// ================= RISE HUB STORE ENGINE =================
// Public standalone app store.
// App catalog source: GitHub Raw JSON feed with localStorage cache fallback.

const APP_FEED_URL = "https://raw.githubusercontent.com/Imanshu999/InstaPro-hack/refs/heads/main/app.json";
const NOTIFICATION_FEED_URL = "https://raw.githubusercontent.com/Imanshu999/InstaPro-hack/refs/heads/main/notifications.json";
const CACHE_KEY = "rise_hub_app_feed";

let appsCatalog = [];
const catalogState = {
  items: [],
  status: 'idle',
  source: 'none',
  error: null,
  bootPromise: null,
  revision: 0
};
let currentTab = 'today';
let currentFilteredCategoryGames = 'All';
let currentFilteredCategoryApps = 'All';
let installedAppIds = new Set();
let isDeviceOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
let networkProbeInProgress = false;
let activeCarouselIndex = 0;
let carouselAutoAdvanceTimer = null;
let feedLoadInProgress = false;
const DOWNLOADS_KEY = 'rise_hub_download_history';
const WISHLIST_KEY = 'rise_hub_wishlist';
const DOWNLOAD_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
let pendingDownloadAppId = null;
let downloadInProgressId = null;
let downloadHistory = [];
let wishlistIds = new Set();
let diagnostics = [];
let activeDownloadAbortController = null;
let downloadStartedAt = 0;
let downloadSpeedBytesPerSecond = 0;
let searchDebounceTimer = null;
let detailMediaIndex = 0;
const ONBOARDING_KEY = 'rise_hub_onboarding_seen_v1';
const ONBOARDING_STEPS = [
  { title: 'Browse the store', body: 'Use Today, Games, Apps, Search, Downloads, and Wishlist to move between the main store areas.', target: '#bottomNavigation' },
  { title: 'Get an app', body: 'Open an app, choose GET, confirm the download, and watch the progress state. You can cancel an active download at any time.', target: '#downloadConfirmModal' },
  { title: 'Check downloads', body: 'Open Downloads to see completed items, expiration information, and available updates.', target: '#tabBtn-downloads' },
  { title: 'Save favorites', body: 'Use the bookmark control on an app to add it to Wishlist for quick access later.', target: '#tabBtn-wishlist' }
];
let onboardingStepIndex = 0;


function extractFeedItems(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return null;

  const candidates = [data.apps, data.catalog, data.items, data.data, data.results];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  return null;
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['true', '1', 'yes', 'featured', 'today'].includes(value.trim().toLowerCase());
  return false;
}

function stripEmoji(value) {
  return String(value ?? '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/\s{2,}/g, ' ').trim();
}
function normalizeToken(value) { return stripEmoji(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function categoryIs(app, category) { return normalizeToken(app?.category) === normalizeToken(category); }
function isGameApp(app) {
  const type = normalizeToken(app?.type), category = normalizeToken(app?.category);
  const tags = Array.isArray(app?.tags) ? app.tags.map(normalizeToken) : [];
  return type === 'game' || category === 'games' || category === 'game' || tags.includes('games') || tags.includes('game');
}
function isStoreApp(app) { return !isGameApp(app); }

function normalizeApp(item, index) {
  if (!item || typeof item !== 'object') return null;

  const id = item.id ?? item.packageName ?? item.appId ?? item.slug ?? item.name ?? item.title;
  const name = item.name ?? item.title;
  if (id == null || name == null) return null;

  const icon = item.icon ?? item.image ?? item.logo ?? "";
  const screenshots = Array.isArray(item.screenshots)
    ? item.screenshots.filter(value => typeof value === 'string' && value.trim())
    : [];
  const videoUrls = Array.isArray(item.videoUrls)
    ? item.videoUrls.filter(value => typeof value === 'string' && value.trim())
    : (typeof item.videoUrl === 'string' && item.videoUrl.trim() ? [item.videoUrl.trim()] : []);

  return {
    id: String(id),
    name: stripEmoji(name),
    developer: stripEmoji(item.developer ?? item.author ?? item.publisher ?? ""),
    tagline: stripEmoji(item.tagline ?? item.subtitle ?? item.shortDescription ?? ""),
    description: stripEmoji(item.description ?? ""),
    icon: typeof icon === 'string' ? icon : "",
    category: stripEmoji(item.category ?? item.genre ?? ""),
    version: stripEmoji(item.version ?? ""),
    size: item.size ?? item.fileSize ?? "",
    rating: stripEmoji(item.rating ?? ""),
    downloads: stripEmoji(item.downloads ?? item.downloadCount ?? ""),
    reviewsCount: stripEmoji(item.reviewsCount ?? item.reviewCount ?? ""),
    ageRating: stripEmoji(item.ageRating ?? item.contentRating ?? ""),
    downloadUrl: String(item.downloadUrl ?? item.downloadURL ?? item.url ?? item.link ?? "").trim(),
    updatedAt: stripEmoji(item.updatedAt ?? item.updated_at ?? item.lastUpdated ?? ""),
    type: stripEmoji(item.type ?? item.appType ?? ""),
    tags: Array.isArray(item.tags) ? item.tags.map(stripEmoji).filter(Boolean) : String(item.tags ?? '').split(',').map(stripEmoji).filter(Boolean),
    versionHistory: Array.isArray(item.versionHistory)
      ? item.versionHistory.filter(entry => entry && typeof entry === 'object').map(entry => ({
          version: String(entry.version ?? ''),
          date: String(entry.date ?? entry.updatedAt ?? ''),
          notes: String(entry.notes ?? entry.changelog ?? entry.description ?? '')
        }))
      : [],
    screenshots,
    videoUrls,
    isTodayHero: toBoolean(item.isTodayHero ?? item.todayHero ?? item.featured ?? item.featuredToday),
    todayHeroTag: String(item.todayHeroTag ?? item.featuredLabel ?? item.heroTag ?? ""),
    todayHeroSubtitle: String(item.todayHeroSubtitle ?? item.featuredSubtitle ?? item.heroSubtitle ?? item.tagline ?? ""),
    todayPriority: Number(item.todayPriority ?? item.featuredPriority ?? 9999)
  };
}

function normalizeFeed(data) {
  const items = extractFeedItems(data);
  if (!Array.isArray(items)) {
    throw new Error("Invalid app feed structure");
  }

  const normalized = items.map(normalizeApp).filter(Boolean);
  if (normalized.length === 0) {
    throw new Error("App feed is empty or unusable");
  }

  return normalized;
}

function setOfflineMode(isOffline, hasCachedData = false) {
  const genuinelyOffline = isOffline === true && (typeof navigator === 'undefined' || navigator.onLine === false);
  isDeviceOnline = !genuinelyOffline;

  document.body.classList.toggle('offline-mode', genuinelyOffline);
  const banner = document.getElementById('offlineBanner');
  if (banner) {
    banner.classList.toggle('hidden', !(genuinelyOffline && hasCachedData));
    banner.setAttribute('aria-hidden', genuinelyOffline && hasCachedData ? 'false' : 'true');
  }
  const status = document.getElementById('feedStatus');
  if (status && genuinelyOffline && hasCachedData) {
    status.classList.add('hidden');
  }
}

function setFeedLoading(isLoading) {
  const loading = document.getElementById('feedLoadingState');
  const main = document.getElementById('storeMain');
  if (loading) {
    loading.classList.toggle('hidden', !isLoading);
    if (isLoading) loading.innerHTML = `<div class="space-y-3"><div class="skeleton h-5 w-28"></div><div class="skeleton h-56 w-full rounded-3xl"></div><div class="grid grid-cols-2 gap-3"><div class="skeleton h-24"></div><div class="skeleton h-24"></div></div></div>`;
  }
  if (main) main.classList.toggle('hidden', isLoading);
}

function setFeedStatus(message) {
  const status = document.getElementById('feedStatus');
  const text = document.getElementById('feedStatusText');
  if (!status || !text) return;

  if (message) {
    text.textContent = message;
    status.classList.remove('hidden');
  } else {
    text.textContent = '';
    status.classList.add('hidden');
  }
}

function showFeedEmptyState(showRetry = true) {
  const main = document.getElementById('storeMain');
  const empty = document.getElementById('feedEmptyState');
  const retry = document.getElementById('feedRetryButton');

  setFeedLoading(false);
  if (main) main.classList.remove('hidden');

  document.querySelectorAll('.tab-pane').forEach(el => el.classList.add('hidden'));
  if (empty) {
    empty.classList.remove('hidden');
    empty.classList.add('flex');
  }
  if (retry) retry.classList.toggle('hidden', !showRetry);
}

function hideFeedEmptyState() {
  const empty = document.getElementById('feedEmptyState');
  if (empty) {
    empty.classList.add('hidden');
    empty.classList.remove('flex');
  }
}

function saveFeedCache(rawData) {
  // WebView storage may be unavailable; cache failures must not discard live data.
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(rawData));
    return true;
  } catch (error) {
    logDiagnostic('Catalog cache could not be saved; continuing with live data.');
    return false;
  }
}

function loadCachedApps() {
  let cached = null;
  try {
    cached = localStorage.getItem(CACHE_KEY);
  } catch (error) {
    logDiagnostic('Catalog cache is unavailable in this WebView.');
    return false;
  }
  if (!cached) return false;

  try {
    const rawData = JSON.parse(cached);
    const normalized = normalizeFeed(rawData);
    appsCatalog = normalized;
    catalogState.items = normalized;
    catalogState.source = 'cache';
    catalogState.status = 'ready';
    return true;
  } catch (error) {
    try { localStorage.removeItem(CACHE_KEY); } catch (_) {}
    logDiagnostic('Saved catalog cache was invalid and has been ignored.');
    return false;
  }
}

function logDiagnostic(message) {
  diagnostics.unshift({ time: new Date().toLocaleTimeString(), message: String(message) });
  diagnostics = diagnostics.slice(0, 30);
  const el = document.getElementById('diagnosticsLog');
  if (el) el.innerHTML = diagnostics.map(item => `<div class="py-1 border-b border-black/[0.04] dark:border-white/[0.04]"><span class="opacity-60">${escapeHtml(item.time)}</span> ${escapeHtml(item.message)}</div>`).join('');
}

function publishCatalog(items, source = 'network') {
  const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];
  appsCatalog = safeItems;
  catalogState.items = safeItems;
  catalogState.source = source;
  catalogState.status = safeItems.length ? 'ready' : 'empty';
  catalogState.error = null;
  catalogState.revision += 1;
}

function renderCatalogImmediately() {
  if (!document || !document.body) return;
  if (appsCatalog.length > 0) {
    hideFeedEmptyState();
    setFeedLoading(false);
    renderAllViews();
  } else {
    setFeedLoading(false);
    showFeedEmptyState(true);
  }
}

function getCachedCatalog() {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (!cached) return null;
    const rawData = JSON.parse(cached);
    const normalized = normalizeFeed(rawData);
    return { rawData, normalized };
  } catch (error) {
    try { localStorage.removeItem(CACHE_KEY); } catch (_) {}
    return null;
  }
}

function loadCachedApps() {
  const cached = getCachedCatalog();
  if (!cached) return false;
  publishCatalog(cached.normalized, 'cache');
  return true;
}

function cacheAndPublishCatalog(rawData) {
  const normalized = normalizeFeed(rawData);
  // Cache the complete validated source immediately after a successful parse.
  saveFeedCache(rawData);
  publishCatalog(normalized, 'network');
  return normalized;
}

window.RiseHubOpenNotificationApp = function(appId) {
  const id = String(appId || '');
  if (!id) return;

  const open = (attempt = 0) => {
    const app = Array.isArray(appsCatalog) ? appsCatalog.find(item => String(item.id) === id) : null;
    if (app && typeof openAppDetailModal === 'function') {
      openAppDetailModal(app.id);
      return;
    }
    if (attempt < 12) setTimeout(() => open(attempt + 1), 500);
  };

  open();
};

async function fetchLiveCatalog() {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), 12000) : null;

  try {
    const response = await fetch(APP_FEED_URL, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
      signal: controller ? controller.signal : undefined
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rawData = await response.json();
    return cacheAndPublishCatalog(rawData);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function finishCatalogLoad() {
  feedLoadInProgress = false;
  catalogState.bootPromise = null;
}

async function loadApps(options = {}) {
  const forceNetwork = options.forceNetwork === true;

  if (catalogState.bootPromise) return catalogState.bootPromise;

  catalogState.bootPromise = (async () => {
    feedLoadInProgress = true;
    catalogState.status = 'loading';
    catalogState.error = null;
    logDiagnostic('Catalog boot started.');

    setFeedLoading(true);
    setFeedStatus('');

    // Never leave the UI empty while waiting for GitHub when a valid cache exists.
    if (!forceNetwork && appsCatalog.length === 0) {
      const usedCache = loadCachedApps();
      if (usedCache) {
        renderCatalogImmediately();
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          isDeviceOnline = false;
          setOfflineMode(true, true);
          logDiagnostic('Using cached catalog while offline.');
        }
      }
    }

    const deviceIsOffline = typeof navigator !== 'undefined' && navigator.onLine === false;

    if (deviceIsOffline) {
      if (appsCatalog.length > 0) {
        catalogState.status = 'ready';
        catalogState.source = 'cache';
        isDeviceOnline = false;
        setOfflineMode(true, true);
        renderCatalogImmediately();
        logDiagnostic(`Offline boot complete: ${appsCatalog.length} cached items.`);
      } else {
        publishCatalog([], 'none');
        setOfflineMode(true, false);
        showFeedEmptyState(true);
        logDiagnostic('Offline boot failed: no cached catalog.');
      }
      return appsCatalog;
    }

    try {
      const normalized = await fetchLiveCatalog();
      isDeviceOnline = true;
      setOfflineMode(false, false);
      setFeedStatus('');
      renderCatalogImmediately();
      logDiagnostic(`Live catalog ready: ${normalized.length} items.`);
      return normalized;
    } catch (error) {
      catalogState.error = error?.message || 'Catalog request failed';
      logDiagnostic(`Live catalog failed: ${catalogState.error}`);

      // A failed GitHub request is not proof that the device is offline.
      const usedCache = loadCachedApps();
      if (usedCache) {
        const currentlyOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
        isDeviceOnline = !currentlyOffline;
        setOfflineMode(currentlyOffline, true);
        renderCatalogImmediately();
        logDiagnostic(`Fallback catalog ready: ${appsCatalog.length} cached items.`);
        return appsCatalog;
      }

      publishCatalog([], 'none');
      isDeviceOnline = true;
      setOfflineMode(false, false);
      showFeedEmptyState(true);
      return [];
    }
  })();

  try {
    return await catalogState.bootPromise;
  } finally {
    finishCatalogLoad();
  }
}

function initNetworkListeners() {
  window.addEventListener('online', async () => {
    // The online event is the transition back to a connected state. Hide the
    // banner immediately, then fetch the newest catalog.
    isDeviceOnline = true;
    setOfflineMode(false, false);
    logDiagnostic('Network connection restored. Refreshing catalog.');
    await loadApps();
  });

  window.addEventListener('offline', () => {
    // Only this browser-level disconnected event is allowed to activate the
    // offline banner. Do not infer offline state from a failed HTTP request.
    isDeviceOnline = false;
    if (appsCatalog.length > 0) {
      setOfflineMode(true, true);
      setFeedStatus('');
      logDiagnostic('Network connection lost. Showing cached catalog.');
    } else {
      setOfflineMode(true, false);
    }
  });
}

async function checkConnectionNow() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setOfflineMode(true, appsCatalog.length > 0);
    return loadApps();
  }

  // A connection failure is not automatically an offline state. The fetch
  // result is handled by loadApps(), which distinguishes feed errors from a
  // navigator offline signal.
  return loadApps();
}

function handleOfflineRetryClick() {
  return loadApps();
}

function updateNetworkStatusUI() {
  const online = typeof navigator === 'undefined' ? true : navigator.onLine;
  isDeviceOnline = online;

  if (online === false) {
    setOfflineMode(true, appsCatalog.length > 0);
  } else {
    setOfflineMode(false, false);
  }
}

function initImageSafety() {
  window.addEventListener('error', event => {
    const target = event.target;
    if (target && target.tagName === 'IMG') {
      target.removeAttribute('src');
      target.classList.add('image-load-failed');
      target.setAttribute('aria-hidden', 'true');
    }
  }, true);
}

async function bootRiseHub() {
  // DOM is guaranteed to exist before this function runs.
  initNetworkListeners();
  initImageSafety();

  const retry = document.getElementById('feedRetryButton');
  if (retry) retry.addEventListener('click', () => loadApps({ forceNetwork: true }));

  updateDateDisplay();
  loadDownloadState();
  startDownloadExpiryMonitor();
  setFeedLoading(true);

  // Render the shell once before network work, then populate every catalog view
  // from the same global state as soon as data becomes available.
  renderAllViews();
  await loadApps();

  // Final deterministic render. This prevents first-load blank panes even when
  // the feed/cache resolves between DOM mutations or WebView layout passes.
  renderAllViews();
  switchTab(currentTab, { instant: true, render: false });

  initOnboarding();
  setupCarouselScrollListener();
  if (window.lucide) window.lucide.createIcons();
}

function initStore() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootRiseHub, { once: true });
  } else {
    bootRiseHub();
  }
}

function saveCatalogToStorage() {
  // Kept as a compatibility no-op. The GitHub feed cache is the only app-data storage.
}


function updateDateDisplay() {
  const options = { weekday: 'long', month: 'long', day: 'numeric' };
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', options).toUpperCase();
  const dateEl = document.getElementById('currentDateStr');
  if (dateEl) dateEl.textContent = dateStr;
}

// ================= NAVIGATION WITH SMOOTH ANIMATION =================
function switchTab(tabName, options = {}) {
  const instant = options.instant === true;
  const shouldRender = options.render !== false;
  const allowedTabs = new Set(['today', 'games', 'apps', 'search', 'downloads', 'wishlist']);
  if (!allowedTabs.has(tabName)) tabName = 'today';

  currentTab = tabName;

  if (shouldRender && appsCatalog.length > 0) {
    // Every tab is rendered from the same global catalog before visibility changes.
    renderAllViews();
  }

  document.querySelectorAll('.tab-pane').forEach(el => {
    el.classList.add('hidden');
    el.classList.remove('tab-fade-in');
  });

  const activePane = document.getElementById(`tab-${tabName}`);
  if (activePane) {
    activePane.classList.remove('hidden');
    if (!instant) {
      void activePane.offsetWidth;
      activePane.classList.add('tab-fade-in');
    }
  }

  document.querySelectorAll('.nav-tab-btn').forEach(btn => {
    btn.classList.remove('text-apple-blue');
    btn.classList.add('text-gray-400', 'dark:text-gray-500');
    const span = btn.querySelector('span');
    if (span) {
      span.classList.remove('font-semibold');
      span.classList.add('font-medium');
    }
  });

  const activeBtn = document.getElementById(`tabBtn-${tabName}`);
  if (activeBtn) {
    activeBtn.classList.add('text-apple-blue');
    activeBtn.classList.remove('text-gray-400', 'dark:text-gray-500');
    const span = activeBtn.querySelector('span');
    if (span) {
      span.classList.remove('font-medium');
      span.classList.add('font-semibold');
    }
  }

  if (!instant) window.scrollTo({ top: 0, behavior: 'smooth' });

  if (tabName === 'downloads') renderDownloadsView();
  if (tabName === 'wishlist') renderWishlistViews();

  if (tabName === 'search') {
    const input = document.getElementById('searchInput');
    if (input) setTimeout(() => input.focus(), 150);
  }

  if (window.lucide) window.lucide.createIcons();
}

// ================= RENDER VIEWS =================
function renderAllViews() {
  renderTodayView();
  renderGamesView();
  renderAppsView();
  renderDownloadsView();
  renderWishlistViews();
  
  // Re-run search if active query exists
  const currentQuery = document.getElementById('searchInput')?.value || '';
  if (currentQuery) {
    handleSearch(currentQuery);
  }
}

// Render Today View (Featured Carousel, Hero Cards & Top Picks)
function getTodayFeaturedApps(limit = 5) {
  const featured = appsCatalog
    .filter(app => app.isTodayHero)
    .sort((a, b) => (a.todayPriority - b.todayPriority) || a.name.localeCompare(b.name));

  const remaining = appsCatalog
    .filter(app => !app.isTodayHero)
    .sort((a, b) => a.name.localeCompare(b.name));

  return [...featured, ...remaining].slice(0, limit);
}

// Render Today View (Featured Carousel, Hero Cards & Top Picks)
function renderTodayView() {
  renderTodayCarousel();

  const heroContainer = document.getElementById('todayHeroContainer');
  const topPicksContainer = document.getElementById('todayTopPicksList');
  if (!heroContainer || !topPicksContainer) return;

  heroContainer.innerHTML = '';
  topPicksContainer.innerHTML = '';

  if (!appsCatalog.length) {
    heroContainer.innerHTML = `<div class="today-inline-empty">Apps are currently unavailable.</div>`;
    return;
  }

  const heroApps = appsCatalog
    .filter(app => app.isTodayHero)
    .sort((a, b) => (a.todayPriority - b.todayPriority) || a.name.localeCompare(b.name));
  const displayHeroes = (heroApps.length ? heroApps : getTodayFeaturedApps(2)).slice(0, 2);

  displayHeroes.forEach((app, idx) => {
    const heroTag = escapeHtml(app.todayHeroTag || (idx === 0 ? 'GAME OF THE DAY' : 'FEATURED APP'));
    const heroSubtitle = escapeHtml(app.todayHeroSubtitle || app.tagline || app.description);
    const bannerImg = app.screenshots[0] || app.icon;

    const card = document.createElement('div');
    card.className = 'group relative rounded-ios-card overflow-hidden shadow-lg border border-black/10 dark:border-white/10 bg-black cursor-pointer pressable';
    card.onclick = () => openAppDetailModal(app.id);

    card.innerHTML = `
      <div class="relative h-96 w-full overflow-hidden">
        <img src="${escapeHtml(bannerImg)}" alt="${escapeHtml(app.name)}" class="w-full h-full object-contain transition-transform duration-700 group-hover:scale-105 opacity-80" loading="lazy">
        <div class="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent"></div>
        <div class="absolute top-5 left-5 right-5 flex justify-between items-start">
          <div>
            <span class="text-[11px] font-extrabold uppercase tracking-widest text-white/80">${heroTag}</span>
            <h3 class="text-2xl font-black text-white leading-tight drop-shadow-md">${escapeHtml(app.name)}</h3>
            <p class="text-xs text-white/90 font-medium max-w-xs line-clamp-2 mt-0.5">${heroSubtitle}</p>
          </div>
        </div>
        <div class="absolute bottom-4 left-4 right-4 p-3 rounded-2xl glass-card-dark flex items-center justify-between border border-white/15">
          <div class="flex items-center space-x-3 min-w-0">
            <img src="${escapeHtml(app.icon)}" alt="${escapeHtml(app.name)}" class="w-11 h-11 ios-squircle object-cover flex-shrink-0 bg-gray-800">
            <div class="min-w-0 flex-1">
              <h4 class="text-sm font-bold text-white truncate leading-tight">${escapeHtml(app.name)}</h4>
              <p class="text-[11px] text-gray-300 truncate">${escapeHtml(app.developer)}${app.size !== '' ? ` · ${escapeHtml(String(app.size))} MB` : ''}</p>
            </div>
          </div>
          <div class="flex-shrink-0 pl-2" onclick="event.stopPropagation()">${renderGetButtonHtml(app.id)}</div>
        </div>
      </div>`;
    heroContainer.appendChild(card);
  });

  const topPicks = getTodayFeaturedApps(4);
  topPicks.forEach(app => {
    const item = document.createElement('div');
    item.className = 'py-3 flex items-center justify-between gap-3 cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition rounded-xl px-1';
    item.onclick = () => openAppDetailModal(app.id);
    item.innerHTML = `
      <div class="flex items-center space-x-3 min-w-0">
        <img src="${escapeHtml(app.icon)}" alt="${escapeHtml(app.name)}" class="w-[52px] h-[52px] ios-squircle object-cover flex-shrink-0 bg-gray-200 dark:bg-gray-800 shadow-sm">
        <div class="min-w-0">
          <h4 class="text-sm font-bold text-black dark:text-white truncate">${escapeHtml(app.name)}</h4>
          <p class="text-[11px] text-gray-500 dark:text-gray-400 truncate">${escapeHtml(app.tagline || app.description)}</p>
          <div class="flex items-center gap-1.5 mt-0.5 text-[10px] text-gray-400">
            <span class="text-apple-yellow flex items-center font-medium">Rating ${escapeHtml(String(app.rating || 'Not rated'))}</span>
            <span>·</span>
            <span>${escapeHtml(app.category || 'App')}</span>
          </div>
        </div>
      </div>
      <div class="flex-shrink-0" onclick="event.stopPropagation()">${renderGetButtonHtml(app.id)}</div>`;
    topPicksContainer.appendChild(item);
  });

  renderTodayCharts();
  if (window.lucide) window.lucide.createIcons();
}

function renderTodayCharts() {
  const container = document.getElementById('todayChartsList');
  if (!container) return;
  const ranked = [...appsCatalog].sort((a,b) => {
    const da = Number(String(a.downloads).replace(/[^0-9.]/g,'')) || 0;
    const db = Number(String(b.downloads).replace(/[^0-9.]/g,'')) || 0;
    return db - da || Number(b.rating) - Number(a.rating);
  }).slice(0, 5);
  container.innerHTML = ranked.map((app, i) => `
    <div class="flex items-center gap-3 py-3 border-b border-black/[0.05] dark:border-white/[0.06] last:border-0 cursor-pointer" onclick="openAppDetailModal('${escapeHtml(app.id)}')">
      <span class="chart-rank">${i + 1}</span>
      <img src="${escapeHtml(app.icon)}" alt="${escapeHtml(app.name)}" class="w-11 h-11 ios-squircle object-cover bg-gray-800 flex-shrink-0">
      <div class="min-w-0 flex-1"><p class="text-sm font-bold text-black dark:text-white truncate">${escapeHtml(app.name)}</p><p class="text-[10px] text-gray-500 dark:text-gray-400 truncate">${escapeHtml(app.category || app.developer)}</p></div>
      <div onclick="event.stopPropagation()">${renderGetButtonHtml(app.id)}</div>
    </div>`).join('');
}

// ================= TODAY CAROUSEL COMPONENT =================
function renderTodayCarousel() {
  const scrollContainer = document.getElementById('todayCarouselScroll');
  const dotsContainer = document.getElementById('todayCarouselDots');
  if (!scrollContainer || !dotsContainer) return;

  scrollContainer.innerHTML = '';
  dotsContainer.innerHTML = '';

  // Prefer Today/featured entries, then fill the carousel from the remaining feed.
  const carouselApps = getTodayFeaturedApps(5);
  if (carouselApps.length === 0) return;

  carouselApps.forEach((app, index) => {
    const banner = app.screenshots[0] || app.icon;

    // Carousel Card Item
    const card = document.createElement('div');
    card.className = "flex-shrink-0 w-[280px] snap-center-item rounded-2xl overflow-hidden bg-white dark:bg-apple-cardDark shadow-md border border-black/[0.06] dark:border-white/[0.08] cursor-pointer pressable flex flex-col transition-all duration-300";
    card.onclick = () => openAppDetailModal(app.id);

    card.innerHTML = `
      <div class="relative h-36 w-full overflow-hidden bg-gray-900">
        <img src="${escapeHtml(banner)}" alt="${escapeHtml(app.name)}" class="w-full h-full object-contain transition-transform duration-500 hover:scale-105" loading="lazy">
        <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent"></div>
        <div class="absolute top-2.5 left-3">
          <span class="px-2 py-0.5 rounded-full text-[9px] font-extrabold uppercase tracking-wider bg-black/60 backdrop-blur-md text-white border border-white/20">
            ${app.category}
          </span>
        </div>
      </div>

      <div class="p-3.5 flex items-center justify-between gap-3">
        <div class="flex items-center space-x-2.5 min-w-0">
          <img src="${escapeHtml(app.icon)}" alt="${escapeHtml(app.name)}" class="w-11 h-11 ios-squircle object-cover flex-shrink-0 bg-gray-200 dark:bg-gray-800 shadow-sm">
          <div class="min-w-0">
            <h4 class="text-xs font-bold text-black dark:text-white truncate leading-tight">${app.name}</h4>
            <p class="text-[10px] text-gray-500 dark:text-gray-400 truncate">${app.developer}</p>
            <p class="text-[9px] text-apple-yellow font-semibold mt-0.5">Rating ${app.rating || 'Not rated'}</p>
          </div>
        </div>
        <div class="flex-shrink-0" onclick="event.stopPropagation()">
          ${renderGetButtonHtml(app.id)}
        </div>
      </div>
    `;
    scrollContainer.appendChild(card);

    // Indicator Dot
    const dot = document.createElement('button');
    dot.className = `w-1.5 h-1.5 rounded-full transition-all duration-300 ${index === 0 ? 'w-4 bg-apple-blue' : 'bg-gray-300 dark:bg-gray-600'}`;
    dot.setAttribute('aria-label', `Go to slide ${index + 1}`);
    dot.onclick = () => scrollTodayCarouselToIndex(index);
    dotsContainer.appendChild(dot);
  });
}

function setupCarouselScrollListener() {
  const scrollContainer = document.getElementById('todayCarouselScroll');
  if (!scrollContainer) return;

  scrollContainer.addEventListener('scroll', () => {
    const itemWidth = 280 + 14; // card width + gap
    const index = Math.round(scrollContainer.scrollLeft / itemWidth);
    if (index !== activeCarouselIndex) {
      activeCarouselIndex = index;
      updateCarouselDots(index);
    }
  }, { passive: true });
}

function updateCarouselDots(activeIndex) {
  const dotsContainer = document.getElementById('todayCarouselDots');
  if (!dotsContainer) return;
  const dots = dotsContainer.querySelectorAll('button');
  dots.forEach((dot, idx) => {
    if (idx === activeIndex) {
      dot.className = 'w-4 h-1.5 rounded-full bg-apple-blue transition-all duration-300';
    } else {
      dot.className = 'w-1.5 h-1.5 rounded-full bg-gray-300 dark:bg-gray-600 transition-all duration-300';
    }
  });
}

function scrollTodayCarousel(direction) {
  const scrollContainer = document.getElementById('todayCarouselScroll');
  if (!scrollContainer) return;
  const cardWidth = 280 + 14;
  const scrollOffset = direction === 'left' ? -cardWidth : cardWidth;
  scrollContainer.scrollBy({ left: scrollOffset, behavior: 'smooth' });
}

function scrollTodayCarouselToIndex(index) {
  const scrollContainer = document.getElementById('todayCarouselScroll');
  if (!scrollContainer) return;
  const cardWidth = 280 + 14;
  scrollContainer.scrollTo({ left: index * cardWidth, behavior: 'smooth' });
}

// ================= RENDER GAMES VIEW =================
function renderGamesView() {
  const grid = document.getElementById('gamesListGrid');
  const spotlight = document.getElementById('gamesSpotlightContainer');
  const countBadge = document.getElementById('gamesCountBadge');
  if (!grid) return;

  const games = appsCatalog.filter(a => {
    if (!isGameApp(a)) return false;
    if (currentFilteredCategoryGames === 'All') return true;
    const q = normalizeToken(currentFilteredCategoryGames);
    return normalizeToken(a.category).includes(q) || normalizeToken(a.tagline).includes(q) ||
      normalizeToken(a.description).includes(q) || (a.tags || []).some(tag => normalizeToken(tag).includes(q));
  });

  if (countBadge) countBadge.textContent = `${games.length} Games`;

  if (spotlight) {
    spotlight.innerHTML = '';
    const topGame = games[0] || appsCatalog.find(isGameApp);
    if (topGame) {
      const banner = document.createElement('div');
      banner.className = "relative rounded-2xl overflow-hidden shadow-md bg-gradient-to-r from-apple-indigo to-apple-purple p-4 text-white cursor-pointer pressable";
      banner.onclick = () => openAppDetailModal(topGame.id);
      banner.innerHTML = `
        <div class="flex justify-between items-center">
          <div>
            <span class="text-[10px] font-bold uppercase tracking-wider text-white/80">FEATURED TITLE</span>
            <h3 class="text-xl font-black mt-0.5">${topGame.name}</h3>
            <p class="text-xs text-white/90 line-clamp-1 max-w-[240px] mt-0.5">${topGame.tagline}</p>
          </div>
          <img src="${topGame.icon}" class="w-14 h-14 ios-squircle object-cover border border-white/30 shadow-lg">
        </div>
      `;
      spotlight.appendChild(banner);
    }
  }

  grid.innerHTML = '';
  if (games.length === 0) {
    grid.innerHTML = `<div class="p-8 text-center text-gray-400 text-xs">No games found in this category.</div>`;
    return;
  }

  games.forEach(app => {
    const item = document.createElement('div');
    item.className = "p-3.5 rounded-2xl bg-white dark:bg-apple-cardDark border border-black/[0.04] dark:border-white/[0.06] shadow-sm flex items-center justify-between gap-3 cursor-pointer pressable";
    item.onclick = () => openAppDetailModal(app.id);

    item.innerHTML = `
      <div class="flex items-center space-x-3 min-w-0">
        <img src="${escapeHtml(app.icon)}" alt="${escapeHtml(app.name)}" class="w-14 h-14 ios-squircle object-cover flex-shrink-0 bg-gray-200 dark:bg-gray-800 shadow-sm">
        <div class="min-w-0">
          <h4 class="text-sm font-bold text-black dark:text-white truncate">${app.name}</h4>
          <p class="text-xs text-gray-500 dark:text-gray-400 truncate">${app.tagline || app.description}</p>
          <div class="flex items-center gap-1.5 mt-1 text-[10px] text-gray-400">
            <span class="text-apple-yellow font-medium">Rating ${app.rating || 'Not rated'}</span>
            <span>•</span>
            <span>${app.size ? `${escapeHtml(String(app.size))} MB` : 'Size unavailable'}</span>
            <span>•</span>
            <span>${app.ageRating || 'Not specified'}</span>
          </div>
        </div>
      </div>
      <div class="flex-shrink-0" onclick="event.stopPropagation()">
        ${renderGetButtonHtml(app.id)}
      </div>
    `;
    grid.appendChild(item);
  });
}

function filterGamesCategory(cat, btn) {
  currentFilteredCategoryGames = cat;
  document.querySelectorAll('.category-pill-game').forEach(p => {
    p.classList.remove('bg-apple-blue', 'text-white', 'shadow-sm');
    p.classList.add('bg-white', 'dark:bg-apple-cardDark', 'text-gray-700', 'dark:text-gray-300', 'border', 'border-black/[0.06]', 'dark:border-white/[0.08]');
  });
  if (btn) {
    btn.classList.add('bg-apple-blue', 'text-white', 'shadow-sm');
    btn.classList.remove('bg-white', 'dark:bg-apple-cardDark', 'text-gray-700', 'dark:text-gray-300', 'border');
    btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
  renderGamesView();
}

// ================= RENDER APPS VIEW =================
function renderAppsView() {
  const grid = document.getElementById('appsListGrid');
  const spotlight = document.getElementById('appsSpotlightContainer');
  const countBadge = document.getElementById('appsCountBadge');
  if (!grid) return;

  const nonGames = appsCatalog.filter(a => {
    if (!isStoreApp(a)) return false;
    if (currentFilteredCategoryApps === 'All') return true;
    const q = normalizeToken(currentFilteredCategoryApps);
    return normalizeToken(a.category).includes(q) || normalizeToken(a.tagline).includes(q) ||
      normalizeToken(a.description).includes(q) || (a.tags || []).some(tag => normalizeToken(tag).includes(q));
  });

  if (countBadge) countBadge.textContent = `${nonGames.length} Apps`;

  if (spotlight) {
    spotlight.innerHTML = '';
    const topApp = nonGames[0] || appsCatalog.find(isStoreApp);
    if (topApp) {
      const banner = document.createElement('div');
      banner.className = "relative rounded-2xl overflow-hidden shadow-md bg-gradient-to-r from-apple-blue to-apple-teal p-4 text-white cursor-pointer pressable";
      banner.onclick = () => openAppDetailModal(topApp.id);
      banner.innerHTML = `
        <div class="flex justify-between items-center">
          <div>
            <span class="text-[10px] font-bold uppercase tracking-wider text-white/80">FEATURED APP</span>
            <h3 class="text-xl font-black mt-0.5">${topApp.name}</h3>
            <p class="text-xs text-white/90 line-clamp-1 max-w-[240px] mt-0.5">${topApp.tagline}</p>
          </div>
          <img src="${topApp.icon}" class="w-14 h-14 ios-squircle object-cover border border-white/30 shadow-lg">
        </div>
      `;
      spotlight.appendChild(banner);
    }
  }

  grid.innerHTML = '';
  if (nonGames.length === 0) {
    grid.innerHTML = `<div class="p-8 text-center text-gray-400 text-xs">No apps found in this category.</div>`;
    return;
  }

  nonGames.forEach(app => {
    const item = document.createElement('div');
    item.className = "p-3.5 rounded-2xl bg-white dark:bg-apple-cardDark border border-black/[0.04] dark:border-white/[0.06] shadow-sm flex items-center justify-between gap-3 cursor-pointer pressable";
    item.onclick = () => openAppDetailModal(app.id);

    item.innerHTML = `
      <div class="flex items-center space-x-3 min-w-0">
        <img src="${escapeHtml(app.icon)}" alt="${escapeHtml(app.name)}" class="w-14 h-14 ios-squircle object-cover flex-shrink-0 bg-gray-200 dark:bg-gray-800 shadow-sm">
        <div class="min-w-0">
          <h4 class="text-sm font-bold text-black dark:text-white truncate">${app.name}</h4>
          <p class="text-xs text-gray-500 dark:text-gray-400 truncate">${app.tagline || app.description}</p>
          <div class="flex items-center gap-1.5 mt-1 text-[10px] text-gray-400">
            <span class="text-apple-blue font-semibold">${app.category}</span>
            <span>•</span>
            <span class="text-apple-yellow font-medium">Rating ${app.rating || 'Not rated'}</span>
            <span>•</span>
            <span>${app.size ? `${escapeHtml(String(app.size))} MB` : 'Size unavailable'}</span>
          </div>
        </div>
      </div>
      <div class="flex-shrink-0" onclick="event.stopPropagation()">
        ${renderGetButtonHtml(app.id)}
      </div>
    `;
    grid.appendChild(item);
  });
}

function filterAppsCategory(cat, btn) {
  currentFilteredCategoryApps = cat;
  document.querySelectorAll('.category-pill-app').forEach(p => {
    p.classList.remove('bg-apple-blue', 'text-white', 'shadow-sm');
    p.classList.add('bg-white', 'dark:bg-apple-cardDark', 'text-gray-700', 'dark:text-gray-300', 'border', 'border-black/[0.06]', 'dark:border-white/[0.08]');
  });
  if (btn) {
    btn.classList.add('bg-apple-blue', 'text-white', 'shadow-sm');
    btn.classList.remove('bg-white', 'dark:bg-apple-cardDark', 'text-gray-700', 'dark:text-gray-300', 'border');
    btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
  renderAppsView();
}

// ================= REAL-TIME SEARCH FUNCTIONALITY =================
function handleSearchSync(value, source) {
  const headerInput = document.getElementById('headerSearchInput');
  const tabInput = document.getElementById('searchInput');

  if (source === 'header' && tabInput) {
    tabInput.value = value;
  } else if (source === 'tab' && headerInput) {
    headerInput.value = value;
  }

  // Update clear button visibility
  const headerClearBtn = document.getElementById('headerSearchClearBtn');
  const tabClearBtn = document.getElementById('searchClearBtn');

  if (value.trim()) {
    if (headerClearBtn) headerClearBtn.classList.remove('hidden');
    if (tabClearBtn) tabClearBtn.classList.remove('hidden');

    // If typing from header and not in search tab, switch to search smoothly
    if (source === 'header' && currentTab !== 'search') {
      switchTab('search');
    }
  } else {
    if (headerClearBtn) headerClearBtn.classList.add('hidden');
    if (tabClearBtn) tabClearBtn.classList.add('hidden');
  }

  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => handleSearch(value), 90);
}

function handleSearch(query) {
  const resultsContainer = document.getElementById('searchResultsContainer');
  const suggestions = document.getElementById('searchSuggestions');
  if (!resultsContainer || !suggestions) return;

  const q = query.trim().toLowerCase();

  if (!q) {
    suggestions.classList.remove('hidden');
    resultsContainer.innerHTML = '';
    return;
  }

  suggestions.classList.add('hidden');

  // Case-insensitive filtering on app name, developer name, category, or tagline
  const matched = appsCatalog.filter(a => 
    (a.name && a.name.toLowerCase().includes(q)) ||
    (a.developer && a.developer.toLowerCase().includes(q)) ||
    (a.category && a.category.toLowerCase().includes(q)) ||
    (a.tagline && a.tagline.toLowerCase().includes(q)) ||
    (a.description && a.description.toLowerCase().includes(q)) ||
    (a.tags && a.tags.some(tag => String(tag).toLowerCase().includes(q))) ||
    (a.type && String(a.type).toLowerCase().includes(q))
  );

  resultsContainer.innerHTML = '';
  if (matched.length === 0) {
    resultsContainer.innerHTML = `
      <div class="py-12 text-center space-y-2">
        <div class="w-12 h-12 rounded-full bg-gray-200 dark:bg-apple-cardDark flex items-center justify-center mx-auto text-gray-400">
          <i data-lucide="package-search" class="w-6 h-6"></i>
        </div>
        <h4 class="text-sm font-bold text-gray-700 dark:text-gray-300">No Results for "${escapeHtml(query)}"</h4>
        <p class="text-xs text-gray-400">Check spelling or try searching by category or developer.</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  // Header showing match count
  const countBar = document.createElement('div');
  countBar.className = "flex items-center justify-between px-1 pb-1";
  countBar.innerHTML = `
    <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Results</span>
    <span class="text-xs font-bold text-apple-blue">${matched.length} found</span>
  `;
  resultsContainer.appendChild(countBar);

  matched.forEach(app => {
    const item = document.createElement('div');
    item.className = "p-3 rounded-2xl bg-white dark:bg-apple-cardDark border border-black/[0.04] dark:border-white/[0.06] shadow-sm flex items-center justify-between gap-3 cursor-pointer pressable";
    item.onclick = () => openAppDetailModal(app.id);

    item.innerHTML = `
      <div class="flex items-center space-x-3 min-w-0">
        <img src="${escapeHtml(app.icon)}" alt="${escapeHtml(app.name)}" class="w-12 h-12 ios-squircle object-cover flex-shrink-0 bg-gray-200 dark:bg-gray-800">
        <div class="min-w-0">
          <h4 class="text-sm font-bold text-black dark:text-white truncate">${app.name}</h4>
          <p class="text-[11px] text-gray-500 dark:text-gray-400 truncate">${app.tagline || app.description}</p>
          <div class="flex items-center gap-1.5 mt-0.5 text-[10px] text-gray-400">
            <span class="text-apple-yellow font-medium">Rating ${app.rating || 'Not rated'}</span>
            <span>•</span>
            <span class="text-apple-blue font-semibold">${app.category}</span>
            <span>•</span>
            <span>${app.size ? `${escapeHtml(String(app.size))} MB` : 'Size unavailable'}</span>
          </div>
        </div>
      </div>
      <div class="flex-shrink-0" onclick="event.stopPropagation()">
        ${renderGetButtonHtml(app.id)}
      </div>
    `;
    resultsContainer.appendChild(item);
  });

  if (window.lucide) window.lucide.createIcons();
}

function applySearchQuery(query) {
  handleSearchSync(query, 'tab');
  if (currentTab !== 'search') {
    switchTab('search');
  }
}

function clearAllSearch() {
  const headerInput = document.getElementById('headerSearchInput');
  const tabInput = document.getElementById('searchInput');
  const headerClearBtn = document.getElementById('headerSearchClearBtn');
  const tabClearBtn = document.getElementById('searchClearBtn');

  if (headerInput) headerInput.value = '';
  if (tabInput) tabInput.value = '';
  if (headerClearBtn) headerClearBtn.classList.add('hidden');
  if (tabClearBtn) tabClearBtn.classList.add('hidden');

  handleSearch('');
}

function clearSearch() {
  clearAllSearch();
}

function renderRatingStars(value) {
  const rating = Math.max(0, Math.min(5, Number(value) || 0));
  const full = Math.floor(rating);
  return Array.from({length:5}, (_,i) => `<i data-lucide="star" class="w-3 h-3 ${i < full ? 'fill-current text-apple-yellow' : 'text-gray-500'}"></i>`).join('');
}

// ================= DETAIL MEDIA CAROUSEL =================
function normalizeMediaUrl(value) {
  return String(value || '').trim().replace(/^\[https?:\/\/[^\]]+\]\((https?:\/\/[^)]+)\)$/i, '$1');
}

function getYouTubeEmbedUrl(url) {
  const raw = normalizeMediaUrl(url);
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    const parts = parsed.pathname.split('/').filter(Boolean);
    let id = '';
    if (host === 'youtu.be') id = parts[0] || '';
    else if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) {
      if (parsed.pathname === '/watch') id = parsed.searchParams.get('v') || '';
      else if (['embed', 'shorts', 'live', 'v'].includes(parts[0])) id = parts[1] || '';
    }
    if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) return '';
    const embed = new URL('https://www.youtube.com/embed/' + id);
    embed.searchParams.set('enablejsapi', '1');
    embed.searchParams.set('origin', 'https://appassets.androidplatform.net');
    embed.searchParams.set('playsinline', '1');
    embed.searchParams.set('rel', '0');
    embed.searchParams.set('autoplay', '0');
    embed.searchParams.set('controls', '0');
    embed.searchParams.set('modestbranding', '1');
    embed.searchParams.set('iv_load_policy', '3');
    const startRaw = parsed.searchParams.get('start') || parsed.searchParams.get('t') || '0';
    const startAt = parseInt(startRaw, 10);
    if (Number.isFinite(startAt) && startAt > 0) embed.searchParams.set('start', String(startAt));
    return embed.toString();
  } catch (_) { return ''; }
}

function isDirectVideoUrl(url) {
  return /\.(mp4|webm|ogg)(?:$|[?#])/i.test(normalizeMediaUrl(url));
}

function buildDetailMedia(app) {
  const media = [];
  (app.videoUrls || []).forEach(url => {
    const clean = normalizeMediaUrl(url);
    if (!clean) return;
    media.push({ type: 'video', url: clean, embed: getYouTubeEmbedUrl(clean) });
  });
  (app.screenshots || []).forEach(url => {
    const clean = normalizeMediaUrl(url);
    if (!clean) return;
    media.push({ type: 'image', url: clean });
  });
  if (!media.length && app.icon) media.push({ type: 'image', url: normalizeMediaUrl(app.icon) });
  return media;
}

function renderDetailMedia(app) {
  const media = buildDetailMedia(app);
  detailMediaIndex = Math.min(detailMediaIndex, Math.max(0, media.length - 1));
  const active = media[detailMediaIndex] || media[0];
  const dots = media.map((item, index) => `<button type="button" onclick="setDetailMedia(${index})" class="detail-media-dot ${index === detailMediaIndex ? 'active' : ''}" aria-label="Go to preview ${index + 1}"></button>`).join('');
  const stage = active ? (active.type === 'video'
    ? (active.embed
      ? `<div class="rise-video-player rise-youtube-player">
          <iframe id="riseYouTubeFrame" class="detail-media-content rise-video-frame" src="${escapeHtml(active.embed)}" title="${escapeHtml(app.name)} video" loading="lazy" allow="autoplay; encrypted-media; picture-in-picture; web-share" allowfullscreen></iframe>
          <div class="rise-player-brand"><span class="rise-player-mark">R</span><span>Rise Player</span></div>
          <button type="button" class="rise-player-center" onclick="riseToggleYouTubePlayback()" aria-label="Play video"><span class="rise-player-play-icon">▶</span></button>
          <div class="rise-player-bottom"><span class="rise-player-now">Playing in Rise Player</span><button type="button" onclick="riseToggleYouTubePlayback()" class="rise-player-control" aria-label="Play or pause video">▶</button><button type="button" onclick="riseToggleYouTubeMute()" class="rise-player-control" aria-label="Mute or unmute video">Sound</button><button type="button" onclick="riseFullscreenPlayer()" class="rise-player-control" aria-label="Fullscreen video">⛶</button></div>
        </div>`
      : (isDirectVideoUrl(active.url)
        ? `<video class="detail-media-content" controls playsinline webkit-playsinline preload="metadata"><source src="${escapeHtml(active.url)}">Your device cannot play this video format.</video>`
        : `<div class="detail-media-empty" role="status">This video link is not a supported YouTube URL or direct video file.</div>`))
    : `<img class="detail-media-content" src="${escapeHtml(active.url)}" alt="${escapeHtml(app.name)} preview ${detailMediaIndex + 1}" loading="lazy">`) : `<div class="detail-media-empty" role="status">No video or preview is available for this app.</div>`;
  return `<div class="detail-media-carousel" id="detailMediaCarousel" data-count="${media.length}">
    <div class="detail-media-stage">${stage}<button type="button" class="detail-media-arrow left" onclick="stepDetailMedia(-1)" aria-label="Previous preview">‹</button><button type="button" class="detail-media-arrow right" onclick="stepDetailMedia(1)" aria-label="Next preview">›</button></div>
    <div class="detail-media-meta"><span>${media.length} preview${media.length === 1 ? '' : 's'}</span><span>${active?.type === 'video' ? 'Video trailer' : 'Screenshot'}</span></div>
    <div class="detail-media-dots" aria-label="Preview navigation">${dots}</div>
  </div>`;
}

function setDetailMedia(index) {
  const appId = document.getElementById('detailModalBody')?.dataset.appId;
  const app = appsCatalog.find(a => a.id === appId);
  if (!app) return;
  const media = buildDetailMedia(app);
  if (!media.length) return;
  detailMediaIndex = (index + media.length) % media.length;
  const host = document.getElementById('detailMediaHost');
  if (host) host.innerHTML = renderDetailMedia(app);
  if (window.lucide) window.lucide.createIcons();
}

function stepDetailMedia(direction) {
  setDetailMedia(detailMediaIndex + Number(direction || 0));
}

function riseSendYouTubeCommand(func, args = []) {
  const frame = document.getElementById('riseYouTubeFrame');
  if (!frame?.contentWindow) return;
  frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args }), 'https://www.youtube.com');
}
function riseToggleYouTubePlayback() {
  const frame = document.getElementById('riseYouTubeFrame');
  if (!frame) return;
  riseSendYouTubeCommand('playVideo');
  const center = document.querySelector('.rise-player-center');
  if (center) center.classList.add('rise-player-hidden');
  const now = document.querySelector('.rise-player-now');
  if (now) now.textContent = 'Playing in Rise Player';
}
function riseToggleYouTubeMute() {
  const frame = document.getElementById('riseYouTubeFrame');
  if (!frame) return;
  const muted = frame.dataset.riseMuted === 'true';
  riseSendYouTubeCommand(muted ? 'unMute' : 'mute');
  frame.dataset.riseMuted = String(!muted);
}
function riseFullscreenPlayer() {
  const player = document.querySelector('.rise-video-player');
  if (!player) return;
  if (player.requestFullscreen) player.requestFullscreen();
  else if (player.webkitRequestFullscreen) player.webkitRequestFullscreen();
}
function stopDetailMediaPlayback() {
  const body = document.getElementById('detailModalBody');
  if (!body) return;
  body.querySelectorAll('video').forEach(video => { try { video.pause(); video.currentTime = 0; } catch (_) {} });
  body.querySelectorAll('iframe').forEach(frame => { frame.src = frame.src; });
}

// ================= APP DETAIL MODAL (APPLE STORE SHEET) =================
function openAppDetailModal(appId) {
  const app = appsCatalog.find(a => a.id === appId);
  if (!app) return;

  const modal = document.getElementById('appDetailModal');
  const sheet = document.getElementById('detailSheet');
  const body = document.getElementById('detailModalBody');
  if (!modal || !sheet || !body) return;

  const isInstalled = installedAppIds.has(app.id);
  const screenshots = (app.screenshots && app.screenshots.length > 0) ? app.screenshots : [app.icon];

  body.dataset.appId = app.id;
  detailMediaIndex = 0;
  body.innerHTML = `
    <div class="flex items-start justify-between gap-4">
      <img src="${escapeHtml(app.icon)}" alt="${escapeHtml(app.name)}" class="w-20 h-20 ios-squircle-large object-cover flex-shrink-0 bg-gray-200 dark:bg-gray-800">
      <div class="flex-1 min-w-0">
        <h2 class="text-xl font-bold tracking-tight text-black dark:text-white leading-snug">${app.name}</h2>
        <p class="text-xs text-gray-500 dark:text-gray-400 font-medium">${app.developer}</p>
        <p class="text-[11px] text-apple-blue font-semibold mt-0.5">${app.category}</p>
        
        <div class="flex items-center gap-2 mt-2">
          <button id="modal-get-btn-${app.id}" onclick="handleDownloadClick('${app.id}', event)" class="pressable px-6 py-1.5 rounded-full font-bold text-xs uppercase tracking-wide bg-apple-blue text-white shadow-sm hover:bg-apple-blue/90 transition flex items-center justify-center min-w-[80px]">
            ${isInstalled ? 'OPEN' : 'GET'}
          </button>
          <button onclick="shareApp('${app.id}')" class="pressable w-8 h-8 rounded-full bg-gray-100 dark:bg-apple-cardDarkSecondary flex items-center justify-center text-gray-600 dark:text-gray-300" title="Share App" aria-label="Share App">
            <i data-lucide="share" class="w-4 h-4"></i>
          </button>
        </div>
      </div>
    </div>

    <div class="flex items-center justify-between divide-x divide-black/[0.06] dark:divide-white/[0.08] py-2 border-y border-black/[0.06] dark:border-white/[0.08] text-center text-xs">
      <div class="flex-1 px-1">
        <span class="text-[10px] uppercase font-bold text-gray-400">RATINGS</span>
        <div class="font-extrabold text-black dark:text-white mt-0.5 flex items-center justify-center gap-1">
          <span class="inline-flex">${renderRatingStars(app.rating)}</span>
          <span>${app.rating || 'Not rated'}</span>
        </div>
        <span class="text-[9px] text-gray-400">${app.reviewsCount ? `${app.reviewsCount} Reviews` : 'Reviews unavailable'}</span>
      </div>

      <div class="flex-1 px-1">
        <span class="text-[10px] uppercase font-bold text-gray-400">AGE</span>
        <div class="font-extrabold text-black dark:text-white mt-0.5">${app.ageRating || 'Not specified'}</div>
        <span class="text-[9px] text-gray-400">Years Old</span>
      </div>

      <div class="flex-1 px-1">
        <span class="text-[10px] uppercase font-bold text-gray-400">CHART</span>
        <div class="font-extrabold text-black dark:text-white mt-0.5">${app.downloads || '—'}</div>
        <span class="text-[9px] text-gray-400">Downloads</span>
      </div>

      <div class="flex-1 px-1">
        <span class="text-[10px] uppercase font-bold text-gray-400">SIZE</span>
        <div class="font-extrabold text-black dark:text-white mt-0.5">${app.size}</div>
        <span class="text-[9px] text-gray-400">MB</span>
      </div>
    </div>

    <div class="space-y-2">
      <h3 class="text-sm font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">Preview</h3>
      <div id="detailMediaHost">${renderDetailMedia(app)}</div>
    </div>

    <div class="p-3.5 rounded-2xl bg-gray-100 dark:bg-apple-cardDarkSecondary/60 space-y-1 text-xs">
      <div class="flex items-center justify-between">
        <span class="font-bold text-black dark:text-white">What's New</span>
        <span class="text-[11px] text-gray-400 font-mono">Version ${app.version || '1.0.0'}</span>
      </div>
      <p class="text-gray-600 dark:text-gray-300 text-[11px] leading-relaxed">
        ${escapeHtml(app.updatedAt ? `Updated ${app.updatedAt}` : (app.description || 'No update information provided.'))}
      </p>
    </div>

    <div class="rounded-2xl bg-gray-100 dark:bg-apple-cardDarkSecondary/60 p-4 space-y-3">
      <div class="flex items-center justify-between"><h3 class="text-sm font-bold text-black dark:text-white">Storage</h3><span class="text-[11px] text-gray-400">Simulated device space</span></div>
      <div class="flex justify-between text-[11px] text-gray-500 dark:text-gray-400"><span>Available 58 GB</span><span>${escapeHtml(String(app.size || 0))} MB required</span></div>
      <div class="storage-meter"><span></span></div>
    </div>

    ${app.versionHistory.length ? `<div class="space-y-2"><h3 class="text-sm font-bold text-black dark:text-white">Version History</h3><div class="space-y-2">${app.versionHistory.slice(0,8).map(v=>`<div class="flex items-start justify-between gap-3 rounded-xl bg-gray-100 dark:bg-apple-cardDarkSecondary/60 p-3"><div><p class="text-xs font-bold text-black dark:text-white">Version ${escapeHtml(String(v.version || v.number || ''))}</p><p class="text-[11px] text-gray-500 dark:text-gray-400 mt-1">${escapeHtml(String(v.notes || v.changelog || v.description || 'Update information'))}</p></div><span class="text-[10px] text-gray-400">${escapeHtml(String(v.date || v.updatedAt || ''))}</span></div>`).join('')}</div></div>` : ''}

    <div class="space-y-2">
      <h3 class="text-sm font-bold text-black dark:text-white">Description</h3>
      <div class="text-xs text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-line font-normal">
        ${escapeHtml(app.description)}
      </div>
    </div>

    <div class="space-y-2 pt-2 border-t border-black/[0.06] dark:border-white/[0.08]">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-bold text-black dark:text-white">Information</h3>
      </div>
      <dl class="divide-y divide-black/[0.04] dark:divide-white/[0.06] text-xs">
        <div class="py-2 flex justify-between">
          <dt class="text-gray-400">Provider</dt>
          <dd class="font-medium text-black dark:text-white">${app.developer}</dd>
        </div>
        <div class="py-2 flex justify-between">
          <dt class="text-gray-400">Size</dt>
          <dd class="font-medium text-black dark:text-white">${app.size ? `${escapeHtml(String(app.size))} MB` : 'Size unavailable'}</dd>
        </div>
        <div class="py-2 flex justify-between">
          <dt class="text-gray-400">Category</dt>
          <dd class="font-medium text-black dark:text-white">${app.category}</dd>
        </div>
        <div class="py-2 flex justify-between">
          <dt class="text-gray-400">Compatibility</dt>
          <dd class="font-medium text-black dark:text-white">Web</dd>
        </div>
        <div class="py-2 flex justify-between">
          <dt class="text-gray-400">Languages</dt>
          <dd class="font-medium text-black dark:text-white">Based on feed data</dd>
        </div>
      </dl>
    </div>

    <div class="pt-3 grid grid-cols-[1fr_auto] gap-2">
      <button onclick="handleDownloadClick('${app.id}', event)" class="pressable py-3 rounded-2xl bg-apple-blue hover:bg-apple-blue/90 text-white font-bold text-sm shadow-lg shadow-apple-blue/30 flex items-center justify-center gap-2">
        <i data-lucide="download" class="w-4 h-4"></i>
        <span>Download</span>
      </button>
      <button onclick="toggleWishlist('${app.id}', event)" class="pressable w-12 rounded-2xl bg-gray-200 dark:bg-apple-cardDarkSecondary text-black dark:text-white flex items-center justify-center" aria-label="Save to wishlist">
        <i data-lucide="bookmark" class="w-4 h-4"></i>
      </button>
    </div>
  `;

  modal.classList.remove('hidden');
  setTimeout(() => {
    modal.classList.remove('opacity-0', 'pointer-events-none');
    sheet.classList.add('modal-enter-active');
  }, 10);

  if (window.lucide) window.lucide.createIcons();
}

function closeAppDetailModal() {
  stopDetailMediaPlayback();
  const modal = document.getElementById('appDetailModal');
  const sheet = document.getElementById('detailSheet');
  if (!modal || !sheet) return;

  sheet.classList.remove('modal-enter-active');
  sheet.classList.add('modal-leave-active');
  modal.classList.add('opacity-0', 'pointer-events-none');

  setTimeout(() => {
    modal.classList.add('hidden');
    sheet.classList.remove('modal-leave-active');
  }, 250);
}

function shareApp(appId) {
  const app = appsCatalog.find(a => a.id === appId);
  if (!app) return;
  const shareUrl = app.downloadUrl || `${APP_FEED_URL}#${encodeURIComponent(app.id)}`;
  if (navigator.share) {
    navigator.share({ title: `Get ${app.name} on Rise Hub`, text: app.tagline || app.description, url: shareUrl }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(shareUrl).then(() => showToast('App link copied.', 'copy')).catch(() => {});
  }
}

// ================= DOWNLOAD MANAGER =================
function loadDownloadState() {
  try { downloadHistory = JSON.parse(localStorage.getItem(DOWNLOADS_KEY) || '[]'); } catch { downloadHistory = []; }
  try { wishlistIds = new Set(JSON.parse(localStorage.getItem(WISHLIST_KEY) || '[]').map(String)); } catch { wishlistIds = new Set(); }
  installedAppIds = new Set(downloadHistory.map(item => String(item.id))); 
  pruneExpiredDownloads();
}

function saveDownloadState() { localStorage.setItem(DOWNLOADS_KEY, JSON.stringify(downloadHistory)); }
function saveWishlistState() { localStorage.setItem(WISHLIST_KEY, JSON.stringify([...wishlistIds])); }

function pruneExpiredDownloads() {
  const now = Date.now();
  const expired = downloadHistory.filter(item => now - Number(item.downloadedAt) >= DOWNLOAD_EXPIRY_MS);
  if (!expired.length) return;
  expired.forEach(item => window.AndroidBridge?.deleteDownloadedFile?.(String(item.id)));
  downloadHistory = downloadHistory.filter(item => now - Number(item.downloadedAt) < DOWNLOAD_EXPIRY_MS);
  saveDownloadState();
}

let expiryTimer = null;
function scheduleDownloadExpiry() {
  if (expiryTimer) clearTimeout(expiryTimer);
  pruneExpiredDownloads();
  const nextExpiry = downloadHistory.map(item => Number(item.downloadedAt) + DOWNLOAD_EXPIRY_MS).filter(Boolean).sort((a,b)=>a-b)[0];
  if (!nextExpiry) return;
  expiryTimer = setTimeout(() => {
    pruneExpiredDownloads();
    renderDownloadsView();
    scheduleDownloadExpiry();
  }, Math.max(1000, nextExpiry - Date.now()));
}
function startDownloadExpiryMonitor() { scheduleDownloadExpiry(); }

function toggleWishlist(appId, event) {
  event?.stopPropagation();
  if (wishlistIds.has(String(appId))) wishlistIds.delete(String(appId));
  else wishlistIds.add(String(appId));
  saveWishlistState();
  renderWishlistViews();
  showToast(wishlistIds.has(String(appId)) ? 'Saved to wishlist.' : 'Removed from wishlist.', 'bookmark');
}

function renderWishlistCard(app) {
  return `<div class="download-card flex items-center gap-3">
    <img src="${escapeHtml(app.icon)}" alt="${escapeHtml(app.name)}" class="w-12 h-12 ios-squircle object-cover bg-gray-800 flex-shrink-0">
    <div class="min-w-0 flex-1 cursor-pointer" onclick="openAppDetailModal('${escapeHtml(app.id)}')"><p class="text-sm font-bold text-white truncate">${escapeHtml(app.name)}</p><p class="text-[11px] text-gray-400 truncate">${escapeHtml(app.developer)}</p></div>
    <button onclick="toggleWishlist('${escapeHtml(app.id)}', event)" class="w-9 h-9 rounded-full bg-white/[0.06] text-gray-300 flex items-center justify-center" aria-label="Remove from wishlist"><i data-lucide="bookmark-minus" class="w-4 h-4"></i></button>
  </div>`;
}

function renderWishlistViews() {
  const apps = [...wishlistIds].map(id => appsCatalog.find(a => a.id === id)).filter(Boolean);
  const html = apps.map(renderWishlistCard).join('');
  ['wishlistList','wishlistTabList'].forEach(id => { const el=document.getElementById(id); if(el) el.innerHTML=html; });
  ['wishlistEmpty','wishlistTabEmpty'].forEach(id => { const el=document.getElementById(id); if(el) el.classList.toggle('hidden', apps.length > 0); });
  if (window.lucide) window.lucide.createIcons();
}

function formatRemaining(ms) {
  const days = Math.max(0, Math.ceil(ms / 86400000));
  return `${days} day${days === 1 ? '' : 's'} remaining`;
}

function hasNewerVersion(current, previous) {
  const a=String(current||'').split('.').map(n=>parseInt(n,10)||0), b=String(previous||'').split('.').map(n=>parseInt(n,10)||0);
  for(let i=0;i<Math.max(a.length,b.length);i++){ if((a[i]||0)>(b[i]||0)) return true; if((a[i]||0)<(b[i]||0)) return false; }
  return false;
}

function renderDownloadsView() {
  pruneExpiredDownloads();
  const list=document.getElementById('downloadsList'), empty=document.getElementById('downloadsEmpty');
  if(!list || !empty) return;
  if(!downloadHistory.length){ list.innerHTML=''; empty.classList.remove('hidden'); }
  else {
    empty.classList.add('hidden');
    list.innerHTML=downloadHistory.map(item=>{
      const app=appsCatalog.find(a=>a.id===item.id) || item.app;
      const remaining=DOWNLOAD_EXPIRY_MS-(Date.now()-Number(item.downloadedAt));
      const update=app && hasNewerVersion(app.version,item.version);
      return `<div class="download-card">
        <div class="flex items-center gap-3">
          <img src="${escapeHtml(app?.icon || item.icon || '')}" alt="${escapeHtml(app?.name || item.name)}" class="w-12 h-12 ios-squircle object-cover bg-gray-800 flex-shrink-0">
          <div class="min-w-0 flex-1"><p class="text-sm font-bold text-white truncate">${escapeHtml(app?.name || item.name)}</p><p class="text-[11px] text-gray-400 truncate">Version ${escapeHtml(app?.version || item.version || 'Unknown')} · ${formatRemaining(remaining)}</p>${update?'<p class="text-[10px] text-apple-blue mt-1">A newer version is available.</p>':''}</div>
          <button onclick="redownloadApp('${escapeHtml(item.id)}', event)" class="px-3 py-1.5 rounded-full bg-white/[0.08] text-white text-[11px] font-bold">${update?'UPDATE':'DOWNLOAD'}</button>
        </div>
        <div class="mt-3 storage-meter"><span style="width:${Math.min(100, Math.max(4, Number(app?.size)||8))}%"></span></div>
        <p class="mt-1 text-[10px] text-gray-500">Downloaded ${new Date(Number(item.downloadedAt)).toLocaleString()}</p>
      </div>`;
    }).join('');
  }
  if(window.lucide) window.lucide.createIcons();
}

function openDownloadConfirm(appId) {
  if (downloadInProgressId) return;
  pendingDownloadAppId = String(appId);
  const app = appsCatalog.find(a => a.id === pendingDownloadAppId);
  if (!app) return;
  const modal = document.getElementById('downloadConfirmModal');
  const text = document.getElementById('downloadConfirmText');
  if (text) text.textContent = 'Do you want to download and install this application?';
  if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }
  if (window.lucide) window.lucide.createIcons();
}

function closeDownloadConfirm() {
  pendingDownloadAppId = null;
  const modal = document.getElementById('downloadConfirmModal');
  if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
}

function showDownloadProgress(app) {
  const modal = document.getElementById('downloadProgressModal');
  if (!modal) return;
  const icon = document.getElementById('downloadProgressIcon');
  if (icon) { icon.src = app.icon || ''; icon.onerror = () => icon.removeAttribute('src'); }
  document.getElementById('downloadProgressName').textContent = app.name;
  document.getElementById('downloadProgressText').textContent = 'Preparing download...';
  document.getElementById('downloadProgressFill').style.width = '0%';
  document.getElementById('downloadProgressPercent').textContent = '0%';
  document.getElementById('downloadProgressSize').textContent = app.size ? String(app.size) : '';
  const cancel = document.getElementById('downloadCancelButton');
  if (cancel) { cancel.disabled = false; cancel.textContent = 'Cancel'; }
  modal.classList.remove('hidden'); modal.classList.add('flex');
}
function hideDownloadProgress() { const modal=document.getElementById('downloadProgressModal'); if(modal){modal.classList.add('hidden');modal.classList.remove('flex');} }

async function confirmDownload() {
  const appId = pendingDownloadAppId; closeDownloadConfirm();
  const app = appsCatalog.find(a => a.id === appId);
  if (!app) return;
  if (!app.downloadUrl) { showToast('This application has no download file.', 'alert-circle'); return; }
  downloadInProgressId = app.id; downloadStartedAt = performance.now(); downloadSpeedBytesPerSecond = 0;
  showDownloadProgress(app); renderAllViews();
  try {
    if (window.AndroidBridge && typeof window.AndroidBridge.downloadFile === 'function') {
      window.AndroidBridge.downloadFile(app.downloadUrl, `${app.name.replace(/[^a-z0-9._-]+/gi, '_')}.apk`, String(app.id));
    } else { await downloadInWebView(app); }
  } catch (error) {
    if (error?.name === 'AbortError') onDownloadCancelled(app.id);
    else onDownloadFailed(app.id, error?.message || 'Download failed.');
  }
}

async function downloadInWebView(app) {
  activeDownloadAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const response = await fetch(app.downloadUrl, {cache:'no-store', signal:activeDownloadAbortController?.signal});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0; let received=0; const chunks=[];
  const reader=response.body?.getReader();
  if(reader){ while(true){ const {done,value}=await reader.read(); if(done) break; chunks.push(value); received+=value.byteLength; updateDownloadProgress(total?Math.round(received/total*100):0,received,total); } }
  else { const blob=await response.blob(); chunks.push(new Uint8Array(await blob.arrayBuffer())); received=chunks[0].byteLength; updateDownloadProgress(100,received,total); }
  const blob=new Blob(chunks,{type:'application/vnd.android.package-archive'}), objectUrl=URL.createObjectURL(blob);
  const anchor=document.createElement('a'); anchor.href=objectUrl; anchor.download=`${app.name.replace(/[^a-z0-9._-]+/gi,'_')}.apk`; anchor.rel='noopener'; document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(objectUrl),5000); onDownloadComplete(app.id,'browser');
}

function formatBytes(value){ const n=Number(value)||0; if(n<1024)return `${Math.round(n)} B`; if(n<1048576)return `${(n/1024).toFixed(1)} KB`; return `${(n/1048576).toFixed(1)} MB`; }
function updateDownloadProgress(percent,received,total){
  const safe=Math.max(0,Math.min(100,Number(percent)||0));
  const fill=document.getElementById('downloadProgressFill'), pct=document.getElementById('downloadProgressPercent'), txt=document.getElementById('downloadProgressText'), speed=document.getElementById('downloadProgressSpeed');
  if(fill)fill.style.width=`${safe}%`; if(pct)pct.textContent=`${safe}%`;
  if(downloadStartedAt&&received>0){ const elapsed=Math.max(.1,(performance.now()-downloadStartedAt)/1000); downloadSpeedBytesPerSecond=received/elapsed; }
  if(speed)speed.textContent=downloadSpeedBytesPerSecond?`${formatBytes(downloadSpeedBytesPerSecond)}/s`:'';
  if(txt)txt.textContent=safe>=100?'Download complete. Preparing installation...':'Downloading application...';
}

function cancelActiveDownload(){
  const appId=downloadInProgressId; if(!appId)return;
  const cancel=document.getElementById('downloadCancelButton'); if(cancel){cancel.disabled=true;cancel.textContent='Cancelling';}
  try{window.AndroidBridge?.cancelDownload?.(String(appId));}catch(_){}
  try{activeDownloadAbortController?.abort();}catch(_){}
  activeDownloadAbortController=null; downloadInProgressId=null; downloadStartedAt=0; hideDownloadProgress(); renderAllViews(); showToast('Download cancelled.','x-circle');
}
window.onNativeDownloadProgress=function(appId,percent,received,total){ if(String(appId)===String(downloadInProgressId)) updateDownloadProgress(percent,received,total); };
function onDownloadComplete(appId,path){
  const app=appsCatalog.find(a=>a.id===String(appId)); if(!app)return;
  downloadHistory=downloadHistory.filter(x=>String(x.id)!==String(app.id)); downloadHistory.unshift({id:app.id,name:app.name,icon:app.icon,version:app.version,downloadedAt:Date.now(),path}); installedAppIds.add(String(app.id)); saveDownloadState(); renderDownloadsView(); scheduleDownloadExpiry();
  updateDownloadProgress(100,0,0); downloadInProgressId=null; activeDownloadAbortController=null;
  setTimeout(()=>{hideDownloadProgress(); if(path!=='browser')window.AndroidBridge?.installDownloadedFile?.(String(app.id));},path==='browser'?350:500);
  showToast('Download complete.','check-circle'); renderAllViews();
}
window.onNativeDownloadComplete=function(appId,path){onDownloadComplete(appId,path);};
window.onNativeDownloadCancelled=function(appId){ if(String(appId)!==String(downloadInProgressId))return; downloadInProgressId=null; activeDownloadAbortController=null; hideDownloadProgress(); renderAllViews(); showToast('Download cancelled.','x-circle'); };
window.onNativeDownloadError=function(appId,message){onDownloadFailed(appId,message);};
function onDownloadFailed(appId,message){hideDownloadProgress();downloadInProgressId=null;activeDownloadAbortController=null;renderAllViews();showToast(message||'Download failed.','alert-circle');}
function onDownloadCancelled(appId){window.onNativeDownloadCancelled(String(appId));}
function redownloadApp(appId,event){event?.stopPropagation();openDownloadConfirm(appId);}
function renderGetButtonHtml(appId){
  const id=String(appId);
  if(String(downloadInProgressId)===id)return `<button onclick="cancelActiveDownload(); event.stopPropagation()" class="pressable px-4 py-1 rounded-full font-bold text-xs uppercase tracking-wide bg-apple-red text-white transition flex items-center justify-center min-w-[78px]" aria-label="Cancel download">CANCEL</button>`;
  const isDownloaded=downloadHistory.some(x=>String(x.id)===id);
  return `<button onclick="handleDownloadClick('${escapeHtml(id)}', event)" class="pressable px-4 py-1 rounded-full font-bold text-xs uppercase tracking-wide ${isDownloaded?'bg-gray-200 dark:bg-apple-cardDarkSecondary text-apple-blue':'bg-apple-blue/15 text-apple-blue hover:bg-apple-blue hover:text-white'} transition flex items-center justify-center min-w-[70px]">${isDownloaded?'OPEN':'GET'}</button>`;
}
function handleDownloadClick(appId,event){event?.stopPropagation();const app=appsCatalog.find(a=>a.id===String(appId));if(!app)return;if(String(downloadInProgressId)===String(appId)){cancelActiveDownload();return;}if(downloadHistory.some(x=>String(x.id)===String(appId))){window.AndroidBridge?.installDownloadedFile?.(String(appId));return;}openDownloadConfirm(appId);}

// ================= TOAST NOTIFICATION =================
let toastTimeout = null;
function showToast(message, iconName = 'check-circle') {
  const toast = document.getElementById('toastNotification');
  const msgEl = document.getElementById('toastMessage');
  const iconEl = document.getElementById('toastIcon');
  if (!toast || !msgEl) return;

  msgEl.textContent = message;
  if (iconEl) {
    iconEl.setAttribute('data-lucide', iconName);
    if (window.lucide) window.lucide.createIcons();
  }

  toast.classList.remove('opacity-0', '-translate-y-4', 'pointer-events-none');
  toast.classList.add('opacity-100', 'translate-y-0');

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.remove('opacity-100', 'translate-y-0');
    toast.classList.add('opacity-0', '-translate-y-4', 'pointer-events-none');
  }, 2600);
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ================= ANDROID HARDWARE BACK HANDLER =================
window.handleHardwareBack = function() {
  const detailModal = document.getElementById('appDetailModal');

  if (detailModal && !detailModal.classList.contains('hidden')) {
    closeAppDetailModal();
    return true;
  }
  const headerInput = document.getElementById('headerSearchInput');
  const tabInput = document.getElementById('searchInput');
  if ((headerInput && headerInput.value) || (tabInput && tabInput.value)) {
    clearAllSearch();
    return true;
  }
  if (currentTab !== 'today') {
    switchTab('today');
    return true;
  }
  return false;
};

// ================= FIRST-TIME ONBOARDING =================
function shouldShowOnboarding() {
  try { return localStorage.getItem(ONBOARDING_KEY) !== '1'; } catch (_) { return true; }
}

function markOnboardingSeen() {
  try { localStorage.setItem(ONBOARDING_KEY, '1'); } catch (_) {}
  closeOnboarding();
}

function renderOnboardingStep() {
  const overlay = document.getElementById('onboardingOverlay');
  const title = document.getElementById('onboardingTitle');
  const body = document.getElementById('onboardingBody');
  const counter = document.getElementById('onboardingCounter');
  const back = document.getElementById('onboardingBack');
  const next = document.getElementById('onboardingNext');
  const step = ONBOARDING_STEPS[onboardingStepIndex];
  if (!overlay || !step) return;
  title.textContent = step.title;
  body.textContent = step.body;
  counter.textContent = `${onboardingStepIndex + 1} of ${ONBOARDING_STEPS.length}`;
  back.disabled = onboardingStepIndex === 0;
  back.classList.toggle('opacity-40', onboardingStepIndex === 0);
  next.textContent = onboardingStepIndex === ONBOARDING_STEPS.length - 1 ? 'Got It' : 'Next';
  document.querySelectorAll('.onboarding-target').forEach(el => el.classList.remove('onboarding-target'));
  const target = document.querySelector(step.target);
  if (target) target.classList.add('onboarding-target');
}

function openOnboarding() {
  const overlay = document.getElementById('onboardingOverlay');
  if (!overlay) return;
  onboardingStepIndex = 0;
  overlay.classList.remove('hidden');
  overlay.setAttribute('aria-hidden', 'false');
  renderOnboardingStep();
  if (window.lucide) window.lucide.createIcons();
}

function closeOnboarding() {
  const overlay = document.getElementById('onboardingOverlay');
  if (!overlay) return;
  document.querySelectorAll('.onboarding-target').forEach(el => el.classList.remove('onboarding-target'));
  overlay.classList.add('hidden');
  overlay.setAttribute('aria-hidden', 'true');
}

function onboardingNext() {
  if (onboardingStepIndex >= ONBOARDING_STEPS.length - 1) { markOnboardingSeen(); return; }
  onboardingStepIndex += 1;
  renderOnboardingStep();
}

function onboardingBack() {
  if (onboardingStepIndex <= 0) return;
  onboardingStepIndex -= 1;
  renderOnboardingStep();
}

function initOnboarding() {
  if (!shouldShowOnboarding()) return;
  window.setTimeout(() => openOnboarding(), 650);
}

// Lifecycle Start
initStore();
