// Ujednolicenie kodów kartotek SPRZĘTU + mapowanie stary → nowy dla księgowości.
//
// Schemat: PREFIKS KATEGORII + trzycyfrowy numer (AS014, K007, STA003). Prefiksy
// biorą się z tego, co w bazie już dominuje — nie wymyślamy od zera, żeby nie
// przedrukowywać etykiet, które i tak są poprawne.
//
// Przenumerowujemy TYLKO kartoteki, które odstają:
//   • kolidujące z numeracją Odoo (Statywy siedzą na T001–T005, a `T003` to
//     w Odoo „Egzaminatorium matematyka" — jedna kolekcja `items`, dwa światy);
//   • kody śmieciowe (DUPA, DUPA14-45);
//   • kody generowane automatycznie (AKCE-MQTBGLJ5, LAPT-MQZ1QHHS);
//   • kartoteki z prefiksem innej kategorii (lampa z prefiksem akcesoriów).
//
// Magazyn zostaje przy kodach z Odoo (G039, T003, O011) i tego NIE ruszamy —
// parytet z Odoo musi przeżyć każdy kolejny import.
//
// Zmiana kodu idzie przez `cascadeItemCodeRename`, więc ruchy, stany, wypożyczenia,
// wnioski i dokumenty operacji jadą razem z kartoteką. `qrCodeValue` aktualizujemy
// tylko wtedy, gdy trzymał stary kod.
//
// Użycie:
//   node scripts/kody-sprzetu.mjs            # próba na sucho + plik mapowania
//   node scripts/kody-sprzetu.mjs --zapisz
//
// Mapowanie ląduje w „Materiały do gitignore/" jako .csv (Excel) i .json.

import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectToDatabase, closeDb } from '../src/db.js';
import { collections } from '../src/schema.js';
import { cascadeItemCodeRename } from '../src/stock.js';
import { isWarehouseCategory } from '../src/lib/categories.js';

const tutaj = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(tutaj, '../.env') });

const ZAPISZ = process.argv.includes('--zapisz');

// Jedna kategoria — jeden prefiks. Kategorii spoza tej mapy nie ruszamy.
const PREFIKS = {
  'Akcesoria': 'AS',
  'Audio': 'AU',
  'Kamery': 'K',
  'Lampy': 'L',
  'Laptop': 'PC',
  'Monitory': 'M',
  'Roll-up': 'R',
  'Prompter': 'P',
  'Statywy': 'STA',
  'Stream': 'ST',
  'Komputer': 'KOM',
  'Zakup': 'ZAK',
  'Zdrowie': 'ZDR'
};

const SMIECIOWY = /DUPA/i;
const GENEROWANY = /^[A-Z]{3,5}-[A-Z0-9]{8,}$/i;

const db = await connectToDatabase();
const items = db.collection(collections.items);

const wszystkie = await items.find({}, { projection: { itemCode: 1, category: 1, name: 1, quantity: 1, qrCodeValue: 1 } }).toArray();
const sprzet = wszystkie.filter((i) => !isWarehouseCategory(i.category));
const kodyZajete = new Set(wszystkie.map((i) => String(i.itemCode).toUpperCase()));

// Kody, których używa Odoo — sprzęt nie ma prawa na nich siedzieć.
let kodyOdoo = new Set();
try {
  const plik = path.join(process.cwd(), 'Materiały do gitignore', 'odoo', 'produkty.json');
  kodyOdoo = new Set(JSON.parse(fs.readFileSync(plik, 'utf8')).filter((p) => p.kod).map((p) => String(p.kod).toUpperCase()));
} catch { /* brak pobrania z Odoo — kolizji nie sprawdzamy, reszta reguł działa */ }

const pasuje = (kod, prefiks) => new RegExp(`^${prefiks}\\d+$`, 'i').test(kod);

function powod(i) {
  const kod = String(i.itemCode);
  const prefiks = PREFIKS[i.category];
  if (!prefiks) return null;
  if (kodyOdoo.has(kod.toUpperCase())) return 'kolizja z numeracją Odoo';
  if (SMIECIOWY.test(kod)) return 'kod śmieciowy';
  if (GENEROWANY.test(kod)) return 'kod generowany automatycznie';
  if (!pasuje(kod, prefiks)) return `prefiks nie pasuje do kategorii (oczekiwany ${prefiks})`;
  return null;
}

// Numeracja startuje za najwyższym zajętym numerem w serii, żeby nie wejść
// na kod, który ktoś ma już na etykiecie.
const licznik = new Map();
for (const [kategoria, prefiks] of Object.entries(PREFIKS)) {
  const max = sprzet
    .filter((i) => pasuje(String(i.itemCode), prefiks))
    .map((i) => Number(String(i.itemCode).slice(prefiks.length)))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => Math.max(a, b), 0);
  licznik.set(kategoria, max);
}

const nastepny = (kategoria) => {
  const prefiks = PREFIKS[kategoria];
  let n = licznik.get(kategoria) || 0;
  let kod;
  do { kod = `${prefiks}${String(++n).padStart(3, '0')}`; } while (kodyZajete.has(kod.toUpperCase()));
  licznik.set(kategoria, n);
  kodyZajete.add(kod.toUpperCase());
  return kod;
};

const mapowanie = [];
for (const i of sprzet.sort((a, b) => String(a.category).localeCompare(String(b.category), 'pl') || String(a.itemCode).localeCompare(String(b.itemCode)))) {
  const p = powod(i);
  if (!p) continue;
  mapowanie.push({
    staryKod: i.itemCode,
    nowyKod: nastepny(i.category),
    kategoria: i.category,
    nazwa: i.name,
    ilosc: i.quantity ?? 0,
    powod: p
  });
}

if (ZAPISZ) {
  for (const m of mapowanie) {
    await cascadeItemCodeRename(db, m.staryKod, m.nowyKod);
    const zmiana = { itemCode: m.nowyKod, updatedAt: new Date() };
    const dok = sprzet.find((i) => i.itemCode === m.staryKod);
    if (dok && dok.qrCodeValue === m.staryKod) zmiana.qrCodeValue = m.nowyKod;
    await items.updateOne({ itemCode: m.staryKod }, { $set: zmiana });
  }
}

// Plik dla księgowości — CSV z BOM (Excel poprawnie czyta polskie znaki) i JSON.
const katalog = path.join(process.cwd(), 'Materiały do gitignore');
fs.mkdirSync(katalog, { recursive: true });
const stempel = new Date().toISOString().slice(0, 10);
const esc = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const naglowki = ['staryKod', 'nowyKod', 'kategoria', 'nazwa', 'ilosc', 'powod'];
const csv = '﻿' + [naglowki.join(';'), ...mapowanie.map((m) => naglowki.map((k) => esc(m[k])).join(';'))].join('\n');
const plikCsv = path.join(katalog, `mapowanie-kodow-sprzetu-${stempel}.csv`);
const plikJson = path.join(katalog, `mapowanie-kodow-sprzetu-${stempel}.json`);
fs.writeFileSync(plikCsv, csv);
fs.writeFileSync(plikJson, JSON.stringify(mapowanie, null, 2));

const wgKategorii = {};
for (const m of mapowanie) wgKategorii[m.kategoria] = (wgKategorii[m.kategoria] || 0) + 1;

console.log(JSON.stringify({
  baza: process.env.MONGO_DB_NAME || process.env.DB_NAME,
  naSucho: !ZAPISZ,
  kartotekSprzetu: sprzet.length,
  doPrzenumerowania: mapowanie.length,
  bezZmian: sprzet.length - mapowanie.length,
  wgKategorii,
  wgPowodu: mapowanie.reduce((a, m) => ({ ...a, [m.powod]: (a[m.powod] || 0) + 1 }), {}),
  mapowanie: { csv: plikCsv, json: plikJson }
}, null, 2));

if (!ZAPISZ) console.error('\nPRÓBA NA SUCHO — kody nie zostały zmienione. Plik mapowania i tak powstał, do przejrzenia.');

await closeDb();
