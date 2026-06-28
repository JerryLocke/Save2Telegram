(() => {
  const INSTALL_KEY = "__save2telegramGraphqlCaptureInstalled";
  const MESSAGE_SOURCE = "Save2Telegram";
  const MESSAGE_TYPE = "GRAPHQL_MEDIA_CACHE";
  const MAX_TWEETS_PER_MESSAGE = 250;

  if (window[INSTALL_KEY]) {
    return;
  }
  window[INSTALL_KEY] = true;

  patchFetch();
  patchXhr();

  function patchFetch() {
    const originalFetch = window.fetch;
    if (typeof originalFetch !== "function") {
      return;
    }

    window.fetch = new Proxy(originalFetch, {
      apply(target, thisArg, args) {
        const input = args[0];
        const responsePromise = Reflect.apply(target, thisArg, args);
        responsePromise
          .then((response) => captureFetchResponse(input, response))
          .catch(() => {});
        return responsePromise;
      }
    });
  }

  function patchXhr() {
    const Xhr = window.XMLHttpRequest;
    if (!Xhr?.prototype?.open || !Xhr?.prototype?.send) {
      return;
    }

    const originalOpen = Xhr.prototype.open;
    const originalSend = Xhr.prototype.send;

    Xhr.prototype.open = function save2telegramXhrOpen(method, url) {
      this.__save2telegramUrl = typeof url === "string" ? url : String(url || "");
      return originalOpen.apply(this, arguments);
    };

    Xhr.prototype.send = function save2telegramXhrSend() {
      this.addEventListener("load", () => captureXhrResponse(this));
      return originalSend.apply(this, arguments);
    };
  }

  function captureFetchResponse(input, response) {
    const url = getFetchUrl(input) || response?.url || "";
    if (!shouldCaptureGraphqlResponse(url, response?.status, response?.headers?.get?.("content-type") || "")) {
      return;
    }

    try {
      response.clone().json()
        .then((data) => postTweetMedia(url, data))
        .catch(() => {});
    } catch {
      // Ignore non-cloneable or already-consumed responses.
    }
  }

  function captureXhrResponse(xhr) {
    const url = xhr.responseURL || xhr.__save2telegramUrl || "";
    if (!shouldCaptureGraphqlResponse(url, xhr.status, xhr.getResponseHeader?.("content-type") || "")) {
      return;
    }

    try {
      const data = xhr.responseType && xhr.responseType !== "text"
        ? xhr.response
        : JSON.parse(xhr.responseText);
      postTweetMedia(url, data);
    } catch {
      // Ignore non-JSON XHR payloads.
    }
  }

  function shouldCaptureGraphqlResponse(url, status, contentType) {
    return isTweetGraphqlUrl(url) &&
      Number(status || 0) >= 200 &&
      Number(status || 0) < 300 &&
      String(contentType || "").includes("json");
  }

  function getFetchUrl(input) {
    if (typeof input === "string") {
      return input;
    }
    if (input?.url) {
      return String(input.url);
    }
    return "";
  }

  function postTweetMedia(url, data) {
    const tweets = extractTweetsWithMedia(data);
    if (!tweets.length) {
      return;
    }

    window.postMessage({
      source: MESSAGE_SOURCE,
      type: MESSAGE_TYPE,
      url,
      tweets
    }, window.location.origin);
  }

  function extractTweetsWithMedia(root) {
    const tweets = [];
    const seenObjects = new Set();
    const seenTweetIds = new Set();
    const stack = [root];

    while (stack.length && tweets.length < MAX_TWEETS_PER_MESSAGE) {
      const value = stack.pop();
      if (!value || typeof value !== "object" || seenObjects.has(value)) {
        continue;
      }

      seenObjects.add(value);
      const tweet = unwrapGraphqlTweet(value);
      const tweetId = getTweetId(tweet);
      if (tweetId && !seenTweetIds.has(tweetId)) {
        seenTweetIds.add(tweetId);
        const mediaItems = extractGraphqlMediaItems(tweet);
        if (mediaItems.length) {
          tweets.push({ tweetId, mediaItems });
        }
      }

      for (const child of Object.values(value)) {
        if (child && typeof child === "object") {
          stack.push(child);
        }
      }
    }

    return tweets;
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

  function getTweetId(tweet) {
    return String(tweet?.rest_id || tweet?.legacy?.id_str || tweet?.id_str || "").trim();
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

  function getTwitterVideoMediaId(url) {
    const value = typeof url === "string" ? cleanEscapedUrl(url) : "";
    if (!value) {
      return "";
    }
    if (/^[A-Za-z0-9_-]{4,}$/.test(value)) {
      return value;
    }

    const pathMatch = value.match(/\/(?:amplify_video|amplify_video_thumb|ext_tw_video|ext_tw_video_thumb)\/([^/?#]+)\//);
    if (pathMatch) {
      return pathMatch[1];
    }

    const tweetVideoMatch = value.match(/\/(?:tweet_video|tweet_video_thumb)\/([^/?#.]+)/);
    return tweetVideoMatch?.[1] || "";
  }

  function dedupeMediaItems(items) {
    const seen = new Set();
    return items.filter((item) => {
      const key = `${item.type}:${item.url || item.candidates?.[0] || ""}`;
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  }

  function stripImageSizeParams(url) {
    try {
      const parsed = new URL(url);
      parsed.searchParams.delete("format");
      parsed.searchParams.delete("name");
      return parsed.toString();
    } catch {
      return url;
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
      return new URL(url, window.location.href).pathname.match(/\/i\/api\/graphql\/[^/]+\/([^/?#]+)/)?.[1] || "";
    } catch {
      return "";
    }
  }

  function isTweetGraphqlOperation(operationName) {
    if (operationName === "TweetResultByRestId" || operationName === "TweetDetail") {
      return true;
    }

    return /(?:Timeline|Tweets|Bookmarks|SearchTimeline|UserMedia|Likes)/.test(operationName) &&
      !/^(Create|Delete|Favorite|Retweet|Unretweet|BookmarkTweet|Unbookmark|LikeTweet|UnlikeTweet|Follow|Mute|Block|Report|Update|Edit)/.test(operationName);
  }

  function cleanEscapedUrl(url) {
    return url
      .replaceAll("\\/", "/")
      .replaceAll("&amp;", "&")
      .replace(/\\u0026/g, "&");
  }

  function isTwitterVideoResource(url) {
    return url.includes("video.twimg.com") && (
      url.includes(".mp4") ||
      url.includes(".m3u8")
    );
  }

  function isDownloadableTwitterVideoResource(url) {
    return isTwitterVideoResource(url) && !/\/(?:vid|aud)\/[^/]+\/0\/0\//.test(url);
  }

  function getVideoCandidatePixels(url) {
    const match = url.match(/\/(\d+)x(\d+)\//);
    return match ? Number(match[1]) * Number(match[2]) : 0;
  }
})();
