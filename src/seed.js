import dotenv from 'dotenv';
import { connectToDatabase, closeDb } from './db.js';
import { collections, ensureIndexes } from './schema.js';
import { seedStandardLocations, applyMove, recomputeQuants, refreshItemCache } from './stock.js';

dotenv.config();

const now = new Date();

const users = [
  { email: 'admin@maturalni.com', fullName: 'Admin Maturalni', role: 'admin', isActive: true, createdAt: now },
  { email: 'daria.najberg@maturalni.com', fullName: 'Daria Najberg', role: 'user', isActive: true, createdAt: now },
  { email: 'sara.kosiarska@maturalni.com', fullName: 'Sara Kosiarska', role: 'user', isActive: true, createdAt: now }
];

const items = [
  {
    itemCode: 'L013',
    category: 'Lampy',
    name: 'Streamplify Light 10',
    details: '',
    quantity: 1,
    conditionStatus: 'very_good',
    operationalStatus: 'loaned',
    currentLocation: 'U pracownika',
    assignedToEmail: 'daria.najberg@maturalni.com',
    notes: '',
    isActive: true,
    createdAt: now,
    updatedAt: now
  },
  {
    itemCode: 'PC006',
    category: 'Laptop',
    name: 'Lenovo IdeaPad Slim 5',
    details: '',
    quantity: 1,
    conditionStatus: 'very_good',
    operationalStatus: 'loaned',
    currentLocation: 'U pracownika',
    assignedToEmail: 'sara.kosiarska@maturalni.com',
    notes: '',
    isActive: true,
    createdAt: now,
    updatedAt: now
  },
  {
    itemCode: 'M006',
    category: 'Monitory',
    name: 'Aputure V',
    details: 'Monitorek podglądowy',
    quantity: 1,
    conditionStatus: 'very_good',
    operationalStatus: 'available',
    currentLocation: 'Magazyn',
    assignedToEmail: null,
    notes: '',
    isActive: true,
    createdAt: now,
    updatedAt: now
  }
];

const loans = [
  {
    itemCode: 'L013',
    userEmail: 'daria.najberg@maturalni.com',
    quantity: 1,
    fromLocation: 'Magazyn',
    targetUseLocation: 'Dom',
    status: 'active',
    borrowedAt: now,
    dueAt: null,
    returnedAt: null,
    borrowNote: 'Wypożyczenie testowe',
    returnNote: null,
    createdByEmail: 'admin@maturalni.com',
    closedByEmail: null
  },
  {
    itemCode: 'PC006',
    userEmail: 'sara.kosiarska@maturalni.com',
    quantity: 1,
    fromLocation: 'Biuro',
    targetUseLocation: 'Biuro',
    status: 'active',
    borrowedAt: now,
    dueAt: null,
    returnedAt: null,
    borrowNote: 'Laptop przypisany do pracy',
    returnNote: null,
    createdByEmail: 'admin@maturalni.com',
    closedByEmail: null
  }
];

const auditLogs = [
  {
    actorEmail: 'admin@maturalni.com',
    actionType: 'loan_created',
    entityType: 'loan',
    entityId: 'L013',
    payload: { itemCode: 'L013', userEmail: 'daria.najberg@maturalni.com' },
    createdAt: now
  },
  {
    actorEmail: 'admin@maturalni.com',
    actionType: 'loan_created',
    entityType: 'loan',
    entityId: 'PC006',
    payload: { itemCode: 'PC006', userEmail: 'sara.kosiarska@maturalni.com' },
    createdAt: now
  }
];

async function run() {
  const db = await connectToDatabase();
  await ensureIndexes(db);

  await db.collection(collections.locations).deleteMany({});
  await db.collection(collections.users).deleteMany({});
  await db.collection(collections.items).deleteMany({});
  await db.collection(collections.loans).deleteMany({});
  await db.collection(collections.auditLogs).deleteMany({});
  await db.collection(collections.stockMoves).deleteMany({});
  await db.collection(collections.quants).deleteMany({});
  await db.collection(collections.warehouses).deleteMany({});
  await db.collection(collections.reorderRules).deleteMany({});

  // Drzewo lokalizacji „w stylu Odoo" (realne + wirtualne) zamiast płaskiej listy.
  const byCode = await seedStandardLocations(db);
  const byName = new Map();
  for (const loc of byCode.values()) byName.set(loc.name, loc);
  const inventoryLoc = byCode.get('VIRT/Inventory');

  await db.collection(collections.users).insertMany(users);
  await db.collection(collections.items).insertMany(items);
  await db.collection(collections.loans).insertMany(loans);
  await db.collection(collections.auditLogs).insertMany(auditLogs);

  // Stan otwarcia: ruch z wirtualnej „Korekta stanu" do bieżącej lokalizacji sprzętu.
  for (const it of items) {
    const loc = byName.get(it.currentLocation) || byName.get('Magazyn');
    await applyMove(db, {
      itemCode: it.itemCode,
      fromLocationId: String(inventoryLoc._id),
      toLocationId: String(loc._id),
      quantity: Number(it.quantity ?? 1) || 1,
      kind: 'opening',
      actorEmail: 'seed',
      note: 'Stan otwarcia (seed)'
    });
  }
  await recomputeQuants(db);
  for (const it of items) await refreshItemCache(db, it.itemCode);

  // Przykładowe reguły min-max (Zapotrzebowanie). Stan dostępny liczy się
  // tylko z lokalizacji „Magazyn" (internal), więc M006 (Magazyn) = 1 szt.,
  // a Lampy/Laptop są u pracowników → 0 dostępnych.
  await db.collection(collections.reorderRules).insertMany([
    { scope: 'category', target: 'Monitory', minQty: 3, maxQty: 6, note: 'Trzon zestawu podglądowego', isActive: true, createdByEmail: 'seed', createdAt: now, updatedAt: now },
    { scope: 'category', target: 'Lampy', minQty: 2, maxQty: 4, note: '', isActive: true, createdByEmail: 'seed', createdAt: now, updatedAt: now },
    { scope: 'item', target: 'M006', minQty: 1, maxQty: 2, note: '', isActive: true, createdByEmail: 'seed', createdAt: now, updatedAt: now }
  ]);

  console.log('Seed OK');
  await closeDb();
}

run().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});