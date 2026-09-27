// Telegram Web K keeps channel message IDs above 2^32 in its DOM.
// See tweb/src/lib/appManagers/constants.ts and appMessagesIdsManager.ts.
const TELEGRAM_MESSAGE_ID_OFFSET = 0x100000000;
const TELEGRAM_BUBBLE_SELECTOR = '.bubble[data-mid][data-peer-id]';
const TELEGRAM_ACTION_CLASS = 'tf-telegram-action';
let telegramRenderTimer = null;

function getTelegramServerMessageId(value) {
  const id = Number(value);
  // Fractional IDs are pending messages; the next offset range is ephemeral.
  if (!Number.isSafeInteger(id) || id <= 0 || id >= TELEGRAM_MESSAGE_ID_OFFSET * 2) return 0;
  const serverId = id >= TELEGRAM_MESSAGE_ID_OFFSET ? id - TELEGRAM_MESSAGE_ID_OFFSET : id;
  return serverId > 0 && serverId <= 0x7fffffff ? serverId : 0;
}

function getTelegramMediaAttachments(bubble) {
  const content = bubble.querySelector(':scope > .bubble-content-wrapper > .bubble-content');
  if (!content) return [];
  // A reply thumbnail, link preview, avatar or reaction is not message media.
  // Web K renders files and audio inside .message > .document-container.
  return Array.from(content.querySelectorAll(
    ':scope > :is(.attachment, .document-container, .document, audio-element, .audio, .media-sticker-wrapper), ' +
    ':scope > .message > .document-container'
  ));
}

function getTelegramMediaNodes(bubble) {
  const attachments = getTelegramMediaAttachments(bubble);
  if (!attachments.length) return [];
  const grouped = attachments.flatMap(node => node.matches('.grouped-item[data-mid]')
    ? [node] : Array.from(node.querySelectorAll('.grouped-item[data-mid]')));
  return grouped.length ? grouped : [bubble];
}

function getTelegramMessageSource(bubble) {
  // Scheduled IDs belong to a separate sequence and can collide with history
  // IDs. Use this guard for both rendering and collection, including stale UI.
  if (!bubble || bubble.closest('.chat[data-type="scheduled"]')) return null;
  const nodes = getTelegramMediaNodes(bubble);
  if (!nodes.length) return null;
  const peerId = bubble.dataset.peerId || '';
  // Private chats and basic groups use account-specific message ID sequences.
  // Only channel/supergroup IDs can be reused safely by a different account.
  if (!/^-[1-9]\d*$/.test(peerId) || !Number.isSafeInteger(Number(peerId))) return null;
  const rawIds = nodes.map(node => Number(node.dataset.mid));
  const ids = rawIds.map(getTelegramServerMessageId);
  if (ids.some(id => !id) || ids.length > 100) return null;
  if (nodes.some(node => node.dataset.peerId && node.dataset.peerId !== peerId)) return null;
  const isChannel = rawIds.every(id => id >= TELEGRAM_MESSAGE_ID_OFFSET);
  if (!isChannel) return null;
  // Web K uses -channelId; Bot API uses -(10^12 + channelId).
  const chatId = String(-1000000000000 + Number(peerId));
  const messageIds = [...new Set(ids)].sort((a, b) => a - b);
  const titlePeer = bubble.closest('.chat')?.querySelector('.peer-title[data-peer-id]')?.dataset.peerId;
  const username = titlePeer === peerId ? location.hash.match(/^#(@[a-zA-Z][a-zA-Z0-9_]{3,31})$/)?.[1] : '';
  return { chatId, messageIds, ...(username ? { chatUsername: username } : {}), protectedContent: bubble.classList.contains('no-forwards') };
}

function collectTelegramPayload(button) {
  const bubble = button.closest(TELEGRAM_BUBBLE_SELECTOR);
  const source = bubble?.isConnected ? getTelegramMessageSource(bubble) : null;
  if (!source) throw new Error(chrome.i18n.getMessage('content_telegramUnavailable'));
  const wrapper = button.closest(`.${TELEGRAM_ACTION_CLASS}`);
  if (wrapper?.dataset.tfTelegramSourceKey !== getTelegramSourceKey(source)) {
    throw new Error(chrome.i18n.getMessage('content_telegramUnavailable'));
  }
  const peerId = bubble.dataset.peerId;
  const url = `https://t.me/c/${peerId.slice(1)}/${source.messageIds[0]}`;
  const mediaNodes = getTelegramMediaNodes(bubble);
  return {
    source: 'telegram',
    telegramSource: source,
    // Keep the existing queue's source-link field for backward compatibility.
    tweetUrl: url,
    text: chrome.i18n.getMessage('content_telegramMessage'),
    mediaItems: source.messageIds.map(messageId => ({
      type: getTelegramMediaType(bubble, mediaNodes.find(node => getTelegramServerMessageId(node.dataset.mid) === messageId)),
      messageId
    }))
  };
}

function getTelegramMediaType(bubble, node) {
  const roots = node === bubble ? getTelegramMediaAttachments(bubble) : (node ? [node] : []);
  const has = selector => roots.some(root => root.matches(selector) || root.querySelector(selector));
  // Video posters also have .media-photo; check the video wrapper first.
  // Scope each album member separately so a mixed album keeps its real types.
  if (has('video, .video-time, .video-play, .media-video, .media-gif-wrapper, .media-round') ||
      (node === bubble && bubble.matches('.video, .gif, .round'))) return 'video';
  if (has('audio-element, audio, .audio')) return 'audio';
  if (has('.media-sticker-wrapper')) return 'sticker';
  if (has('.document, .document-container')) return 'document';
  if (has('.media-photo') || (node === bubble && bubble.classList.contains('photo')) ||
      (node?.matches('.album-item') && has('.media-container'))) return 'photo';
  return 'telegram';
}

function getTelegramSourceKey(source) {
  return `${source.chatId}:${source.messageIds.join(',')}`;
}

/** Store up to three durable previews for the popup's album stack. */
function addTelegramPayloadThumbnail(payload, button) {
  const bubble = button.closest(TELEGRAM_BUBBLE_SELECTOR);
  const mediaNodes = getTelegramMediaNodes(bubble);
  let thumbnailCount = 0;
  for (const item of payload.mediaItems) {
    const node = mediaNodes.find(media => getTelegramServerMessageId(media.dataset.mid) === item.messageId);
    const roots = node === bubble ? getTelegramMediaAttachments(bubble) : (node ? [node] : []);
    const thumbnail = captureTelegramThumbnail(roots);
    if (thumbnail) {
      item.thumbnail = thumbnail;
      if (++thumbnailCount === 3) break;
    }
  }
  return payload;
}

function captureTelegramThumbnail(roots) {
  // Only use already-decoded media. This must not start a video download or
  // keep the Telegram tab alive for the popup to display its queue preview.
  const previews = roots.flatMap(root => Array.from(root.querySelectorAll('img, canvas, video')));
  previews.sort((a, b) => (a.tagName === 'IMG' ? 0 : 1) - (b.tagName === 'IMG' ? 0 : 1));
  for (const preview of previews) {
    const width = preview.tagName === 'IMG' ? preview.naturalWidth : preview.tagName === 'VIDEO' ? preview.videoWidth : preview.width;
    const height = preview.tagName === 'IMG' ? preview.naturalHeight : preview.tagName === 'VIDEO' ? preview.videoHeight : preview.height;
    if (!width || !height || (preview.tagName === 'IMG' && !preview.complete) ||
        (preview.tagName === 'VIDEO' && preview.readyState < 2)) continue;
    try {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 160 / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext('2d');
      if (!context) continue;
      context.drawImage(preview, 0, 0, canvas.width, canvas.height);
      const thumbnail = canvas.toDataURL('image/jpeg', .72);
      if (thumbnail.startsWith('data:image/jpeg;base64,') && thumbnail.length <= 48 * 1024) return thumbnail;
    } catch {
      // Cross-origin or disappearing previews must not prevent forwarding.
    }
  }
  return '';
}

function syncTelegramButton(button) {
  if (button.disabled) return;
  button.setAttribute('aria-disabled', 'false');
  const label = LABEL_READY();
  if (button.getAttribute('aria-label') !== label) setButtonState(button, false, label);
}

function renderTelegramButtons() {
  telegramRenderTimer = null;
  const mounts = new Set();
  document.querySelectorAll(`#column-center ${TELEGRAM_BUBBLE_SELECTOR}`).forEach(bubble => {
    const source = getTelegramMessageSource(bubble);
    const parent = bubble.querySelector(':scope > .bubble-content-wrapper > .bubble-content');
    if (!source || !parent) return;
    mounts.add(parent);
    let wrapper = parent.querySelector(`:scope > .${TELEGRAM_ACTION_CLASS}`);
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.className = `${WRAPPER_CLASS} ${TELEGRAM_ACTION_CLASS}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = BUTTON_CLASS;
      wrapper.append(button);
      bindTelegramButton(wrapper, button);
      parent.append(wrapper);
    }
    const nativeButton = parent.querySelector(':scope > .bubble-beside-button.forward, :scope > .bubble-beside-button.goto-original');
    const hasNativeButton = Boolean(nativeButton && !(nativeButton.classList.contains('forward') && bubble.classList.contains('no-forwards')));
    wrapper.dataset.tfNativeBeside = String(hasNativeButton);
    const sourceKey = getTelegramSourceKey(source);
    if (wrapper.dataset.tfTelegramSourceKey !== sourceKey) {
      hideConfigMenu(wrapper);
      wrapper.dataset.tfTelegramSourceKey = sourceKey;
    }
    syncTelegramButton(wrapper.querySelector('button'));
  });
  document.querySelectorAll(`.${TELEGRAM_ACTION_CLASS}`).forEach(wrapper => {
    if (!mounts.has(wrapper.parentElement)) wrapper.remove();
  });
  if (activeConfigMenuWrapper && !activeConfigMenuWrapper.isConnected) hideConfigMenu();
}

function scheduleTelegramRender() {
  if (telegramRenderTimer === null) telegramRenderTimer = setTimeout(renderTelegramButtons, 80);
}

function bindTelegramButton(wrapper, button) {
  ['pointerdown', 'mousedown', 'mouseup', 'dblclick'].forEach(type => {
    button.addEventListener(type, stopForwardInteractionEvent);
  });
  button.addEventListener('click', async event => {
    cancelForwardInteractionEvent(event);
    try {
      const selectionKey = getTelegramSourceKey(collectTelegramPayload(button).telegramSource);
      const configs = await loadTelegramConfigs();
      if (!configs.length) throw new Error(chrome.i18n.getMessage('content_noConfig'));
      if (selectionKey !== getTelegramSourceKey(collectTelegramPayload(button).telegramSource)) {
        throw new Error(chrome.i18n.getMessage('content_telegramUnavailable'));
      }
      await handleForwardAction(event, button, getDefaultForwardConfig(configs).id);
    } catch (error) {
      showToast(error.message || String(error), true);
    }
  });
  const showMenu = async (force = false) => {
    try {
      const selectionKey = getTelegramSourceKey(collectTelegramPayload(button).telegramSource);
      await showConfigMenu(wrapper, button, { force });
      if (selectionKey !== getTelegramSourceKey(collectTelegramPayload(button).telegramSource)) {
        hideConfigMenu(wrapper);
      }
    } catch (error) {
      hideConfigMenu(wrapper);
      showToast(error.message || String(error), true);
    }
  };
  button.addEventListener('contextmenu', event => {
    cancelForwardInteractionEvent(event);
    showMenu(true);
  });
  button.addEventListener('mouseenter', () => showMenu());
  button.addEventListener('focus', () => showMenu());
  wrapper.addEventListener('mouseleave', () => scheduleHideConfigMenu(wrapper));
  wrapper.addEventListener('focusout', () => setTimeout(() => {
    if (!wrapper.contains(document.activeElement) && !document.activeElement?.closest(`.${MENU_CLASS}`)) hideConfigMenu(wrapper);
  }, 0));
}

// Shared configuration-menu callbacks. Telegram messages remain whole messages
// (and albums); they are not mixed into the X media download draft.
async function handleForwardAction(event, button, configId = '') {
  cancelForwardInteractionEvent(event);
  if (button.disabled) return;
  hideConfigMenu();
  setButtonState(button, true, LABEL_SENDING());
  try {
    const payload = addTelegramPayloadThumbnail(collectTelegramPayload(button), button);
    const response = await chrome.runtime.sendMessage({ type: 'FORWARD_TELEGRAM_MEDIA', payload, configId });
    if (!response?.ok) throw new Error(response?.error || MESSAGE_FAILED());
    markConfigRecentlyUsed(configId);
    // Enqueueing is not delivery; the popup shows actual success or failure.
    showToast(chrome.i18n.getMessage('content_telegramQueued'));
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    button.disabled = false;
    syncTelegramButton(button);
  }
}

function stopForwardInteractionEvent(event) { event?.stopPropagation?.(); }
function preventNativeContextMenu(event) { event?.preventDefault?.(); }
function cancelForwardInteractionEvent(event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  event?.stopImmediatePropagation?.();
}

function initTelegramButtons() {
  const observer = new MutationObserver(records => {
    const ownElement = node => node.nodeType === 1 && (node.closest(`.${TELEGRAM_ACTION_CLASS}, .${MENU_CLASS}, #${TOAST_ID}`));
    const relevant = records.some(record => {
      if (ownElement(record.target)) return false;
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (!target?.closest('#column-center')) {
        // Still notice replacement of the entire chat column, but ignore the
        // chat list's unread counters, animations and unrelated sidebar updates.
        return [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 &&
          (node.id === 'column-center' || node.querySelector('#column-center')));
      }
      if (record.type === 'attributes') return true;
      return [...record.addedNodes, ...record.removedNodes].some(node => !ownElement(node));
    });
    if (relevant) scheduleTelegramRender();
  });
  observer.observe(document.body, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-mid', 'data-peer-id', 'data-type', 'class']
  });
  window.addEventListener('hashchange', () => { hideConfigMenu(); scheduleTelegramRender(); });
  window.addEventListener('resize', () => hideConfigMenu());
  document.addEventListener('scroll', () => hideConfigMenu(), true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hideConfigMenu(); });
  chrome.storage?.onChanged?.addListener(() => { configCache = null; configCacheAt = 0; });
  renderTelegramButtons();
}

if (document.body) initTelegramButtons();
else document.addEventListener('DOMContentLoaded', initTelegramButtons, { once: true });
