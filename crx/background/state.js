var __i18nReady = false;
Save2TG.I18n.init().then(function () { __i18nReady = true; }).catch(function () { __i18nReady = true; });
function __t(key, subs) { return __i18nReady ? Save2TG.I18n.t(key, subs) : key; }
const TELEGRAM_API_BASE = "https://api.telegram.org";
const QUEUE_KEY = "forwardQueue";
const DRAFT_KEY = "forwardDraft";
const TELEGRAM_CONFIGS_KEY = "telegramConfigs";
const GENERAL_SETTINGS_KEY = "generalSettings";
const UI_LANGUAGE_KEY = "uiLanguage";
const DEFAULT_GENERAL_SETTINGS = {
  keepCompletedItems: false,
  maxCompletedItems: 5,
  endpointUrl: "",
  endpointSetupUrl: "",
  endpointKey: ""
};
const ALLOWED_COMPLETED_RECORD_COUNTS = [5, 10, 30];
const VIDEO_HOST_PATTERN = /^https:\/\/video\.twimg\.com\//;
const TELEGRAM_MEDIA_GROUP_MAX_ITEMS = 10;
const TELEGRAM_PHOTO_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const TELEGRAM_FILE_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const MAX_CAPTURED_GRAPHQL_URLS_PER_TAB = 20;
const TELEGRAM_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const TELEGRAM_SEND_MIN_INTERVAL_MS = 1250;
const FORWARD_ENDPOINT_BINDING_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_CONCURRENT_FORWARD_TASKS = 3;
let queueProcessingPromise = null;
let queueUpdatePromise = Promise.resolve();
const activeQueueItemIds = new Set();
const activeQueueChatKeys = new Set();
const activeQueueAbortControllers = new Map();
const telegramSendQueuesByChat = new Map();
const telegramLastSendAtByChat = new Map();
const capturedGraphqlRequestsByTab = new Map();
const pendingForwardEndpointBindings = new Map();
