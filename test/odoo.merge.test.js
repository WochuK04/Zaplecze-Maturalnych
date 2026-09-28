import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProductRef, productCore, compareCodes, pickCanonical,
  mergeProducts, findConversionCandidates, mapLocation, classifyMove,
  normalizeMoveLine, detectConversions, tylkoAktywne, findDuplicateCodes
} from '../src/odoo.js';

const d = (s) => new Date(s);

test('parseProductRef wyłuskuje kod z formatu Odoo', () => {
  assert.deepEqual(parseProductRef('[G039] Arkusz polski e8'), { kod: 'G039', nazwa: 'Arkusz polski e8' });
  assert.deepEqual(parseProductRef('Krówki matura'), { kod: null, nazwa: 'Krówki matura' });
  assert.equal(parseProductRef('  [t003]  Egzaminatorium  ').kod, 'T003');
});

test('productCore zdejmuje dopiski rozróżniające kartotekę', () => {
  assert.equal(productCore('Kubek E8 towar'), productCore('Kubek E8'));
  assert.equal(productCore('Skarpety E8 Granat/róż gadżet'), productCore('Skarpety E8 Granat róż towar'));
  assert.notEqual(productCore('Kubek E8'), productCore('Kubek matura'));
});

test('compareCodes porządkuje po numerze, nie po tekście', () => {
  assert.deepEqual(['G46', 'G9', 'G39'].sort(compareCodes), ['G9', 'G39', 'G46']);
  assert.ok(compareCodes('G001', 'T001') < 0);
});

test('pickCanonical bierze kartotekę z największym stanem', () => {
  const g = [{ kod: 'G046', stan: 199 }, { kod: 'G039', stan: 279 }];
  assert.equal(pickCanonical(g).kod, 'G039');
});

test('pickCanonical przy remisie bierze najstarszy kod', () => {
  const g = [{ kod: 'G046', stan: 0 }, { kod: 'G039', stan: 0 }, { kod: 'G048', stan: 0 }];
  assert.equal(pickCanonical(g).kod, 'G039');
});

test('mergeProducts scala tę samą nazwę w tej samej kategorii i zachowuje koszt partii', () => {
  const out = mergeProducts([
    { kod: 'G039', nazwa: 'Arkusz polski e8', kategoria: 'gadżet', stan: 279, koszt: 1.25 },
    { kod: 'G046', nazwa: 'Arkusz polski e8', kategoria: 'gadżet', stan: 199, koszt: 1.4 }
  ]);
  assert.equal(out.length, 1);
  const p = out[0];
  assert.equal(p.itemCode, 'G039');
  assert.deepEqual(p.mergedCodes, ['G046']);
  assert.equal(p.quantity, 478);
  assert.deepEqual(p.priceBatches.map((b) => [b.qty, b.unitPrice, b.note]), [
    [279, 1.25, 'Odoo G039'],
    [199, 1.4, 'Odoo G046']
  ]);
});

test('mergeProducts NIE scala towaru z gadżetem, mimo tej samej nazwy', () => {
  const out = mergeProducts([
    { kod: 'T003', nazwa: 'Egzaminatorium matematyka wydanie I', kategoria: 'Towar', stan: 277, koszt: 8 },
    { kod: 'G060', nazwa: 'Egzaminatorium matematyka wydanie I', kategoria: 'gadżet', stan: 20, koszt: 8 }
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((p) => p.itemCode).sort(), ['G060', 'T003']);
  assert.ok(out.every((p) => p.mergedCodes.length === 0));
});

test('mergeProducts zachowuje kod pustej kartoteki w mergedCodes, ale bez partii', () => {
  const out = mergeProducts([
    { kod: 'G009', nazwa: 'Kubek E8', kategoria: 'gadżet', stan: 109, koszt: 3 },
    { kod: 'G008', nazwa: 'Kubek E8', kategoria: 'gadżet', stan: 0, koszt: 5 }
  ]);
  assert.equal(out[0].itemCode, 'G009');
  assert.deepEqual(out[0].mergedCodes, ['G008']);
  assert.equal(out[0].quantity, 109);
  assert.equal(out[0].priceBatches.length, 1);
});

test('mergeProducts pomija wiersze bez kodu, nazwy lub kategorii', () => {
  const out = mergeProducts([
    { kod: '', nazwa: 'Bez kodu', kategoria: 'gadżet', stan: 5 },
    { kod: 'G001', nazwa: '', kategoria: 'gadżet', stan: 5 },
    { kod: 'G002', nazwa: 'Ok', kategoria: '', stan: 5 }
  ]);
  assert.equal(out.length, 0);
});

test('findConversionCandidates pokazuje pary towar↔gadżet, a nie partie', () => {
  const k = [
    { kod: 'G039', nazwa: 'Arkusz polski e8', kategoria: 'gadżet', stan: 279 },
    { kod: 'G046', nazwa: 'Arkusz polski e8', kategoria: 'gadżet', stan: 199 },
    { kod: 'T003', nazwa: 'Egzaminatorium', kategoria: 'Towar', stan: 277 },
    { kod: 'G060', nazwa: 'Egzaminatorium', kategoria: 'gadżet', stan: 20 }
  ];
  const c = findConversionCandidates(k);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].kartoteki.map((x) => x.kod), ['G060', 'T003']);
});

test('mapLocation sprowadza oba magazyny Odoo do jednego „Magazynu”', () => {
  assert.equal(mapLocation('mag/Strefa składowania'), 'WH/Stock');
  assert.equal(mapLocation('WH/Stock'), 'WH/Stock');
  assert.equal(mapLocation('Vendors'), 'VIRT/Suppliers');
  assert.equal(mapLocation('Customers'), 'VIRT/Customers');
  assert.equal(mapLocation('Inventory adjustment'), 'VIRT/Inventory');
  assert.equal(mapLocation('Coś nowego'), null);
});

test('classifyMove nadaje rodzaj ruchu zgodny z magazynem', () => {
  assert.equal(classifyMove('VIRT/Suppliers', 'WH/Stock'), 'receipt');
  assert.equal(classifyMove('WH/Stock', 'VIRT/Customers'), 'delivery');
  assert.equal(classifyMove('VIRT/Inventory', 'WH/Stock'), 'adjustment');
  assert.equal(classifyMove('WH/Stock', 'WH/Studio'), 'internal');
});

const linia = (o) => normalizeMoveLine({
  produkt: o.produkt, data: o.data, ilosc: o.ilosc,
  od: o.od, do: o.do, odnosnik: o.odnosnik ?? '', status: 'Wykonano'
});

test('detectConversions paruje zdjęcie z towaru z dopisaniem na gadżecie', () => {
  const { conversions, pozostaleKorekty } = detectConversions([
    linia({ produkt: '[T003] Egzaminatorium matematyka wydanie I', data: d('2026-09-26T18:11:00Z'), ilosc: 20, od: 'mag/Strefa składowania', do: 'Inventory adjustment' }),
    linia({ produkt: '[G060] Egzaminatorium matematyka wydanie I', data: d('2026-09-26T18:10:00Z'), ilosc: 20, od: 'Inventory adjustment', do: 'mag/Strefa składowania' })
  ]);
  assert.equal(conversions.length, 1);
  assert.equal(pozostaleKorekty.length, 0);
  assert.deepEqual(
    { s: conversions[0].sourceCode, t: conversions[0].targetCode, q: conversions[0].qty },
    { s: 'T003', t: 'G060', q: 20 }
  );
});

test('detectConversions paruje też kierunek gadżet→towar', () => {
  const { conversions } = detectConversions([
    linia({ produkt: '[G014] Maturatorium epoki wydanie I', data: d('2026-04-01T18:52:00Z'), ilosc: 453, od: 'mag/Strefa składowania', do: 'Inventory adjustment' }),
    linia({ produkt: '[T012] Maturatorium epoki wydanie I', data: d('2026-04-01T18:52:30Z'), ilosc: 453, od: 'Inventory adjustment', do: 'mag/Strefa składowania' })
  ]);
  assert.equal(conversions.length, 1);
  assert.equal(conversions[0].sourceCode, 'G014');
  assert.equal(conversions[0].targetCode, 'T012');
});

test('detectConversions nie paruje różnych wyrobów o tej samej ilości', () => {
  const { conversions, pozostaleKorekty } = detectConversions([
    linia({ produkt: '[G020] Skarpety E8 Granat/róż gadżet', data: d('2026-01-28T19:49:00Z'), ilosc: 105, od: 'mag/Strefa składowania', do: 'Inventory adjustment' }),
    linia({ produkt: '[T001] Długopis E8 towar', data: d('2026-01-28T19:48:00Z'), ilosc: 105, od: 'Inventory adjustment', do: 'mag/Strefa składowania' })
  ]);
  assert.equal(conversions.length, 0);
  assert.equal(pozostaleKorekty.length, 2);
});

test('detectConversions nie paruje korekt na tej samej kartotece', () => {
  const { conversions } = detectConversions([
    linia({ produkt: '[G002] Długopis mat', data: d('2026-01-28T19:46:00Z'), ilosc: 1746, od: 'mag/Strefa składowania', do: 'Inventory adjustment' }),
    linia({ produkt: '[G002] Długopis mat', data: d('2026-01-28T19:46:30Z'), ilosc: 1746, od: 'Inventory adjustment', do: 'mag/Strefa składowania' })
  ]);
  assert.equal(conversions.length, 0);
});

test('detectConversions nie paruje korekt odległych w czasie', () => {
  const { conversions } = detectConversions([
    linia({ produkt: '[T003] Egzaminatorium', data: d('2026-09-26T08:00:00Z'), ilosc: 20, od: 'mag/Strefa składowania', do: 'Inventory adjustment' }),
    linia({ produkt: '[G060] Egzaminatorium', data: d('2026-09-26T18:00:00Z'), ilosc: 20, od: 'Inventory adjustment', do: 'mag/Strefa składowania' })
  ]);
  assert.equal(conversions.length, 0);
});

test('detectConversions ignoruje ruchy spoza korekt stanu', () => {
  const { conversions, pozostaleKorekty } = detectConversions([
    linia({ produkt: '[G005] Krówki E8', data: d('2026-05-01T10:00:00Z'), ilosc: 20, od: 'mag/Strefa składowania', do: 'Customers' }),
    linia({ produkt: '[T016] Krówki E8', data: d('2026-05-01T10:01:00Z'), ilosc: 20, od: 'Vendors', do: 'mag/Strefa składowania' })
  ]);
  assert.equal(conversions.length, 0);
  assert.equal(pozostaleKorekty.length, 0);
});

test('tylkoAktywne odsiewa zarchiwizowane, brak pola traktuje jak aktywną', () => {
  const out = tylkoAktywne([
    { kod: 'G050', aktywny: true },
    { kod: 'G041', aktywny: false },
    { kod: 'G039' }
  ]);
  assert.deepEqual(out.map((x) => x.kod), ['G050', 'G039']);
});

test('findDuplicateCodes łapie ten sam kod na dwóch produktach', () => {
  const produkty = mergeProducts([
    { kod: 'G041', nazwa: 'Krówki matura', kategoria: 'gadżet', stan: 0 },
    { kod: 'G041', nazwa: 'Planer 8 mies mat', kategoria: 'gadżet', stan: 45 }
  ]);
  assert.equal(produkty.length, 2);
  const k = findDuplicateCodes(produkty);
  assert.equal(k.length, 1);
  assert.equal(k[0].itemCode, 'G041');
  assert.equal(k[0].wygrywa.name, 'Planer 8 mies mat');
  assert.deepEqual(k[0].przegrywaja.map((x) => x.name), ['Krówki matura']);
});

test('findDuplicateCodes milczy, gdy kody są unikalne', () => {
  const produkty = mergeProducts([
    { kod: 'G039', nazwa: 'Arkusz polski e8', kategoria: 'gadżet', stan: 279 },
    { kod: 'T003', nazwa: 'Egzaminatorium', kategoria: 'Towar', stan: 277 }
  ]);
  assert.deepEqual(findDuplicateCodes(produkty), []);
});
