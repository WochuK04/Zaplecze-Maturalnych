import test from 'node:test';
import assert from 'node:assert/strict';
import { movePriceBatches } from '../src/stock-history.js';

// Wycena pojedynczego ruchu w raporcie „Ruchy w okresie". Zgłoszenie z Magazynu
// brzmiało „eksport ruchów w okresie nie pobiera cen i wartości" — okazało się, że
// kresek jest kilka rodzajów i raport nie umiał ich rozróżnić.

const ruch = (kod, qty) => ({ itemCode: kod, quantity: qty });

test('przyjęcie wycenia się ceną z pozycji dokumentu', () => {
  const op = { type: 'receipt', lines: [{ itemCode: 'G039', unitPrice: 6.95 }] };
  const { batches, unpriced } = movePriceBatches(op, ruch('G039', 100));
  assert.equal(unpriced, null);
  assert.deepEqual(batches, [{ qty: 100, unitPrice: 6.95 }]);
});

test('cena zero to cena, nie brak ceny', () => {
  const op = { type: 'receipt', lines: [{ itemCode: 'G039', unitPrice: 0 }] };
  const { batches, unpriced } = movePriceBatches(op, ruch('G039', 5));
  assert.equal(unpriced, null);
  assert.deepEqual(batches, [{ qty: 5, unitPrice: 0 }]);
});

test('wydanie pokazuje wszystkie partie zdjęte FIFO', () => {
  const op = {
    type: 'delivery',
    deliveryDetail: [{ itemCode: 'G039', consumed: [{ qty: 40, unitPrice: 5 }, { qty: 60, unitPrice: 6.95 }] }]
  };
  const { batches } = movePriceBatches(op, ruch('G039', 100));
  assert.equal(batches.length, 2);
  assert.equal(batches.reduce((s, b) => s + b.qty * b.unitPrice, 0), 40 * 5 + 60 * 6.95);
});

// Korekty mają ceny tak samo jak wydania, a raport ich wcześniej nie czytał —
// przez to wyrównanie stanu do Odoo (ADJ-WYR) wychodziło bez wartości.
test('korekta stanu jest wyceniana jak każdy inny dokument', () => {
  const zdjecie = { type: 'adjustment', adjustmentDetail: [{ itemCode: 'T016', consumed: [{ qty: 1, unitPrice: 12.4 }] }] };
  assert.deepEqual(movePriceBatches(zdjecie, ruch('T016', 1)).batches, [{ qty: 1, unitPrice: 12.4 }]);

  const dolozenie = { type: 'adjustment', adjustmentDetail: [{ itemCode: 'T016', added: { unitPrice: 12.4 } }] };
  assert.deepEqual(movePriceBatches(dolozenie, ruch('T016', 2)).batches, [{ qty: 2, unitPrice: 12.4 }]);
});

test('konwersja: źródło po partiach zdjętych, cel po koszcie przeniesionym', () => {
  const op = {
    type: 'conversion',
    conversionDetail: [{ sourceCode: 'T003', targetCode: 'G060', qty: 20, consumed: [{ qty: 20, unitPrice: 8.5 }] }]
  };
  assert.deepEqual(movePriceBatches(op, ruch('T003', 20)).batches, [{ qty: 20, unitPrice: 8.5 }]);
  assert.deepEqual(movePriceBatches(op, ruch('G060', 20)).batches, [{ qty: 20, unitPrice: 8.5 }]);
});

// Sedno zgłoszenia: odróżnić „nie znamy ceny, bo dokument przyszedł z Odoo" od
// „coś się zepsuło". Pierwsze jest stanem faktycznym i UI ma to powiedzieć wprost.
test('dokument z importu Odoo zgłasza brak ceny jako brak danych źródła', () => {
  const op = { type: 'receipt', importedFrom: 'odoo', lines: [{ itemCode: 'T038', quantity: 10 }] };
  const { batches, unpriced } = movePriceBatches(op, ruch('T038', 10));
  assert.equal(batches, null);
  assert.equal(unpriced, 'import');
});

test('konwersja z importu też jest oznaczona jako import, nie jako pustka', () => {
  const op = { type: 'conversion', importedFrom: 'odoo', lines: [{ itemCode: 'T020', targetItemCode: 'G063', quantity: 82 }] };
  assert.equal(movePriceBatches(op, ruch('G063', 82)).unpriced, 'import');
});

test('ruch bez dokumentu to brak danych, nie import', () => {
  assert.deepEqual(movePriceBatches(null, ruch('G001', 3)), { batches: null, unpriced: 'brak-danych' });
});

test('dokument zaplecza bez detalu nie udaje importu', () => {
  const op = { type: 'delivery', deliveryDetail: [] };
  assert.equal(movePriceBatches(op, ruch('G001', 3)).unpriced, 'brak-danych');
});
