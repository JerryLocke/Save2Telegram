/** Build a Telegram caption from a tweet payload: author, text, and URL, HTML-escaped. */
export function buildCaption(payload) {
  const author = escapeTelegramHtml(payload?.author || "");
  const text = String(payload?.text || "").trim();
  const tweetUrl = payload?.tweetUrl || "";
  const body = formatTweetTextForTelegram(text);
  const parts = [];
  if (author) parts.push(author);
  if (body) parts.push(body);
  if (tweetUrl) parts.push(escapeTelegramHtml(tweetUrl));
  return truncateTelegramCaption(parts.join("\n\n"));
}

/** Truncate a caption to Telegram's 1024-char limit, preserving blockquote boundaries. */
function truncateTelegramCaption(caption) {
  if (caption.length <= 1024) {
    return caption;
  }

  const quoteStart = caption.search(/<blockquote(?:\s+expandable)?>/);
  const quoteEnd = caption.lastIndexOf("</blockquote>");
  if (quoteStart >= 0 && quoteEnd > quoteStart) {
    const openTagEnd = caption.indexOf(">", quoteStart) + 1;
    const prefix = caption.slice(0, openTagEnd);
    const quote = caption.slice(openTagEnd, quoteEnd);
    const suffix = caption.slice(quoteEnd);
    const maxQuoteLength = 1024 - prefix.length - suffix.length - 3;
    if (maxQuoteLength > 0) {
      return `${prefix}${truncateEscapedHtml(quote, maxQuoteLength)}...${suffix}`;
    }
  }

  return `${truncateEscapedHtml(caption, 1021)}...`;
}

/** Format tweet text: short tweets as plain text, long tweets with a quote block. */
function formatTweetTextForTelegram(text) {
  if (!text) {
    return "";
  }

  const paragraphs = text.split(/\n+/).map((part) => part.trim()).filter(Boolean);
  const isLongTweet = text.length > 280;
  const hasShortTitle = isLongTweet && paragraphs.length > 1 && paragraphs[0].length <= 80;
  if (!isLongTweet) {
    return escapeTelegramHtml(text);
  }

  if (hasShortTitle) {
    return [escapeTelegramHtml(paragraphs[0]), wrapTelegramQuote(paragraphs.slice(1).join("\n"))].join("\n\n");
  }

  return wrapTelegramQuote(text);
}

/** Wrap text in Telegram's expandable blockquote. */
function wrapTelegramQuote(text) {
  return `<blockquote expandable>${escapeTelegramHtml(text)}</blockquote>`;
}

/** Escape HTML special characters for Telegram's parse_mode=HTML. */
function escapeTelegramHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Truncate HTML-escaped text without breaking an entity. */
function truncateEscapedHtml(value, maxLength) {
  return value.slice(0, maxLength).trimEnd().replace(/&[^;\s]*$/, "");
}
