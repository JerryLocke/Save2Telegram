function getTweetIdFromUrl(url) {
  try {
    return new URL(url, location.href).pathname.match(/\/status\/(\d+)/)?.[1] || "";
  } catch {
    return "";
  }
}

function findTweetArticleForButton(button) {
  return button?.closest?.("article") || null;
}

function findPayloadTweetArticleForButton(button) {
  const buttonArticle = findTweetArticleForButton(button);
  return buttonArticle || findMainTweetArticle();
}

/** Extract the canonical tweet URL from a tweet article element. */
function findTweetUrl(article) {
  const link = Array.from(article?.querySelectorAll('a[href*="/status/"]') || [])
    .map((anchor) => anchor.href)
    .find(isTweetStatusUrl);

  return link ? normalizeTweetUrl(link) : "";
}

function isTweetStatusUrl(href) {
  try {
    return /\/[^/]+\/status\/\d+/.test(new URL(href, location.href).pathname);
  } catch {
    return false;

    // ==================== Media Discovery ====================
  }
}

function findMainTweetArticle() {
  const articles = findTweetArticles();
  return articles.find((article) => article.querySelector('[data-testid="tweetText"]')) || articles[0] || null;
}

function findTweetArticles() {
  // Status, timeline, search, and profile pages can all contain multiple tweet articles.
  return Array.from(document.querySelectorAll("article"))
    .filter(isVisible)
    .filter((article) => findTweetUrl(article))
    .filter((article) => article.querySelector('[data-testid="reply"],[data-testid="retweet"],[data-testid="like"],[data-testid="bookmark"]'));
}

function extractAuthor(article) {
  const userName = article?.querySelector('[data-testid="User-Name"]')?.innerText?.trim();
  if (userName) {
    return userName.split("\n").filter(Boolean).slice(0, 2).join(" ");
  }

  return "";
}

function extractTweetText(article) {
  const el = article?.querySelector('[data-testid="tweetText"]');
  if (!el) return "";
  return el.textContent.trim();
}

/** Deduplicate media items by URL, keeping the first occurrence. */
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

function isTwitterVideoResource(url) {
  return url.includes("video.twimg.com") && (
    url.includes(".mp4") ||
    url.includes(".m3u8")
  );
}

function isDownloadableTwitterVideoResource(url) {
  return isTwitterVideoResource(url) && !/\/(?:vid|aud)\/[^/]+\/0\/0\//.test(url);
}

function cleanEscapedUrl(url) {
  return url
    .replaceAll("\\/", "/")
    .replaceAll("&amp;", "&")
    .replace(/\\u0026/g, "&");
}

function getVideoCandidatePixels(url) {
  const match = url.match(/\/(\d+)x(\d+)\//);
  return match ? Number(match[1]) * Number(match[2]) : 0;
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 8 && rect.height > 8 && style.visibility !== "hidden" && style.display !== "none";
}
