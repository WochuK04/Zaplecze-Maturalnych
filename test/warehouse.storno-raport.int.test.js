// Test integracyjny: storno nie udaje zwykłego ruchu w raporcie „Ruchy w okresie".
//
// Cofnięcie operacji dopisuje ruchy przeciwstawne (reverseOperation), żeby historia
// była niezmienna — ale te ruchy niosą `kind` ruchu odwracanego. Bez rozróżnienia
// raport liczył cofnięte przyjęcie jako DRUGIE przyjęcie, czyli podbijał licznik
// dokładnie tym, co anulowano. Izolowana baza, forge req.user (admin). Wymaga Mongo.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';

process.env.DB_NAME = 'maturalni_equipment_storno_test';

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
let server, db, stockId, supplierId, receiptId;

const liczbaRuchow = (rep, kind) => (rep.rows || []).filter(r => r.kind === kind).length;
const przyjeciaWgPodsumowania = (rep) =>
  ((rep.byKind || []).find(k => k.kind === 'receipt') || { moves: 0 }).moves;

test.before(async () => {
  db = getDb();
  await db.dropDatabase();
  const byCode = await seedStandardLocations(db);
  stockId = String(byCode.get('WH/Stock')._id);
  supplierId = String(byCode.get('VIRT/Suppliers')._id);

  await db.collection(collections.items).insertOne({
    itemCode: 'T100', name: 'Karton testowy', category: 'towar',
    quantity: 0, isActive: true, priceBatches: []
  });

  server = await startServer(admin);

  const reference = await nextReference(db, 'mag/IN');
  const { insertedId } = await db.collection(collections.stockOperations).insertOne({
    type: 'receipt', reference, state: 'draft',
    fromLocationId: supplierId, toLocationId: stockId,
    lines: [{ itemCode: 'T100', quantity: 100, unitPrice: 5 }],
    createdAt: new Date(), updatedAt: new Date()
  });
  receiptId = String(insertedId);
  const r = await req(server, 'POST', `/warehouse/operations/${receiptId}/validate`, {});
  assert.equal(r.status, 200, 'przyjęcie miało się zatwierdzić');
});

test.after(async () => {
  await db.dropDatabase();
  server?.close();
  await closeDb();
});

test('przed cofnięciem: jedno przyjęcie, zero storn', async () => {
  const { json: rep } = await req(server, 'GET', '/warehouse/moves-report');
  assert.equal(przyjeciaWgPodsumowania(rep), 1);
  assert.equal(rep.storno, 0);
  assert.equal((rep.rows || []).filter(r => r.isReversal).length, 0);
});

test('po cofnięciu licznik przyjęć NIE rośnie — storno to nie drugie przyjęcie', async () => {
  const r = await req(server, 'POST', `/warehouse/operations/${receiptId}/reverse`, {});
  assert.equal(r.status, 200);

  const { json: rep } = await req(server, 'GET', '/warehouse/moves-report');
  // Rdzeń regresji: bez filtra po isReversal było tu 2.
  assert.equal(przyjeciaWgPodsumowania(rep), 1, 'cofnięte przyjęcie nie może liczyć się dwa razy');
  assert.equal(rep.storno, 1, 'storno raportowane osobno');
});

test('wiersz storna jest w raporcie, oznaczony i w przeciwną stronę', async () => {
  const { json: rep } = await req(server, 'GET', '/warehouse/moves-report');
  const storna = (rep.rows || []).filter(r => r.isReversal);
  assert.equal(storna.length, 1, 'storno zostaje widoczne — historia jest niezmienna');
  assert.equal(storna[0].kind, 'receipt', 'storno niesie kind ruchu odwracanego');
  assert.equal(storna[0].quantity, 100);

  // Oba ruchy są w raporcie: pierwotny i jego storno.
  assert.equal(liczbaRuchow(rep, 'receipt'), 2, 'wierszy jest dwa, ale liczy się jeden ruch');
});

test('historia ruchów też oznacza storno', async () => {
  const { json: rows } = await req(server, 'GET', '/warehouse/moves?limit=50');
  const storna = rows.filter(m => m.isReversal);
  assert.equal(storna.length, 1);
  assert.equal(rows.filter(m => !m.isReversal).length, 1);
});

test('stan wraca do zera, bo storno znosi przyjęcie', async () => {
  const { json: stock } = await req(server, 'GET', '/warehouse/stock');
  assert.equal(stock.find(r => r.itemCode === 'T100'), undefined, 'zerowy stan znika ze stanu');
});
