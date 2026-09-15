import test from 'node:test';
import assert from 'node:assert/strict';
import { UNITS, DEFAULT_UNIT, isUnit, normalizeUnit, normalizeQty, normalizeQtyOrZero } from '../src/lib/units.js';

test('normalizeUnit: zna tylko jednostki z listy', () => {
  for (const u of UNITS) assert.equal(normalizeUnit(u), u);
  assert.equal(normalizeUnit(' kg '), 'kg');
});

test('normalizeUnit: nieznane i puste → domyślne „szt."', () => {
  // Produkty sprzed wprowadzenia pola nie mają go wcale — muszą działać bez migracji.
  assert.equal(normalizeUnit(undefined), DEFAULT_UNIT);
  assert.equal(normalizeUnit(null), DEFAULT_UNIT);
  assert.equal(normalizeUnit(''), DEFAULT_UNIT);
  assert.equal(normalizeUnit('kilogram'), DEFAULT_UNIT);
  assert.equal(normalizeUnit('Kg'), DEFAULT_UNIT);
  assert.equal(normalizeUnit(42), DEFAULT_UNIT);
});

test('isUnit odróżnia listę od wolnego tekstu', () => {
  assert.equal(isUnit('kg'), true);
  assert.equal(isUnit('szt.'), true);
  assert.equal(isUnit('szt'), false);
  assert.equal(isUnit(''), false);
});

test('normalizeQty: ułamki przechodzą (produkty na kg)', () => {
  // To był realny blocker: Math.max(1, …) zamieniało 0,5 kg na 1 kg.
  assert.equal(normalizeQty(9.5), 9.5);
  assert.equal(normalizeQty(0.5), 0.5);
  assert.equal(normalizeQty('0.25'), 0.25);
  assert.equal(normalizeQty(1), 1);
});

test('normalizeQty: zero, ujemne i śmieci → wartość zapasowa', () => {
  assert.equal(normalizeQty(0), 1);
  assert.equal(normalizeQty(-3), 1);
  assert.equal(normalizeQty('abc'), 1);
  assert.equal(normalizeQty(undefined), 1);
  assert.equal(normalizeQty(Infinity), 1);
  assert.equal(normalizeQty(0, 0), 0, 'wartość zapasową można nadpisać');
});

test('normalizeQty: przycina do 3 miejsc i gasi błędy zmiennoprzecinkowe', () => {
  assert.equal(normalizeQty(0.1 + 0.2), 0.3);
  assert.equal(normalizeQty(1.23456), 1.235);
});

test('normalizeQtyOrZero: zero jest poprawną odpowiedzią', () => {
  // Inwentaryzacja („policzono 0") i partie cenowe o zerowej ilości.
  assert.equal(normalizeQtyOrZero(0), 0);
  assert.equal(normalizeQtyOrZero(-5), 0);
  assert.equal(normalizeQtyOrZero('nic'), 0);
  assert.equal(normalizeQtyOrZero(9.5), 9.5);
  assert.equal(normalizeQtyOrZero(0.001), 0.001);
});
