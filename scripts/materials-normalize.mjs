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

// Kilka wierszy eksportu ED ma przesunięte kolumny i do pola linku wpada wartość
// z `zrodlo` („not-found", data). Bez tej bramki taki śmieć trafia do bazy jako
// adres publikacji i grupuje ze sobą niepowiązane materiały.
const jakoUrl = (v) => {
  const s = String(v ?? '').trim();
  return /^https?:\/\//i.test(s) ? s : null;
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
      // Z mapowania Dysku (materials-drive-map.gs) — dokładane po scaleniu źródeł.
      driveFileId: null, driveMd5: null, drivePath: null,
      driveModified: null, driveOwner: null,
      // Które pola pochodzą z wnioskowania ze ścieżki, a nie z eksportu.
      derived: [],
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
    publishedUrl: jakoUrl(row.url), publishedHost: hostOf(row.url),
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
  const host = hostOf(jakoUrl(row.link));
  // zpe.gov.pl = Zintegrowana Platforma Edukacyjna, treść RZĄDOWA używana w kursach.
  // To nie jest nasz materiał — oznaczamy, nie wyrzucamy, bo wykorzystanie jest realne.
  const external = host === 'zpe.gov.pl';
  upsert(id, {
    title: row.nazwa, subject, level, grade: row.klasa,
    publishedUrl: jakoUrl(row.link), publishedHost: host,
    createdAt: parseDate(row.data_stworzenia), updatedAt: parseDate(row.data_ostatniej_aktualizacji),
    published: true, isExternal: external,
    brands: external ? [] : ['Szkoła Maturalnych']
  }, 'prod-ed');
  addUsage(id, r, 'prod-ed');
}

// --- 5. Mapa Dysku (opcjonalna) ----------------------------------------------
// Wynik `materials-drive-map.gs`. Daje trzy rzeczy, których nie ma w eksportach:
// sumę kontrolną (czy dwa rekordy to ten sam plik), realną datę modyfikacji
// (daty w masterze są wpisywane ręcznie) i ścieżkę w drzewie folderów.
const DRIVE_XLSX = path.join(SRC, 'drive-map-komplet.xlsx');
if (fs.existsSync(DRIVE_XLSX)) {
  const wbD = xlsx.readFile(DRIVE_XLSX);
  const arkusz = wbD.Sheets['AllFiles'];
  const plikiDysku = arkusz ? xlsx.utils.sheet_to_json(arkusz, { defval: '' }) : [];
  const poId = new Map(plikiDysku.map(r => [String(r.file_id), r]));

  // fileId wyciągamy z linku do źródła — kolumna Dysku ma kilka formatów URL.
  const WZORCE = [/\/file\/d\/([A-Za-z0-9_-]{20,})/, /\/(?:document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]{20,})/, /[?&]id=([A-Za-z0-9_-]{20,})/];
  let dopasowane = 0, zepsute = 0;
  for (const m of materials.values()) {
    if (!m.sourceUrl) continue;
    let fid = null;
    for (const w of WZORCE) { const t = m.sourceUrl.match(w); if (t) { fid = t[1]; break; } }
    if (!fid) continue;
    m.driveFileId = fid;
    const r = poId.get(fid);
    if (!r) { zepsute++; continue; }   // wskaźnik istnieje, ale pliku nie ma → do kolejki „potwierdź"
    dopasowane++;
    m.driveMd5 = String(r.md5 || '') || null;
    m.drivePath = String(r.path || '') || null;
    m.driveModified = String(r.modified || '').slice(0, 10) || null;
    m.driveOwner = String(r.owner || '') || null;
    // Data z pliku jest wiarygodniejsza niż wpisywana ręcznie w arkuszu.
    if (m.driveModified) m.updatedAt = m.driveModified;
  }
  console.log(`\n  mapa Dysku: ${plikiDysku.length} plików, dopasowano ${dopasowane}, zepsutych wskaźników ${zepsute}`);
  for (const m of materials.values()) {
    if (m.driveFileId && !m.driveMd5 && !m.isExternal) {
      warn.push({ kind: 'wskaznik-dysku-zepsuty', platformId: m.platformId, detail: m.sourceUrl });
    }
  }
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
  // Marka z `examType` niezależnie od tego, które źródło go wniosło. Wcześniej
  // reguła działała tylko na eksporcie produkcyjnym, więc materiały obecne WYŁĄCZNIE
  // w masterze platformowym (kolumna `egzamin`) zostawały bez marki — dotyczyło to
  // 5 arkuszy próbnych CKE zdjętych już z platformy.
  if (!m.brands.size && !m.isExternal) {
    if (m.examType === 'matura') m.brands.add('Maturalni');
    if (m.examType === 'primaryschoolexam') m.brands.add('KursyE8');
  }
  if (!m.brands.size && !m.isExternal) {
    warn.push({ kind: 'brak-marki', platformId: m.platformId, detail: m.title });
  }
  if (!m.publishedUrl && !m.sourceUrl && !m.isExternal) {
    warn.push({ kind: 'brak-jakiegokolwiek-linku', platformId: m.platformId, detail: m.title });
  }
}

// --- Uzupełnienia ze ŚCIEŻKI na Dysku (PO rozpoznaniu typu z nazwy) -------------------------------------
// Ludzie segregują pliki po tym, czym te pliki są — więc drzewo folderów niesie
// typ, poziom i klasę. Wypełniamy WYŁĄCZNIE luki: dane z eksportów są twarde,
// ścieżka to wnioskowanie. Kolejność jest istotna: prefiks NAZWY wygrywa ze ścieżką,
// bo jest konkretniejszy („Planer 100 dni" kontra ogólne „Prezentacje" z folderu).
// Kontrola na 1312 materiałach, dla których poziom znamy
// z eksportu: ścieżka zgadza się w 1312 przypadkach, myli w 8 (0,6%).
const TYP_ZE_SCIEZKI = [
  [/prezentacj/i, 'Prezentacja'],
  [/materia.{0,3}\s*dodatkow|materia.y\s*dod/i, 'Materiał dodatkowy'],
  [/notatk/i, 'Notatka'],
  [/arkusz/i, 'Arkusz'],
  [/quiz/i, 'Quiz'],
  [/plansz/i, 'Plansza'],
  [/planer/i, 'Planer'],
  [/karta\s*pracy/i, 'Karta pracy']
];
const RX_POZIOM = /\/(podst|podstawa|podstawowa|podstawowy|rozsz|rozszerzenie|rozszerzona|rozszerzony)(\/|$)/i;
const RX_KLASA = /\/klasa\s*([1-4])(\/|$)/i;
// Eksport ED używa angielskich nazw klas — trzymamy jedną konwencję, nie dwie.
const KLASY = [null, 'first', 'second', 'third', 'fourth'];

for (const m of materials.values()) {
  if (!m.drivePath) continue;
  if (!m.materialType) {
    for (const [rx, v] of TYP_ZE_SCIEZKI) {
      if (rx.test(m.drivePath)) { m.materialType = v; m.derived.push('materialType'); break; }
    }
  }
  if (!m.level) {
    const t = m.drivePath.match(RX_POZIOM);
    if (t) {
      m.level = /^podst/i.test(t[1]) ? 'podstawowa' : 'rozszerzona';
      m.derived.push('level');
    }
  }
  if (!m.grade) {
    const t = m.drivePath.match(RX_KLASA);
    if (t) { m.grade = KLASY[Number(t[1])]; m.derived.push('grade'); }
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
  'purchaseType', 'paid', 'visible', 'published', 'rebranded', 'isExternal',
  'drivePath', 'driveMd5', 'driveModified', 'driveOwner', 'derived', 'sources'];
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
  ['po rebrandingu', (m) => m.rebranded],
  ['suma kontrolna pliku', (m) => m.driveMd5],
  ['ścieżka na Dysku', (m) => m.drivePath],
  ['…w tym pola ze ścieżki', (m) => m.derived.length]
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
