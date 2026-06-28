const openOptionsButton = document.getElementById("open-options");
const backToQueueButton = document.getElementById("back-to-queue");
const headerMain = document.getElementById("header-main");
const headerSettings = document.getElementById("header-settings");
const queueView = document.getElementById("view-queue");
const queueTabs = document.getElementById("queue-tabs");
const settingsView = document.getElementById("view-settings");
const queueList = document.getElementById("queue-list");
const queuePagination = document.getElementById("queue-pagination");
const extensionName = document.getElementById("extension-name");
const configList = document.getElementById("config-list");
const newConfigButton = document.getElementById("new-config");
const form = document.getElementById("settings-form");
const configIdInput = document.getElementById("config-id");
const noteInput = document.getElementById("config-note");
const botTokenInput = document.getElementById("bot-token");
const chatIdInput = document.getElementById("chat-id");
const settingsStatus = document.getElementById("settings-status");
const keepCompletedItemsInput = document.getElementById("keep-completed-items");
const languageSelect = document.getElementById("language-select");
const maxCompletedItemsRow = document.getElementById("max-completed-items-row");
const maxCompletedItemsSelect = document.getElementById("max-completed-items");
const forwardEndpointRow = document.getElementById("forward-endpoint-row");
const forwardEndpointHost = document.getElementById("forward-endpoint-host");
const clearForwardEndpointButton = document.getElementById("clear-forward-endpoint");
const exportSettingsButton = document.getElementById("export-settings");
const importSettingsButton = document.getElementById("import-settings");
const importSettingsFileInput = document.getElementById("import-settings-file");

const QUEUE_KEY = "forwardQueue";
const DRAFT_KEY = "forwardDraft";
const GENERAL_SETTINGS_KEY = "generalSettings";
const QUEUE_ITEMS_PER_PAGE = 5;
const DEFAULT_GENERAL_SETTINGS = {
  keepCompletedItems: false,
  maxCompletedItems: 5,
  endpointUrl: "",
  endpointSetupUrl: "",
  endpointKey: ""
};
const ALLOWED_COMPLETED_RECORD_COUNTS = [5, 10, 30];
const ICONS = {
  dragHandle: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="5" cy="4" r="1"/><circle cx="11" cy="4" r="1"/><circle cx="5" cy="8" r="1"/><circle cx="11" cy="8" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="11" cy="12" r="1"/></svg>',
  send: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 2.5 7 9"/><path d="m13.5 2.5-3.6 11-3-4.6-4.4-2.8 11-3.6Z"/></svg>',
  retry: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 7a5 5 0 1 0-1.5 3.6"/><path d="M13 3.5V7h-3.5"/></svg>',
  close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4.5 4.5 11.5 11.5"/><path d="M11.5 4.5 4.5 11.5"/></svg>',
  error: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.6"/><line x1="8" y1="4.5" x2="8" y2="9"/><circle cx="8" cy="11.5" r="0.7" fill="currentColor" stroke="none"/></svg>'
};

let configs = [];
let currentQueue = [];
let currentDraft = null;
let activeQueueFilter = "all";
let queueCurrentPage = 0;
let lastQueueSignature = "";
let draggedConfigItem = null;
let snapEndTime = 0;
const SNAP_DURATION_MS = 290;
