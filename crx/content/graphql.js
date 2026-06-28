function handleGraphqlMediaCacheMessage(event) {
  if (event.source !== window) {
    return;
  }

  const data = event.data;
  if (data?.source !== GRAPHQL_MEDIA_CACHE_MESSAGE_SOURCE ||
    data?.type !== GRAPHQL_MEDIA_CACHE_MESSAGE_TYPE ||
    !Array.isArray(data.tweets)) {
    return;
  }

  for (const tweet of data.tweets) {
    rememberGraphqlMediaItems(tweet?.tweetId, tweet?.mediaItems);
  }
}

function rememberGraphqlMediaItems(tweetId, mediaItems) {
  const id = String(tweetId || "").trim();
  const normalizedItems = normalizeCachedMediaItems(mediaItems);
  if (!id || !normalizedItems.length) {
    return;
  }

  graphqlMediaCache.delete(id);
  graphqlMediaCache.set(id, {
    mediaItems: normalizedItems,
    updatedAt: Date.now()
  });
  trimGraphqlMediaCache();
}

function getCachedGraphqlMediaItems(tweetId) {
  const cached = graphqlMediaCache.get(String(tweetId || "").trim());
  return cached?.mediaItems ? cloneMediaItems(cached.mediaItems) : [];
}

function normalizeCachedMediaItems(mediaItems) {
  if (!Array.isArray(mediaItems)) {
    return [];
  }

  return dedupeMediaItems(mediaItems
    .map(normalizeCachedMediaItem)
    .filter(Boolean));
}

function normalizeCachedMediaItem(media) {
  if (media?.type === "photo") {
    const url = typeof media.url === "string" ? media.url : "";
    if (!url) {
      return null;
    }

    return {
      type: "photo",
      url: stripImageSizeParams(url),
      thumbnail: stripImageSizeParams(media.thumbnail || url)
    };
  }

  if (media?.type === "video") {
    const candidates = [
      ...(Array.isArray(media.candidates) ? media.candidates : []),
      media.url
    ]
      .map((url) => typeof url === "string" ? cleanEscapedUrl(url) : "")
      .filter((url) => url && isDownloadableTwitterVideoResource(url));
    const uniqueCandidates = [...new Set(candidates)];
    const thumbnail = typeof media.thumbnail === "string" ? media.thumbnail : "";

    return {
      type: "video",
      url: uniqueCandidates[0] || "",
      thumbnail: thumbnail ? stripImageSizeParams(thumbnail) : "",
      sourceId: typeof media.sourceId === "string" ? media.sourceId : "",
      candidates: uniqueCandidates
    };
  }

  return null;
}

function cloneMediaItems(mediaItems) {
  return mediaItems.map((media) => ({
    ...media,
    candidates: Array.isArray(media.candidates) ? [...media.candidates] : media.candidates
  }));
}

function trimGraphqlMediaCache() {
  while (graphqlMediaCache.size > MAX_GRAPHQL_MEDIA_CACHE_ENTRIES) {
    const oldestKey = graphqlMediaCache.keys().next().value;
    graphqlMediaCache.delete(oldestKey);
  }
}

async function hydrateTweetPayloadMediaFromGraphql(payload) {
  const tweetId = payload?.tweetId || getTweetIdFromUrl(payload?.tweetUrl);
  if (!tweetId) {
    return payload;
  }

  try {
    const cachedMediaItems = getCachedGraphqlMediaItems(tweetId);
    const mediaItems = cachedMediaItems.length ? cachedMediaItems : await fetchGraphqlTweetMediaItems(tweetId);
    if (!mediaItems.length) {
      return payload;
    }

    rememberGraphqlMediaItems(tweetId, mediaItems);
    return {
      ...payload,
      tweetId,
      media: mediaItems[0] || null,
      mediaItems
    };
  } catch {
    return payload;
  }
}

async function fetchGraphqlTweetMediaItems(tweetId) {
  const capturedRequests = await getCapturedTweetGraphqlRequests();
  const directRequest = buildTweetGraphqlRequest(tweetId, capturedRequests);
  if (!directRequest) {
    return [];
  }

  return fetchGraphqlRequestMediaItems(directRequest, tweetId);
}

async function fetchGraphqlRequestMediaItems(request, tweetId) {
  if (!request?.url || !request.headers) {
    return [];
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), GRAPHQL_MEDIA_QUERY_TIMEOUT_MS);

  try {
    const response = await fetch(request.url, {
      credentials: "include",
      signal: controller.signal,
      headers: request.headers
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    const tweet = findGraphqlTweetById(data, tweetId);
    return extractGraphqlMediaItems(tweet);
  } catch {
    return [];
  } finally {
    window.clearTimeout(timeout);
  }
}

function buildTweetGraphqlRequest(tweetId, capturedRequests) {
  const templates = findTweetGraphqlRequestTemplates(capturedRequests);
  const preferredTemplate = templates.find((template) => template.operationName === "TweetResultByRestId") ||
    templates.find((template) => template.operationName === "TweetDetail");
  if (!preferredTemplate) {
    return null;
  }

  const url = new URL(preferredTemplate.url, location.href);
  url.protocol = location.protocol;
  url.host = location.host;

  const variables = parseJsonSearchParam(url.searchParams.get("variables")) || {};
  if (preferredTemplate.operationName === "TweetResultByRestId") {
    variables.tweetId = tweetId;
  } else {
    variables.focalTweetId = tweetId;
  }

  url.searchParams.set("variables", JSON.stringify(variables));
  return {
    url: url.toString(),
    headers: preferredTemplate.headers
  };
}

function findTweetGraphqlRequestTemplates(requests) {
  const templates = (Array.isArray(requests) ? requests : [])
    .map(parseTweetGraphqlRequestTemplate)
    .filter(Boolean);
  const seen = new Set();
  return templates
    .reverse()
    .filter((template) => {
      const key = template.operationName;
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
}

async function getCapturedTweetGraphqlRequests() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_CAPTURED_TWEET_GRAPHQL_REQUESTS" });
    return Array.isArray(response?.result) ? response.result.filter((request) => isTweetGraphqlUrl(request?.url)) : [];
  } catch {
    return [];
  }
}

function parseTweetGraphqlRequestTemplate(request) {
  const template = parseTweetGraphqlTemplate(request?.url);
  const headers = normalizeGraphqlHeaders(request?.headers);
  if (!template || !headers) {
    return null;
  }

  return {
    ...template,
    headers
  };
}

function normalizeGraphqlHeaders(headers) {
  if (!headers || typeof headers !== "object") {
    return null;
  }

  const allowedHeaders = [
    "authorization",
    "content-type",
    "x-csrf-token",
    "x-twitter-active-user",
    "x-twitter-auth-type",
    "x-twitter-client-language"
  ];
  const result = {};
  for (const name of allowedHeaders) {
    const value = getHeaderCaseInsensitive(headers, name);
    if (value) {
      result[name] = value;
    }
  }

  return result.authorization && result["x-csrf-token"] ? result : null;
}

function getHeaderCaseInsensitive(headers, name) {
  const match = Object.entries(headers)
    .find(([key]) => key.toLowerCase() === name.toLowerCase());
  return typeof match?.[1] === "string" ? match[1] : "";
}

function parseTweetGraphqlTemplate(url) {
  try {
    const parsed = new URL(url, location.href);
    const operationName = getGraphqlOperationName(parsed.toString());
    if (!isDirectTweetGraphqlOperation(operationName)) {
      return null;
    }

    return { url: parsed.toString(), operationName };
  } catch {
    return null;
  }
}

function isTweetGraphqlUrl(url) {
  if (typeof url !== "string" || !url.includes("/i/api/graphql/")) {
    return false;
  }

  return isTweetGraphqlOperation(getGraphqlOperationName(url));
}

function getGraphqlOperationName(url) {
  try {
    return new URL(url, location.href).pathname.match(/\/i\/api\/graphql\/[^/]+\/([^/?#]+)/)?.[1] || "";
  } catch {
    return "";
  }
}

function isTweetGraphqlOperation(operationName) {
  if (isDirectTweetGraphqlOperation(operationName)) {
    return true;
  }

  return /(?:Timeline|Tweets|Bookmarks|SearchTimeline|UserMedia|Likes)/.test(operationName) &&
    !/^(Create|Delete|Favorite|Retweet|Unretweet|BookmarkTweet|Unbookmark|LikeTweet|UnlikeTweet|Follow|Mute|Block|Report|Update|Edit)/.test(operationName);
}

function isDirectTweetGraphqlOperation(operationName) {
  return operationName === "TweetResultByRestId" || operationName === "TweetDetail";
}

function parseJsonSearchParam(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function findGraphqlTweetById(value, tweetId, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return null;
  }

  seen.add(value);

  const unwrapped = unwrapGraphqlTweet(value);
  if (unwrapped?.rest_id === tweetId && unwrapped?.legacy) {
    return unwrapped;
  }

  for (const child of Object.values(value)) {
    const found = findGraphqlTweetById(child, tweetId, seen);
    if (found) {
      return found;
    }
  }

  return null;
}

function unwrapGraphqlTweet(value) {
  let current = value;
  const seen = new Set();

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);

    if (current.rest_id && current.legacy) {
      return current;
    }

    if (current.tweet && typeof current.tweet === "object") {
      current = current.tweet;
      continue;
    }

    if (current.tweet_results?.result && typeof current.tweet_results.result === "object") {
      current = current.tweet_results.result;
      continue;
    }

    break;
  }

  return current;
}

function extractGraphqlMediaItems(tweet) {
  const media = tweet?.legacy?.extended_entities?.media || tweet?.legacy?.entities?.media || [];
  if (!Array.isArray(media) || !media.length) {
    return [];
  }

  return dedupeMediaItems(media
    .map(createMediaItemFromGraphqlMedia)
    .filter(Boolean));
}

function createMediaItemFromGraphqlMedia(media) {
  if (media?.type === "photo") {
    const url = media.media_url_https || media.media_url || "";
    if (!url) {
      return null;
    }

    return {
      type: "photo",
      url: stripImageSizeParams(url),
      thumbnail: stripImageSizeParams(url)
    };
  }

  if (media?.type === "video" || media?.type === "animated_gif") {
    const candidates = getGraphqlVideoCandidates(media);
    const thumbnail = media.media_url_https || media.media_url || "";
    return {
      type: "video",
      url: candidates[0] || "",
      thumbnail: thumbnail ? stripImageSizeParams(thumbnail) : "",
      sourceId: getGraphqlMediaSourceId(media),
      candidates
    };
  }

  return null;
}

function getGraphqlVideoCandidates(media) {
  const variants = Array.isArray(media?.video_info?.variants) ? media.video_info.variants : [];
  const candidates = variants
    .map((variant) => ({
      url: typeof variant?.url === "string" ? cleanEscapedUrl(variant.url) : "",
      bitrate: Number(variant?.bitrate || 0),
      contentType: String(variant?.content_type || "")
    }))
    .filter((variant) => variant.url && isDownloadableTwitterVideoResource(variant.url))
    .sort(rankGraphqlVideoVariant);

  const seen = new Set();
  return candidates
    .map((variant) => variant.url)
    .filter((url) => {
      if (seen.has(url)) {
        return false;
      }

      seen.add(url);
      return true;
    });
}

function rankGraphqlVideoVariant(a, b) {
  const aIsMp4 = isMp4VideoVariant(a);
  const bIsMp4 = isMp4VideoVariant(b);
  if (aIsMp4 !== bIsMp4) {
    return bIsMp4 - aIsMp4;
  }

  const bitrateDiff = Number(b.bitrate || 0) - Number(a.bitrate || 0);
  if (bitrateDiff) {
    return bitrateDiff;
  }

  return getVideoCandidatePixels(b.url) - getVideoCandidatePixels(a.url);
}

function isMp4VideoVariant(variant) {
  return variant?.url?.includes(".mp4") || variant?.contentType === "video/mp4";
}

function getGraphqlMediaSourceId(media) {
  const mediaKeyId = String(media?.media_key || "").split("_").pop();
  return getTwitterVideoMediaId(media?.media_url_https || media?.media_url || "") ||
    getTwitterVideoMediaId(media?.expanded_url || "") ||
    getTwitterVideoMediaId(mediaKeyId) ||
    getTwitterVideoMediaId(media?.id_str || "") ||
    "";
}
