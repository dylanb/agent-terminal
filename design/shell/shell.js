// Shared shell behavior for the §24.1B mockups: theme, view switching, quick-send overlay.
(function () {
  const root = document.documentElement;
  if (matchMedia('(prefers-color-scheme:dark)').matches) root.setAttribute('data-theme', 'dark');

  function setTheme(t) {
    root.setAttribute('data-theme', t);
    document.querySelectorAll('[data-theme-label]').forEach(el => { el.textContent = t === 'dark' ? 'Dark' : 'Light'; });
  }
  window.toggleTheme = () => setTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');

  function setView(v) {
    document.querySelectorAll('[data-viewpane]').forEach(p => p.classList.toggle('on', p.getAttribute('data-viewpane') === v));
    document.querySelectorAll('[data-viewbtn]').forEach(b => b.classList.toggle('on', b.getAttribute('data-viewbtn') === v));
    document.querySelectorAll('[data-viewbtn]').forEach(b => b.setAttribute('aria-current', b.getAttribute('data-viewbtn') === v ? 'page' : 'false'));
  }
  window.setView = setView;

  const scrim = () => document.querySelector('.scrim');
  window.openOverlay = (tab) => { const s = scrim(); if (s) { s.classList.add('open'); if (tab) selectTab(tab); } };
  window.closeOverlay = () => { const s = scrim(); if (s) s.classList.remove('open'); };
  function selectTab(name) {
    document.querySelectorAll('.overlay .tab').forEach(t => t.classList.toggle('on', t.getAttribute('data-tab') === name));
    document.querySelectorAll('.overlay .panel').forEach(p => p.hidden = p.getAttribute('data-tabpanel') !== name);
  }
  window.selectTab = selectTab;

  document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); const s = scrim(); s && s.classList.contains('open') ? window.closeOverlay() : window.openOverlay(); }
    else if (meta && ['1', '2', '3'].includes(e.key)) { e.preventDefault(); setView(e.key); }
    else if (e.key === 'Escape') window.closeOverlay();
  });

  // deep-link initial state (handy for review screenshots): ?view=2&overlay=capture
  const q = new URLSearchParams(location.search);
  if (q.get('view')) setView(q.get('view'));
  if (q.get('theme')) setTheme(q.get('theme'));
  if (q.has('overlay')) window.addEventListener('DOMContentLoaded', () => window.openOverlay(q.get('overlay') || undefined));

  document.addEventListener('click', (e) => {
    const vb = e.target.closest('[data-viewbtn]'); if (vb) setView(vb.getAttribute('data-viewbtn'));
    const tb = e.target.closest('.overlay .tab'); if (tb) selectTab(tb.getAttribute('data-tab'));
    if (e.target.classList.contains('scrim')) window.closeOverlay();
    const tg = e.target.closest('[data-toggle-theme]'); if (tg) window.toggleTheme();
    const oo = e.target.closest('[data-open-overlay]'); if (oo) window.openOverlay(oo.getAttribute('data-open-overlay') || undefined);
    const oc = e.target.closest('[data-close-overlay]'); if (oc) window.closeOverlay();
    const chk = e.target.closest('.todo .chk'); if (chk) chk.closest('.todo').classList.toggle('done');
  });
})();
