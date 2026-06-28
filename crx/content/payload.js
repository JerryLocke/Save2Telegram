/** Collect tweet metadata (author, text, URL, media) from the DOM for forwarding. */
function collectTweetPayload(sourceButton) {
  // Multiple tweet articles can share one status page; the clicked footer decides which tweet to forward.
  const article = findPayloadTweetArticleForButton(sourceButton);
  const tweetUrl = findTweetUrl(article) || normalizeTweetUrl(location.href);

  return {
    tweetUrl,
    tweetId: getTweetIdFromUrl(tweetUrl),
    author: extractAuthor(article),
    text: extractTweetText(article),
    media: null,
    mediaItems: []
  };
}
