/* ==========================================================================
   Rise Hub - Automated Update Checker (riseup-update.js)

   Behaviour
   - Compares the running version with the latest version published on GitHub.
   - Same or newer local version: the app runs normally, nothing is shown.
   - Older local version: the interface is locked behind an "Update Available"
     dialog. Mandatory updates (default) cannot be dismissed.
   - "Update Now":
       * native app + apkUrl in the manifest -> downloads the new APK through the
         native bridge (with progress) and opens the Android installer.
       * otherwise -> refreshes the remote catalog data and caches inside the
         app sandbox, records the applied version, then reloads the app.

   Remote manifest (version.json, same GitHub folder as app.json):
     {
       "version": "2.4.0",
       "mandatory": true,
       "releaseDate": "2026-10-10",
       "apkUrl": "https://.../RiseHub-2.4.0.apk",
       "notes": ["First note", "Second note"]
     }
   Fallback: if version.json is unavailable, an entry in app.json whose "slug"
   (or "id") is "rise-hub" is used (version, downloadUrl, changelog/description).
   ========================================================================== */
(function () {
  'use strict';

  if (window.RiseHubUpdater) return;

  /* ---------------------------- Configuration ---------------------------- */
  var BASE_URL = 'https://raw.githubusercontent.com/Imanshu999/InstaPro-hack/refs/heads/main/';
  var MANIFEST_URL = BASE_URL + 'version.json';
  var CATALOG_URL = BASE_URL + 'app.json';
  var FALLBACK_APP_VERSION = '2.3.0'; /* used only when no native bridge exists */
  var UPDATE_DOWNLOAD_ID = 'rise-hub-self-update';
  var CATALOG_CACHE_KEY = 'rise_hub_app_feed'; /* same key used by rise_hub.js */
  var PENDING_KEY = 'rise_hub_update_pending';
  var APPLIED_KEY = 'rise_hub_applied_version';
  var FETCH_TIMEOUT_MS = 8000;
  var RECHECK_INTERVAL_MS = 5 * 60 * 1000;
  var MAX_NOTES = 8;
  var MAX_NOTE_LENGTH = 220;

  /* ------------------------------- State --------------------------------- */
  var state = {
    manifest: null,
    locked: false,
    busy: false,
    downloaded: false,
    lastCheck: 0,
    checking: false,
    nodes: null,
    inertNodes: []
  };

  /* ------------------------------- Helpers ------------------------------- */
  function stripEmoji(value) {
    return String(value == null ? '' : value)
      .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }
  function storageRemove(key) {
    try { window.localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  function cleanVersion(value) {
    var text = String(value == null ? '' : value).trim().replace(/^v/i, '');
    return /^\d+(\.\d+)*$/.test(text) ? text : '';
  }

  function compareVersions(a, b) {
    var pa = cleanVersion(a).split('.');
    var pb = cleanVersion(b).split('.');
    var length = Math.max(pa.length, pb.length);
    for (var i = 0; i < length; i++) {
      var na = parseInt(pa[i] || '0', 10);
      var nb = parseInt(pb[i] || '0', 10);
      if (na > nb) return 1;
      if (na < nb) return -1;
    }
    return 0;
  }

  function getBaseVersion() {
    try {
      if (window.AndroidBridge && typeof window.AndroidBridge.getAppVersion === 'function') {
        var native = cleanVersion(window.AndroidBridge.getAppVersion());
        if (native) return native;
      }
    } catch (e) { /* fall through */ }
    return FALLBACK_APP_VERSION;
  }

  function getLocalVersion() {
    var base = getBaseVersion();
    var applied = cleanVersion(storageGet(APPLIED_KEY));
    return applied && compareVersions(applied, base) > 0 ? applied : base;
  }

  function hasNativeInstaller() {
    return !!(window.AndroidBridge &&
      typeof window.AndroidBridge.downloadFile === 'function' &&
      typeof window.AndroidBridge.installDownloadedFile === 'function');
  }

  /* --------------------------- Manifest handling ------------------------- */
  function normalizeNotes(raw) {
    var list = [];
    if (Array.isArray(raw)) list = raw;
    else if (typeof raw === 'string') list = raw.split(/\r?\n/);
    var out = [];
    for (var i = 0; i < list.length && out.length < MAX_NOTES; i++) {
      var line = stripEmoji(list[i]).replace(/^[-*]\s*/, '');
      if (line) out.push(line.slice(0, MAX_NOTE_LENGTH));
    }
    return out;
  }

  function normalizeManifest(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    var version = cleanVersion(data.version);
    if (!version) return null;
    var apkUrl = typeof data.apkUrl === 'string' ? data.apkUrl.trim() : '';
    if (!/^https:\/\//i.test(apkUrl)) apkUrl = '';
    return {
      version: version,
      mandatory: data.mandatory !== false && String(data.mandatory).toLowerCase() !== 'false',
      releaseDate: stripEmoji(data.releaseDate || ''),
      apkUrl: apkUrl,
      notes: normalizeNotes(data.notes)
    };
  }

  function manifestFromCatalog(list) {
    if (!Array.isArray(list)) return null;
    var entry = null;
    for (var i = 0; i < list.length; i++) {
      var item = list[i] || {};
      var key = String(item.slug || item.id || '').toLowerCase();
      if (key === 'rise-hub' || key === 'risehub') { entry = item; break; }
    }
    if (!entry) return null;
    return normalizeManifest({
      version: entry.version,
      mandatory: entry.mandatory,
      releaseDate: entry.updatedAt,
      apkUrl: entry.downloadUrl,
      notes: entry.changelog || entry.notes || entry.description
    });
  }

  function fetchJson(url) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS) : null;
    var separator = url.indexOf('?') === -1 ? '?' : '&';
    return fetch(url + separator + 't=' + Date.now(), {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
      signal: controller ? controller.signal : undefined
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    }).then(function (data) {
      if (timer) clearTimeout(timer);
      return { ok: true, data: data };
    }).catch(function () {
      if (timer) clearTimeout(timer);
      return { ok: false, data: null };
    });
  }

  function getRemoteManifest() {
    return fetchJson(MANIFEST_URL).then(function (primary) {
      if (primary.ok) return { ok: true, manifest: normalizeManifest(primary.data) };
      return fetchJson(CATALOG_URL).then(function (catalog) {
        if (catalog.ok) return { ok: true, manifest: manifestFromCatalog(catalog.data) };
        return { ok: false, manifest: null };
      });
    });
  }

  function readPending() {
    var raw = storageGet(PENDING_KEY);
    if (!raw) return null;
    try { return normalizeManifest(JSON.parse(raw)); } catch (e) { return null; }
  }

  /* ------------------------------- Styles -------------------------------- */
  function injectStyles() {
    if (document.getElementById('riseupStyles')) return;
    var css = [
      '.riseup-overlay{position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483000;background:#000;color:#f2f2f7;',
      'display:flex;align-items:center;justify-content:center;',
      'padding:calc(20px + env(safe-area-inset-top,0px)) calc(20px + env(safe-area-inset-right,0px)) calc(20px + env(safe-area-inset-bottom,0px)) calc(20px + env(safe-area-inset-left,0px));',
      'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
      '-webkit-font-smoothing:antialiased;overflow-y:auto;animation:riseupFade .22s ease-out}',
      '.riseup-card{width:100%;max-width:400px;background:#1c1c1e;border:1px solid rgba(255,255,255,.08);border-radius:24px;',
      'padding:28px 22px 22px;box-shadow:0 24px 80px rgba(0,0,0,.6);animation:riseupRise .28s cubic-bezier(.2,.8,.2,1)}',
      '.riseup-mark{width:60px;height:60px;border-radius:16px;background:#0a84ff;display:flex;align-items:center;justify-content:center;margin:0 auto 18px}',
      '.riseup-mark svg{width:30px;height:30px;display:block}',
      '.riseup-title{margin:0;text-align:center;font-size:22px;line-height:1.2;font-weight:700;letter-spacing:-.01em;color:#fff}',
      '.riseup-sub{margin:8px 0 0;text-align:center;font-size:14px;line-height:1.45;color:#98989f}',
      '.riseup-versions{display:flex;justify-content:center;gap:8px;margin:16px 0 0;flex-wrap:wrap}',
      '.riseup-chip{font-size:12px;font-weight:600;padding:5px 10px;border-radius:999px;background:#2c2c2e;color:#c7c7cc}',
      '.riseup-chip-new{background:rgba(10,132,255,.16);color:#0a84ff}',
      '.riseup-notes{margin:18px 0 0;padding:14px 16px;background:#2c2c2e;border-radius:16px}',
      '.riseup-notes-title{margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8e8e93}',
      '.riseup-notes ul{list-style:none;margin:0;padding:0;max-height:34vh;overflow-y:auto;-webkit-overflow-scrolling:touch}',
      '.riseup-notes li{position:relative;padding:8px 0 8px 16px;font-size:13px;line-height:1.45;color:#e5e5ea;border-top:1px solid #38383a}',
      '.riseup-notes li:first-child{border-top:0}',
      '.riseup-notes li:before{content:"";position:absolute;left:0;top:15px;width:6px;height:6px;border-radius:50%;background:#0a84ff}',
      '.riseup-progress{margin:18px 0 0}',
      '.riseup-track{height:6px;border-radius:999px;background:#3a3a3c;overflow:hidden}',
      '.riseup-fill{height:100%;width:0;border-radius:999px;background:#0a84ff;transition:width .2s ease}',
      '.riseup-fill.riseup-indeterminate{width:40%;animation:riseupSlide 1.1s ease-in-out infinite}',
      '.riseup-status{margin:10px 0 0;text-align:center;font-size:12px;font-weight:600;color:#98989f;min-height:16px}',
      '.riseup-status.riseup-error{color:#ff453a}',
      '.riseup-actions{margin-top:20px;display:flex;flex-direction:column;gap:10px}',
      '.riseup-btn{appearance:none;-webkit-appearance:none;border:0;width:100%;min-height:50px;border-radius:14px;font:inherit;font-size:16px;font-weight:700;cursor:pointer;',
      'transition:opacity .15s ease,transform .1s ease;-webkit-tap-highlight-color:transparent}',
      '.riseup-btn:active{transform:scale(.98)}',
      '.riseup-btn:focus-visible{outline:2px solid #64d2ff;outline-offset:2px}',
      '.riseup-btn[disabled]{opacity:.55;cursor:default;transform:none}',
      '.riseup-primary{background:#0a84ff;color:#fff}',
      '.riseup-secondary{background:transparent;color:#0a84ff;min-height:44px;font-size:15px;font-weight:600}',
      '@keyframes riseupFade{from{opacity:0}to{opacity:1}}',
      '@keyframes riseupRise{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}',
      '@keyframes riseupSlide{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}',
      '@media (prefers-reduced-motion:reduce){.riseup-overlay,.riseup-card,.riseup-fill.riseup-indeterminate{animation:none}}'
    ].join('');
    var style = document.createElement('style');
    style.id = 'riseupStyles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* -------------------------------- UI ----------------------------------- */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function buildMark() {
    var ns = 'http://www.w3.org/2000/svg';
    var wrap = el('div', 'riseup-mark');
    wrap.setAttribute('aria-hidden', 'true');
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', '#ffffff');
    svg.setAttribute('stroke-width', '2.4');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    var shaft = document.createElementNS(ns, 'path');
    shaft.setAttribute('d', 'M12 4v12');
    var head = document.createElementNS(ns, 'path');
    head.setAttribute('d', 'M6.5 11.5L12 17l5.5-5.5');
    var base = document.createElementNS(ns, 'path');
    base.setAttribute('d', 'M5 20h14');
    svg.appendChild(shaft);
    svg.appendChild(head);
    svg.appendChild(base);
    wrap.appendChild(svg);
    return wrap;
  }

  function buildOverlay(manifest) {
    injectStyles();

    var overlay = el('div', 'riseup-overlay');
    overlay.id = 'riseupOverlay';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'riseupTitle');
    overlay.setAttribute('aria-describedby', 'riseupSub');

    var card = el('div', 'riseup-card');
    card.appendChild(buildMark());

    var title = el('h2', 'riseup-title', 'Update Available');
    title.id = 'riseupTitle';
    card.appendChild(title);

    var sub = el('p', 'riseup-sub',
      manifest.mandatory
        ? 'A new version of Rise Hub is required to continue.'
        : 'A new version of Rise Hub is ready to install.');
    sub.id = 'riseupSub';
    card.appendChild(sub);

    var versions = el('div', 'riseup-versions');
    versions.appendChild(el('span', 'riseup-chip', 'Current ' + getLocalVersion()));
    versions.appendChild(el('span', 'riseup-chip riseup-chip-new', 'Latest ' + manifest.version));
    if (manifest.releaseDate) versions.appendChild(el('span', 'riseup-chip', manifest.releaseDate));
    card.appendChild(versions);

    var notes = manifest.notes.length ? manifest.notes : ['Performance improvements and stability fixes.'];
    var notesBox = el('div', 'riseup-notes');
    notesBox.appendChild(el('p', 'riseup-notes-title', 'What is new'));
    var list = el('ul');
    for (var i = 0; i < notes.length; i++) list.appendChild(el('li', '', notes[i]));
    notesBox.appendChild(list);
    card.appendChild(notesBox);

    var progress = el('div', 'riseup-progress');
    progress.hidden = true;
    var track = el('div', 'riseup-track');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    var fill = el('div', 'riseup-fill');
    track.appendChild(fill);
    progress.appendChild(track);
    card.appendChild(progress);

    var status = el('p', 'riseup-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    card.appendChild(status);

    var actions = el('div', 'riseup-actions');
    var primary = el('button', 'riseup-btn riseup-primary', 'Update Now');
    primary.type = 'button';
    primary.addEventListener('click', startUpdate);
    actions.appendChild(primary);

    var later = null;
    if (!manifest.mandatory) {
      later = el('button', 'riseup-btn riseup-secondary', 'Later');
      later.type = 'button';
      later.addEventListener('click', function () { unlock(); });
      actions.appendChild(later);
    }
    card.appendChild(actions);
    overlay.appendChild(card);

    state.nodes = {
      overlay: overlay, primary: primary, later: later, progress: progress,
      track: track, fill: fill, status: status
    };
    return overlay;
  }

  function setInertBackground(on) {
    var overlay = state.nodes && state.nodes.overlay;
    if (on) {
      state.inertNodes = [];
      var children = document.body.children;
      for (var i = 0; i < children.length; i++) {
        var node = children[i];
        if (node === overlay || node.tagName === 'SCRIPT' || node.tagName === 'STYLE') continue;
        if (node.hasAttribute('inert')) continue;
        node.setAttribute('inert', '');
        node.setAttribute('aria-hidden', 'true');
        state.inertNodes.push(node);
      }
    } else {
      for (var j = 0; j < state.inertNodes.length; j++) {
        state.inertNodes[j].removeAttribute('inert');
        state.inertNodes[j].removeAttribute('aria-hidden');
      }
      state.inertNodes = [];
    }
  }

  function lock(manifest) {
    if (state.locked) {
      /* Refresh text if a newer manifest arrived while the dialog is open. */
      if (state.manifest && state.manifest.version === manifest.version && !state.busy) return;
      if (state.busy) return;
      unlock(true);
    }
    state.manifest = manifest;
    state.downloaded = false;
    var overlay = buildOverlay(manifest);
    document.body.appendChild(overlay);
    setInertBackground(true);
    document.documentElement.style.overflow = 'hidden';
    state.locked = true;
    try { state.nodes.primary.focus(); } catch (e) { /* ignore */ }
  }

  function unlock(silent) {
    if (state.nodes && state.nodes.overlay && state.nodes.overlay.parentNode) {
      state.nodes.overlay.parentNode.removeChild(state.nodes.overlay);
    }
    setInertBackground(false);
    document.documentElement.style.overflow = '';
    state.locked = false;
    state.busy = false;
    state.nodes = null;
    if (!silent) state.manifest = null;
  }

  function setStatus(message, isError) {
    if (!state.nodes) return;
    state.nodes.status.textContent = message || '';
    state.nodes.status.className = 'riseup-status' + (isError ? ' riseup-error' : '');
  }

  function setProgress(percent) {
    if (!state.nodes) return;
    var n = state.nodes;
    n.progress.hidden = false;
    if (percent == null) {
      n.fill.className = 'riseup-fill riseup-indeterminate';
      n.fill.style.width = '';
      n.track.removeAttribute('aria-valuenow');
    } else {
      var value = Math.max(0, Math.min(100, Math.round(percent)));
      n.fill.className = 'riseup-fill';
      n.fill.style.width = value + '%';
      n.track.setAttribute('aria-valuenow', String(value));
    }
  }

  function setBusy(busy, label) {
    state.busy = busy;
    if (!state.nodes) return;
    state.nodes.primary.disabled = busy;
    if (label) state.nodes.primary.textContent = label;
    if (state.nodes.later) state.nodes.later.disabled = busy;
  }

  function showFailure(message) {
    setBusy(false, 'Try Again');
    if (state.nodes) state.nodes.progress.hidden = true;
    setStatus(message, true);
    try { state.nodes && state.nodes.primary.focus(); } catch (e) { /* ignore */ }
  }

  /* ---------------------------- Update process --------------------------- */
  function startUpdate() {
    if (state.busy || !state.manifest) return;
    var manifest = state.manifest;

    if (manifest.apkUrl && hasNativeInstaller()) {
      if (state.downloaded) {
        setStatus('Opening installer', false);
        try { window.AndroidBridge.installDownloadedFile(UPDATE_DOWNLOAD_ID); } catch (e) { /* ignore */ }
        return;
      }
      setBusy(true, 'Downloading');
      setStatus('Starting download', false);
      setProgress(0);
      try {
        window.AndroidBridge.downloadFile(manifest.apkUrl, 'RiseHub-' + manifest.version + '.apk', UPDATE_DOWNLOAD_ID);
      } catch (e) {
        showFailure('Unable to start the download. Check your connection and try again.');
      }
      return;
    }

    refreshContent(manifest);
  }

  function clearBrowserCaches() {
    if (!('caches' in window) || !window.caches.keys) return Promise.resolve();
    return window.caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) { return window.caches.delete(key); }));
    }).catch(function () { /* ignore */ });
  }

  function refreshContent(manifest) {
    setBusy(true, 'Updating');
    setStatus('Fetching latest data', false);
    setProgress(null);

    fetchJson(CATALOG_URL).then(function (result) {
      if (!result.ok || !Array.isArray(result.data)) {
        throw new Error('catalog');
      }
      setStatus('Applying update', false);
      storageSet(CATALOG_CACHE_KEY, JSON.stringify(result.data));
      return clearBrowserCaches();
    }).then(function () {
      storageSet(APPLIED_KEY, manifest.version);
      storageRemove(PENDING_KEY);
      setProgress(100);
      setStatus('Update complete. Restarting', false);
      setTimeout(function () { window.location.reload(); }, 700);
    }).catch(function () {
      showFailure('Update failed. Check your connection and try again.');
    });
  }

  /* ------------- Native download callbacks (shared with rise_hub.js) ----- */
  function wrapNativeCallback(name, handler) {
    var original = window[name];
    window[name] = function (appId) {
      if (String(appId) === UPDATE_DOWNLOAD_ID) {
        handler.apply(null, Array.prototype.slice.call(arguments, 1));
        return undefined;
      }
      if (typeof original === 'function') return original.apply(this, arguments);
      return undefined;
    };
  }

  wrapNativeCallback('onNativeDownloadProgress', function (percent) {
    if (!state.locked) return;
    var value = Number(percent) || 0;
    setProgress(value);
    setStatus('Downloading update ' + Math.round(value) + '%', false);
  });

  wrapNativeCallback('onNativeDownloadComplete', function () {
    if (!state.locked) return;
    state.downloaded = true;
    setProgress(100);
    setBusy(false, 'Update Now');
    setStatus('Download complete. Opening installer', false);
    try { window.AndroidBridge.installDownloadedFile(UPDATE_DOWNLOAD_ID); } catch (e) {
      showFailure('Unable to open the installer. Tap Update Now to try again.');
    }
  });

  wrapNativeCallback('onNativeDownloadError', function (message) {
    if (!state.locked) return;
    showFailure(stripEmoji(message) || 'Download failed. Try again.');
  });

  wrapNativeCallback('onNativeDownloadCancelled', function () {
    if (!state.locked) return;
    showFailure('Download cancelled. Try again.');
  });

  /* ----------------------- Hardware back / keyboard ---------------------- */
  (function patchBackHandler() {
    var original = window.handleHardwareBack;
    window.handleHardwareBack = function () {
      if (state.locked) {
        if (state.manifest && !state.manifest.mandatory && !state.busy) unlock();
        return true; /* consume the event; the app must not navigate behind the dialog */
      }
      return typeof original === 'function' ? original.apply(this, arguments) : false;
    };
  })();

  document.addEventListener('keydown', function (event) {
    if (!state.locked || !state.nodes) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (state.manifest && !state.manifest.mandatory && !state.busy) unlock();
      return;
    }
    if (event.key === 'Tab') {
      var focusable = [state.nodes.primary];
      if (state.nodes.later) focusable.push(state.nodes.later);
      focusable = focusable.filter(function (node) { return !node.disabled; });
      if (!focusable.length) { event.preventDefault(); return; }
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      var active = document.activeElement;
      if (event.shiftKey && (active === first || !state.nodes.overlay.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !state.nodes.overlay.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
  }, true);

  /* ------------------------------ Checking ------------------------------- */
  function evaluate(manifest) {
    if (manifest && compareVersions(getLocalVersion(), manifest.version) < 0) {
      storageSet(PENDING_KEY, JSON.stringify(manifest));
      lock(manifest);
    } else {
      storageRemove(PENDING_KEY);
      if (state.locked && !state.busy) unlock();
    }
  }

  function checkForUpdate(force) {
    var now = Date.now();
    if (state.checking) return Promise.resolve();
    if (!force && now - state.lastCheck < RECHECK_INTERVAL_MS) return Promise.resolve();
    state.checking = true;
    state.lastCheck = now;

    return getRemoteManifest().then(function (result) {
      /* Network or feed unreachable: keep whatever state we already have. */
      if (result.ok) evaluate(result.manifest);
    }).catch(function () { /* never block the app because of a failed check */ })
      .then(function () { state.checking = false; });
  }

  function start() {
    /* Enforce a previously discovered update immediately, even before the network answers. */
    var pending = readPending();
    if (pending && compareVersions(getLocalVersion(), pending.version) < 0) {
      lock(pending);
    } else if (pending) {
      storageRemove(PENDING_KEY);
    }
    checkForUpdate(true);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') checkForUpdate(false);
    });
    window.addEventListener('online', function () { checkForUpdate(true); });
  }

  window.RiseHubUpdater = {
    check: function () { return checkForUpdate(true); },
    getLocalVersion: getLocalVersion,
    compareVersions: compareVersions,
    isLocked: function () { return state.locked; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
