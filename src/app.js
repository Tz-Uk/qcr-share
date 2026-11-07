/**
 * Quran Cross-References — application shell.
 */

import {
  state, loadBase, loadMode, loadTranslation, setOrder, verseIndex, verseAtPos,
  refOf, posOf, formatNumber, categoryName, parseReference, translationText, surahEnvelope,
  MODES, TRANSLATIONS,
} from './data.js';
import { ArcView } from './arcs.js';
import { createUI } from './ui.js';

const $ = (sel) => document.querySelector(sel);
const BUILD = '14';

const urlState = (() => {
  const p = new URLSearchParams(location.search);
  const links = p.get('l');
  return {
    mode: p.get('m') === 'sunni' ? 'sunni' : p.get('m') === 'shia' ? 'shia' : null,
    order: p.get('o') === 'revelation' ? 'revelation' : null,
    links: ['all', 'focus'].includes(links) ? links : null,
    tr: p.get('tr'),
    cat: p.get('cat') != null && Number.isInteger(+p.get('cat')) ? +p.get('cat') : null,
    surah: p.get('s') && Number.isInteger(+p.get('s')) ? +p.get('s') : null,
    span: p.get('span') && +p.get('span') > 0 ? +p.get('span') : null,
    start: p.get('start') != null ? +p.get('start') : 0,
  };
})();

const app = {
  build: BUILD,
  view: null,
  ui: null,
  ready: false,
};

async function boot() {
  const canvas = $('#arcs');
  app.view = new ArcView(canvas, {
    onHover: (info) => {
      app.ui.showTooltip(info);
      canvas.style.cursor = info ? 'pointer' : 'crosshair';
    },
    onSelect: (index) => navigate(index),
    onSurah: (n) => selectSurah(n),
  });

  await loadBase();
  if (urlState.order === 'revelation') setOrder('revelation');
  const savedMode = urlState.mode || (localStorage.getItem('qcr-mode') === 'sunni' ? 'sunni' : 'shia');
  await loadMode(savedMode);
  const savedTr = urlState.tr || localStorage.getItem('qcr-translation');
  const tr = TRANSLATIONS.find((t) => t.slug === savedTr && t.tradition === savedMode)
    ? savedTr
    : MODES[savedMode].defaultTranslation;
  await loadTranslation(tr);
  state.translation = tr;
  if (urlState.cat != null && state.categories.length > 1 && state.categories[urlState.cat]) {
    state.category = urlState.cat;
  }
  app.view.rebuildInstances();

  app.ui = createUI(app.view, app);
  app.ui.renderSurahBar();
  populateTranslations();
  populateCategories();
  updateModeUI();
  $('#order').value = state.order;
  if (state.category >= 0) $('#category').value = String(state.category);
  const savedLinks = urlState.links || localStorage.getItem('qcr-links-mode');
  state.linksMode = savedLinks === 'focus' ? 'focus' : 'all';
  $('#links-mode').value = state.linksMode;
  app.ui.renderStats();
  restoreTheme();
  wire();
  app.ready = true;
  setTimeout(showMobileNotice, 700);

  const deep = readHash();
  if (deep != null) {
    setTimeout(() => {
      navigate(deep, { fromBar: urlState.span != null });
      if (urlState.span != null) {
        app.view.setCamera(urlState.start, urlState.start + urlState.span, { animate: false });
      }
    }, 40);
  } else {
    if (urlState.span != null) {
      app.view.setCamera(urlState.start, urlState.start + urlState.span, { animate: false });
    } else {
      app.view.resize();
    }
  }

  $('#loading').classList.add('done');
  setTimeout(() => $('#hint').classList.add('gone'), 9000);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then((reg) => reg.update().catch(() => {}))
      .catch(() => {});
  }
}

/* ------------------------------------------------------------- navigation */

function navigate(index, { fromBar = false, replace = false, fitConnections = false } = {}) {
  if (index == null) return;
  index = Math.max(0, Math.min(6235, index));
  state.activeSurah = state.quran.verses[index].s;
  if (!fromBar) {
    if (fitConnections) app.view.fitVerseConnections(index);
    else app.view.focusVerse(index, { zoom: true });
  }
  app.ui.openPanel(index);
  writeHash(index, replace);
  if (!fromBar) setTimeout(syncUrl, 520);
  app.ui.renderStats(filteredCount());
}

/** Shared by the surah bar and the surah labels drawn on the diagram. */
function busiestVerse(n) {
  const s = state.quran.surahs[n - 1];
  let best = s.start;
  let bestDeg = -1;
  for (let i = s.start; i < s.start + s.verses; i++) {
    const degree = state.degree[i] || 0;
    if (degree > bestDeg) { bestDeg = degree; best = i; }
  }
  return best;
}

function selectSurah(n) {
  const s = state.quran.surahs[n - 1];
  if (!s) return;
  state.activeSurah = n;
  const env = surahEnvelope(n);
  const target = busiestVerse(n);
  app.view.fitSurah(n);
  app.view.setSelected(target);
  navigate(target, { fromBar: true });
  app.ui.setSurahSummary?.(n);
  setTimeout(syncUrl, 560);
  if (env && env.end - env.start > 5000) {
    const span = Math.min(6236, Math.round(env.end - env.start));
    app.ui.toast(`${s.name}: its links span ${formatNumber(span)} verses — showing the whole map`);
  }
}

function readHash() {
  const m = location.hash.match(/^#\/?(\d{1,3})[:/](\d{1,3})$/);
  if (!m) return null;
  return verseIndex(+m[1], +m[2]);
}

function writeHash(index, replace) {
  const v = state.quran.verses[index];
  const hash = `#/${v.s}/${v.a}`;
  const qs = stateQuery();
  const url = `${location.pathname}${qs ? `?${qs}` : ''}${hash}`;
  if (location.pathname + location.search + location.hash === url) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
}

function stateQuery() {
  const p = new URLSearchParams();
  if (state.mode !== 'shia') p.set('m', state.mode);
  if (state.order !== 'mushaf') p.set('o', state.order);
  if (state.linksMode !== 'all') p.set('l', state.linksMode);
  if (state.translation !== MODES[state.mode].defaultTranslation) p.set('tr', state.translation);
  if (state.category >= 0) p.set('cat', state.category);
  const span = Math.round(app.view.span);
  if (span < 6234) {
    p.set('span', span);
    p.set('start', Math.round(app.view.cam.start));
  }
  return p.toString();
}

function syncUrl() {
  const qs = stateQuery();
  const url = `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`;
  if (location.pathname + location.search + location.hash === url) return;
  history.replaceState(null, '', url);
}

/* ------------------------------------------------------------------- UI */

function populateTranslations() {
  const sel = $('#translation');
  const frag = document.createDocumentFragment();
  for (const tradition of ['shia', 'sunni']) {
    const group = document.createElement('optgroup');
    group.label = MODES[tradition].label;
    for (const t of TRANSLATIONS.filter((x) => x.tradition === tradition)) {
      const o = document.createElement('option');
      o.value = t.slug;
      o.textContent = t.name;
      group.append(o);
    }
    frag.append(group);
  }
  sel.replaceChildren(frag);
  sel.value = state.translation;
}

function populateCategories() {
  const sel = $('#category');
  sel.replaceChildren();
  const all = document.createElement('option');
  all.value = '-1';
  all.textContent = 'All connections';
  sel.append(all);
  state.categories.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = c;
    sel.append(o);
  });
  sel.value = '-1';
  const wrap = sel.closest('.select-wrap');
  if (wrap) wrap.hidden = state.categories.length <= 1;
}

function updateModeUI() {
  for (const b of document.querySelectorAll('[data-mode]')) {
    b.classList.toggle('active', b.dataset.mode === state.mode);
    b.setAttribute('aria-pressed', b.dataset.mode === state.mode ? 'true' : 'false');
  }
  const source = $('#source-btn');
  if (source) source.textContent = `${state.meta.sourceShort}, ${state.meta.sourceWork}`;
  const title = `Quran Cross-References — ${MODES[state.mode].label} (${state.meta.sourceShort})`;
  window.QCR_APP_TITLE = title;
  document.title = document.documentElement.dataset.locked === '1' ? 'Protected' : title;
}

async function switchMode(mode) {
  if (mode === state.mode || !MODES[mode]) return;
  const btn = document.querySelector(`[data-mode="${mode}"]`);
  btn?.setAttribute('disabled', 'true');
  try {
    await loadMode(mode);
    const preferred = MODES[mode].defaultTranslation;
    await loadTranslation(preferred);
    state.translation = preferred;
    localStorage.setItem('qcr-mode', mode);
    localStorage.setItem('qcr-translation', preferred);

    $('#translation').value = preferred;
    populateCategories();
    updateModeUI();
    app.view.rebuildInstances();
    app.ui.renderStats();
    if (app.ui.panelIndex != null) app.ui.renderPanel(app.ui.panelIndex);
    state.category = -1;
    $('#category').value = '-1';
    syncUrl();
  } finally {
    btn?.removeAttribute('disabled');
  }
}

function filteredCount() {
  if (state.category < 0) return state.linkCount;
  let n = 0;
  for (const l of state.links) if (l[2] === state.category) n++;
  return n;
}

function restoreTheme() {
  const saved = localStorage.getItem('qcr-theme');
  const theme = saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = theme;
  app.view?.invalidate();
}

function showMobileNotice() {
  if (!window.matchMedia('(max-width: 760px)').matches) return;
  try {
    if (localStorage.getItem('qcr-mobile-notice') === '1') return;
  } catch { /* storage may be unavailable */ }
  const el = document.createElement('div');
  el.className = 'mobile-notice';
  el.setAttribute('role', 'status');
  el.innerHTML = '<span>Best on a larger screen — the map and connections are easier to explore on a PC. You can still use everything here.</span><button type="button">Got it</button>';
  el.querySelector('button').addEventListener('click', () => {
    el.remove();
    try { localStorage.setItem('qcr-mobile-notice', '1'); } catch { /* ignore */ }
  });
  document.body.append(el);
}

function wire() {
  const view = app.view;
  const ui = app.ui;

  for (const b of document.querySelectorAll('[data-mode]')) {
    b.addEventListener('click', () => switchMode(b.dataset.mode));
  }

  $('#theme-btn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('qcr-theme', next);
    view.invalidate();
  });

  $('#translation').addEventListener('change', async (e) => {
    const slug = e.target.value;
    await loadTranslation(slug);
    state.translation = slug;
    localStorage.setItem('qcr-translation', slug);
    if (ui.panelIndex != null) ui.renderPanel(ui.panelIndex);
    syncUrl();
  });

  $('#order').addEventListener('change', (e) => {
    setOrder(e.target.value);
    view.rebuildInstances();
    ui.renderSurahBar();
    view.setSelected(ui.panelIndex);
    view.focusPos(0, 6236, { animate: true });
    view.invalidate();
    setTimeout(syncUrl, 520);
  });

  $('#category').addEventListener('change', (e) => {
    state.category = +e.target.value;
    view.rebuildInstances();
    view.invalidate();
    ui.renderStats(filteredCount());
    if (ui.panelIndex != null) ui.renderPanel(ui.panelIndex);
    syncUrl();
  });

  $('#links-mode').addEventListener('change', (e) => {
    state.linksMode = e.target.value;
    localStorage.setItem('qcr-links-mode', state.linksMode);
    const hint = $('#hint');
    if (state.linksMode === 'focus') {
      hint.textContent = 'Hover or click a verse to reveal its connections';
      hint.classList.remove('gone');
      setTimeout(() => hint.classList.add('gone'), 5200);
    }
    view.invalidate(true);
    syncUrl();
    ui.renderStats(filteredCount());
  });

  $('#zoom-in').addEventListener('click', () => view.animateZoom(1.8));
  $('#zoom-out').addEventListener('click', () => view.animateZoom(1 / 1.8));
  $('#reset').addEventListener('click', () => view.focusPos(0, 6236, { animate: true }));
  $('#random').addEventListener('click', () => navigate(Math.floor(Math.random() * 6236)));

  $('#panel-close').addEventListener('click', () => {
    ui.closePanel();
    history.replaceState(null, '', location.pathname + location.search);
  });

  document.addEventListener('keydown', (e) => {
    const typing = /input|textarea|select/i.test(document.activeElement?.tagName || '');
    if (e.key === '/' && !typing) {
      e.preventDefault();
      $('#search').focus();
      return;
    }
    if (e.key === 'Escape') {
      if (!$('#modal').hidden) { ui.closeModal(); return; }
      if (!$('#results').hidden) { $('#results').hidden = true; return; }
      if (ui.panelIndex != null) { ui.closePanel(); history.replaceState(null, '', location.pathname + location.search); }
      return;
    }
    if (typing) return;
    if (!$('#modal').hidden) return;

    const current = ui.panelIndex;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      if (current == null) { navigate(0); return; }
      const step = e.shiftKey ? 10 : 1;
      const next = current + (e.key === 'ArrowRight' ? step : -step);
      focusKeepZoom(Math.max(0, Math.min(6235, next)));
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      view.animateZoom(1.8);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      view.animateZoom(1 / 1.8);
    } else if (e.key === '0') {
      view.focusPos(0, 6236, { animate: true });
    } else if (e.key === 'r' || e.key === 'R') {
      navigate(Math.floor(Math.random() * 6236));
    }
  });

  window.addEventListener('hashchange', () => {
    const idx = readHash();
    if (idx != null && idx !== ui.panelIndex) {
      view.focusVerse(idx, { zoom: false });
      ui.openPanel(idx);
    } else if (idx == null && ui.panelIndex != null) {
      ui.closePanel();
    }
  });

  const ro = new ResizeObserver(() => view.resize());
  ro.observe($('#stage'));
  window.addEventListener('resize', () => {
    ui.updateSurahLabels();
  });
}

function focusKeepZoom(index) {
  state.activeSurah = state.quran.verses[index].s;
  app.view.focusVerse(index, { zoom: false });
  app.ui.openPanel(index);
  writeHash(index);
  app.ui.renderStats(filteredCount());
}

/* ------------------------------------------------------------- share glue */

app.share = (index) => app.ui.shareCard(index);
app.copyLink = async (index) => {
  const v = state.quran.verses[index];
  const url = `${location.origin}${location.pathname}#/${v.s}/${v.a}`;
  try {
    await navigator.clipboard.writeText(url);
    app.ui.toast('Link copied');
  } catch {
    app.ui.toast(url);
  }
};
app.navigate = navigate;
app.selectSurah = selectSurah;
app.switchMode = switchMode;

/* ------------------------------------------------------------------ boot */

boot().catch((err) => {
  console.error(err);
  const box = document.querySelector('#loading');
  if (box) {
    box.classList.remove('done');
    box.textContent = 'Could not load the data. Serve this folder over HTTP (not file://) and reload.';
  }
});

// Handy for debugging in the console, and for the data tests.
window.QCR = {
  state, app, refOf, verseAtPos, posOf, formatNumber, parseReference,
  translationText, categoryName, MODES, TRANSLATIONS,
};
