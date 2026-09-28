import test from 'node:test';
import assert from 'node:assert/strict';
import { movePriceBatches, assignFifoPrices, newFifoQueue, takeFifoLayers } from '../src/stock-history.js';

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

test('cena z dokumentu jest oznaczona jako pochodząca z dokumentu', () => {
  const op = { type: 'receipt', lines: [{ itemCode: 'G039', unitPrice: 6.95 }] };
  assert.equal(movePriceBatches(op, ruch('G039', 100)).source, 'dokument');
});

// Sedno zgłoszenia: dokument odtworzony z Odoo własnej ceny nie ma. Wtedy wchodzi
// `assignFifoPrices` i dokłada ją z partii kartoteki — FIFO, nie średnia, bo kolumna
// nazywa się „Cena wg partii" i ma pokazywać partie.
test('dokument z importu zgłasza brak ceny — wycenę dokłada dopiero FIFO', () => {
  const op = { type: 'receipt', importedFrom: 'odoo', lines: [{ itemCode: 'T038', quantity: 10 }] };
  assert.deepEqual(movePriceBatches(op, ruch('T038', 10)), { batches: null, source: null, unpriced: 'import' });
});

test('ruch bez dokumentu to brak danych, nie import', () => {
  assert.deepEqual(movePriceBatches(null, ruch('G001', 3)), { batches: null, source: null, unpriced: 'brak-danych' });
});

test('dokument zaplecza bez detalu nie udaje importu', () => {
  const op = { type: 'delivery', deliveryDetail: [] };
  assert.equal(movePriceBatches(op, ruch('G001', 3)).unpriced, 'brak-danych');
});

// --- FIFO z partii kartoteki ----------------------------------------------------

const wiersz = (kod, qty, kiedy, extra = {}) =>
  ({ itemCode: kod, quantity: qty, doneAt: kiedy, priceBatches: null, source: null, unpriced: 'import', ...extra });

test('ruch mieszczący się w jednej partii bierze jej cenę', () => {
  const rows = [wiersz('G039', 40, '2026-09-10')];
  assignFifoPrices(rows, new Map([['G039', [{ qty: 100, unitPrice: 6.95 }]]]));
  assert.deepEqual(rows[0].priceBatches, [{ qty: 40, unitPrice: 6.95 }]);
  assert.equal(rows[0].source, 'fifo');
  assert.equal(rows[0].unpriced, null);
});

// To jest różnica, o którą chodzi: 9,5 kg krówek to 4,5 po 22,10 i 5 po 24,00,
// a nie 9,5 po uśrednionych 23,10.
test('ruch przez dwie partie pokazuje obie warstwy, nie ich średnią', () => {
  const rows = [wiersz('T016', 9.5, '2026-09-08')];
  assignFifoPrices(rows, new Map([['T016', [{ qty: 4.5, unitPrice: 22.1 }, { qty: 5, unitPrice: 24 }]]]));
  assert.deepEqual(rows[0].priceBatches, [{ qty: 4.5, unitPrice: 22.1 }, { qty: 5, unitPrice: 24 }]);
  const wartosc = rows[0].priceBatches.reduce((s, b) => s + b.qty * b.unitPrice, 0);
  assert.equal(Math.round(wartosc * 100) / 100, 219.45);
});

test('kolejka jest wspólna: starszy ruch zjada partię przed młodszym', () => {
  const rows = [wiersz('G039', 60, '2026-09-20'), wiersz('G039', 40, '2026-09-10')];
  assignFifoPrices(rows, new Map([['G039', [{ qty: 40, unitPrice: 5 }, { qty: 60, unitPrice: 8 }]]]));
  const starszy = rows.find(r => r.doneAt === '2026-09-10');
  const mlodszy = rows.find(r => r.doneAt === '2026-09-20');
  assert.deepEqual(starszy.priceBatches, [{ qty: 40, unitPrice: 5 }]);
  assert.deepEqual(mlodszy.priceBatches, [{ qty: 60, unitPrice: 8 }]);
});

test('ruch z ceną z dokumentu nie rusza kolejki', () => {
  const zDokumentu = wiersz('G039', 40, '2026-09-01', { priceBatches: [{ qty: 40, unitPrice: 99 }], source: 'dokument', unpriced: null });
  const rows = [zDokumentu, wiersz('G039', 40, '2026-09-10')];
  assignFifoPrices(rows, new Map([['G039', [{ qty: 40, unitPrice: 5 }, { qty: 60, unitPrice: 8 }]]]));
  assert.deepEqual(rows[0].priceBatches, [{ qty: 40, unitPrice: 99 }]);
  assert.deepEqual(rows[1].priceBatches, [{ qty: 40, unitPrice: 5 }]);
});

// Partie opisują stan dzisiejszy, a historia sięga wstecz — kolejka potrafi się
// skończyć przed listą ruchów. Dociągamy wtedy po ostatniej znanej cenie warstwy.
test('gdy partie się wyczerpią, dalsze ruchy idą po ostatniej znanej cenie', () => {
  const rows = [wiersz('G039', 150, '2026-09-10')];
  assignFifoPrices(rows, new Map([['G039', [{ qty: 100, unitPrice: 6.95 }]]]));
  assert.deepEqual(rows[0].priceBatches, [{ qty: 100, unitPrice: 6.95 }, { qty: 50, unitPrice: 6.95 }]);
});

test('kartoteka bez partii zostaje bez ceny', () => {
  const rows = [wiersz('X001', 5, '2026-09-10')];
  assignFifoPrices(rows, new Map());
  assert.equal(rows[0].priceBatches, null);
  assert.equal(rows[0].unpriced, 'import');
});

test('kolejka ignoruje partie zużyte do zera, ale pamięta ich cenę', () => {
  const q = newFifoQueue([{ qty: 0, unitPrice: 4 }, { qty: 0, unitPrice: 7 }]);
  assert.deepEqual(q.warstwy, []);
  assert.deepEqual(takeFifoLayers(q, 3), [{ qty: 3, unitPrice: 7 }]);
});
