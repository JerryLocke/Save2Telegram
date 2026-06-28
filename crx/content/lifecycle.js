// ==================== Initialization ====================
/** Initialize content script: mount forward buttons on tweets and media viewer. */
function init() {
  window.addEventListener("message", handleGraphqlMediaCacheMessage);
  installGraphqlResponseCapture();
  setupDraftSync();
  queueRenderBurst();
  patchHistoryNavigation();
  observeTweetResources();
  document.addEventListener("click", handlePotentialMediaClick, true);
  window.addEventListener("popstate", handleUrlMaybeChanged);
  window.addEventListener("pageshow", queueRenderBurst);
}

function installGraphqlResponseCapture() {
  const inject = () => {
    if (document.documentElement?.dataset.tfGraphqlCaptureInjected === "true") {
      return;
    }

    const parent = document.documentElement || document.head || document.body;
    if (!parent) {
      document.addEventListener("DOMContentLoaded", inject, { once: true });
      return;
    }

    const marker = document.documentElement || parent;
    marker.dataset.tfGraphqlCaptureInjected = "true";
    const script = document.createElement("script");
    script.async = false;
    script.src = chrome.runtime.getURL("content/page-graphql-capture.js");
    script.onload = () => script.remove();
    parent.append(script);
  };

  inject();
}

/** Monkey-patch history.pushState/replaceState to detect SPA navigation. */
function patchHistoryNavigation() {
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function patchedPushState(...args) {
    const result = originalPushState.apply(this, args);
    handleUrlMaybeChanged();
    return result;
  };

  history.replaceState = function patchedReplaceState(...args) {
    const result = originalReplaceState.apply(this, args);
    handleUrlMaybeChanged();
    return result;
  };
}

/** Check if the URL changed since last check; trigger re-render if so. */
function checkUrlChange() {
  if (currentUrl === location.href) {
    return;
  }


  // ==================== Navigation Detection ====================
  currentUrl = location.href;
  queueRenderBurst();
}

/** Debounced handler for URL changes: queue a re-render. */
function handleUrlMaybeChanged() {
  window.setTimeout(checkUrlChange, 0);
}

/** Detect clicks on media elements and capture video candidates. */
function handlePotentialMediaClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  const link = target?.closest('a[href*="/status/"][href*="/photo/"],a[href*="/status/"][href*="/video/"]');
  if (link) {
    queueRenderBurst();
  }
}

/** Use PerformanceObserver to detect new tweet resources loading via XHR/fetch. */
function observeTweetResources() {
  if (!("PerformanceObserver" in window)) {
    return;
  }

  const observer = new PerformanceObserver((list) => {
    if (list.getEntries().some((entry) => isTweetResource(entry.name))) {
      const now = Date.now();
      if (now - lastResourceRenderAt < 800) {
        return;
      }

      lastResourceRenderAt = now;
      queueRenderBurst();
    }
  });

  try {
    observer.observe({ type: "resource", buffered: true });
  } catch {
    observer.observe({ entryTypes: ["resource"] });
  }
}

/** Check if a URL is a tweet-related resource that warrants a re-render. */
function isTweetResource(url) {
  return isTweetGraphqlUrl(url);
}

function queueRender() {
  if (renderTimer) {
    return;
  }

  renderTimer = window.setTimeout(() => {
    renderTimer = null;
    renderButtons();
  }, 120);
}

function queueRenderBurst() {
  clearRenderBurst();
  [0, 160, 400, 900, 1800, 3200, 5200].forEach((delay) => {

    // ==================== Button Rendering ====================
    renderBurstTimers.push(window.setTimeout(queueRender, delay));
  });
}

function clearRenderBurst() {
  renderBurstTimers.forEach((timer) => window.clearTimeout(timer));
  renderBurstTimers = [];
}
