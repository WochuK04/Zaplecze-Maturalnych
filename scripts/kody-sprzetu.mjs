// Ujednolicenie kodów kartotek SPRZĘTU do schematu aplikacji + mapowanie
// stary → nowy dla księgowości.
//
// Schemat jest jeden i mieszka w `src/lib/item-code.js`: PREFIKS-SUFIKS, gdzie
// prefiks to cztery pierwsze litery kategorii („Akcesoria" → `AKCE-MQTBGLJ5`).
// Tego samego używa aplikacja przy zakładaniu kartoteki i przy zmianie kategorii,
// więc kod nadany ręcznie poza tym schematem i tak zostanie kiedyś przez nią
// przemianowany — lepiej zrobić to raz, świadomie.
//
// ODTWARZANIE ORYGINAŁÓW. Wcześniejsza wersja tego skryptu normalizowała kody
// w drugą stronę (`AKCE-MQ9LIJT0` → `AS046`), co było pomyłką. Podanie tamtego
// pliku mapowania przez `--przywroc=` sprawia, że kartoteki wracają do swoich
// pierwotnych kodów, zamiast dostawać świeżo wylosowane. To istotne: ich etykiety
// i kody QR mogą nadal nosić oryginał.
//
// Magazyn zostaje przy kodach z Odoo (`G039`, `T003`, `O011`) i tego NIE ruszamy —
// parytet z Odoo musi przeżyć każdy kolejny import.
//
// Zmiana idzie przez `cascadeItemCodeRename`, więc ruchy, stany, wypożyczenia
// i dokumenty jadą razem z kartoteką. `qrCodeValue` aktualizujemy tylko wtedy,
// gdy trzymał stary kod.
//
// Użycie:
//   node scripts/kody-sprzetu.mjs                                   # na sucho
//   node scripts/kody-sprzetu.mjs --przywroc=mapowanie-kodow-sprzetu-2026-09-28.json
//   node scripts/kody-sprzetu.mjs --przywroc=… --zapisz

import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectToDatabase, closeDb } from '../src/db.js';
import { collections } from '../src/schema.js';
import { cascadeItemCodeRename } from '../src/stock.js';
import { isWarehouseCategory } from '../src/lib/categories.js';
import { itemCodePrefix, itemCodeSuffix, matchesScheme } from '../src/lib/item-code.js';

const tutaj = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(tutaj, '../.env') });

const args = process.argv.slice(2);
const ZAPISZ = args.includes('--zapisz');
const PRZYWROC = (args.find((a) => a.startsWith('--przywroc=')) || '').slice(11);

const KATALOG = path.join(process.cwd(), 'Materiały do gitignore');

// Poprzednie mapowanie: nowyKod → staryKod. Pozwala oddać kartotece jej pierwotny
// kod zamiast losować kolejny.
const oryginaly = new Map();
let sciezkaPrzywrocenia = null;
if (PRZYWROC) {
  sciezkaPrzywrocenia = path.resolve(path.isAbsolute(PRZYWROC) ? PRZYWROC : path.join(KATALOG, path.basename(PRZYWROC)));
  for (const m of JSON.parse(fs.readFileSync(sciezkaPrzywrocenia, 'utf8'))) {
    if (m.nowyKod && m.staryKod) oryginaly.set(m.nowyKod, m.staryKod);
  }
}

const db = await connectToDatabase();
const items = db.collection(collections.items);

const wszystkie = await items.find({}, { projection: { itemCode: 1, category: 1, name: 1, quantity: 1, qrCodeValue: 1 } }).toArray();
const sprzet = wszystkie.filter((i) => !isWarehouseCategory(i.category));
const zajete = new Set(wszystkie.map((i) => String(i.itemCode).toUpperCase()));

// Kody z Odoo są zarezerwowane — sprzęt nie ma prawa na nich usiąść.
let kodyOdoo = new Set();
try {
  const plik = path.join(KATALOG, 'odoo', 'produkty.json');
  kodyOdoo = new Set(JSON.parse(fs.readFileSync(plik, 'utf8')).filter((p) => p.kod).map((p) => String(p.kod).toUpperCase()));
} catch { /* brak pobrania z Odoo — kolizji nie sprawdzamy */ }

const wolny = (kod) => kod && !zajete.has(kod.toUpperCase()) && !kodyOdoo.has(kod.toUpperCase());

let licznik = 0;
const nowyKod = (kategoria) => {
  for (let i = 0; i < 8; i += 1) {
    const kandydat = `${itemCodePrefix(kategoria)}-${itemCodeSuffix(String(licznik++))}`;
    if (wolny(kandydat)) { zajete.add(kandydat.toUpperCase()); return kandydat; }
  }
  const awaryjny = `${itemCodePrefix(kategoria)}-${itemCodeSuffix(`${licznik++}X`)}`;
  zajete.add(awaryjny.toUpperCase());
  return awaryjny;
};

const mapowanie = [];
for (const i of sprzet.sort((a, b) => String(a.category).localeCompare(String(b.category), 'pl') || String(a.itemCode).localeCompare(String(b.itemCode)))) {
  const kod = String(i.itemCode);
  const kolidujeZOdoo = kodyOdoo.has(kod.toUpperCase());
  if (matchesScheme(kod, i.category) && !kolidujeZOdoo) continue;

  // Najpierw próbujemy oddać kartotece jej pierwotny kod — o ile trzymał się
  // schematu i nikt go w międzyczasie nie zajął.
  const oryginal = oryginaly.get(kod);
  const przywrocony = oryginal && matchesScheme(oryginal, i.category) && wolny(oryginal) ? oryginal : null;
  if (przywrocony) zajete.add(przywrocony.toUpperCase());

  mapowanie.push({
    staryKod: kod,
    nowyKod: przywrocony || nowyKod(i.category),
    kategoria: i.category,
    nazwa: i.name,
    ilosc: i.quantity ?? 0,
    powod: kolidujeZOdoo ? 'kolizja z numeracją Odoo'
      : przywrocony ? 'przywrócony kod pierwotny'
        : 'kod poza schematem aplikacji'
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

// CSV z BOM (Excel poprawnie czyta polskie znaki) + JSON do dalszego przetwarzania.
fs.mkdirSync(KATALOG, { recursive: true });
// Znacznik z godziną, nie samą datą: plik wyjściowy nie może nadpisać pliku
// podanego w `--przywroc`, a przy tej samej nazwie właśnie to się działo.
const stempel = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
const esc = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const nag = ['staryKod', 'nowyKod', 'kategoria', 'nazwa', 'ilosc', 'powod'];
const plikCsv = path.join(KATALOG, `mapowanie-kodow-sprzetu-${stempel}.csv`);
const plikJson = plikCsv.replace('.csv', '.json');
// Twarda blokada: plik wyjściowy nie może być tym, z którego przywracamy kody.
// Przy nazwie opartej o samą datę skrypt kasował własne źródło w trakcie działania.
if (sciezkaPrzywrocenia && [plikCsv, plikJson].some((f) => path.resolve(f) === sciezkaPrzywrocenia)) {
  console.error(`PRZERWANE: plik wyjściowy nadpisałby źródło przywracania (${sciezkaPrzywrocenia}).`);
  await closeDb();
  process.exit(1);
}
fs.writeFileSync(plikCsv, '﻿' + [nag.join(';'), ...mapowanie.map((m) => nag.map((k) => esc(m[k])).join(';'))].join('\n'));
fs.writeFileSync(plikJson, JSON.stringify(mapowanie, null, 2));

console.log(JSON.stringify({
  baza: process.env.MONGO_DB_NAME || process.env.DB_NAME,
  naSucho: !ZAPISZ,
  kartotekSprzetu: sprzet.length,
  doZmiany: mapowanie.length,
  juzWSchemacie: sprzet.length - mapowanie.length,
  wgPowodu: mapowanie.reduce((a, m) => ({ ...a, [m.powod]: (a[m.powod] || 0) + 1 }), {}),
  mapowanie: plikCsv
}, null, 2));

if (!ZAPISZ) console.error('\nPRÓBA NA SUCHO — kody nie zostały zmienione. Plik mapowania i tak powstał.');

await closeDb();
