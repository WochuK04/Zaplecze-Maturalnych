// Eksport produktów z Odoo (maturalni.odoo.com) — WYŁĄCZNIE ODCZYT.
//
// Klient ma twardą białą listę metod: cokolwiek spoza niej rzuca błąd PRZED wysłaniem
// żądania. To była wprost postawiona zasada — Odoo jest aktywnym magazynem firmy.
//
// KLUCZ API: „Materiały do gitignore/odoo-creds.json" (ten katalog jest w .gitignore).
//   { "url": "https://maturalni.odoo.com", "db": "maturalni",
//     "login": "…@maturalni.com", "apiKey": "…" }
// Klucz zakłada się w Odoo: awatar → Mój profil → Bezpieczeństwo konta → Nowy klucz API.
// Klucze bywają zakładane na 7 dni, więc przy „Uwierzytelnianie nieudane" najpierw
// sprawdź, czy nie wygasł.
//
// Użycie:  node scripts/odoo-produkty.mjs [--all]   (--all dołącza zarchiwizowane)

import fs from 'node:fs';
import path from 'node:path';

const READ_ONLY = new Set(['search_read', 'search_count', 'read', 'read_group', 'fields_get']);
const here = path.join(process.cwd(), 'Materiały do gitignore');
const { url, db, login, apiKey } = JSON.parse(fs.readFileSync(path.join(here, 'odoo-creds.json'), 'utf8'));
const base = url.replace(/\/$/, '');

async function rpc(service, method, args) {
  const r = await fetch(`${base}/jsonrpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() })
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error.data ?? j.error).slice(0, 300));
  return j.result;
}
const uid = await rpc('common', 'login', [db, login, apiKey]);
if (!uid) throw new Error('Uwierzytelnianie nieudane — sprawdź klucz i nazwę bazy.');

async function call(model, method, args, kwargs = {}) {
  if (!READ_ONLY.has(method)) throw new Error(`ZABLOKOWANE: ${method} nie jest metodą odczytu.`);
  return rpc('object', 'execute_kw', [db, uid, apiKey, model, method, args, kwargs]);
}

const wszystkie = process.argv.includes('--all');
const domena = wszystkie ? [['active', 'in', [true, false]]] : [];
const POLA = ['default_code', 'name', 'categ_id', 'uom_id', 'type', 'standard_price',
  'list_price', 'qty_available', 'active', 'barcode', 'sale_ok', 'purchase_ok',
  'responsible_id', 'description'];

const p = await call('product.template', 'search_read', [domena, POLA], { order: 'default_code asc, name asc' });
console.log(`produktów: ${p.length}${wszystkie ? ' (z zarchiwizowanymi)' : ' (tylko aktywne)'}`);

const rel = (v) => (Array.isArray(v) ? v[1] : v || '');
const wiersze = p.map((x) => ({
  kod: x.default_code || '', nazwa: x.name || '', kategoria: rel(x.categ_id),
  jednostka: rel(x.uom_id), typ: x.type || '', stan: x.qty_available ?? '',
  koszt: x.standard_price ?? '', cena_sprzedazy: x.list_price ?? '',
  kod_kreskowy: x.barcode || '', aktywny: x.active ? 'tak' : 'nie',
  odpowiedzialny: rel(x.responsible_id), opis: (x.description || '').replace(/\s+/g, ' ').trim(),
  id_odoo: x.id
}));

const kol = Object.keys(wiersze[0]);
const esc = (v) => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
fs.writeFileSync(path.join(here, 'produkty.csv'),
  '﻿' + [kol.join(','), ...wiersze.map((r) => kol.map((k) => esc(r[k])).join(','))].join('\n'));
fs.writeFileSync(path.join(here, 'produkty.json'), JSON.stringify(wiersze, null, 2));

const kat = {};
for (const r of wiersze) kat[r.kategoria] = (kat[r.kategoria] || 0) + 1;
console.log('\nwg kategorii:');
for (const [k, n] of Object.entries(kat).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
const jm = {};
for (const r of wiersze) jm[r.jednostka] = (jm[r.jednostka] || 0) + 1;
console.log('wg jednostki: ' + Object.entries(jm).map(([k, v]) => `${k}:${v}`).join('  '));
console.log(`\n→ produkty.csv (Excel) i produkty.json w ${here}`);
