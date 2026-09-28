// Testy jednostkowe replayStockAt — odtwarzania stanu i wyceny FIFO na dany dzień.
// Bez Mongo: funkcja jest czysta, dostaje gotową listę ruchów i mapę dokumentów.
import test from 'node:test';
import assert from 'node:assert/strict';
import { replayStockAt, endOfDay } from '../src/stock-history.js';

// WH = realny magazyn, SUP = wirtualna lokalizacja dostawców, CUST = wirtualna klientów.
const LOCS = [
  { id: 'WH', kind: 'internal' },
  { id: 'BIURO', kind: 'internal' },
  { id: 'SUP', kind: 'supplier' },
  { id: 'CUST', kind: 'customer' }
];

const move = (over) => ({
  itemCode: 'T012', quantity: 1, lot: null,
  fromLocationId: null, toLocationId: null, operationId: null, ...over
});

test('przyjęcie buduje stan i warstwę cenową', () => {
  const moves = [move({ quantity: 109, fromLocationId: 'SUP', toLocationId: 'WH', operationId: 'op1' })];
  const opById = new Map([['op1', { type: 'receipt', lines: [{ itemCode: 'T012', unitPrice: 23.7 }] }]]);

  const { rows, byItem } = replayStockAt({ moves, locations: LOCS, opById });

  assert.equal(rows.find(r => r.locationId === 'WH').quantity, 109);
  const agg = byItem.get('T012');
  assert.equal(agg.quantity, 109);
  assert.equal(agg.value, round(109 * 23.7));
  assert.equal(agg.valueExact, true);
});

test('dwa przyjęcia po różnych cenach dają dwie warstwy FIFO', () => {
  const moves = [
    move({ quantity: 109, fromLocationId: 'SUP', toLocationId: 'WH', operationId: 'op1' }),
    move({ quantity: 825, fromLocationId: 'SUP', toLocationId: 'WH', operationId: 'op2' })
  ];
  const opById = new Map([
    ['op1', { type: 'receipt', lines: [{ itemCode: 'T012', unitPrice: 23.7 }] }],
    ['op2', { type: 'receipt', lines: [{ itemCode: 'T012', unitPrice: 16.58 }] }]
  ]);

  const { byItem } = replayStockAt({ moves, locations: LOCS, opById });
  const agg = byItem.get('T012');

  assert.equal(agg.quantity, 934);
  assert.deepEqual(agg.layers, [{ qty: 109, unitPrice: 23.7 }, { qty: 825, unitPrice: 16.58 }]);
  assert.equal(agg.value, round(109 * 23.7 + 825 * 16.58));
});

test('wydanie zdejmuje najstarszą warstwę (FIFO), nie najtańszą', () => {
  const moves = [
    move({ quantity: 109, fromLocationId: 'SUP', toLocationId: 'WH', operationId: 'op1' }),
    move({ quantity: 825, fromLocationId: 'SUP', toLocationId: 'WH', operationId: 'op2' }),
    move({ quantity: 200, fromLocationId: 'WH', toLocationId: 'CUST', operationId: 'op3' })
  ];
  const opById = new Map([
    ['op1', { type: 'receipt', lines: [{ itemCode: 'T012', unitPrice: 23.7 }] }],
    ['op2', { type: 'receipt', lines: [{ itemCode: 'T012', unitPrice: 16.58 }] }],
    ['op3', { type: 'delivery', deliveryDetail: [{ itemCode: 'T012', consumed: [{ qty: 109, unitPrice: 23.7 }, { qty: 91, unitPrice: 16.58 }] }] }]
  ]);

  const { byItem } = replayStockAt({ moves, locations: LOCS, opById });
  const agg = byItem.get('T012');

  assert.equal(agg.quantity, 734);
  assert.deepEqual(agg.layers, [{ qty: 734, unitPrice: 16.58 }]);
  assert.equal(agg.valueExact, true);
});

test('przesunięcie między realnymi lokalizacjami nie zmienia wyceny', () => {
  const moves = [
    move({ quantity: 100, fromLocationId: 'SUP', toLocationId: 'WH', operationId: 'op1' }),
    move({ quantity: 40, fromLocationId: 'WH', toLocationId: 'BIURO' })
  ];
  const opById = new Map([['op1', { type: 'receipt', lines: [{ itemCode: 'T012', unitPrice: 10 }] }]]);

  const { rows, byItem } = replayStockAt({ moves, locations: LOCS, opById });

  assert.equal(rows.find(r => r.locationId === 'WH').quantity, 60);
  assert.equal(rows.find(r => r.locationId === 'BIURO').quantity, 40);
  const agg = byItem.get('T012');
  assert.equal(agg.quantity, 100);
  assert.equal(agg.value, 1000);
  assert.equal(agg.valueExact, true);
});

test('storno przyjęcia zdejmuje warstwę po cenie tego przyjęcia, nie FIFO', () => {
  // Najpierw tanie przyjęcie, potem drogie — i storno tego DROGIEGO.
  // FIFO zdjęłoby tanie warstwy; storno musi trafić w swoją własną cenę.
  const moves = [
    move({ quantity: 100, fromLocationId: 'SUP', toLocationId: 'WH', operationId: 'op1' }),
    move({ quantity: 50, fromLocationId: 'SUP', toLocationId: 'WH', operationId: 'op2' }),
    move({ quantity: 50, fromLocationId: 'WH', toLocationId: 'SUP', operationId: 'op2', isReversal: true })
  ];
  const opById = new Map([
    ['op1', { type: 'receipt', lines: [{ itemCode: 'T012', unitPrice: 10 }] }],
    ['op2', { type: 'receipt', lines: [{ itemCode: 'T012', unitPrice: 99 }] }]
  ]);

  const { byItem } = replayStockAt({ moves, locations: LOCS, opById });
  const agg = byItem.get('T012');

  assert.equal(agg.quantity, 100);
  assert.deepEqual(agg.layers, [{ qty: 100, unitPrice: 10 }]);
  assert.equal(agg.value, 1000);
});

test('storno wydania oddaje dokładnie te warstwy, które wydanie zdjęło', () => {
  const moves = [
    move({ quantity: 100, fromLocationId: 'SUP', toLocationId: 'WH', operationId: 'op1' }),
    move({ quantity: 30, fromLocationId: 'WH', toLocationId: 'CUST', operationId: 'op2' }),
    move({ quantity: 30, fromLocationId: 'CUST', toLocationId: 'WH', operationId: 'op2', isReversal: true })
  ];
  const opById = new Map([
    ['op1', { type: 'receipt', lines: [{ itemCode: 'T012', unitPrice: 10 }] }],
    ['op2', { type: 'delivery', deliveryDetail: [{ itemCode: 'T012', consumed: [{ qty: 30, unitPrice: 10 }] }] }]
  ]);

  const { byItem } = replayStockAt({ moves, locations: LOCS, opById });
  const agg = byItem.get('T012');

  assert.equal(agg.quantity, 100);
  assert.equal(agg.value, 1000);
  assert.equal(agg.valueExact, true);
});

test('stan otwarcia bez dokumentu wchodzi po 0 zł i oznacza wycenę jako przybliżoną', () => {
  const moves = [move({ quantity: 42, fromLocationId: null, toLocationId: 'WH' })];

  const { byItem } = replayStockAt({ moves, locations: LOCS, opById: new Map() });
  const agg = byItem.get('T012');

  assert.equal(agg.quantity, 42);
  assert.equal(agg.value, 0);
  assert.equal(agg.valueExact, false);
});

test('ruchy po dacie granicznej po prostu nie trafiają na wejście', () => {
  // Filtr daty robi zapytanie do Mongo; tu sprawdzamy, że wynik zależy wyłącznie
  // od przekazanej listy — przewinięcie o jeden ruch mniej daje stan sprzed wydania.
  const all = [
    move({ quantity: 100, fromLocationId: 'SUP', toLocationId: 'WH', operationId: 'op1' }),
    move({ quantity: 60, fromLocationId: 'WH', toLocationId: 'CUST', operationId: 'op2' })
  ];
  const opById = new Map([
    ['op1', { type: 'receipt', lines: [{ itemCode: 'T012', unitPrice: 10 }] }],
    ['op2', { type: 'delivery', deliveryDetail: [{ itemCode: 'T012', consumed: [{ qty: 60, unitPrice: 10 }] }] }]
  ]);

  assert.equal(replayStockAt({ moves: all.slice(0, 1), locations: LOCS, opById }).byItem.get('T012').quantity, 100);
  assert.equal(replayStockAt({ moves: all, locations: LOCS, opById }).byItem.get('T012').quantity, 40);
});

test('ilości ułamkowe (kilogramy) przechodzą bez zaokrąglania', () => {
  const moves = [
    move({ itemCode: 'T016', quantity: 10, fromLocationId: 'SUP', toLocationId: 'WH', operationId: 'op1' }),
    move({ itemCode: 'T016', quantity: 0.5, fromLocationId: 'WH', toLocationId: 'CUST', operationId: 'op2' })
  ];
  const opById = new Map([
    ['op1', { type: 'receipt', lines: [{ itemCode: 'T016', unitPrice: 30 }] }],
    ['op2', { type: 'delivery', deliveryDetail: [{ itemCode: 'T016', consumed: [{ qty: 0.5, unitPrice: 30 }] }] }]
  ]);

  const { byItem } = replayStockAt({ moves, locations: LOCS, opById });
  assert.equal(byItem.get('T016').quantity, 9.5);
  assert.equal(byItem.get('T016').value, 285);
});

test('endOfDay zwraca koniec doby, a dla śmieci null', () => {
  const d = endOfDay('2026-08-31');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 7);
  assert.equal(d.getDate(), 31);
  assert.equal(d.getHours(), 23);
  assert.equal(endOfDay('31.08.2026'), null);
  assert.equal(endOfDay(''), null);
});

const round = (n) => Math.round(n * 100) / 100;
