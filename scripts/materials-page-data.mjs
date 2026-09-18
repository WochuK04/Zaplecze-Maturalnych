// Buduje kompaktowy zbiór dla przeglądarki materiałów (strona podglądowa).
// Wejście: wynik `materials-normalize.mjs`. Wyjście: data.js z `window.MAT`.
//
// Użycie:  node scripts/materials-page-data.mjs --out <katalog>

import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(process.cwd(), 'Materiały do gitignore', 'znormalizowane');
const i = process.argv.indexOf('--out');
const OUT = i > -1 ? process.argv[i + 1] : SRC;

const mats = JSON.parse(fs.readFileSync(path.join(SRC, 'materialy.json'), 'utf8'));
const uses = JSON.parse(fs.readFileSync(path.join(SRC, 'wykorzystania.json'), 'utf8'));

// Klucz porównania tytułów. ŚWIADOMIE nie obcinamy prefiksu typu ani dopisku
// „długa wersja": „Prezentacja - Antygona, Sofokles" i „Antygona, Sofokles" to
// DWA RÓŻNE materiały — prezentacja o lekturze kontra jej opracowanie. Wcześniejsza
// wersja obcinała prefiks i skleiła 175 z 260 grup, które nie mają ze sobą nic
// wspólnego poza tematem. Normalizujemy wyłącznie wielkość liter i interpunkcję,
// żeby „–" kontra „-" nie robiło różnicy.
const norm = (s) => (s || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const own = mats.filter((m) => !m.isExternal);
// Kody klasyfikacji. WAŻNE rozróżnienie: wspólny link do publikacji przy wspólnej
// nazwie to NIE jest duplikat do scalenia. Jeden plik na Dysku, jeden flipbook
// i kilka wpisów na platformie znaczy, że materiał jest używany w kilku miejscach,
// a brak drugiego pliku to stan PRAWIDŁOWY — nie ma po co kopiować pliku, skoro
// publikacja jest jedna. Dotyczy 366 z 372 takich grup, z czego 258 faktycznie
// wisi w różnych kursach. Scalenie zgubiłoby informację o powtórnym użyciu.
const KOD = {
  REUZYCIE: 1,        // ten sam plik w kilku miejscach — stan prawidłowy
  ZLY_LINK: 3,        // jeden link, różne tytuły — podejrzenie złego odnośnika
  ROWNOLEGLA: 4,      // ta sama nazwa, osobny plik dla drugiego produktu
  ROZJAZD: 5          // różne pliki pod jednym flipbookiem — publikacja ≠ plik
};
const flaga = new Map();
const grupa = new Map();   // platformId -> [platformId rodzeństwa]

const zapisz = (czlonkowie, kod) => {
  for (const m of czlonkowie) {
    if (flaga.has(m.platformId)) continue;
    flaga.set(m.platformId, kod);
    grupa.set(m.platformId, czlonkowie.map((x) => x.platformId).filter((x) => x !== m.platformId));
  }
};

// Ten sam link do publikacji. Zgodne tytuły = jeden materiał wpisany dwa razy.
// Różne tytuły = jeden flipbook pod dwiema nazwami, czyli najpewniej zły odnośnik.
const poLinku = new Map();
for (const m of own) if (m.publishedUrl) {
  if (!poLinku.has(m.publishedUrl)) poLinku.set(m.publishedUrl, []);
  poLinku.get(m.publishedUrl).push(m);
}
for (const v of poLinku.values()) {
  if (v.length < 2) continue;
  if (new Set(v.map((m) => norm(m.title))).size > 1) { zapisz(v, KOD.ZLY_LINK); continue; }
  // Ta sama nazwa i ten sam flipbook. Rozstrzyga liczba RÓŻNYCH plików na Dysku:
  // jeden (albo żaden po drugiej stronie) = powtórne użycie; kilka różnych = rozjazd
  // między tym, co opublikowane, a tym, co leży w plikach.
  const md5 = new Set(v.map((m) => m.driveMd5).filter(Boolean));
  zapisz(v, md5.size > 1 ? KOD.ROZJAZD : KOD.REUZYCIE);
}

// Ta sama nazwa i przedmiot, różne linki — rozstrzyga suma kontrolna pliku.
const poNazwie = new Map();
for (const m of own) {
  const k = norm(m.title);
  if (k.length < 10) continue;
  const key = k + '|' + (m.subject || '');
  if (!poNazwie.has(key)) poNazwie.set(key, []);
  poNazwie.get(key).push(m);
}
for (const v of poNazwie.values()) {
  if (v.length < 2) continue;
  if (new Set(v.map((m) => m.publishedUrl).filter(Boolean)).size < 2) continue;
  const md5 = new Set(v.map((m) => m.driveMd5).filter(Boolean));
  const zeSuma = v.filter((m) => m.driveMd5).length;
  zapisz(v, md5.size === 1 && zeSuma > 1 ? KOD.REUZYCIE : KOD.ROWNOLEGLA);
}

const BRANDS = ['Maturalni', 'KursyE8', 'Szkoła Maturalnych'];
const pula = (v) => [...new Set(v.filter(Boolean))].sort();
const subjects = pula(mats.map((m) => m.subject));
const types = pula(mats.map((m) => m.materialType));
const courses = pula(uses.map((u) => u.courseName));

const wykorzystania = new Map();
for (const u of uses) {
  if (!wykorzystania.has(u.platformId)) wykorzystania.set(u.platformId, []);
  wykorzystania.get(u.platformId).push([courses.indexOf(u.courseName), u.sectionName || '', u.lessonName || '']);
}

const rows = mats.map((m) => [
  m.platformId, m.title || '', m.brands.reduce((a, b) => a | (1 << BRANDS.indexOf(b)), 0),
  subjects.indexOf(m.subject), m.level || '', m.grade || '', types.indexOf(m.materialType),
  m.createdAt || '', m.updatedAt || '', m.publishedUrl || '', m.sourceUrl || '',
  m.purchaseType || '', m.paid === true ? 1 : m.paid === false ? 0 : -1,
  m.published ? 1 : 0, m.rebranded ? 1 : 0, m.isExternal ? 1 : 0,
  wykorzystania.get(m.platformId) || [], flaga.get(m.platformId) || 0,
  m.drivePath || '', (m.derived || []).join(','), m.driveMd5 || '', grupa.get(m.platformId) || []
]);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'data.js'),
  'window.MAT=' + JSON.stringify({ BRANDS, subjects, types, courses, rows }) + ';');

const ile = (kod) => rows.filter((r) => r[17] === kod).length;
const grup = (kod) => new Set(rows.filter((r) => r[17] === kod)
  .map((r) => [r[0], ...r[21]].sort().join('|'))).size;
console.log(`data.js → ${OUT}  (${Math.round(fs.statSync(path.join(OUT, 'data.js')).size / 1024)} KB)`);
console.log(`  ten sam plik w kilku miejscach: ${String(ile(1)).padStart(4)} rekordów w ${grup(1)} grupach`);
console.log(`  równoległa kopia:               ${String(ile(4)).padStart(4)} rekordów w ${grup(4)} grupach`);
console.log(`  publikacja ≠ plik:              ${String(ile(5)).padStart(4)} rekordów w ${grup(5)} grupach`);
console.log(`  jeden link, różne tytuły:       ${String(ile(3)).padStart(4)} rekordów w ${grup(3)} grupach`);
