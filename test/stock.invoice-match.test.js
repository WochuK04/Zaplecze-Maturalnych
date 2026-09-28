// Testy jednostkowe dopasowania pozycji faktury do kartoteki produktów.
// Bez Mongo i bez modelu — czysta heurystyka nazw + słownik aliasów.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeInvoiceName, nameSimilarity, matchInvoiceLine, matchInvoiceLines, MATCH_THRESHOLD
} from '../src/lib/invoice-match.js';

// Wycinek realnej kartoteki po imporcie z Odoo.
const PRODUCTS = [
  { itemCode: 'T018', name: 'Długopis E8', category: 'Towar' },
  { itemCode: 'T019', name: 'Długopis mat', category: 'Towar' },
  { itemCode: 'T012', name: 'Maturatorium epoki wydanie I', category: 'Towar' },
  { itemCode: 'T016', name: 'Krówki E8', category: 'Towar' },
  { itemCode: 'O011', name: 'Wypełniacz do paczek niebieski', category: 'opakowanie' },
  { itemCode: 'G023', name: 'Smyczki E8', category: 'gadżet' }
];

test('normalizacja zdejmuje ogonki, znaki i wielkość liter', () => {
  assert.equal(normalizeInvoiceName('Wypełniacz do paczek, NIEBIESKI'), 'wypelniacz do paczek niebieski');
  assert.equal(normalizeInvoiceName('  Długopis   E8  '), 'dlugopis e8');
});

test('identyczna nazwa po normalizacji to trafienie dokładne', () => {
  const m = matchInvoiceLine('DŁUGOPIS E8', PRODUCTS);
  assert.equal(m.itemCode, 'T018');
  assert.equal(m.source, 'exact');
  assert.equal(m.score, 1);
});

test('rozwlekły opis z faktury trafia w krótką nazwę z kartoteki', () => {
  const m = matchInvoiceLine('Długopis plastikowy z nadrukiem E8, kolor niebieski', PRODUCTS);
  assert.equal(m.itemCode, 'T018');
  assert.equal(m.source, 'fuzzy');
  assert.ok(m.score >= MATCH_THRESHOLD);
});

test('alias bije heurystykę i wskazuje produkt, którego nazwa nic nie podpowiada', () => {
  const aliases = new Map([['wkl 3000 nieb', 'T018']]);
  const m = matchInvoiceLine('WKL-3000 NIEB', PRODUCTS, aliases);
  assert.equal(m.itemCode, 'T018');
  assert.equal(m.source, 'alias');
});

test('alias wskazujący na nieistniejący już produkt jest ignorowany', () => {
  const aliases = new Map([['cos tam', 'T999']]);
  assert.equal(matchInvoiceLine('coś tam', PRODUCTS, aliases), null);
});

test('nazwa niepodobna do niczego nie dostaje podpowiedzi', () => {
  assert.equal(matchInvoiceLine('Usługa transportowa DPD', PRODUCTS), null);
  assert.equal(matchInvoiceLine('Palety EUR 120x80', PRODUCTS), null);
});

test('nie myli produktów różniących się jednym słowem-kluczem', () => {
  // „Długopis mat" i „Długopis E8" mają wspólne tylko słowo „dlugopis".
  const m = matchInvoiceLine('Długopis mat', PRODUCTS);
  assert.equal(m.itemCode, 'T019');
});

test('podobieństwo jest symetryczne i zerowe przy braku wspólnych słów', () => {
  assert.equal(nameSimilarity('Krówki E8', 'Smyczki E8') > 0, true); // wspolne "e8"
  assert.equal(nameSimilarity('Krówki E8', 'Palety drewniane'), 0);
  assert.equal(nameSimilarity('Długopis E8', 'E8 Długopis'), nameSimilarity('E8 Długopis', 'Długopis E8'));
});

test('szum („szt", „nadruk", „logo") nie podbija podobieństwa', () => {
  const withNoise = nameSimilarity('Smyczki E8 szt z nadrukiem logo', 'Smyczki E8');
  const without = nameSimilarity('Smyczki E8', 'Smyczki E8');
  assert.equal(withNoise, without);
});

test('matchInvoiceLines zachowuje kolejność, ilości i ceny netto', () => {
  const out = matchInvoiceLines({
    items: [
      { name: 'Długopis E8', quantity: 1000, unit: 'szt.', unitPriceNet: 1.2 },
      { name: 'Usługa transportowa', quantity: 1, unit: 'szt.', unitPriceNet: 50 },
      { name: 'Krówki E8 mleczne', quantity: 9.5, unit: 'kg', unitPriceNet: 28.4 }
    ],
    products: PRODUCTS,
    aliases: []
  });

  assert.equal(out.length, 3);
  assert.equal(out[0].suggestion.itemCode, 'T018');
  assert.equal(out[1].suggestion, null);
  assert.equal(out[2].suggestion.itemCode, 'T016');
  assert.equal(out[2].quantity, 9.5);
  assert.equal(out[2].unit, 'kg');
  assert.equal(out[2].unitPriceNet, 28.4);
});

test('aliasy podane jako lista dokumentów są normalizowane przy wczytaniu', () => {
  const out = matchInvoiceLines({
    items: [{ name: '  DŁUGOPIS-REKLAMOWY 3000  ', quantity: 5, unitPriceNet: 2 }],
    products: PRODUCTS,
    aliases: [{ invoiceText: 'Długopis reklamowy 3000', itemCode: 'T019' }]
  });
  assert.equal(out[0].suggestion.itemCode, 'T019');
  assert.equal(out[0].suggestion.source, 'alias');
});
