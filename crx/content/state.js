const BUTTON_ID = "tf-forward-button";
const WRAPPER_ID = "tf-forward-action";
const BUTTON_CLASS = "tf-forward-button";
const WRAPPER_CLASS = "tf-forward-action";
const MENU_CLASS = "tf-forward-config-menu";
const TOAST_ID = "tf-forward-toast";
const FORWARD_DRAFT_KEY = "forwardDraft";
const GRAPHQL_MEDIA_QUERY_TIMEOUT_MS = 3000;
const GRAPHQL_MEDIA_CACHE_MESSAGE_SOURCE = "Save2Telegram";
const GRAPHQL_MEDIA_CACHE_MESSAGE_TYPE = "GRAPHQL_MEDIA_CACHE";
const MAX_GRAPHQL_MEDIA_CACHE_ENTRIES = 800;
const LABEL_READY = function () { return chrome.i18n.getMessage("content_labelReady"); };
const LABEL_SENDING = function () { return chrome.i18n.getMessage("content_labelSending"); };
const LABEL_SENT = function () { return chrome.i18n.getMessage("content_labelSent"); };
const LABEL_RECENT = function () { return chrome.i18n.getMessage("content_labelRecent"); };
const MESSAGE_SENT = function () { return chrome.i18n.getMessage("content_messageSent"); };
const MESSAGE_FAILED = function () { return chrome.i18n.getMessage("content_messageFailed"); };
const MESSAGE_DRAFT_ADDED = function (count) { return chrome.i18n.getMessage("content_draftAdded", [count]); };
const MESSAGE_DRAFT_REMOVED = function (count) { return chrome.i18n.getMessage("content_draftRemoved", [count]); };
const MESSAGE_DRAFT_QUEUED = function () { return chrome.i18n.getMessage("content_draftQueued"); };
const MESSAGE_NO_MEDIA = function () { return chrome.i18n.getMessage("content_noMedia"); };
const MESSAGE_NO_DOWNLOADABLE_VIDEO = function () { return chrome.i18n.getMessage("content_noDownloadableVideo"); };
const ICON_READY = `
<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path d="M21.7 3.3a1.1 1.1 0 0 0-1.2-.2L3 10.1a1.1 1.1 0 0 0 .1 2.1l4.8 1.5 1.8 5.7a1.1 1.1 0 0 0 2 .2l2.7-4.1 4.9 3.6a1.1 1.1 0 0 0 1.7-.7l1.1-14a1.1 1.1 0 0 0-.4-1.1Zm-4.2 4.4-8.2 7.1-.7-2.3 8.9-4.8Z"/>
</svg>`;
const ICON_SENT = `
<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path d="M9.5 16.7 4.8 12l-1.4 1.4 6.1 6.1L21 8l-1.4-1.4L9.5 16.7Z"/>
</svg>`;

let currentUrl = location.href;
let renderTimer = null;
let renderBurstTimers = [];
let lastResourceRenderAt = 0;
let configCache = null;
let configCacheAt = 0;
let draftCache = null;
let activeConfigMenuWrapper = null;
const graphqlMediaCache = new Map();
