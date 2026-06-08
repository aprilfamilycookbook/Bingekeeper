const SERVICES = ['Netflix','Max','Hulu','Disney+','Apple TV+','Peacock','Paramount+','Amazon Prime','Other'];
const STATUSES = ['Watching','Plan to Watch','Completed','On Hold','Dropped'];
const STATUS_BADGE = {
  'Watching': 'badge-watching',
  'Plan to Watch': 'badge-plan',
  'Completed': 'badge-completed',
  'On Hold': 'badge-hold',
  'Dropped': 'badge-dropped'
};

let watchlist = JSON.parse(localStorage.getItem('bk_watchlist') || '[]');
let activeTab = 'All';
let pending = null;

function save() {
  localStorage.setItem('bk_watchlist', JSON.stringify(watchlist));
}

function esc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => t.classList.add('hidden'), 2500);
}

const savedTheme = localStorage.getItem('bk_theme') || 'light';
document.documentElement.setAttribute('data-theme', savedTheme);

document.getElementById('themeToggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('bk_theme', next);
});

document.getElementById('searchBtn').addEventListener('click', doSearch);
document.getElementById('searchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') doSearch();
  if (e.key === 'Escape') closeSearch();
});

async function doSearch() {
  const q = document.getElementById('searchInput').value.trim();
  if (!q) return;
  const btn = document.getElementById('searchBtn');
  const resultsEl = document.getElementById('searchResults');
  btn.disabled = true;
  btn.textContent = 'Searching...';
  resultsEl.classList.remove('hidden');
  resultsEl.innerHTML = '<div class="search-msg">Searching...</div>';
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (data.error) { resultsEl.innerHTML = `<div class="search-msg error">${esc(data.error)}</div>`; return; }
    if (!data.results || data.results.length === 0) { resultsEl.innerHTML = '<div class="search-msg">No results found.</div>'; return; }
    resultsEl.innerHTML = data.results.slice(0,6).map(s => `
      <div class="result-item">
        ${s.poster_path ? `<img class="result-poster" src="https://image.tmdb.org/t/p/w92${s.poster_path}" alt="${esc(s.name)}" loading="lazy">` : `<div class="result-poster-ph">📺</div>`}
        <div class="result-info"><div class="result-name">${esc(s.name)}</div><div class="result-meta">${(s.first_air_date || '').slice(0,4) || 'Unknown'}</div></div>
        <button class="btn-add" onclick="openAdd(${s.id},${JSON.stringify(esc(s.name))},${JSON.stringify(s.poster_path || '')},${JSON.stringify((s.first_air_date || '').slice(0,0))})">+ Add</button>
      </div>`).join('');
  } catch(err) { resultsEl.innerHTML = '<div class="search-msg error">Search failed.</div>'; }
  finally { btn.disabled = false; btn.textContent = 'Search'; }
}

function closeSearch() {
  document.getElementById('searchResults').classList.add('hidden');
  document.getElementById('searchInput').value = '';
}

document.addEventListener('click', e => {
  const sr = document.getElementById('searchResults');
  if (!sr.contains(e.target) && e.target !== document.getElementById('searchInput') && e.target !== document.getElementById('searchBtn')) sr.classList.add('hidden');
});

function openAdd(id, name, poster, year) {
  pending = { id, name, poster, year };
  document.getElementById('modalTitle').textContent = `Add "${name}"`;
  document.getElementById('modalBody').innerHTML = `
    <div class="form-group"><label>Status</label><select id="f-status">${STATUSES.map(s => `<option>${s}</option>`).join('')}</select></div>
    <div class="form-group"><label>Streaming service</label><select id="f-service">${SERVICES.map(s => `<option>${s}</option>`).join('')}</select></div>
    <div class="form-row"><div class="form-group"><label>Season</label><input type="number" id="f-season" value="1" min="1" max="99"></div><div class="form-group"><label>Episode</label><input type="number" id="f-episode" value="1" min="1" max="999"></div></div>
    <div class="modal-actions"><button class="btn-cancel" onclick="closeModal()">Cancel</button><button class="btn-save" onclick="confirmAdd()">Add to watchlist</button></div>`;
  openModal();
}

function confirmAdd() {
  if (!pending) return;
  if (watchlist.find(w => w.id === pending.id)) { closeModal(); toast('Already in your watchlist!'); return; }
  watchlist.unshift({ id:pending.id, name:pending.name, poster:pending.poster, year:pending.year, status:document.getElementById('f-status').value, service:document.getElementById('f-service').value, season:parseInt(document.getElementById('f-season').value)||1, episode:parseInt(document.getElementById('f-episode').value)||1, added:Date.now() });
  save(); closeModal(); closeSearch(); activeTab = 'All'; render(); toast(`"${pending.name}" added!`); pending = null;
}

function openEdit(idx) {
  const s = watchlist[idx];
  document.getElementById('modalTitle').textContent = `Edit "${s.name}"`;
  document.getElementById('modalBody').innerHTML = `
    <div class="form-group"><label>Status</label><select id="f-status">${STATUSES.map(st => `<option${st===s.status?' selected':''}>${st}</option>`).join('')}</select></div>
    <div class="form-group"><label>Streaming service</label><select id="f-service">${SERVICES.map(sv => `<option${sv===s.service?' selected':''}>${sv}</option>`).join('')}</select></div>
    <div class="form-row"><div class="form-group"><label>Season</label><input type="number" id="f-season" value="${s.season}" min="1" max="99"></div><div class="form-group"><label>Episode</label><input type="number" id="f-episode" value="${s.episode}" min="1" max="999"></div></div>
    <div class="modal-actions"><button class="btn-cancel" onclick="closeModal()">Cancel</button><button class="btn-save" onclick="confirmEdit(${idx})">Save changes</button></div>`;
  openModal();
}

function confirmEdit(idx) {
  watchlist[idx].status = document.getElementById('f-status').value;
  watchlist[idx].service = document.getElementById('f-service').value;
  watchlist[idx].season = parseInt(document.getElementById('f-season').value)||1;
  watchlist[idx].episode = parseInt(document.getElementById('f-episode').value)||1;
  save(); closeModal(); render(); toast('Changes saved!');
}

function removeShow(idx) {
  const name = watchlist[idx].name;
  if (!confirm(`Remove "${name}"?`)) return;
  watchlist.splice(idx,1); save(); render(); toast(`"${name}" removed.`);
}

function openModal() { document.getElementById('modal').classList.remove('hidden'); }
function closeModal() { document.getElementById('modal').classList.add('hidden'); pending = null; }

document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modal').addEventListener('click', e => { if (e.target === document.getElementById('modal')) closeModal(); });

function render() {
  const allTabs = ['All', ...STATUSES];
  document.getElementById('tabs').innerHTML = allTabs.map(t => {
    const cnt = t === 'All' ? watchlist.length : watchlist.filter(s => s.status === t).length;
    return `<button class="tab${activeTab === t ? ' active' : ''}" onclick="setTab('${t}')">${t}<span class="tab-count">${cnt}</span></button>`;
  }).join('');
  const list = activeTab === 'All' ? watchlist : watchlist.filter(s => s.status === activeTab);
  const grid = document.getElementById('showsGrid');
  document.getElementById('showCount').textContent = watchlist.length > 0 ? `${watchlist.length} show${watchlist.length !== 1 ? 's' : ''}` : '';
  if (!list.length) {
    grid.innerHTML = `<div class="empty-state"><span class="empty-icon">📺</span><h3>${watchlist.length===0 ? 'Your watchlist is empty' : 'No shows here yet'}</h3><p>${watchlist.length===0 ? 'Search for a show above to get started!' : 'Add some shows to this category.' </p></div>`;
    return;
  }
  grid.innerHTML = list.map(s => {
    const idx = watchlist.indexOf(s);
    return `<div class="show-card">${s.poster?`<img class="show-poster" src="https://image.tmdb.org/t/p/w185${s.poster}" alt="${esc(s.name)}" loading="lazy">`:`<div class="show-poster-ph">📺</div>`}<div class="show-body"><div class="show-title" title="${esc(s.name)}">${esc(s.name)}</div><div class="show-badges"><span class="badge ${STATUS_BADGE[s.status]||'badge-watching'}">${s.status}</span><span class="badge badge-service">${esc(s.service)}</span></div><div class="show-progress">S${s.season} · E${s.episode}</div><div class="show-actions"><button class="btn-sm" onclick="openEdit(${idx})">✏ Edit</button><button class="btn-sm btn-sm-danger" onclick="removeShow(${idx})">🗑</button></div></div></div>`;
  }).join('');
}

function setTab(t) { activeTab = t; render(); }
render();
