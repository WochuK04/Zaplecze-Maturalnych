// Import produktów z eksportu Odoo `product.template` (.xlsx) do kolekcji `items`.
//
// Mapowanie kolumn Odoo -> pola apki:
//   Odnośnik wewnętrzny -> itemCode    Nazwa -> name    Kategoria produktu -> category
//   Ilość Na Stanie -> quantity (stan; 0 dozwolone)    Cena sprzedaży -> notes (zachowana)
//
// Dedup: pomija duplikaty kodów w pliku oraz kody już obecne w bazie (additywnie).
// Po imporcie uruchom `node scripts/migrate-warehouse.js`, by zmaterializować
// stan otwarcia w modelu „w stylu Odoo" (ruchy/quants) — kanoniczne źródło stanu.
//
// Użycie:  node scripts/import-products.js ["/ścieżka/do/Produkt (product.template).xlsx"] [--dry]
// Cel bazy: z .env (lokalnie localhost) — patrz src/db.js.

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import xlsxPkg from 'xlsx';
import { connectToDatabase, closeDb } from '../src/db.js';
import { collections, ensureIndexes } from '../src/schema.js';

const xlsx = xlsxPkg.default || xlsxPkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FILE = args.find(a => !a.startsWith('--')) || '/Users/kacper/Downloads/Produkt (product.template).xlsx';

const COL = {
  code: 'Odnośnik wewnętrzny',
  name: 'Nazwa',
  category: 'Kategoria produktu',
  qty: 'Ilość Na Stanie',
  price: 'Cena sprzedaży'
};

const normCode = v => String(v ?? '').trim().toUpperCase();

async function main() {
  const wb = xlsx.readFile(FILE);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: null });

  const now = new Date();
  const errors = [];
  const valid = [];
  const seen = new Set();

  rows.forEach((r, i) => {
    const rowNo = i + 2; // +2: wiersz nagłówka + indeks od 1
    const itemCode = normCode(r[COL.code]);
    const name = String(r[COL.name] ?? '').trim();
    const category = String(r[COL.category] ?? '').trim();
    if (!itemCode || !name || !category) {
      errors.push({ row: rowNo, itemCode: itemCode || '(brak)', reason: 'brak kodu/nazwy/kategorii' });
      return;
    }
    if (seen.has(itemCode)) {
      errors.push({ row: rowNo, itemCode, reason: 'duplikat kodu w pliku' });
      return;
    }
    seen.add(itemCode);
    valid.push({
      itemCode, name, category,
      stock: Math.max(0, Math.floor(Number(r[COL.qty]) || 0)),
      price: r[COL.price]
    });
  });

  const db = await connectToDatabase();
  await ensureIndexes(db);

  const existing = valid.length
    ? new Set((await db.collection(collections.items)
        .find({ itemCode: { $in: valid.map(v => v.itemCode) } }, { projection: { itemCode: 1 } })
        .toArray()).map(d => d.itemCode))
    : new Set();

  const docs = [];
  for (const v of valid) {
    if (existing.has(v.itemCode)) {
      errors.push({ itemCode: v.itemCode, reason: 'kod już istnieje w bazie' });
      continue;
    }
    docs.push({
      itemCode: v.itemCode,
      category: v.category,
      name: v.name,
      details: '',
      quantity: v.stock,
      currentLocation: 'Magazyn',
      conditionStatus: 'good',
      operationalStatus: 'available',
      assignedToName: null,
      assignedToEmail: null,
      notes: (v.price != null && v.price !== '')
        ? `Cena sprzedaży: ${v.price} PLN (import Odoo)`
        : 'Import Odoo product.template',
      imageUrl: '', thumbnailUrl: '', brand: '', model: '', qrCodeValue: '',
      tags: [], serialNumber: '', warrantyUntil: '', detailedLocation: '',
      isStudioLocked: false, isActive: true, createdAt: now, updatedAt: now
    });
  }

  let added = 0;
  if (docs.length && !DRY) {
    const res = await db.collection(collections.items).insertMany(docs, { ordered: false });
    added = res.insertedCount;
  }

  const itemsTotal = await db.collection(collections.items).countDocuments({});
  console.log(JSON.stringify({
    file: path.basename(FILE),
    dryRun: DRY,
    db: process.env.MONGO_DB_NAME || process.env.DB_NAME,
    wierszyWPliku: rows.length,
    doDodania: docs.length,
    dodano: added,
    pominieto: errors.length,
    itemsWBaziePoImporcie: itemsTotal,
    bledy: errors
  }, null, 2));

  await closeDb();
}

main().catch(async err => {
  console.error(err);
  await closeDb().catch(() => {});
  process.exit(1);
});
