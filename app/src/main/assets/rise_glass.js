/* Rise Hub — Liquid Glass layer
   1) real-refraction glass engine  2) floating dock with draggable lens
   3) no-internet guard             4) Apple-style Today page
   Loaded after rise_hub.js, before DOMContentLoaded, so overrides are in place before boot. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var UA = navigator.userAgent || '';
  var CHROMIUM = /Chrome\//.test(UA) && !/iPhone|iPad|iPod/.test(UA);

  /* ================= 1. glass engine =================
     Builds a lens-shaped displacement map (bends the backdrop near the edge, with a little
     colour dispersion) plus a rim-light canvas, for any pill-shaped element. */
  var defs = null, uid = 0;
  function ensureDefs() {
    if (defs) return defs;
    defs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    defs.setAttribute('width', '0'); defs.setAttribute('height', '0');
    defs.setAttribute('aria-hidden', 'true'); defs.style.position = 'absolute';
    document.body.appendChild(defs);
    return defs;
  }
  function glass(el, w, h, B, S, str) {
    var id = 'rgf' + (uid++), r = h / 2, N = w * h;
    var D = new Float32Array(N), NX = new Float32Array(N), NY = new Float32Array(N), edge = [];
    el.style.width = w + 'px'; el.style.height = h + 'px';
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var i = y * w + x, px = x + .5 - w / 2, py = y + .5 - h / 2;
      var qx = Math.abs(px) - (w / 2 - r), qy = Math.abs(py) - (h / 2 - r);
      var ox = Math.max(qx, 0), oy = Math.max(qy, 0), l = Math.hypot(ox, oy);
      D[i] = -(l + Math.min(Math.max(qx, qy), 0) - r);
      if (l > 0) { NX[i] = Math.sign(px) * ox / l; NY[i] = Math.sign(py) * oy / l; }
      else if (qx > qy) NX[i] = Math.sign(px); else NY[i] = Math.sign(py);
      if (D[i] > 0 && D[i] < 16) edge.push(i);
    }
    if (CHROMIUM) {
      var c = document.createElement('canvas'); c.width = w; c.height = h;
      var cx = c.getContext('2d'), m = cx.createImageData(w, h);
      for (var j = 0; j < N; j++) {
        var rr = 128, gg = 128;
        if (D[j] > 0) { var t = Math.min(D[j] / B, 1), mg = Math.pow(1 - t, 2.4); rr = 128 - NX[j] * mg * 127; gg = 128 - NY[j] * mg * 127; }
        m.data[j * 4] = rr; m.data[j * 4 + 1] = gg; m.data[j * 4 + 2] = 128; m.data[j * 4 + 3] = 255;
      }
      cx.putImageData(m, 0, 0);
      var ch = function (sc, v, n) {
        return '<feDisplacementMap in="SourceGraphic" in2="map" scale="' + sc + '" xChannelSelector="R" yChannelSelector="G" result="d' + n + '"/>' +
          '<feColorMatrix in="d' + n + '" type="matrix" values="' + v + '" result="c' + n + '"/>';
      };
      var f = '<filter xmlns="http://www.w3.org/2000/svg" id="' + id + '" x="0" y="0" width="' + w + '" height="' + h + '" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB">' +
        '<feImage id="' + id + 'm" x="0" y="0" width="' + w + '" height="' + h + '" preserveAspectRatio="none" result="map"/>' +
        ch(S, '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0', 1) +
        ch(S * .92, '0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0', 2) +
        ch(S * .84, '0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0', 3) +
        '<feBlend in="c1" in2="c2" mode="screen" result="rg"/><feBlend in="rg" in2="c3" mode="screen" result="rgb"/>' +
        '<feGaussianBlur in="rgb" stdDeviation="0.6"/></filter>';
      ensureDefs().insertAdjacentHTML('beforeend', f);
      var fe = document.getElementById(id + 'm');
      if (fe) fe.setAttribute('href', c.toDataURL());
      var bf = 'url(#' + id + ') saturate(1.7) brightness(1.1)';
      el.style.backdropFilter = bf; el.style.webkitBackdropFilter = bf;
    }
    var sc = document.createElement('canvas'); sc.className = 'rg-spec'; sc.width = w; sc.height = h;
    var sx = sc.getContext('2d'), si = sx.createImageData(w, h);
    for (var k = 0; k < edge.length; k++) {
      var p = edge[k], dd = D[p], rim = Math.exp(-dd / 1.7), halo = Math.exp(-dd / 8), dp = NX[p] * -.55 + NY[p] * -.83;
      var a = (Math.pow(Math.max(dp, 0), 1.4) * (rim + halo * .28) + Math.pow(Math.max(-dp, 0), 1.4) * (rim * .55 + halo * .1) + rim * .18) * str;
      si.data[p * 4] = si.data[p * 4 + 1] = si.data[p * 4 + 2] = 255; si.data[p * 4 + 3] = Math.min(1, a) * 255;
    }
    sx.putImageData(si, 0, 0); el.appendChild(sc);
  }

  /* ================= 2. floating dock with liquid lens ================= */
  function initDock() {
    var dock = $('bottomNavigation'), bar = $('rgBar'), lens = $('rgLens'), items = $('rgItems');
    if (!dock || !bar || !lens || !items) return;
    var tabs = Array.prototype.slice.call(items.querySelectorAll('.rg-tab'));
    var names = tabs.map(function (t) { return t.dataset.tab; });
    var n = tabs.length, pad = 6, H = 70;
    var W = Math.min(innerWidth - 20, 430), slot = (W - pad * 2) / n, lensW = Math.round(slot + 8);
    dock.style.width = W + 'px';
    try { glass(bar, W, H, 26, 56, 1); glass(lens, lensW, 60, 22, 52, 1.2); } catch (e) { /* CSS frosted fallback stays */ }

    var pos = 0, vel = 0, target = 0, drag = false, press = 1, raf = 0, last = 0, act = -1, near = -1;
    function idxFrom(e) {
      var r = dock.getBoundingClientRect();
      return Math.max(0, Math.min(n - 1, (e.clientX - r.left - pad) / slot - .5));
    }
    function paint() {
      var sx = 1 + Math.min(Math.abs(vel) * .9, .35), x = pad + pos * slot + (slot - lensW) / 2;
      lens.style.transform = 'translate3d(' + x + 'px,0,0) scale(' + (press * sx) + ',' + press + ')';
    }
    function frame(t) {
      var dt = Math.min((t - last) / 16.7 || 1, 3); last = t;
      vel += (target - pos) * .17 * dt; vel *= Math.pow(.72, dt); pos += vel * dt;
      press += ((drag ? 1.17 : 1) - press) * .25;
      paint();
      var nr = Math.round(drag ? target : pos);
      if (drag && nr !== near) { near = nr; tabs.forEach(function (b, i) { b.classList.toggle('rg-near', i === nr); }); }
      var busy = drag || Math.abs(target - pos) > .0008 || Math.abs(vel) > .0008 || Math.abs(press - 1) > .002;
      if (busy) raf = requestAnimationFrame(frame); else { raf = 0; pos = target; vel = 0; press = 1; paint(); }
    }
    function kick() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }

    dock.addEventListener('pointerdown', function (e) {
      drag = true; try { dock.setPointerCapture(e.pointerId); } catch (x) { }
      target = idxFrom(e); lens.classList.add('down'); kick();
    });
    dock.addEventListener('pointermove', function (e) { if (drag) { target = idxFrom(e); kick(); } });
    function up() {
      if (!drag) return;
      drag = false; lens.classList.remove('down');
      var i = Math.round(target); target = i;
      tabs.forEach(function (b) { b.classList.remove('rg-near'); }); near = -1;
      if (names[i] && typeof window.switchTab === 'function') window.switchTab(names[i]);
      kick();
    }
    dock.addEventListener('pointerup', up);
    dock.addEventListener('pointercancel', up);
    // keyboard / accessibility activation (detail===0 means not a touch/mouse click)
    tabs.forEach(function (b) { b.addEventListener('click', function (e) { if (e.detail === 0) window.switchTab(b.dataset.tab); }); });

    window.RiseDock = {
      setTab: function (name, instant) {
        var i = names.indexOf(name); if (i < 0) return;
        target = i; if (instant) { pos = i; vel = 0; } kick();
        if (act !== i) { act = i; }
      }
    };
    paint();

    // keep the lens in sync when other code calls switchTab(...) (See All buttons, notifications, back)
    var orig = window.switchTab;
    if (typeof orig === 'function') {
      window.switchTab = function (name, opts) {
        var r = orig.apply(this, arguments);
        window.RiseDock.setTab(names.indexOf(name) < 0 ? 'today' : name, !!(opts && opts.instant));
        return r;
      };
    }
  }

  /* ================= 3. no-internet guard ================= */
  var Net = {
    shown: false, mode: 'offline', timer: 0, reloading: false,
    online: function () {
      try { if (window.AndroidBridge && typeof window.AndroidBridge.isNetworkAvailable === 'function' && window.AndroidBridge.isNetworkAvailable() === false) return false; } catch (e) { }
      return navigator.onLine !== false;
    },
    show: function (mode) {
      var scr = $('noInternetScreen'); if (!scr) return;
      Net.mode = mode; Net.shown = true;
      var t = $('rgNetTitle'), p = $('rgNetText'), s = $('rgNetStatusText');
      if (mode === 'server') {
        t.textContent = 'Can’t Reach Rise Hub';
        p.textContent = 'Your connection is weak or the store isn’t responding. Check your internet, then tap Restart.';
        s.textContent = 'Tap Restart to try again';
      } else {
        t.textContent = 'No Internet Connection';
        p.textContent = 'Your internet is off or not working. Turn on Wi-Fi or mobile data, then tap Restart.';
        s.textContent = 'Waiting for connection…';
      }
      scr.classList.remove('hidden', 'rg-back');
      if (!Net.timer) Net.timer = setInterval(Net.poll, 1500);
    },
    hide: function () {
      var scr = $('noInternetScreen'); if (scr) scr.classList.add('hidden');
      Net.shown = false; if (Net.timer) { clearInterval(Net.timer); Net.timer = 0; }
    },
    restart: function () {
      if (Net.reloading) return;
      Net.reloading = true;
      var scr = $('noInternetScreen'); if (scr) scr.classList.add('rg-back');
      var s = $('rgNetStatusText'); if (s) s.textContent = 'Restarting…';
      setTimeout(function () { location.reload(); }, 450);
    },
    poll: function () {
      // internet came back while the screen is up -> restart automatically
      if (Net.shown && Net.mode === 'offline' && Net.online()) {
        var s = $('rgNetStatusText'); if (s) s.textContent = 'Back online — restarting…';
        Net.restart();
      }
    }
  };
  window.RiseNet = Net;

  function initNet() {
    var rb = $('rgNetRestart'), sb = $('rgNetSettings');
    if (rb) rb.addEventListener('click', function () {
      if (Net.online()) { Net.restart(); return; }
      rb.classList.remove('rg-shake'); void rb.offsetWidth; rb.classList.add('rg-shake');
      var s = $('rgNetStatusText'); if (s) s.textContent = 'Still no internet. Turn on Wi-Fi or mobile data.';
    });
    if (sb) sb.addEventListener('click', function () {
      try { if (window.AndroidBridge && window.AndroidBridge.openNetworkSettings) window.AndroidBridge.openNetworkSettings(); } catch (e) { }
    });
    window.addEventListener('online', function () { Net.poll(); });
    window.addEventListener('offline', function () {
      // debounce short flickers, then show the page
      setTimeout(function () { if (!Net.online()) Net.show('offline'); }, 1200);
    });
    if (!Net.online()) Net.show('offline');   // before any catalog work starts
  }

  // Wrap the catalog loader: offline -> load NOTHING and show the page;
  // live fetch failed (only cache left) -> also show the page instead of stale data.
  if (typeof window.loadApps === 'function') {
    var origLoad = window.loadApps;
    window.loadApps = async function () {
      if (!Net.online()) { Net.show('offline'); return []; }
      var res = await origLoad.apply(this, arguments);
      try {
        if (!appsCatalog.length || catalogState.source === 'cache') Net.show('server');
        else if (Net.mode === 'server') Net.hide();
      } catch (e) { }
      return res;
    };
  }

  /* ================= 4. Apple-style Today ================= */
  function esc(v) { return typeof escapeHtml === 'function' ? escapeHtml(String(v == null ? '' : v)) : String(v == null ? '' : v); }
  function get(app) { return '<span onclick="event.stopPropagation()">' + renderGetButtonHtml(app.id) + '</span>'; }
  function heroCard(app, tag) {
    var img = app.screenshots[0] || app.icon, sub = app.todayHeroSubtitle || app.tagline || app.description || '';
    return '<div class="rg-card pressable" data-app="' + esc(app.id) + '">' +
      '<img class="rg-card-bg" src="' + esc(img) + '" alt="" aria-hidden="true">' +
      '<img class="rg-card-img" src="' + esc(img) + '" alt="' + esc(app.name) + '" loading="lazy">' +
      '<div class="rg-card-shade"></div>' +
      '<div class="rg-card-top"><span class="rg-tag">' + esc(app.todayHeroTag || tag) + '</span><h3>' + esc(app.name) + '</h3><p>' + esc(sub) + '</p></div>' +
      '<div class="rg-card-foot"><div class="rg-app"><img src="' + esc(app.icon) + '" alt=""><div style="min-width:0"><b>' + esc(app.name) + '</b><small>' +
      esc(app.developer || app.category) + (app.size !== '' ? ' · ' + esc(app.size) + ' MB' : '') + '</small></div></div>' + get(app) + '</div></div>';
  }
  function row(app, rank) {
    return '<div class="rg-row" data-app="' + esc(app.id) + '">' + (rank ? '<span class="rg-rank">' + rank + '</span>' : '') +
      '<img src="' + esc(app.icon) + '" alt=""><div class="rg-info"><b>' + esc(app.name) + '</b><small>' + esc(app.tagline || app.category || app.developer) + '</small></div>' + get(app) + '</div>';
  }
  function heading(kicker, title, more) {
    return '<div class="rg-sec-h"><div>' + (kicker ? '<span>' + kicker + '</span>' : '') + '<h3>' + title + '</h3></div>' +
      (more ? '<button type="button" onclick="switchTab(\'apps\')">See All</button>' : '') + '</div>';
  }
  window.renderTodayView = function () {
    var feed = $('todayHeroContainer'); if (!feed) return;
    if (!appsCatalog.length) { feed.innerHTML = '<div class="rg-empty">Apps are currently unavailable.</div>'; return; }
    var featured = appsCatalog.filter(function (a) { return a.isTodayHero; })
      .sort(function (a, b) { return (a.todayPriority - b.todayPriority) || a.name.localeCompare(b.name); });
    var all = getTodayFeaturedApps(appsCatalog.length);
    var heroes = (featured.length ? featured : all).slice(0, 3);
    var picks = all.filter(function (a) { return heroes.indexOf(a) < 0; });
    if (picks.length < 3) picks = all;
    picks = picks.slice(0, 9);
    var cols = '';
    for (var i = 0; i < picks.length; i += 3) cols += '<div class="rg-col">' + picks.slice(i, i + 3).map(function (a) { return row(a); }).join('') + '</div>';
    var ranked = appsCatalog.slice().sort(function (a, b) {
      var da = Number(String(a.downloads).replace(/[^0-9.]/g, '')) || 0, db = Number(String(b.downloads).replace(/[^0-9.]/g, '')) || 0;
      return db - da || Number(b.rating) - Number(a.rating);
    }).slice(0, 5);
    var tags = ['APP OF THE DAY', 'NOW TRENDING', 'EDITORS’ CHOICE'];
    var html = '';
    if (heroes[0]) html += heroCard(heroes[0], /game/i.test(heroes[0].category) ? 'GAME OF THE DAY' : tags[0]);
    if (picks.length) html += '<div>' + heading('NOW TRENDING', 'Top Picks for You', true) + '<div class="rg-cols no-scrollbar">' + cols + '</div></div>';
    if (heroes[1]) html += heroCard(heroes[1], tags[1]);
    html += '<div>' + heading('', 'Top Charts', false) + '<div class="rg-panel">' + ranked.map(function (a, k) { return row(a, k + 1); }).join('') + '</div></div>';
    if (heroes[2]) html += heroCard(heroes[2], tags[2]);
    feed.innerHTML = html;
    if (!feed._rgBound) {
      feed._rgBound = true;
      feed.addEventListener('click', function (e) {
        var el = e.target.closest('[data-app]');
        if (el && typeof openAppDetailModal === 'function') openAppDetailModal(el.getAttribute('data-app'));
      });
    }
  };

  function start() { initNet(); initDock(); }
  start(); // script sits at the end of <body>, so the DOM is ready and this runs before the store boots
})();
