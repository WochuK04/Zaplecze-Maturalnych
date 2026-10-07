import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProductRef, productCore, compareCodes, pickCanonical,
  mergeProducts, findConversionCandidates, mapLocation, classifyMove,
  normalizeMoveLine, detectConversions, tylkoAktywne, findDuplicateCodes, resolveCodeCollisions, mapUnit, normalizeStock, odnosnikImportu, dopasujKartoteke} from '../src/odoo.js';

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

test('mergeProducts zachowuje kod pustej kartoteki w mergedCodes', () => {
  const out = mergeProducts([
    { kod: 'G009', nazwa: 'Kubek E8', kategoria: 'gadżet', stan: 109, koszt: 3 },
    { kod: 'G008', nazwa: 'Kubek E8', kategoria: 'gadżet', stan: 0, koszt: 5 }
  ]);
  assert.equal(out[0].itemCode, 'G009');
  assert.deepEqual(out[0].mergedCodes, ['G008']);
  assert.equal(out[0].quantity, 109);
});

// Odoo trzyma koszt na kartotece niezależnie od stanu, a historia ruchów sięga czasów,
// gdy towar jeszcze był. Bez partii o ilości 0 cała ta historia zostawała bez wyceny —
// dotyczyło to 37 kartotek, w tym „Biletu energylandia" za 193,52 zł.
test('kartoteka bez stanu, ale z kosztem, daje partię o ilości 0', () => {
  const out = mergeProducts([
    { kod: 'T038', nazwa: 'Bilet energylandia', kategoria: 'Towar', stan: 0, koszt: 193.52 }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].quantity, 0);
  assert.deepEqual(
    out[0].priceBatches.map(b => ({ qty: b.qty, unitPrice: b.unitPrice })),
    [{ qty: 0, unitPrice: 193.52 }]
  );
});

test('partia o ilości 0 nie dokłada się do stanu produktu', () => {
  const out = mergeProducts([
    { kod: 'G009', nazwa: 'Kubek E8', kategoria: 'gadżet', stan: 109, koszt: 3 },
    { kod: 'G008', nazwa: 'Kubek E8', kategoria: 'gadżet', stan: 0, koszt: 5 }
  ]);
  assert.equal(out[0].quantity, 109);
  assert.equal(out[0].priceBatches.length, 2);
  assert.equal(out[0].priceBatches.reduce((s, b) => s + b.qty, 0), 109);
});

// Zerowa cena to nie to samo co nieznana. „Za darmo" musiałoby być prawdą, a nie jest.
test('kartoteka bez stanu i bez kosztu nadal nie daje partii', () => {
  const out = mergeProducts([
    { kod: 'T020', nazwa: 'Planer na 35 tygodni', kategoria: 'Towar', stan: 0, koszt: 0 }
  ]);
  assert.equal(out[0].priceBatches.length, 0);
});

// Sponsor: dostajemy za 0 i wydajemy za 0 — zero jest poprawne, więc kartoteka
// ze stanem wchodzi normalnie, z ceną zerową.
test('sponsor ze stanem wchodzi jako partia po 0 zł', () => {
  const out = mergeProducts([
    { kod: 'S001', nazwa: 'Owolovo galaretka', kategoria: 'sponsor', stan: 1300, koszt: 0 }
  ]);
  assert.deepEqual(
    out[0].priceBatches.map(b => ({ qty: b.qty, unitPrice: b.unitPrice })),
    [{ qty: 1300, unitPrice: 0 }]
  );
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

test('resolveCodeCollisions nie pozwala importowi przejąć kodu sprzętu', () => {
  // Realny przypadek z produkcji: T003 to w Odoo „Egzaminatorium matematyka",
  // a w zapleczu „Statyw lampowy" z importu Excela.
  const produkty = mergeProducts([
    { kod: 'T003', nazwa: 'Egzaminatorium matematyka wydanie I', kategoria: 'Towar', stan: 277, koszt: 21.65 },
    { kod: 'G039', nazwa: 'Arkusz polski e8', kategoria: 'gadżet', stan: 279, koszt: 3.35 }
  ]);
  const { produkty: out, mapa, kolizje } = resolveCodeCollisions(produkty, new Set(['T003']));

  assert.equal(kolizje.length, 1);
  assert.deepEqual(
    { odoo: kolizje[0].odooCode, nowy: kolizje[0].itemCode },
    { odoo: 'T003', nowy: 'MAG-T003' }
  );
  assert.equal(mapa.get('T003'), 'MAG-T003');

  const egz = out.find((p) => p.odooCode === 'T003');
  assert.equal(egz.itemCode, 'MAG-T003');
  assert.equal(egz.quantity, 277);
  // Kartoteka bez kolizji zostaje ze swoim kodem z Odoo.
  assert.equal(out.find((p) => p.name === 'Arkusz polski e8').itemCode, 'G039');
});

test('resolveCodeCollisions łapie kolizję także na kodzie wchłoniętym', () => {
  const produkty = mergeProducts([
    { kod: 'G009', nazwa: 'Kubek E8', kategoria: 'gadżet', stan: 109, koszt: 20.25 },
    { kod: 'G008', nazwa: 'Kubek E8', kategoria: 'gadżet', stan: 0, koszt: 18.45 }
  ]);
  // Kolizja siedzi na kodzie scalonym (G008), nie na wiodącym.
  const { produkty: out, mapa, kolizje } = resolveCodeCollisions(produkty, new Set(['G008']));
  assert.equal(kolizje.length, 1);
  assert.equal(out[0].itemCode, 'MAG-G009');
  assert.equal(mapa.get('G008'), 'MAG-G009');
  assert.equal(mapa.get('G009'), 'MAG-G009');
});

test('resolveCodeCollisions milczy, gdy nic nie koliduje', () => {
  const produkty = mergeProducts([
    { kod: 'G039', nazwa: 'Arkusz polski e8', kategoria: 'gadżet', stan: 279, koszt: 3.35 }
  ]);
  const { produkty: out, kolizje } = resolveCodeCollisions(produkty, new Set(['KAM-1', 'LAP-7']));
  assert.equal(kolizje.length, 0);
  assert.equal(out[0].itemCode, 'G039');
  assert.ok(!('odooCode' in out[0]));
});

test('resolveCodeCollisions porównuje kody bez względu na wielkość liter', () => {
  const produkty = mergeProducts([
    { kod: 'T003', nazwa: 'Egzaminatorium', kategoria: 'Towar', stan: 10, koszt: 1 }
  ]);
  const { kolizje } = resolveCodeCollisions(produkty, new Set(['t003']));
  assert.equal(kolizje.length, 1);
});

test('mapUnit tłumaczy jednostki Odoo, nieznane spadają na sztuki', () => {
  assert.equal(mapUnit('Units'), 'szt.');
  assert.equal(mapUnit('kg'), 'kg');
  assert.equal(mapUnit('Litry'), 'l');
  assert.equal(mapUnit(''), 'szt.');
  assert.equal(mapUnit('cośdziwnego'), 'szt.');
});

test('normalizeStock zachowuje ułamki — kilogramów nie wolno zaokrąglać', () => {
  // Realny przypadek: bilans T016 to 25 − 15 − 0,5 − 4,5 = 5 kg. Zaokrąglanie
  // do sztuk dawało 4 i wyglądało to na ręczną edycję stanu w Odoo.
  assert.equal(normalizeStock(0.5), 0.5);
  assert.equal(normalizeStock(4.5), 4.5);
  assert.equal(normalizeStock('3.14159'), 3.142);
  assert.equal(normalizeStock(-2), 0);
  assert.equal(normalizeStock('nie liczba'), 0);
});

test('mergeProducts NIE scala kartotek o różnych jednostkach', () => {
  // „Wypełniacz do paczek niebieski" ma w Odoo kartotekę na sztuki i na kilogramy.
  // Zlanie ich dałoby „11 szt." — liczbę bez znaczenia.
  const out = mergeProducts([
    { kod: 'O010', nazwa: 'Wypełniacz do paczek niebieski', kategoria: 'opakowanie', stan: 1, koszt: 165.6, jednostka: 'Units' },
    { kod: 'O011', nazwa: 'Wypełniacz do paczek niebieski', kategoria: 'opakowanie', stan: 10, koszt: 14.51, jednostka: 'kg' }
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((p) => [p.itemCode, p.quantity, p.unit]).sort(),
    [['O010', 1, 'szt.'], ['O011', 10, 'kg']]
  );
});

test('mergeProducts scala kartoteki tej samej jednostki i nie gubi ułamków', () => {
  const out = mergeProducts([
    { kod: 'T016', nazwa: 'Krówki E8', kategoria: 'Towar', stan: 5.5, koszt: 35.7, jednostka: 'kg' },
    { kod: 'T018', nazwa: 'Krówki E8', kategoria: 'Towar', stan: 0.5, koszt: 35.7, jednostka: 'kg' }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].unit, 'kg');
  assert.equal(out[0].quantity, 6);
  assert.deepEqual(out[0].priceBatches.map((b) => b.qty), [5.5, 0.5]);
});

test('normalizeMoveLine przenosi jednostkę i ułamkową ilość', () => {
  const l = normalizeMoveLine({
    produkt: '[T016] Krówki E8', data: d('2026-08-24T10:00:00Z'), ilosc: 0.5,
    od: 'mag/Strefa składowania', do: 'Customers', odnosnik: 'mag/OUT/00010', status: 'Wykonano'
  });
  assert.equal(l.qty, 0.5);
  assert.equal(l.jednostka, 'szt.');
  assert.equal(normalizeMoveLine({ produkt: '[T016] x', data: d('2026-08-24T10:00:00Z'), ilosc: 4.5, od: 'a', do: 'b', jednostka: 'kg' }).jednostka, 'kg');
});

// --- przestrzeń nazw odnośników importu -------------------------------------
// Regresja z 07.10.2026: import historii wywrócił się w połowie zapisu na unikalnym
// indeksie `reference`. Odoo nazywa przekazy `mag/IN/00057`, czyli tak samo jak
// numeruje się dokument zakładany w Zapleczu — gdy w Odoo przybyły nowe przekazy,
// jego numeracja weszła na numery już wydane przez licznik aplikacji.
test('odnośnik importu trafia do przestrzeni odoo/ i nie zderza się z serią aplikacji', () => {
  assert.equal(odnosnikImportu('mag/IN/00057'), 'odoo/mag/IN/00057');
  assert.equal(odnosnikImportu('mag/OUT/00012'), 'odoo/mag/OUT/00012');
  // Seria aplikacji (OPERATION_TYPES.prefix) to `mag/…` — po prefiksowaniu nie ma
  // sposobu, żeby którykolwiek odnośnik importu zrównał się z odnośnikiem z aplikacji.
  assert.ok(odnosnikImportu('mag/IN/00057').startsWith('odoo/'));
  assert.notEqual(odnosnikImportu('mag/IN/00057'), 'mag/IN/00057');
});

test('prefiksowanie jest idempotentne — ponowny import nie dokłada kolejnego odoo/', () => {
  assert.equal(odnosnikImportu('odoo/mag/IN/00057'), 'odoo/mag/IN/00057');
  assert.equal(odnosnikImportu('odoo/CONV/00001'), 'odoo/CONV/00001');
  assert.equal(odnosnikImportu(odnosnikImportu('mag/IN/1')), 'odoo/mag/IN/1');
});

test('puste i śmieciowe wejście nie produkuje odnośnika', () => {
  assert.equal(odnosnikImportu(''), '');
  assert.equal(odnosnikImportu(null), '');
  assert.equal(odnosnikImportu(undefined), '');
  assert.equal(odnosnikImportu('   '), '');
});

test('odnośnik importu zachowuje oryginalny numer Odoo w środku', () => {
  // Numer ma zostać czytelny, żeby dało się zestawić dokument z Odoo bez bazy.
  assert.match(odnosnikImportu('mag/IN/00057'), /00057$/);
});

// --- dopasowanie kartoteki po przenumerowaniu kodu --------------------------
// Magazyn stoi na kodach z Odoo (`G039`). Po przenumerowaniu na schemat aplikacji
// (`GADZ-…`) kartoteki nie da się już znaleźć po kodzie z Odoo — a import szukał
// wyłącznie po `itemCode`. Bez tego dopasowania najbliższa synchronizacja założyłaby
// wszystkie sto pozycji drugi raz.
test('kartoteka nieprzenumerowana dopasowuje się po itemCode', () => {
  const baza = [{ itemCode: 'G039', name: 'Arkusz polski e8' }];
  const r = dopasujKartoteke({ itemCode: 'G039', mergedCodes: [] }, baza);
  assert.equal(r.wiodacy, baza[0]);
  assert.equal(r.kodDocelowy, 'G039');
  assert.deepEqual(r.doWchloniecia, []);
});

test('kartoteka przenumerowana dopasowuje się po odooCode i ZOSTAJE przy swoim kodzie', () => {
  const baza = [{ itemCode: 'GADZ-MQTBGLJ5', odooCode: 'G039', name: 'Arkusz polski e8' }];
  const r = dopasujKartoteke({ itemCode: 'G039', mergedCodes: [] }, baza);
  assert.equal(r.wiodacy, baza[0], 'musi ją znaleźć mimo innego itemCode');
  assert.equal(r.kodDocelowy, 'GADZ-MQTBGLJ5', 'import nie cofa przenumerowania');
});

test('brak kartoteki w bazie → produkt do założenia pod kodem z Odoo', () => {
  const r = dopasujKartoteke({ itemCode: 'G099', mergedCodes: [] }, []);
  assert.equal(r.wiodacy, null);
  assert.equal(r.kodDocelowy, 'G099');
});

test('scalenie po przenumerowaniu: wchłaniane idą na kod lokalny, nie na kod Odoo', () => {
  const baza = [
    { itemCode: 'GADZ-MQTBGLJ5', odooCode: 'G039', name: 'Arkusz polski e8' },
    { itemCode: 'G046', name: 'Arkusz polski e8' }
  ];
  const r = dopasujKartoteke({ itemCode: 'G039', mergedCodes: ['G046'] }, baza);
  assert.equal(r.kodDocelowy, 'GADZ-MQTBGLJ5');
  assert.deepEqual(r.doWchloniecia.map((d) => d.itemCode), ['G046']);
});

test('kod wiodący wygrywa z wchłanianym, niezależnie od kolejności w bazie', () => {
  const baza = [
    { itemCode: 'G046', name: 'Arkusz polski e8' },
    { itemCode: 'G039', name: 'Arkusz polski e8' }
  ];
  const r = dopasujKartoteke({ itemCode: 'G039', mergedCodes: ['G046'] }, baza);
  assert.equal(r.wiodacy.itemCode, 'G039');
  assert.deepEqual(r.doWchloniecia.map((d) => d.itemCode), ['G046']);
});
