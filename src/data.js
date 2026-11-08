/**
 * Data loading and derived indexes.
 * Everything is fetched once, from this repository only. No runtime third parties.
 *
 * Two interpretive traditions are shipped:
 *  - Shia (default): al-Mizan, the Quran-by-Quran tafsir of Allamah Tabataba'i
 *  - Sunni: al-Tahrir wa al-Tanwir of Ibn Ashur
 * They share the same 6,236-verse axis and surah metadata; only the link
 * corpus, the source labels and the default translation change.
 */

const nf = new Intl.NumberFormat('en');

export const TRANSLATIONS = [
  { slug: 'qarai', name: "Ali Quli Qara'i", note: 'Shia scholar, phrase-by-phrase', tradition: 'shia' },
  { slug: 'sarwar', name: 'Muhammad Sarwar', note: 'Shia scholar', tradition: 'shia' },
  { slug: 'pickthall', name: 'M. Pickthall', note: '1930, public domain', tradition: 'sunni' },
  { slug: 'yusufali', name: 'A. Yusuf Ali', note: '1934, public domain', tradition: 'sunni' },
];

export const MODES = {
  shia: {
    label: 'Shia',
    defaultTranslation: 'qarai',
    blurb: "Allamah Tabataba'i, al-Mizan",
  },
  sunni: {
    label: 'Sunni',
    defaultTranslation: 'pickthall',
    blurb: 'Ibn Ashur, al-Tahrir wa al-Tanwir',
  },
};

export const state = {
  quran: null,
  mode: 'shia',
  meta: null,
  links: null,          // [src, dst, categoryIndex, weight] flattened
  linkCount: 0,
  adjacency: null,      // adjacency[verseIndex] = [{ o, dir, cat, w }]
  degree: null,
  categories: [],
  translation: 'qarai',
  translations: {},
  order: 'mushaf',
  category: -1,
  linksMode: 'all',      // 'all' | 'focus'
  activeSurah: null,     // surah last opened from the surah bar
  posOfVerse: null,
  verseAtPos: null,
  surahOrder: [],
  selected: null,
  hovered: null,
};

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

export async function loadBase() {
  const quran = await getJson('./data/quran.json');
  state.quran = quran;
  setOrder('mushaf');
  return quran;
}

/**
 * Switch the link corpus. The caller reloads the default translation and
 * rebuilds the renderer; this function only owns the data.
 */
export async function loadMode(mode) {
  // The Sunni corpus predates the mode switch and keeps its original files.
  const linksP = mode === 'sunni'
    ? getJson('./data/links.json')
    : getJson(`./data/links-${mode}.json`);
  const degreeP = mode === 'sunni'
    ? Promise.resolve(state.quran.degree)
    : getJson(`./data/degree-${mode}.json`);
  const [links, degree, meta] = await Promise.all([
    linksP, degreeP, getJson(`./data/meta-${mode}.json`),
  ]);
  state.mode = mode;
  state.meta = meta;
  state.links = links;
  state.linkCount = links.length;
  state.degree = degree;
  state.categories = meta.categories || [];
  state.category = -1;
  buildAdjacency();
}

export async function loadTranslation(slug) {
  if (state.translations[slug]) return state.translations[slug];
  const rows = await getJson(`./data/translation-${slug}.json`);
  state.translations[slug] = rows;
  return rows;
}

function buildAdjacency() {
  const adj = Array.from({ length: 6236 }, () => []);
  const links = state.links;
  for (let i = 0; i < links.length; i++) {
    const [s, d, cat, w] = links[i];
    adj[s].push({ o: d, dir: 1, cat, w });
    adj[d].push({ o: s, dir: -1, cat, w });
  }
  state.adjacency = adj;
}

/* ------------------------------------------------------------- ordering */

export function setOrder(kind) {
  state.order = kind;
  const surahs = state.quran.surahs;
  const order = surahs.map((s, i) => i);
  if (kind === 'revelation') order.sort((a, b) => surahs[a].order - surahs[b].order);

  const posOfVerse = new Uint16Array(6236);
  const verseAtPos = new Uint16Array(6236);
  let p = 0;
  for (const si of order) {
    const s = surahs[si];
    for (let a = 0; a < s.verses; a++) {
      const vi = s.start + a;
      posOfVerse[vi] = p;
      verseAtPos[p] = vi;
      p++;
    }
  }
  state.posOfVerse = posOfVerse;
  state.verseAtPos = verseAtPos;
  state.surahOrder = order;
}

/* --------------------------------------------------------------- helpers */

export function verseIndex(surah, ayah) {
  const s = state.quran.surahs[surah - 1];
  if (!s || ayah < 1 || ayah > s.verses) return null;
  return s.start + ayah - 1;
}

export function verseAt(index) {
  return state.quran.verses[index];
}

export function keyOf(index) {
  const v = state.quran.verses[index];
  return `${v.s}.${v.a}`;
}

export function surahOf(index) {
  const v = state.quran.verses[index];
  return state.quran.surahs[v.s - 1];
}

export function refOf(index) {
  const v = state.quran.verses[index];
  return `${v.s}:${v.a}`;
}

export function posOf(index) {
  return state.posOfVerse[index];
}

export function verseAtPos(pos) {
  return state.verseAtPos[Math.max(0, Math.min(6235, Math.round(pos)))];
}

export function translationText(index) {
  const rows = state.translations[state.translation];
  return rows ? rows[index] : '';
}

export function translationMeta(slug = state.translation) {
  return TRANSLATIONS.find((t) => t.slug === slug) || TRANSLATIONS[0];
}

export function connectionsOf(index) {
  return state.adjacency[index] || [];
}

/**
 * The span that holds a whole surah plus every verse it is connected to.
 * Used when clicking a surah: zoom out just enough to see all its links.
 */
export function surahEnvelope(number) {
  const s = state.quran.surahs[number - 1];
  if (!s) return null;
  let lo = posOf(s.start);
  let hi = posOf(s.start + s.verses - 1);
  const cat = state.category;
  for (let v = s.start; v < s.start + s.verses; v++) {
    for (const e of state.adjacency[v] || []) {
      if (cat >= 0 && e.cat !== cat) continue;
      const p = posOf(e.o);
      if (p < lo) lo = p;
      if (p > hi) hi = p;
    }
  }
  lo = Math.min(lo, posOf(s.start));
  hi = Math.max(hi, posOf(s.start + s.verses - 1));
  const pad = Math.max(2, Math.round((hi - lo) * 0.02));
  return { start: lo - pad, end: hi + pad };
}

export function surahLinkCount(number) {
  const verses = state.quran.verses;
  let n = 0;
  for (const l of state.links) {
    if (verses[l[0]].s === number || verses[l[1]].s === number) n++;
  }
  return n;
}

/**
 * The span holding one verse plus every verse it connects to. Used when a
 * connection is opened from the panel: fit its links instead of diving into
 * a 34-verse window at the target.
 */
export function verseEnvelope(index) {
  const p0 = posOf(index);
  let lo = p0;
  let hi = p0;
  const cat = state.category;
  for (const e of state.adjacency[index] || []) {
    if (cat >= 0 && e.cat !== cat) continue;
    const p = posOf(e.o);
    if (p < lo) lo = p;
    if (p > hi) hi = p;
  }
  if (hi - lo < 2) return { start: p0 - 17, end: p0 + 17, empty: true };
  const pad = Math.max(2, Math.round((hi - lo) * 0.06));
  return { start: lo - pad, end: hi + pad, empty: false };
}

export function surahNumberAtPos(pos) {
  const vi = verseAtPos(pos);
  return state.quran.verses[vi].s;
}

export function formatNumber(n) {
  return nf.format(n);
}

/** Parse "2:255", "2 255", "2.255", "Al-Baqarah 255", "baqarah". */
export function parseReference(raw) {
  const q = raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .trim()
    .toLowerCase();
  if (!q) return null;

  let m = q.match(/^(\d{1,3})\s*[:.\-/\s]\s*(\d{1,3})$/);
  if (m) {
    const idx = verseIndex(+m[1], +m[2]);
    return idx == null ? null : { index: idx };
  }

  m = q.match(/^(\d{1,3})$/);
  if (m && +m[1] <= 114) {
    const s = state.quran.surahs[+m[1] - 1];
    return { surah: s.n, ayah: null };
  }

  m = q.match(/^(.*?)[\s,]+(\d{1,3})$/);
  const namePart = m ? m[1] : q;
  const ayahPart = m ? +m[2] : null;
  const surah = findSurah(namePart);
  if (surah) {
    if (ayahPart && ayahPart <= surah.verses) {
      return { index: surah.start + ayahPart - 1 };
    }
    return { surah: surah.n, ayah: null };
  }
  return null;
}

export function findSurah(query) {
  const q = query.trim().toLowerCase().replace(/^the\s+/, '');
  if (!q) return null;
  const list = state.quran.surahs;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const qn = norm(q);
  if (!qn) return null;
  for (const s of list) {
    if (norm(s.name) === qn || norm(s.english) === qn) return s;
  }
  for (const s of list) {
    if (norm(s.name).startsWith(qn) || norm(s.english).startsWith(qn)) return s;
  }
  for (const s of list) {
    if (norm(s.name).includes(qn) || norm(s.english).includes(qn)) return s;
  }
  return null;
}

export function searchText(query, limit = 8) {
  const q = query.trim();
  if (q.length < 2) return [];

  if (/[\u0600-\u06FF]/.test(q)) {
    const nq = normalizeArabic(q);
    if (!nq) return [];
    const out = [];
    const verses = state.quran.verses;
    for (let i = 0; i < verses.length && out.length < limit; i++) {
      const at = normalizeArabic(verses[i].ar).indexOf(nq);
      if (at >= 0) out.push({ index: i, at, arabic: true });
    }
    return out;
  }

  const ql = q.toLowerCase();
  const rows = state.translations[state.translation];
  if (!rows) return [];
  const out = [];
  for (let i = 0; i < rows.length && out.length < limit; i++) {
    const at = rows[i].toLowerCase().indexOf(ql);
    if (at >= 0) out.push({ index: i, at });
  }
  return out;
}

/** Diacritic- and spelling-insensitive Arabic, for search. */
function normalizeArabic(text) {
  return String(text)
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
    .replace(/\u0640/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();
}

export function categoryName(i) {
  return state.meta?.categories?.[i] || 'Other';
}
