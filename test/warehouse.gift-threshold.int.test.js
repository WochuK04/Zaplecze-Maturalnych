// Test integracyjny endpointu GET /warehouse/gift-threshold na izolowanej bazie.
// Wzorzec: forge `req.user`/`isAuthenticated` w nadrzędnym Express (OAuth jest
// headless), własna baza DB_NAME=…_test, dropDatabase po teście. Wymaga lokalnego
// Mongo (z .env). Uruchom: `node --test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';

// Izolowana baza — ustawiona PRZED importem app (dotenv nie nadpisuje istniejących).
process.env.DB_NAME = 'maturalni_equipment_giftvat_test';

const { default: app } = await import('../src/index.js');
const { getDb, closeDb } = await import('../src/db.js');
const { collections } = await import('../src/schema.js');

// Nadrzędny serwer: wstrzykuje zalogowanego admina, potem deleguje do `app`.
function startServer(user) {
  const parent = express();
  parent.use((req, _res, next) => {
    req.user = user;
    req.isAuthenticated = () => true;
    next();
  });
  parent.use(app);
  return new Promise(resolve => {
    const server = parent.listen(0, () => resolve(server));
  });
}

function get(server, path) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null }));
    }).on('error', reject);
  });
}

const admin = { email: 'admin@maturalni.com', fullName: 'Admin', role: 'admin' };
const conv = (qty, unitPrice) => ({ qty, unitPrice, note: `KONW/2026/0001 · konwersja z TOWA-1`, addedAt: new Date() });

let server;

test.before(async () => {
  const db = getDb();
  await db.collection(collections.items).deleteMany({});
  await db.collection(collections.items).insertMany([
    // Gadżet z konwersji 25 zł > 20 → ryzyko VAT.
    { itemCode: 'GADZ-RYZYKO', name: 'Smycz premium', category: 'gadżet', isActive: true, priceBatches: [conv(8, 25)] },
    // Gadżet z konwersji 12 zł ≤ 20 → ok.
    { itemCode: 'GADZ-OK', name: 'Długopis', category: 'gadżet', isActive: true, priceBatches: [conv(40, 12)] },
    // Pozycja spoza Magazynu (elektronika) z partią konwersyjną — endpoint ma ją odfiltrować.
    { itemCode: 'KAM-1', name: 'Kamera', category: 'Kamera', isActive: true, priceBatches: [conv(2, 500)] },
    // Nieaktywny gadżet > 20 → pomijany (isActive: false).
    { itemCode: 'GADZ-DEL', name: 'Stary gadżet', category: 'gadżet', isActive: false, priceBatches: [conv(3, 99)] }
  ]);
  server = await startServer(admin);
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  const db = getDb();
  await db.dropDatabase();
  await closeDb();
});

test('domyślny próg 20 zł zwraca tylko gadżet z konwersji powyżej progu', async () => {
  const { status, json } = await get(server, '/warehouse/gift-threshold');
  assert.equal(status, 200);
  assert.equal(json.threshold, 20);
  assert.equal(json.items.length, 1);
  assert.equal(json.items[0].itemCode, 'GADZ-RYZYKO');
  assert.equal(json.items[0].overQty, 8);
  assert.equal(json.items[0].overValue, 200);
  assert.equal(json.summary.riskItemCount, 1);
  assert.equal(json.summary.riskValue, 200);
  // Tylko aktywne gadżety magazynowe z partią konwersyjną: GADZ-RYZYKO + GADZ-OK.
  assert.equal(json.summary.conversionItemCount, 2);
});

test('wymaga autoryzacji odczytu (viewer z listy dostępu nie ma 403)', async () => {
  const viewerServer = await startServer({ email: 'v@maturalni.com', role: 'viewer', warehouseAccess: true });
  const { status } = await get(viewerServer, '/warehouse/gift-threshold');
  await new Promise(r => viewerServer.close(r));
  assert.equal(status, 200); // viewer ma requireWarehouseRead, a lista wpuszcza do modułu
});

test('konfigurowalny próg przez ?threshold=', async () => {
  const { json } = await get(server, '/warehouse/gift-threshold?threshold=500');
  // Przy progu 500 zł żaden gadżet (25, 12) nie przekracza; KAM-1=500 i tak poza Magazynem.
  assert.equal(json.threshold, 500);
  assert.equal(json.items.length, 0);

  const low = await get(server, '/warehouse/gift-threshold?threshold=10');
  assert.equal(low.json.threshold, 10);
  assert.equal(low.json.items.length, 2); // 25 i 12 oba > 10
});
