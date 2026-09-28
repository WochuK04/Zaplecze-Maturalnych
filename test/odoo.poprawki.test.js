import test from 'node:test';
import assert from 'node:assert/strict';
import { zastosujPoprawki, BEZ_ODNOSNIKA, PRZELICZNIKI } from '../src/odoo-poprawki.js';
import { mergeProducts, tylkoAktywne } from '../src/odoo.js';

test('nadaje kod kartotece, która nie ma odnośnika w Odoo', () => {
  const { kartoteki, zastosowane } = zastosujPoprawki([
    { kod: '', nazwa: 'Taśma E8', kategoria: 'Sprzęt', stan: 32, koszt: 0, jednostka: 'Units' }
  ]);
  assert.equal(kartoteki.length, 1);
  assert.equal(kartoteki[0].kod, 'O018');
  assert.equal(kartoteki[0].kategoria, 'opakowanie');
  assert.equal(zastosowane[0].nadanyKod, 'O018');
});

test('pomija kartotekę, która należy do modułu Sprzęt', () => {
  const { kartoteki, pominiete } = zastosujPoprawki([
    { kod: '', nazwa: 'Szklana kula', kategoria: 'Sprzęt', stan: 7, koszt: 0, jednostka: 'Units' }
  ]);
  assert.equal(kartoteki.length, 0);
  assert.equal(pominiete[0].nazwa, 'Szklana kula');
});

test('przelicza jednostkę bez zmiany wartości pozycji', () => {
  const { kartoteki, zastosowane } = zastosujPoprawki([
    { kod: 'O010', nazwa: 'Wypełniacz do paczek niebieski', kategoria: 'opakowanie', stan: 1, koszt: 165.6, jednostka: 'Units' }
  ]);
  const k = kartoteki[0];
  assert.equal(k.jednostka, 'kg');
  assert.equal(k.stan, 10);
  assert.equal(k.koszt, 16.56);
  // Wartość pozycji musi zostać bez zmian — to jest sedno przeliczenia.
  assert.equal(Math.round(k.stan * k.koszt * 100) / 100, 165.6);
  assert.match(zastosowane[0].przeliczono, /→ 10 kg/);
});

test('po przeliczeniu O010 i O011 scalają się w jedną pozycję', () => {
  const surowe = [
    { kod: 'O010', nazwa: 'Wypełniacz do paczek niebieski', kategoria: 'opakowanie', stan: 1, koszt: 165.6, jednostka: 'Units' },
    { kod: 'O011', nazwa: 'Wypełniacz do paczek niebieski', kategoria: 'opakowanie', stan: 10, koszt: 14.51, jednostka: 'kg' }
  ];
  // Bez poprawki jednostki się różnią, więc scalenie nie następuje.
  assert.equal(mergeProducts(surowe).length, 2);

  const out = mergeProducts(tylkoAktywne(zastosujPoprawki(surowe).kartoteki));
  assert.equal(out.length, 1);
  assert.equal(out[0].unit, 'kg');
  assert.equal(out[0].quantity, 20);
  assert.equal(out[0].priceBatches.reduce((s, b) => s + b.qty * b.unitPrice, 0), 310.7);
});

test('zgłasza poprawki, które w nic nie trafiły', () => {
  const { nietrafione } = zastosujPoprawki([
    { kod: 'G001', nazwa: 'Długopis E8', kategoria: 'gadżet', stan: 5, koszt: 2.5, jednostka: 'Units' }
  ]);
  // Żaden wpis nie znalazł swojej kartoteki — wszystkie muszą być zgłoszone.
  assert.equal(nietrafione.length, BEZ_ODNOSNIKA.length + PRZELICZNIKI.length);
  assert.ok(nietrafione.some((n) => n.includes('Taśma E8')));
  assert.ok(nietrafione.some((n) => n.includes('O010')));
});

test('nie rusza kartotek, których poprawki nie dotyczą', () => {
  const wejscie = [{ kod: 'G039', nazwa: 'Arkusz polski e8', kategoria: 'gadżet', stan: 279, koszt: 3.35, jednostka: 'Units' }];
  const { kartoteki } = zastosujPoprawki(wejscie);
  assert.deepEqual(kartoteki[0], wejscie[0]);
});

test('dopasowanie po nazwie ignoruje wielkość liter i nadmiarowe spacje', () => {
  const { kartoteki } = zastosujPoprawki([
    { kod: '', nazwa: '  taśma   matura ', kategoria: 'Sprzęt', stan: 34, koszt: 0, jednostka: 'Units' }
  ]);
  assert.equal(kartoteki[0].kod, 'O019');
});
