
// create.enhance.js — fallback/усилитель для вкладок и авторизации
(() => {
  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const on = (sel, evt, fn) => { const el = $(sel); if (el) el.addEventListener(evt, fn, { passive: false }); };
  const API = (window.__FOODY__ && window.__FOODY__.FOODY_API) || window.foodyApi || 'https://foodyback-production.up.railway.app';
  const toast = (m) => { try { (window.showToast||((x)=>alert(x)))(m); } catch { alert(m); } };

  function activateTab(tab){
    $$('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.pane').forEach(p => p.classList.toggle('active', p.id === tab));
  }

  // ---- HARD GATE (работает даже если app.js сломан) ----
  function hardGate(){
    const rid = localStorage.getItem('foody_restaurant_id') || '';
    const key = localStorage.getItem('foody_key') || '';
    const authed = !!(rid && key);

    // show/hide tabs & bottom nav
    const tabs = $('#tabs'); if (tabs) tabs.style.display = authed ? '' : 'none';
    const bn = $('.bottom-nav'); if (bn) bn.style.display = authed ? '' : 'none';

    // hide logout link when not authed
    $$('#profile [data-hard-logout], [data-hard-logout]').forEach(a => { a.style.display = authed ? '' : 'none'; });

    // activate proper pane
    if (!authed) {
      activateTab('auth');
    } else {
      // if we came from login/registration, app.js may still init its data loaders
      // leave current tab unless nothing active
      const hasActive = !!$('.pane.active');
      if (!hasActive) activateTab('dashboard');
    }
  }

  // Run hardGate on load
  hardGate();

  // ---- AUTH tabs (Регистрация / Вход) ----
  function setAuthMode(mode){
    $$('#authTabs .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.auth === mode));
    $('#registerForm')?.classList.toggle('hidden', mode !== 'register');
    $('#loginForm')?.classList.toggle('hidden', mode !== 'login');
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('#authTabs .seg-btn');
    if (!btn) return;
    e.preventDefault();
    const mode = btn.getAttribute('data-auth'); if (!mode) return;
    setAuthMode(mode);
  }, { passive: false });

  // Prefill from URL
  try {
    const sp = new URLSearchParams(location.search);
    const name = sp.get('name') || sp.get('title');
    const phone = sp.get('phone');
    if (name) { const i=$('#registerForm input[name="name"]'); if(i) i.value = name; }
    if (phone){ const i=$('#registerForm input[name="phone"]'); if(i) i.value = phone; }
  } catch(_) {}

  // ---- Registration submit (fallback, если app.js не повесил обработчик) ----
  on('#registerForm','submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const fd = new FormData(f);
    const payload = { name: (fd.get('name')||'').toString().trim(), phone: (fd.get('phone')||'').toString().trim() };
    if (!payload.name) return toast('Укажите название ресторана');
    try {
      const res = await fetch(`${API}/api/v1/merchant/register_public`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = await res.json();
      if (!r.restaurant_id || !r.api_key) throw new Error('Неожиданный ответ');
      localStorage.setItem('foody_restaurant_id', r.restaurant_id);
      localStorage.setItem('foody_key', r.api_key);
      toast('Ресторан создан ✅');
      hardGate();
      // перейти сразу на Создать
      activateTab('create');
      try { (window.initCreateTab||(()=>{}))(); } catch {}
    } catch (err) {
      console.warn(err); toast('Не удалось зарегистрировать: ' + err.message);
    }
  });

  // ---- Login submit (fallback) ----
  on('#loginForm','submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const fd = new FormData(f);
    const rid = (fd.get('restaurant_id')||'').toString().trim();
    const key = (fd.get('api_key')||'').toString().trim();
    if (!rid || !key) return toast('Введите Restaurant ID и API key');
    try {
      localStorage.setItem('foody_restaurant_id', rid);
      localStorage.setItem('foody_key', key);
      toast('Вход выполнен ✅');
      hardGate();
      activateTab('dashboard');
    } catch (err) {
      console.warn(err); toast('Не удалось войти: ' + err.message);
    }
  });

  // If query string has ?auth=login etc.
  try {
    const sp = new URLSearchParams(location.search);
    const mode = sp.get('auth'); if (mode) setAuthMode(mode);
  } catch {}

  // Safety: if user lands with keys but on auth, switch to dashboard
  try {
    const rid = localStorage.getItem('foody_restaurant_id') || '';
    const key = localStorage.getItem('foody_key') || '';
    if (rid && key && $('#auth')?.classList.contains('active')) activateTab('dashboard');
  } catch {}
})();
