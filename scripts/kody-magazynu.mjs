// Przenumerowanie kartotek MAGAZYNU na schemat kodów aplikacji + mapa dla księgowości.
//
// Schemat mieszka w `src/lib/item-code.js`: PREFIKS-SUFIKS, gdzie prefiks to cztery
// pierwsze litery kategorii bez diakrytyków („gadżet" → `GADZ-MQTBGLJ5`). Tego samego
// używa aplikacja przy zakładaniu kartoteki, więc po tej operacji cała kolekcja mówi
// jednym schematem zamiast dwoma.
//
// CO Z PARYTETEM ODOO. Magazyn stał dotąd na kodach z Odoo (`G039`) i import dopasowywał
// kartoteki właśnie po nich. Przenumerowanie zrywałoby to dopasowanie, więc zanim tu
// cokolwiek ruszymy, `odoo-import.mjs` szuka kartoteki po `itemCode` ALBO `odooCode`
// (patrz dopasujKartoteke w src/odoo.js). Ten skrypt zapisuje stary kod w `odooCode`,
// więc łącznik z Odoo zostaje nienaruszony, a import nie cofa przenumerowania.
//
// Zmiana idzie przez `cascadeItemCodeRename`, więc ruchy, stany, dokumenty,
// wypożyczenia, reguły zapotrzebowania i listy pakowania Wyjazdów jadą razem
// z kartoteką. `qrCodeValue` aktualizujemy tylko wtedy, gdy trzymał stary kod.
//
// Użycie:
//   node scripts/kody-magazynu.mjs                 # PRÓBA NA SUCHO + plik mapowania
//   node scripts/kody-magazynu.mjs --zapisz        # dopiero to zmienia bazę
//   node scripts/kody-magazynu.mjs --przywroc=<plik-mapowania.json>
//
// Cel bazy z .env (patrz src/db.js). NA PRODUKCJI uruchamiaj z MONGODB_URI Atlasu.

import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectToDatabase, closeDb } from '../src/db.js';
import { collections } from '../src/schema.js';
import { cascadeItemCodeRename } from '../src/stock.js';
import { isWarehouseCategory } from '../src/lib/categories.js';
import { buildItemCode, matchesScheme, normalizeItemCode } from '../src/lib/item-code.js';
import { BEZ_ODNOSNIKA, kodZNazwy } from '../src/odoo-poprawki.js';
import { normalizeName } from '../src/odoo.js';

const tutaj = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(tutaj, '../.env') });

const args = process.argv.slice(2);
const ZAPISZ = args.includes('--zapisz');
const PRZYWROC = (args.find((a) => a.startsWith('--przywroc=')) || '').split('=')[1] || null;

const KATALOG = 'Materiały do gitignore';
const stempel = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);

const csvPole = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csv = (wiersze) => wiersze.map((r) => r.map(csvPole).join(';')).join('\n');

async function main() {
  const db = await connectToDatabase();
  const items = db.collection(collections.items);

  // Wszystkie kody w bazie — także sprzętu. Nowy kod musi być unikalny GLOBALNIE,
  // bo magazyn i sprzęt dzielą jedną kolekcję i jeden unikalny indeks na `itemCode`.
  const wszystkie = await items.find({}, { projection: { itemCode: 1, category: 1, name: 1, unit: 1, quantity: 1, qrCodeValue: 1, odooCode: 1, mergedCodes: 1, isActive: 1 } }).toArray();
  const zajete = new Set(wszystkie.map((d) => d.itemCode));

  if (PRZYWROC) return przywroc(db, items, zajete);

  const magazyn = wszystkie.filter((d) => isWarehouseCategory(d.category));
  const doZmiany = magazyn.filter((d) => !matchesScheme(d.itemCode, d.category));

  const plan = [];
  doZmiany.forEach((d, i) => {
    // `rozroznik` rozsuwa kody generowane w tej samej milisekundzie — bez niego cała
    // partia dostałaby identyczny sufiks i wywaliłaby się na unikalnym indeksie.
    let nowy = buildItemCode(d.category, String(i).padStart(3, '0'));
    for (let n = 1; zajete.has(nowy); n += 1) nowy = buildItemCode(d.category, `${i}X${n}`);
    zajete.add(nowy);
    plan.push({
      staryKod: d.itemCode,
      nowyKod: nowy,
      kategoria: d.category || '',
      nazwa: d.name || '',
      ilosc: d.quantity ?? 0,
      jednostka: d.unit || 'szt.',
      // Stary kod zostaje łącznikiem z Odoo. Jeśli kartoteka miała już `odooCode`
      // (kolizja rozwiązana przy imporcie), nie nadpisujemy go.
      odooCode: d.odooCode || d.itemCode,
      qrDoZmiany: d.qrCodeValue === d.itemCode
    });
  });

  const bezZmian = magazyn.length - plan.length;
  const raport = {
    baza: db.databaseName,
    naSucho: !ZAPISZ,
    kartotekMagazynu: magazyn.length,
    doPrzenumerowania: plan.length,
    juzWSchemacie: bezZmian,
    kodowQrDoAktualizacji: plan.filter((p) => p.qrDoZmiany).length,
    wgKategorii: plan.reduce((acc, p) => { acc[p.kategoria] = (acc[p.kategoria] || 0) + 1; return acc; }, {})
  };

  // === MAPA DLA KSIĘGOWOŚCI ===
  //
  // Idzie od strony ODOO, nie od naszych kartotek. To istotna różnica: lista naszych
  // kartotek nie powie, co się stało z kodem, który przy imporcie został WCHŁONIĘTY
  // w inny (G033 → G002). Taki kod nie jest już kartoteką, więc nie ma własnego
  // wiersza — a księgowa ma go u siebie w ewidencji i musi wiedzieć, gdzie wylądował.
  //
  // Dlatego wierszem jest każdy kod z Odoo, a kolumna `status` mówi, czym się stał:
  //   kartoteka  – ma u nas własną kartotekę (dostaje nowy kod),
  //   scalona    – wchłonięta w inną kartotekę; jej towar żyje jako osobna PARTIA
  //                cenowa pod kodem docelowym (aplikacja rozróżnia partie),
  //   brak u nas – nie zaimportowana (śmieci z Odoo albo pozycja modułu Sprzęt).
  // Na końcu dochodzą kartoteki, których Odoo nie zna, bo kod nadaliśmy sami.
  const plikOdoo = path.join(KATALOG, 'odoo', 'produkty.json');
  const odoo = fs.existsSync(plikOdoo) ? JSON.parse(fs.readFileSync(plikOdoo, 'utf8')) : [];

  const nowyWg = new Map(plan.map((p) => [p.staryKod, p.nowyKod]));
  const kartotekaWg = new Map(wszystkie.map((d) => [d.itemCode, d]));
  const wchloniete = new Map();            // kod wchłonięty → kartoteka, która go wchłonęła
  for (const d of wszystkie) for (const m of d.mergedCodes || []) wchloniete.set(m, d);

  const kodPo = (kod) => nowyWg.get(kod) || kod;   // bez zmiany, gdy już w schemacie
  const pominieteArchiwalne = [];   // archiwalne śmieci z Odoo, poza zestawieniem
  const rozwiazaneZNazwy = new Set(); // kody nadane po naszej stronie, już opisane wyżej

  // Jeden odnośnik potrafi w Odoo siedzieć na dwóch kartotekach. Prawie zawsze dlatego,
  // że kod ZWOLNIŁ SIĘ po archiwizacji i został nadany ponownie — to normalne działanie
  // Odoo, nie błąd do zgłoszenia. W aktywnym widoku Odoo taki kod jest jeden.
  // Rozróżniamy więc dwa przypadki: ponowne użycie (jedna aktywna + archiwalne)
  // od realnego konfliktu (dwie AKTYWNE kartoteki pod tym samym kodem).
  const wgKodu = new Map();
  for (const r of odoo) {
    const k = String(r.kod || '').trim();
    if (!k) continue;
    if (!wgKodu.has(k)) wgKodu.set(k, []);
    wgKodu.get(k).push(r);
  }
  const ileRazy = new Map([...wgKodu].map(([k, v]) => [k, v.length]));
  const ileAktywnych = new Map([...wgKodu].map(([k, v]) => [k, v.filter((x) => x.aktywny !== false).length]));
  const aktywnaNazwa = new Map([...wgKodu].map(([k, v]) => [k, (v.find((x) => x.aktywny !== false) || {}).nazwa || '']));
  const rownaNazwa = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const naglowek = ['kodOdoo', 'nazwaWOdoo', 'kategoria', 'stanWOdoo', 'aktywnaWOdoo',
    'status', 'kodUNasPrzed', 'kodUNasPo', 'kartotekaDocelowa', 'nazwaUNas', 'uwaga'];
  const wiersze = [];

  for (const r of odoo) {
    const kod = String(r.kod || '').trim();
    const wspolne = [kod || '(brak kodu)', r.nazwa || '', r.kategoria || '', r.stan ?? '',
      r.aktywny === false ? 'nie' : 'tak'];
    if (!kod) {
      // Kartoteka bez `default_code`. NAJPIERW próbujemy ją rozwiązać po NAZWIE — tak
      // samo jak import (src/odoo-poprawki.js) — bo część takich kartotek ma u nas
      // kod nadany z naszej strony. Dopiero to, czego nie da się rozwiązać ORAZ jest
      // w Odoo archiwalne i puste, pomijamy jako śmieć („test", „1", „2", „3").
      const nadany = kodZNazwy(r.nazwa);
      if (!nadany && r.aktywny === false && !(r.stan > 0)) {
        pominieteArchiwalne.push(r.nazwa || '(bez nazwy)');
        continue;
      }
      const doSprzetu = BEZ_ODNOSNIKA.some((b) => b.doSprzetu && normalizeName(b.nazwa) === normalizeName(r.nazwa));
      if (nadany && kartotekaWg.has(nadany)) {
        const k = kartotekaWg.get(nadany);
        wiersze.push([...wspolne, 'kartoteka', nadany, kodPo(nadany), kodPo(nadany), k.name || '',
          `kod ${nadany} nadaliśmy po naszej stronie — w Odoo ta kartoteka nie ma odnośnika wewnętrznego`]);
        rozwiazaneZNazwy.add(nadany);
        continue;
      }
      if (doSprzetu) {
        wiersze.push([...wspolne, 'brak u nas', '', '', '', '', 'należy do modułu Sprzęt — import magazynu świadomie jej nie prowadzi']);
        continue;
      }
      wiersze.push([...wspolne, 'brak u nas', '', '', '', '', 'kartoteka bez odnośnika w Odoo — nie da się jej zidentyfikować przy imporcie']);
      continue;
    }
    const wlasna = kartotekaWg.get(kod);

    // Kod użyty PONOWNIE po archiwizacji: pod jednym odnośnikiem siedzą w Odoo dwie
    // różne kartoteki. Znaleziona po kodzie kartoteka reprezentuje tylko tę o zgodnej
    // nazwie — poprzedni właściciel kodu NIE został u nas zaimportowany i nie wolno mu
    // przypisywać cudzego przejścia, bo wiersz twierdziłby, że „Krówki matura" stały
    // się kartoteką, która naprawdę nazywa się „Planer 8 mies mat".
    if (wlasna && (ileRazy.get(kod) || 0) > 1 && !rownaNazwa(r.nazwa, wlasna.name)) {
      // Nie mamy TEJ kartoteki, ale sam towar zwykle prowadzimy pod innymi kodami —
      // „Krówki matura" to u nas G006, G007 i G065. Napisanie samego „nie jest
      // prowadzona" sugerowałoby, że produkt zniknął, co jest nieprawdą.
      const rodzenstwo = magazyn
        .filter((d) => rownaNazwa(d.name, r.nazwa))
        .map((d) => `${d.itemCode} → ${kodPo(d.itemCode)}`);
      wiersze.push([...wspolne, 'brak u nas', '', '', '', '',
        `kod ${kod} nosi dziś „${wlasna.name || ''}", więc ta archiwalna kartoteka nie ma u nas własnego odpowiednika` +
        (rodzenstwo.length
          ? `; ten sam towar prowadzimy pod: ${rodzenstwo.join(', ')}`
          : '; nie znaleziono u nas kartoteki o tej nazwie')]);
      continue;
    }

    if (wlasna) {
      const uwagi = [];
      // Nieaktywna NIE znaczy „pozostałość po scaleniu" — to kartoteka zarchiwizowana
      // w Odoo, którą `odoo-historia.mjs` odtworzył, bo odwołują się do niej ruchy
      // z przeszłości. Stan ma zerowy, ale historia na niej wisi i musi się rozwiązywać.
      if (wlasna.isActive === false) {
        uwagi.push('zarchiwizowana w Odoo — u nas istnieje wyłącznie po to, żeby rozwiązywały się historyczne ruchy (stan 0, nie do obrotu)');
      }
      if ((ileRazy.get(kod) || 0) > 1) {
        const konflikt = (ileAktywnych.get(kod) || 0) > 1;
        if (konflikt) {
          uwagi.push(rownaNazwa(r.nazwa, wlasna.name)
            ? `KONFLIKT: ${ileRazy.get(kod)} AKTYWNE kartoteki Odoo pod tym kodem — u nas reprezentuje JĄ; do rozstrzygnięcia w Odoo`
            : `KONFLIKT: ${ileRazy.get(kod)} AKTYWNE kartoteki Odoo pod tym kodem — ta NIE została zaimportowana; pod ${kod} jest u nas „${wlasna.name || ''}"`);
        } else if (r.aktywny === false) {
          uwagi.push(`kod zwolniony po archiwizacji i nadany ponownie — aktywna kartoteka pod ${kod} to „${aktywnaNazwa.get(kod) || ''}"; ta pozycja jest archiwalna`);
        } else {
          uwagi.push(`ten kod nosiły wcześniej kartoteki zarchiwizowane (${ileRazy.get(kod) - 1}); aktywna jest ta`);
        }
      }
      wiersze.push([...wspolne, 'kartoteka', kod, kodPo(kod), kodPo(kod), wlasna.name || '', uwagi.join('; ')]);
      continue;
    }
    const cel = wchloniete.get(kod);
    if (cel) {
      wiersze.push([...wspolne, 'scalona', kod, '', kodPo(cel.itemCode), cel.name || '',
        `towar z tego kodu jest osobną partią cenową pod ${kodPo(cel.itemCode)}`]);
      continue;
    }
    wiersze.push([...wspolne, 'brak u nas', '', '', '', '', 'nie zaimportowana (śmieci albo moduł Sprzęt)']);
  }

  // Nasze kartoteki, których Odoo nie zna — kod nadaliśmy sami (np. taśmy bez odnośnika).
  const znaneOdoo = new Set(odoo.map((r) => String(r.kod || '').trim()).filter(Boolean));
  for (const d of magazyn) {
    if (znaneOdoo.has(d.itemCode) || wchloniete.has(d.itemCode) || rozwiazaneZNazwy.has(d.itemCode)) continue;
    wiersze.push(['(brak w Odoo)', '', d.category || '', '', '', 'tylko u nas',
      d.itemCode, kodPo(d.itemCode), kodPo(d.itemCode), d.name || '', 'kod nadany po naszej stronie']);
  }

  const plikCsv = path.join(KATALOG, `mapa-kodow-odoo-${stempel}.csv`);
  const plikJson = path.join(KATALOG, `mapowanie-kodow-magazyn-${stempel}.json`);
  fs.mkdirSync(KATALOG, { recursive: true });
  fs.writeFileSync(plikCsv, '﻿' + csv([naglowek, ...wiersze]), 'utf8');
  fs.writeFileSync(plikJson, JSON.stringify(plan, null, 1), 'utf8');
  raport.mapaDlaKsiegowej = plikCsv;
  raport.mapowanieJson = plikJson;
  raport.wierszyWMapie = wiersze.length;
  raport.pominieteArchiwalneBezKodu = pominieteArchiwalne.length;
  raport.pominieteNazwy = pominieteArchiwalne;
  raport.wgStatusu = wiersze.reduce((acc, w) => { acc[w[5]] = (acc[w[5]] || 0) + 1; return acc; }, {});

  if (!ZAPISZ) {
    console.log(JSON.stringify(raport, null, 2));
    console.error('\nPRÓBA NA SUCHO — nic nie zapisano. Mapowanie leży w pliku powyżej.');
    console.error('Po akceptacji uruchom ponownie z --zapisz.');
    await closeDb();
    return;
  }

  for (const p of plan) {
    await cascadeItemCodeRename(db, p.staryKod, p.nowyKod);
    const set = { itemCode: p.nowyKod, odooCode: p.odooCode, updatedAt: new Date() };
    if (p.qrDoZmiany) set.qrCodeValue = p.nowyKod;
    await items.updateOne({ itemCode: p.staryKod }, { $set: set });
  }

  raport.przenumerowano = plan.length;
  console.log(JSON.stringify(raport, null, 2));
  console.error(`\nZAPISANO. Plik do cofnięcia: ${plikJson}`);
  console.error(`Cofnięcie:  node scripts/kody-magazynu.mjs --przywroc=${plikJson} --zapisz`);
  await closeDb();
}

// Cofnięcie: czyta plik mapowania i wraca kod po kodzie. Bez `--zapisz` tylko pokazuje.
async function przywroc(db, items, zajete) {
  const plan = JSON.parse(fs.readFileSync(PRZYWROC, 'utf8'));
  const kolizje = plan.filter((p) => zajete.has(p.staryKod));
  const raport = { baza: db.databaseName, naSucho: !ZAPISZ, doCofniecia: plan.length, kolizje: kolizje.map((k) => k.staryKod) };

  if (kolizje.length) {
    console.error(JSON.stringify(raport, null, 2));
    console.error('\nPRZERWANO: stare kody są już zajęte — ktoś je w międzyczasie nadał.');
    process.exitCode = 1;
    await closeDb();
    return;
  }
  if (!ZAPISZ) {
    console.log(JSON.stringify(raport, null, 2));
    console.error('\nPRÓBA NA SUCHO — nic nie zapisano.');
    await closeDb();
    return;
  }
  for (const p of plan) {
    await cascadeItemCodeRename(db, p.nowyKod, p.staryKod);
    const set = { itemCode: p.staryKod, updatedAt: new Date() };
    if (p.qrDoZmiany) set.qrCodeValue = p.staryKod;
    await items.updateOne({ itemCode: normalizeItemCode(p.nowyKod) }, { $set: set });
  }
  raport.cofnieto = plan.length;
  console.log(JSON.stringify(raport, null, 2));
  await closeDb();
}

main().catch(async (e) => {
  console.error('BŁĄD:', e?.message || e);
  process.exitCode = 1;
  await closeDb();
});
