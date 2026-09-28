// Mapowanie „stary kod → nowy kod" dla księgowości.
//
// Zbiera w jedną tabelę obie zmiany numeracji, które przeszły przez bazę:
//   • SPRZĘT — przenumerowanie z `kody-sprzetu.mjs` (plik mapowania tego skryptu);
//   • MAGAZYN — wymiana kartotek na kody z Odoo (kopia sprzed zaorania).
//
// Dopasowanie magazynu idzie po NAZWIE, bo stare kody (`GADZ-MQS8H8S0`) nie mają
// nic wspólnego z odnośnikami Odoo. Sama nazwa bywa niejednoznaczna — „Krówki E8"
// to w Odoo pięć kartotek — więc zawężamy ją dwoma regułami:
//   1. prefiks starego kodu niesie kategorię (GADZ- → gadżet, TOWA- → Towar);
//   2. z pozostałych kandydatów wygrywa kartoteka aktywna, nie archiwum Odoo.
// Co się po tym nie rozstrzygnie, ląduje w pliku z adnotacją — do decyzji ręcznej.
//
// Użycie:
//   node scripts/mapowanie-kodow.mjs <katalog-kopii> [plik-mapowania-sprzetu.json]

import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectToDatabase, closeDb } from '../src/db.js';
import { collections } from '../src/schema.js';
import { isWarehouseCategory } from '../src/lib/categories.js';
import { normalizeName } from '../src/odoo.js';

const tutaj = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(tutaj, '../.env') });

const [katalogKopii, plikSprzetu] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!katalogKopii) {
  console.error('Podaj katalog z kopią magazynu sprzed zaorania, np.:');
  console.error('  node scripts/mapowanie-kodow.mjs "Materiały do gitignore/atlas-kopia-magazyn-…"');
  process.exit(1);
}

// Prefiks starego kodu → kategoria. Tak numerował produkty poprzedni schemat.
const KATEGORIA_Z_PREFIKSU = [
  [/^GADZ-/i, 'gadżet'], [/^TOWA-/i, 'towar'],
  [/^OPAK-/i, 'opakowanie'], [/^SPON-/i, 'sponsor']
];

const kategoriaStarego = (kod) => {
  for (const [re, kat] of KATEGORIA_Z_PREFIKSU) if (re.test(kod)) return kat;
  return null;
};

// Kody zmienione RĘCZNIE w trakcie tej samej migracji, zanim ruszył skrypt
// numeracji. Bez tego księgowość zobaczyłaby ogniwo pośrednie zamiast punktu
// wyjścia: statyw zszedł z `T003` (oddanego magazynowi) na `STA-03`, a dopiero
// potem skrypt nadał mu `STA001`.
const PRZED_SKRYPTEM = { 'STA-03': 'T003' };

const db = await connectToDatabase();
const teraz = await db.collection(collections.items)
  .find({}, { projection: { itemCode: 1, name: 1, category: 1, quantity: 1, unit: 1, isActive: 1 } })
  .toArray();
const magTeraz = teraz.filter((i) => isWarehouseCategory(i.category));

const wgNazwy = new Map();
for (const i of magTeraz) {
  const k = normalizeName(i.name);
  if (!wgNazwy.has(k)) wgNazwy.set(k, []);
  wgNazwy.get(k).push(i);
}

const wiersze = [];

// --- sprzęt ---------------------------------------------------------------------
const sciezkaSprzetu = plikSprzetu
  || fs.readdirSync(path.join(process.cwd(), 'Materiały do gitignore'))
    .filter((f) => /^mapowanie-kodow-sprzetu-.*\.json$/.test(f)).sort().pop();
if (sciezkaSprzetu) {
  const pelna = path.isAbsolute(sciezkaSprzetu) ? sciezkaSprzetu
    : path.join(process.cwd(), 'Materiały do gitignore', path.basename(sciezkaSprzetu));
  for (const m of JSON.parse(fs.readFileSync(pelna, 'utf8'))) {
    wiersze.push({
      obszar: 'Sprzęt', staryKod: PRZED_SKRYPTEM[m.staryKod] || m.staryKod, nowyKod: m.nowyKod,
      kategoria: m.kategoria, nazwa: m.nazwa, ilosc: m.ilosc, jednostka: 'szt.', uwaga: m.powod
    });
  }
}

// --- magazyn --------------------------------------------------------------------
const kopia = JSON.parse(fs.readFileSync(path.join(katalogKopii, 'items.json'), 'utf8'));
for (const s of kopia) {
  let kandydaci = wgNazwy.get(normalizeName(s.name)) || [];

  const kat = kategoriaStarego(s.itemCode) || normalizeName(s.category);
  const wgKategorii = kandydaci.filter((k) => normalizeName(k.category) === kat);
  if (wgKategorii.length) kandydaci = wgKategorii;

  const aktywne = kandydaci.filter((k) => k.isActive !== false);
  if (aktywne.length) kandydaci = aktywne;

  const trafiony = kandydaci.length === 1 ? kandydaci[0] : null;
  wiersze.push({
    obszar: 'Magazyn',
    staryKod: s.itemCode,
    nowyKod: trafiony ? trafiony.itemCode : (kandydaci.length ? kandydaci.map((k) => k.itemCode).join(' / ') : '(brak odpowiednika)'),
    kategoria: trafiony ? trafiony.category : s.category,
    nazwa: s.name,
    ilosc: trafiony ? trafiony.quantity : (s.quantity ?? 0),
    jednostka: trafiony ? (trafiony.unit || 'szt.') : 'szt.',
    uwaga: trafiony ? 'kod z Odoo'
      : kandydaci.length ? 'kilka kartotek o tej nazwie — do rozstrzygnięcia'
        : 'nie ma odpowiednika w Odoo'
  });
}

const nag = ['obszar', 'staryKod', 'nowyKod', 'kategoria', 'nazwa', 'ilosc', 'jednostka', 'uwaga'];
const esc = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const stempel = new Date().toISOString().slice(0, 10);
const plik = path.join(process.cwd(), 'Materiały do gitignore', `mapowanie-kodow-${stempel}.csv`);
fs.writeFileSync(plik, '﻿' + [nag.join(';'), ...wiersze.map((r) => nag.map((k) => esc(r[k])).join(';'))].join('\n'));
fs.writeFileSync(plik.replace('.csv', '.json'), JSON.stringify(wiersze, null, 2));

const doRozstrzygniecia = wiersze.filter((r) => /rozstrzygnięcia|brak odpowiednika/.test(r.uwaga));
console.log(JSON.stringify({
  wierszy: wiersze.length,
  sprzet: wiersze.filter((r) => r.obszar === 'Sprzęt').length,
  magazyn: wiersze.filter((r) => r.obszar === 'Magazyn').length,
  doRecznegoRozstrzygniecia: doRozstrzygniecia.length,
  plik
}, null, 2));
for (const r of doRozstrzygniecia) console.error(`  ${r.staryKod} „${r.nazwa}" → ${r.nowyKod}  (${r.uwaga})`);

await closeDb();
