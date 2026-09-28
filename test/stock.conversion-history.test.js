import test from 'node:test';
import assert from 'node:assert/strict';
import { computeConversionHistory } from '../src/stock.js';

const items = new Map([
  ['T003', { itemCode: 'T003', name: 'Egzaminatorium matematyka', category: 'Towar' }],
  ['G060', { itemCode: 'G060', name: 'Egzaminatorium matematyka', category: 'gadżet' }],
  ['T015', { itemCode: 'T015', name: 'Kubek matura', category: 'Towar' }],
  ['G011', { itemCode: 'G011', name: 'Kubek matura', category: 'gadżet' }]
]);

const op = (o) => ({
  _id: o.id || 'x1',
  type: 'conversion',
  state: 'done',
  reference: o.reference || 'mag/CONV/00001',
  doneAt: o.doneAt,
  doneByEmail: o.by || 'kto@maturalni.com',
  lines: o.lines,
  conversionDetail: o.detail,
  importedFrom: o.importedFrom,
  sourceDocument: o.sourceDocument || '',
  ...o.extra
});

test('składa wiersz „z czego → na co” z nazwami produktów', () => {
  const { rows, total } = computeConversionHistory([op({
    doneAt: new Date('2026-09-26T18:11:00Z'),
    lines: [{ itemCode: 'T003', targetItemCode: 'G060', quantity: 20 }],
    detail: [{ sourceCode: 'T003', targetCode: 'G060', qty: 20, producedUnit: 8.5 }]
  })], items);

  assert.equal(rows.length, 1);
  assert.deepEqual(
    {
      s: rows[0].sourceCode, sn: rows[0].sourceName, sc: rows[0].sourceCategory,
      t: rows[0].targetCode, tc: rows[0].targetCategory,
      q: rows[0].qty, u: rows[0].unitCost, v: rows[0].value
    },
    { s: 'T003', sn: 'Egzaminatorium matematyka', sc: 'Towar', t: 'G060', tc: 'gadżet', q: 20, u: 8.5, v: 170 }
  );
  assert.deepEqual(total, { operations: 1, lines: 1, qty: 20, value: 170, linesWithoutCost: 0 });
});

test('dokument z Odoo nie ma kosztu — zamiast zmyślonej kwoty zwraca null', () => {
  const { rows, total } = computeConversionHistory([op({
    doneAt: new Date('2026-01-28T19:54:00Z'),
    lines: [{ itemCode: 'T015', targetItemCode: 'G011', quantity: 76 }],
    importedFrom: 'odoo'
  })], items);

  assert.equal(rows[0].unitCost, null);
  assert.equal(rows[0].value, null);
  assert.equal(rows[0].imported, true);
  assert.equal(total.value, 0);
  assert.equal(total.linesWithoutCost, 1);
});

test('pomija operacje innego typu i niezatwierdzone', () => {
  const { rows } = computeConversionHistory([
    op({ doneAt: new Date(), lines: [{ itemCode: 'T003', targetItemCode: 'G060', quantity: 1 }], extra: { type: 'receipt' } }),
    op({ doneAt: new Date(), lines: [{ itemCode: 'T003', targetItemCode: 'G060', quantity: 1 }], extra: { state: 'draft' } })
  ], items);
  assert.equal(rows.length, 0);
});

test('pomija pozycje bez produktu źródłowego lub docelowego', () => {
  const { rows } = computeConversionHistory([op({
    doneAt: new Date(),
    lines: [{ itemCode: 'T003', quantity: 5 }, { targetItemCode: 'G060', quantity: 5 }]
  })], items);
  assert.equal(rows.length, 0);
});

test('sortuje od najnowszych i liczy operacje, nie pozycje', () => {
  const { rows, total } = computeConversionHistory([
    op({
      id: 'a', doneAt: new Date('2026-01-01T10:00:00Z'),
      lines: [{ itemCode: 'T003', targetItemCode: 'G060', quantity: 2 }]
    }),
    op({
      id: 'b', doneAt: new Date('2026-09-01T10:00:00Z'),
      lines: [
        { itemCode: 'T003', targetItemCode: 'G060', quantity: 3 },
        { itemCode: 'T015', targetItemCode: 'G011', quantity: 4 }
      ]
    })
  ], items);

  assert.equal(rows[0].qty, 3);
  assert.equal(rows.at(-1).qty, 2);
  assert.equal(total.operations, 2);
  assert.equal(total.lines, 3);
  assert.equal(total.qty, 9);
});

test('nieznany kod nie wywraca raportu — nazwa spada do kodu', () => {
  const { rows } = computeConversionHistory([op({
    doneAt: new Date(),
    lines: [{ itemCode: 'ZZZ1', targetItemCode: 'G060', quantity: 1 }]
  })], items);
  assert.equal(rows[0].sourceName, 'ZZZ1');
  assert.equal(rows[0].sourceCategory, '');
});
