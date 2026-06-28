/** Find all locations where forward buttons should be injected. */
function findButtonMounts() {
  const mounts = [];
  const seenParents = new Set();

  for (const mount of findMediaViewerButtonMounts()) {
    if (!seenParents.has(mount.parent)) {
      seenParents.add(mount.parent);
      mounts.push(mount);
    }
  }

  for (const mount of findTweetArticleButtonMounts()) {
    if (mount && !seenParents.has(mount.parent)) {
      seenParents.add(mount.parent);
      mounts.push(mount);
    }
  }

  return mounts;
}

/** Find mount points inside tweet action rows on the timeline. */
function findTweetArticleButtonMounts() {
  const mounts = [];
  const articles = findTweetArticles();

  for (const article of articles) {
    const actionRow = findFooterActionRow(article);
    const mount = actionRow ? createMountFromActionRow(actionRow, "default") : null;
    if (mount) {
      mounts.push(mount);
    }
  }

  return mounts;
}

/** Find mount points on the media viewer / photo detail page. */
function findMediaViewerButtonMounts() {
  if (!needsMediaFooter()) {
    return [];
  }

  const mounts = [];
  const roots = [
    ...Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]')).filter(isVisible),
    document.body
  ].filter(Boolean);

  for (const root of roots) {
    const groups = findFooterActionRows(root, { allowCompactMediaFooter: true });
    for (const group of groups) {
      const surface = isDarkSurface(group) ? "media" : "default";
      const mount = createMountFromActionRow(group, surface);
      if (mount && !mounts.some((candidate) => candidate.parent === mount.parent)) {
        mounts.push(mount);
      }
    }
  }

  return mounts;
}

/** Create a mount descriptor from an action row element. */
function createMountFromActionRow(actionRow, surface) {
  const shareAction = findShareAction(actionRow);
  const directActionChild = shareAction ? findDirectChild(actionRow, shareAction) : null;

  if (!directActionChild) {
    return null;
  }

  return {
    parent: actionRow,
    after: directActionChild,
    itemClassName: directActionChild.className || "",
    surface
  };
}

function findFooterActionRows(root, options = {}) {
  const shareActions = findShareCandidates(root)
    .filter((element) => element.id !== BUTTON_ID && !element.classList.contains(BUTTON_CLASS) && isVisible(element))
    .filter(isShareAction);

  const rows = [];
  for (const shareAction of shareActions) {
    const group = shareAction.closest('[role="group"]');
    if (!group || rows.includes(group)) {
      continue;
    }

    const rect = group.getBoundingClientRect();
    const looksLikeFooter = rect.height <= 80 && rect.width >= 80;
    const hasStandardActions = Boolean(group.querySelector('[data-testid="reply"],[data-testid="retweet"],[data-testid="like"],[data-testid="bookmark"]'));
    const hasMediaStats = /\d/.test(group.innerText || "") && rect.width >= 120;

    if (looksLikeFooter && (hasStandardActions || (options.allowCompactMediaFooter && hasMediaStats))) {
      rows.push(group);
    }
  }

  return rows;
}

function insertAfter(parent, node, anchor) {
  if (!anchor) {
    parent.append(node);
    return;
  }


  // ==================== Theme Detection ====================
  anchor.after(node);
}

function ensureButtonWrapper(button) {
  const currentWrapper = button.closest(`.${WRAPPER_CLASS},#${WRAPPER_ID}`);
  if (currentWrapper) {
    return currentWrapper;
  }

  const wrapper = document.createElement("div");
  button.replaceWith(wrapper);
  wrapper.append(button);
  return wrapper;
}

function syncWrapperWithMount(wrapper, mount) {
  wrapper.removeAttribute("id");
  wrapper.className = [mount.itemClassName, WRAPPER_CLASS].filter(Boolean).join(" ");
  wrapper.dataset.tfForwardAction = "true";
  wrapper.style.marginLeft = "12px";
}

function syncButtonSurface(button, mount) {
  button.dataset.tfSurface = mount.surface || "default";
  syncButtonDraftState(button);
}

function isDarkSurface(element) {
  let node = element;

  while (node && node !== document.documentElement) {
    const luminance = getBackgroundLuminance(getComputedStyle(node).backgroundColor);
    if (luminance !== null) {
      return luminance < 80;
    }

    node = node.parentElement;
  }

  return false;
}

function getBackgroundLuminance(color) {
  const parts = color.match(/\d+(\.\d+)?/g);
  if (!parts || parts.length < 3) {
    return null;
  }

  const [red, green, blue, alpha = 1] = parts.map(Number);
  if (alpha === 0) {
    return null;
  }

  return (red * 299 + green * 587 + blue * 114) / 1000;
}

function isMountedAtTarget(node, mount) {
  if (node.parentElement !== mount.parent) {
    return false;
  }

  if (!mount.after) {
    return !node.nextElementSibling;
  }

  return node.previousElementSibling === mount.after;
}

function findFooterActionRow(article) {
  return findFooterActionRows(article)[0] || null;
}

function findShareAction(root) {
  const actions = findShareCandidates(root)
    .filter((element) => element.id !== BUTTON_ID && !element.classList.contains(BUTTON_CLASS) && isVisible(element));

  return actions.find(isShareAction) || null;
}

function findShareCandidates(root) {
  const selectors = [
    '[data-testid="share"]',
    'button[aria-label*="Share"]',
    '[role="button"][aria-label*="Share"]',
    'button[aria-label*="\u5206\u4eab"]',
    '[role="button"][aria-label*="\u5206\u4eab"]'
  ];

  const candidates = [];
  for (const selector of selectors) {
    root.querySelectorAll(selector).forEach((element) => {

      // ==================== Payload Extraction ====================
      if (!candidates.includes(element)) {
        candidates.push(element);
      }
    });
  }

  return candidates;
}

function isShareAction(element) {
  const testId = element.getAttribute("data-testid") || "";
  const label = `${element.getAttribute("aria-label") || ""} ${element.innerText || ""}`.toLowerCase();
  return testId === "share" ||
    label.includes("share") ||
    label.includes("\u5206\u4eab");
}

function findDirectChild(parent, descendant) {
  let node = descendant;

  while (node?.parentElement && node.parentElement !== parent) {
    node = node.parentElement;
  }

  return node?.parentElement === parent ? node : descendant;
}
