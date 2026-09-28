// Test integracyjny autoryzacji: /me (401 vs zalogowany), bramki ról
// (requireAdmin / requireWarehouseRead → 403 dla złej roli) i zapis preferencji.
// Izolowana baza, forge req.user, dropDatabase. Uruchom: `node --test --test-force-exit`.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';

process.env.DB_NAME = 'maturalni_equipment_auth_test';

const { default: app } = await import('../src/index.js');
const { getDb, closeDb } = await import('../src/db.js');
const { collections } = await import('../src/schema.js');

// user=null → niezalogowany (isAuthenticated()=false, brak req.user).
function startServer(user) {
  const parent = express();
  parent.use(express.json());
  parent.use((req, _res, next) => {
    req.isAuthenticated = () => Boolean(user);
    if (user) req.user = user;
    next();
  });
  parent.use(app);
  return new Promise(resolve => { const s = parent.listen(0, () => resolve(s)); });
}
function call(server, method, path, body) {
  const { port } = server.address();
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port, path, method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}
    }, res => {
      let b = ''; res.on('data', c => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const admin = { email: 'admin@maturalni.com', fullName: 'Admin', role: 'admin' };
// Rola daje wgląd, ale do modułu wpuszcza dopiero imienna lista (warehouseAccess).
const viewer = { email: 'viewer@maturalni.com', fullName: 'Widz', role: 'viewer', warehouseAccess: true };
const viewerBezListy = { email: 'widz2@maturalni.com', fullName: 'Widz bez listy', role: 'viewer' };
const plainUser = { email: 'user@maturalni.com', fullName: 'Zwykły', role: 'user' };

let db;

test.before(async () => {
  db = getDb();
  await db.dropDatabase();
  await db.collection(collections.users).insertOne({ ...plainUser, isActive: true, preferences: {} });
});
test.after(async () => { await db.dropDatabase(); await closeDb(); });

test('/me bez logowania → 401', async () => {
  const s = await startServer(null);
  const res = await call(s, 'GET', '/me');
  s.close();
  assert.equal(res.status, 401);
  assert.equal(res.json.authenticated, false);
});

test('/me zalogowany → 200 z danymi użytkownika', async () => {
  const s = await startServer(admin);
  const res = await call(s, 'GET', '/me');
  s.close();
  assert.equal(res.status, 200);
  assert.equal(res.json.authenticated, true);
  assert.equal(res.json.user.email, admin.email);
  assert.equal(res.json.user.role, 'admin');
  assert.ok(res.json.user.preferences, 'preferencje w odpowiedzi');
});

test('requireAdmin: zwykły user → 403, admin → 200', async () => {
  const asUser = await startServer(plainUser);
  const denied = await call(asUser, 'GET', '/admin/users');
  asUser.close();
  assert.equal(denied.status, 403);

  const asAdmin = await startServer(admin);
  const ok = await call(asAdmin, 'GET', '/admin/users');
  asAdmin.close();
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.json));
});

test('Magazyn: user → 403, viewer z listy → 200, viewer bez listy → 403', async () => {
  const asUser = await startServer(plainUser);
  const denied = await call(asUser, 'GET', '/warehouse/valuation');
  asUser.close();
  assert.equal(denied.status, 403);

  const asViewer = await startServer(viewer);
  const ok = await call(asViewer, 'GET', '/warehouse/valuation');
  asViewer.close();
  assert.equal(ok.status, 200);

  // Sama rola już nie wystarcza — moduł chodzi po imiennej liście dostępu.
  const asViewerBez = await startServer(viewerBezListy);
  const bezListy = await call(asViewerBez, 'GET', '/warehouse/valuation');
  asViewerBez.close();
  assert.equal(bezListy.status, 403);
});

test('PUT /me/preferences zapisuje motyw do dokumentu użytkownika', async () => {
  const s = await startServer(plainUser);
  const res = await call(s, 'PUT', '/me/preferences', { theme: 'dark' });
  s.close();
  assert.equal(res.status, 200);
  const doc = await db.collection(collections.users).findOne({ email: plainUser.email });
  assert.equal(doc.preferences.theme, 'dark');
});
