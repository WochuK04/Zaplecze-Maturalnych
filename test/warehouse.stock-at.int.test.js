// Test integracyjny „stanu na dzień" + storna.
//
// Sedno: rejestr ruchów jest append-only, więc cofnięcie starej operacji NIE zmienia
// stanu odtworzonego na wcześniejszą datę. Raz wyeksportowany stan zostaje prawdziwy.
// Izolowana baza, forge req.user (admin). Wymaga lokalnego Mongo.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';

process.env.DB_NAME = 'maturalni_equipment_stockat_test';

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
let server, db, stockId, supplierId, customerId;
let receiptId, deliveryId;

// Przesuwa ruchy danej operacji w przeszłość — udaje, że dokument wykonano wtedy.
async function backdate(operationId, iso) {
  await db.collection(collections.stockMoves).updateMany(
    { operationId: String(operationId) },
    { $set: { doneAt: new Date(iso) } }
  );
}

async function makeOp(type, lines, from, to) {
  const reference = await nextReference(db, type);
  const { insertedId } = await db.collection(collections.stockOperations).insertOne({
    type, reference, state: 'draft',
    fromLocationId: from, toLocationId: to,
    lines, createdAt: new Date(), updatedAt: new Date()
  });
  return String(insertedId);
}

test.before(async () => {
  db = getDb();
  await db.dropDatabase();
  const byCode = await seedStandardLocations(db);
  stockId = String(byCode.get('WH/Stock')._id);
  supplierId = String(byCode.get('VIRT/Suppliers')._id);
  customerId = String(byCode.get('VIRT/Customers')._id);

  await db.collection(collections.items).insertOne({
    itemCode: 'T012', name: 'Maturatorium epoki wydanie I', category: 'towar',
    quantity: 0, isActive: true, priceBatches: []
  });

  server = await startServer(admin);

  // Styczeń: przyjęcie 100 szt. po 23,70 zł.
  receiptId = await makeOp('receipt', [{ itemCode: 'T012', quantity: 100, unitPrice: 23.7 }], supplierId, stockId);
  await req(server, 'POST', `/warehouse/operations/${receiptId}/validate`, {});
  await backdate(receiptId, '2026-01-10T10:00:00.000Z');

  // Luty: wydanie 40 szt.
  deliveryId = await makeOp('delivery', [{ itemCode: 'T012', quantity: 40 }], stockId, customerId);
  await req(server, 'POST', `/warehouse/operations/${deliveryId}/validate`, {});
  await backdate(deliveryId, '2026-02-10T10:00:00.000Z');
});

test.after(async () => {
  await db.dropDatabase();
  server?.close();
  await closeDb();
});

test('stan na 31.01 zna przyjęcie, ale jeszcze nie wydanie', async () => {
  const r = await req(server, 'GET', '/warehouse/stock-at?date=2026-01-31');
  assert.equal(r.status, 200);
  const row = r.json.rows.find(x => x.itemCode === 'T012');
  assert.equal(row.quantity, 100);
  assert.equal(row.unitValue, 23.7);
  assert.equal(row.value, 2370);
  assert.equal(row.valueExact, true);
  assert.equal(r.json.totalValue, 2370);
});

test('stan na 28.02 uwzględnia wydanie', async () => {
  const r = await req(server, 'GET', '/warehouse/stock-at?date=2026-02-28');
  const row = r.json.rows.find(x => x.itemCode === 'T012');
  assert.equal(row.quantity, 60);
  assert.equal(row.value, 1422); // 60 × 23,70
});

test('stan na 09.01 — przed pierwszym ruchem — jest pusty', async () => {
  const r = await req(server, 'GET', '/warehouse/stock-at?date=2026-01-09');
  assert.equal(r.json.rows.length, 0);
  assert.equal(r.json.totalValue, 0);
});

test('zła data i data z przyszłości są odrzucane', async () => {
  assert.equal((await req(server, 'GET', '/warehouse/stock-at?date=31.01.2026')).status, 400);
  assert.equal((await req(server, 'GET', '/warehouse/stock-at?date=2099-01-01')).status, 400);
});

test('cofnięcie wydania dopisuje storno, a nie kasuje ruchów', async () => {
  const before = await db.collection(collections.stockMoves).countDocuments({ operationId: deliveryId });
  const r = await req(server, 'POST', `/warehouse/operations/${deliveryId}/reverse`, {});
  assert.equal(r.status, 200);

  const after = await db.collection(collections.stockMoves).countDocuments({ operationId: deliveryId });
  assert.equal(after, before * 2, 'każdy ruch dostaje swoje storno');
  const storna = await db.collection(collections.stockMoves).find({ operationId: deliveryId, isReversal: true }).toArray();
  assert.equal(storna.length, before);
  assert.equal(storna[0].fromLocationId, customerId, 'storno idzie w przeciwną stronę');
  assert.equal(storna[0].toLocationId, stockId);
});

test('po cofnięciu stan BIEŻĄCY wraca do 100 szt.', async () => {
  const r = await req(server, 'GET', '/warehouse/stock');
  const row = r.json.find(x => x.itemCode === 'T012');
  assert.equal(row.quantity, 100);
});

test('ale stan na 28.02 dalej pokazuje 60 szt. — historia się nie cofnęła', async () => {
  // To jest cała stawka zmiany: raport wydany w lutym zostaje prawdziwy,
  // mimo że dokument cofnięto we wrześniu.
  const r = await req(server, 'GET', '/warehouse/stock-at?date=2026-02-28');
  const row = r.json.rows.find(x => x.itemCode === 'T012');
  assert.equal(row.quantity, 60);
  assert.equal(row.value, 1422);
});

test('dokument z niedopasowanymi pozycjami faktury nie da się zatwierdzić', async () => {
  const opId = await makeOp('receipt', [{ itemCode: 'T012', quantity: 5, unitPrice: 10 }], supplierId, stockId);
  await db.collection(collections.stockOperations).updateOne(
    { _id: new (await import('mongodb')).ObjectId(opId) },
    { $set: { fromInvoice: true, pendingInvoiceLines: [{ invoiceName: 'Wkład do długopisu XYZ', quantity: 10, unitPrice: 2 }] } }
  );

  const r = await req(server, 'POST', `/warehouse/operations/${opId}/validate`, {});
  assert.equal(r.status, 400);
  assert.match(r.json.message, /nie dopasowano/i);
  assert.match(r.json.message, /Wkład do długopisu XYZ/);
});
