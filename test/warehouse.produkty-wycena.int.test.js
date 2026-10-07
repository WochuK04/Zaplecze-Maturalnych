// Test integracyjny: GET /warehouse/products liczy wartość i cenę jednostkową.
//
// Zgłoszenie z eksportu: w kolumnie „Wartość" pojawiały się liczby w rodzaju
// 1579.3999999999999 i 5997.049999999999 — artefakt sumowania iloczynów
// zmiennoprzecinkowych, który szedł z API wprost do CSV. Pieniądze mają wychodzić
// w groszach. Przy okazji sprawdzamy, że sama arytmetyka jest poprawna.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';

process.env.DB_NAME = 'maturalni_equipment_wycena_test';

const { default: app } = await import('../src/index.js');
const { getDb, closeDb } = await import('../src/db.js');
const { collections } = await import('../src/schema.js');

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
      let out = '';
      res.on('data', c => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, json: out ? JSON.parse(out) : null }));
    });
    r.on('error', reject);
    r.end();
  });
}

const admin = { email: 'admin@maturalni.com', fullName: 'Admin', role: 'admin' };
let server, db;
const wg = (lista, kod) => lista.find(p => p.itemCode === kod);

test.before(async () => {
  db = getDb();
  await db.dropDatabase();
  await db.collection(collections.items).insertMany([
    // Realny przypadek z eksportu: 596 × 2.65 daje 1579.3999999999999 bez zaokrąglenia.
    { itemCode: 'TOWA-FLOAT', name: 'Długopis mat', category: 'towar', unit: 'szt.',
      quantity: 596, isActive: true, priceBatches: [{ qty: 596, unitPrice: 2.65 }] },
    // Dwie transze o różnych cenach — cena jednostkowa musi być ŚREDNIĄ WAŻONĄ.
    { itemCode: 'GADZ-DWIE', name: 'Smyczki E8', category: 'gadżet', unit: 'szt.',
      quantity: 450, isActive: true,
      priceBatches: [{ qty: 228, unitPrice: 1.68 }, { qty: 222, unitPrice: 1.82 }] },
    // Stan bez kosztu — znana luka w danych Odoo. Ma dać 0, a nie wywrócić wyliczenia.
    { itemCode: 'GADZ-BEZCENY', name: 'Teczki Ti', category: 'gadżet', unit: 'szt.',
      quantity: 421, isActive: true, priceBatches: [] },
    // Kilogramy: ilość ułamkowa nie może psuć ceny jednostkowej.
    { itemCode: 'TOWA-KG', name: 'Krówki E8', category: 'towar', unit: 'kg',
      quantity: 9.5, isActive: true, priceBatches: [{ qty: 9.5, unitPrice: 35.7 }] },
    // Nie-magazynowa: nie ma prawa pojawić się w tym widoku.
    { itemCode: 'KAM-1', name: 'Kamera', category: 'Kamery', quantity: 1, isActive: true }
  ]);
  server = await startServer(admin);
});

test.after(async () => {
  await db.dropDatabase();
  server?.close();
  await closeDb();
});

test('wartość nie niesie ogona zmiennoprzecinkowego', async () => {
  const { json } = await req(server, 'GET', '/warehouse/products');
  const p = wg(json, 'TOWA-FLOAT');
  assert.equal(p.totalValue, 1579.4);
  // Rdzeń regresji: 596 * 2.65 === 1579.3999999999999 w surowej arytmetyce.
  assert.notEqual(596 * 2.65, 1579.4);
  assert.ok(String(p.totalValue).split('.')[1].length <= 2);
});

test('cena jednostkowa przy jednej partii to po prostu cena zakupu', async () => {
  const { json } = await req(server, 'GET', '/warehouse/products');
  assert.equal(wg(json, 'TOWA-FLOAT').avgUnitPrice, 2.65);
});

test('przy dwóch partiach cena jednostkowa to średnia WAŻONA, nie arytmetyczna', async () => {
  const { json } = await req(server, 'GET', '/warehouse/products');
  const p = wg(json, 'GADZ-DWIE');
  assert.equal(p.quantity, 450);
  assert.equal(p.totalValue, 787.08);           // 228×1,68 + 222×1,82
  assert.equal(p.avgUnitPrice, 1.75);           // 787,08 / 450
  assert.equal(typeof p.avgUnitPrice, 'number', 'liczba, nie sformatowany tekst');
  // UWAGA: przy kilku partiach cena × ilość NIE odtworzy wartości co do grosza
  // (1,75 × 450 = 787,50, a wartość to 787,08). Średnia zaokrąglona do groszy nie
  // może tego zrobić i nie jest to błąd — autorytatywna jest WARTOŚĆ, liczona
  // z partii. Pilnujemy więc tylko, że średnia nie odjeżdża: mieści się między
  // najtańszą a najdroższą transzą i odtwarza wartość z dokładnością do grosza
  // na sztuce.
  assert.ok(p.avgUnitPrice >= 1.68 && p.avgUnitPrice <= 1.82);
  assert.ok(Math.abs(p.avgUnitPrice * p.quantity - p.totalValue) <= 0.01 * p.quantity);
  assert.equal(p.batchCount, 2, 'odbiorca musi wiedzieć, że to średnia z dwóch transz');
});

test('pozycja bez partii: wartość i cena zero, ale ilość zachowana', async () => {
  const { json } = await req(server, 'GET', '/warehouse/products');
  const p = wg(json, 'GADZ-BEZCENY');
  assert.equal(p.quantity, 421);
  assert.equal(p.totalValue, 0);
  assert.equal(p.avgUnitPrice, 0);
  assert.equal(p.batchCount, 0);
});

test('ilość ułamkowa (kilogramy) nie psuje ceny jednostkowej', async () => {
  const { json } = await req(server, 'GET', '/warehouse/products');
  const p = wg(json, 'TOWA-KG');
  assert.equal(p.quantity, 9.5);
  assert.equal(p.unit, 'kg');
  assert.equal(p.totalValue, 339.15);           // 9,5 × 35,70
  assert.equal(p.avgUnitPrice, 35.7);
});

test('suma wartości wszystkich pozycji też jest w groszach', async () => {
  const { json } = await req(server, 'GET', '/warehouse/products');
  const suma = json.reduce((s, p) => s + p.totalValue, 0);
  assert.equal(Math.round(suma * 100) / 100, suma);
});

test('widok obejmuje wyłącznie kategorie magazynowe', async () => {
  const { json } = await req(server, 'GET', '/warehouse/products');
  assert.equal(wg(json, 'KAM-1'), undefined);
  assert.equal(json.length, 4);
});
