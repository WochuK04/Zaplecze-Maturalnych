// Pobranie z Odoo: produkty (z KOSZTEM), linie ruchu i przekazy — WYŁĄCZNIE ODCZYT.
//
// To jest źródło lepsze niż ręczny eksport .xlsx, bo ma `standard_price` (koszt
// partii), którego w eksporcie nie ma, i bo nie trzeba niczego klikać.
// Wynik ląduje w „Materiały do gitignore/odoo/*.json" (katalog jest w .gitignore).
//
// Użycie:
//   node scripts/odoo-pobierz.mjs              # aktywne kartoteki
//   node scripts/odoo-pobierz.mjs --all        # z zarchiwizowanymi (potrzebne do historii!)
//   node scripts/odoo-pobierz.mjs --od 2025-01-01
//
// Potem:  node scripts/odoo-import.mjs --dry   i   node scripts/odoo-historia.mjs --dry

import { polacz, czytajStronami, rel, zapiszJson, credsIstnieja, podpowiedzOKluczu } from './odoo/rpc.mjs';

if (!credsIstnieja()) {
  console.error(podpowiedzOKluczu());
  process.exit(1);
}

const args = process.argv.slice(2);
const wszystkie = args.includes('--all');
const od = (args.find((a) => a.startsWith('--od=')) || '').slice(5)
  || (args[args.indexOf('--od') + 1] && !args[args.indexOf('--od') + 1].startsWith('--') ? args[args.indexOf('--od') + 1] : '');

const call = await polacz();

// Odoo 17 nazywa ilość na linii ruchu `quantity`, starsze `qty_done`. Sprawdzamy,
// zamiast zgadywać — `fields_get` jest na białej liście odczytu.
const poleIlosci = async () => {
  const f = await call('stock.move.line', 'fields_get', [[], ['type']]);
  if ('quantity' in f) return 'quantity';
  if ('qty_done' in f) return 'qty_done';
  throw new Error('stock.move.line nie ma ani `quantity`, ani `qty_done` — sprawdź wersję Odoo.');
};

// --- produkty -----------------------------------------------------------------
const domenaProd = wszystkie ? [['active', 'in', [true, false]]] : [];
const surowe = await czytajStronami(call, 'product.template', domenaProd, [
  'default_code', 'name', 'categ_id', 'uom_id', 'standard_price', 'list_price',
  'qty_available', 'active', 'barcode', 'write_date'
], { order: 'default_code asc, name asc' });

const produkty = surowe.map((x) => ({
  idOdoo: x.id,
  kod: x.default_code || '',
  nazwa: x.name || '',
  kategoria: rel(x.categ_id),
  jednostka: rel(x.uom_id),
  stan: x.qty_available ?? 0,
  koszt: x.standard_price ?? 0,
  cenaSprzedazy: x.list_price ?? 0,
  kodKreskowy: x.barcode || '',
  aktywny: !!x.active,
  zaktualizowano: x.write_date ? new Date(x.write_date.replace(' ', 'T') + 'Z').toISOString() : null
}));

// --- linie ruchu --------------------------------------------------------------
const pole = await poleIlosci();
const domenaRuch = [['state', '=', 'done']];
if (od) domenaRuch.push(['date', '>=', `${od} 00:00:00`]);

const surRuchy = await czytajStronami(call, 'stock.move.line', domenaRuch, [
  'date', 'reference', 'product_id', 'location_id', 'location_dest_id', pole,
  'product_uom_id', 'state', 'picking_id', 'lot_id'
], { order: 'date asc, id asc' });

const ruchy = surRuchy.map((x) => ({
  idOdoo: x.id,
  data: x.date ? new Date(x.date.replace(' ', 'T') + 'Z').toISOString() : null,
  odnosnik: x.reference || '',
  produkt: rel(x.product_id),
  od: rel(x.location_id),
  do: rel(x.location_dest_id),
  ilosc: x[pole] ?? 0,
  jednostka: rel(x.product_uom_id),
  status: x.state === 'done' ? 'Wykonano' : x.state,
  przekaz: rel(x.picking_id),
  lot: rel(x.lot_id)
}));

// --- przekazy -----------------------------------------------------------------
const domenaPrzek = od ? [['scheduled_date', '>=', `${od} 00:00:00`]] : [];
const surPrzek = await czytajStronami(call, 'stock.picking', domenaPrzek, [
  'name', 'location_id', 'location_dest_id', 'partner_id', 'scheduled_date',
  'date_done', 'origin', 'state', 'picking_type_id'
], { order: 'scheduled_date asc, id asc' });

const przekazy = surPrzek.map((x) => ({
  idOdoo: x.id,
  odnosnik: x.name || '',
  od: rel(x.location_id),
  do: rel(x.location_dest_id),
  kontakt: rel(x.partner_id),
  data: (x.date_done || x.scheduled_date)
    ? new Date(String(x.date_done || x.scheduled_date).replace(' ', 'T') + 'Z').toISOString() : null,
  dokument: x.origin || '',
  typ: rel(x.picking_type_id),
  status: x.state === 'done' ? 'Wykonano' : x.state
}));

zapiszJson('produkty.json', produkty);
zapiszJson('ruchy.json', ruchy);
zapiszJson('przekazy.json', przekazy);

const zKosztem = produkty.filter((p) => Number(p.koszt) > 0).length;
console.log(JSON.stringify({
  produktow: produkty.length,
  produktowZKosztem: zKosztem,
  liniiRuchu: ruchy.length,
  przekazow: przekazy.length,
  zarchiwizowaneWliczone: wszystkie,
  odDaty: od || '(od początku)',
  poleIlosci: pole,
  katalog: 'Materiały do gitignore/odoo/'
}, null, 2));

if (!zKosztem) {
  console.warn('\nUWAGA: żaden produkt nie ma kosztu (standard_price > 0) — partie wejdą po 0 zł.');
}
if (!wszystkie) {
  console.warn('\nWSKAZÓWKA: historia dotyka kartotek zarchiwizowanych (np. G014, T004).');
  console.warn('Do pełnej historii przetworzeń uruchom: node scripts/odoo-pobierz.mjs --all');
}
