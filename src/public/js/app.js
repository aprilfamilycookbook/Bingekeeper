const API = '';
const SERVICES = ['Netflix','Max','Hulu','Disney+','Apple TV+','Peacock','Paramount+','Amazon Prime','Other'];
const STATUSES = ['Watching','Plan to Watch','Completed','On Hold','Dropped'];
const STATUS_BADGE = { 'Watching':'b-watching','Plan to Watch':'b-plan','Completed':'b-completed','On Hold':'b-hold','Dropped':'b-dropped' };
const PUBLIC_PAGES = {
  plus: {
    title: 'Bingekeeper Plus',
    eyebrow: 'Pricing',
    body: `<p>Track the shows you care about, remember where you watch them, and get a clean view of upcoming episodes.</p><div class="pricing-grid"><div><h3>Free</h3><strong>$0</strong><p>Track up to 20 shows, including status, streaming service, season, episode, and upcoming episode details.</p></div><div class="featured"><h3>Plus</h3><strong>Monthly</strong><p>Unlimited show tracking and self-service billing through Stripe. The final price is shown securely at checkout.</p><button class="btn-primary" onclick="openBillingFromPublic()">Upgrade to Plus</button></div></div>`
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
    body: `<p>Bingekeeper is provided as a show-tracking tool. You are responsible for keeping your login information secure and for using the service lawfully.</p><p>Plus subscriptions are billed through Stripe and can be managed from the app. Free accounts may be limited to 20 tracked shows.</p><p>Bingekeeper depends on third-party services for payments, email, hosting, and show metadata. The service may change as those services or the product evolve.</p>`
  }
};

let token = localStorage.getItem('bk_token');
let currentUser = JSON.parse(localStorage.getItem('bk_user') || 'null');
let watchlist = [];
let activeTab = 'All';
window.addEventListener('DOMContentLoaded', () => {
  const route = getAuthRoute();
  const billingResult = window.location.hash;
  if (billingResult === '#billing=cancelled') toast('Upgrade cancelled.');
  if (route.name === 'verify' && route.token) { showVerify(route.token);
  } else if (route.name === 'reset' && route.token) { showReset(route.token);
  } else if (PUBLIC_PAGES[billingResult.slice(1)]) { showPublicPage(billingResult.slice(1));
  } else if (token && currentUser) { showApp(billingResult === '#billing=success');
  } else { showAuth(); }
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
function showAuth() {
  document.getElementById('authPage').classList.remove('hidden');
  document.getElementById('appPage').classList.add('hidden');
  document.getElementById('publicPage').classList.add('hidden');
  showLogin();
}
function showLogin() { hideAllAuthForms(); document.getElementById('loginForm').classList.remove('hidden'); }
function showRegister() { hideAllAuthForms(); document.getElementById('registerForm').classList.remove('hidden'); }
function showForgot() { hideAllAuthForms(); document.getElementById('forgotForm').classList.remove('hidden'); }
function showReset(t) { hideAllAuthForms(); document.getElementById('authPage').classList.remove('hidden'); document.getElementById('resetForm').classList.remove('hidden'); document.getElementById('resetForm').dataset.token = t; }
function showVerify(t) { document.getElementById('authPage').classList.remove('hidden'); hideAllAuthForms(); document.getElementById('verifyForm').classList.remove('hidden'); verifyEmail(t); }
function hideAllAuthForms() { ['loginForm','registerForm','forgotForm','resetForm','verifyForm'].forEach(id => { document.getElementById(id).classList.add('hidden'); }); }
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
  const btn = event.target; btn.disabled = true; btn.textContent = 'Creating account...';
  const res = await api('/api/auth/register', 'POST', { name, email, password });
  btn.disabled = false; btn.textContent = 'Create account';
  if (res.error) { showError(errEl, res.error); return; }
  successEl.textContent = res.message; successEl.classList.remove('hidden');
}
async function doForgot() {
  const email = document.getElementById('forgotEmail').value.trim();
  const errEl = document.getElementById('forgotError'); const successEl = document.getElementById('forgotSuccess');
  errEl.classList.add('hidden'); successEl.classList.add('hidden');
  if (!email) { showError(errEl, 'Please enter your email'); return; }
  const res = await api('/api/auth/forgot', 'POST', { email });
  if (res.error) { showError(errEl, res.error); return; }
  successEl.textContent = res.message; successEl.classList.remove('hidden');
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
function doLogout() { token = null; currentUser = null; localStorage.removeItem('bk_token'); localStorage.removeItem('bk_user'); watchlist = []; showAuth(); }
async function showApp(fromBilling = false) {
  document.getElementById('authPage').classList.add('hidden'); document.getElementById('publicPage').classList.add('hidden'); document.getElementById('appPage').classList.remove('hidden');
  await refreshCurrentUser();
  if (fromBilling) toast(currentUser?.plan === 'plus' ? 'Welcome to Plus!' : 'Plus is processing. Your account will update shortly.');
  if (fromBilling) window.history.replaceState(null, '', '/');
  document.getElementById('headerName').textContent = currentUser.name;
  syncBillingUi();
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
async function loadWatchlist() { const res = await api('/api/watchlist', 'GET'); if (res.error) { toast('Failed to load watchlist'); return; } watchlist = res.watchlist || []; render(); }
async function doSearch() {
  const q = document.getElementById('searchInput').value.trim(); if (!q) return;
  const btn = document.getElementById('searchBtn'); const resultsEl = document.getElementById('searchResults');
  btn.disabled = true; btn.textContent = 'Searching...'; resultsEl.classList.remove('hidden'); resultsEl.innerHTML = '<div class="search-msg">Searching...</div>';
  const res = await api(`/api/search?q=${encodeURIComponent(q)}`, 'GET');
  btn.disabled = false; btn.textContent = 'Search';
  if (res.error) { resultsEl.innerHTML = `<div class="search-msg error">${esc(res.error)}</div>`; return; }
  if (!res.results || res.results.length === 0) { resultsEl.innerHTML = '<div class="search-msg">No results found.</div>'; return; }
  resultsEl.innerHTML = res.results.slice(0,6).map(s => `<div class="result-item">${s.poster_path?`<img class="result-poster" src="https://image.tmdb.org/t/p/w92${s.poster_path}" alt="${esc(s.name)}" style="object-fit:cover">`:`<div class="result-poster">TV</div>`}<div class="result-info"><div class="result-name">${esc(s.name)}</div><div class="result-year">${s.first_air_date?s.first_air_date.slice(0,4):'Unknown'}</div>${s.overview?`<div class="result-overview">${esc(s.overview)}</div>`:''}</div><button class="btn-add" onclick='openAdd(${JSON.stringify(s)})'>+ Add</button></div>`).join('');
}
function closeSearch() { document.getElementById('searchResults').classList.add('hidden'); document.getElementById('searchInput').value = ''; }
function openAdd(show) {
  if (watchlist.find(w => w.show_id === show.id)) { toast('Already in your watchlist!'); return; }
  document.getElementById('modalTitle').textContent = `Add "${show.name}"`;
  document.getElementById('modalBody').innerHTML = `<div class="form-group"><label>Status</label><select id="f-status">${STATUSES.map(s => `<option>${s}</option>`).join('')}</select></div><div class="form-group"><label>Streaming service</label><select id="f-service">${SERVICES.map(s => `<option>${s}</option>`).join('')}</select></div><div class="form-row"><div class="form-group"><label>Season</label><input type="number" id="f-season" value="1" min="1" max="99"></div><div class="form-group"><label>Episode</label><input type="number" id="f-episode" value="1" min="1" max="999"></div></div><div class="notify-row"><input type="checkbox" id="f-notify" checked><label for="f-notify">Email me when new episodes drop</label></div><div class="modal-actions"><button class="btn-cancel" onclick="closeModal()">Cancel</button><button class="btn-save" onclick='confirmAdd(${JSON.stringify(show)})'>Add to watchlist</button></div>`;
  openModal();
}
async function confirmAdd(show) {
  const body = { show_id:show.id, name:show.name, poster_path:show.poster_path||null, overview:show.overview||null, first_air_date:show.first_air_date||null, status:document.getElementById('f-status').value, service:document.getElementById('f-service').value, current_season:parseInt(document.getElementById('f-season').value)||1, current_episode:parseInt(document.getElementById('f-episode').value)||1, notify:document.getElementById('f-notify').checked };
  const res = await api('/api/watchlist', 'POST', body);
  if (res.error) { toast(res.error); if (res.error.includes('Upgrade')) document.getElementById('plusBanner').classList.remove('hidden'); return; }
  closeModal(); closeSearch(); await loadWatchlist(); activeTab = 'All'; render(); toast(`"${show.name}" added!`);
}
function openEdit(idx) {
  const s = watchlist[idx];
  document.getElementById('modalTitle').textContent = `Edit "${s.name}"`;
  document.getElementById('modalBody').innerHTML = `<div class="form-group"><label>Status</label><select id="f-status">${STATUSES.map(st => `<option${st===s.status?' selected':''}>${st}</option>`).join('')}</select></div><div class="form-group"><label>Streaming service</label><select id="f-service">${SERVICES.map(sv => `<option${sv===s.service?' selected':''}>${sv}</option>`).join('')}</select></div><div class="form-row"><div class="form-group"><label>Season</label><input type="number" id="f-season" value="${s.current_season}" min="1" max="99"></div><div class="form-group"><label>Episode</label><input type="number" id="f-episode" value="${s.current_episode}" min="1" max="999"></div></div><div class="notify-row"><input type="checkbox" id="f-notify" ${s.notify?'checked':''}><label for="f-notify">Email me when new episodes drop</label></div><div class="modal-actions"><button class="btn-cancel" onclick="closeModal()">Cancel</button><button class="btn-save" onclick="confirmEdit(${s.show_id})">Save changes</button></div>`;
  openModal();
}
async function confirmEdit(showId) {
  const body = { status:document.getElementById('f-status').value, service:document.getElementById('f-service').value, current_season:parseInt(document.getElementById('f-season').value)||1, current_episode:parseInt(document.getElementById('f-episode').value)||1, notify:document.getElementById('f-notify').checked };
  const res = await api(`/api/watchlist/${showId}`, 'PUT', body);
  if (res.error) { toast(res.error); return; }
  closeModal(); await loadWatchlist(); toast('Changes saved!');
}
async function removeShow(showId, name) {
  if (!confirm(`Remove "${name}" from your watchlist?`)) return;
  const res = await api(`/api/watchlist/${showId}`, 'DELETE');
  if (res.error) { toast(res.error); return; } await loadWatchlist(); toast(`"${name}" removed.`);
}
function render() {
  renderDashboard();
  const allTabs = ['All', ...STATUSES];
  document.getElementById('tabs').innerHTML = allTabs.map(t => { const cnt = t==='All'?watchlist.length:watchlist.filter(s => s.status===t).length; return `<button class="tab${activeTab===t?' active':''}" onclick="setTab('${t}')">${t}<span class="tab-count">${cnt}</span></button>`; }).join('');
  const list = activeTab==='All'?watchlist:watchlist.filter(s => s.status===activeTab);
  const grid = document.getElementById('watchlistGrid');
  if (!list.length) { grid.innerHTML = `<div class="empty-state"><span class="empty-icon">TV</span><h3>${watchlist.length===0?'Build your first watchlist':'Nothing here yet'}</h3><p>${watchlist.length===0?'Search for a show above, add where you watch it, and Bingekeeper will keep an eye on new episodes.':'Try another status tab or add a show to this category.'}</p><button class="btn-primary" onclick="document.getElementById('searchInput').focus()">Start searching</button></div>`; return; }
  grid.innerHTML = list.map((s,i) => { const idx=watchlist.indexOf(s); const hasUpcoming=s.next_episode_date&&s.next_episode_date>=todayString(); const nextLabel=s.next_episode_date?`S${s.next_season_number}E${s.next_episode_number} - ${formatAirDate(s.next_episode_date)}`:null; return `<div class="show-card">${s.poster_path?`<img class="show-poster" src="https://image.tmdb.org/t/p/w185${s.poster_path}" alt="${esc(s.name)}" loading="lazy">`:`<div class="show-poster-ph">TV</div>`}${hasUpcoming?`<div class="upcoming-badge">${daysUntilLabel(s.next_episode_date)}</div>`:''}<div class="show-body"><div class="show-title" title="${esc(s.name)}">${esc(s.name)}</div><div class="show-badges"><span class="badge ${STATUS_BADGE[s.status]||'b-watching'}">${s.status}</span><span class="badge b-service">${esc(s.service)}</span></div><div class="show-progress">Season ${s.current_season || 1}, episode ${s.current_episode || 1}</div>${nextLabel?`<div class="show-next">${nextLabel}</div>`:''}<div class="show-actions"><button class="btn-sm" onclick="openEdit(${idx})">Edit</button><button class="btn-sm btn-sm-danger" onclick="removeShow(${s.show_id},'${esc(s.name)}')">Remove</button></div></div></div>`; }).join('');
}
function renderDashboard() {
  const watching = watchlist.filter(s => s.status === 'Watching').length;
  const upcoming = watchlist.filter(s => s.next_episode_date && s.next_episode_date >= todayString()).sort((a,b) => a.next_episode_date.localeCompare(b.next_episode_date));
  const isPlus = currentUser?.plan === 'plus';
  document.getElementById('plusBanner').classList.toggle('hidden', isPlus || watchlist.length < 16);
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
function syncBillingUi() {
  const isPlus = currentUser?.plan === 'plus';
  document.getElementById('planBadge').textContent = isPlus ? 'Plus' : 'Free';
  document.getElementById('planBadge').classList.toggle('is-plus', isPlus);
  document.getElementById('billingBtn').textContent = isPlus ? 'Manage Plus' : 'Upgrade';
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
  document.getElementById('publicPage').classList.remove('hidden');
  document.getElementById('publicContent').innerHTML = `<p class="eyebrow">${content.eyebrow}</p><h1>${content.title}</h1>${content.body}`;
  window.history.replaceState(null, '', `#${page}`);
}
function openAccount() {
  const isPlus = currentUser?.plan === 'plus';
  document.getElementById('modalTitle').textContent = 'Account';
  document.getElementById('modalBody').innerHTML = `<div class="account-panel"><div><span>Name</span><strong>${esc(currentUser.name)}</strong></div><div><span>Email</span><strong>${esc(currentUser.email)}</strong></div><div><span>Plan</span><strong>${isPlus ? 'Plus' : 'Free'}</strong></div></div><div class="modal-actions stacked"><button class="btn-save" onclick="openBilling()">${isPlus ? 'Manage Plus' : 'Upgrade to Plus'}</button><button class="btn-cancel" onclick="closeModal()">Close</button><button class="btn-danger" onclick="deleteAccount()">Delete account</button></div>`;
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
function closeModal() { document.getElementById('modal').classList.add('hidden'); }
document.addEventListener('click', e => { if (e.target===document.getElementById('modal')) closeModal(); });
function esc(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
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
