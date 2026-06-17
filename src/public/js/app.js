const API = '';
const SERVICES = ['Netflix','Max','Hulu','Disney+','Apple TV+','Peacock','Paramount+','Amazon Prime','Other'];
const KNOWN_SERVICES = new Set(SERVICES);
const STATUSES = ['Watching','Plan to Watch','Completed','On Hold','Dropped'];
const NOTIFY_OPTIONS = [['two_days','2 days before'],['day_before','1 day before'],['drop','When episode airs'],['none','No episode emails']];
const STATUS_BADGE = { 'Watching':'b-watching','Plan to Watch':'b-plan','Completed':'b-completed','On Hold':'b-hold','Dropped':'b-dropped' };
const PUBLIC_PAGES = {
  plus: {
    title: 'Bingekeeper Plus',
    eyebrow: 'Pricing',
    body: `<p>Track the shows you care about, remember where you watch them, and get a clean view of upcoming episodes.</p><div class="pricing-grid"><div><h3>Free</h3><strong>$0</strong><p>Track up to 10 shows, including status, streaming service, season, episode, and upcoming episode details.</p></div><div class="featured"><h3>Plus</h3><strong>Monthly</strong><p>Unlimited show tracking and self-service billing through Stripe. The final price is shown securely at checkout.</p><button class="btn-primary" onclick="openBillingFromPublic()">Upgrade to Plus</button></div></div>`
  },
  support: {
    title: 'Support',
    eyebrow: 'Help',
    body: `<p>Need help with your account, billing, email verification, or show tracking? Email <a href="mailto:hello@bingekeeper.tv">hello@bingekeeper.tv</a>.</p><p>A dedicated customer service number can be added here once your business phone line is active.</p>`
  },
  privacy: {
    title: 'Privacy Policy',
    eyebrow: 'Effective June 12, 2026',
    body: `<p>Bingekeeper stores the account details needed to run the service: your name, email address, password hash, verification status, subscription status, and watchlist data.</p><p>Payments are handled by Stripe. Bingekeeper does not store full card numbers. Email delivery is handled by Resend, and show data comes from TMDB.</p><p>Your data is used to provide account access, email verification, password resets, episode reminders, watchlist features, and billing status. To request help or deletion, contact <a href="mailto:hello@bingekeeper.tv">hello@bingekeeper.tv</a>.</p>`
  },
  terms: {
    title: 'Terms of Service',
    eyebrow: 'Effective June 12, 2026',
    body: `<p>Bingekeeper is provided as a show-tracking tool. You are responsible for keeping your login information secure and for using the service lawfully.</p><p>Plus subscriptions are billed through Stripe and can be managed from the app. Free accounts may be limited to 10 tracked shows.</p><p>Bingekeeper depends on third-party services for payments, email, hosting, and show metadata. The service may change as those services or the product evolve.</p>`
  }
};

let token = localStorage.getItem('bk_token');
let currentUser = JSON.parse(localStorage.getItem('bk_user') || 'null');
let watchlist = [];
let searchResults = [];
let dashboardRecommendations = [];
let dashboardRecommendationGroups = [];
let detailRecommendations = [];
let recommendationLoadToken = 0;
let pendingAddShow = null;
let activeTab = 'All';
let adminSocialData = null;
let authConfig = { turnstileSiteKey: '' };
let pushConfig = { supported: false, vapidPublicKey: '' };
let pushState = { available: false, permission: 'default', enabled: false, endpoint: '' };
let deferredInstallPrompt = null;
const turnstileWidgets = { register: null, forgot: null };
const turnstileActions = { register: 'register', forgot: 'password_reset' };

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  syncInstallButtons();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  syncInstallButtons();
  toast('BingeKeeper installed.');
});

window.addEventListener('DOMContentLoaded', async () => {
  registerServiceWorker();
  await loadAuthConfig();
  const route = getAuthRoute();
  const billingResult = window.location.hash;
  const oauthResult = getOAuthResult();
  if (billingResult === '#billing=cancelled') toast('Upgrade cancelled.');
  if (route.name === 'verify' && route.token) { showVerify(route.token);
  } else if (route.name === 'reset' && route.token) { showReset(route.token);
  } else if (oauthResult.error) { showAuth(); showOAuthError(oauthResult.message);
  } else if (PUBLIC_PAGES[billingResult.slice(1)]) { showPublicPage(billingResult.slice(1));
  } else if (window.location.pathname === '/admin/social') { showAdminSocial();
  } else if (token && currentUser) { showApp(billingResult === '#billing=success');
  } else { showAuth(); }
  syncInstallButtons();
});
function getAuthRoute() {
  const hashMatch = window.location.hash.match(/^#(verify|reset)\?(.*)$/);
  if (hashMatch) {
    return { name: hashMatch[1], token: new URLSearchParams(hashMatch[2]).get('token') };
  }
  const params = new URLSearchParams(window.location.search);
  if (params.get('token') && window.location.pathname === '/verify') return { name: 'verify', token: params.get('token') };
  if (params.get('token') && window.location.pathname === '/reset') return { name: 'reset', token: params.get('token') };
  return { name: '', token: '' };
}
function getOAuthResult() {
  if (!window.location.hash.startsWith('#oauth=')) return { error: false, message: '' };
  const params = new URLSearchParams(window.location.hash.slice(1));
  return { error: params.get('oauth') === 'error', message: params.get('message') || 'Google login failed. Please try again.' };
}
function showAuth() {
  document.getElementById('authPage').classList.remove('hidden');
  document.getElementById('appPage').classList.add('hidden');
  document.getElementById('publicPage').classList.add('hidden');
  document.getElementById('adminSocialPage').classList.add('hidden');
  showLogin(false);
}
function showLogin(shouldScroll = true) { hideAllAuthForms(); document.getElementById('loginForm').classList.remove('hidden'); if (shouldScroll) scrollAuthPanel(); }
function showRegister(shouldScroll = true) { hideAllAuthForms(); document.getElementById('registerForm').classList.remove('hidden'); renderTurnstile('register'); if (shouldScroll) scrollAuthPanel(); }
function showForgot() { hideAllAuthForms(); document.getElementById('forgotForm').classList.remove('hidden'); renderTurnstile('forgot'); }
function showReset(t) { hideAllAuthForms(); document.getElementById('authPage').classList.remove('hidden'); document.getElementById('resetForm').classList.remove('hidden'); document.getElementById('resetForm').dataset.token = t; }
function showVerify(t) { document.getElementById('authPage').classList.remove('hidden'); hideAllAuthForms(); document.getElementById('verifyForm').classList.remove('hidden'); verifyEmail(t); }
function hideAllAuthForms() { ['loginForm','registerForm','forgotForm','resetForm','verifyForm'].forEach(id => { document.getElementById(id).classList.add('hidden'); }); }
function scrollAuthPanel() {
  const panel = document.querySelector('.auth-panel');
  if (panel && !document.getElementById('authPage').classList.contains('hidden')) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function scrollToHowItWorks() {
  document.getElementById('howItWorks')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function startGoogleLogin() {
  const returnTo = window.location.pathname === '/admin/social' ? '/admin/social' : '/';
  window.location.href = `/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`;
}
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const register = () => navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
function isStandaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function syncInstallButtons() {
  const canInstall = Boolean(deferredInstallPrompt) && !isStandaloneApp();
  ['installAppBtn', 'installAppBtnHeader'].forEach(id => {
    const button = document.getElementById(id);
    if (button) button.classList.toggle('hidden', !canInstall);
  });
}
async function installApp() {
  if (!deferredInstallPrompt) {
    toast('In Chrome, open the menu and tap Add to Home screen.');
    return;
  }
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice.catch(() => null);
  deferredInstallPrompt = null;
  syncInstallButtons();
}
async function loadPushConfig() {
  pushState = {
    available: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
    permission: 'Notification' in window ? Notification.permission : 'unsupported',
    enabled: false,
    endpoint: ''
  };

  const section = document.getElementById('pushSettingsSection');
  if (!section) return;

  if (!pushState.available) {
    pushConfig = { supported: false, vapidPublicKey: '' };
    renderPushSettings();
    return;
  }

  const res = await api('/api/push/config', 'GET');
  if (res.error) {
    pushConfig = { supported: false, vapidPublicKey: '' };
    renderPushSettings('Notification settings could not be loaded.');
    return;
  }

  pushConfig = res;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    pushState.enabled = Boolean(subscription);
    pushState.endpoint = subscription?.endpoint || '';
  } catch {
    pushState.enabled = false;
    pushState.endpoint = '';
  }
  renderPushSettings();
}
function renderPushSettings(message = '') {
  const section = document.getElementById('pushSettingsSection');
  const copy = document.getElementById('pushSettingsCopy');
  const actions = document.getElementById('pushSettingsActions');
  if (!section || !copy || !actions) return;

  section.classList.remove('hidden');

  if (!pushState.available) {
    copy.textContent = 'Browser notifications are not supported in this browser. Email reminders will still work.';
    actions.innerHTML = '';
    return;
  }

  if (!pushConfig.supported) {
    copy.textContent = message || 'Push notifications are not configured yet. Email reminders will still work.';
    actions.innerHTML = '';
    return;
  }

  if (isIos() && !isStandaloneApp()) {
    copy.textContent = 'On iPhone or iPad, install BingeKeeper to your Home Screen first, then open it from the app icon to enable push notifications.';
    actions.innerHTML = '<button class="btn-secondary" onclick="installApp()">Install app</button>';
    return;
  }

  if (pushState.permission === 'denied') {
    copy.textContent = 'Notifications are blocked in this browser. Enable them in browser or site settings, then reload BingeKeeper.';
    actions.innerHTML = '';
    return;
  }

  if (pushState.enabled) {
    copy.textContent = message || 'Browser notifications are enabled on this device. Email reminders remain available as fallback.';
    actions.innerHTML = '<button class="btn-secondary" onclick="sendTestPush()">Send test</button><button class="btn-ghost" onclick="disablePushNotifications()">Disable</button>';
    return;
  }

  copy.textContent = message || 'Turn on browser notifications to get alerts on this device when tracked shows have new episodes or seasons.';
  actions.innerHTML = '<button class="btn-primary" onclick="enablePushNotifications()">Enable notifications</button>';
}
async function enablePushNotifications() {
  if (!pushState.available || !pushConfig.supported) {
    renderPushSettings('Push notifications are not available right now.');
    return;
  }
  if (isIos() && !isStandaloneApp()) {
    renderPushSettings();
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    pushState.permission = permission;
    if (permission !== 'granted') {
      renderPushSettings('Notifications were not enabled. You can try again later from this device.');
      return;
    }

    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(pushConfig.vapidPublicKey)
    });
    const res = await api('/api/push/subscribe', 'POST', { subscription: subscription.toJSON() });
    if (res.error) {
      await subscription.unsubscribe().catch(() => {});
      renderPushSettings(res.error);
      return;
    }

    pushState.enabled = true;
    pushState.endpoint = subscription.endpoint;
    renderPushSettings('Notifications are enabled on this device.');
    toast('Notifications enabled.');
  } catch {
    renderPushSettings('Could not enable notifications. Please refresh and try again.');
  }
}
async function disablePushNotifications() {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    const endpoint = subscription?.endpoint || pushState.endpoint;
    if (subscription) await subscription.unsubscribe();
    await api('/api/push/subscribe', 'DELETE', endpoint ? { endpoint } : null);
    pushState.enabled = false;
    pushState.endpoint = '';
    renderPushSettings('Notifications are disabled on this device.');
    toast('Notifications disabled.');
  } catch {
    renderPushSettings('Could not disable notifications. Please try again.');
  }
}
async function sendTestPush() {
  const res = await api('/api/push/test', 'POST');
  if (res.error) { toast(res.error); return; }
  toast(`Test notification sent to ${res.sent || 1} ${plural(res.sent || 1, 'device')}.`);
}
function urlBase64ToUint8Array(value) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}
function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function showOAuthError(message) {
  hideAllAuthForms();
  const loginForm = document.getElementById('loginForm');
  const errEl = document.getElementById('loginError');
  loginForm.classList.remove('hidden');
  showError(errEl, message);
  window.history.replaceState(null, '', '/');
}
async function loadAuthConfig() {
  const res = await api('/api/auth/config', 'GET');
  if (!res.error) authConfig = { ...authConfig, ...res };
  syncTurnstileUi();
}
function syncTurnstileUi() {
  ['register', 'forgot'].forEach(name => {
    const wrap = document.getElementById(`${name}TurnstileWrap`);
    if (wrap) wrap.classList.toggle('hidden', !authConfig.turnstileSiteKey);
  });
}
function renderTurnstile(name) {
  const container = document.getElementById(`${name}Turnstile`);
  if (!container || !authConfig.turnstileSiteKey) return;
  if (!window.turnstile) {
    setTimeout(() => renderTurnstile(name), 250);
    return;
  }
  if (turnstileWidgets[name] !== null) {
    resetTurnstile(name);
    return;
  }
  try {
    turnstileWidgets[name] = window.turnstile.render(container, {
      sitekey: authConfig.turnstileSiteKey,
      theme: 'dark',
      size: 'flexible',
      action: turnstileActions[name]
    });
  } catch {
    turnstileWidgets[name] = window.turnstile.render(container, {
      sitekey: authConfig.turnstileSiteKey,
      theme: 'dark',
      action: turnstileActions[name]
    });
  }
}
function getTurnstileToken(name) {
  if (!authConfig.turnstileSiteKey || !window.turnstile || turnstileWidgets[name] === null) return '';
  return window.turnstile.getResponse(turnstileWidgets[name]) || '';
}
function resetTurnstile(name) {
  if (window.turnstile && turnstileWidgets[name] !== null) window.turnstile.reset(turnstileWidgets[name]);
}
async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.classList.add('hidden');
  if (!email || !password) { showError(errEl, 'Please fill in all fields'); return; }
  const btn = event.target; btn.disabled = true; btn.textContent = 'Signing in...';
  const res = await api('/api/auth/login', 'POST', { email, password });
  btn.disabled = false; btn.textContent = 'Sign in';
  if (res.error) { showError(errEl, res.error); return; }
  token = res.token; currentUser = res.user;
  localStorage.setItem('bk_token', token); localStorage.setItem('bk_user', JSON.stringify(currentUser));
  if (window.location.pathname === '/admin/social') { showAdminSocial(); return; }
  showApp();
}
async function doRegister() {
  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;
  const passwordConfirm = document.getElementById('regPasswordConfirm').value;
  const errEl = document.getElementById('regError'); const successEl = document.getElementById('regSuccess');
  errEl.classList.add('hidden'); successEl.classList.add('hidden');
  if (!name || !email || !password || !passwordConfirm) { showError(errEl, 'Please fill in all fields'); return; }
  if (password !== passwordConfirm) { showError(errEl, 'Passwords do not match'); return; }
  const turnstileToken = getTurnstileToken('register');
  if (!turnstileToken) { showError(errEl, 'Please complete the security check before creating your account.'); return; }
  const btn = event.target; btn.disabled = true; btn.textContent = 'Creating account...';
  const res = await api('/api/auth/register', 'POST', { name, email, password, turnstileToken });
  btn.disabled = false; btn.textContent = 'Create account';
  if (res.error) { resetTurnstile('register'); showError(errEl, res.error); return; }
  successEl.textContent = res.message; successEl.classList.remove('hidden');
  resetTurnstile('register');
}
async function doForgot() {
  const email = document.getElementById('forgotEmail').value.trim();
  const errEl = document.getElementById('forgotError'); const successEl = document.getElementById('forgotSuccess');
  errEl.classList.add('hidden'); successEl.classList.add('hidden');
  if (!email) { showError(errEl, 'Please enter your email'); return; }
  const turnstileToken = getTurnstileToken('forgot');
  if (!turnstileToken) { showError(errEl, 'Please complete the security check before sending a reset link.'); return; }
  const btn = event.target; btn.disabled = true; btn.textContent = 'Sending reset link...';
  const res = await api('/api/auth/forgot', 'POST', { email, turnstileToken });
  btn.disabled = false; btn.textContent = 'Send reset link';
  if (res.error) { resetTurnstile('forgot'); showError(errEl, res.error); return; }
  successEl.textContent = res.message; successEl.classList.remove('hidden');
  resetTurnstile('forgot');
}
async function doReset() {
  const password = document.getElementById('resetPassword').value;
  const t = document.getElementById('resetForm').dataset.token;
  const errEl = document.getElementById('resetError'); const successEl = document.getElementById('resetSuccess');
  errEl.classList.add('hidden'); successEl.classList.add('hidden');
  if (!password) { showError(errEl, 'Please enter a new password'); return; }
  const res = await api('/api/auth/reset', 'POST', { token: t, password });
  if (res.error) { showError(errEl, res.error); return; }
  successEl.textContent = res.message + ' Redirecting...'; successEl.classList.remove('hidden');
  setTimeout(() => { window.location.href = '/'; }, 2000);
}
async function verifyEmail(t) {
  const res = await api('/api/auth/verify', 'POST', { token: t });
  const msg = document.getElementById('verifyMsg');
  if (res.error) { msg.style.color = '#ef4444'; msg.textContent = res.error;
  } else { msg.style.color = '#22c55e'; msg.textContent = res.message + ' Redirecting to login...'; setTimeout(() => { window.location.href = '/'; }, 2500); }
}
function doLogout() { token = null; currentUser = null; localStorage.removeItem('bk_token'); localStorage.removeItem('bk_user'); watchlist = []; dashboardRecommendations = []; dashboardRecommendationGroups = []; detailRecommendations = []; adminSocialData = null; pushState = { available: false, permission: 'default', enabled: false, endpoint: '' }; showAuth(); }
async function showApp(fromBilling = false) {
  document.getElementById('authPage').classList.add('hidden'); document.getElementById('publicPage').classList.add('hidden'); document.getElementById('adminSocialPage').classList.add('hidden'); document.getElementById('appPage').classList.remove('hidden');
  await refreshCurrentUser();
  if (fromBilling) toast(currentUser?.plan === 'plus' ? 'Welcome to Plus!' : 'Plus is processing. Your account will update shortly.');
  if (fromBilling) window.history.replaceState(null, '', '/');
  document.getElementById('headerName').textContent = currentUser.name;
  syncBillingUi();
  syncAdminUi();
  loadPushConfig();
  document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); if (e.key === 'Escape') closeSearch(); });
  document.addEventListener('click', e => { const sr = document.getElementById('searchResults'); if (!sr.contains(e.target) && e.target !== document.getElementById('searchInput') && e.target !== document.getElementById('searchBtn')) { sr.classList.add('hidden'); } });
  await loadWatchlist();
}
async function refreshCurrentUser() {
  const res = await api('/api/auth/me', 'GET');
  if (!res.error && res.user) {
    currentUser = res.user;
    localStorage.setItem('bk_user', JSON.stringify(currentUser));
  }
}
async function loadWatchlist() {
  const res = await api('/api/watchlist', 'GET');
  if (res.error) { toast('Failed to load watchlist'); return; }
  watchlist = res.watchlist || [];
  render();
  loadDashboardRecommendations();
}
async function doSearch() {
  const q = document.getElementById('searchInput').value.trim(); if (!q) return;
  const btn = document.getElementById('searchBtn'); const resultsEl = document.getElementById('searchResults');
  btn.disabled = true; btn.textContent = 'Searching...'; resultsEl.classList.remove('hidden'); resultsEl.innerHTML = '<div class="search-msg">Searching...</div>';
  const res = await api(`/api/search?q=${encodeURIComponent(q)}`, 'GET');
  btn.disabled = false; btn.textContent = 'Search';
  if (res.error) { resultsEl.innerHTML = `<div class="search-msg error">${esc(res.error)}</div>`; return; }
  if (!res.results || res.results.length === 0) { resultsEl.innerHTML = '<div class="search-msg">No results found.</div>'; return; }
  searchResults = res.results.slice(0, 6);
  resultsEl.innerHTML = searchResults.map((s, i) => `<div class="result-item">${s.poster_path?`<img class="result-poster" src="https://image.tmdb.org/t/p/w92${s.poster_path}" alt="${esc(s.name)}" style="object-fit:cover">`:`<div class="result-poster">TV</div>`}<div class="result-info"><div class="result-name">${esc(s.name)}</div><div class="result-year">${s.first_air_date?s.first_air_date.slice(0,4):'Unknown'}</div>${renderProviders(s.providers)}${s.overview?`<div class="result-overview">${esc(s.overview)}</div>`:''}</div><button class="btn-add" onclick="openAdd(${i})">+ Add</button></div>`).join('');
}
function closeSearch() { document.getElementById('searchResults').classList.add('hidden'); document.getElementById('searchInput').value = ''; searchResults = []; }
function openAdd(index) {
  const show = searchResults[index];
  if (!show) { toast('Search again and choose a show.'); return; }
  openAddShow(show);
}
function openRecommendationAdd(source, index) {
  const collection = source === 'detail' ? detailRecommendations : dashboardRecommendations;
  const show = collection[index];
  if (!show) { toast('Recommendation not found.'); return; }
  openAddShow(show);
}
function openAddShow(show) {
  pendingAddShow = show;
  if (watchlist.find(w => w.show_id === show.id)) { toast('Already in your watchlist!'); return; }
  const service = suggestedService(show);
  document.getElementById('modalTitle').textContent = `Add "${show.name}"`;
  document.getElementById('modalBody').innerHTML = `<div class="form-group"><label>Status</label><select id="f-status">${STATUSES.map(s => `<option>${s}</option>`).join('')}</select></div><div class="form-group"><label>Streaming service</label><select id="f-service">${SERVICES.map(s => `<option${s===service?' selected':''}>${s}</option>`).join('')}</select>${show.providers?.length?`<div class="service-hint">Found on ${show.providers.map(esc).join(', ')}</div>`:''}</div><div class="form-row"><div class="form-group"><label>Season</label><input type="number" id="f-season" value="1" min="1" max="99"></div><div class="form-group"><label>Episode</label><input type="number" id="f-episode" value="1" min="1" max="999"></div></div><div class="form-group notify-row"><label for="f-notify-pref">Episode emails</label><select id="f-notify-pref">${notifyOptionsHtml('two_days')}</select></div><div class="modal-actions"><button class="btn-cancel" onclick="closeModal()">Cancel</button><button class="btn-save" onclick="confirmAdd()">Add to watchlist</button></div>`;
  openModal();
}
async function confirmAdd() {
  const show = pendingAddShow;
  if (!show) { toast('Search again and choose a show.'); closeModal(); return; }
  const notifyPref = document.getElementById('f-notify-pref').value;
  const body = { show_id:show.id, name:show.name, poster_path:show.poster_path||null, overview:show.overview||null, first_air_date:show.first_air_date||null, status:document.getElementById('f-status').value, service:document.getElementById('f-service').value, current_season:parseInt(document.getElementById('f-season').value)||1, current_episode:parseInt(document.getElementById('f-episode').value)||1, notify:notifyPref !== 'none', notify_pref:notifyPref };
  const res = await api('/api/watchlist', 'POST', body);
  if (res.error) { toast(res.error); if (res.error.includes('Upgrade')) document.getElementById('plusBanner').classList.remove('hidden'); return; }
  pendingAddShow = null; closeModal(); closeSearch(); await loadWatchlist(); activeTab = 'All'; render(); toast(`"${show.name}" added!`);
}
async function openShowDetail(index) {
  const s = watchlist[index];
  if (!s) { toast('Show not found.'); return; }
  detailRecommendations = [];
  document.getElementById('modalTitle').textContent = s.name;
  document.getElementById('modalBody').innerHTML = `<div class="show-detail">
    ${s.poster_path ? `<img class="show-detail-poster" src="https://image.tmdb.org/t/p/w185${s.poster_path}" alt="${esc(s.name)} poster">` : '<div class="show-detail-poster">TV</div>'}
    <div class="show-detail-copy">
      <div class="show-badges"><span class="badge ${STATUS_BADGE[s.status]||'b-watching'}">${esc(s.status)}</span><span class="badge b-service">${esc(s.service)}</span></div>
      <p>${s.overview ? esc(s.overview) : 'No description available yet.'}</p>
      <div class="show-progress">Season ${s.current_season || 1}, episode ${s.current_episode || 1}</div>
      ${s.next_episode_date ? `<div class="show-next">Next: S${s.next_season_number || '?'}E${s.next_episode_number || '?'} - ${formatAirDate(s.next_episode_date)}</div>` : ''}
      <div class="modal-actions detail-actions"><button class="btn-cancel" onclick="openEdit(${index})">Edit</button><button class="btn-cancel" onclick="closeModal()">Close</button></div>
    </div>
  </div>
  <section class="detail-recommendations">
    <div class="section-heading"><div><p class="eyebrow">Discover</p><h2>You May Also Like</h2></div></div>
    <div class="recommendation-grid compact" id="detailRecommendations"><div class="search-msg">Loading recommendations...</div></div>
  </section>`;
  openModal();
  await loadShowRecommendations(s.show_id);
}
function openEdit(idx) {
  const s = watchlist[idx];
  const notifyPref = normalizeNotifyPref(s.notify_pref, s.notify);
  document.getElementById('modalTitle').textContent = `Edit "${s.name}"`;
  document.getElementById('modalBody').innerHTML = `<div class="form-group"><label>Status</label><select id="f-status">${STATUSES.map(st => `<option${st===s.status?' selected':''}>${st}</option>`).join('')}</select></div><div class="form-group"><label>Streaming service</label><select id="f-service">${SERVICES.map(sv => `<option${sv===s.service?' selected':''}>${sv}</option>`).join('')}</select></div><div class="form-row"><div class="form-group"><label>Season</label><input type="number" id="f-season" value="${s.current_season || 1}" min="1" max="99"></div><div class="form-group"><label>Episode</label><input type="number" id="f-episode" value="${s.current_episode || 1}" min="1" max="999"></div></div><div class="form-group notify-row"><label for="f-notify-pref">Episode emails</label><select id="f-notify-pref">${notifyOptionsHtml(notifyPref)}</select></div><div class="modal-actions"><button class="btn-cancel" onclick="closeModal()">Cancel</button><button class="btn-save" onclick="confirmEdit(${s.show_id})">Save changes</button></div>`;
  openModal();
}
async function confirmEdit(showId) {
  const notifyPref = document.getElementById('f-notify-pref').value;
  const body = { status:document.getElementById('f-status').value, service:document.getElementById('f-service').value, current_season:parseInt(document.getElementById('f-season').value)||1, current_episode:parseInt(document.getElementById('f-episode').value)||1, notify:notifyPref !== 'none', notify_pref:notifyPref };
  const res = await api(`/api/watchlist/${showId}`, 'PUT', body);
  if (res.error) { toast(res.error); return; }
  closeModal(); await loadWatchlist(); toast('Changes saved!');
}
async function removeShow(index) {
  const show = watchlist[index];
  if (!show) { toast('Show not found.'); return; }
  if (!confirm(`Remove "${show.name}" from your watchlist?`)) return;
  const showId = show.show_id;
  const res = await api(`/api/watchlist/${showId}`, 'DELETE');
  if (res.error) { toast(res.error); return; } await loadWatchlist(); toast(`"${show.name}" removed.`);
}
async function quickProgress(index, season, episode, message) {
  const show = watchlist[index];
  if (!show) { toast('Show not found.'); return; }
  const pref = normalizeNotifyPref(show.notify_pref, show.notify);
  const body = { status:show.status || 'Watching', service:show.service || 'Other', current_season:season, current_episode:episode, notify:pref !== 'none', notify_pref:pref };
  const res = await api(`/api/watchlist/${show.show_id}`, 'PUT', body);
  if (res.error) { toast(res.error); return; }
  await loadWatchlist();
  toast(message);
}
function incrementEpisode(index) {
  const show = watchlist[index];
  if (!show) { toast('Show not found.'); return; }
  const episode = (parseInt(show.current_episode) || 1) + 1;
  quickProgress(index, parseInt(show.current_season) || 1, episode, `Moved "${show.name}" to episode ${episode}.`);
}
function nextSeason(index) {
  const show = watchlist[index];
  if (!show) { toast('Show not found.'); return; }
  const season = (parseInt(show.current_season) || 1) + 1;
  quickProgress(index, season, 1, `Moved "${show.name}" to season ${season}.`);
}
function render() {
  renderDashboard();
  const allTabs = ['All', ...STATUSES];
  document.getElementById('tabs').innerHTML = allTabs.map(t => { const cnt = t==='All'?watchlist.length:watchlist.filter(s => s.status===t).length; return `<button class="tab${activeTab===t?' active':''}" onclick="setTab('${t}')">${t}<span class="tab-count">${cnt}</span></button>`; }).join('');
  const list = activeTab==='All'?watchlist:watchlist.filter(s => s.status===activeTab);
  const grid = document.getElementById('watchlistGrid');
  if (!list.length) { grid.innerHTML = `<div class="empty-state"><span class="empty-icon">TV</span><h3>${watchlist.length===0?'Build your first watchlist':'Nothing here yet'}</h3><p>${watchlist.length===0?'Search for a show above, add where you watch it, and Bingekeeper will keep an eye on new episodes.':'Try another status tab or add a show to this category.'}</p><button class="btn-primary" onclick="document.getElementById('searchInput').focus()">Start searching</button></div>`; return; }
  grid.innerHTML = list.map((s,i) => { const idx=watchlist.indexOf(s); const hasUpcoming=s.next_episode_date&&s.next_episode_date>=todayString(); const nextLabel=s.next_episode_date?`S${s.next_season_number}E${s.next_episode_number} - ${formatAirDate(s.next_episode_date)}`:null; return `<div class="show-card">${s.poster_path?`<img class="show-poster clickable" src="https://image.tmdb.org/t/p/w185${s.poster_path}" alt="${esc(s.name)}" loading="lazy" onclick="openShowDetail(${idx})">`:`<div class="show-poster-ph clickable" onclick="openShowDetail(${idx})">TV</div>`}${hasUpcoming?`<div class="upcoming-badge">${daysUntilLabel(s.next_episode_date)}</div>`:''}<div class="show-body"><button class="show-title title-button" title="${esc(s.name)}" onclick="openShowDetail(${idx})">${esc(s.name)}</button><div class="show-badges"><span class="badge ${STATUS_BADGE[s.status]||'b-watching'}">${s.status}</span><span class="badge b-service">${esc(s.service)}</span></div><div class="show-progress">Season ${s.current_season || 1}, episode ${s.current_episode || 1}</div>${nextLabel?`<div class="show-next">${nextLabel}</div>`:''}<div class="show-actions"><button class="btn-sm" onclick="incrementEpisode(${idx})">+ Episode</button><button class="btn-sm" onclick="nextSeason(${idx})">Next season</button><button class="btn-sm" onclick="openEdit(${idx})">Edit</button><button class="btn-sm btn-sm-danger" onclick="removeShow(${idx})">Remove</button></div></div></div>`; }).join('');
}
function renderDashboard() {
  const watching = watchlist.filter(s => s.status === 'Watching').length;
  const upcoming = watchlist.filter(s => s.next_episode_date && s.next_episode_date >= todayString()).sort((a,b) => a.next_episode_date.localeCompare(b.next_episode_date));
  const isPlus = currentUser?.plan === 'plus';
  document.getElementById('plusBanner').classList.toggle('hidden', isPlus || watchlist.length < 8);
  document.getElementById('dashboardGreeting').textContent = watchlist.length ? `Welcome back, ${currentUser.name}` : 'Start your watchlist';
  document.getElementById('dashboardSubcopy').textContent = watchlist.length ? `${watching} ${plural(watching, 'show')} in progress. ${upcoming.length} upcoming ${plural(upcoming.length, 'episode')} on the radar.` : 'Add a few shows and this page becomes your personal release calendar.';
  document.getElementById('statsGrid').innerHTML = [
    ['Total', watchlist.length],
    ['Watching', watching],
    ['Upcoming', upcoming.length]
  ].map(([label, value]) => `<div class="stat-card"><span>${label}</span><strong>${value}</strong></div>`).join('');

  const section = document.getElementById('upcomingSection');
  const list = document.getElementById('upcomingList');
  if (!upcoming.length) { section.classList.add('hidden'); list.innerHTML = ''; return; }
  section.classList.remove('hidden');
  list.innerHTML = upcoming.slice(0, 4).map(s => `<div class="upcoming-item">${s.poster_path?`<img src="https://image.tmdb.org/t/p/w92${s.poster_path}" alt="${esc(s.name)}">`:`<div class="upcoming-poster">TV</div>`}<div><strong>${esc(s.name)}</strong><span>${daysUntilLabel(s.next_episode_date)} - S${s.next_season_number || '?'}E${s.next_episode_number || '?'}</span></div></div>`).join('');
}
async function loadDashboardRecommendations() {
  const loadToken = ++recommendationLoadToken;
  const section = document.getElementById('dashboardRecommendationsSection');
  const grid = document.getElementById('dashboardRecommendations');
  if (!watchlist.length) { dashboardRecommendations = []; dashboardRecommendationGroups = []; section.classList.add('hidden'); grid.innerHTML = ''; return; }
  const cacheKey = dashboardRecommendationCacheKey();
  const cachedGroups = readDashboardRecommendationCache(cacheKey);
  if (cachedGroups?.length) {
    dashboardRecommendationGroups = cachedGroups;
    dashboardRecommendations = cachedGroups.flatMap(group => group.recommendations);
    section.classList.remove('hidden');
    grid.innerHTML = renderRecommendationGroups(cachedGroups);
  } else {
    dashboardRecommendations = [];
    dashboardRecommendationGroups = [];
    section.classList.remove('hidden');
    grid.innerHTML = renderRecommendationSkeletonGroups(watchlist.slice(0, 3));
  }

  const res = await api('/api/recommendations/dashboard', 'GET');
  if (loadToken !== recommendationLoadToken) return;
  const groups = (res.groups || []).filter(group => group.recommendations?.length);
  if (res.error || !groups.length) {
    if (!cachedGroups?.length) { dashboardRecommendations = []; dashboardRecommendationGroups = []; section.classList.add('hidden'); grid.innerHTML = ''; }
    return;
  }
  dashboardRecommendationGroups = groups;
  dashboardRecommendations = groups.flatMap(group => group.recommendations);
  section.classList.remove('hidden');
  grid.innerHTML = renderRecommendationGroups(groups);
  writeDashboardRecommendationCache(cacheKey, groups);
}
async function loadShowRecommendations(showId) {
  const grid = document.getElementById('detailRecommendations');
  if (!grid) return;
  grid.innerHTML = renderRecommendationSkeletonCards(4);
  const res = await api(`/api/recommendations?show_id=${encodeURIComponent(showId)}`, 'GET');
  if (res.error || !res.recommendations?.length) {
    detailRecommendations = [];
    grid.innerHTML = '<div class="empty-state compact"><span class="empty-icon">TV</span><h3>No recommendations yet</h3><p>Try another show or check back later.</p></div>';
    return;
  }
  detailRecommendations = res.recommendations.slice(0, 8);
  grid.innerHTML = renderRecommendationCards(detailRecommendations, 'detail');
}
function dashboardRecommendationCacheKey() {
  const ids = watchlist.map(show => Number(show.show_id)).filter(Boolean).sort((a, b) => a - b).join('-');
  return `bk_dashboard_recommendations:${ids}`;
}
function readDashboardRecommendationCache(key) {
  try {
    const cached = JSON.parse(localStorage.getItem(key) || 'null');
    if (!cached?.groups || Date.now() - Number(cached.savedAt || 0) > 6 * 60 * 60 * 1000) return null;
    return cached.groups;
  } catch {
    return null;
  }
}
function writeDashboardRecommendationCache(key, groups) {
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), groups }));
  } catch {}
}
function renderRecommendationCards(items, source) {
  return items.map((show, index) => `<article class="recommendation-card">
    ${show.poster_path ? `<img src="https://image.tmdb.org/t/p/w185${show.poster_path}" alt="${esc(show.name)} poster" loading="lazy">` : '<div class="recommendation-poster">TV</div>'}
    <div class="recommendation-card-body">
      <h3>${esc(show.name)}</h3>
      ${show.source_show_name ? `<p>Because you track ${esc(show.source_show_name)}</p>` : '<p>Recommended from your watchlist</p>'}
      <button class="btn-add" onclick="openRecommendationAdd('${source}', ${index})">+ Add</button>
    </div>
  </article>`).join('');
}
function renderRecommendationGroups(groups) {
  let globalIndex = 0;
  return groups.map(group => {
    const cards = group.recommendations.map(show => {
      const index = globalIndex++;
      return `<article class="recommendation-card">
        ${show.poster_path ? `<img src="https://image.tmdb.org/t/p/w185${show.poster_path}" alt="${esc(show.name)} poster" loading="lazy">` : '<div class="recommendation-poster">TV</div>'}
        <div class="recommendation-card-body">
          <h3>${esc(show.name)}</h3>
          <p>Because you track ${esc(group.source_show_name || show.source_show_name || 'this show')}</p>
          <button class="btn-add" onclick="openRecommendationAdd('dashboard', ${index})">+ Add</button>
        </div>
      </article>`;
    }).join('');
    return `<section class="recommendation-group">
      <h3>Because you track ${esc(group.source_show_name || 'this show')}</h3>
      <div class="recommendation-row">${cards}</div>
    </section>`;
  }).join('');
}
function renderRecommendationSkeletonGroups(sourceShows) {
  return sourceShows.map(show => `<section class="recommendation-group">
    <h3>Because you track ${esc(show.name || 'this show')}</h3>
    <div class="recommendation-row">${renderRecommendationSkeletonCards(4)}</div>
  </section>`).join('');
}
function renderRecommendationSkeletonCards(count) {
  return Array.from({ length: count }, () => `<article class="recommendation-card recommendation-skeleton">
    <div class="recommendation-poster"></div>
    <div class="recommendation-card-body">
      <div class="skeleton-line wide"></div>
      <div class="skeleton-line"></div>
      <div class="skeleton-button"></div>
    </div>
  </article>`).join('');
}
function syncBillingUi() {
  const isPlus = currentUser?.plan === 'plus';
  document.getElementById('planBadge').textContent = isPlus ? 'Plus' : 'Free';
  document.getElementById('planBadge').classList.toggle('is-plus', isPlus);
  document.getElementById('billingBtn').textContent = isPlus ? 'Manage Plus' : 'Upgrade';
}
function syncAdminUi() {
  document.getElementById('adminSocialBtn').classList.toggle('hidden', !currentUser?.is_admin);
}
async function openBilling() {
  const path = currentUser?.plan === 'plus' ? '/api/billing/portal' : '/api/billing/checkout';
  const res = await api(path, 'POST');
  if (res.error) { toast(res.error); return; }
  if (res.url) window.location.href = res.url;
}
function openBillingFromPublic() {
  if (!token || !currentUser) { showAuth(); toast('Sign in to upgrade.'); return; }
  showApp().then(() => openBilling());
}
function showPublicPage(page) {
  const content = PUBLIC_PAGES[page] || PUBLIC_PAGES.plus;
  document.getElementById('authPage').classList.add('hidden');
  document.getElementById('appPage').classList.add('hidden');
  document.getElementById('adminSocialPage').classList.add('hidden');
  document.getElementById('publicPage').classList.remove('hidden');
  document.getElementById('publicContent').innerHTML = `<p class="eyebrow">${content.eyebrow}</p><h1>${content.title}</h1>${content.body}`;
  window.history.replaceState(null, '', `#${page}`);
}
async function openAdminSocial() {
  window.history.pushState(null, '', '/admin/social');
  await showAdminSocial();
}
async function showAdminSocial() {
  if (!token || !currentUser) {
    showAuth();
    toast('Sign in with an admin account.');
    return;
  }

  document.getElementById('authPage').classList.add('hidden');
  document.getElementById('publicPage').classList.add('hidden');
  document.getElementById('appPage').classList.add('hidden');
  document.getElementById('adminSocialPage').classList.remove('hidden');
  document.getElementById('adminSocialError').classList.add('hidden');
  document.getElementById('adminSocialStatus').classList.remove('hidden');
  document.getElementById('adminSocialStatus').textContent = 'Loading social content...';
  document.getElementById('weeklyRoundupBtn').disabled = true;

  await refreshCurrentUser();
  if (!currentUser?.is_admin) {
    document.getElementById('adminSocialPage').classList.add('hidden');
    showApp();
    toast('Admin access required.');
    return;
  }

  document.getElementById('adminHeaderName').textContent = currentUser.name;
  const res = await api('/api/admin/social', 'GET');
  if (res.error) {
    document.getElementById('adminSocialStatus').classList.add('hidden');
    showError(document.getElementById('adminSocialError'), res.error);
    if (res.error.includes('Admin')) setTimeout(() => showApp(), 1200);
    return;
  }

  adminSocialData = res.sections || {};
  renderAdminSocial();
  document.getElementById('adminSocialStatus').classList.add('hidden');
  document.getElementById('weeklyRoundupBtn').disabled = weeklyRoundupItems().length === 0;
}
function renderAdminSocial() {
  renderAdminSocialSection('adminTrendingWeek', adminSocialData.trending_this_week || [], 'trending_week');
  renderAdminSocialSection('adminNewSeasons', adminSocialData.new_seasons_today || [], 'season');
  renderAdminSocialSection('adminNewEpisodes', adminSocialData.new_episodes_today || [], 'episode');
  renderAdminSocialSection('adminPremiering', adminSocialData.premiering_this_week || [], 'upcoming');
  renderAdminSocialSection('adminTrending', adminSocialData.trending_tracked || [], 'trending');
}
function renderAdminSocialSection(id, items, type) {
  const el = document.getElementById(id);
  if (!items.length) {
    el.innerHTML = "<div class=\"empty-state compact\"><span class=\"empty-icon\">TV</span><h3>No items found</h3><p>Nothing in this category from today's popular TV release data.</p></div>";
    return;
  }
  el.innerHTML = items.map((item, index) => adminSocialCard(item, type, index)).join('');
}
function adminSocialCard(item, type, index) {
  const poster = item.poster_url ? `<img src="${esc(item.poster_url)}" alt="${esc(item.name)} poster" loading="lazy">` : '<div class="admin-social-poster">TV</div>';
  const meta = [
    item.season_number ? `Season ${item.season_number}` : '',
    item.episode_number ? `Episode ${item.episode_number}` : '',
    item.release_date ? formatAirDate(item.release_date) : '',
    item.services?.length ? item.services.join(', ') : '',
    item.tracked_count ? `${item.tracked_count} tracked` : '',
    item.vote_count ? `${Number(item.vote_count).toLocaleString()} votes` : '',
    item.is_major ? 'Major audience' : ''
  ].filter(Boolean);
  return `<article class="admin-social-card">
    ${poster}
    <div class="admin-social-card-body">
      <h3>${esc(item.name)}</h3>
      <div class="admin-social-meta">${meta.map(value => `<span>${esc(value)}</span>`).join('')}</div>
      <div class="admin-social-actions">
        <button class="btn-primary btn-full" onclick="copyFacebookPost('${type}', ${index})">Copy Facebook Post</button>
        <button class="btn-secondary btn-full" onclick="copyQuestionPost('${type}', ${index})">Copy Question Post</button>
      </div>
    </div>
  </article>`;
}
async function copyFacebookPost(type, index) {
  const item = adminSocialItem(type, index);
  if (!item) { toast('Post item not found.'); return; }
  await copyText(facebookPostText(item, type), 'Copied Facebook post.');
}
async function copyQuestionPost(type, index) {
  const item = adminSocialItem(type, index);
  if (!item) { toast('Post item not found.'); return; }
  await copyText(questionPostText(item, type), 'Copied question post.');
}
function adminSocialItem(type, index) {
  const collections = {
    trending_week: adminSocialData.trending_this_week || [],
    season: adminSocialData.new_seasons_today || [],
    episode: adminSocialData.new_episodes_today || [],
    upcoming: adminSocialData.premiering_this_week || [],
    trending: adminSocialData.trending_tracked || []
  };
  return collections[type]?.[index];
}
function facebookPostText(item, type) {
  if (type === 'episode') {
    return `📺 New Episode Alert\n\n${item.name}${item.season_number ? ` Season ${item.season_number}` : ''}${item.episode_number ? ` Episode ${item.episode_number}` : ''} is now available.\n\nAre you watching?\n\nTrack your favorite shows and never miss a new episode:\nhttps://bingekeeper.tv`;
  }
  if (type === 'upcoming') {
    return `📺 Coming Soon\n\n${item.name}${item.season_number ? ` Season ${item.season_number}` : ''} arrives ${item.release_date ? formatAirDate(item.release_date) : 'soon'}.\n\nAre you watching?\n\nTrack your favorite shows and never miss a new episode:\nhttps://bingekeeper.tv`;
  }
  return `📺 New Season Alert\n\n${item.name}${item.season_number ? ` Season ${item.season_number}` : ''} is now available.\n\nAre you watching?\n\nTrack your favorite shows and never miss a new episode:\nhttps://bingekeeper.tv`;
}
function questionPostText(item, type) {
  const service = item.services?.[0] ? ` on ${item.services[0]}` : '';
  const season = item.season_number ? ` Season ${item.season_number}` : '';
  if (type === 'upcoming') {
    return `${item.name}${season} arrives ${item.release_date ? formatAirDate(item.release_date) : 'soon'}${service}. Are you watching right away or waiting to binge the whole season?\n\nTrack your shows free:\nhttps://bingekeeper.tv`;
  }
  if (type === 'episode') {
    return `${item.name}${season}${item.episode_number ? ` Episode ${item.episode_number}` : ''} is now streaming${service}. Are you watching tonight or saving it for the weekend?\n\nTrack your shows free:\nhttps://bingekeeper.tv`;
  }
  return `${item.name}${season} is now streaming${service}. Are you watching immediately or waiting to binge the whole season?\n\nTrack your shows free:\nhttps://bingekeeper.tv`;
}
async function copyWeeklyRoundup() {
  const items = weeklyRoundupItems();
  if (!items.length) { toast('No weekly roundup items found.'); return; }
  const lines = items.slice(0, 6).map(item => `📺 ${item.name}${item.season_number ? ` Season ${item.season_number}` : ''}`);
  await copyText(`🍿 Coming This Week\n\nHere are some shows returning or premiering this week:\n\n${lines.join('\n')}\n\nWhich one are you watching?\n\nTrack your shows free:\nhttps://bingekeeper.tv`, 'Copied weekly roundup.');
}
function weeklyRoundupItems() {
  return [...(adminSocialData?.trending_this_week || []), ...(adminSocialData?.premiering_this_week || []), ...(adminSocialData?.new_seasons_today || []), ...(adminSocialData?.new_episodes_today || [])]
    .filter((item, index, items) => items.findIndex(other => other.show_id === item.show_id) === index);
}
async function copyText(text, message = 'Copied Facebook post.') {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    toast(message);
  }
}
function accountPushHtml() {
  if (!pushState.available) return '<div><span>Browser notifications</span><strong>Not supported on this browser</strong></div>';
  if (!pushConfig.supported) return '<div><span>Browser notifications</span><strong>Not configured yet</strong></div>';
  if (pushState.permission === 'denied') return '<div><span>Browser notifications</span><strong>Blocked in browser settings</strong></div>';
  return `<div><span>Browser notifications</span><strong>${pushState.enabled ? 'Enabled on this device' : 'Off on this device'}</strong></div>`;
}
function accountPushActionsHtml() {
  if (!pushState.available || !pushConfig.supported || pushState.permission === 'denied') return '';
  if (isIos() && !isStandaloneApp()) return '<button class="btn-cancel" onclick="installApp()">Install app for iOS notifications</button>';
  if (pushState.enabled) return '<button class="btn-cancel" onclick="sendTestPush()">Send test notification</button><button class="btn-cancel" onclick="disablePushNotifications().then(openAccount)">Disable notifications</button>';
  return '<button class="btn-save" onclick="enablePushNotifications().then(openAccount)">Enable notifications</button>';
}
function openAccount() {
  const isPlus = currentUser?.plan === 'plus';
  document.getElementById('modalTitle').textContent = 'Account';
  document.getElementById('modalBody').innerHTML = `<div class="account-panel"><div><span>Name</span><strong>${esc(currentUser.name)}</strong></div><div><span>Email</span><strong>${esc(currentUser.email)}</strong></div><div><span>Plan</span><strong>${isPlus ? 'Plus' : 'Free'}</strong></div>${accountPushHtml()}</div><div class="modal-actions stacked"><button class="btn-save" onclick="openBilling()">${isPlus ? 'Manage Plus' : 'Upgrade to Plus'}</button>${accountPushActionsHtml()}<button class="btn-cancel" onclick="closeModal()">Close</button><button class="btn-danger" onclick="deleteAccount()">Delete account</button></div>`;
  openModal();
}
async function deleteAccount() {
  const phrase = prompt('Type DELETE to permanently delete your Bingekeeper account.');
  if (phrase !== 'DELETE') return;
  const res = await api('/api/auth/account', 'DELETE');
  if (res.error) { toast(res.error); return; }
  doLogout();
  toast('Account deleted.');
}
function setTab(t) { activeTab = t; render(); }
function openModal() { document.getElementById('modal').classList.remove('hidden'); }
function closeModal() { document.getElementById('modal').classList.add('hidden'); pendingAddShow = null; }
document.addEventListener('click', e => { if (e.target===document.getElementById('modal')) closeModal(); });
function esc(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function renderProviders(providers = []) {
  if (!providers.length) return '<div class="provider-row"><span>Streaming service unknown</span></div>';
  return `<div class="provider-row">${providers.slice(0, 3).map(provider => `<span>${esc(provider)}</span>`).join('')}</div>`;
}
function suggestedService(show) {
  return (show.providers || []).find(provider => KNOWN_SERVICES.has(provider)) || 'Other';
}
function notifyOptionsHtml(selected) {
  return NOTIFY_OPTIONS.map(([value, label]) => `<option value="${value}"${value===selected?' selected':''}>${label}</option>`).join('');
}
function normalizeNotifyPref(pref, notify) {
  if (notify === false || notify === 0) return 'none';
  return NOTIFY_OPTIONS.some(([value]) => value === pref) ? pref : 'two_days';
}
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(window._toastTimer); window._toastTimer = setTimeout(() => t.classList.add('hidden'), 2800); }
function showError(el, msg) { el.textContent = msg; el.classList.remove('hidden'); }
function todayString() { return new Date().toISOString().slice(0,10); }
function plural(count, word) { return count === 1 ? word : `${word}s`; }
function formatAirDate(date) {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function daysUntilLabel(date) {
  const now = new Date(`${todayString()}T00:00:00`);
  const air = new Date(`${date}T00:00:00`);
  const days = Math.round((air - now) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `${days} days`;
}
function togglePassword(inputId, btn) {
  const input = document.getElementById(inputId);
  const isHidden = input.type === 'password';
  input.type = isHidden ? 'text' : 'password';
  btn.textContent = isHidden ? 'Hide' : 'Show';
}
async function api(path, method='GET', body=null) {
  try {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(API + path, opts);
    if (res.status===401 && path!=='/api/auth/login') { doLogout(); return { error: 'Session expired' }; }
    return await res.json();
  } catch (e) { return { error: 'Network error. Please try again.' }; }
}
