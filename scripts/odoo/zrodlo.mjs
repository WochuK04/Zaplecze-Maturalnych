// Wczytanie danych z Odoo do jednej, wspólnej postaci — niezależnie od tego, czy
// przyszły przez JSON-RPC (`odoo-pobierz.mjs`), czy z ręcznego eksportu .xlsx.
//
// RPC jest źródłem lepszym i to on ma KOSZT (`standard_price`). Eksport .xlsx z
// Odoo ma tylko „Cenę sprzedaży", która w tej bazie jest placeholderem (0/1/23,9),
// więc partie z pliku wejdą z kosztem 0, dopóki nie dołożysz kolumny „Koszt".

import fs from 'node:fs';
import path from 'node:path';
import xlsxPkg from 'xlsx';
import { KATALOG_ODOO } from './rpc.mjs';

const xlsx = xlsxPkg.default || xlsxPkg;

// Excel trzyma datę jako liczbę dni od 1899-12-30. Odoo eksportuje czas w UTC.
export function zDatyExcel(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v;
  const n = Number(v);
  if (Number.isFinite(n)) return new Date(Math.round((n - 25569) * 86400 * 1000));
  const d = new Date(String(v).replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(String(v)) ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? null : d;
}

const wiersze = (plik) => {
  const wb = xlsx.readFile(plik);
  return xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
};

const ma = (r, ...kol) => kol.every((k) => k in r);

// Rozpoznanie arkusza po kolumnach — dzięki temu wystarczy podać ścieżki plików,
// bez mówienia, który jest który.
function rozpoznaj(r) {
  if (ma(r, 'Odnośnik wewnętrzny', 'Kategoria produktu')) return 'produkty';
  if (ma(r, 'Produkt', 'Od', 'Do', 'Ilość')) return 'ruchy';
  if (ma(r, 'Strefa źródłowa', 'Strefa docelowa', 'Odnośnik')) return 'przekazy';
  return null;
}

// Koszt: w eksporcie .xlsx kolumny „Koszt" domyślnie NIE ma — trzeba ją dodać
// ręcznie w widoku eksportu Odoo. Gdy jej nie ma, partie dostają 0 zł.
const KOL_KOSZT = ['Koszt', 'Cena kosztowa', 'Cena zakupu', 'standard_price'];

function kosztZWiersza(r) {
  for (const k of KOL_KOSZT) if (r[k] != null && r[k] !== '') return Number(r[k]) || 0;
  return null;
}

export function wczytajPliki(sciezki) {
  const wynik = { produkty: [], ruchy: [], przekazy: [], koszty: false, zrodlo: 'xlsx', pliki: [] };

  for (const p of sciezki) {
    const rs = wiersze(p);
    if (!rs.length) continue;
    const typ = rozpoznaj(rs[0]);
    if (!typ) throw new Error(`Nie rozpoznaję arkusza: ${path.basename(p)} (kolumny: ${Object.keys(rs[0]).join(', ')})`);
    wynik.pliki.push({ plik: path.basename(p), typ, wierszy: rs.length });

    if (typ === 'produkty') {
      for (const r of rs) {
        const koszt = kosztZWiersza(r);
        if (koszt != null) wynik.koszty = true;
        wynik.produkty.push({
          kod: r['Odnośnik wewnętrzny'],
          nazwa: r['Nazwa'],
          kategoria: r['Kategoria produktu'],
          stan: r['Ilość Na Stanie'],
          koszt: koszt ?? 0,
          cenaSprzedazy: Number(r['Cena sprzedaży']) || 0,
          jednostka: r['Jednostka'] || 'Jednostki',
          zaktualizowano: zDatyExcel(r['Data ostatniej aktualizacji'])
        });
      }
    } else if (typ === 'ruchy') {
      for (const r of rs) {
        wynik.ruchy.push({
          data: zDatyExcel(r['Data']),
          odnosnik: r['Odnośnik'],
          produkt: r['Produkt'],
          od: r['Od'],
          do: r['Do'],
          ilosc: r['Ilość'],
          status: r['Status']
        });
      }
    } else {
      for (const r of rs) {
        wynik.przekazy.push({
          odnosnik: r['Odnośnik'],
          od: r['Strefa źródłowa'],
          do: r['Strefa docelowa'],
          kontakt: r['Kontakt'],
          data: zDatyExcel(r['Zaplanowana data']),
          dokument: r['Dokument źródłowy'],
          status: r['Status']
        });
      }
    }
  }

  // Ten sam przekaz potrafi trafić w dwóch eksportach (przyjęcia i wydania osobno).
  const widziane = new Set();
  wynik.przekazy = wynik.przekazy.filter((p) => {
    const k = String(p.odnosnik || '');
    if (!k || widziane.has(k)) return false;
    widziane.add(k);
    return true;
  });

  return wynik;
}

// Dane ściągnięte przez `odoo-pobierz.mjs` (mają koszt i pełną historię).
export function wczytajRpc() {
  const czytaj = (n) => {
    const p = path.join(KATALOG_ODOO, n);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  };
  const produkty = czytaj('produkty.json');
  if (!produkty) return null;
  const ruchy = czytaj('ruchy.json') || [];
  const przekazy = czytaj('przekazy.json') || [];
  return {
    zrodlo: 'rpc',
    koszty: produkty.some((p) => Number(p.koszt) > 0),
    pliki: [{ plik: 'odoo/*.json', typ: 'rpc', wierszy: produkty.length + ruchy.length + przekazy.length }],
    produkty: produkty.map((p) => ({ ...p, zaktualizowano: p.zaktualizowano ? new Date(p.zaktualizowano) : null })),
    ruchy: ruchy.map((r) => ({ ...r, data: r.data ? new Date(r.data) : null })),
    przekazy: przekazy.map((r) => ({ ...r, data: r.data ? new Date(r.data) : null }))
  };
}

// Wybór źródła: podane ścieżki > dane z RPC. Rzuca, gdy nie ma ani jednego.
export function wczytaj(sciezki = []) {
  if (sciezki.length) return wczytajPliki(sciezki);
  const rpc = wczytajRpc();
  if (rpc) return rpc;
  throw new Error(
    'Brak danych. Podaj ścieżki do eksportów .xlsx albo najpierw uruchom:\n  node scripts/odoo-pobierz.mjs'
  );
}
