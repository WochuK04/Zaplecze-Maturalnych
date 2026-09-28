import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLinesTable } from '../src/operation-pdf.js';

// Wydruk przyjęcia. Zgłoszenie z Magazynu: „brak kwot przy tworzeniu pdfa z przyjęć" —
// dokument odtworzony z Odoo nie ma cen w pozycjach, a wydruk pokazywał je jako 0,00 zł.
// Zero to cena, brak ceny to brak danych; na papierze, który idzie do księgowości,
// pomylenie tych dwóch rzeczy znaczy „towar przyszedł za darmo".

const przyjecie = (lines, extra = {}) => ({ type: 'receipt', lines, ...extra });

test('pozycja bez ceny drukuje kreskę, nie zero', () => {
  const t = buildLinesTable(przyjecie([{ itemCode: 'T038', itemName: 'Bilet', quantity: 250 }]));
  assert.deepEqual(t.rows[0], ['T038', 'Bilet', '250', '—', '—']);
  assert.equal(t.pricedLines, 0);
  assert.equal(t.unpricedLines, 1);
});

test('ilość ułamkowa drukuje się po polsku, z przecinkiem', () => {
  const t = buildLinesTable(przyjecie([{ itemCode: 'T016', itemName: 'Krówki', quantity: 9.5 }]));
  assert.equal(t.rows[0][2], '9,5');
});

test('cena zero nadal drukuje się jako kwota', () => {
  const t = buildLinesTable(przyjecie([{ itemCode: 'G001', itemName: 'Gratis', quantity: 10, unitPrice: 0 }]));
  assert.deepEqual(t.rows[0], ['G001', 'Gratis', '10', '0,00 zł', '0,00 zł']);
  assert.equal(t.pricedLines, 1);
  assert.equal(t.unpricedLines, 0);
});

test('suma liczy tylko pozycje, które mają cenę', () => {
  const t = buildLinesTable(przyjecie([
    { itemCode: 'G039', quantity: 100, unitPrice: 6.95 },
    { itemCode: 'T038', quantity: 250 }
  ]));
  assert.equal(t.totalValue, 695);
  assert.equal(t.pricedLines, 1);
  assert.equal(t.unpricedLines, 1);
});

test('dokument bez żadnej ceny nie udaje sumy zerowej', () => {
  const t = buildLinesTable(przyjecie([
    { itemCode: 'G053', quantity: 25 },
    { itemCode: 'T031', quantity: 250 }
  ]));
  assert.equal(t.totalValue, 0);
  assert.equal(t.pricedLines, 0);
  assert.equal(t.unpricedLines, 2);
});
