// Test integracyjny: historia przetworzeń zaciągnięta z Odoo.
// Sprawdza raport „Przetworzenia" (/warehouse/conversions) i to, że dokumentu
// zaimportowanego z Odoo NIE da się cofnąć — nie ma snapshotu partii cenowych,
// więc cofnięcie rozjechałoby stan z wyceną.
// Izolowana baza, forge req.user (admin). Wymaga lokalnego Mongo.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';

process.env.DB_NAME = 'maturalni_equipment_odoohist_test';

const { default: app } = await import('../src/index.js');
const { getDb, closeDb } = await import('../src/db.js');
const { collections } = await import('../src/schema.js');
const { seedStandardLocations, applyMove } = await import('../src/stock.js');

function startServer(user) {
  const parent = express();
  parent.use(express.json());
  parent.use((req, _res, next) => { req.user = user; req.isAuthenticated = () => true; next(); });
  parent.use(app);
  return new Promise(resolve => { const s = parent.listen(0, () => resolve(s)); });
}

function req(server, method, path) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method }, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null }));
    });
    r.on('error', reject);
    r.end();
  });
}

const admin = { email: 'admin@maturalni.com', fullName: 'Admin', role: 'admin' };
const KIEDY = new Date('2026-09-26T18:11:00Z');
let server, db, opId;

test.before(async () => {
  db = getDb();
  await db.dropDatabase();
  const lok = await seedStandardLocations(db);
  const stock = String(lok.get('WH/Stock')._id);
  const conv = String(lok.get('VIRT/Conversion')._id);

  await db.collection(collections.items).insertMany([
    { itemCode: 'T003', name: 'Egzaminatorium matematyka wydanie I', category: 'Towar', quantity: 277, priceBatches: [], isActive: true },
    { itemCode: 'G060', name: 'Egzaminatorium matematyka wydanie I', category: 'gadżet', quantity: 20, priceBatches: [], isActive: true }
  ]);

  const { insertedId } = await db.collection(collections.stockOperations).insertOne({
    reference: 'odoo/CONV/00007',
    type: 'conversion',
    state: 'done',
    lines: [{ itemCode: 'T003', targetItemCode: 'G060', quantity: 20 }],
    sourceDocument: 'Zaktualizowana ilość produktu',
    createdByEmail: 'import@odoo',
    doneByEmail: 'import@odoo',
    doneAt: KIEDY,
    createdAt: new Date(),
    updatedAt: new Date(),
    importedFrom: 'odoo'
  });
  opId = String(insertedId);

  await applyMove(db, { itemCode: 'T003', fromLocationId: stock, toLocationId: conv, quantity: 20, kind: 'conversion', operationId: opId, doneAt: KIEDY });
  await applyMove(db, { itemCode: 'G060', fromLocationId: conv, toLocationId: stock, quantity: 20, kind: 'conversion', operationId: opId, doneAt: KIEDY });

  server = await startServer(admin);
});

test.after(async () => {
  if (server) server.close();
  await db.dropDatabase();
  await closeDb();
});

test('raport przetworzeń pokazuje „z czego → na co”, ile i kiedy', async () => {
  const res = await req(server, 'GET', '/warehouse/conversions');
  assert.equal(res.status, 200);
  assert.equal(res.json.rows.length, 1);
  const r = res.json.rows[0];
  assert.equal(r.sourceCode, 'T003');
  assert.equal(r.targetCode, 'G060');
  assert.equal(r.targetCategory, 'gadżet');
  assert.equal(r.qty, 20);
  assert.equal(r.imported, true);
  assert.equal(new Date(r.when).toISOString(), KIEDY.toISOString());
  assert.equal(res.json.total.operations, 1);
});

test('brak kosztu z Odoo zwraca null, a nie wymyśloną kwotę', async () => {
  const { json } = await req(server, 'GET', '/warehouse/conversions');
  assert.equal(json.rows[0].unitCost, null);
  assert.equal(json.rows[0].value, null);
  assert.equal(json.total.linesWithoutCost, 1);
});

test('filtr dat zawęża raport', async () => {
  const w = await req(server, 'GET', '/warehouse/conversions?from=2026-09-01&to=2026-09-30');
  assert.equal(w.json.rows.length, 1);
  const poza = await req(server, 'GET', '/warehouse/conversions?from=2026-01-01&to=2026-01-31');
  assert.equal(poza.json.rows.length, 0);
});

test('filtr itemCode łapie zarówno źródło, jak i cel', async () => {
  const zrodlo = await req(server, 'GET', '/warehouse/conversions?itemCode=T003');
  const cel = await req(server, 'GET', '/warehouse/conversions?itemCode=G060');
  const obcy = await req(server, 'GET', '/warehouse/conversions?itemCode=G999');
  assert.equal(zrodlo.json.rows.length, 1);
  assert.equal(cel.json.rows.length, 1);
  assert.equal(obcy.json.rows.length, 0);
});

test('dokumentu z importu Odoo nie da się cofnąć', async () => {
  const res = await req(server, 'POST', `/warehouse/operations/${opId}/reverse`);
  assert.equal(res.status, 400);
  assert.match(res.json.message, /historii Odoo/);

  // Stan po odrzuconym cofnięciu jest nietknięty.
  const moves = await db.collection(collections.stockMoves).countDocuments({ operationId: opId });
  assert.equal(moves, 2);
  const op = await db.collection(collections.stockOperations).findOne({ reference: 'odoo/CONV/00007' });
  assert.equal(op.state, 'done');
});
