// Normalizator bazy materiałów edukacyjnych — scala cztery źródła w jeden kanoniczny
// zbiór i raport jakości. To jest krok migracyjny 5. modułu Zaplecza; ten sam kod
// zasili później import do Mongo, więc rekord na wyjściu ma już docelowy kształt.
//
// ŹRÓDŁA (kolejność = rosnąca wiarygodność; późniejsze nadpisują wcześniejsze):
//   1. Master baza platforma TIL.xlsx  — umieszczenia, przedmiot, egzamin, linki Dysku
//   2. Master baza ED TIL (2).xlsx     — daty, linki Dysku, tracker rebrandingu
//   3. lrs-prod.csv                    — PRODUKCJA platformy: żywe linki, typ zakupu
//   4. lrs-ed.csv                      — PRODUKCJA ED: żywe linki + tabela wykorzystań
//
// Mastery są sprzed zmiany dostawcy hostingu, więc ich kolumny „publuu" są MARTWE —
// trzymamy je wyłącznie jako ślad historyczny, nigdy jako „gdzie leży materiał".
//
// Użycie:  node scripts/materials-normalize.mjs [--out <katalog>]
// Wejście: „Materiały do gitignore/" (gitignorowane, poza repo).

import fs from 'node:fs';
import path from 'node:path';
import xlsx from 'xlsx';

const SRC = path.join(process.cwd(), 'Materiały do gitignore');
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > -1 ? process.argv[outIdx + 1] : path.join(SRC, 'znormalizowane');

const OID = /^[0-9a-f]{24}$/;

// ---------------------------------------------------------------- mapowanie nagłówków
//
// 51 arkuszy, nagłówki niespójne co do wielkości liter, spacji i nazwy. Tabela poniżej
// jest odpowiedzią na sekcję 3.8 analizy — całe rozjechanie źródeł mieszka tutaj,
// a nie rozsypane po kodzie. Klucz porównujemy po `norm()`.
const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');

const HEADERS = {
  // UWAGA: kurs_id/dzial_id/lekcja_id to TEŻ ObjectId, ale wskazują kurs, dział
  // i lekcję — nie materiał. Pomylenie ich zawyża zbiór o ~1300 pozycji.
  platformId: ['id platformy', 'id platforma', 'id_duzy', 'id'],
  title: ['nazwa materiału', 'nazwa_duzy', 'nazwa'],
  subject: ['przedmiot'],
  examType: ['egzamin'],
  purchaseType: ['typ_zakupu'],
  // Link per plik jest w „POPRAWNY LINK DO MATERIAŁU"; „Link do dysku" w 756 z 781
  // przypadków wskazuje FOLDER, więc ma niższy priorytet.
  driveUrl: ['poprawny link do materiału', 'link do materiału', 'link do dysku google',
    'link do dysku', 'link do wszystkiego z niemieckiego na dysku'],
  legacyUrl: ['link do publuu', 'link'],
  courseId: ['kurs_id'], courseName: ['kurs_nazwa'],
  sectionId: ['dzial_id'], sectionName: ['dzial_nazwa'],
  lessonId: ['lekcja_id'], lessonName: ['lekcja_nazwa'],
  createdAt: ['data_stworzenia'], updatedAt: ['data_ostatniej_aktualizacji'],
  grade: ['klasa']
};

const LOOKUP = new Map();
for (const [field, names] of Object.entries(HEADERS)) {
  names.forEach((n, rank) => {
    if (!LOOKUP.has(n)) LOOKUP.set(n, []);
    LOOKUP.get(n).push({ field, rank });
  });
}

// Z jednego wiersza arkusza wyciąga pola kanoniczne, respektując priorytet wariantów.
function mapRow(row) {
  const out = {};
  const best = {};
  for (const [rawKey, rawVal] of Object.entries(row)) {
    const hits = LOOKUP.get(norm(rawKey));
    if (!hits) continue;
    const val = String(rawVal ?? '').trim();
    if (!val) continue;
    for (const { field, rank } of hits) {
      if (field === 'platformId' && !OID.test(val)) continue;
      if (best[field] !== undefined && best[field] <= rank) continue;
      best[field] = rank;
      out[field] = val;
    }
  }
  return out;
}

// ---------------------------------------------------------------- pomocnicze
const parseDate = (v) => {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/); // d.m.yyyy, bez zer wiodących
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : null;
};

// ObjectId koduje znacznik czasu utworzenia — data powstania dla 100% rekordów.
const dateFromObjectId = (id) =>
  new Date(parseInt(id.slice(0, 8), 16) * 1000).toISOString().slice(0, 10);

const hostOf = (url) => {
  try { return new URL(url).hostname; } catch { return null; }
};

// Typ materiału siedzi w prefiksie nazwy (~60% zbioru); reszta to w większości
// opracowania lektur, rozpoznawalne po wzorcu „Tytuł, Autor".
const TYPE_PREFIXES = ['Prezentacja', 'Materiał dodatkowy', 'Plansza', 'Planer 100 dni',
  'Arkusz próbny E8', 'Arkusz próbny', 'Arkusz E8', 'Karta pracy', 'Notatka', 'Infografika'];
function typeFromName(name) {
  const n = String(name || '').trim();
  for (const p of TYPE_PREFIXES) {
    if (n.toLowerCase().startsWith(p.toLowerCase())) return p;
  }
  if (/^[^,]{2,},\s*[A-ZĄĆĘŁŃÓŚŹŻ]/.test(n)) return 'Opracowanie lektury';
  return null;
}

// „PolishLanguage rozszerzona" → { subject, level }
function splitSubject(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(.*?)\s+(podstawowa|rozszerzona)$/i);
  return m ? { subject: m[1], level: m[2].toLowerCase() } : { subject: s || null, level: null };
}

function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    }
    // Cudzysłów otwiera pole cytowane TYLKO na jego początku. Potraktowanie każdego
    // `"` jako otwierającego sprawia, że pojedynczy cudzysłów w nazwie lekcji połyka
    // kolejne wiersze — w eksporcie ED gubiło to 1544 z 2803 wierszy.
    else if (c === '"' && cell === '') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift().map((h) => h.trim());
  return rows.filter((r) => r.length > 1).map((r) =>
    Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const readSheets = (file) => {
  const wb = xlsx.readFile(file);
  return wb.SheetNames.flatMap((name) =>
    xlsx.utils.sheet_to_json(wb.Sheets[name], { defval: '' }).map((row) => ({ sheet: name, row })));
};

// ---------------------------------------------------------------- scalanie
const materials = new Map();
const usages = [];
const warn = [];

function upsert(id, patch, source) {
  if (!materials.has(id)) {
    materials.set(id, {
      platformId: id, title: null, brands: new Set(), subject: null, level: null,
      grade: null, examType: null, materialType: null,
      createdAt: null, updatedAt: null,
      publishedUrl: null, publishedHost: null, sourceUrl: null, legacyPubluuUrl: null,
      purchaseType: null, paid: null, visible: null,
      rebranded: false, isExternal: false, published: false,
      sources: new Set()
    });
  }
  const m = materials.get(id);
  m.sources.add(source);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '') continue;
    if (k === 'brands') { v.forEach((b) => m.brands.add(b)); continue; }
    if (k === 'rebranded' || k === 'isExternal' || k === 'published') { m[k] = m[k] || v; continue; }
    m[k] = v; // późniejsze źródło wygrywa — kolejność wczytywania = wiarygodność
  }
  return m;
}

function addUsage(id, r, origin) {
  if (!r.courseId && !r.lessonId) return;
  usages.push({
    platformId: id, origin,
    courseId: r.courseId || null, courseName: r.courseName || null,
    sectionId: r.sectionId || null, sectionName: r.sectionName || null,
    lessonId: r.lessonId || null, lessonName: r.lessonName || null
  });
}

// --- 1. Master platformowy ---------------------------------------------------
for (const { sheet, row } of readSheets(path.join(SRC, 'Master baza platforma TIL.xlsx'))) {
  const r = mapRow(row);
  if (!r.platformId) continue;
  const { subject, level } = splitSubject(r.subject);
  const m = upsert(r.platformId, {
    title: r.title, subject, level, examType: r.examType,
    purchaseType: r.purchaseType,
    sourceUrl: r.driveUrl, legacyPubluuUrl: r.legacyUrl,
    createdAt: parseDate(r.createdAt), updatedAt: parseDate(r.updatedAt)
  }, 'master-platforma');
  m.sheets = m.sheets || new Set();
  m.sheets.add(sheet);
  addUsage(r.platformId, r, 'master-platforma');
}

// --- 2. Master ED ------------------------------------------------------------
// Arkusz „zmienione już przy platformie" to nie dane, tylko STATUS zaszyty w nazwie
// zakładki: 1208 materiałów po rebrandingu. Ta wiedza istnieje wyłącznie tutaj.
for (const { sheet, row } of readSheets(path.join(SRC, 'Master baza ED TIL (2).xlsx'))) {
  const r = mapRow(row);
  if (!r.platformId) continue;
  const { subject, level } = splitSubject(r.subject);
  upsert(r.platformId, {
    title: r.title, subject, level,
    sourceUrl: r.driveUrl, legacyPubluuUrl: r.legacyUrl,
    createdAt: parseDate(r.createdAt), updatedAt: parseDate(r.updatedAt),
    brands: ['Szkoła Maturalnych'],
    rebranded: /zmienione/i.test(sheet)
  }, 'master-ed');
  addUsage(r.platformId, r, 'master-ed');
}

// --- 3. Produkcja: platforma -------------------------------------------------
for (const row of readCsv(path.join(SRC, 'lrs-prod.csv'))) {
  const id = row._id;
  if (!OID.test(id || '')) continue;
  if (String(row.title).trim().toLowerCase() === 'test test test') {
    warn.push({ kind: 'rekord-testowy', platformId: id, detail: row.title });
    continue;
  }
  const brands = [];
  if (row.examType === 'matura') brands.push('Maturalni');
  if (row.examType === 'primaryschoolexam') brands.push('KursyE8');
  upsert(id, {
    title: row.title, examType: row.examType,
    publishedUrl: row.url || null, publishedHost: hostOf(row.url),
    purchaseType: row.purchaseType,
    paid: row.paid === 'true', visible: row.visible === 'true',
    published: true, brands
  }, 'prod-platforma');
}

// --- 4. Produkcja: ED (zawiera tabelę wykorzystań) ---------------------------
for (const row of readCsv(path.join(SRC, 'lrs-ed.csv'))) {
  const id = row.id;
  if (!OID.test(id || '')) continue;
  const r = mapRow(row);
  const { subject, level } = splitSubject(row.przedmiot);
  const host = hostOf(row.link);
  // zpe.gov.pl = Zintegrowana Platforma Edukacyjna, treść RZĄDOWA używana w kursach.
  // To nie jest nasz materiał — oznaczamy, nie wyrzucamy, bo wykorzystanie jest realne.
  const external = host === 'zpe.gov.pl';
  upsert(id, {
    title: row.nazwa, subject, level, grade: row.klasa,
    publishedUrl: row.link || null, publishedHost: host,
    createdAt: parseDate(row.data_stworzenia), updatedAt: parseDate(row.data_ostatniej_aktualizacji),
    published: true, isExternal: external,
    brands: external ? [] : ['Szkoła Maturalnych']
  }, 'prod-ed');
  addUsage(id, r, 'prod-ed');
}

// --- domknięcia --------------------------------------------------------------
for (const m of materials.values()) {
  if (!m.createdAt) m.createdAt = dateFromObjectId(m.platformId);
  if (!m.materialType) m.materialType = typeFromName(m.title);
  // Mastery są sprzed zmiany dostawcy — ich link „publuu" nigdy nie jest publikacją.
  if (m.publishedUrl && /publuu\.com/.test(m.publishedUrl)) {
    m.legacyPubluuUrl = m.publishedUrl;
    m.publishedUrl = null; m.publishedHost = null;
  }
  if (!m.brands.size && !m.isExternal) {
    warn.push({ kind: 'brak-marki', platformId: m.platformId, detail: m.title });
  }
  if (!m.publishedUrl && !m.sourceUrl && !m.isExternal) {
    warn.push({ kind: 'brak-jakiegokolwiek-linku', platformId: m.platformId, detail: m.title });
  }
}

// deduplikacja wykorzystań (ten sam materiał w tej samej lekcji z dwóch źródeł)
const seen = new Set();
const usagesUniq = usages.filter((u) => {
  const k = `${u.platformId}|${u.courseId}|${u.sectionId}|${u.lessonId}`;
  if (seen.has(k)) return false;
  seen.add(k); return true;
});

// ---------------------------------------------------------------- zapis i raport
fs.mkdirSync(OUT, { recursive: true });
const asJson = [...materials.values()].map((m) => ({
  ...m, brands: [...m.brands].sort(), sources: [...m.sources].sort(), sheets: undefined
}));
fs.writeFileSync(path.join(OUT, 'materialy.json'), JSON.stringify(asJson, null, 2));
fs.writeFileSync(path.join(OUT, 'wykorzystania.json'), JSON.stringify(usagesUniq, null, 2));
fs.writeFileSync(path.join(OUT, 'ostrzezenia.json'), JSON.stringify(warn, null, 2));

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const COLS = ['platformId', 'title', 'brands', 'subject', 'level', 'grade', 'materialType',
  'createdAt', 'updatedAt', 'publishedUrl', 'publishedHost', 'sourceUrl',
  'purchaseType', 'paid', 'visible', 'published', 'rebranded', 'isExternal', 'sources'];
fs.writeFileSync(path.join(OUT, 'materialy.csv'),
  [COLS.join(','), ...asJson.map((m) => COLS.map((c) => csvCell(m[c])).join(','))].join('\n'));

const ours = asJson.filter((m) => !m.isExternal);
const count = (fn, arr = ours) => arr.filter(fn).length;
const pct = (n) => `${Math.round((n / ours.length) * 100)}%`;

console.log(`\n=== ZNORMALIZOWANO → ${OUT} ===\n`);
console.log(`  wszystkich rekordów:        ${asJson.length}`);
console.log(`  treści obce (ZPE):          ${asJson.length - ours.length}`);
console.log(`  NASZYCH materiałów:         ${ours.length}`);
console.log(`  wykorzystań (miejsc użycia): ${usagesUniq.length}`);

console.log('\n  pokrycie pól (nasze materiały):');
for (const [label, fn] of [
  ['tytuł', (m) => m.title],
  ['marka', (m) => m.brands.length],
  ['przedmiot', (m) => m.subject],
  ['poziom', (m) => m.level],
  ['typ materiału', (m) => m.materialType],
  ['data powstania', (m) => m.createdAt],
  ['data aktualizacji', (m) => m.updatedAt],
  ['żywy link do publikacji', (m) => m.publishedUrl],
  ['link do źródła (Dysk)', (m) => m.sourceUrl],
  ['zastosowanie (typ zakupu)', (m) => m.purchaseType],
  ['opublikowany', (m) => m.published],
  ['po rebrandingu', (m) => m.rebranded]
]) {
  const n = count(fn);
  console.log(`    ${label.padEnd(26)} ${String(n).padStart(5)}  ${pct(n).padStart(4)}`);
}

const brandDist = {};
for (const m of ours) {
  const k = m.brands.length ? m.brands.join(' + ') : '(brak)';
  brandDist[k] = (brandDist[k] || 0) + 1;
}
console.log('\n  marki:');
for (const [k, n] of Object.entries(brandDist).sort((a, b) => b[1] - a[1]))
  console.log(`    ${String(n).padStart(5)}  ${k}`);

const reuse = {};
for (const u of usagesUniq) reuse[u.platformId] = (reuse[u.platformId] || 0) + 1;
const multi = Object.values(reuse).filter((n) => n > 1).length;
console.log(`\n  powtórne użycie: ${multi} materiałów w >1 miejscu (max ${Math.max(0, ...Object.values(reuse))})`);

const byKind = {};
for (const w of warn) byKind[w.kind] = (byKind[w.kind] || 0) + 1;
console.log('\n  ostrzeżenia:');
for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1]))
  console.log(`    ${String(n).padStart(5)}  ${k}`);
console.log();
