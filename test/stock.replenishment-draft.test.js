// Test jednostkowy logiki „Uzupełnij" — replenishmentDraft z src/stock.js (czysta
// funkcja decydująca, czy z policzonej reguły min-max da się zbudować linię przyjęcia).
// Uruchom: `node --test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { replenishmentDraft } from '../src/stock.js';

// Wiersz w kształcie zwracanym przez computeReplenishment.
const row = (over = {}) => ({
  id: 'r1', scope: 'item', target: 'GADZ-1', label: 'GADZ-1 · Smycz',
  minQty: 10, maxQty: 50, onHand: 2, toOrder: 48, below: true, isActive: true, ...over
});

test('reguła itemowa poniżej minimum → eligible z linią na toOrder', () => {
  const d = replenishmentDraft(row());
  assert.equal(d.eligible, true);
  assert.deepEqual(d.line, { itemCode: 'GADZ-1', quantity: 48 });
});

test('reguła kategorii → nieobsługiwana (brak jednego produktu)', () => {
  const d = replenishmentDraft(row({ scope: 'category', target: 'gadżet' }));
  assert.equal(d.eligible, false);
  assert.equal(d.reason, 'category');
});

test('reguła powyżej minimum (below=false) → nic do uzupełnienia', () => {
  const d = replenishmentDraft(row({ below: false, toOrder: 0 }));
  assert.equal(d.eligible, false);
  assert.equal(d.reason, 'not_below');
});

test('below=true, ale toOrder ≤ 0 → nie tworzymy pustej linii', () => {
  assert.equal(replenishmentDraft(row({ toOrder: 0 })).reason, 'zero');
  assert.equal(replenishmentDraft(row({ toOrder: -5 })).reason, 'zero');
});

test('toOrder ułamkowy jest zaokrąglany w dół do pełnych sztuk', () => {
  assert.equal(replenishmentDraft(row({ toOrder: 7.9 })).line.quantity, 7);
  assert.equal(replenishmentDraft(row({ toOrder: 7.9, unit: 'szt.' })).line.quantity, 7);
  assert.equal(replenishmentDraft(row({ toOrder: 7.9, unit: 'opak.' })).line.quantity, 7);
});

test('toOrder na kg/l/m zostaje ułamkowy — „zamów 7,9 kg" jest poprawne', () => {
  assert.equal(replenishmentDraft(row({ toOrder: 7.9, unit: 'kg' })).line.quantity, 7.9);
  assert.equal(replenishmentDraft(row({ toOrder: 0.5, unit: 'l' })).line.quantity, 0.5);
  // Poniżej pełnej sztuki: dla kg zamawiamy, dla sztuk nie ma czego zamówić.
  assert.equal(replenishmentDraft(row({ toOrder: 0.4, unit: 'kg' })).line.quantity, 0.4);
  assert.equal(replenishmentDraft(row({ toOrder: 0.4, unit: 'szt.' })).reason, 'zero');
});

test('brak wiersza / śmieci nie wybuchają', () => {
  assert.equal(replenishmentDraft(undefined).eligible, false);
  assert.equal(replenishmentDraft(null).eligible, false);
  assert.equal(replenishmentDraft({}).eligible, false);
});
