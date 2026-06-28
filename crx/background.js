// MV3 service worker entrypoint. Keep background logic in crx/background/*.js.
importScripts(
  'lib/i18n.js',
  'background/state.js',
  'background/forward-draft.js',
  'background/settings.js',
  'background/queue.js',
  'background/endpoints.js',
  'background/media.js',
  'background/telegram.js',
  'background/utils.js',
  'background/events.js'
);
