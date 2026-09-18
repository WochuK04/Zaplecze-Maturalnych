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

// Numer na początku nazwy pliku na Dysku to POZYCJA W PROGRAMIE: klasa i numer
// lekcji („2.17 Narządy zmysłów.pdf" = klasa 2, lekcja 17). Dwa różne numery znaczą,
// że ludzie wpisali te pliki w dwa różne miejsca programu — podstawa klasa 2 kontra
// rozszerzenie klasa 3 — więc to DWA RÓŻNE materiały o tym samym temacie, a nie
// kopia jednego. Sumy kontrolne to potwierdzają: pliki mają inne md5 i inny rozmiar.
//
// Numeru wymagamy od KAŻDEGO członka grupy — brak numeru to brak dowodu, nie dowód
// przeciwny. Dzięki temu zostają oznaczone chemiczne „Lekcja podsumowująca", gdzie
// plik z ED i plik z kursu mają identyczną nazwę bez numeru, a różnią się rozmiarem:
// to jest prawdziwa równoległa kopia.
const NUMER_LEKCJI = /^\s*(\d{1,2})[.,](\d{1,2})\.?\s+\S/;
const numerLekcji = (m) => {
  const t = NUMER_LEKCJI.exec(m.driveName || '');
  return t ? `${t[1]}.${t[2]}` : null;
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

  // RÓŻNY EGZAMIN = różny materiał, nawet przy identycznym tytule. „Arkusz od
  // egzaminatora CKE (matematyka)" istnieje osobno dla matury i osobno dla E8 —
  // ścieżki na Dysku mówią to wprost („MATERIAŁY MATURA" kontra „MATERIAŁY E8").
  // Takich grup nie oznaczamy w ogóle, bo nie są żadną formą kopii.
  //
  // UWAGA: nie testujemy tego po MARCE. Marka bywa wyprowadzona z jednego źródła,
  // więc ten sam materiał używany w kursie i w Edukacji domowej ma marki rozłączne
  // („Maturalni" kontra „Szkoła Maturalnych") — a to jest właśnie równoległa kopia,
  // którą chcemy widzieć. Rozstrzyga `examType`: matura kontra primaryschoolexam.
  const egzaminy = new Set(v.map((m) => m.examType).filter(Boolean));
  if (egzaminy.size > 1) continue;

  const md5 = new Set(v.map((m) => m.driveMd5).filter(Boolean));
  const zeSuma = v.filter((m) => m.driveMd5).length;
  // Jeden plik pod dwoma wpisami — powtórne użycie, niezależnie od numeracji.
  if (md5.size === 1 && zeSuma > 1) { zapisz(v, KOD.REUZYCIE); continue; }

  // Osobne pliki wpisane w osobne miejsca programu = osobne materiały. Nie kopia.
  const numery = v.map(numerLekcji);
  if (numery.every(Boolean) && new Set(numery).size > 1) continue;

  zapisz(v, KOD.ROWNOLEGLA);
}

// Podgląd na platformie: adres to origin marki + stała ścieżka + ID platformy.
// Do przeglądarki wysyłamy same indeksy platform, a URL składa strona — 1621 pełnych
// adresów waży 110 KB, indeksy nic.
const PODGLAD_SCIEZKA = '/materialy/flippingbook/';
const platformy = [];
for (const m of mats) {
  for (const p of m.previewUrls || []) {
    const origin = p.url.slice(0, p.url.indexOf(PODGLAD_SCIEZKA));
    if (!platformy.some(([b]) => b === p.brand)) platformy.push([p.brand, origin]);
  }
}
// [indeks platformy, ID rekordu, przez który idzie podgląd albo '' gdy własny]. Materiały
// Szkoły Maturalnych nie istnieją na platformie Maturalnych, więc ich podgląd prowadzi do
// bliźniaczego rekordu z tym samym plikiem — strona musi to powiedzieć wprost.
const podglady = (m) => (m.previewUrls || [])
  .map((p) => [platformy.findIndex(([b]) => b === p.brand), p.viaId || '', p.via || '']);

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
  m.drivePath || '', (m.derived || []).join(','), m.driveMd5 || '', grupa.get(m.platformId) || [],
  podglady(m)
]);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'data.js'),
  'window.MAT=' + JSON.stringify({ BRANDS, subjects, types, courses, rows,
    podglad: { sciezka: PODGLAD_SCIEZKA, platformy } }) + ';');

const ile = (kod) => rows.filter((r) => r[17] === kod).length;
const grup = (kod) => new Set(rows.filter((r) => r[17] === kod)
  .map((r) => [r[0], ...r[21]].sort().join('|'))).size;
console.log(`data.js → ${OUT}  (${Math.round(fs.statSync(path.join(OUT, 'data.js')).size / 1024)} KB)`);
console.log(`  ten sam plik w kilku miejscach: ${String(ile(1)).padStart(4)} rekordów w ${grup(1)} grupach`);
console.log(`  równoległa kopia:               ${String(ile(4)).padStart(4)} rekordów w ${grup(4)} grupach`);
console.log(`  publikacja ≠ plik:              ${String(ile(5)).padStart(4)} rekordów w ${grup(5)} grupach`);
console.log(`  jeden link, różne tytuły:       ${String(ile(3)).padStart(4)} rekordów w ${grup(3)} grupach`);
console.log(`  podgląd na platformie:          ${String(rows.filter((r) => r[22].length).length).padStart(4)} rekordów (${platformy.map(([b]) => b).join(', ')})`);
