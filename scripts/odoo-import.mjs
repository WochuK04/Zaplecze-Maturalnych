// Import najnowszej bazy produktów z Odoo do `items` — ze SCALENIEM kartotek.
//
// Scalamy kartoteki o tej samej nazwie i tej samej kategorii (G039 + G046 „Arkusz
// polski e8") w JEDEN produkt, ale każda kartoteka zostaje osobną PARTIĄ CENOWĄ
// (`priceBatches`), bo każda to inna transza o innym koszcie. Ilość produktu =
// suma partii, rozchód zdejmuje FIFO — tak jak reszta magazynu (src/stock.js).
//
// Czego NIE scalamy: pary Towar↔gadżet o tej samej nazwie (T003 + G060). To nie
// duplikat, tylko ślad przetworzenia towaru w gadżet — scalenie zabiłoby historię
// przetworzeń i raport „prezent ≤20 zł". Te pary raportujemy osobno, do wglądu.
//
// Kody wchłoniętych kartotek trafiają do `mergedCodes` i są kaskadowo przepisane
// na kod wiodący we wszystkich kolekcjach (ruchy, stan, wypożyczenia, operacje),
// więc stare etykiety i historia nadal się rozwiązują.
//
// Użycie:
//   node scripts/odoo-import.mjs                       # próba na sucho, dane z RPC
//   node scripts/odoo-import.mjs "…/Produkt (product.template).xlsx"
//   node scripts/odoo-import.mjs --zapisz              # dopiero to zapisuje
//
// Cel bazy bierze się z .env (patrz src/db.js). NA PRODUKCJI uruchamiaj z
// MONGODB_URI Atlasu — lokalny .env wskazuje localhost.

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectToDatabase, closeDb } from '../src/db.js';
import { collections, ensureIndexes } from '../src/schema.js';
import { cascadeItemCodeRename, recomputeQuants } from '../src/stock.js';
import { mergeProducts, findConversionCandidates, tylkoAktywne, findDuplicateCodes } from '../src/odoo.js';
import { wczytaj } from './odoo/zrodlo.mjs';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const args = process.argv.slice(2);
const ZAPISZ = args.includes('--zapisz');
const sciezki = args.filter((a) => !a.startsWith('--'));

const zrodlo = wczytaj(sciezki);
const teraz = new Date();
const kartoteki = tylkoAktywne(zrodlo.produkty);
const wszystkie = mergeProducts(kartoteki, { teraz });
const bezKodu = kartoteki.filter((p) => !String(p.kod ?? '').trim());

// Zbieg odnośników wewnętrznych (Odoo ich nie pilnuje): kod zostaje przy grupie
// o większym stanie, przegrywające pomijamy — `items.itemCode` musi być unikalny.
const konflikty = findDuplicateCodes(wszystkie);
const pominiete = new Set(konflikty.flatMap((k) => k.przegrywaja));
const produkty = wszystkie.filter((p) => !pominiete.has(p));

const db = await connectToDatabase();
await ensureIndexes(db);
const items = db.collection(collections.items);

// Kody, których quanty trzeba odbudować z ruchów po scaleniu.
const doPrzeliczenia = new Set();

const raport = {
  zrodlo: zrodlo.zrodlo,
  pliki: zrodlo.pliki,
  kosztWZrodle: zrodlo.koszty,
  baza: process.env.DB_NAME || process.env.MONGO_DB_NAME,
  naSucho: !ZAPISZ,
  kartotekOdoo: zrodlo.produkty.length,
  produktowPoScaleniu: produkty.length,
  scalono: [],
  wchlonietoDokumentow: 0,
  utworzono: [],
  zaktualizowano: [],
  kartotekZarchiwizowanych: zrodlo.produkty.length - kartoteki.length,
  pominietoBezKodu: bezKodu.map((p) => ({ nazwa: p.nazwa, kategoria: p.kategoria, stan: p.stan })),
  konfliktyKodow: konflikty.map((k) => ({
    itemCode: k.itemCode,
    zostaje: `${k.wygrywa.name} [${k.wygrywa.category}] — ${k.wygrywa.quantity} szt.`,
    pominieto: k.przegrywaja.map((x) => `${x.name} [${x.category}] — ${x.quantity} szt.`)
  })),
  paryTowarGadzet: []
};

// Pary tej samej nazwy w różnych kategoriach — do ręcznego przejrzenia. Zostają
// osobnymi produktami; tu tylko mówimy, że istnieją.
for (const k of findConversionCandidates(kartoteki)) {
  raport.paryTowarGadzet.push({
    nazwa: k.nazwa,
    kartoteki: k.kartoteki.map((x) => `${x.kod}/${x.kategoria}(${x.stan})`)
  });
}

for (const p of produkty) {
  const wszystkieKody = [p.itemCode, ...p.mergedCodes];
  const istniejace = await items.find({ itemCode: { $in: wszystkieKody } }).toArray();
  const wiodacy = istniejace.find((d) => d.itemCode === p.itemCode) || null;
  const doWchloniecia = istniejace.filter((d) => d.itemCode !== p.itemCode);

  const pola = {
    name: p.name,
    category: p.category,
    quantity: p.quantity,
    priceBatches: p.priceBatches,
    mergedCodes: p.mergedCodes,
    odooSyncAt: teraz,
    updatedAt: teraz
  };

  // Raportujemy SCALENIE LOGICZNE (ile kartotek Odoo złożyło się na ten produkt),
  // niezależnie od tego, czy wchłonięte kody miały już swój dokument w bazie.
  if (p.mergedCodes.length) {
    raport.scalono.push({
      itemCode: p.itemCode,
      nazwa: p.name,
      zKartotek: [p.itemCode, ...p.mergedCodes],
      dokumentyWchloniete: doWchloniecia.map((d) => d.itemCode),
      ilosc: p.quantity,
      partie: p.priceBatches.map((b) => `${b.qty} szt. × ${b.unitPrice} zł (${b.note})`)
    });
  }
  raport.wchlonietoDokumentow += doWchloniecia.length;

  if (!ZAPISZ) {
    if (wiodacy || doWchloniecia.length) raport.zaktualizowano.push({ itemCode: p.itemCode, nazwa: p.name, ilosc: p.quantity });
    else raport.utworzono.push({ itemCode: p.itemCode, nazwa: p.name, ilosc: p.quantity });
    continue;
  }

  // Który dokument przeżyje scalenie: ten pod kodem wiodącym, a gdy go w bazie nie
  // ma — pierwszy z wchłanianych, awansowany na kod wiodący. Chodzi o to, żeby nie
  // wyrzucić zdjęć, notatek i tagów wpisanych ręcznie w zapleczu.
  const zachowany = wiodacy || doWchloniecia[0] || null;
  const doUsuniecia = doWchloniecia.filter((d) => d !== zachowany);

  // Quanty kasujemy PRZED kaskadą, a nie przepisujemy: `uniq_quant_item_loc_lot`
  // nie zniesie dwóch kartotek stojących na tej samej lokalizacji (a po scaleniu
  // obie stoją na „Magazynie"). Stan i tak odtwarza się z ruchów, więc niżej
  // wołamy recomputeQuants. Kaskada nie rusza samego `items` — to robimy tutaj.
  for (const d of doWchloniecia) {
    await db.collection(collections.quants).deleteMany({ itemCode: d.itemCode });
    await cascadeItemCodeRename(db, d.itemCode, p.itemCode);
    doPrzeliczenia.add(p.itemCode);
  }
  for (const d of doUsuniecia) await items.deleteOne({ _id: d._id });

  if (zachowany) {
    await items.updateOne({ _id: zachowany._id }, { $set: { itemCode: p.itemCode, ...pola } });
    raport.zaktualizowano.push({
      itemCode: p.itemCode, nazwa: p.name, ilosc: p.quantity,
      ...(wiodacy ? {} : { przejeteZ: zachowany.itemCode })
    });
  } else {
    await items.insertOne({
      itemCode: p.itemCode,
      ...pola,
      details: '',
      currentLocation: 'Magazyn',
      conditionStatus: 'good',
      operationalStatus: 'available',
      assignedToName: null,
      assignedToEmail: null,
      notes: 'Import Odoo product.template',
      imageUrl: '', thumbnailUrl: '', brand: '', model: '', qrCodeValue: '',
      tags: [], serialNumber: '', warrantyUntil: '', detailedLocation: '',
      isStudioLocked: false, isActive: true, createdAt: teraz
    });
    raport.utworzono.push({ itemCode: p.itemCode, nazwa: p.name, ilosc: p.quantity });
  }
}

// Odbudowa stanu z rejestru ruchów dla scalonych kodów. Świadomie NIE wołamy tu
// refreshItemCache: `items.quantity` ma zostać tym, co mówi Odoo (suma partii).
// Ruchy zrówna z tym dopiero `odoo-historia.mjs`.
for (const kod of doPrzeliczenia) await recomputeQuants(db, kod);

raport.podsumowanie = {
  utworzono: raport.utworzono.length,
  zaktualizowano: raport.zaktualizowano.length,
  grupScalonych: raport.scalono.length,
  kartotekZlozonychWGrupy: raport.scalono.reduce((n, g) => n + g.zKartotek.length, 0),
  wchlonietoIstniejacychDokumentow: raport.wchlonietoDokumentow,
  parTowarGadzet: raport.paryTowarGadzet.length,
  konfliktowKodow: raport.konfliktyKodow.length,
  itemsWBazie: await items.countDocuments({})
};

console.log(JSON.stringify(raport, null, 2));
if (!ZAPISZ) console.error('\nPRÓBA NA SUCHO — nic nie zapisano. Dodaj --zapisz, żeby wykonać.');
if (konflikty.length) {
  console.error(`\nUWAGA: ${konflikty.length} odnośnik(ów) wewnętrznych występuje w Odoo dwa razy.`);
  for (const k of konflikty) console.error(`  ${k.itemCode}: zostaje „${k.wygrywa.name}", pominięto ${k.przegrywaja.map((x) => `„${x.name}"`).join(', ')}`);
  console.error('Rozstrzygnij to w Odoo — u nas kod produktu musi być unikalny.');
}
if (!zrodlo.koszty) {
  console.error('\nUWAGA: źródło nie ma kosztu — partie wchodzą po 0 zł.');
  console.error('Koszt bierze się z pola `standard_price` w Odoo: uruchom `node scripts/odoo-pobierz.mjs --all`,');
  console.error('albo dołóż w eksporcie .xlsx kolumnę „Koszt".');
}

await closeDb();
