// Klient JSON-RPC do Odoo — WYŁĄCZNIE ODCZYT.
//
// Odoo (maturalni.odoo.com) jest aktywnym magazynem firmy. Biała lista metod jest
// twarda: cokolwiek spoza niej rzuca błąd PRZED wysłaniem żądania, więc żaden błąd
// w skrypcie nie jest w stanie ruszyć danych po tamtej stronie.
//
// KLUCZ API: „Materiały do gitignore/odoo-creds.json" (katalog jest w .gitignore):
//   { "url": "https://maturalni.odoo.com", "db": "maturalni",
//     "login": "…@maturalni.com", "apiKey": "…" }
// Zakładasz go w Odoo: awatar → Mój profil → Bezpieczeństwo konta → Nowy klucz API.
// Klucze bywają zakładane na 7 dni — przy „Uwierzytelnianie nieudane" najpierw
// sprawdź, czy nie wygasł.

import fs from 'node:fs';
import path from 'node:path';

const READ_ONLY = new Set(['search_read', 'search_count', 'read', 'read_group', 'fields_get']);

export const KATALOG = path.join(process.cwd(), 'Materiały do gitignore');
export const KATALOG_ODOO = path.join(KATALOG, 'odoo');
const PLIK_CREDS = path.join(KATALOG, 'odoo-creds.json');

export function credsIstnieja() {
  return fs.existsSync(PLIK_CREDS);
}

export function podpowiedzOKluczu() {
  return [
    `Brak pliku ${PLIK_CREDS}`,
    '',
    'Załóż klucz API w Odoo (awatar → Mój profil → Bezpieczeństwo konta → Nowy klucz API)',
    'i zapisz plik o treści:',
    '  {',
    '    "url": "https://maturalni.odoo.com",',
    '    "db": "maturalni",',
    '    "login": "twoj.login@maturalni.com",',
    '    "apiKey": "…"',
    '  }',
    '',
    'Katalog „Materiały do gitignore/" jest w .gitignore, więc klucz nie trafi do repo.'
  ].join('\n');
}

// Łączy się i zwraca funkcję `call(model, method, args, kwargs)` ograniczoną do odczytu.
export async function polacz() {
  if (!credsIstnieja()) throw new Error(podpowiedzOKluczu());
  const { url, db, login, apiKey } = JSON.parse(fs.readFileSync(PLIK_CREDS, 'utf8'));
  const base = String(url).replace(/\/$/, '');

  async function rpc(service, method, args) {
    const r = await fetch(`${base}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() })
    });
    const j = await r.json();
    if (j.error) throw new Error(JSON.stringify(j.error.data ?? j.error).slice(0, 300));
    return j.result;
  }

  const uid = await rpc('common', 'login', [db, login, apiKey]);
  if (!uid) throw new Error('Uwierzytelnianie nieudane — sprawdź klucz API (bywa ważny 7 dni) i nazwę bazy.');

  return async function call(model, method, args, kwargs = {}) {
    if (!READ_ONLY.has(method)) throw new Error(`ZABLOKOWANE: ${method} nie jest metodą odczytu.`);
    return rpc('object', 'execute_kw', [db, uid, apiKey, model, method, args, kwargs]);
  };
}

// Odoo tnie duże wyniki, więc czytamy stronami. `search_read` z limit/offset.
export async function czytajStronami(call, model, domena, pola, { order = 'id asc', strona = 500 } = {}) {
  const out = [];
  for (let offset = 0; ; offset += strona) {
    const partia = await call(model, 'search_read', [domena, pola], { order, limit: strona, offset });
    out.push(...partia);
    if (partia.length < strona) break;
  }
  return out;
}

// Pole relacyjne Odoo to [id, "nazwa"] — prawie zawsze chcemy nazwę.
export const rel = (v) => (Array.isArray(v) ? v[1] : v || '');

export function zapiszJson(nazwaPliku, dane) {
  fs.mkdirSync(KATALOG_ODOO, { recursive: true });
  const p = path.join(KATALOG_ODOO, nazwaPliku);
  fs.writeFileSync(p, JSON.stringify(dane, null, 2));
  return p;
}
