import test from 'node:test';
import assert from 'node:assert/strict';
import { computeValuation, computeAging, computeGiftThresholdReport } from '../src/stock.js';
import { newFifoQueue, takeFifoLayers } from '../src/stock-history.js';

// Import zakłada partię o ilości 0 dla kartotek, które w Odoo mają koszt, ale nie mają
// stanu — inaczej cała historia takiego produktu zostaje bez wyceny. Partia zerowa ma
// robić DOKŁADNIE jedno: podawać cenę kolejce FIFO. Tu pilnujemy, żeby nie zaczęła
// robić czegokolwiek więcej — bo trafia do tej samej tablicy, co partie realne.

const bezStanu = {
  itemCode: 'T038', name: 'Bilet energylandia', category: 'Towar', quantity: 0,
  priceBatches: [{ qty: 0, unitPrice: 193.52, note: 'Odoo T038', addedAt: new Date('2026-01-10') }]
};

const zeStanem = {
  itemCode: 'G039', name: 'Arkusz polski e8', category: 'gadżet', quantity: 100,
  priceBatches: [{ qty: 100, unitPrice: 6.95, note: 'Odoo G039', addedAt: new Date('2026-09-01') }]
};

test('wycena stanu nie rośnie o partię zerową', () => {
  const sama = computeValuation([bezStanu]);
  assert.equal(sama.totalQty, 0);
  assert.equal(sama.totalValue, 0);

  const razem = computeValuation([zeStanem, bezStanu]);
  const bez = computeValuation([zeStanem]);
  assert.equal(razem.totalValue, bez.totalValue);
  assert.equal(razem.totalQty, bez.totalQty);
});

test('wiek zapasu pomija produkt, który ma wyłącznie partię zerową', () => {
  const rep = computeAging([bezStanu, zeStanem], new Date('2026-09-29'));
  assert.deepEqual(rep.products.map(p => p.itemCode), ['G039']);
  assert.equal(rep.totalQty, 100);
});

test('próg prezentu nie widzi partii zerowej', () => {
  const gadzetZKonwersji = {
    itemCode: 'G060', name: 'Egzaminatorium', category: 'gadżet', quantity: 0,
    priceBatches: [{ qty: 0, unitPrice: 99, note: 'konwersja z T003' }]
  };
  const rep = computeGiftThresholdReport([gadzetZKonwersji], 20);
  assert.equal(rep.items.length, 0);
});

// I to, po co ta partia w ogóle istnieje.
test('kolejka FIFO bierze cenę z partii zerowej jako ostatnią znaną', () => {
  const q = newFifoQueue(bezStanu.priceBatches);
  assert.deepEqual(q.warstwy, []);
  assert.equal(q.ostatniaCena, 193.52);
  assert.deepEqual(takeFifoLayers(q, 10), [{ qty: 10, unitPrice: 193.52 }]);
});

// Gdy realne warstwy istnieją, to one rządzą — a nadwyżka idzie po cenie warstwy
// OSTATNIO ZDJĘTEJ, nie po cenie partii zerowej. Tak jest bliżej FIFO: skończył się
// zapas, więc liczymy dalej po koszcie, który właśnie widzieliśmy. Partia zerowa
// wchodzi do gry dopiero wtedy, gdy realnych warstw nie ma wcale.
test('realne partie mają pierwszeństwo, nadwyżka idzie po ostatnio zdjętej cenie', () => {
  const q = newFifoQueue([
    { qty: 4, unitPrice: 5 },
    { qty: 0, unitPrice: 9 }
  ]);
  assert.deepEqual(takeFifoLayers(q, 6), [{ qty: 4, unitPrice: 5 }, { qty: 2, unitPrice: 5 }]);
});
