// Test integracyjny: imienna lista dostępu do Magazynu.
// Rola mówi, CO wolno w środku modułu; flaga `warehouseAccess` — KTO w ogóle
// wchodzi. Domyślnie nikt: pole nieustawione znaczy brak dostępu. Admin wchodzi
// zawsze, żeby nie dało się zamknąć modułu dla całej firmy.
// Izolowana baza, forge req.user. Wymaga lokalnego Mongo.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';

process.env.DB_NAME = 'maturalni_equipment_whaccess_test';

const { default: app } = await import('../src/index.js');
const { getDb, closeDb } = await import('../src/db.js');
const { collections } = await import('../src/schema.js');
const { seedStandardLocations } = await import('../src/stock.js');

// Serwer czyta użytkownika z `biezacy`, więc jeden serwer obsłuży wszystkie role.
let biezacy = null;

function startServer() {
  const parent = express();
  parent.use(express.json());
  parent.use((req, _res, next) => { req.user = biezacy; req.isAuthenticated = () => !!biezacy; next(); });
  parent.use(app);
  return new Promise(resolve => { const s = parent.listen(0, () => resolve(s)); });
}

function req(server, method, path, body) {
  const { port } = server.address();
  const payload = body ? JSON.stringify(body) : null;
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
const bezDostepu = { email: 'nowy@maturalni.com', fullName: 'Nowy', role: 'viewer' };
const zDostepem = { email: 'magazyn@maturalni.com', fullName: 'Magazynier', role: 'viewer', warehouseAccess: true };
const jawnieOdciety = { email: 'odciety@maturalni.com', fullName: 'Odcięty', role: 'manager', warehouseAccess: false };

let server, db;

test.before(async () => {
  db = getDb();
  await db.dropDatabase();
  await seedStandardLocations(db);
  await db.collection(collections.users).insertMany([admin, bezDostepu, zDostepem, jawnieOdciety]);
  server = await startServer();
});

test.after(async () => {
  if (server) server.close();
  await db.dropDatabase();
  await closeDb();
});

test('bez flagi nie ma Magazynu, choć rola na to pozwala', async () => {
  biezacy = bezDostepu;
  const r = await req(server, 'GET', '/warehouse/stock');
  assert.equal(r.status, 403);
  assert.match(r.json.message, /Brak dostępu do Magazynu/);
});

test('flaga otwiera moduł', async () => {
  biezacy = zDostepem;
  const r = await req(server, 'GET', '/warehouse/stock');
  assert.equal(r.status, 200);
});

test('jawne odcięcie działa nawet dla kierownika', async () => {
  biezacy = jawnieOdciety;
  const r = await req(server, 'GET', '/warehouse/stock');
  assert.equal(r.status, 403);
});

test('admin wchodzi bez flagi — modułu nie da się zamknąć dla wszystkich', async () => {
  biezacy = admin;
  const r = await req(server, 'GET', '/warehouse/stock');
  assert.equal(r.status, 200);
});

test('bramka obejmuje Wyjazdy, które ruszają stanem magazynu', async () => {
  biezacy = bezDostepu;
  assert.equal((await req(server, 'GET', '/tw')).status, 403);
  assert.equal((await req(server, 'GET', '/packing-products')).status, 403);

  biezacy = zDostepem;
  assert.equal((await req(server, 'GET', '/tw')).status, 200);
});

test('bramka obejmuje też trasy zapisu, nie tylko odczyt', async () => {
  biezacy = bezDostepu;
  const r = await req(server, 'POST', '/warehouse/operations', { type: 'receipt', lines: [] });
  assert.equal(r.status, 403);
  assert.match(r.json.message, /Brak dostępu do Magazynu/);
});

test('/me niesie flagę, żeby interfejs nie powielał reguły', async () => {
  biezacy = bezDostepu;
  assert.equal((await req(server, 'GET', '/me')).json.user.warehouseAccess, false);
  biezacy = zDostepem;
  assert.equal((await req(server, 'GET', '/me')).json.user.warehouseAccess, true);
  biezacy = admin;
  assert.equal((await req(server, 'GET', '/me')).json.user.warehouseAccess, true);
});

test('admin nadaje i odbiera dostęp z panelu', async () => {
  biezacy = admin;
  const nadanie = await req(server, 'PATCH', '/admin/users/nowy@maturalni.com', { warehouseAccess: true });
  assert.equal(nadanie.status, 200);

  biezacy = { ...bezDostepu, warehouseAccess: true };
  assert.equal((await req(server, 'GET', '/warehouse/stock')).status, 200);

  biezacy = admin;
  await req(server, 'PATCH', '/admin/users/nowy@maturalni.com', { warehouseAccess: false });
  const po = await db.collection(collections.users).findOne({ email: 'nowy@maturalni.com' });
  assert.equal(po.warehouseAccess, false);
});

test('adminowi flagi się nie ustawia — ma moduł z urzędu', async () => {
  biezacy = admin;
  const r = await req(server, 'PATCH', '/admin/users/admin@maturalni.com', { warehouseAccess: false });
  assert.equal(r.status, 400);
  assert.match(r.json.message, /z urzędu/);

  const po = await db.collection(collections.users).findOne({ email: 'admin@maturalni.com' });
  assert.notEqual(po.warehouseAccess, false);
});

test('lista w panelu pokazuje admina jako zaznaczonego i zablokowanego', async () => {
  biezacy = admin;
  const { json } = await req(server, 'GET', '/admin/users');
  const a = json.find(u => u.email === 'admin@maturalni.com');
  const m = json.find(u => u.email === 'magazyn@maturalni.com');
  assert.deepEqual([a.warehouseAccess, a.warehouseAccessLocked], [true, true]);
  assert.deepEqual([m.warehouseAccess, m.warehouseAccessLocked], [true, false]);
});

test('niezalogowany nie przechodzi bramki', async () => {
  biezacy = null;
  const r = await req(server, 'GET', '/warehouse/stock');
  assert.equal(r.status, 401);
});
