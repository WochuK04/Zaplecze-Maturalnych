// Dosypuje partie cenowe o ilości 0 kartotekom, które w Odoo mają koszt, ale nie mają
// stanu — żeby ich historia ruchów dała się wycenić.
//
// Po co osobny skrypt, skoro naprawiony jest już sam import (src/odoo.js): produkcja
// została zaimportowana WCZEŚNIEJ, więc te partie tam nie powstały. Pełny import
// (~06.10) załatwi to sam, ale do tego czasu raport „Ruchy w okresie" i wydruki
// przyjęć pokazują pustkę zamiast kwot, których Odoo wcale nie ukrywa. Ten skrypt
// domyka lukę, nie ruszając niczego innego.
//
// Co robi DOKŁADNIE: dla produktu Magazynu bez ani jednej partii cenowej, którego
// odpowiednik w Odoo ma koszt > 0, dopisuje jedną partię `{ qty: 0, unitPrice: koszt }`.
// Nie dotyka ilości, nie dotyka produktów, które partie już mają, nie tworzy ruchów.
//
// Użycie:
//   node scripts/odoo-koszty-bez-stanu.mjs                                  # na sucho
//   MONGODB_URI='<atlas>' DB_NAME=maturalni_equipment \
//     node scripts/odoo-koszty-bez-stanu.mjs --zapisz --potwierdz=maturalni_equipment

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectToDatabase, closeDb } from '../src/db.js';
import { collections } from '../src/schema.js';
import { tylkoAktywne } from '../src/odoo.js';
import { isWarehouseCategory } from '../src/lib/categories.js';
import { zastosujPoprawki } from '../src/odoo-poprawki.js';
import { wczytaj } from './odoo/zrodlo.mjs';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const args = process.argv.slice(2);
const ZAPISZ = args.includes('--zapisz');
const POTWIERDZ = (args.find((a) => a.startsWith('--potwierdz=')) || '').split('=')[1] || '';
const sciezki = args.filter((a) => !a.startsWith('--'));

const zrodlo = wczytaj(sciezki);

// Ta sama kolejność co w imporcie: najpierw poprawki (nadają kod kartotekom bez
// odnośnika), potem odsiew archiwalnych. Archiwalne odpadają celowo — to przez nie
// `G041` znaczy naraz „Krówki matura" (41,85 zł, zarchiwizowane) i „Planer 8 mies mat"
// (14,21 zł, aktywny). Wzięcie pierwszej lepszej wyceniłoby planery ceną krówek.
const { kartoteki } = zastosujPoprawki(zrodlo.produkty);
const aktywne = tylkoAktywne(kartoteki);

const kosztWgKodu = new Map();
for (const k of aktywne) {
  const kod = String(k.kod ?? '').trim().toUpperCase();
  const koszt = Number(k.koszt) || 0;
  if (!kod || koszt <= 0) continue;
  // Przy dwóch aktywnych kartotekach o tym samym kodzie bierzemy wyższy stan —
  // tak samo rozstrzyga to `findDuplicateCodes` w imporcie.
  const poprzednia = kosztWgKodu.get(kod);
  if (!poprzednia || (Number(k.stan) || 0) > poprzednia.stan) {
    kosztWgKodu.set(kod, { koszt: Math.round(koszt * 100) / 100, stan: Number(k.stan) || 0 });
  }
}

const db = await connectToDatabase();
const nazwaBazy = db.databaseName;
const host = (process.env.MONGODB_URI || process.env.MONGO_URI || '').includes('mongodb+srv')
  ? `${nazwaBazy} ← ATLAS (produkcja)` : nazwaBazy;
console.log(`Baza: ${host}\n`);

const items = await db.collection(collections.items)
  .find({ isActive: { $ne: false } }, { projection: { itemCode: 1, name: 1, category: 1, quantity: 1, priceBatches: 1 } })
  .toArray();

const doUzupelnienia = [];
const bezKosztuWOdoo = [];
for (const it of items) {
  if (!isWarehouseCategory(it.category)) continue;
  if (Array.isArray(it.priceBatches) && it.priceBatches.length) continue;
  const wpis = kosztWgKodu.get(String(it.itemCode || '').toUpperCase());
  if (!wpis) { bezKosztuWOdoo.push(it); continue; }
  doUzupelnienia.push({ item: it, koszt: wpis.koszt });
}

console.log(`Produktów Magazynu bez ani jednej partii cenowej: ${doUzupelnienia.length + bezKosztuWOdoo.length}`);
console.log(`  z kosztem w Odoo — DO UZUPEŁNIENIA: ${doUzupelnienia.length}`);
console.log(`  bez kosztu w Odoo — zostają bez wyceny: ${bezKosztuWOdoo.length}\n`);

if (doUzupelnienia.length) {
  console.log('KOD     NAZWA                                        KOSZT');
  for (const { item, koszt } of doUzupelnienia.sort((a, b) => b.koszt - a.koszt)) {
    console.log(String(item.itemCode).padEnd(8), String(item.name || '').slice(0, 44).padEnd(46), koszt.toFixed(2).padStart(8));
  }
}
if (bezKosztuWOdoo.length) {
  console.log('\nBez kosztu w Odoo (nie ruszam — to dziura w danych po tamtej stronie):');
  for (const it of bezKosztuWOdoo) console.log('  ', String(it.itemCode).padEnd(8), String(it.name || '').slice(0, 44));
}

if (!ZAPISZ) {
  console.error('\nPRÓBA NA SUCHO — nic nie zapisano. Dodaj --zapisz --potwierdz=<nazwa bazy>.');
  await closeDb();
  process.exit(0);
}
if (POTWIERDZ !== nazwaBazy) {
  console.error(`\nPRZERWANE: --potwierdz="${POTWIERDZ}" nie zgadza się z nazwą bazy "${nazwaBazy}".`);
  await closeDb();
  process.exit(1);
}

const teraz = new Date();
let zapisanych = 0;
for (const { item, koszt } of doUzupelnienia) {
  await db.collection(collections.items).updateOne(
    { _id: item._id },
    {
      $set: {
        priceBatches: [{ qty: 0, unitPrice: koszt, note: `Odoo ${item.itemCode} (koszt bez stanu)`, addedAt: teraz }],
        updatedAt: teraz
      }
    }
  );
  zapisanych += 1;
}

console.log(`\nZapisano partie cenowe dla ${zapisanych} produktów. Ilości i ruchy nietknięte.`);
await closeDb();
