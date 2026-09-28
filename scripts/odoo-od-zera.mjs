// Magazyn od zera: wyczyszczenie dotychczasowych danych i pełny import z Odoo.
//
// Jedna komenda zamiast trzech, pomyślana pod wejście na Atlasa: kasuje to, co
// było, po czym uruchamia `odoo-import.mjs` (produkty + partie cenowe) i
// `odoo-historia.mjs` (ruchy, przekazy, przetworzenia). Skrypty odpalamy jako
// procesy potomne, żeby nie dublować ich logiki — mają zostać jedynym źródłem prawdy.
//
// BEZPIECZNIKI (operacja jest nieodwracalna):
//   • domyślnie PRÓBA NA SUCHO — pokazuje, co zniknie i co wejdzie, nic nie rusza;
//   • zapis wymaga `--potwierdz=<nazwa-bazy>` dokładnie zgodnej z celem, żeby nie
//     dało się zaorać produkcji, celując w bazę lokalną (i odwrotnie);
//   • zakres `magazyn` (domyślny) NIE dotyka sprzętu, użytkowników, wypożyczeń,
//     licencji ani mapy dostępów.
//
// Użycie:
//   node scripts/odoo-od-zera.mjs
//   node scripts/odoo-od-zera.mjs --zakres=wszystko
//   MONGODB_URI='<atlas>' node scripts/odoo-od-zera.mjs --zapisz --potwierdz=maturalni_equipment
//
// Wcześniej: `node scripts/odoo-pobierz.mjs --all` (dane z Odoo, z kosztem).

import dotenv from 'dotenv';
import path from 'path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'url';
import { connectToDatabase, closeDb } from '../src/db.js';
import { collections } from '../src/schema.js';
import { isWarehouseCategory } from '../src/lib/categories.js';

const tutaj = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(tutaj, '../.env') });

const args = process.argv.slice(2);
const ZAPISZ = args.includes('--zapisz');
const ZAKRES = (args.find((a) => a.startsWith('--zakres=')) || '--zakres=magazyn').slice(9);
const POTWIERDZENIE = (args.find((a) => a.startsWith('--potwierdz=')) || '').slice(12);

if (!['magazyn', 'wszystko'].includes(ZAKRES)) {
  console.error(`Nieznany zakres „${ZAKRES}". Dozwolone: magazyn, wszystko.`);
  process.exit(1);
}

const nazwaBazy = process.env.MONGO_DB_NAME || process.env.DB_NAME || 'equipment_db';
const uri = process.env.MONGO_URI || process.env.MONGODB_URI || '';
const host = (uri.match(/^[a-z+]+:\/\/(?:[^@/]*@)?([^/?]+)/i) || [])[1] || '(nieznany)';
const toAtlas = /mongodb\.net/i.test(uri);

// Kolekcje czyszczone w całości w zakresie „magazyn" — te należą wyłącznie do
// modułu, więc nie ma czego z nich wyławiać.
const KOLEKCJE_MAGAZYNU = [
  collections.stockOperations, collections.inventoryAdjustments, collections.reorderRules,
  collections.suppliers, collections.deliveryDestinations, collections.counters
];

// Rejestr stanu jest WSPÓLNY dla magazynu i sprzętu: `stockMoves`/`quants`/`lots`
// trzymają też stan otwarcia laptopów i kamer. Kasowanie ich w całości wywaliłoby
// sprzętowi rejestr, mimo że kartoteki miały zostać. Zdejmujemy więc tylko to, co
// dotyczy kasowanych kodów — plus ruchy z importu Odoo, gdyby któryś osierociał.
const REJESTR_STANU = [collections.stockMoves, collections.quants, collections.lots];

// Do zdjęcia idą też wpisy WISZĄCE — wskazujące na kartotekę, której już nie ma.
// Na produkcji leżało 34 takich ruchów `opening` po pozycjach magazynu skasowanych
// w czerwcu; pełne przeliczenie stanu materializowało z nich quanty, które raport
// spójności zgłaszał jako sieroty. Ruch bez kartoteki to śmieć niezależnie od tego,
// czyj był, więc zdejmujemy go razem z resztą.
const filtrRejestru = (kody, wiszace = []) =>
  ({ $or: [{ itemCode: { $in: [...kody, ...wiszace] } }, { importedFrom: 'odoo' }] });

// W zakresie „wszystko" zostawiamy konta i sesje — inaczej nikt się nie zaloguje,
// żeby to naprawić, a role i lista dostępu do Magazynu przepadają.
const NIETYKALNE = new Set([collections.users, 'sessions']);

const db = await connectToDatabase();

const plan = [];
let itemsDoUsuniecia = 0;
let itemsZostaje = 0;

let kodyMagazynu = [];
let kodyWiszace = [];

if (ZAKRES === 'magazyn') {
  const items = await db.collection(collections.items)
    .find({}, { projection: { category: 1, itemCode: 1 } }).toArray();
  const magazynowe = items.filter((i) => isWarehouseCategory(i.category));
  kodyMagazynu = magazynowe.map((i) => i.itemCode);

  const znane = new Set(items.map((i) => i.itemCode));
  kodyWiszace = [...new Set(
    (await db.collection(collections.stockMoves).find({}, { projection: { itemCode: 1 } }).toArray())
      .map((m) => m.itemCode)
  )].filter((k) => !znane.has(k));
  itemsDoUsuniecia = magazynowe.length;
  itemsZostaje = items.length - itemsDoUsuniecia;
  plan.push({ kolekcja: collections.items, usuwamy: itemsDoUsuniecia, zostaje: itemsZostaje, filtr: 'kategorie magazynowe' });
  for (const k of REJESTR_STANU) {
    const usuwamy = await db.collection(k).countDocuments(filtrRejestru(kodyMagazynu, kodyWiszace));
    const wszystkie = await db.collection(k).countDocuments({});
    plan.push({
      kolekcja: k, usuwamy, zostaje: wszystkie - usuwamy,
      filtr: kodyWiszace.length ? `kody magazynowe + ${kodyWiszace.length} wiszących` : 'tylko kody magazynowe'
    });
  }
  for (const k of KOLEKCJE_MAGAZYNU) {
    plan.push({ kolekcja: k, usuwamy: await db.collection(k).countDocuments({}), zostaje: 0, filtr: 'całość' });
  }
} else {
  for (const { name } of await db.listCollections().toArray()) {
    const n = await db.collection(name).countDocuments({});
    if (NIETYKALNE.has(name)) plan.push({ kolekcja: name, usuwamy: 0, zostaje: n, filtr: 'NIETYKALNE' });
    else plan.push({ kolekcja: name, usuwamy: n, zostaje: 0, filtr: 'całość' });
  }
}

const doUsuniecia = plan.reduce((s, p) => s + p.usuwamy, 0);

console.log('CEL');
console.log(`  baza:   ${nazwaBazy}`);
console.log(`  host:   ${host}${toAtlas ? '   ← ATLAS (produkcja)' : ''}`);
console.log(`  zakres: ${ZAKRES}`);
console.log(`  tryb:   ${ZAPISZ ? 'ZAPIS — nieodwracalnie' : 'próba na sucho (nic nie zniknie)'}`);
console.log('\nDO USUNIĘCIA');
for (const p of plan.filter((x) => x.usuwamy > 0)) {
  console.log(`  ${p.kolekcja.padEnd(22)} ${String(p.usuwamy).padStart(6)}   (${p.filtr})`);
}
if (!doUsuniecia) console.log('  (nic — baza jest już pusta w tym zakresie)');

const zostaje = plan.filter((x) => x.zostaje > 0);
if (zostaje.length) {
  console.log('\nZOSTAJE NIETKNIĘTE');
  const etykieta = (p) => (p.filtr === 'NIETYKALNE' ? 'nietykalne' : 'sprzęt i pozostałe');
  for (const p of zostaje) console.log(`  ${p.kolekcja.padEnd(22)} ${String(p.zostaje).padStart(6)}   (${etykieta(p)})`);
}
if (ZAKRES === 'magazyn') {
  console.log('\n  Poza zakresem w ogóle: użytkownicy, wypożyczenia, wnioski, licencje,');
  console.log('  mapa dostępów, wyjazdy, logi audytu, lokalizacje.');
}

if (!ZAPISZ) {
  console.log('\n— PRÓBA NA SUCHO — nic nie zostało zmienione.');
  console.log(`Aby wykonać: --zapisz --potwierdz=${nazwaBazy}`);
  await closeDb();
  process.exit(0);
}

if (POTWIERDZENIE !== nazwaBazy) {
  console.error(`\nPRZERWANE: --potwierdz musi być dokładnie „${nazwaBazy}" (podano: „${POTWIERDZENIE || 'brak'}").`);
  console.error('Ten bezpiecznik istnieje po to, żeby nie dało się zaorać nie tej bazy, co trzeba.');
  await closeDb();
  process.exit(1);
}

console.log('\nCZYSZCZENIE…');
if (ZAKRES === 'magazyn') {
  for (const k of REJESTR_STANU) {
    const { deletedCount } = await db.collection(k).deleteMany(filtrRejestru(kodyMagazynu, kodyWiszace));
    const zostalo = await db.collection(k).countDocuments({});
    console.log(`  ${k}: usunięto ${deletedCount}, zostało ${zostalo} (sprzęt)`);
  }
  const items = await db.collection(collections.items).find({}, { projection: { category: 1 } }).toArray();
  const doKasacji = items.filter((i) => isWarehouseCategory(i.category)).map((i) => i._id);
  if (doKasacji.length) await db.collection(collections.items).deleteMany({ _id: { $in: doKasacji } });
  console.log(`  ${collections.items}: usunięto ${doKasacji.length}, zostało ${items.length - doKasacji.length}`);
  for (const k of KOLEKCJE_MAGAZYNU) {
    const { deletedCount } = await db.collection(k).deleteMany({});
    console.log(`  ${k}: usunięto ${deletedCount}`);
  }
} else {
  for (const { name } of await db.listCollections().toArray()) {
    if (NIETYKALNE.has(name)) { console.log(`  ${name}: pominięte (nietykalne)`); continue; }
    const { deletedCount } = await db.collection(name).deleteMany({});
    console.log(`  ${name}: usunięto ${deletedCount}`);
  }
}

await closeDb();

// Import odpalamy dopiero po zamknięciu własnego połączenia — procesy potomne
// otwierają swoje, a dwa klienty do Atlasa naraz to niepotrzebne gniazda.
const uruchom = (skrypt, argv) => new Promise((resolve, reject) => {
  console.log(`\n→ ${skrypt} ${argv.join(' ')}`);
  const p = spawn(process.execPath, [path.join(tutaj, skrypt), ...argv], { stdio: 'inherit', env: process.env });
  p.on('exit', (kod) => (kod === 0 ? resolve() : reject(new Error(`${skrypt} zakończył się kodem ${kod}`))));
  p.on('error', reject);
});

await uruchom('odoo-import.mjs', ['--zapisz']);
await uruchom('odoo-historia.mjs', ['--zapisz', '--wyczysc']);

console.log('\nGOTOWE. Sprawdź „Raportowanie → Spójność danych" — powinno być zero rozjazdów.');
