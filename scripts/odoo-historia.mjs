// Zaciągnięcie historii magazynu z Odoo: ruchy, przekazy i PRZETWORZENIA.
//
// Odoo nie ma osobnego dokumentu „przetworzenie towaru w gadżet" — magazyn robi to
// dwiema korektami stanu (zdjęcie X z kartoteki towaru, dopisanie X na kartotece
// gadżetu chwilę później). Odtwarzamy z nich operacje typu `conversion`, czyli
// dokładnie ten sam byt, który zaplecze tworzy dziś samo (src/stock.js). Reszta
// linii ruchu wchodzi jako przyjęcia, wydania i korekty.
//
// Dokumenty wchodzą jako JUŻ WYKONANE (state: 'done') — to zapis zdarzeń, które
// wydarzyły się w Odoo, a nie operacje do zatwierdzania. Dlatego nie przechodzą
// przez validateOperation (ten liczy koszty i rezerwacje wg stanu NA DZIŚ, więc
// odtwarzając przeszłość zjadłby partie cenowe zaimportowane z bieżącego stanu).
// Partie cenowe ustawia `odoo-import.mjs` ze stanu bieżącego; tu ich nie ruszamy.
//
// Użycie:
//   node scripts/odoo-historia.mjs                     # na sucho, dane z RPC
//   node scripts/odoo-historia.mjs "…/Przesunięcia …xlsx" "…/Przekaz …xlsx"
//   node scripts/odoo-historia.mjs --zapisz
//   node scripts/odoo-historia.mjs --zapisz --wyczysc  # najpierw usuń poprzedni import
//
// Kolejność: najpierw `odoo-import.mjs` (produkty), potem to.

import dotenv from 'dotenv';
import path from 'path';
import { ObjectId } from 'mongodb';
import { fileURLToPath } from 'url';
import { connectToDatabase, closeDb } from '../src/db.js';
import { collections, ensureIndexes } from '../src/schema.js';
import { seedStandardLocations, recomputeQuants, refreshItemCache } from '../src/stock.js';
import { mergeProducts, normalizeMoveLine, detectConversions, tylkoAktywne, findDuplicateCodes, resolveCodeCollisions, KOD_KOLIZJI } from '../src/odoo.js';
import { isWarehouseCategory } from '../src/lib/categories.js';
import { DEFAULT_UNIT } from '../src/lib/units.js';
import { zastosujPoprawki, kodZNazwy, mnoznikDlaKodu } from '../src/odoo-poprawki.js';
import { wczytaj } from './odoo/zrodlo.mjs';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const args = process.argv.slice(2);
const ZAPISZ = args.includes('--zapisz');
const WYCZYSC = args.includes('--wyczysc');
const sciezki = args.filter((a) => !a.startsWith('--'));

const ZNACZNIK = 'odoo';           // importedFrom — po tym poznajemy dokumenty z importu
const AKTOR = 'import@odoo';       // actorEmail ruchów historycznych
const newId = () => new ObjectId();

// Własna numeracja dokumentów importu. `stockOperations.reference` ma unikalny
// indeks, a odnośniki korekt w Odoo się powtarzają („Zaktualizowana ilość produktu
// (Rafał Szumełda)" na każdej), więc oryginał trzymamy w `sourceDocument`.
const licznik = { conversion: 0, adjustment: 0 };
const numer = (prefiks, typ) => `${prefiks}/${String(++licznik[typ]).padStart(5, '0')}`;

const KATEGORIA_Z_PREFIKSU = { G: 'gadżet', T: 'Towar', O: 'opakowanie', S: 'sponsor' };

const zrodlo = wczytaj(sciezki);
const teraz = new Date();

// --- mapa kodów: kod kartoteki Odoo → kod produktu w zapleczu po scaleniu --------
// Ta sama filtracja co w `odoo-import.mjs` — inaczej mapa kodów rozjechałaby się
// z tym, co realnie wylądowało w `items`.
// Te same poprawki co w `odoo-import.mjs` — mapa kodów musi widzieć dokładnie to,
// co wylądowało w `items`.
const wszystkieProdukty = mergeProducts(tylkoAktywne(zastosujPoprawki(zrodlo.produkty).kartoteki), { teraz });
const pominiete = new Set(findDuplicateCodes(wszystkieProdukty).flatMap((k) => k.przegrywaja));
const bezDuplikatow = wszystkieProdukty.filter((p) => !pominiete.has(p));
const naWiodacy = new Map();
const kanon = (kod) => (kod ? naWiodacy.get(kod) || kod : null);

const db = await connectToDatabase();
await ensureIndexes(db);
const lok = await seedStandardLocations(db);

// Ta sama zasada co w `odoo-import.mjs`: kod zajęty przez kartotekę niemagazynową
// (sprzęt) jest nietykalny, a kolidująca pozycja Odoo dostaje kod z prefiksem MAG-.
// Musi to pójść PRZED budową mapy kodów, inaczej ruchy magazynowe podpięłyby się
// pod statyw.
const obceKody = new Set(
  (await db.collection(collections.items).find({}, { projection: { itemCode: 1, category: 1 } }).toArray())
    .filter((i) => !isWarehouseCategory(i.category))
    .map((i) => i.itemCode)
);
const { produkty, kolizje } = resolveCodeCollisions(bezDuplikatow, obceKody);
for (const p of produkty) {
  naWiodacy.set(p.odooCode || p.itemCode, p.itemCode);
  naWiodacy.set(p.itemCode, p.itemCode);
  for (const k of p.mergedCodes) naWiodacy.set(k, p.itemCode);
}

// Kartoteki ZARCHIWIZOWANE w Odoo nie przechodzą przez `produkty` (import bierze
// tylko aktywne), a historia i tak się do nich odwołuje — np. konwersja
// G001 → T001 ze stycznia. Gdyby taki kod był w zapleczu zajęty przez sprzęt,
// ruch magazynowy podpiąłby się pod statyw. Mapujemy je tak samo.
for (const kod of obceKody) {
  if (!naWiodacy.has(kod)) naWiodacy.set(kod, KOD_KOLIZJI(kod));
}
// --- linie ruchu ----------------------------------------------------------------
const wszystkieLinie = zrodlo.ruchy.map(normalizeMoveLine);
const linie = wszystkieLinie
  .filter((l) => l.status === 'Wykonano' || l.status === 'done')
  .filter((l) => l.when instanceof Date && !Number.isNaN(l.when.getTime()));

// Linie bez kodu produktu: Odoo podaje wtedy samą nazwę. Kartoteki, którym kod
// nadaliśmy sami (taśmy), da się po tej nazwie rozpoznać — reszta zostaje pominięta.
const zOdzyskanym = linie.map((l) => (l.kod ? l : { ...l, kod: kodZNazwy(l.nazwa) }));
const bezKodu = zOdzyskanym.filter((l) => !l.kod);
// Ilość przeliczamy tym samym mnożnikiem co stan kartoteki, inaczej rejestr
// rozjedzie się z ilością (O010: ruchy w sztukach, kartoteka w kilogramach).
const zKodem = zOdzyskanym.filter((l) => l.kod).map((l) => {
  const m = mnoznikDlaKodu(l.kod);
  return { ...l, itemCode: kanon(l.kod), qty: m === 1 ? l.qty : Math.round(l.qty * m * 1000) / 1000 };
});

const { conversions, pozostaleKorekty } = detectConversions(zKodem);
// Przetworzenia mapujemy na kody po scaleniu dopiero tutaj — parowanie musi widzieć
// oryginalne kartoteki (scalenie potrafiłoby zetknąć źródło i cel w jeden kod).
const przetworzenia = conversions
  .map((c) => ({ ...c, sourceItem: kanon(c.sourceCode), targetItem: kanon(c.targetCode) }))
  .filter((c) => c.sourceItem !== c.targetItem);

const zwykle = zKodem.filter((l) => l.kind !== 'adjustment');
const korekty = pozostaleKorekty;

const idLok = (kod) => (lok.get(kod) ? String(lok.get(kod)._id) : null);

const items = db.collection(collections.items);
const ops = db.collection(collections.stockOperations);
const moves = db.collection(collections.stockMoves);

const raport = {
  zrodlo: zrodlo.zrodlo,
  pliki: zrodlo.pliki,
  baza: process.env.DB_NAME || process.env.MONGO_DB_NAME,
  naSucho: !ZAPISZ,
  liniiWZrodle: wszystkieLinie.length,
  liniiWykonanych: linie.length,
  pominietoBezKoduProduktu: [...new Set(bezKodu.map((l) => l.nazwa))],
  przetworzen: przetworzenia.length,
  przetworzenia: przetworzenia.map((c) => ({
    kiedy: c.when.toISOString().slice(0, 16).replace('T', ' '),
    ilosc: c.qty,
    z: `${c.sourceCode} ${c.sourceName}`,
    na: `${c.targetCode} ${c.targetName}`
  })),
  kolizjeZeSprzetem: [],
  brakujaceKartoteki: [],
  operacje: {},
  ruchow: 0,
  licznikiNumeracji: {},
  usunieteStanyOtwarcia: 0,
  rozbieznosciStanu: []
};

// --- kartoteki, których nie ma w eksporcie produktów (zarchiwizowane w Odoo) ------
const potrzebneKody = new Set([
  ...zwykle.map((l) => l.itemCode),
  ...korekty.map((l) => kanon(l.kod)),
  ...przetworzenia.flatMap((c) => [c.sourceItem, c.targetItem])
].filter(Boolean));

const znane = new Set(
  (await items.find({ itemCode: { $in: [...potrzebneKody] } }, { projection: { itemCode: 1 } }).toArray())
    .map((d) => d.itemCode)
);
// Kod zajęty przez sprzęt nie jest „brakujący" — tam nie wolno nic zakładać.
const brakujace = [...potrzebneKody].filter((k) => !znane.has(k) && !obceKody.has(k));

// Nazwę bierzemy z pierwszej linii ruchu, kategorię z prefiksu kodu. Takie kartoteki
// wchodzą jako nieaktywne — to archiwum Odoo, nie żywy asortyment.
const nazwaDlaKodu = new Map();
const jednostkaDlaKodu = new Map();
for (const l of zKodem) {
  const k = kanon(l.kod);
  if (k && !nazwaDlaKodu.has(k)) nazwaDlaKodu.set(k, l.nazwa);
  if (k && l.jednostka && !jednostkaDlaKodu.has(k)) jednostkaDlaKodu.set(k, l.jednostka);
}
raport.kolizjeZeSprzetem = kolizje.map((k) => ({ odooCode: k.odooCode, itemCode: k.itemCode, nazwa: k.name }));
raport.brakujaceKartoteki = brakujace.map((k) => ({ itemCode: k, nazwa: nazwaDlaKodu.get(k) || k }));

if (ZAPISZ && brakujace.length) {
  await items.insertMany(brakujace.map((k) => ({
    itemCode: k,
    category: KATEGORIA_Z_PREFIKSU[k[0]] || 'Towar',
    name: nazwaDlaKodu.get(k) || k,
    unit: jednostkaDlaKodu.get(k) || DEFAULT_UNIT,
    details: '',
    quantity: 0,
    currentLocation: 'Magazyn',
    conditionStatus: 'good',
    operationalStatus: 'available',
    assignedToName: null, assignedToEmail: null,
    notes: 'Kartoteka zarchiwizowana w Odoo — odtworzona z historii ruchów',
    imageUrl: '', thumbnailUrl: '', brand: '', model: '', qrCodeValue: '',
    tags: [], serialNumber: '', warrantyUntil: '', detailedLocation: '',
    priceBatches: [], mergedCodes: [],
    isStudioLocked: false, isActive: false,
    importedFrom: ZNACZNIK, createdAt: teraz, updatedAt: teraz
  })));
}

// Ponowne uruchomienie bez --wyczysc rozbiłoby się o unikalny indeks na
// `reference` w połowie zapisu. Lepiej powiedzieć to wprost, zanim cokolwiek pójdzie.
if (ZAPISZ && !WYCZYSC) {
  const juzSa = await ops.countDocuments({ importedFrom: ZNACZNIK });
  if (juzSa) {
    console.error(`W bazie jest już ${juzSa} dokumentów z importu Odoo.`);
    console.error('Uruchom ponownie z --wyczysc, żeby je zastąpić.');
    await closeDb();
    process.exit(1);
  }
}

if (ZAPISZ && WYCZYSC) {
  const { deletedCount: dm } = await moves.deleteMany({ importedFrom: ZNACZNIK });
  const { deletedCount: dop } = await ops.deleteMany({ importedFrom: ZNACZNIK });
  raport.wyczyszczono = { ruchow: dm, operacji: dop };
}

// Stan otwarcia z migracji (`kind: 'opening'`, scripts/migrate-warehouse.js) to
// syntetyczny ruch, który w swoim czasie wprowadził stan z `items.currentLocation`.
// Historia z Odoo tłumaczy ten sam stan od zera — razem podwoiłyby ilości, więc
// dla produktów objętych importem stan otwarcia znika.
const filtrOtwarc = { kind: 'opening', itemCode: { $in: [...potrzebneKody] } };
raport.usunieteStanyOtwarcia = await moves.countDocuments(filtrOtwarc);
if (ZAPISZ && raport.usunieteStanyOtwarcia) await moves.deleteMany(filtrOtwarc);

// --- budowa dokumentów ----------------------------------------------------------
const przekazWg = new Map(zrodlo.przekazy.map((p) => [String(p.odnosnik || ''), p]));
const dokOps = [];
const dokMoves = [];

const nowyRuch = (o) => ({
  itemCode: o.itemCode,
  fromLocationId: o.from || null,
  toLocationId: o.to || null,
  quantity: o.qty,
  lot: null,
  kind: o.kind,
  state: 'done',
  operationId: o.operationId,
  actorEmail: AKTOR,
  note: o.note || '',
  doneAt: o.when,
  createdAt: teraz,
  importedFrom: ZNACZNIK
});

// 1) Przetworzenia → operacje `conversion` (dwa spięte ruchy, jak w validateOperation).
for (const c of przetworzenia) {
  const opId = newId();
  dokOps.push({
    _id: opId,
    reference: numer('odoo/CONV', 'conversion'),
    type: 'conversion',
    state: 'done',
    fromLocationId: idLok('WH/Stock'),
    toLocationId: idLok('WH/Stock'),
    contact: '', supplierId: null, supplierName: '', destinationId: null, destinationName: '',
    scheduledAt: c.when,
    sourceDocument: c.referencja || '',
    note: `Odtworzone z korekt stanu w Odoo (${c.sourceCode} → ${c.targetCode}).`,
    lines: [{ itemCode: c.sourceItem, targetItemCode: c.targetItem, quantity: c.qty }],
    createdByEmail: AKTOR,
    doneAt: c.when,
    doneByEmail: AKTOR,
    createdAt: teraz,
    updatedAt: teraz,
    importedFrom: ZNACZNIK
  });
  dokMoves.push(
    nowyRuch({ itemCode: c.sourceItem, from: idLok('WH/Stock'), to: idLok('VIRT/Conversion'), qty: c.qty, kind: 'conversion', operationId: String(opId), when: c.when, note: 'Przetworzenie (Odoo)' }),
    nowyRuch({ itemCode: c.targetItem, from: idLok('VIRT/Conversion'), to: idLok('WH/Stock'), qty: c.qty, kind: 'conversion', operationId: String(opId), when: c.when, note: 'Przetworzenie (Odoo)' })
  );
}

// 2) Zwykłe linie → jedna operacja na przekaz Odoo (mag/IN/00004, mag/OUT/00012…).
const wgPrzekazu = new Map();
for (const l of zwykle) {
  const k = l.referencja || `bez-odnosnika/${l.when.toISOString().slice(0, 10)}/${l.kind}`;
  if (!wgPrzekazu.has(k)) wgPrzekazu.set(k, []);
  wgPrzekazu.get(k).push(l);
}

for (const [ref, grupa] of wgPrzekazu) {
  const meta = przekazWg.get(ref) || null;
  const typ = grupa[0].kind === 'receipt' ? 'receipt' : grupa[0].kind === 'delivery' ? 'delivery' : 'internal';
  const kiedy = grupa.reduce((a, b) => (a && a > b.when ? a : b.when), null);
  const opId = newId();
  dokOps.push({
    _id: opId,
    reference: ref,
    type: typ,
    state: 'done',
    fromLocationId: idLok(grupa[0].fromKod) || null,
    toLocationId: idLok(grupa[0].toKod) || null,
    contact: String(meta?.kontakt || ''),
    supplierId: null, supplierName: typ === 'receipt' ? String(meta?.kontakt || '') : '',
    destinationId: null, destinationName: typ === 'delivery' ? String(meta?.kontakt || '') : '',
    scheduledAt: meta?.data || kiedy,
    sourceDocument: String(meta?.dokument || ''),
    note: 'Import historii z Odoo',
    lines: grupa.map((l) => ({ itemCode: l.itemCode, quantity: l.qty })),
    createdByEmail: AKTOR,
    doneAt: kiedy,
    doneByEmail: AKTOR,
    createdAt: teraz, updatedAt: teraz,
    importedFrom: ZNACZNIK
  });
  for (const l of grupa) {
    dokMoves.push(nowyRuch({
      itemCode: l.itemCode, from: idLok(l.fromKod), to: idLok(l.toKod),
      qty: l.qty, kind: l.kind, operationId: String(opId), when: l.when, note: ref
    }));
  }
}

// 3) Pozostałe korekty → operacje `adjustment`, grupowane po odnośniku i dniu.
const wgKorekty = new Map();
for (const l of korekty) {
  const k = `${l.referencja}|${l.when.toISOString().slice(0, 10)}`;
  if (!wgKorekty.has(k)) wgKorekty.set(k, []);
  wgKorekty.get(k).push(l);
}

for (const [k, grupa] of wgKorekty) {
  const [ref] = k.split('|');
  const opId = newId();
  const kiedy = grupa.reduce((a, b) => (a && a > b.when ? a : b.when), null);
  dokOps.push({
    _id: opId,
    reference: numer('odoo/ADJ', 'adjustment'),
    type: 'adjustment',
    state: 'done',
    fromLocationId: idLok('VIRT/Inventory'),
    toLocationId: idLok('WH/Stock'),
    contact: '', supplierId: null, supplierName: '', destinationId: null, destinationName: '',
    scheduledAt: kiedy,
    sourceDocument: ref,
    note: 'Korekta stanu przeniesiona z Odoo',
    lines: grupa.map((l) => ({
      itemCode: kanon(l.kod),
      locationId: idLok('WH/Stock'),
      quantity: l.qty,
      countedQty: null
    })),
    createdByEmail: AKTOR,
    doneAt: kiedy, doneByEmail: AKTOR,
    createdAt: teraz, updatedAt: teraz,
    importedFrom: ZNACZNIK
  });
  for (const l of grupa) {
    dokMoves.push(nowyRuch({
      itemCode: kanon(l.kod), from: idLok(l.fromKod), to: idLok(l.toKod),
      qty: l.qty, kind: 'adjustment', operationId: String(opId), when: l.when, note: ref
    }));
  }
}

// --- wyrównanie: historia musi dawać ten sam stan, co kartoteka Odoo ------------
//
// Odoo potrafi być wewnętrznie niespójne: `qty_available` mówi 5, a suma jego
// własnych ruchów 4, bo ktoś poprawił stan z ręki, poza rejestrem. Przyjmujemy
// `qty_available` za prawdę (to jest liczba, na której pracuje magazyn) i dokładamy
// jeden ruch domykający różnicę.
//
// Partii cenowych NIE ruszamy — one przyszły właśnie z `qty_available`, więc już
// pokazują 5. Dlatego to NIE jest korekta inwentarzowa z zaplecza (ta zsynchronizowałaby
// partie do policzonego stanu i policzyłaby różnicę drugi raz).
const stanZOdoo = new Map(produkty.map((p) => [p.itemCode, p.quantity]));
const bilans = new Map();
// Ruchy sprzed importu, które zostają w bazie (np. operacje robione już w
// zapleczu), też wchodzą do bilansu — inaczej wyrównanie dokładałoby sztuki,
// które ktoś już rozliczył. Wyłączamy stan otwarcia (zastąpiony historią)
// i ruchy z tego importu: te mamy w `dokMoves`.
const zostajace = await moves.find({
  itemCode: { $in: [...potrzebneKody] },
  kind: { $ne: 'opening' },
  importedFrom: { $ne: ZNACZNIK }
}).toArray();
for (const m of [...dokMoves, ...zostajace]) {
  const wIn = m.toLocationId === idLok('WH/Stock');
  const wOut = m.fromLocationId === idLok('WH/Stock');
  if (!wIn && !wOut) continue;
  bilans.set(m.itemCode, (bilans.get(m.itemCode) || 0) + (wIn ? m.quantity : -m.quantity));
}

const doWyrownania = [];
for (const [kod, stan] of stanZOdoo) {
  const z = bilans.get(kod) ?? 0;
  if (z !== stan) doWyrownania.push({ itemCode: kod, wOdoo: stan, zHistorii: z, roznica: stan - z });
}
raport.rozbieznosciStanu = doWyrownania;

if (doWyrownania.length) {
  const opId = newId();
  dokOps.push({
    _id: opId,
    reference: 'odoo/ADJ-WYR/00001',
    type: 'adjustment',
    state: 'done',
    fromLocationId: idLok('VIRT/Inventory'),
    toLocationId: idLok('WH/Stock'),
    contact: '', supplierId: null, supplierName: '', destinationId: null, destinationName: '',
    scheduledAt: teraz,
    sourceDocument: 'Odoo qty_available',
    note: 'Wyrównanie rejestru do stanu z kartotek Odoo — różnica powstała z ręcznej edycji stanu poza rejestrem ruchów.',
    lines: doWyrownania.map((r) => ({
      itemCode: r.itemCode, locationId: idLok('WH/Stock'), quantity: Math.abs(r.roznica), countedQty: r.wOdoo
    })),
    createdByEmail: AKTOR, doneAt: teraz, doneByEmail: AKTOR,
    createdAt: teraz, updatedAt: teraz,
    importedFrom: ZNACZNIK
  });
  for (const r of doWyrownania) {
    dokMoves.push(nowyRuch({
      itemCode: r.itemCode,
      from: r.roznica > 0 ? idLok('VIRT/Inventory') : idLok('WH/Stock'),
      to: r.roznica > 0 ? idLok('WH/Stock') : idLok('VIRT/Inventory'),
      qty: Math.abs(r.roznica), kind: 'adjustment', operationId: String(opId),
      when: teraz, note: 'Wyrównanie do stanu Odoo'
    }));
  }
}

raport.operacje = dokOps.reduce((a, o) => ({ ...a, [o.type]: (a[o.type] || 0) + 1 }), {});
raport.ruchow = dokMoves.length;

// Liczniki numeracji muszą przeskoczyć za najwyższy zaimportowany numer.
// Dokumenty z Odoo niosą własne odnośniki (`mag/IN/00056`), a `reference` ma
// indeks unikalny — licznik zostawiony na zerze sprawiał, że pierwsza operacja
// zakładana w aplikacji dostawała numer już zajęty i zapis się wywracał.
const maxNumeru = new Map();
for (const o of dokOps) {
  const m = /^(.*)\/(\d+)$/.exec(String(o.reference || ''));
  if (!m) continue;
  const [, prefiks, numer] = m;
  maxNumeru.set(prefiks, Math.max(maxNumeru.get(prefiks) || 0, Number(numer)));
}
raport.licznikiNumeracji = Object.fromEntries(maxNumeru);

if (ZAPISZ) {
  if (dokOps.length) await ops.insertMany(dokOps);
  if (dokMoves.length) await moves.insertMany(dokMoves);
  for (const [prefiks, numer] of maxNumeru) {
    const biezacy = await db.collection(collections.counters).findOne({ _id: `ref:${prefiks}` });
    if (!biezacy || (biezacy.seq || 0) < numer) {
      await db.collection(collections.counters).updateOne(
        { _id: `ref:${prefiks}` }, { $set: { seq: numer } }, { upsert: true }
      );
    }
  }
  await recomputeQuants(db);
  for (const kod of potrzebneKody) await refreshItemCache(db, kod);
}

console.log(JSON.stringify(raport, null, 2));
if (!ZAPISZ) console.error('\nPRÓBA NA SUCHO — nic nie zapisano. Dodaj --zapisz, żeby wykonać.');
if (raport.rozbieznosciStanu.length) {
  console.error(`\nUWAGA: ${raport.rozbieznosciStanu.length} kartotek miało stan z historii inny niż w Odoo —`);
  console.error('domknięte dokumentem odoo/ADJ-WYR/00001. To ślad po ręcznej edycji stanu w Odoo');
  console.error('poza rejestrem ruchów; warto sprawdzić, która liczba jest prawdziwa. Szczegóły w „rozbieznosciStanu”.');
}

await closeDb();
