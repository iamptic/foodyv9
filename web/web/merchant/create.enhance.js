
(() => {
  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const on = (sel, evt, fn) => { const el = $(sel); if (el) el.addEventListener(evt, fn, { passive: true }); };

  function activateTab(tab){
    $$('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.pane').forEach(p => p.classList.toggle('active', p.id === tab));
  }

  on('#tabs','click', (e) => {
    const btn = e.target.closest('.seg-btn'); if (!btn) return;
    const tab = btn.getAttribute('data-tab'); if (!tab) return;
    activateTab(tab);
    if (tab === 'create') initCreateTab();
  });
  on('.bottom-nav','click', (e) => {
    const btn = e.target.closest('.nav-btn'); if (!btn) return;
    const tab = btn.getAttribute('data-tab'); if (!tab) return;
    activateTab(tab);
    if (tab === 'create') initCreateTab();
  });

  function bindNativePreview(){
    const el = $('#photo'); if (!el || el._prevBound) return;
    el._prevBound = true;
    el.addEventListener('change', () => {
      if (document.querySelector('.filepond--root')) return;
      const f = el.files && el.files[0];
      const wrap = $('#photoPreviewWrap'); const img = $('#photoPreview');
      if (!wrap || !img) return;
      if (f) {
        const url = URL.createObjectURL(f);
        img.src = url; wrap.classList.remove('hidden');
        img.onload = () => URL.revokeObjectURL(url);
      } else {
        wrap.classList.add('hidden'); img.removeAttribute('src');
      }
    });
  }

  let inited = false;
  function initCreateTab(){
    try {
      if (inited) { bindNativePreview(); return; }
      inited = true;

      if (window.flatpickr && $('#expires_at')) {
        if (window.flatpickr.l10ns && window.flatpickr.l10ns.ru) {
          flatpickr.localize(flatpickr.l10ns.ru);
        }
        const fp = flatpickr('#expires_at', {
          enableTime: true, time_24hr: true, minuteIncrement: 5,
          dateFormat: 'Y-m-d H:i', altInput: true, altFormat: 'd.m.Y H:i',
          defaultDate: new Date(Date.now() + 60*60*1000), minDate: 'today'
        });
        const qt = $('#quickTime');
        if (qt) {
          qt.addEventListener('click', (e) => {
            const b = e.target.closest('button'); if (!b) return;
            let t = null;
            if (b.dataset.mins) {
              t = new Date(Date.now() + (parseInt(b.dataset.mins,10)||0)*60*1000);
            } else if (b.dataset.eod) {
              const [hh,mm]=b.dataset.eod.split(':').map(x=>parseInt(x,10)||0);
              const d = new Date(); d.setHours(hh,mm,0,0); if (d<new Date()) d.setDate(d.getDate()+1); t=d;
            }
            if (t) fp.setDate(t, true);
          }, { passive: true });
        }
      }

      bindNativePreview();
      const fileInput = $('#photo');
      if (window.FilePond && fileInput) {
        try {
          if (window.FilePondPluginImagePreview) FilePond.registerPlugin(window.FilePondPluginImagePreview);
          if (window.FilePondPluginFileValidateType) FilePond.registerPlugin(window.FilePondPluginFileValidateType);
          if (window.FilePondPluginFileValidateSize) FilePond.registerPlugin(window.FilePondPluginFileValidateSize);
        } catch (_) {}
        const pond = FilePond.create(fileInput, {
          labelIdle: 'Перетащите фото или <span class="filepond--label-action">выберите</span>',
          acceptedFileTypes: ['image/*'],
          maxFileSize: '5MB',
          credits: true,
          instantUpload: false
        });
        window.foodyPond = pond;
        pond.on('removefile', () => { const w = $('#photoPreviewWrap'); if (w) w.classList.add('hidden'); });
      }
    } catch (e) { console.warn('initCreateTab failed', e); }
  }

  const createPane = $('#create');
  if (createPane && createPane.classList.contains('active')) initCreateTab();
  if (location.search.includes('title=') || location.pathname.endsWith('/new')) {
    activateTab('create'); initCreateTab();
  }
})();
