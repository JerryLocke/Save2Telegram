(function (root) {
  // IIFE: exposes Save2TG.I18n for locale-aware UI in the extension
  if (root.Save2TG && root.Save2TG.I18n) return;

  var STORAGE_KEY = 'uiLanguage';  // chrome.storage.local key for locale preference
  var SUPPORTED = ['en', 'zh_CN'];  // Supported locales
  var dict = {};  // Loaded message dictionary
  var locale = 'en';  // Current active locale
  var initPromise = null;  // Cached init promise (singleton)

  /** Resolve the effective locale from storage override or browser UI language. */
  function resolveLocale() {
    return new Promise(function (resolve) {
      var settled = false;
      var done = function (loc) { if (settled) return; settled = true; resolve(loc); };
      setTimeout(function () { done(autoLocale()); }, 200);
      try {
        chrome.storage.local.get(STORAGE_KEY, function (r) {
          if (chrome.runtime.lastError) { done(autoLocale()); return; }
          var override = r && r[STORAGE_KEY];
          if (override === 'en' || override === 'zh_CN') { done(override); }
          else { done(autoLocale()); }
        });
      } catch (_) { done(autoLocale()); }
    });
  }

  /** Auto-detect locale from chrome.i18n API (browser UI language). */
  function autoLocale() {
    try {
      var ui = (chrome.i18n.getUILanguage() || '').toLowerCase();
      return ui.indexOf('zh') === 0 ? 'zh_CN' : 'en';
    } catch (_) { return 'en'; }
  }

  /** Fetch the messages.json dictionary for the given locale. */
  function loadDict(loc) {
    var url = chrome.runtime.getURL('_locales/' + loc + '/messages.json');
    return fetch(url).then(function (r) { return r.json(); });
  }

  /** Initialize i18n: resolve locale, load dictionary, return promise resolving to locale string. */
  function init() {
    if (initPromise) return initPromise;
    initPromise = resolveLocale().then(function (loc) {
      locale = loc;
      return loadDict(loc).catch(function () {
        if (loc === 'en') return {};
        locale = 'en';
        return loadDict('en').catch(function () { return {}; });
      });
    }).then(function (d) {
      dict = d || {};
      return locale;
    });
    return initPromise;
  }

  function reset() { initPromise = null; }

  function t(key, subs) {
    var entry = dict && dict[key];
    var msg = entry && entry.message ? entry.message : key;
    if (subs == null) return msg;
    var arr = Array.isArray(subs) ? subs : [subs];
    msg = msg.replace(/\$([A-Za-z0-9_]+)\$/g, function (whole, name) {
      var ph = entry && entry.placeholders && entry.placeholders[name.toLowerCase()];
      if (ph && typeof ph.content === 'string') {
        return ph.content.replace(/\$(\d+)/g, function (_, n) {
          var idx = Number(n) - 1;
          return arr[idx] != null ? String(arr[idx]) : '';
        });
      }
      return whole;
    });
    msg = msg.replace(/\$(\d+)/g, function (_, n) {
      var idx = Number(n) - 1;
      return arr[idx] != null ? String(arr[idx]) : '';
    });
    return msg;
  }

  function setLocale(loc) {
    if (loc !== 'auto' && SUPPORTED.indexOf(loc) === -1) return Promise.resolve(false);
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.set({ uiLanguage: loc }, function () { reset(); resolve(true); });
      } catch (_) { resolve(false); }
    });
  }

  function getLocale() { return locale; }

  function applyDom(rootEl) {
    rootEl = rootEl || document;
    var nodes = rootEl.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      el.textContent = t(el.getAttribute('data-i18n'));
    }
    var titled = rootEl.querySelectorAll('[data-i18n-title]');
    for (var j = 0; j < titled.length; j++) {
      var titleText = t(titled[j].getAttribute('data-i18n-title'));
      titled[j].title = titleText;
      if (titled[j].hasAttribute('aria-label')) {
        titled[j].setAttribute('aria-label', titleText);
      }
    }
    var phs = rootEl.querySelectorAll('[data-i18n-placeholder]');
    for (var k = 0; k < phs.length; k++) {
      phs[k].placeholder = t(phs[k].getAttribute('data-i18n-placeholder'));
    }
    var tooltips = rootEl.querySelectorAll('[data-i18n-tooltip]');
    for (var l = 0; l < tooltips.length; l++) {
      tooltips[l].setAttribute('data-tooltip', t(tooltips[l].getAttribute('data-i18n-tooltip')));
    }
    var ariaLabels = rootEl.querySelectorAll('[data-i18n-aria-label]');
    for (var m = 0; m < ariaLabels.length; m++) {
      ariaLabels[m].setAttribute('aria-label', t(ariaLabels[m].getAttribute('data-i18n-aria-label')));
    }
    if (rootEl === document && document.documentElement) {
      document.documentElement.lang = locale === 'zh_CN' ? 'zh-CN' : 'en';
    }
  }

  root.Save2TG = root.Save2TG || {};
  root.Save2TG.I18n = {
    init: init, reset: reset, t: t,
    setLocale: setLocale, getLocale: getLocale,
    applyDom: applyDom, STORAGE_KEY: STORAGE_KEY, SUPPORTED: SUPPORTED
  };
})(typeof self !== 'undefined' ? self : window);
