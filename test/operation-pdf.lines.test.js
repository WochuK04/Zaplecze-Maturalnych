import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLinesTable } from '../src/operation-pdf.js';

// Wydruk przyjęcia. Zgłoszenie z Magazynu: „brak kwot przy tworzeniu pdfa z przyjęć" —
// dokument odtworzony z Odoo nie ma cen w pozycjach, a wydruk pokazywał je jako 0,00 zł.
// Zero to cena, brak ceny to brak danych; na papierze, który idzie do księgowości,
// pomylenie tych dwóch rzeczy znaczy „towar przyszedł za darmo".

const przyjecie = (lines, extra = {}) => ({ type: 'receipt', lines, ...extra });

test('pozycja, której nie ma czym wycenić, drukuje kreskę zamiast zera', () => {
  const t = buildLinesTable(przyjecie([{ itemCode: 'T038', itemName: 'Bilet', quantity: 250 }]));
  assert.deepEqual(t.rows[0], ['T038', 'Bilet', '250', '—', '—']);
  assert.equal(t.pricedLines, 0);
  assert.equal(t.unpricedLines, 1);
});

// Dokument odtworzony z Odoo własnej ceny nie ma, ale koszt kartoteki znamy —
// wyceniamy nim i oznaczamy gwiazdką, żeby nie czytało się jak kwota z faktury.
test('pozycja bez ceny w dokumencie wycenia się kosztem kartoteki, z gwiazdką', () => {
  const t = buildLinesTable(przyjecie([{ itemCode: 'T038', itemName: 'Bilet', quantity: 250, fallbackUnitPrice: 1.2 }]));
  assert.deepEqual(t.rows[0], ['T038', 'Bilet', '250', '1,20 zł *', '300,00 zł *']);
  assert.equal(t.estimatedLines, 1);
  assert.equal(t.pricedLines, 0);
  assert.equal(t.unpricedLines, 0);
  assert.equal(t.totalValue, 300);
});

test('cena z dokumentu wygrywa z kosztem kartoteki i nie dostaje gwiazdki', () => {
  const t = buildLinesTable(przyjecie([{ itemCode: 'G039', quantity: 10, unitPrice: 6.95, fallbackUnitPrice: 99 }]));
  assert.deepEqual(t.rows[0].slice(3), ['6,95 zł', '69,50 zł']);
  assert.equal(t.estimatedLines, 0);
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

test('suma pomija wyłącznie pozycje, których nie ma czym wycenić', () => {
  const t = buildLinesTable(przyjecie([
    { itemCode: 'G039', quantity: 100, unitPrice: 6.95 },
    { itemCode: 'T038', quantity: 250 }
  ]));
  assert.equal(t.totalValue, 695);
  assert.equal(t.pricedLines, 1);
  assert.equal(t.unpricedLines, 1);
});

test('suma łączy ceny z dokumentu z wyceną kartotekową', () => {
  const t = buildLinesTable(przyjecie([
    { itemCode: 'G039', quantity: 100, unitPrice: 6.95 },
    { itemCode: 'T038', quantity: 100, fallbackUnitPrice: 2 }
  ]));
  assert.equal(t.totalValue, 895);
  assert.equal(t.pricedLines, 1);
  assert.equal(t.estimatedLines, 1);
});

test('dokument, którego nie ma czym wycenić, nie udaje sumy zerowej', () => {
  const t = buildLinesTable(przyjecie([
    { itemCode: 'G053', quantity: 25 },
    { itemCode: 'T031', quantity: 250 }
  ]));
  assert.equal(t.totalValue, 0);
  assert.equal(t.pricedLines, 0);
  assert.equal(t.estimatedLines, 0);
  assert.equal(t.unpricedLines, 2);
});
