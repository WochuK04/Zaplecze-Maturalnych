// Test integracyjny: formularz operacji musi umieć pokazać KAŻDĄ lokalizację, na której
// dokument potrafi stanąć. Inaczej select nie ma opcji odpowiadającej wartości dokumentu,
// przeglądarka zgłasza pierwszą z brzegu, a zapis nagłówka po cichu podmienia lokalizację.
//
// Tak właśnie ginęły dostawy: `VIRT/Customers` nie był na liście wyboru, więc otwarcie
// dostawy i kliknięcie „Zatwierdź" przestawiało ją z „Magazyn → Wydania / odbiorcy"
// na „Magazyn → Magazyn" i towar nigdy nie opuszczał magazynu.
//
// Izolowana baza, forge req.user (admin). Wymaga lokalnego Mongo.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';

process.env.DB_NAME = 'maturalni_equipment_formloc_test';

const { default: app } = await import('../src/index.js');
const { getDb, closeDb } = await import('../src/db.js');
const { collections } = await import('../src/schema.js');
const { seedStandardLocations, OPERATION_TYPES } = await import('../src/stock.js');

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

let server, db;

test('przygotowanie bazy', async () => {
  db = await getDb();
  for (const c of Object.values(collections)) await db.collection(c).deleteMany({});
  await seedStandardLocations(db);
  server = await startServer({ email: 'admin@maturalni.com', fullName: 'Admin', role: 'admin' });
});

test('formularz zna każdą domyślną lokalizację każdego typu operacji', async () => {
  const { status, json } = await req(server, 'GET', '/warehouse/form-data');
  assert.equal(status, 200);
  const kody = new Set(json.locations.map(l => l.code));

  const brakujace = [];
  for (const [typ, cfg] of Object.entries(OPERATION_TYPES)) {
    for (const kod of [cfg.defaultFrom, cfg.defaultTo]) {
      if (kod && !kody.has(kod)) brakujace.push(`${typ}: ${kod}`);
    }
  }
  assert.deepEqual(brakujace, [], `lokalizacje nieobecne na liście wyboru: ${brakujace.join(', ')}`);
});

test('cel dostawy (Wydania / odbiorcy) jest do wybrania w formularzu', async () => {
  const { json } = await req(server, 'GET', '/warehouse/form-data');
  const cel = json.locations.find(l => l.code === 'VIRT/Customers');
  assert.ok(cel, 'VIRT/Customers musi być na liście — to cel każdej dostawy');
  assert.equal(cel.kind, 'customer');
});

test('sprzątanie', async () => {
  await new Promise(r => server.close(r));
  await db.dropDatabase();
  await closeDb();
});
