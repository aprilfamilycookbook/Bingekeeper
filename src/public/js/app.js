const API = '';
const SERVICES = ['Netflix','Max','Hulu','Disney+','Apple TV+','Peacock','Paramount+','Amazon Prime','Other'];
const STATUSES = ['Watching','Plan to Watch','Completed','On Hold','Dropped'];
const STATUS_BADGE = { 'Watching':'b-watching','Plan to Watch':'b-plan','Completed':'b-completed','On Hold':'b-hold','Dropped':'b-dropped' };

let token = localStorage.getItem('bk_token');
let currentUser = JSON.parse(localStorage.getItem('bk_user') || 'null');
let watchlist = [];
let activeTab = 'All';
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('token') && window.location.pathname === '/verify') { showVerify(params.get('token'));
  } else if (params.get('token') && window.location.pathname === '/reset') { showReset(params.get('token'));
  } else if (token && currentUser) { showApp();
  } else { showAuth(); }
});
function showAuth() { document.getElementById('authPage').classList.remove('hidden'); document.getElementById('appPage').classList.add('hidden'); showLogin(); }
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
  const errEl = document.getElementById('regError'); const successEl = document.getElementById('regSuccess');
  errEl.classList.add('hidden'); successEl.classList.add('hidden');
  if (!name || !email || !password) { showError(errEl, 'Please fill in all fields'); return; }
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
async function showApp() {
  document.getElementById('authPage').classList.add('hidden'); document.getElementById('appPage').classList.remove('hidden');
  document.getElementById('headerName').textContent = currentUser.name;
  document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); if (e.key === 'Escape') closeSearch(); });
  document.addEventListener('click', e => { const sr = document.getElementById('searchResults'); if (!sr.contains(e.target) && e.target !== document.getElementById('searchInput') && e.target !== document.getElementById('searchBtn')) { sr.classList.add('hidden'); } });
  await loadWatchlist();
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
  resultsEl.innerHTML = res.results.slice(0,6).map(s => `<div class="result-item">${s.poster_path?`<img class="result-poster" src="https://image.tmdb.org/t/p/w92${s.poster_path}" alt="${esc(s.name)}" style="object-fit:cover">`:`<div class="result-poster">📺</div>`}<div class="result-info"><div class="result-name">${esc(s.name)}</div><div class="result-year">${s.first_air_date?s.first_air_date.slice(0,4):'Unknown'}</div>${s.overview?`<div class="result-overview">${esc(s.overview)}</div>`:''}</div><button class="btn-add" onclick='openAdd(${JSON.stringify(s)})'>+ Add</button></div>`).join('');
}
function closeSearch() { document.getElementById('searchResults').classList.add('hidden'); document.getElementById('searchInput').value = ''; }
function openAdd(show) {
  if (watchlist.find(w => w.show_id === show.id)) { toast('Already in your watchlist!'); return; }
  document.getElementById('modalTitle').textContent = `Add "${show.name}"`;
  document.getElementById('modalBody').innerHTML = `<div class="form-group"><label>Status</label><select id="f-status">${STATUSES.map(s => `<option>${s}</option>`).join('')}</select></div><div class="form-group"><label>Streaming service</label><select id="f-service">${SERVICES.map(s => `<option>${s}</option>`).join('')}</select></div><div class="form-row"><div class="form-group"><label>Season</label><input type="number" id="f-season" value="1" min="1" max="99"></div><div class="form-group"><label>Episode</label><input type="number" id="f-episode" value="1" min="1" max="999"></div></div><div class="notify-row"><input type="checkbox" id="f-notify" checked><label for="f-notify">📧 Email me when new episodes drop</label></div><div class="modal-actions"><button class="btn-cancel" onclick="closeModal()">Cancel</button><button class="btn-save" onclick='confirmAdd(${JSON.stringify(show)})'>Add to watchlist</button></div>`;
  openModal();
}
async function confirmAdd(show) {
  const body = { show_id:show.id, name:show.name, poster_path:show.poster_path||null, overview:show.overview||null, first_air_date:show.first_air_date||null, status:document.getElementById('f-status').value, service:document.getElementById('f-service').value, current_season:parseInt(document.getElementById('f-season').value)||1, current_episode:parseInt(document.getElementById('f-episode').value)||1, notify:document.getElementById('f-notify').checked };
  const res = await api('/api/watchlist', 'POST', body);
  if (res.error) { toast(res.error); return; }
  closeModal(); closeSearch(); await loadWatchlist(); activeTab = 'All'; render(); toast(`"${show.name}" added!`);
}
function openEdit(idx) {
  const s = watchlist[idx];
  document.getElementById('modalTitle').textContent = `Edit "${s.name}"`;
  document.getElementById('modalBody').innerHTML = `<div class="form-group"><label>Status</label><select id="f-status">${STATUSES.map(st => `<option${st===s.status?' selected':''}>${st}</option>`).join('')}</select></div><div class="form-group"><label>Streaming service</label><select id="f-service">${SERVICES.map(sv => `<option${sv===s.service?' selected':''}>${sv}</option>`).join('')}</select></div><div class="form-row"><div class="form-group"><label>Season</label><input type="number" id="f-season" value="${s.current_season}" min="1" max="99"></div><div class="form-group"><label>Episode</label><input type="number" id="f-episode" value="${s.current_episode}" min="1" max="999"></div></div><div class="notify-row"><input type="checkbox" id="f-notify" ${s.notify?'checked':''}><label for="f-notify">📧 Email me when new episodes drop</label></div><div class="modal-actions"><button class="btn-cancel" onclick="closeModal()">Cancel</button><button class="btn-save" onclick="confirmEdit(${s.show_id})">Save changes</button></div>`;
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
  const allTabs = ['All', ...STATUSES];
  document.getElementById('tabs').innerHTML = allTabs.map(t => { const cnt = t==='All'?watchlist.length:watchlist.filter(s => s.status===t).length; return `<button class="tab${activeTab===t?' active':''}" onclick="setTab('${t}')">${t}<span class="tab-count">${cnt}</span></button>`; }).join('');
  const list = activeTab==='All'?watchlist:watchlist.filter(s => s.status===activeTab);
  const grid = document.getElementById('watchlistGrid');
  if (!list.length) { grid.innerHTML = `<div class="empty-state"><span class="empty-icon">📺</pan><h3>${watchlist.length===0?'Your watchlist is empty':'Nothing here yet'}</h3><p>${watchlist.length===0?'Search for a show above to get started!':'Add some shows to this category.'}</p></div>`; return; }
  grid.innerHTML = list.map((s,i) => { const idx=watchlist.indexOf(s); const hasUpcoming=s.next_episode_date&&s.next_episode_date>=new Date().toISOString().slice(0,10); const nextLabel=s.next_episode_date?`S${s.next_season_number}E${s.next_episode_number} · ${s.next_episode_date}`:null; return `<div class="show-card">${s.poster_path?`<img class="show-poster" src="https://image.tmdb.org/t/p/w185${s.poster_path}" alt="${esc(s.name)}" loading="lazy">`:`<div class="show-poster-ph">📺</div>`}${hasUpcoming?`<div class="upcoming-badge">New Soon</div>`:''}<div class="show-body"><div class="show-title" title="${esc(s.name)}">${esc(s.name)}</div><div class="show-badges"><span class="badge ${STATUS_BADGE[s.status]||'b-watching'}">${s.status}</span><span class="badge b-service">${esc(s.service)}</span></div><div class="show-progress">S${s.current_season} · E${s.current_episode}</div>${nextLabel?`<div class="show-next">📅 ${nextLabel}</div>`:''}<div class="show-actions"><button class="btn-sm" onclick="openEdit(${idx})">✏ Edit</button><button class="btn-sm btn-sm-danger" onclick="removeShow(${s.show_id},'${esc(s.name)}')">🗑</button></div></div></div>`; }).join('');
}
function setTab(t) { activeTab = t; render(); }
function openModal() { document.getElementById('modal').classList.remove('hidden'); }
function closeModal() { document.getElementById('modal').classList.add('hidden'); }
document.addEventListener('click', e => { if (e.target===document.getElementById('modal')) closeModal(); });
function esc(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(window._toastTimer); window._toastTimer = setTimeout(() => t.classList.add('hidden'), 2800); }
function showError(el, msg) { el.textContent = msg; el.classList.remove('hidden'); }
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
