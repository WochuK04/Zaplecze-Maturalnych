import test from 'node:test';
import assert from 'node:assert/strict';
import { itemCodePrefix, itemCodeSuffix, buildItemCode, matchesScheme, normalizeItemCode } from '../src/lib/item-code.js';

test('prefiks to cztery pierwsze litery kategorii, bez znaków diakrytycznych', () => {
  assert.equal(itemCodePrefix('Akcesoria'), 'AKCE');
  assert.equal(itemCodePrefix('Audio'), 'AUDI');
  assert.equal(itemCodePrefix('Roll-up'), 'ROLL');
  assert.equal(itemCodePrefix('Zdrowie'), 'ZDRO');
  assert.equal(itemCodePrefix('Sprzęt'), 'SPRZ');
  assert.equal(itemCodePrefix(''), 'ZAK');
  assert.equal(itemCodePrefix(null), 'ZAK');
});

test('buildItemCode składa kod w postaci PREFIKS-SUFIKS', () => {
  const kod = buildItemCode('Kamery');
  assert.match(kod, /^KAME-[A-Z0-9]+$/);
});

test('rozróżnik rozsuwa kody generowane w tej samej milisekundzie', () => {
  const a = itemCodeSuffix('0');
  const b = itemCodeSuffix('1');
  assert.notEqual(a, b);
});

test('matchesScheme przyjmuje kod aplikacji, odrzuca numerację ręczną', () => {
  assert.equal(matchesScheme('AKCE-MQTBGLJ5', 'Akcesoria'), true);
  assert.equal(matchesScheme('akce-mqtbglj5', 'Akcesoria'), true);
  // Prefiks innej kategorii — kartoteka przekategoryzowana, kod nie nadąża.
  assert.equal(matchesScheme('AKCE-MQTBCH1T', 'Lampy'), false);
  // Numeracja z ręcznych importów: brak „-".
  assert.equal(matchesScheme('AS046', 'Akcesoria'), false);
  assert.equal(matchesScheme('K004', 'Kamery'), false);
  assert.equal(matchesScheme('', 'Kamery'), false);
});

test('normalizeItemCode przycina i podnosi do wielkich liter', () => {
  assert.equal(normalizeItemCode('  akce-abc '), 'AKCE-ABC');
  assert.equal(normalizeItemCode(null), '');
});
