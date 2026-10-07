// Test integracyjny: ruchy dostają DATĘ Z DOKUMENTU, a nie chwilę kliknięcia.
//
// Bez tego towar przyjęty w piątek, a wprowadzony do systemu w poniedziałek, siadał
// w historii na poniedziałek — i raport „stan na dzień" za piątek go nie widział.
// Izolowana baza, forge req.user (admin). Wymaga lokalnego Mongo.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';

process.env.DB_NAME = 'maturalni_equipment_dataop_test';

const { default: app } = await import('../src/index.js');
const { getDb, closeDb } = await import('../src/db.js');
const { collections } = await import('../src/schema.js');
const { seedStandardLocations, nextReference } = await import('../src/stock.js');

function startServer(user) {
  const parent = express();
  parent.use(express.json());
  parent.use((req, _res, next) => { req.user = user; req.isAuthenticated = () => true; next(); });
  parent.use(app);
  return new Promise(resolve => { const s = parent.listen(0, () => resolve(s)); });
}

function req(server, method, path, body) {
  const { port } = server.address();
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port, path, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
    }, res => {
      let out = '';
      res.on('data', c => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, json: out ? JSON.parse(out) : null }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const admin = { email: 'admin@maturalni.com', fullName: 'Admin', role: 'admin' };
let server, db, stockId, supplierId;

async function nowyDraft(scheduledAt) {
  const reference = await nextReference(db, 'mag/IN');
  const { insertedId } = await db.collection(collections.stockOperations).insertOne({
    type: 'receipt', reference, state: 'draft',
    fromLocationId: supplierId, toLocationId: stockId,
    lines: [{ itemCode: 'T500', quantity: 10, unitPrice: 2 }],
    scheduledAt, createdAt: new Date(), updatedAt: new Date()
  });
  return String(insertedId);
}

test.before(async () => {
  db = getDb();
  await db.dropDatabase();
  const byCode = await seedStandardLocations(db);
  stockId = String(byCode.get('WH/Stock')._id);
  supplierId = String(byCode.get('VIRT/Suppliers')._id);
  await db.collection(collections.items).insertOne({
    itemCode: 'T500', name: 'Karton testowy', category: 'towar',
    quantity: 0, isActive: true, priceBatches: []
  });
  server = await startServer(admin);
});

test.after(async () => {
  await db.dropDatabase();
  server?.close();
  await closeDb();
});

test('ruch dostaje datę z dokumentu, nie chwilę zatwierdzenia', async () => {
  const dzien = new Date('2026-03-11T00:00:00.000Z');
  const opId = await nowyDraft(dzien);
  const r = await req(server, 'POST', `/warehouse/operations/${opId}/validate`, {});
  assert.equal(r.status, 200);

  const ruchy = await db.collection(collections.stockMoves).find({ operationId: opId }).toArray();
  assert.ok(ruchy.length > 0);
  for (const m of ruchy) {
    assert.equal(new Date(m.doneAt).toISOString().slice(0, 10), '2026-03-11');
  }
});

test('„stan na dzień" widzi towar już w dniu z dokumentu', async () => {
  // Istota zmiany: dokument wprowadzony dziś, ale datowany na 11.03 — raport za 11.03
  // ma ten towar pokazać, a za 10.03 jeszcze nie.
  const przed = await req(server, 'GET', '/warehouse/stock-at?date=2026-03-10');
  const po = await req(server, 'GET', '/warehouse/stock-at?date=2026-03-11');
  assert.equal((przed.json.rows || []).find(r => r.itemCode === 'T500'), undefined);
  assert.equal((po.json.rows || []).find(r => r.itemCode === 'T500').quantity, 10);
});

test('data z przyszłości jest odrzucana', async () => {
  const jutro = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const opId = await nowyDraft(jutro);
  const r = await req(server, 'POST', `/warehouse/operations/${opId}/validate`, {});
  assert.equal(r.status, 400);
  assert.match(r.json.message, /przysz/i);

  const ruchy = await db.collection(collections.stockMoves).countDocuments({ operationId: opId });
  assert.equal(ruchy, 0, 'odrzucony dokument nie zostawia ruchów');
});

test('stary draft bez daty dalej się zatwierdza — wpada chwila zatwierdzenia', async () => {
  // Wersje robocze sprzed wprowadzenia pola nie mogą się zablokować.
  const opId = await nowyDraft(null);
  const r = await req(server, 'POST', `/warehouse/operations/${opId}/validate`, {});
  assert.equal(r.status, 200);

  const ruch = await db.collection(collections.stockMoves).findOne({ operationId: opId });
  const dzis = new Date().toISOString().slice(0, 10);
  assert.equal(new Date(ruch.doneAt).toISOString().slice(0, 10), dzis);
});

test('PATCH zapisuje datę dokumentu', async () => {
  const opId = await nowyDraft(null);
  const r = await req(server, 'PATCH', `/warehouse/operations/${opId}`, { scheduledAt: '2026-02-20' });
  assert.equal(r.status, 200);
  const op = await db.collection(collections.stockOperations)
    .findOne({ _id: (await import('mongodb')).ObjectId.createFromHexString(opId) });
  assert.equal(new Date(op.scheduledAt).toISOString().slice(0, 10), '2026-02-20');
});
