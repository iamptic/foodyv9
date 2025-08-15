(() => { console.log('[Foody] app.js loaded');
  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const on = (sel, evt, fn) => { const el = $(sel); if (el) el.addEventListener(evt, fn); };
  const state = {
    api: (window.__FOODY__ && window.__FOODY__.FOODY_API) || "https://foodyback-production.up.railway.app",
    rid: localStorage.getItem('foody_restaurant_id') || '',
    key: localStorage.getItem('foody_key') || '',
  };

  const toastBox = $('#toast');
  const showToast = (msg) => {
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    toastBox.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  };

  // Tabs (segmented + bottom nav)
  function activateTab(tab) {
    $$('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.pane').forEach(p => p.classList.toggle('active', p.id === tab));
    if (tab === 'dashboard') refreshDashboard();
    if (tab === 'offers') loadOffers();
    if (tab === 'profile') loadProfile();
    if (tab === 'export') updateCreds();
    if (tab === 'create') initCreateTab();
  }
  on('#tabs','click', (e) => {
    const btn = e.target.closest('.seg-btn'); if (!btn) return;
    if (btn.dataset.tab) activateTab(btn.dataset.tab);
  });
  on('.bottom-nav','click', (e) => {
    const btn = e.target.closest('.nav-btn'); if (!btn) return;
    if (btn.dataset.tab) activateTab(btn.dataset.tab);
  });

  // Auth gating: if no creds — show AUTH pane only
  function gate() {
    if (!state.rid || !state.key) {
      activateTab('auth');
      $('#tabs').style.display = 'none';
      $('.bottom-nav').style.display = 'none';
      return false;
    }
    $('#tabs').style.display = '';
    $('.bottom-nav').style.display = '';
    activateTab('dashboard');
    return true;
  }
  $('#logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('foody_restaurant_id');
    localStorage.removeItem('foody_key');
    state.rid = ''; state.key = '';
    showToast('Вы вышли');
    gate();
  });

  // API helper
  async function api(path, { method='GET', headers={}, body=null, raw=false } = {}) {
    const url = `${state.api}${path}`;
    const h = { 'Content-Type': 'application/json', ...headers };
    if (state.key) h['X-Foody-Key'] = state.key;
    const res = await fetch(url, { method, headers: h, body });
    if (!res.ok) {
      const txt = await res.text().catch(()=>'');
      throw new Error(`${res.status} ${res.statusText} — ${txt}`);
    }
    if (raw) return res;
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  // AUTH
  on('#registerForm','submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const payload = { name: fd.get('name')?.trim(), phone: fd.get('phone')?.trim() };
    try {
      const r = await api('/api/v1/merchant/register_public', { method: 'POST', body: JSON.stringify(payload) });
      if (!r.restaurant_id || !r.api_key) throw new Error('Неожиданный ответ API');
      state.rid = r.restaurant_id; state.key = r.api_key;
      localStorage.setItem('foody_restaurant_id', state.rid);
      localStorage.setItem('foody_key', state.key);
      showToast('Ресторан создан ✅');
      gate();
    } catch (err) { console.error(err); showToast('Ошибка регистрации: ' + err.message); }
  });
  on('#loginForm','submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    state.rid = fd.get('restaurant_id')?.trim();
    state.key = fd.get('api_key')?.trim();
    if (!state.rid || !state.key) return showToast('Введите ID и ключ');
    localStorage.setItem('foody_restaurant_id', state.rid);
    localStorage.setItem('foody_key', state.key);
    showToast('Вход выполнен ✅');
    gate();
  });

  // PROFILE
  async function loadProfile() {
    if (!state.rid || !state.key) return;
    try {
      const p = await api(`/api/v1/merchant/profile?restaurant_id=${encodeURIComponent(state.rid)}`);
      const f = $('#profileForm');
      f.name.value = p.name || ''; f.phone.value = p.phone || '';
      f.address.value = p.address || ''; f.lat.value = p.lat ?? ''; f.lng.value = p.lng ?? '';
      f.close_time.value = (p.close_time || '').slice(0,5);
      $('#profileDump').textContent = JSON.stringify(p, null, 2);
    } catch (err) { console.warn(err); showToast('Не удалось загрузить профиль: ' + err.message); }
  }
  on('#profileForm','submit', async (e) => {
    e.preventDefault();
    if (!state.rid || !state.key) return showToast('Сначала войдите');
    const fd = new FormData(e.currentTarget);
    const payload = {
      restaurant_id: state.rid,
      name: fd.get('name')?.trim(),
      phone: fd.get('phone')?.trim(),
      address: fd.get('address')?.trim(),
      lat: parseFloat(fd.get('lat')) || null,
      lng: parseFloat(fd.get('lng')) || null,
      close_time: fd.get('close_time') || null,
    };
    try {
      const resp = await api('/api/v1/merchant/profile', { method: 'POST', body: JSON.stringify(payload) });
      $('#profileDump').textContent = JSON.stringify(resp || payload, null, 2);
      showToast('Профиль сохранён ✅');
    } catch (err) { console.error(err); showToast('Ошибка сохранения: ' + err.message); }
  });

  // OFFERS
  function moneyToCents(x){ return Math.round((Number(x)||0) * 100); }
  function dtLocalToIso(s){
    if(!s) return null;
    const str = String(s).trim().replace(' ', 'T');
    const d = new Date(str);
    return isNaN(d) ? null : d.toISOString();
  }

  on('#offerForm','submit', async (e) => {
    e.preventDefault();
    if (!state.rid || !state.key) return showToast('Сначала войдите');
    const fd = new FormData(e.currentTarget);
    const payload = {
      restaurant_id: state.rid,
      title: fd.get('title')?.trim(),
      price_cents: moneyToCents(fd.get('price')),
      original_price_cents: moneyToCents(fd.get('original_price')),
      qty_total: Number(fd.get('qty_total') || fd.get('stock')) || 1,
      qty_left: Number(fd.get('qty_total') || fd.get('stock')) || 1,
      expires_at: dtLocalToIso(fd.get('expires_at')),
      image_url: fd.get('image_url')?.trim() || null,
      \1
      category: (fd.get('category')||'').trim() || null,
    };
    try {
      await api('/api/v1/merchant/offers', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Оффер создан ✅');
      e.currentTarget.reset();
      loadOffers();
      activateTab('offers');
    } catch (err) { console.error(err); showToast('Ошибка создания: ' + err.message); }
  });

  async function loadOffers() {
    if (!state.rid || !state.key) return;
    const root = $('#offerList');
    root.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
    try {
      let list = [];
      try {
        list = await api(`/api/v1/merchant/offers?restaurant_id=${encodeURIComponent(state.rid)}`);
      } catch (_) {
        const all = await api(`/api/v1/offers`);
        list = Array.isArray(all) ? all.filter(x => x.restaurant_id === state.rid) : [];
      }
      renderOffers(list);
      updateStats(list);
    } catch (err) {
      console.error(err);
      root.innerHTML = '<div class="hint">Не удалось загрузить офферы</div>';
      showToast('Ошибка загрузки: ' + err.message);
    }
  }

  function renderOffers(items){
    const root = $('#offerList');
    if (!Array.isArray(items) || items.length === 0) {
      root.innerHTML = '<div class="hint">Пока нет офферов</div>';
      return;
    }
    const head = `<div class="row head"><div>Название</div><div>Цена</div><div>Старая</div><div>Скидка</div><div>Остаток</div><div>До</div></div>`;
    const rows = items.map(o => {
      const price = (o.price_cents||0)/100;
      const old = (o.original_price_cents||0)/100;
      const disc = old>0 ? Math.round((1 - price/old)*100) : 0;
      const exp = o.expires_at ? new Date(o.expires_at).toLocaleString() : '—';
      return `<div class="row">
        <div>${o.title || '—'}</div>
        <div>${price.toFixed(0)} ₽</div>
        <div>${old? old.toFixed(0)+' ₽':'—'}</div>
        <div>${disc?`-${disc}%`:'—'}</div>
        <div>${o.qty_left ?? '—'} / ${o.qty_total ?? '—'}</div>
        <div>${exp}</div>
      </div>`;
    }).join('');
    root.innerHTML = head + rows;
  }

  async function refreshDashboard(){
    await loadOffers();
    const list = $('#offerList').querySelectorAll('.row:not(.head)');
    const box = $('#dashboardOffers');
    if (!list.length) { box.innerHTML = '<div class="hint">Нет активных офферов</div>'; return; }
    box.innerHTML='';
    list.forEach(row => {
      const name = row.children[0]?.textContent || '—';
      const price = row.children[1]?.textContent || '—';
      const till = row.children[5]?.textContent || '—';
      const card = document.createElement('div');
      card.className = 'item';
      card.innerHTML = `<div><b>${name}</b><div class="muted">до ${till}</div></div><span class="badge">${price}</span>`;
      box.appendChild(card);
    });
  }

  function updateStats(items){
    items = Array.isArray(items) ? items : [];
    const active = items.length;
    const qty = items.reduce((s,x)=> s + (Number(x.qty_left)||0), 0);
    const discs = items.map(o => {
      const p = (o.price_cents||0)/100;
      const old = (o.original_price_cents||0)/100;
      return old>0 ? (1 - p/old) : 0;
    }).filter(x=>x>0);
    const avg = discs.length ? Math.round((discs.reduce((a,b)=>a+b,0)/discs.length)*100) : 0;
    $('#statOffers').textContent = String(active);
    $('#statQty').textContent = String(qty);
    $('#statDisc').textContent = avg ? `-${avg}%` : '—';
  }

  // EXPORT
  on('#downloadCsv','click', async () => {
    if (!state.rid || !state.key) return showToast('Сначала войдите');
    try {
      const res = await fetch(`${state.api}/api/v1/merchant/offers/csv?restaurant_id=${encodeURIComponent(state.rid)}`, {
        headers: { 'X-Foody-Key': state.key }
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `foody_offers_${state.rid}.csv`;
      a.click(); URL.revokeObjectURL(a.href);
      showToast('CSV скачан ✅');
    } catch (err) { console.error(err); showToast('Ошибка экспорта: ' + err.message); }
  });
  function updateCreds(){
    $('#creds').textContent = JSON.stringify({ restaurant_id: state.rid, api_key: state.key, api: state.api }, null, 2);
  }

  // Create tab init (Flatpickr + FilePond)
  let createInited = false;
  async function initCreateTab(){
    if (createInited) return;
    createInited = true;
    try {
      if (window.flatpickr && document.getElementById('expires_at')) {
        flatpickr.localize(flatpickr.l10ns?.ru || {});
        const expiresPicker = flatpickr("#expires_at", {
          enableTime: true, time_24hr: true, minuteIncrement: 5,
          dateFormat: "Y-m-d H:i",
          altInput: true, altFormat: "d.m.Y H:i",
          defaultDate: new Date(Date.now() + 60*60*1000),
          minDate: "today"
        });
        window._foodyExpiresPicker = expiresPicker;
        // Quick time buttons
        const qt = document.getElementById('quickTime');
        if (qt && expiresPicker) {
          qt.addEventListener('click', (e) => {
            const btn = e.target.closest('button'); if (!btn) return;
            const mins = btn.getAttribute('data-mins');
            const eod = btn.getAttribute('data-eod'); // format "HH:MM"
            let target = null;
            if (mins) {
              const add = parseInt(mins, 10) || 0;
              target = new Date(Date.now() + add*60*1000);
            } else if (eod) {
              const [hh, mm] = eod.split(':').map(x=>parseInt(x,10)||0);
              const d = new Date();
              d.setHours(hh, mm, 0, 0);
              if (d < new Date()) d.setDate(d.getDate()+1); // если время прошло — на завтра
              target = d;
            }
            if (target) expiresPicker.setDate(target, true);
          }, { passive: true });
        }
        }
      if (window.FilePond && document.getElementById('photo')) {
        FilePond.registerPlugin(
          window.FilePondPluginImagePreview,
          window.FilePondPluginFileValidateType,
          window.FilePondPluginFileValidateSize
        );
        const pond = FilePond.create(document.getElementById('photo'), {
          allowMultiple: false,
          labelIdle: 'Перетащите фото или <span class="filepond--label-action">выберите</span>',
          acceptedFileTypes: ['image/*'],
          maxFileSize: '5MB',
          acceptedFileTypes: ['image/*'],
          maxFileSize: '5MB',
          server: {
            process: {
              url: (window.foodyApi || state.api) + '/upload',
              method: 'POST',
              onload: (res) => {
                try {
                  const data = JSON.parse(res);
                  if (data && data.url) {
                    document.getElementById('image_url').value = data.url;
                    return data.url;
                  }
                } catch (e) {}
                return null;
              }
            }
          }
        });
      }
    } catch (err) { console.warn('Create init failed', err); }
  }

  // Init
  gate();
})();