/**
 * DOM side of the app: details panel, search, surah bar, share card, about.
 */

import {
  state, refOf, keyOf, surahOf, translationText, connectionsOf, posOf,
  categoryName, formatNumber, parseReference, searchText, findSurah, translationMeta,
} from './data.js';

const CATEGORY_BLURB = {
  Bayani: 'one verse clarifies another',
  Siyaqi: 'shared context or narrative',
  Tafsili: 'one verse expands another',
  Uslubi: 'shared rhetorical form',
  Lughawi: 'a word or usage links them',
  Tawfiqi: 'a link left for the reader',
  Takhsis: 'one verse narrows another',
  Nazmi: 'shared composition',
  Taqyid: 'one verse qualifies another',
  'Muhkam-based': 'anchored in a clear verse',
  Naskh: 'abrogation-related',
  'Quran by Quran': 'al-Mizan reads them together',
};

const $ = (sel) => document.querySelector(sel);

export function createUI(view, app) {
  const els = {
    panel: $('#panel'),
    pRef: $('#p-ref'),
    pSub: $('#p-sub'),
    pChips: $('#p-chips'),
    pBody: $('#p-body'),
    search: $('#search'),
    results: $('#results'),
    tooltip: $('#tooltip'),
    surahbar: $('#surahbar'),
    surahLabel: $('#surah-label'),
    stats: $('#stats'),
    toast: $('#toast'),
    modal: $('#modal'),
    modalBody: $('#modal-body'),
  };

  let contextMode = false;
  let connSort = 'near';
  let panelIndex = null;
  let searchTimer = 0;
  let searchItems = [];
  let searchActive = -1;
  let toastTimer = 0;

  /* ------------------------------------------------------------- helpers */

  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
  }

  function chip(text, cls = '') {
    const s = document.createElement('span');
    s.className = `chip ${cls}`.trim();
    s.textContent = text;
    return s;
  }

  function snippet(text, at, len) {
    const start = Math.max(0, at - 34);
    const frag = document.createElement('span');
    const before = (start > 0 ? '…' : '') + text.slice(start, at);
    const hit = text.slice(at, at + len);
    const after = text.slice(at + len, at + len + 90) + '…';
    frag.append(document.createTextNode(before));
    const mark = document.createElement('mark');
    mark.textContent = hit;
    frag.append(mark, document.createTextNode(after));
    return frag;
  }

  /* ------------------------------------------------------------ surah bar */

  function renderSurahBar() {
    const frag = document.createDocumentFragment();
    for (const si of state.surahOrder) {
      const s = state.quran.surahs[si];
      const b = document.createElement('button');
      b.className = `surah-seg ${s.place}`;
      b.style.flex = `${s.verses} 1 0`;
      b.dataset.surah = s.n;
      b.title = `${s.n} · ${s.name} — ${s.verses} verses (${s.place === 'meccan' ? 'Meccan' : 'Medinan'})`;
      b.setAttribute('aria-label', `Surah ${s.n}, ${s.name}, ${s.verses} verses`);
      const span = document.createElement('span');
      span.textContent = s.n;
      b.append(span);
      b.addEventListener('click', () => {
        app.selectSurah(s.n);
      });
      b.addEventListener('mouseenter', () => {
        view.setSurahPreview(s.n);
        showSurahLabel(b, s);
      });
      b.addEventListener('mouseleave', () => {
        view.setSurahPreview(null);
        hideSurahLabel();
      });
      b.addEventListener('focus', () => {
        view.setSurahPreview(s.n);
        showSurahLabel(b, s);
      });
      b.addEventListener('blur', () => {
        view.setSurahPreview(null);
        hideSurahLabel();
      });
      frag.append(b);
    }
    els.surahbar.replaceChildren(frag);
    if (!els.surahbar.dataset.keys) {
      els.surahbar.dataset.keys = '1';
      els.surahbar.addEventListener('keydown', (e) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        const buttons = [...els.surahbar.querySelectorAll('.surah-seg')];
        const i = buttons.indexOf(document.activeElement);
        if (i < 0) return;
        e.preventDefault();
        let next = i;
        if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = buttons.length - 1;
        else if (e.key === 'ArrowLeft') next = Math.max(0, i - 1);
        else next = Math.min(buttons.length - 1, i + 1);
        buttons[next].focus();
      });
    }
    requestAnimationFrame(updateSurahLabels);
  }

  function showSurahLabel(button, s) {
    if (!els.surahLabel) return;
    const r = button.getBoundingClientRect();
    const half = 110;
    const left = Math.max(half + 8, Math.min(window.innerWidth - half - 8, r.left + r.width / 2));
    els.surahLabel.textContent = `${s.n} · ${s.name} — ${s.verses} verses · ${s.place === 'meccan' ? 'Meccan' : 'Medinan'}`;
    els.surahLabel.style.left = `${left}px`;
    els.surahLabel.style.bottom = `${window.innerHeight - r.top + 6}px`;
    els.surahLabel.classList.add('show');
  }

  function hideSurahLabel() {
    els.surahLabel?.classList.remove('show');
  }

  function updateSurahLabels() {
    const wide = window.innerWidth > 760;
    for (const b of els.surahbar.children) {
      const label = b.firstElementChild;
      if (!label) continue;
      label.style.display = wide && b.offsetWidth >= 22 ? 'flex' : 'none';
    }
  }

  function markActiveSurah(index) {
    const s = index == null ? null : state.quran.verses[index].s;
    for (const b of els.surahbar.children) {
      const active = s != null && +b.dataset.surah === s;
      b.classList.toggle('active', active);
      if (active) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    }
  }

  /* --------------------------------------------------------------- stats */

  function renderStats(filteredCount) {
    const base = `${formatNumber(6236)} verses · ${formatNumber(state.linkCount)} connections · ${state.meta?.sourceShort || ''}`;
    const cat = state.category >= 0
      ? ` · showing ${formatNumber(filteredCount ?? 0)} ${categoryName(state.category)}`
      : '';
    els.stats.textContent = base + cat + (state.linksMode === 'focus' ? ' · highlight only' : '');
  }

  /* --------------------------------------------------------------- panel */

  function openPanel(index) {
    panelIndex = index;
    contextMode = false;
    view.setSelected(index);
    markActiveSurah(index);
    renderPanel(index);
    els.panel.hidden = false;
    document.body.classList.add('panel-open');
    resizeSoon();
  }

  function closePanel() {
    els.panel.hidden = true;
    document.body.classList.remove('panel-open');
    panelIndex = null;
    view.setSelected(null);
    markActiveSurah(null);
    resizeSoon();
  }

  function resizeSoon() {
    requestAnimationFrame(() => view.resize());
  }

  function renderDetails(index) {
    const v = state.quran.verses[index];
    const s = surahOf(index);
    const deg = state.degree[index];
    els.pRef.textContent = refOf(index);
    els.pSub.textContent = `${s.name} · ${s.english} · verse ${v.a} of ${s.verses}`;
    els.pChips.replaceChildren(
      chip(s.place === 'meccan' ? 'Meccan' : 'Medinan', s.place),
      chip(`${formatNumber(deg)} connection${deg === 1 ? '' : 's'}`, 'accent'),
      chip(`Surah ${s.n}`),
      chip(`Revelation #${s.order}`),
    );

    const body = document.createDocumentFragment();

    const ar = document.createElement('div');
    ar.className = 'arabic';
    ar.dir = 'rtl';
    ar.lang = 'ar';
    ar.textContent = v.ar;
    body.append(ar);

    const tr = document.createElement('p');
    tr.className = 'verse-tr';
    tr.textContent = translationText(index);
    body.append(tr);

    const credit = document.createElement('div');
    credit.className = 'tr-credit';
    const trMeta = translationMeta();
    credit.textContent = `${trMeta.name} — ${trMeta.note}`;
    body.append(credit);

    const prev = v.a > 1 ? index - 1 : null;
    const next = v.a < s.verses ? index + 1 : null;
    if (prev != null || next != null) {
      const ctx = document.createElement('div');
      ctx.className = 'verse-context';
      const label = document.createElement('span');
      label.className = 'ctx-label';
      label.textContent = 'Context';
      ctx.append(label);
      if (prev != null) {
        const b = document.createElement('button');
        b.className = 'ctx-link';
        b.textContent = `← ${refOf(prev)}`;
        b.addEventListener('click', () => app.navigate(prev));
        ctx.append(b);
      }
      if (next != null) {
        const b = document.createElement('button');
        b.className = 'ctx-link';
        b.textContent = `${refOf(next)} →`;
        b.addEventListener('click', () => app.navigate(next));
        ctx.append(b);
      }
      body.append(ctx);
    }

    const actions = document.createElement('div');
    actions.className = 'panel-actions';

    const bShare = pill('Share picture', 'primary');
    bShare.addEventListener('click', () => app.share(index));
    const bCopy = pill('Copy link');
    bCopy.addEventListener('click', () => app.copyLink(index));
    const bText = pill('Copy verse');
    bText.addEventListener('click', async () => {
      const text = `${refOf(index)}\n\n${v.ar}\n\n${translationText(index)}`;
      try {
        await navigator.clipboard.writeText(text);
        toast('Verse copied');
      } catch {
        toast('Could not copy');
      }
    });
    const bCtx = pill('Read in context');
    bCtx.addEventListener('click', () => { contextMode = true; renderPanel(index); });
    const bOpen = document.createElement('a');
    bOpen.className = 'pill';
    bOpen.href = `https://quran.com/${v.s}/${v.a}`;
    bOpen.target = '_blank';
    bOpen.rel = 'noopener noreferrer';
    bOpen.textContent = 'Quran.com ↗';
    actions.append(bShare, bCopy, bText, bCtx, bOpen);

    // Keep the actions above the verse text: a long ayah must not push Share
    // below the fold of a laptop panel.
    body.prepend(actions);

    const conns = connectionsOf(index);
    if (!conns.length) {
      const p = document.createElement('p');
      p.className = 'empty-note';
      p.textContent = `No cross-reference from ${state.meta.sourceShort} lands on this verse. It is still part of the whole: use the surah bar or the search to read around it.`;
      body.append(p);
    } else {
      const tools = document.createElement('div');
      tools.className = 'conn-tools';
      const count = document.createElement('span');
      count.textContent = `${formatNumber(conns.length)} connection${conns.length === 1 ? '' : 's'}`;
      const sort = document.createElement('select');
      sort.className = 'conn-sort';
      sort.setAttribute('aria-label', 'Sort connections');
      for (const [value, label] of [['near', 'Nearest'], ['far', 'Furthest'], ['canon', 'Reading order']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        sort.append(option);
      }
      sort.value = connSort;
      sort.addEventListener('change', () => {
        connSort = sort.value;
        renderPanel(index);
      });
      tools.append(count, sort);
      body.append(tools);

      const p0 = posOf(index);
      const order = (rows) => {
        const copy = rows.slice();
        if (connSort === 'near') copy.sort((a, b) => Math.abs(posOf(a.o) - p0) - Math.abs(posOf(b.o) - p0));
        else if (connSort === 'far') copy.sort((a, b) => Math.abs(posOf(b.o) - p0) - Math.abs(posOf(a.o) - p0));
        else copy.sort((a, b) => a.o - b.o);
        return copy;
      };
      const outgoing = order(conns.filter((c) => c.dir === 1));
      const incoming = order(conns.filter((c) => c.dir === -1));
      if (outgoing.length) body.append(connectionSection('This verse points to', outgoing, '→'));
      if (incoming.length) body.append(connectionSection('Points to this verse', incoming, '←'));
    }

    els.pBody.replaceChildren(body);
    els.pBody.scrollTop = 0;
    applyCategoryFilterToPanel();
  }

  function applyCategoryFilterToPanel() {
    if (state.category < 0) return;
    for (const row of els.pBody.querySelectorAll('.conn')) {
      const cat = +row.dataset.cat;
      row.style.display = cat === state.category ? '' : 'none';
    }
  }

  function connectionSection(title, rows, arrow) {
    const frag = document.createDocumentFragment();
    const h = document.createElement('div');
    h.className = 'section-title';
    const left = document.createElement('span');
    left.textContent = title;
    const right = document.createElement('span');
    right.textContent = `${rows.length}`;
    h.append(left, right);
    frag.append(h);

    const STEP = 12;
    let shown = Math.min(STEP, rows.length);
    for (const c of rows.slice(0, shown)) frag.append(connectionRow(c, arrow));

    if (rows.length > shown) {
      const more = document.createElement('div');
      more.className = 'more';
      const update = () => {
        const remaining = rows.length - shown;
        if (remaining <= 0) { more.remove(); return; }
        const b = document.createElement('button');
        b.className = 'conn-more';
        b.textContent = `Show ${Math.min(STEP, remaining)} more`;
        b.addEventListener('click', () => {
          const parent = more.parentNode;
          const next = rows.slice(shown, shown + STEP);
          for (const c of next) parent.insertBefore(connectionRow(c, arrow), more);
          shown += next.length;
          update();
        });
        more.replaceChildren(b);
      };
      update();
      frag.append(more);
    }
    return frag;
  }

  function connectionRow(c, arrow) {
    const o = c.o;
    const s = surahOf(o);
    const b = document.createElement('button');
    b.className = 'conn';
    b.dataset.cat = c.cat;
    b.title = `Open ${refOf(o)}`;

    const top = document.createElement('div');
    top.className = 'conn-top';
    const ref = document.createElement('span');
    ref.className = 'conn-ref';
    ref.textContent = `${arrow} ${refOf(o)}`;
    const name = document.createElement('span');
    name.className = 'conn-name';
    name.textContent = `${s.name} · verse ${state.quran.verses[o].a} of ${s.verses}`;
    name.title = `${s.english} · ${s.place === 'meccan' ? 'Meccan' : 'Medinan'}`;
    const cat = document.createElement('span');
    cat.className = 'conn-cat';
    cat.textContent = categoryName(c.cat);
    if (state.categories.length > 1) top.append(ref, name, cat);
    else top.append(ref, name);

    const ar = document.createElement('div');
    ar.className = 'conn-ar';
    ar.dir = 'rtl';
    ar.lang = 'ar';
    ar.textContent = state.quran.verses[o].ar;

    const tr = document.createElement('div');
    tr.className = 'conn-tr';
    tr.textContent = translationText(o);

    const why = document.createElement('div');
    why.className = 'conn-why';
    why.textContent = connectionWhy(c);

    b.append(top, why, ar, tr);
    b.addEventListener('click', () => app.navigate(o, { fitConnections: true }));
    return b;
  }

  function connectionWhy(c) {
    const name = categoryName(c.cat);
    if (state.categories.length > 1) {
      return `${name} — ${CATEGORY_BLURB[name] || 'related passage'}`;
    }
    return `${state.meta.sourceShort} · ${name}`;
  }

  function renderContext(index) {
    const s = surahOf(index);
    const frag = document.createDocumentFragment();

    const actions = document.createElement('div');
    actions.className = 'panel-actions';
    const back = pill('← Back to connections', 'primary');
    back.addEventListener('click', () => { contextMode = false; renderPanel(index); });
    actions.append(back);
    frag.append(actions);

    const h = document.createElement('div');
    h.className = 'section-title';
    const left = document.createElement('span');
    left.textContent = `Surah ${s.n} · ${s.name}`;
    const right = document.createElement('span');
    right.textContent = `${s.verses} verses`;
    h.append(left, right);
    frag.append(h);

    for (let a = 0; a < s.verses; a++) {
      const vi = s.start + a;
      const b = document.createElement('button');
      b.className = 'ctx-verse' + (vi === index ? ' current' : '');
      const r = document.createElement('div');
      r.className = 'ctx-ref';
      r.textContent = `${s.n}:${a + 1}`;
      const ar = document.createElement('div');
      ar.className = 'ctx-ar';
      ar.dir = 'rtl';
      ar.lang = 'ar';
      ar.textContent = state.quran.verses[vi].ar;
      const tr = document.createElement('div');
      tr.className = 'ctx-tr';
      tr.textContent = translationText(vi);
      b.append(r, ar, tr);
      b.addEventListener('click', () => app.navigate(vi));
      frag.append(b);
    }

    els.pBody.replaceChildren(frag);
    els.pBody.scrollTop = 0;
    const current = els.pBody.querySelector('.current');
    if (current) current.scrollIntoView({ block: 'center' });
  }

  function renderPanel(index) {
    if (contextMode) {
      panelIndex = index;
      view.setSelected(index);
      markActiveSurah(index);
      const v = state.quran.verses[index];
      const s = surahOf(index);
      els.pRef.textContent = refOf(index);
      els.pSub.textContent = `${s.name} · ${s.english} · verse ${v.a} of ${s.verses}`;
      els.pChips.replaceChildren(
        chip(s.place === 'meccan' ? 'Meccan' : 'Medinan', s.place),
        chip(`${formatNumber(state.degree[index])} connections`, 'accent'),
      );
      renderContext(index);
      return;
    }
    renderDetails(index);
  }

  function pill(text, cls = '') {
    const b = document.createElement('button');
    b.className = `pill ${cls}`.trim();
    b.textContent = text;
    return b;
  }

  /* ------------------------------------------------------------- tooltip */

  function showTooltip(info) {
    if (!info) {
      els.tooltip.hidden = true;
      return;
    }

    if (info.surah) {
      const s = info.surah;
      const { x, y } = info;
      els.tooltip.replaceChildren();
      const r = document.createElement('div');
      r.className = 'tt-ref';
      r.textContent = `Surah ${s.n}`;
      const m = document.createElement('div');
      m.className = 'tt-meta';
      m.textContent = `${s.name} · ${s.english}`;
      const d = document.createElement('div');
      d.className = 'tt-deg';
      d.textContent = `${s.verses} verses · click to fit connections`;
      els.tooltip.append(r, m, d);
      els.tooltip.hidden = false;
      const stage = $('#stage').getBoundingClientRect();
      const left = Math.max(70, Math.min(stage.width - 70, x));
      els.tooltip.style.left = `${left}px`;
      els.tooltip.style.top = `${Math.max(52, y - 12)}px`;
      return;
    }

    const { index, x, y } = info;
    const s = surahOf(index);
    const deg = state.degree[index];
    els.tooltip.replaceChildren();
    const r = document.createElement('div');
    r.className = 'tt-ref';
    r.textContent = refOf(index);
    const m = document.createElement('div');
    m.className = 'tt-meta';
    m.textContent = `${s.name} · ${s.english}`;
    const d = document.createElement('div');
    d.className = 'tt-deg';
    d.textContent = `${formatNumber(deg)} connection${deg === 1 ? '' : 's'}`;
    els.tooltip.append(r, m, d);
    els.tooltip.hidden = false;

    const stage = $('#stage').getBoundingClientRect();
    const left = Math.max(70, Math.min(stage.width - 70, x));
    els.tooltip.style.left = `${left}px`;
    els.tooltip.style.top = `${Math.max(52, y - 12)}px`;
  }

  /* -------------------------------------------------------------- search */

  function closeResults() {
    els.results.hidden = true;
    els.search.setAttribute('aria-expanded', 'false');
    searchActive = -1;
  }

  function runSearch() {
    const q = els.search.value.trim();
    if (!q) { closeResults(); return; }
    searchItems = [];
    const frag = document.createDocumentFragment();

    const ref = parseReference(q);
    if (ref && ref.surah) {
      const s = state.quran.surahs[ref.surah - 1];
      if (ref.ayah) {
        const idx = s.start + ref.ayah - 1;
        if (ref.ayah <= s.verses) {
          const item = indexItem(idx, `Go to ${refOf(idx)}`);
          searchItems.push(item);
          frag.append(item.el);
        }
      } else {
        const item = surahItem(s);
        searchItems.push(item);
        frag.append(item.el);
      }
    } else if (ref) {
      const item = indexItem(ref.index, `Go to ${refOf(ref.index)}`);
      searchItems.push(item);
      frag.append(item.el);
    }

    for (const hit of searchText(q, 8)) {
      if (searchItems.length >= 9) break;
      const idx = hit.index;
      const b = document.createElement('button');
      b.className = 'result';
      b.setAttribute('role', 'option');
      const top = document.createElement('div');
      top.className = 'result-top';
      const r = document.createElement('span');
      r.className = 'result-ref';
      r.textContent = refOf(idx);
      const n = document.createElement('span');
      n.className = 'result-name';
      const s = surahOf(idx);
      n.textContent = `${s.name} · ${s.english}`;
      top.append(r, n);
      const t = document.createElement('div');
      t.className = 'result-text';
      if (hit.arabic) {
        t.dir = 'rtl';
        t.lang = 'ar';
        t.textContent = state.quran.verses[idx].ar;
      } else {
        t.append(snippet(translationText(idx), hit.at, q.length));
      }
      b.append(top, t);
      b.addEventListener('click', () => { chooseSearch(idx); });
      searchItems.push({ index: idx, el: b });
      frag.append(b);
    }

    if (!searchItems.length) {
      const d = document.createElement('div');
      d.className = 'result-empty';
      d.textContent = 'Nothing found. Try “2:255”, “Al-Baqarah”, or a word from the translation.';
      frag.append(d);
    }

    els.results.replaceChildren(frag);
    els.results.hidden = false;
    els.search.setAttribute('aria-expanded', 'true');
    searchActive = -1;
  }

  function indexItem(idx, label) {
    const s = surahOf(idx);
    const b = document.createElement('button');
    b.className = 'result';
    b.setAttribute('role', 'option');
    const top = document.createElement('div');
    top.className = 'result-top';
    const r = document.createElement('span');
    r.className = 'result-ref';
    r.textContent = label;
    const n = document.createElement('span');
    n.className = 'result-name';
    n.textContent = `${s.name} · ${s.english}`;
    top.append(r, n);
    const t = document.createElement('div');
    t.className = 'result-text';
    t.textContent = translationText(idx).slice(0, 130) + '…';
    b.append(top, t);
    b.addEventListener('click', () => chooseSearch(idx));
    return { index: idx, el: b };
  }

  function surahItem(s) {
    const b = document.createElement('button');
    b.className = 'result';
    b.setAttribute('role', 'option');
    const top = document.createElement('div');
    top.className = 'result-top';
    const r = document.createElement('span');
    r.className = 'result-ref';
    r.textContent = `Surah ${s.n}`;
    const n = document.createElement('span');
    n.className = 'result-name';
    n.textContent = `${s.name} · ${s.english} · ${s.verses} verses`;
    top.append(r, n);
    b.append(top);
    b.addEventListener('click', () => {
      closeResults();
      view.focusPos(s.start, s.start + s.verses);
      app.navigate(s.start, { fromBar: true });
    });
    return { index: s.start, el: b, surah: s };
  }

  function chooseSearch(idx) {
    closeResults();
    els.search.blur();
    app.navigate(idx);
  }

  function highlightResult() {
    searchItems.forEach((it, i) => {
      const on = i === searchActive;
      it.el.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) it.el.scrollIntoView({ block: 'nearest' });
    });
  }

  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 90);
  });

  els.search.addEventListener('focus', () => {
    if (els.search.value.trim()) runSearch();
  });

  els.search.addEventListener('keydown', (e) => {
    if (els.results.hidden) return;
    // Keep search keys from reaching the document-level shortcuts; Escape in
    // the search box means "close the results", not "close the verse panel".
    e.stopPropagation();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      searchActive = Math.min(searchItems.length - 1, searchActive + 1);
      highlightResult();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      searchActive = Math.max(0, searchActive - 1);
      highlightResult();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = searchItems[searchActive >= 0 ? searchActive : 0];
      if (item) {
        if (item.surah) {
          closeResults();
          view.focusPos(item.surah.start, item.surah.start + item.surah.verses);
          app.navigate(item.surah.start, { fromBar: true });
        } else {
          chooseSearch(item.index);
        }
      }
    } else if (e.key === 'Escape') {
      closeResults();
      els.search.blur();
    }
  });

  document.addEventListener('pointerdown', (e) => {
    if (!els.results.hidden && !e.target.closest('.searchbox')) closeResults();
  });

  /* --------------------------------------------------------------- modal */

  function openModal(html) {
    els.modalBody.replaceChildren(html);
    els.modal.hidden = false;
  }

  function closeModal() { els.modal.hidden = true; }

  function about() {
    const m = state.meta;
    const shia = state.mode === 'shia';
    const privacy = window.QCR_CLARITY_ID
      ? 'This public build uses <a href="https://clarity.microsoft.com" target="_blank" rel="noopener">Microsoft Clarity</a> for aggregate usage analytics and session recordings. Recordings may include the unlock screen. No accounts. The text, links and fonts are served from this site, and a service worker keeps them on your device after the first visit.'
      : 'No analytics are enabled in this build. No accounts and no third-party requests; the text, links and fonts are served from this site, and a service worker keeps them on your device after the first visit.';
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <h2 id="modal-title">Quran Cross-References</h2>
      <p class="small">All 6,236 verses of the Quran on one line, with ${formatNumber(state.linkCount)} ${m.sourceShort} cross-references drawn as arcs. Reading the <b>${m.label}</b> corpus.</p>

      <h3>What am I looking at?</h3>
      <p>Every verse sits on the baseline in reading order, from <code>1:1</code> to <code>114:6</code>. Each arc joins two verses that ${m.sourceName}, in <i>${m.sourceWork}</i>, read together. Each arc carries the colour of both ends: teal for a Meccan verse, amber for a Medinan one, so a link between the two fades from one to the other across the arc.</p>
      <p>Zoom in with the wheel or a pinch; drag to pan; click a verse for its text and every connection. The surah bar jumps to a surah, and <code>Reset</code> returns to the whole Quran. The <b>Shia / Sunni</b> switch at the top changes the corpus and the default translation; they are two separate maps, not a filter.</p>
      <p>The <b>Connections</b> menu either draws every link at once, or draws only the links of the verse you hover or open. Clicking a surah — its field on the map, its name, or its bar segment — zooms out just enough to bring its whole connection envelope into view. Click the axis itself to open a verse.</p>

      <h3>Keyboard</h3>
      <p><span class="kbd">←</span> <span class="kbd">→</span> move verse &nbsp; <span class="kbd">+</span> <span class="kbd">−</span> zoom &nbsp; <span class="kbd">0</span> reset &nbsp; <span class="kbd">/</span> search &nbsp; <span class="kbd">R</span> random &nbsp; <span class="kbd">Esc</span> close</p>

      <h3>Data</h3>
      <ul>
        ${shia
          ? `<li><b>Cross-references</b> — Allamah Muhammad Husayn Tabataba'i (d. 1981), <i>al-Mizan fi Tafsir al-Qur'an</i>, the Quran-by-Quran tafsir. ${formatNumber(state.linkCount)} verse-to-verse references extracted from the Arabic original; 87% of verses covered. Data packaging: <a href="${m.sourceUrl}" target="_blank" rel="noopener">app-furqan/quran-app-data</a>, CC BY-ND 4.0.</li>`
          : `<li><b>Cross-references</b> — Ibn Ashur (d. 1973), <i>al-Tahrir wa al-Tanwir</i>, extracted into the <a href="${m.sourceUrl}" target="_blank" rel="noopener">quran-bil-quran-connections</a> dataset (Apache-2.0). ${formatNumber(state.linkCount)} verse-to-verse links, 87% of verses covered.</li>`}
        <li><b>Arabic text</b> — Uthmani script, <a href="https://api.quran.com" target="_blank" rel="noopener">Quran.com Content API v4</a>.</li>
        <li><b>Translations</b> — Ali Quli Qara'i and Muhammad Sarwar (Shia); M. Pickthall (1930) and A. Yusuf Ali (1934), both public domain.</li>
        <li><b>Surah metadata</b> — names, revelation place, verse counts, revelation order, via the same API.</li>
      </ul>
      <p class="small">This is a reading aid, not a tafsir. A cross-reference is one scholar's judgement that two passages belong together; it is not a claim that they say the same thing. For worship and rulings, read the verse in its surah and consult a qualified teacher.</p>
      ${shia ? '<p class="small"><b>Data note.</b> The al-Mizan packaging is CC BY-ND 4.0. This build includes derived verse pairs with attribution; see <a href="./data/README.md">data/README.md</a>.</p>' : ''}

      <h3>Privacy</h3>
      <p class="small">${privacy}</p>
      <p class="small">Renderer: <b>${view.isGL ? 'WebGL2' : 'Canvas2D fallback'}</b>${view.isGL && view.glRenderer ? ` · ${String(view.glRenderer).slice(0, 90)}` : ''} · ${formatNumber(state.linkCount)} links · build ${app.build || '?'}. ${view.isGL ? '' : 'If this says fallback, enable hardware acceleration in the browser for the smooth view.'}</p>
    `;
    openModal(wrap);
  }

  function sourceNote() {
    const m = state.meta;
    const shia = state.mode === 'shia';
    const wrap = document.createElement('div');
    wrap.innerHTML = shia
      ? `
      <h2 id="modal-title">Where the connections come from</h2>
      <p>Al-Mizan is built on the principle of <i>al-Qur'an yufassiru ba'dahu ba'dan</i>: the Quran explains itself. While commenting on a passage, Allamah Tabataba'i gathers the verses that qualify, parallel, or complete it, and reads them together.</p>
      <p>This map keeps the verse-to-verse references he draws. The Arabic tafsir's 594 passages cover all 6,236 ayahs; ${formatNumber(m.references)} references were extracted and joined to the verses of the passage they comment on. Only the reference pairs are stored — no tafsir text is copied into this repository.</p>
      <p class="small">Source: <a href="${m.sourceUrl}" target="_blank" rel="noopener">app-furqan/quran-app-data</a> (CC BY-ND 4.0). Arabic original: <i>al-Mizan fi Tafsir al-Qur'an</i>, Allamah Sayyid Muhammad Husayn Tabataba'i (d. 1981).</p>
    `
      : `
      <h2 id="modal-title">Where the connections come from</h2>
      <p>Every arc is a place where Ibn Ashur, in <i>al-Tahrir wa al-Tanwir</i> (1964–1973), read one verse through another. The pairs were extracted verse by verse, and each pair keeps the kind of relation he drew:</p>
      <ul>
        <li><b>Bayani</b> — one verse clarifies another.</li>
        <li><b>Siyaqi</b> — shared context or narrative.</li>
        <li><b>Tafsili</b> — one verse expands another.</li>
        <li><b>Uslubi</b> — shared rhetorical form.</li>
        <li><b>Lughawi</b> — a word or usage links them.</li>
        <li><b>Tawfiqi</b>, <b>Takhsis</b>, <b>Nazmi</b>, <b>Taqyid</b>, <b>Muhkam-based</b>, <b>Naskh</b> — narrower categories.</li>
      </ul>
      <p>Use the <b>connection type</b> menu to show one kind at a time.</p>
      <p class="small">Dataset: <a href="${m.sourceUrl}" target="_blank" rel="noopener">ShahamFarooq/quran-bil-quran-connections</a>, Apache-2.0. See also <a href="https://ulumaldata.substack.com/p/ibn-ashurs-quran-bil-quran-visualized" target="_blank" rel="noopener">the write-up</a>.</p>
    `;
    openModal(wrap);
  }

  $('#modal-close').addEventListener('click', closeModal);
  els.modal.addEventListener('click', (e) => { if (e.target === els.modal) closeModal(); });
  $('#about-btn').addEventListener('click', about);
  $('#source-btn').addEventListener('click', sourceNote);

  /* ---------------------------------------------------------------- share */

  async function shareCard(index) {
    const canvas = await drawCard(index);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const url = URL.createObjectURL(blob);
    const file = new File([blob], `quran-${keyOf(index).replace(':', '-')}.png`, { type: 'image/png' });

    const wrap = document.createElement('div');
    const h = document.createElement('h2');
    h.id = 'modal-title';
    h.textContent = `Share ${refOf(index)}`;
    const img = document.createElement('img');
    img.src = url;
    img.alt = `Share card for ${refOf(index)}`;
    img.style.cssText = 'width:100%;border-radius:12px;margin:14px 0;border:1px solid var(--line)';
    const row = document.createElement('div');
    row.className = 'panel-actions';

    const dl = pill('Download PNG', 'primary');
    dl.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.click();
    });
    row.append(dl);

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      const sh = pill('Share…');
      sh.addEventListener('click', () => navigator.share({ files: [file], title: refOf(index) }).catch(() => {}));
      row.append(sh);
    }
    wrap.append(h, img, row);
    openModal(wrap);
  }

  async function drawCard(index) {
    const W = 1080, H = 1350;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const pal = readPalette();

    if (document.fonts) {
      try { await document.fonts.load('44px "Amiri Quran"'); } catch { /* fallback */ }
      try { await document.fonts.load('600 28px ui-sans-serif'); } catch { /* fallback */ }
    }

    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#0b1420');
    g.addColorStop(0.55, '#0a111a');
    g.addColorStop(1, '#131a16');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // A quiet halo behind the verse.
    const halo = ctx.createRadialGradient(W * 0.5, 330, 20, W * 0.5, 330, 620);
    halo.addColorStop(0, 'rgba(230,193,124,.10)');
    halo.addColorStop(1, 'rgba(230,193,124,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, W, 900);

    const s = surahOf(index);
    ctx.fillStyle = '#e6c17c';
    ctx.font = '600 22px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.letterSpacing = '4px';
    ctx.fillText('QURAN CROSS-REFERENCES', 80, 92);
    ctx.letterSpacing = '0px';

    ctx.fillStyle = '#f4efe4';
    ctx.font = '600 52px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(refOf(index), 80, 158);

    ctx.fillStyle = 'rgba(244,239,228,.62)';
    ctx.font = '26px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(`${s.name} · ${s.english}`, 80, 198);

    ctx.save();
    ctx.direction = 'rtl';
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(244,239,228,.8)';
    ctx.font = '34px "Amiri Quran"';
    ctx.fillText(s.arabic, W - 80, 156);
    ctx.restore();

    // Arabic, right aligned and wrapped.
    ctx.direction = 'rtl';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#fbf7ee';
    const arLines = wrapText(ctx, state.quran.verses[index].ar, W - 160, 74, '44px "Amiri Quran"', 6);
    let y = 300;
    ctx.font = '44px "Amiri Quran"';
    for (const line of arLines) {
      ctx.fillText(line, W - 80, y);
      y += 74;
    }

    // Translation.
    const trLines = wrapText(ctx, translationText(index), W - 160, 42, '30px Georgia, serif', 9);
    y = Math.max(y + 24, 470);
    ctx.direction = 'ltr';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(244,239,228,.86)';
    ctx.font = '30px Georgia, serif';
    for (const line of trLines) {
      ctx.fillText(line, 80, y);
      y += 42;
    }

    ctx.fillStyle = 'rgba(244,239,228,.4)';
    ctx.font = '18px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(translationCredit(), 80, y + 8);

    // Mini arc diagram: the whole Quran as a baseline, this verse's links lit.
    const bx = 80, bw = W - 160, by = 1140;
    ctx.strokeStyle = 'rgba(244,239,228,.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + bw, by);
    ctx.stroke();

    const posOfVerse = state.posOfVerse;
    const xAt = (p) => bx + (p / 6236) * bw;

    const p = posOfVerse[index];
    const x0 = xAt(p);
    const focusPath = new Path2D();
    for (const e of connectionsOf(index)) {
      const x2 = xAt(posOfVerse[e.o]);
      const d = Math.abs(x2 - x0);
      const h = Math.min(150, 5 + Math.pow(d, 0.72) * 1.1);
      focusPath.moveTo(x0, by);
      focusPath.quadraticCurveTo((x0 + x2) / 2, by - h * 2, x2, by);
    }
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = 'rgba(230,193,124,.95)';
    ctx.stroke(focusPath);
    ctx.fillStyle = '#e6c17c';
    ctx.beginPath();
    ctx.arc(x0, by, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(244,239,228,.55)';
    ctx.font = '18px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(`${formatNumber(state.degree[index])} connections · all 6,236 verses`, 80, by + 34);

    ctx.fillStyle = 'rgba(244,239,228,.32)';
    ctx.font = '16px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(`Cross-references: ${state.meta.sourceName}, ${state.meta.sourceWork}`, 80, H - 54);
    ctx.textAlign = 'right';
    ctx.fillText('quran cross-references', W - 80, H - 54);

    void pal;
    return c;
  }

  function translationCredit() {
    const t = translationMeta();
    return `${t.name} — ${t.note}`;
  }

  function readPalette() {
    const cs = getComputedStyle(document.documentElement);
    return { accent: cs.getPropertyValue('--accent').trim() };
  }

  function wrapText(ctx, text, maxWidth, lineHeight, font, maxLines) {
    ctx.font = font;
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
        if (lines.length === maxLines - 1) break;
      } else {
        line = test;
      }
    }
    if (line && lines.length < maxLines) lines.push(line);
    if (lines.length === maxLines) {
      const last = lines[maxLines - 1];
      if (ctx.measureText(last).width > maxWidth - 30) {
        lines[maxLines - 1] = last.slice(0, Math.max(0, last.length - 2)) + '…';
      }
    }
    void lineHeight;
    return lines;
  }

  /* --------------------------------------------------------------- public */

  return {
    openPanel,
    closePanel,
    renderPanel,
    renderContext,
    renderSurahBar,
    renderStats,
    markActiveSurah,
    showTooltip,
    shareCard,
    toast,
    openModal,
    closeModal,
    updateSurahLabels,
    get panelIndex() { return panelIndex; },
  };
}
