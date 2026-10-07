// Test integracyjny: przyjęcie z faktury ma ten sam numer i te same pola co ręczne.
//
// Import z faktury składał dokument osobno od „Nowa operacja" i numerował go
// `receipt/NNNNN` (własny licznik) zamiast `mag/IN/NNNNN`, a nazwy dostawcy nie
// zapisywał — lista i szczegóły pokazywały „—". Izolowana baza, forge req.user.
// Wymaga lokalnego Mongo.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';

process.env.DB_NAME = 'maturalni_equipment_frominvoice_test';

const { default: app } = await import('../src/index.js');
const { getDb, closeDb } = await import('../src/db.js');
const { collections } = await import('../src/schema.js');
const { seedStandardLocations } = await import('../src/stock.js');

function startServer(user) {
  const parent = express();
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
let server, db;

test.before(async () => {
  db = getDb();
  await db.dropDatabase();
  await seedStandardLocations(db);
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

test('przyjęcie z faktury dostaje numer mag/IN, wspólny licznik i nazwę dostawcy', async () => {
  const reczne = await req(server, 'POST', '/warehouse/operations', {
    type: 'receipt', lines: [{ itemCode: 'T500', quantity: 1 }]
  });
  assert.equal(reczne.status, 201);
  assert.match(reczne.json.reference, /^mag\/IN\/\d{5}$/);

  const z = await req(server, 'POST', '/warehouse/operations/from-invoice', {
    supplierName: 'Dostawca Testowy Sp. z o.o.',
    invoiceNumber: 'FS-1/26',
    lines: [{ itemCode: 'T500', invoiceName: 'Karton', quantity: 3, unitPrice: 4.5 }]
  });
  assert.equal(z.status, 201);
  assert.match(z.json.reference, /^mag\/IN\/\d{5}$/);
  assert.equal(
    Number(z.json.reference.split('/').pop()),
    Number(reczne.json.reference.split('/').pop()) + 1,
    'licznik jest wspólny z ręcznymi przyjęciami'
  );

  const op = await db.collection(collections.stockOperations).findOne({ reference: z.json.reference });
  assert.equal(op.type, 'receipt');
  assert.equal(op.state, 'draft');
  assert.equal(op.supplierName, 'Dostawca Testowy Sp. z o.o.');
  assert.equal(op.sourceDocument, 'FS-1/26');
  assert.deepEqual(op.lines, [{ itemCode: 'T500', quantity: 3, lot: null, unitPrice: 4.5 }]);

  const lista = await req(server, 'GET', '/warehouse/operations');
  const wiersz = lista.json.find(o => o.reference === z.json.reference);
  assert.equal(wiersz.supplierName, 'Dostawca Testowy Sp. z o.o.');
});

test('przyjęcie z faktury da się zatwierdzić i ma partię cenową', async () => {
  const z = await req(server, 'POST', '/warehouse/operations/from-invoice', {
    supplierName: 'Dostawca Testowy Sp. z o.o.',
    invoiceNumber: 'FS-2/26',
    lines: [{ itemCode: 'T500', invoiceName: 'Karton', quantity: 5, unitPrice: 2 }]
  });
  const v = await req(server, 'POST', `/warehouse/operations/${z.json.id}/validate`, {});
  assert.equal(v.status, 200);
  const item = await db.collection(collections.items).findOne({ itemCode: 'T500' });
  assert.ok((item.priceBatches || []).some(b => b.unitPrice === 2), 'partia cenowa z faktury');
});

test('po zatwierdzeniu i cofnięciu: nie da się odrzucić, da się anulować — stan wraca do zera', async () => {
  await db.collection(collections.items).insertOne({
    itemCode: 'T600', name: 'Taśma testowa', category: 'towar',
    quantity: 0, isActive: true, priceBatches: []
  });
  const z = await req(server, 'POST', '/warehouse/operations/from-invoice', {
    supplierName: 'Dostawca Testowy Sp. z o.o.',
    invoiceNumber: 'FS-3/26',
    lines: [{ itemCode: 'T600', invoiceName: 'Taśma', quantity: 7, unitPrice: 3 }]
  });
  assert.equal((await req(server, 'GET', `/warehouse/operations/${z.json.id}`)).json.hasMoves, false);

  assert.equal((await req(server, 'POST', `/warehouse/operations/${z.json.id}/validate`, {})).status, 200);
  assert.equal((await req(server, 'POST', `/warehouse/operations/${z.json.id}/reverse`, {})).status, 200);

  const detal = await req(server, 'GET', `/warehouse/operations/${z.json.id}`);
  assert.equal(detal.json.state, 'draft');
  assert.equal(detal.json.hasMoves, true, 'edytor ma pokazać „Anuluj dokument”, nie „Odrzuć”');

  const odrzuc = await req(server, 'DELETE', `/warehouse/operations/${z.json.id}`);
  assert.equal(odrzuc.status, 409);

  const anuluj = await req(server, 'POST', `/warehouse/operations/${z.json.id}/cancel`, {});
  assert.equal(anuluj.status, 200);
  const op = await db.collection(collections.stockOperations).findOne({ reference: z.json.reference });
  assert.equal(op.state, 'cancelled');
  const item = await db.collection(collections.items).findOne({ itemCode: 'T600' });
  assert.equal(item.quantity, 0);
  assert.deepEqual(item.priceBatches || [], []);
});

test('anulowanie dokumentu z ruchem bez storna jest blokowane', async () => {
  const z = await req(server, 'POST', '/warehouse/operations/from-invoice', {
    supplierName: 'Dostawca Testowy Sp. z o.o.',
    invoiceNumber: 'FS-4/26',
    lines: [{ itemCode: 'T500', invoiceName: 'Karton', quantity: 1, unitPrice: 1 }]
  });
  await db.collection(collections.stockMoves).insertOne({
    itemCode: 'T500', quantity: 1, kind: 'receipt', state: 'done',
    operationId: z.json.id, reversalOf: null, doneAt: new Date(), createdAt: new Date()
  });
  const r = await req(server, 'POST', `/warehouse/operations/${z.json.id}/cancel`, {});
  assert.equal(r.status, 409);
  const op = await db.collection(collections.stockOperations).findOne({ reference: z.json.reference });
  assert.equal(op.state, 'draft');
});
