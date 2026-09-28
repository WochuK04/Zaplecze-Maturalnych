// Magazyn „w stylu Odoo" – warstwa logiki stanu (Faza 0).
//
// Zasada jak w Odoo: STANU SIĘ NIE USTAWIA. Stan to suma niezmiennych ruchów.
// Każdy ruch (`stockMoves`) idzie z lokalizacji źródłowej do docelowej.
// `quants` to zmaterializowany stan na (towar, lokalizacja, partia) – zawsze
// dający się odtworzyć z rejestru przez `recomputeQuants`.
//
// Wszystkie funkcje przyjmują `db` jako argument, więc działają tak samo
// z serwera (getDb) jak i ze skryptów (własny MongoClient).

import { ObjectId } from 'mongodb';
import { collections } from './schema.js';

// Rodzaje lokalizacji (semantyka Odoo). Trzymamy w polu `kind`, żeby nie kolidować
// z istniejącym, nieużywanym polem `type` na starych dokumentach lokalizacji.
export const LOCATION_KINDS = {
  VIEW: 'view',           // węzeł grupujący, nie trzyma stanu
  INTERNAL: 'internal',   // realny magazyn (Magazyn, Studio, Biuro, Serwis…)
  EMPLOYEE: 'employee',   // „u pracownika" – sprzęt wydany, wciąż nasz
  INVENTORY: 'inventory', // wirtualna: korekty / stan otwarcia (źródło-ujście)
  SCRAP: 'scrap',         // wirtualna: złom / wybrakowane
  SUPPLIER: 'supplier',   // wirtualna: przyjęcia od dostawców
  TRANSIT: 'transit',     // wirtualna: tranzyt między lokalizacjami
  CONVERSION: 'conversion', // wirtualna: przetworzenie towar→gadżet (przeklasyfikowanie)
  CUSTOMER: 'customer'    // wirtualna: wydania na zewnątrz (dostawy do odbiorców)
};

// Lokalizacje, na których liczymy realny „stan posiadania".
// Wirtualne (inventory/scrap/supplier/transit) są źródłami/ujściami i mogą schodzić poniżej zera.
export function isStockableKind(kind) {
  return kind === LOCATION_KINDS.INTERNAL || kind === LOCATION_KINDS.EMPLOYEE;
}

export function isVirtualKind(kind) {
  return (
    kind === LOCATION_KINDS.INVENTORY ||
    kind === LOCATION_KINDS.SCRAP ||
    kind === LOCATION_KINDS.SUPPLIER ||
    kind === LOCATION_KINDS.TRANSIT ||
    kind === LOCATION_KINDS.CONVERSION ||
    kind === LOCATION_KINDS.CUSTOMER
  );
}

// Standardowe drzewo lokalizacji. WAŻNE: nazwy realnych lokalizacji muszą zostać
// zgodne z tym, czego używa istniejąca apka (items.currentLocation: „Magazyn"
// itd.), więc dopasowujemy je po `matchName` do już istniejących dokumentów.
export const STANDARD_LOCATIONS = [
  { code: 'WH', name: 'Magazyn główny', kind: LOCATION_KINDS.VIEW, parentCode: null, matchName: null },
  { code: 'WH/Stock', name: 'Magazyn', kind: LOCATION_KINDS.INTERNAL, parentCode: 'WH', matchName: 'Magazyn' },
  { code: 'WH/Studio', name: 'Studio', kind: LOCATION_KINDS.INTERNAL, parentCode: 'WH', matchName: 'Studio' },
  { code: 'WH/Biuro', name: 'Biuro', kind: LOCATION_KINDS.INTERNAL, parentCode: 'WH', matchName: 'Biuro' },
  { code: 'WH/Serwis', name: 'Serwis', kind: LOCATION_KINDS.INTERNAL, parentCode: 'WH', matchName: 'Serwis' },
  { code: 'WH/Employees', name: 'U pracownika', kind: LOCATION_KINDS.EMPLOYEE, parentCode: 'WH', matchName: 'U pracownika' },

  { code: 'VIRT', name: 'Lokalizacje wirtualne', kind: LOCATION_KINDS.VIEW, parentCode: null, matchName: null },
  { code: 'VIRT/Inventory', name: 'Korekta stanu (wirtualna)', kind: LOCATION_KINDS.INVENTORY, parentCode: 'VIRT', matchName: null },
  { code: 'VIRT/Scrap', name: 'Złom / wybrakowane', kind: LOCATION_KINDS.SCRAP, parentCode: 'VIRT', matchName: null },
  { code: 'VIRT/Suppliers', name: 'Dostawcy (przyjęcia)', kind: LOCATION_KINDS.SUPPLIER, parentCode: 'VIRT', matchName: null },
  { code: 'VIRT/Conversion', name: 'Przetworzenie (konwersja)', kind: LOCATION_KINDS.CONVERSION, parentCode: 'VIRT', matchName: null },
  { code: 'VIRT/Customers', name: 'Wydania / odbiorcy', kind: LOCATION_KINDS.CUSTOMER, parentCode: 'VIRT', matchName: null }
];

// Zbiór kodów standardowego drzewa — do ochrony przed edycją/usunięciem z UI.
const STANDARD_LOCATION_CODES = new Set(STANDARD_LOCATIONS.map(l => l.code));

// Lokalizacja „systemowa": standardowe drzewo (po kodzie) albo wirtualna/grupująca.
// Logika stanu trzyma się ich kodów (WH/Stock, VIRT/*), więc CRUD z UI ich nie tyka —
// edytować/usuwać można tylko własne fizyczne (internal/employee bez kodu standardowego).
export function isProtectedLocation(loc) {
  if (!loc) return true;
  if (loc.code && STANDARD_LOCATION_CODES.has(loc.code)) return true;
  if (loc.kind === LOCATION_KINDS.VIEW) return true;
  return isVirtualKind(loc.kind);
}

// Kod lokalizacji z nazwy (bez polskich znaków/spacji) — sufiks pod kodem rodzica.
// NFD rozkłada „ż"→„z"+znak łączący; filtr [^A-Za-z0-9] usuwa łączące i separatory.
export function slugifyLocationCode(name) {
  const slug = String(name || '')
    .normalize('NFD')
    .replace(/[^A-Za-z0-9]+/g, '')
    .slice(0, 24);
  return slug || 'Loc';
}

function toObjectIdOrNull(value) {
  try {
    return new ObjectId(String(value));
  } catch {
    return null;
  }
}

function quantKey(itemCode, locationId, lot) {
  return JSON.stringify([itemCode, locationId, lot == null ? null : String(lot)]);
}

function normalizeLot(lot) {
  return lot != null && lot !== '' ? String(lot) : null;
}

// Tworzy/uzupełnia standardowe drzewo lokalizacji. Idempotentne.
// Zwraca Mapę code -> dokument lokalizacji (ze świeżym _id).
export async function seedStandardLocations(db) {
  const col = db.collection(collections.locations);
  const byCode = new Map();

  for (const def of STANDARD_LOCATIONS) {
    const parent = def.parentCode ? byCode.get(def.parentCode) : null;
    const parentId = parent ? String(parent._id) : null;
    const ancestors = parent ? [...(parent.ancestors || []), parent.code] : [];

    const matchFilter = def.matchName
      ? { $or: [{ code: def.code }, { name: def.matchName }] }
      : { code: def.code };

    await col.updateOne(
      matchFilter,
      {
        $set: {
          code: def.code,
          name: def.name,
          kind: def.kind,
          parentId,
          ancestors,
          isActive: true,
          updatedAt: new Date()
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );

    const saved = await col.findOne({ code: def.code });
    byCode.set(def.code, saved);
  }

  return byCode;
}

// Atomowa zmiana stanu na jednej lokalizacji (upsert + $inc). Bez transakcji,
// więc działa tak samo na standalone Mongo (lokalnie) i na replica secie (Atlas).
async function adjustQuant(db, itemCode, locationId, lot, delta) {
  await db.collection(collections.quants).updateOne(
    { itemCode, locationId, lot },
    {
      $inc: { quantity: delta },
      $setOnInsert: { reservedQty: 0 },
      $set: { updatedAt: new Date() }
    },
    { upsert: true }
  );
}

// Zapisuje pojedynczy ruch (append-only) i aktualizuje stan na obu końcach.
// Kolejność: najpierw nieusuwalny wpis do rejestru, potem $inc na quant –
// jeśli proces padnie pomiędzy, `recomputeQuants` odtworzy prawdę z rejestru.
export async function applyMove(db, move) {
  const itemCode = String(move.itemCode || '').trim();
  if (!itemCode) throw new Error('applyMove: brak itemCode');

  const quantity = Number(move.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('applyMove: quantity musi być liczbą > 0');
  }

  const fromLocationId = move.fromLocationId ? String(move.fromLocationId) : null;
  const toLocationId = move.toLocationId ? String(move.toLocationId) : null;
  if (!fromLocationId && !toLocationId) {
    throw new Error('applyMove: ruch musi mieć źródło lub cel');
  }
  if (fromLocationId && toLocationId && fromLocationId === toLocationId) {
    throw new Error('applyMove: źródło i cel nie mogą być takie same');
  }

  const lot = normalizeLot(move.lot);
  const doneAt = move.doneAt instanceof Date ? move.doneAt : new Date();

  const moveDoc = {
    itemCode,
    fromLocationId,
    toLocationId,
    quantity,
    lot,
    kind: move.kind || 'internal',
    state: 'done',
    operationId: move.operationId ? String(move.operationId) : null,
    actorEmail: move.actorEmail || null,
    note: String(move.note || ''),
    doneAt,
    createdAt: new Date()
  };

  const { insertedId } = await db.collection(collections.stockMoves).insertOne(moveDoc);

  if (fromLocationId) await adjustQuant(db, itemCode, fromLocationId, lot, -quantity);
  if (toLocationId) await adjustQuant(db, itemCode, toLocationId, lot, quantity);

  return { ...moveDoc, _id: insertedId };
}

// Odtwarza `quants` z rejestru ruchów. Dla pojedynczego towaru lub całości.
// To „źródło prawdy ostatniej instancji" – po migracji/awarii zawsze zgadza się z ruchami.
export async function recomputeQuants(db, itemCode = null) {
  const filter = itemCode ? { itemCode: String(itemCode) } : {};
  const acc = new Map();
  const affected = new Set();

  const cursor = db.collection(collections.stockMoves).find(filter);
  for await (const m of cursor) {
    affected.add(m.itemCode);
    const lot = m.lot ?? null;
    const qty = Number(m.quantity) || 0;

    if (m.fromLocationId) {
      const k = quantKey(m.itemCode, m.fromLocationId, lot);
      const prev = acc.get(k);
      if (prev) prev.quantity -= qty;
      else acc.set(k, { itemCode: m.itemCode, locationId: m.fromLocationId, lot, quantity: -qty });
    }
    if (m.toLocationId) {
      const k = quantKey(m.itemCode, m.toLocationId, lot);
      const prev = acc.get(k);
      if (prev) prev.quantity += qty;
      else acc.set(k, { itemCode: m.itemCode, locationId: m.toLocationId, lot, quantity: qty });
    }
  }

  const codes = itemCode ? [String(itemCode)] : [...affected];
  if (codes.length) {
    await db.collection(collections.quants).deleteMany({ itemCode: { $in: codes } });
  }

  const now = new Date();
  const docs = [...acc.values()]
    .filter(d => d.quantity !== 0)
    .map(d => ({ ...d, reservedQty: 0, updatedAt: now }));

  if (docs.length) {
    await db.collection(collections.quants).insertMany(docs);
  }

  return { items: codes.length, quants: docs.length };
}

// Synchronizuje pola-cache na `items` (currentLocation, quantity) ze stanem z `quants`,
// licząc tylko lokalizacje realne (internal/employee). Nie dotyka operationalStatus/
// assignedToEmail – te zostają w gestii dotychczasowych przepływów (do Fazy 2).
export async function refreshItemCache(db, itemCode) {
  const code = String(itemCode);
  const quants = await db.collection(collections.quants).find({ itemCode: code }).toArray();
  if (!quants.length) return null;

  const locIds = [...new Set(quants.map(q => q.locationId))]
    .map(toObjectIdOrNull)
    .filter(Boolean);
  const locs = await db.collection(collections.locations).find({ _id: { $in: locIds } }).toArray();
  const locById = new Map(locs.map(l => [String(l._id), l]));

  let total = 0;
  let best = null;
  for (const q of quants) {
    const loc = locById.get(q.locationId);
    if (!loc || !isStockableKind(loc.kind)) continue;
    total += q.quantity;
    if (!best || q.quantity > best.qty) best = { qty: q.quantity, name: loc.name };
  }

  const update = { quantity: total, updatedAt: new Date() };
  if (best) update.currentLocation = best.name;
  await db.collection(collections.items).updateOne({ itemCode: code }, { $set: update });
  return update;
}

// Kaskadowa zmiana itemCode we wszystkich kolekcjach, które trzymają go jako klucz
// obcy: stan (quants), ruchy, wypożyczenia, wnioski, loty, reguły min-max oraz
// dokumenty operacji — pozycje (itemCode i targetItemCode konwersji) i snapshoty do
// cofania (conversionDetail: sourceCode/targetCode, deliveryDetail/scrapDetail/
// adjustmentDetail: itemCode).
// Logi audytu zostają z historycznym kodem (zapis zdarzenia, nie stan bieżący).
// Nie zmienia samego dokumentu `items` — to robi wołający (przed kaskadą).
export async function cascadeItemCodeRename(db, oldCode, newCode) {
  const o = String(oldCode), n = String(newCode);
  if (!o || !n || o === n) return;
  await db.collection(collections.quants).updateMany({ itemCode: o }, { $set: { itemCode: n } });
  await db.collection(collections.stockMoves).updateMany({ itemCode: o }, { $set: { itemCode: n } });
  await db.collection(collections.loans).updateMany({ itemCode: o }, { $set: { itemCode: n } });
  await db.collection(collections.loanRequests).updateMany({ itemCode: o }, { $set: { itemCode: n } });
  await db.collection(collections.lots).updateMany({ itemCode: o }, { $set: { itemCode: n } });
  await db.collection(collections.reorderRules).updateMany({ scope: 'item', target: o }, { $set: { target: n } });

  // Pozycje operacji: itemCode (każdy typ) oraz targetItemCode (gadżet-cel konwersji).
  const ops = db.collection(collections.stockOperations);
  await ops.updateMany(
    { 'lines.itemCode': o },
    { $set: { 'lines.$[e].itemCode': n } },
    { arrayFilters: [{ 'e.itemCode': o }] }
  );
  await ops.updateMany(
    { 'lines.targetItemCode': o },
    { $set: { 'lines.$[e].targetItemCode': n } },
    { arrayFilters: [{ 'e.targetItemCode': o }] }
  );
  // Snapshoty do cofania: konwersja (sourceCode/targetCode), dostawa i odpad (itemCode).
  await ops.updateMany(
    { 'conversionDetail.sourceCode': o },
    { $set: { 'conversionDetail.$[e].sourceCode': n } },
    { arrayFilters: [{ 'e.sourceCode': o }] }
  );
  await ops.updateMany(
    { 'conversionDetail.targetCode': o },
    { $set: { 'conversionDetail.$[e].targetCode': n } },
    { arrayFilters: [{ 'e.targetCode': o }] }
  );
  await ops.updateMany(
    { 'deliveryDetail.itemCode': o },
    { $set: { 'deliveryDetail.$[e].itemCode': n } },
    { arrayFilters: [{ 'e.itemCode': o }] }
  );
  await ops.updateMany(
    { 'scrapDetail.itemCode': o },
    { $set: { 'scrapDetail.$[e].itemCode': n } },
    { arrayFilters: [{ 'e.itemCode': o }] }
  );
  await ops.updateMany(
    { 'adjustmentDetail.itemCode': o },
    { $set: { 'adjustmentDetail.$[e].itemCode': n } },
    { arrayFilters: [{ 'e.itemCode': o }] }
  );
}

// Sekwencyjny numer dokumentu operacji (np. mag/IN/00001).
export async function nextReference(db, prefix) {
  const res = await db.collection(collections.counters).findOneAndUpdate(
    { _id: `ref:${prefix}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const doc = res && res.value !== undefined ? res.value : res;
  const seq = doc && typeof doc.seq === 'number' ? doc.seq : 1;
  return `${prefix}/${String(seq).padStart(5, '0')}`;
}

// ===== Operacje magazynowe (Faza 2 – układ jak w Odoo) =====
//
// Każda operacja to dokument (`stockOperations`) z obiegiem stanów:
//   draft (Wersja robocza) -> ready (Gotowe) -> done (Wykonano).
// Zatwierdzenie (validateOperation) zamienia pozycje dokumentu na ruchy w rejestrze.
//
// Typy = grupy z menu „Operacje": Przekazy (receipt/delivery/internal),
// Korekty (scrap/adjustment). Domyślne lokalizacje to kody z drzewa (STANDARD_LOCATIONS).
export const OPERATION_TYPES = {
  receipt:    { label: 'Przyjęcie',             group: 'Przekazy', prefix: 'mag/IN',    defaultFrom: 'VIRT/Suppliers', defaultTo: 'WH/Stock' },
  delivery:   { label: 'Dostawa',               group: 'Przekazy', prefix: 'mag/OUT',   defaultFrom: 'WH/Stock',       defaultTo: 'VIRT/Customers' },
  internal:   { label: 'Przesunięcie wewnętrzne', group: 'Przekazy', prefix: 'mag/INT', defaultFrom: 'WH/Stock',       defaultTo: 'WH/Studio' },
  scrap:      { label: 'Odpad',                 group: 'Korekty',  prefix: 'mag/SCRAP', defaultFrom: 'WH/Stock',       defaultTo: 'VIRT/Scrap' },
  adjustment: { label: 'Inwentarz fizyczny',    group: 'Korekty',  prefix: 'mag/ADJ',   defaultFrom: null,             defaultTo: 'WH/Stock' },
  // Konwersja (przeklasyfikowanie między kategoriami, np. towar↔gadżet): zdejmuje
  // źródło z Magazynu i tworzy tyle samo produktu docelowego, przenosząc koszt
  // jednostkowy. Pozycja ma dodatkowe pole `targetItemCode`.
  conversion: { label: 'Konwersja',             group: 'Przetworzenie', prefix: 'mag/CONV', defaultFrom: 'WH/Stock',  defaultTo: 'WH/Stock' }
};

export function isOperationType(type) {
  return Object.prototype.hasOwnProperty.call(OPERATION_TYPES, type);
}

// Stan danej sztuki na konkretnej lokalizacji (z materializowanych quantów).
export async function onHandAt(db, itemCode, locationId, lot = null) {
  const q = await db.collection(collections.quants).findOne({
    itemCode: String(itemCode),
    locationId: String(locationId),
    lot: lot ?? null
  });
  return q ? q.quantity : 0;
}

async function locationByCode(db, code) {
  return db.collection(collections.locations).findOne({ code });
}

// Gwarantuje istnienie wirtualnej lokalizacji (np. VIRT/Conversion, VIRT/Customers) —
// bazy zaseedowane przed jej wprowadzeniem jej nie mają, a `seedStandardLocations`
// leci tylko ze skryptu. Idempotentny upsert wpięty pod węzeł VIRT.
async function ensureVirtualLocation(db, code, name, kind) {
  const col = db.collection(collections.locations);
  const existing = await col.findOne({ code });
  if (existing) return existing;
  const parent = await col.findOne({ code: 'VIRT' });
  const ancestors = parent ? [...(parent.ancestors || []), parent.code] : [];
  const now = new Date();
  await col.updateOne(
    { code },
    {
      $set: { code, name, kind, parentId: parent ? String(parent._id) : null, ancestors, isActive: true, updatedAt: now },
      $setOnInsert: { createdAt: now }
    },
    { upsert: true }
  );
  return col.findOne({ code });
}

// Zatwierdza operację: generuje ruchy z pozycji dokumentu i ustawia stan „done".
// Dla inwentaryzacji liczy różnicę (policzone − stan systemowy), koryguje przez
// wirtualną lokalizację „Korekta stanu" i uzgadnia partie cenowe (ubytek FIFO,
// nadwyżka po ostatnim koszcie). Dla przekazów/odpadu sprawdza dostępność na
// lokalizacji fizycznej, by nie zejść poniżej zera.
export async function validateOperation(db, operationId, actorEmail) {
  const ops = db.collection(collections.stockOperations);
  const op = await ops.findOne({ _id: new ObjectId(String(operationId)) });
  if (!op) throw new Error('Operacja nie istnieje');
  if (op.state === 'done') throw new Error('Operacja jest już wykonana');
  if (op.state === 'cancelled') throw new Error('Operacja anulowana — nie można zatwierdzić');

  const lines = Array.isArray(op.lines) ? op.lines : [];
  if (!lines.length) throw new Error('Operacja nie ma pozycji');

  const now = new Date();
  const affected = new Set();

  // Przyjęcie: zapamiętaj stan/partie sprzed ruchów, by ochronić istniejącą ilość
  // przy dopisywaniu partii cenowych (patrz applyReceiptPriceBatches).
  const preReceipt = new Map();
  if (op.type === 'receipt') {
    const codes = [...new Set(lines.map(l => String(l.itemCode)))];
    const its = codes.length
      ? await db.collection(collections.items)
          .find({ itemCode: { $in: codes } }, { projection: { itemCode: 1, quantity: 1, priceBatches: 1 } })
          .toArray()
      : [];
    for (const it of its) preReceipt.set(it.itemCode, {
      quantity: Number(it.quantity) || 0,
      hadBatches: Array.isArray(it.priceBatches) && it.priceBatches.length > 0
    });
  }

  // Konwersja: zapamiętaj partie i ilość źródeł SPRZED ruchów — koszt zdejmujemy
  // z tego stanu (po ruchach quanty/ilości już są obniżone), patrz applyConversionBatches.
  const preConv = new Map();
  if (op.type === 'conversion') {
    const codes = [...new Set(lines.map(l => String(l.itemCode)))];
    const its = codes.length
      ? await db.collection(collections.items)
          .find({ itemCode: { $in: codes } }, { projection: { itemCode: 1, quantity: 1, priceBatches: 1 } })
          .toArray()
      : [];
    for (const it of its) preConv.set(it.itemCode, {
      quantity: Number(it.quantity) || 0,
      priceBatches: Array.isArray(it.priceBatches) ? it.priceBatches.map(b => ({ ...b })) : []
    });
  }

  // Dostawa (wydanie na zewnątrz): zapamiętaj partie/ilość SPRZED ruchów — wydanie
  // zdejmuje partie cenowe (towar opuszcza stan), patrz applyDeliveryBatches.
  const preDelivery = new Map();
  if (op.type === 'delivery') {
    const codes = [...new Set(lines.map(l => String(l.itemCode)))];
    const its = codes.length
      ? await db.collection(collections.items)
          .find({ itemCode: { $in: codes } }, { projection: { itemCode: 1, quantity: 1, priceBatches: 1 } })
          .toArray()
      : [];
    for (const it of its) preDelivery.set(it.itemCode, {
      quantity: Number(it.quantity) || 0,
      priceBatches: Array.isArray(it.priceBatches) ? it.priceBatches.map(b => ({ ...b })) : []
    });
  }

  // Odpad (złom): jak dostawa — towar opuszcza stan, więc zdejmujemy partie cenowe FIFO
  // (inaczej wycena zawyżałaby wartość o złomowane sztuki). Snapshot SPRZED ruchów.
  const preScrap = new Map();
  if (op.type === 'scrap') {
    const codes = [...new Set(lines.map(l => String(l.itemCode)))];
    const its = codes.length
      ? await db.collection(collections.items)
          .find({ itemCode: { $in: codes } }, { projection: { itemCode: 1, quantity: 1, priceBatches: 1 } })
          .toArray()
      : [];
    for (const it of its) preScrap.set(it.itemCode, {
      quantity: Number(it.quantity) || 0,
      priceBatches: Array.isArray(it.priceBatches) ? it.priceBatches.map(b => ({ ...b })) : []
    });
  }

  // Inwentaryzacja: jak przy rozchodzie/przyjęciu, korekta stanu musi też uzgodnić partie
  // cenowe (inaczej wycena dryfuje). Snapshot partii SPRZED ruchów + zliczony NETTO diff
  // per produkt (sumujemy linie tego samego kodu z różnych lokalizacji/lotów), bo partie
  // są per-produkt, nie per-lokalizacja. Uzgodnienie partii liczymy po refreshItemCache.
  const preAdjust = new Map();
  const adjustmentNetDiff = new Map();
  if (op.type === 'adjustment') {
    const codes = [...new Set(lines.map(l => String(l.itemCode)))];
    const its = codes.length
      ? await db.collection(collections.items)
          .find({ itemCode: { $in: codes } }, { projection: { itemCode: 1, quantity: 1, priceBatches: 1 } })
          .toArray()
      : [];
    for (const it of its) preAdjust.set(it.itemCode, {
      quantity: Number(it.quantity) || 0,
      priceBatches: Array.isArray(it.priceBatches) ? it.priceBatches.map(b => ({ ...b })) : []
    });
  }

  if (op.type === 'adjustment') {
    const inv = await locationByCode(db, 'VIRT/Inventory');
    if (!inv) throw new Error('Brak wirtualnej lokalizacji korekty (VIRT/Inventory)');

    for (const ln of lines) {
      const itemCode = String(ln.itemCode || '').trim();
      const locationId = String(ln.locationId || op.toLocationId || '');
      if (!itemCode || !locationId) throw new Error('Pozycja inwentarza bez sprzętu/lokalizacji');
      const lot = ln.lot != null && ln.lot !== '' ? String(ln.lot) : null;
      const counted = Number(ln.countedQty);
      if (!Number.isFinite(counted) || counted < 0) throw new Error(`Niepoprawny policzony stan dla ${itemCode}`);

      const theoretical = await onHandAt(db, itemCode, locationId, lot);
      const diff = counted - theoretical;
      if (diff === 0) continue;

      await applyMove(db, {
        itemCode,
        fromLocationId: diff > 0 ? String(inv._id) : locationId,
        toLocationId: diff > 0 ? locationId : String(inv._id),
        quantity: Math.abs(diff),
        lot,
        kind: 'adjustment',
        operationId: String(op._id),
        actorEmail,
        note: op.reference,
        doneAt: now
      });
      affected.add(itemCode);
      adjustmentNetDiff.set(itemCode, (adjustmentNetDiff.get(itemCode) || 0) + diff);
    }
  } else if (op.type === 'conversion') {
    // Przeklasyfikowanie: dla każdej pozycji zdejmij `quantity` źródła z Magazynu
    // (Magazyn → VIRT/Conversion) i utwórz tyle samo celu (VIRT/Conversion →
    // Magazyn). Dwa spięte ruchy; koszt przeniesie applyConversionBatches.
    const stock = await locationByCode(db, 'WH/Stock');
    if (!stock) throw new Error('Brak lokalizacji magazynu (WH/Stock)');
    const conv = await ensureVirtualLocation(db, 'VIRT/Conversion', 'Przetworzenie (konwersja)', LOCATION_KINDS.CONVERSION);

    for (const ln of lines) {
      const sourceCode = String(ln.itemCode || '').trim();
      const targetCode = String(ln.targetItemCode || '').trim();
      const qty = Number(ln.quantity);
      if (!sourceCode || !targetCode) throw new Error('Pozycja konwersji wymaga produktu źródłowego i docelowego');
      if (sourceCode === targetCode) throw new Error('Produkt źródłowy i docelowy muszą być różne');
      if (!Number.isFinite(qty) || qty <= 0) throw new Error(`Niepoprawna ilość dla ${sourceCode}`);

      const avail = await onHandAt(db, sourceCode, String(stock._id), null);
      if (qty > avail) throw new Error(`Za mało na stanie: ${sourceCode} (dostępne ${avail}, żądane ${qty})`);

      await applyMove(db, {
        itemCode: sourceCode,
        fromLocationId: String(stock._id),
        toLocationId: String(conv._id),
        quantity: qty,
        kind: 'conversion',
        operationId: String(op._id),
        actorEmail,
        note: op.reference,
        doneAt: now
      });
      await applyMove(db, {
        itemCode: targetCode,
        fromLocationId: String(conv._id),
        toLocationId: String(stock._id),
        quantity: qty,
        kind: 'conversion',
        operationId: String(op._id),
        actorEmail,
        note: op.reference,
        doneAt: now
      });
      affected.add(sourceCode);
      affected.add(targetCode);
    }
  } else {
    let from = op.fromLocationId ? String(op.fromLocationId) : null;
    let to = op.toLocationId ? String(op.toLocationId) : null;

    // Dostawa: źródło zawsze Magazyn, cel zawsze wirtualne „Wydania" (towar
    // opuszcza stan). Wymuszamy niezależnie od zapisu na dokumencie.
    if (op.type === 'delivery') {
      const stock = await locationByCode(db, 'WH/Stock');
      const sink = await ensureVirtualLocation(db, 'VIRT/Customers', 'Wydania / odbiorcy', LOCATION_KINDS.CUSTOMER);
      if (stock) from = String(stock._id);
      if (sink) to = String(sink._id);
    }

    // Kontrola dostępności, gdy źródłem jest lokalizacja fizyczna (nie dotyczy przyjęć).
    if (from) {
      const fromLoc = await db.collection(collections.locations).findOne({ _id: new ObjectId(from) });
      if (fromLoc && isStockableKind(fromLoc.kind)) {
        for (const ln of lines) {
          const lot = ln.lot != null && ln.lot !== '' ? String(ln.lot) : null;
          const avail = await onHandAt(db, ln.itemCode, from, lot);
          if (Number(ln.quantity) > avail) {
            throw new Error(`Za mało na stanie: ${ln.itemCode} (dostępne ${avail}, żądane ${ln.quantity})`);
          }
        }
      }
    }

    for (const ln of lines) {
      const qty = Number(ln.quantity);
      if (!Number.isFinite(qty) || qty <= 0) throw new Error(`Niepoprawna ilość dla ${ln.itemCode}`);
      await applyMove(db, {
        itemCode: ln.itemCode,
        fromLocationId: from,
        toLocationId: to,
        quantity: qty,
        lot: ln.lot != null && ln.lot !== '' ? String(ln.lot) : null,
        kind: op.type,
        operationId: String(op._id),
        actorEmail,
        note: op.reference,
        doneAt: now
      });
      affected.add(ln.itemCode);
    }
  }

  await ops.updateOne(
    { _id: op._id },
    { $set: { state: 'done', doneAt: now, doneByEmail: actorEmail, updatedAt: now } }
  );
  for (const code of affected) await refreshItemCache(db, code);

  // Przyjęcie z ceną → dopisz partie cenowe (po odświeżeniu cache, by nadpisać
  // ilość sumą partii — partie są źródłem prawdy dla produktów Magazynu, #27).
  if (op.type === 'receipt') await applyReceiptPriceBatches(db, op, lines, preReceipt, now);

  // Konwersja → przenieś koszt z partii towaru na nową partię gadżetu; zapamiętaj
  // detal na dokumencie, by cofnięcie mogło dokładnie odtworzyć partie obu stron.
  if (op.type === 'conversion') {
    const detail = await applyConversionBatches(db, op, lines, preConv, now);
    if (detail.length) await ops.updateOne({ _id: op._id }, { $set: { conversionDetail: detail } });
  }

  // Dostawa → zdejmij partie cenowe (towar opuszcza stan); zapamiętaj zdjęte partie,
  // by cofnięcie mogło je oddać.
  if (op.type === 'delivery') {
    const detail = await consumeStockBatches(db, op, lines, preDelivery, now);
    if (detail.length) await ops.updateOne({ _id: op._id }, { $set: { deliveryDetail: detail } });
  }

  // Odpad → zdejmij partie cenowe (jak dostawa); zapamiętaj zdjęte partie do cofnięcia.
  if (op.type === 'scrap') {
    const detail = await consumeStockBatches(db, op, lines, preScrap, now);
    if (detail.length) await ops.updateOne({ _id: op._id }, { $set: { scrapDetail: detail } });
  }

  // Inwentaryzacja → uzgodnij partie z policzonym stanem: ubytek zdejmuje FIFO, nadwyżka
  // dopisuje warstwę po ostatnim znanym koszcie. Zapamiętaj detal do cofnięcia.
  if (op.type === 'adjustment') {
    const detail = await applyAdjustmentBatches(db, adjustmentNetDiff, preAdjust, op, now);
    if (detail.length) await ops.updateOne({ _id: op._id }, { $set: { adjustmentDetail: detail } });
  }

  return { reference: op.reference, affected: [...affected] };
}

// Dopisuje partie cenowe do produktów z pozycji przyjęcia i ustawia ilość = suma
// partii. Jeśli produkt miał ilość, ale nie miał partii, najpierw dopisuje partię
// „Stan początkowy" (0 zł), żeby suma partii odzwierciedlała pełny stan.
async function applyReceiptPriceBatches(db, op, lines, preReceipt, now) {
  const byCode = new Map();
  for (const ln of lines) {
    const code = String(ln.itemCode);
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push({
      qty: Math.max(0, Math.floor(Number(ln.quantity) || 0)),
      unitPrice: Math.max(0, Math.round((Number(ln.unitPrice) || 0) * 100) / 100)
    });
  }

  const noteBase = op.supplierName ? `${op.reference} · ${op.supplierName}` : op.reference;

  for (const [code, entries] of byCode) {
    const item = await db.collection(collections.items)
      .findOne({ itemCode: code }, { projection: { priceBatches: 1 } });
    if (!item) continue;
    const batches = Array.isArray(item.priceBatches) ? item.priceBatches.slice() : [];
    const pre = preReceipt.get(code) || { quantity: 0, hadBatches: batches.length > 0 };

    if (!pre.hadBatches && batches.length === 0 && pre.quantity > 0) {
      batches.push({ qty: pre.quantity, unitPrice: 0, note: 'Stan początkowy', addedAt: now });
    }
    for (const e of entries) {
      if (e.qty <= 0 && e.unitPrice <= 0) continue;
      batches.push({ qty: e.qty, unitPrice: e.unitPrice, note: noteBase, addedAt: now });
    }

    const totalQty = batches.reduce((s, b) => s + (Number(b.qty) || 0), 0);
    await db.collection(collections.items).updateOne(
      { itemCode: code },
      { $set: { priceBatches: batches, quantity: totalQty, updatedAt: now } }
    );
  }
}

// Zdejmuje `qty` z tablicy partii FIFO (mutuje qty partii). Zwraca koszt zdjętej
// ilości i listę zdjętych transz (do odwrócenia operacji).
export function fifoConsume(batches, qty) {
  let remaining = Math.max(0, qty);
  let cost = 0;
  const consumed = [];
  for (const b of batches) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(b.qty) || 0);
    if (take <= 0) continue;
    b.qty = (Number(b.qty) || 0) - take;
    const up = Number(b.unitPrice) || 0;
    cost += take * up;
    consumed.push({ qty: take, unitPrice: up });
    remaining -= take;
  }
  return { consumed, cost };
}

// Przenosi koszt przy konwersji: zdejmuje `quantity` z partii towaru (FIFO) i
// dopisuje gadżetowi jedną partię po średniej cenie zdjętego kosztu. Operuje na
// stanie SPRZED ruchów (`preConv`), więc ilość pozostała = suma partii po zdjęciu.
// Zwraca detal [{ sourceCode, targetCode, qty, consumed:[{qty,unitPrice}], note }]
// do dokładnego odwrócenia w reverseOperation.
async function applyConversionBatches(db, op, lines, preConv, now) {
  const items = db.collection(collections.items);
  const detail = [];
  // Robocza kopia partii towaru — współdzielona między pozycjami tego samego źródła.
  const work = new Map();
  const sourceBatches = (code) => {
    if (!work.has(code)) {
      const pre = preConv.get(code) || { quantity: 0, priceBatches: [] };
      const b = pre.priceBatches.map(x => ({ ...x }));
      // Legacy bez partii, ale z ilością → najpierw partia „Stan początkowy" (0 zł).
      if (b.length === 0 && pre.quantity > 0) b.push({ qty: pre.quantity, unitPrice: 0, note: 'Stan początkowy', addedAt: now });
      work.set(code, b);
    }
    return work.get(code);
  };

  for (const ln of lines) {
    const sourceCode = String(ln.itemCode || '').trim();
    const targetCode = String(ln.targetItemCode || '').trim();
    const qty = Math.max(0, Math.floor(Number(ln.quantity) || 0));
    if (!sourceCode || !targetCode || qty <= 0) continue;

    // Zdejmij qty FIFO; zbierz koszt i zdjęte partie (do cofnięcia).
    const batches = sourceBatches(sourceCode);
    const { consumed, cost } = fifoConsume(batches, qty);
    const kept = batches.filter(b => (Number(b.qty) || 0) > 0);
    work.set(sourceCode, kept);
    const srcTotal = kept.reduce((s, b) => s + (Number(b.qty) || 0), 0);
    await items.updateOne({ itemCode: sourceCode }, { $set: { priceBatches: kept, quantity: srcTotal, updatedAt: now } });

    // Cena jednostkowa gadżetu = średnia zdjętego kosztu (gdy brak kosztu → 0 zł).
    const producedUnit = qty > 0 ? Math.round((cost / qty) * 100) / 100 : 0;
    const note = `${op.reference} · konwersja z ${sourceCode}`;
    const tgt = await items.findOne({ itemCode: targetCode }, { projection: { priceBatches: 1 } });
    if (tgt) {
      const tBatches = Array.isArray(tgt.priceBatches) ? tgt.priceBatches.slice() : [];
      tBatches.push({ qty, unitPrice: producedUnit, note, addedAt: now });
      const tTotal = tBatches.reduce((s, b) => s + (Number(b.qty) || 0), 0);
      await items.updateOne({ itemCode: targetCode }, { $set: { priceBatches: tBatches, quantity: tTotal, updatedAt: now } });
    }

    detail.push({ sourceCode, targetCode, qty, consumed, producedUnit, note });
  }
  return detail;
}

// Zdejmuje partie cenowe przy ROZCHODZIE (dostawa lub odpad — towar opuszcza stan).
// FIFO z partii każdego produktu na podstawie snapshotu sprzed ruchów; ustawia ilość =
// suma partii po zdjęciu. Zwraca detal [{ itemCode, qty, consumed }] do oddania przy
// cofnięciu. Tej samej logiki używają dostawa (deliveryDetail) i odpad (scrapDetail).
async function consumeStockBatches(db, op, lines, preStock, now) {
  const items = db.collection(collections.items);
  const detail = [];
  const work = new Map();
  const productBatches = (code) => {
    if (!work.has(code)) {
      const pre = preStock.get(code) || { quantity: 0, priceBatches: [] };
      const b = pre.priceBatches.map(x => ({ ...x }));
      if (b.length === 0 && pre.quantity > 0) b.push({ qty: pre.quantity, unitPrice: 0, note: 'Stan początkowy', addedAt: now });
      work.set(code, b);
    }
    return work.get(code);
  };

  for (const ln of lines) {
    const code = String(ln.itemCode || '').trim();
    const qty = Math.max(0, Math.floor(Number(ln.quantity) || 0));
    if (!code || qty <= 0) continue;
    const batches = productBatches(code);
    const { consumed } = fifoConsume(batches, qty);
    const kept = batches.filter(b => (Number(b.qty) || 0) > 0);
    work.set(code, kept);
    const total = kept.reduce((s, b) => s + (Number(b.qty) || 0), 0);
    await items.updateOne({ itemCode: code }, { $set: { priceBatches: kept, quantity: total, updatedAt: now } });
    detail.push({ itemCode: code, qty, consumed });
  }
  return detail;
}

// Uzgadnia partie cenowe z policzonym stanem inwentaryzacji. Dla każdego produktu liczy
// NETTO różnicę (Σ po liniach): ubytek (< 0) zdejmuje partie FIFO; nadwyżka (> 0) dopisuje
// jedną warstwę po OSTATNIM znanym koszcie jednostkowym (cena najnowszej partii; brak →
// 0 zł). Operuje na partiach SPRZED ruchów (`preAdjust`) — ruchy korekty nie tykają partii,
// więc to wciąż żywy stan. Pomija produkty bez partii (nie syntetyzujemy ich — wycena bez
// partii i tak liczy ilość, nie koszt). Zwraca detal [{ itemCode, diff, consumed?, added? }]
// do dokładnego odwrócenia w reverseOperation.
async function applyAdjustmentBatches(db, netDiffByItem, preAdjust, op, now) {
  const items = db.collection(collections.items);
  const detail = [];

  for (const [code, netDiff] of netDiffByItem) {
    if (!netDiff) continue;
    const pre = preAdjust.get(code);
    const batches = pre && Array.isArray(pre.priceBatches) ? pre.priceBatches.map(b => ({ ...b })) : [];
    if (!batches.length) continue; // brak partii → nie syntetyzujemy kosztu

    if (netDiff < 0) {
      const { consumed } = fifoConsume(batches, -netDiff);
      const kept = batches.filter(b => (Number(b.qty) || 0) > 0);
      const total = kept.reduce((s, b) => s + (Number(b.qty) || 0), 0);
      await items.updateOne({ itemCode: code }, { $set: { priceBatches: kept, quantity: total, updatedAt: now } });
      detail.push({ itemCode: code, diff: netDiff, consumed });
    } else {
      // Nadwyżka: ostatni znany koszt = cena najnowszej (ostatniej) partii; brak → 0 zł.
      const lastUnit = batches.length ? (Number(batches[batches.length - 1].unitPrice) || 0) : 0;
      const added = { qty: netDiff, unitPrice: lastUnit, note: `${op.reference} · nadwyżka inwentaryzacji`, addedAt: now };
      const updated = [...batches, added];
      const total = updated.reduce((s, b) => s + (Number(b.qty) || 0), 0);
      await items.updateOne({ itemCode: code }, { $set: { priceBatches: updated, quantity: total, updatedAt: now } });
      detail.push({ itemCode: code, diff: netDiff, added: { qty: netDiff, unitPrice: lastUnit } });
    }
  }
  return detail;
}

// Cofa wykonaną operację: usuwa jej ruchy z rejestru i przelicza stany (jakby
// nigdy się nie zaksięgowała), a dla przyjęć usuwa partie cenowe dopisane przez
// tę operację (rozpoznawane po prefiksie referencji). Operacja wraca do stanu
// „draft" — można ją poprawić i zatwierdzić ponownie.
export async function reverseOperation(db, operationId, actorEmail) {
  const ops = db.collection(collections.stockOperations);
  const op = await ops.findOne({ _id: new ObjectId(String(operationId)) });
  if (!op) throw new Error('Operacja nie istnieje');
  if (op.state !== 'done') throw new Error('Cofnąć można tylko wykonaną operację');
  // Dokumenty zaciągnięte z Odoo to ZAPIS zdarzeń, które wydarzyły się poza zapleczem.
  // Nie mają snapshotu partii cenowych, więc cofnięcie odtworzyłoby ruchy, ale nie
  // koszty — zostawiłoby stan rozjechany z wyceną. Historię się poprawia w Odoo.
  if (op.importedFrom === 'odoo') {
    throw new Error('To dokument zaciągnięty z historii Odoo — nie można go cofnąć.');
  }

  const opId = String(op._id);
  const moves = await db.collection(collections.stockMoves).find({ operationId: opId }).toArray();
  const affected = [...new Set(moves.map(m => m.itemCode))];
  await db.collection(collections.stockMoves).deleteMany({ operationId: opId });
  for (const code of affected) { await recomputeQuants(db, code); await refreshItemCache(db, code); }

  // Przyjęcie: zdejmij partie cenowe dopisane przez tę operację (po referencji).
  if (op.type === 'receipt') {
    const codes = [...new Set((op.lines || []).map(l => String(l.itemCode)))];
    for (const code of codes) {
      const item = await db.collection(collections.items)
        .findOne({ itemCode: code }, { projection: { priceBatches: 1 } });
      if (!item || !Array.isArray(item.priceBatches)) continue;
      const kept = item.priceBatches.filter(b => !String(b.note || '').startsWith(op.reference));
      if (kept.length !== item.priceBatches.length) {
        const totalQty = kept.reduce((s, b) => s + (Number(b.qty) || 0), 0);
        await db.collection(collections.items).updateOne(
          { itemCode: code },
          { $set: { priceBatches: kept, quantity: totalQty, updatedAt: new Date() } }
        );
      }
    }
  }

  // Konwersja: odtwórz partie z zapamiętanego detalu — gadżetowi zdejmij dopisaną
  // partię (po nocie + ilości), towarowi oddaj zdjęte partie. Bez detalu (stare
  // dokumenty) cofamy tylko ruchy — quanty i tak wracają przez recomputeQuants.
  if (op.type === 'conversion' && Array.isArray(op.conversionDetail)) {
    const items = db.collection(collections.items);
    for (const d of op.conversionDetail) {
      const tgt = await items.findOne({ itemCode: d.targetCode }, { projection: { priceBatches: 1 } });
      if (tgt && Array.isArray(tgt.priceBatches)) {
        const kept = [];
        let removed = false;
        for (const b of tgt.priceBatches) {
          if (!removed && b.note === d.note && Number(b.qty) === Number(d.qty)) { removed = true; continue; }
          kept.push(b);
        }
        const tTotal = kept.reduce((s, b) => s + (Number(b.qty) || 0), 0);
        await items.updateOne({ itemCode: d.targetCode }, { $set: { priceBatches: kept, quantity: tTotal, updatedAt: new Date() } });
      }
      if (Array.isArray(d.consumed) && d.consumed.length) {
        const src = await items.findOne({ itemCode: d.sourceCode }, { projection: { priceBatches: 1 } });
        const sBatches = src && Array.isArray(src.priceBatches) ? src.priceBatches.slice() : [];
        for (const c of d.consumed) sBatches.push({ qty: Number(c.qty) || 0, unitPrice: Number(c.unitPrice) || 0, note: `Zwrot z konwersji ${op.reference}`, addedAt: new Date() });
        const sTotal = sBatches.reduce((s, b) => s + (Number(b.qty) || 0), 0);
        await items.updateOne({ itemCode: d.sourceCode }, { $set: { priceBatches: sBatches, quantity: sTotal, updatedAt: new Date() } });
      }
    }
  }

  // Dostawa/odpad: oddaj partie cenowe zdjęte przy rozchodzie (z zapamiętanego detalu).
  // Stare dokumenty odpadu bez `scrapDetail` (sprzed wprowadzenia zdejmowania partii)
  // nic tu nie oddają — i słusznie: wtedy partie nie były zdejmowane.
  for (const { detail, label } of [
    { detail: op.type === 'delivery' ? op.deliveryDetail : null, label: 'dostawy' },
    { detail: op.type === 'scrap' ? op.scrapDetail : null, label: 'odpadu' }
  ]) {
    if (!Array.isArray(detail)) continue;
    const items = db.collection(collections.items);
    for (const d of detail) {
      if (!Array.isArray(d.consumed) || !d.consumed.length) continue;
      const it = await items.findOne({ itemCode: d.itemCode }, { projection: { priceBatches: 1 } });
      const batches = it && Array.isArray(it.priceBatches) ? it.priceBatches.slice() : [];
      for (const c of d.consumed) batches.push({ qty: Number(c.qty) || 0, unitPrice: Number(c.unitPrice) || 0, note: `Zwrot z ${label} ${op.reference}`, addedAt: new Date() });
      const total = batches.reduce((s, b) => s + (Number(b.qty) || 0), 0);
      await items.updateOne({ itemCode: d.itemCode }, { $set: { priceBatches: batches, quantity: total, updatedAt: new Date() } });
    }
  }

  // Inwentaryzacja: odwróć uzgodnienie partii — ubytkowi oddaj zdjęte warstwy (jak rozchód),
  // nadwyżce zdejmij dopisaną warstwę (po nocie + ilości, jak konwersja). Bez detalu (stare
  // dokumenty) cofamy tylko ruchy — quanty i tak wracają przez recomputeQuants.
  if (op.type === 'adjustment' && Array.isArray(op.adjustmentDetail)) {
    const items = db.collection(collections.items);
    for (const d of op.adjustmentDetail) {
      const it = await items.findOne({ itemCode: d.itemCode }, { projection: { priceBatches: 1 } });
      let batches = it && Array.isArray(it.priceBatches) ? it.priceBatches.slice() : [];
      if (Array.isArray(d.consumed) && d.consumed.length) {
        for (const c of d.consumed) batches.push({ qty: Number(c.qty) || 0, unitPrice: Number(c.unitPrice) || 0, note: `Zwrot z inwentaryzacji ${op.reference}`, addedAt: new Date() });
      } else if (d.added) {
        const note = `${op.reference} · nadwyżka inwentaryzacji`;
        let removed = false;
        batches = batches.filter(b => {
          if (!removed && b.note === note && Number(b.qty) === Number(d.added.qty)) { removed = true; return false; }
          return true;
        });
      }
      const total = batches.reduce((s, b) => s + (Number(b.qty) || 0), 0);
      await items.updateOne({ itemCode: d.itemCode }, { $set: { priceBatches: batches, quantity: total, updatedAt: new Date() } });
    }
  }

  const now = new Date();
  await ops.updateOne(
    { _id: op._id },
    { $set: { state: 'draft', updatedAt: now, reversedByEmail: actorEmail, reversedAt: now }, $unset: { doneAt: '', doneByEmail: '', conversionDetail: '', deliveryDetail: '', scrapDetail: '', adjustmentDetail: '' } }
  );
  return { reference: op.reference, affected };
}

// ===== Zapotrzebowanie (reguły min-max / orderpoint) =====
//
// Jak w Odoo „Replenishment": reguła trzyma minimum i maksimum dla celu
// (kategoria albo konkretny itemCode). Gdy dostępny stan spadnie poniżej
// minimum, sugerujemy uzupełnienie do maksimum (do zamówienia = max − stan).
// „Dostępny stan" liczymy tylko na lokalizacjach realnego magazynu (`internal`):
// sprzęt u pracownika jest wydany, a lokalizacje wirtualne to źródła/ujścia.
export const REORDER_SCOPES = ['category', 'item'];

export function isReorderScope(scope) {
  return REORDER_SCOPES.includes(scope);
}

// ===== Rezerwacje stanu (pochodna otwartych operacji wydających towar) =====
//
// `reservedQty` na `quants` jest zerowane przez recomputeQuants (źródło prawdy z
// ruchów), więc rezerwacji NIE trzymamy jako niezależny zapis — liczymy ją z otwartych
// operacji (draft/ready), jak w Odoo. Rezerwują operacje zdejmujące towar z magazynu:
// dostawa (wydanie), odpad i źródło konwersji (towar→gadżet). Po zatwierdzeniu operacja
// znika ze stanu draft/ready, więc rezerwacja sama gaśnie (ruch realnie obniża stan).
export const RESERVING_OP_TYPES = ['delivery', 'scrap', 'conversion'];
export const RESERVING_OP_STATES = ['draft', 'ready'];

// Czysta agregacja nad listą operacji: zwraca rezerwacje per itemCode oraz per
// (itemCode, lokalizacja źródłowa). Konwersja rezerwuje `itemCode` (towar-źródło).
export function reservedFromOperations(operations) {
  const byItem = new Map();
  const byItemLoc = new Map();
  for (const op of Array.isArray(operations) ? operations : []) {
    if (!RESERVING_OP_TYPES.includes(op?.type)) continue;
    if (!RESERVING_OP_STATES.includes(op?.state)) continue;
    const loc = op.fromLocationId ? String(op.fromLocationId) : null;
    for (const ln of Array.isArray(op.lines) ? op.lines : []) {
      const code = String(ln?.itemCode || '').trim();
      const qty = Math.max(0, Math.floor(Number(ln?.quantity) || 0));
      if (!code || qty <= 0) continue;
      byItem.set(code, (byItem.get(code) || 0) + qty);
      if (loc) {
        const k = `${code}::${loc}`;
        byItemLoc.set(k, (byItemLoc.get(k) || 0) + qty);
      }
    }
  }
  return { byItem, byItemLoc };
}

// Rezerwacje policzone z bazy (otwarte operacje wydające towar). `excludeOpId` pomija
// jedną operację (liczymy „rezerwacje INNYCH operacji"). `states` zawęża stany — do
// widoczności bierzemy draft+ready, ale blokada przy commit liczy tylko zacommitowane
// (ready), żeby pierwszy commit nie był blokowany cudzymi wersjami roboczymi.
export async function reservedQuantities(db, { excludeOpId = null, states = RESERVING_OP_STATES } = {}) {
  const filter = { type: { $in: RESERVING_OP_TYPES }, state: { $in: states } };
  if (excludeOpId) {
    try { filter._id = { $ne: new ObjectId(String(excludeOpId)) }; } catch { /* zły id → bez wykluczenia */ }
  }
  const ops = await db.collection(collections.stockOperations)
    .find(filter, { projection: { type: 1, state: 1, fromLocationId: 1, lines: 1 } })
    .toArray();
  return reservedFromOperations(ops);
}

// Czy operację wydającą towar można zarezerwować (przejść w „ready"): łączne
// zapotrzebowanie per produkt nie może przekroczyć dostępnego = on-hand − rezerwacje
// INNYCH otwartych operacji. Czysta logika (mapy podaje wołający). Konwersja podaje
// w `itemCode` towar-źródło, więc działa tak samo jak dostawa/odpad.
export function checkReservation(lines, onHandByItem, reservedByOthers) {
  const oh = onHandByItem instanceof Map ? onHandByItem : new Map(Object.entries(onHandByItem || {}));
  const ro = reservedByOthers instanceof Map ? reservedByOthers : new Map(Object.entries(reservedByOthers || {}));
  const demand = new Map();
  for (const ln of Array.isArray(lines) ? lines : []) {
    const code = String(ln?.itemCode || '').trim();
    const qty = Math.max(0, Math.floor(Number(ln?.quantity) || 0));
    if (!code || qty <= 0) continue;
    demand.set(code, (demand.get(code) || 0) + qty);
  }
  const violations = [];
  for (const [code, need] of demand) {
    const onHand = Number(oh.get(code)) || 0;
    const otherReserved = Number(ro.get(code)) || 0;
    const available = Math.max(0, onHand - otherReserved);
    if (need > available) violations.push({ itemCode: code, demand: need, onHand, otherReserved, available });
  }
  return { ok: violations.length === 0, violations };
}

// Stan na lokalizacjach `internal` z rezerwacjami: per itemCode i per kategoria zwraca
// on-hand, zarezerwowane i dostępne (= max(0, onHand − reserved)).
async function availableOnHand(db) {
  const internal = await db.collection(collections.locations)
    .find({ kind: LOCATION_KINDS.INTERNAL, isActive: { $ne: false } })
    .toArray();
  const internalIds = new Set(internal.map(l => String(l._id)));

  const quants = await db.collection(collections.quants)
    .find({ quantity: { $gt: 0 } })
    .toArray();

  const onHandByItem = new Map();
  for (const q of quants) {
    if (!internalIds.has(q.locationId)) continue;
    onHandByItem.set(q.itemCode, (onHandByItem.get(q.itemCode) || 0) + q.quantity);
  }

  const { byItem: reservedByItem } = await reservedQuantities(db);

  // Kategorie dla sumy unii kodów (na stanie + zarezerwowane bez stanu).
  const codes = [...new Set([...onHandByItem.keys(), ...reservedByItem.keys()])];
  const items = codes.length
    ? await db.collection(collections.items)
        .find({ itemCode: { $in: codes } }, { projection: { itemCode: 1, category: 1 } })
        .toArray()
    : [];
  const catByCode = new Map(items.map(it => [it.itemCode, it.category || '']));

  const onHandByCategory = new Map();
  const reservedByCategory = new Map();
  for (const [code, qty] of onHandByItem) {
    const cat = catByCode.get(code) || '';
    onHandByCategory.set(cat, (onHandByCategory.get(cat) || 0) + qty);
  }
  for (const [code, qty] of reservedByItem) {
    const cat = catByCode.get(code) || '';
    reservedByCategory.set(cat, (reservedByCategory.get(cat) || 0) + qty);
  }

  const availByItem = new Map();
  for (const code of new Set([...onHandByItem.keys(), ...reservedByItem.keys()])) {
    availByItem.set(code, Math.max(0, (onHandByItem.get(code) || 0) - (reservedByItem.get(code) || 0)));
  }
  const availByCategory = new Map();
  for (const cat of new Set([...onHandByCategory.keys(), ...reservedByCategory.keys()])) {
    availByCategory.set(cat, Math.max(0, (onHandByCategory.get(cat) || 0) - (reservedByCategory.get(cat) || 0)));
  }

  return {
    onHandByItem, reservedByItem, availByItem,
    onHandByCategory, reservedByCategory, availByCategory
  };
}

// Zwraca wszystkie reguły wzbogacone o bieżący stan i sugestię zamówienia.
export async function computeReplenishment(db) {
  const rules = await db.collection(collections.reorderRules)
    .find({}).sort({ scope: 1, target: 1 }).toArray();
  if (!rules.length) return [];

  const {
    onHandByItem, reservedByItem, availByItem,
    onHandByCategory, reservedByCategory, availByCategory
  } = await availableOnHand(db);

  // Nazwy dla reguł itemowych (czytelna etykieta „K004 · Sony A7").
  const itemCodes = rules.filter(r => r.scope === 'item').map(r => r.target);
  const items = itemCodes.length
    ? await db.collection(collections.items)
        .find({ itemCode: { $in: itemCodes } }, { projection: { itemCode: 1, name: 1 } })
        .toArray()
    : [];
  const nameByCode = new Map(items.map(it => [it.itemCode, it.name || '']));

  return rules.map(r => {
    const isItem = r.scope === 'item';
    const onHand = isItem ? (onHandByItem.get(r.target) || 0) : (onHandByCategory.get(r.target) || 0);
    const reserved = isItem ? (reservedByItem.get(r.target) || 0) : (reservedByCategory.get(r.target) || 0);
    const available = isItem ? (availByItem.get(r.target) || 0) : (availByCategory.get(r.target) || 0);
    const minQty = Number(r.minQty) || 0;
    const maxQty = Number(r.maxQty) || 0;
    const isActive = r.isActive !== false;
    // Decyzja o uzupełnieniu liczona od DOSTĘPNEGO (stan po rezerwacjach) — nie zamawiamy
    // ponownie pod towar już zaklepany otwartymi wydaniami.
    const below = isActive && available < minQty;
    const toOrder = below ? Math.max(0, maxQty - available) : 0;
    const itemName = isItem ? (nameByCode.get(r.target) || '') : '';
    return {
      id: String(r._id),
      scope: r.scope,
      target: r.target,
      itemName,
      label: isItem ? (itemName || r.target) : r.target,
      minQty,
      maxQty,
      onHand,
      reserved,
      available,
      toOrder,
      below,
      isActive,
      note: r.note || ''
    };
  });
}

// Z policzonej reguły (jeden wiersz z computeReplenishment) buduje pozycję draftu
// „przyjęcia". Uzupełniać da się tylko reguły itemowe poniżej minimum z dodatnim
// `toOrder` — reguła kategorii nie wskazuje jednego produktu, więc nie da się z niej
// zbudować linii przyjęcia (`below` już zawiera warunek aktywności). Czysta logika
// (bez bazy): zwraca { eligible, reason?, line? }.
export function replenishmentDraft(row) {
  const r = row || {};
  if (r.scope !== 'item') return { eligible: false, reason: 'category' };
  if (!r.below) return { eligible: false, reason: 'not_below' };
  const qty = Math.max(0, Math.floor(Number(r.toOrder) || 0));
  if (qty <= 0) return { eligible: false, reason: 'zero' };
  return { eligible: true, line: { itemCode: r.target, quantity: qty } };
}

// ===== Wycena stanu (Σ ilość × cena zakupu wg partii) =====
//
// Czysta agregacja — bierze listę pozycji (już odfiltrowaną do kategorii Magazynu
// przez wołającego) i liczy wartość per produkt, per kategoria oraz łącznie.
// Arytmetyka jest taka sama jak `totalValue` w widoku Produktów (źródłem są partie
// cenowe FIFO), więc te same pieniądze widać w dwóch miejscach.
// Pozycje bez partii: ilość = `quantity`, wartość = 0 zł (jak w widoku Produktów) —
// po prostu nie znamy ich kosztu zakupu.
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function computeValuation(items) {
  const byCategory = new Map();
  let totalQty = 0;
  let totalValue = 0;
  let pricedQty = 0; // sztuki z poznanym kosztem (mają partie) — do oceny pokrycia wyceny

  for (const it of Array.isArray(items) ? items : []) {
    const batches = Array.isArray(it.priceBatches) ? it.priceBatches : [];
    const batchQty = batches.reduce((s, b) => s + (Number(b.qty) || 0), 0);
    const qty = batches.length ? batchQty : (Number(it.quantity) || 0);
    const value = batches.reduce((s, b) => s + (Number(b.qty) || 0) * (Number(b.unitPrice) || 0), 0);
    const cat = String(it.category || '—');

    if (!byCategory.has(cat)) {
      byCategory.set(cat, { category: cat, totalQty: 0, totalValue: 0, products: [] });
    }
    const group = byCategory.get(cat);
    group.products.push({
      itemCode: it.itemCode,
      name: it.name || '',
      qty,
      value: round2(value),
      avgUnitPrice: qty > 0 ? round2(value / qty) : 0,
      batchCount: batches.length
    });
    group.totalQty += qty;
    group.totalValue += value;
    totalQty += qty;
    totalValue += value;
    if (batches.length) pricedQty += batchQty;
  }

  const categories = [...byCategory.values()]
    .map(c => ({
      ...c,
      totalValue: round2(c.totalValue),
      products: c.products.sort((a, b) => b.value - a.value || String(a.name).localeCompare(String(b.name), 'pl'))
    }))
    .sort((a, b) => b.totalValue - a.totalValue || a.category.localeCompare(b.category, 'pl'));

  return {
    categories,
    totalQty,
    totalValue: round2(totalValue),
    productCount: categories.reduce((s, c) => s + c.products.length, 0),
    // Ile sztuk ma poznany koszt — gdy < totalQty, część stanu jest wyceniona na 0 zł.
    pricedQty,
    unpricedQty: totalQty - pricedQty
  };
}

// ===== Podsumowanie ruchów wg rodzaju (raport okresowy) =====
//
// Czysta agregacja nad listą ruchów (już zawężoną przez wołającego do okresu i
// kategorii Magazynu): zlicza ruchy, sumuje ilości i liczy unikalne towary per
// rodzaj (receipt/delivery/internal/scrap/adjustment/conversion/opening).
export function summarizeMovesByKind(moves) {
  const byKind = new Map();
  const seenItems = new Map(); // kind -> Set(itemCode)
  let totalMoves = 0;
  let totalQty = 0;

  for (const m of Array.isArray(moves) ? moves : []) {
    const kind = m.kind || 'internal';
    const qty = Number(m.quantity) || 0;
    if (!byKind.has(kind)) {
      byKind.set(kind, { kind, moves: 0, totalQty: 0, items: 0 });
      seenItems.set(kind, new Set());
    }
    const g = byKind.get(kind);
    g.moves += 1;
    g.totalQty += qty;
    if (m.itemCode != null && m.itemCode !== '') seenItems.get(kind).add(String(m.itemCode));
    totalMoves += 1;
    totalQty += qty;
  }
  for (const [kind, set] of seenItems) byKind.get(kind).items = set.size;

  const rows = [...byKind.values()]
    .sort((a, b) => b.moves - a.moves || a.kind.localeCompare(b.kind));

  return { byKind: rows, totalMoves, totalQty };
}

// ===== Raport progu „prezent ≤20 zł" (VAT) =====
//
// „Prezenty małej wartości" (ustawa o VAT, art. 7 ust. 4) wolno wydawać bez
// naliczania VAT należnego, gdy jednostkowy koszt nabycia ≤ 20 zł netto. Gadżety
// powstają u nas z KONWERSJI (towar→gadżet): koszt jednostkowy gadżetu to
// `producedUnit` zapisany jako `unitPrice` partii cenowej z notą „… · konwersja z
// {kod}" (patrz applyConversionBatches). Raport wyławia gadżety z konwersji, których
// koszt jednostkowy przekracza próg — to pozycje, których wydanie rodzi ryzyko VAT.
//
// Patrzymy tylko na partie z qty > 0 (realnie na stanie). Partie zużyte FIFO to już
// wydany towar, nie bieżące ryzyko. Próg domyślny 20 zł; porównanie ostre (> próg),
// bo dokładnie 20 zł jeszcze mieści się w limicie. Czysta agregacja nad listą pozycji
// (wołający zawęża do kategorii Magazynu).
// Historia przetransferowań (Raportowanie → „Przetworzenia"): co, kiedy i z czego
// zostało przerobione na gadżet. Buduje się z operacji typu `conversion` — tych
// zrobionych w zapleczu i tych odtworzonych z Odoo (importedFrom: 'odoo').
//
// Koszt jednostkowy bierzemy z `conversionDetail.producedUnit` — to koszt, który
// konwersja realnie przeniosła z partii towaru (applyConversionBatches). Operacje
// zaimportowane z historii go nie mają (Odoo nie trzyma tego w eksporcie ruchów),
// więc wychodzą z `unitCost: null` i UI pokazuje tam kreskę zamiast zmyślonej kwoty.
//
// Czysta funkcja nad listą operacji i mapą produktów — wołający dostarcza dane.
export function computeConversionHistory(operations, itemsByCode = new Map()) {
  const nazwa = (kod) => itemsByCode.get(kod)?.name || kod || '';
  const kategoria = (kod) => itemsByCode.get(kod)?.category || '';
  const rows = [];

  for (const op of Array.isArray(operations) ? operations : []) {
    if (op.type !== 'conversion' || op.state !== 'done') continue;
    const detail = new Map(
      (Array.isArray(op.conversionDetail) ? op.conversionDetail : [])
        .map(d => [`${d.sourceCode}>${d.targetCode}`, d])
    );

    for (const ln of Array.isArray(op.lines) ? op.lines : []) {
      const sourceCode = String(ln.itemCode || '');
      const targetCode = String(ln.targetItemCode || '');
      if (!sourceCode || !targetCode) continue;
      const qty = Number(ln.quantity) || 0;
      const d = detail.get(`${sourceCode}>${targetCode}`) || null;
      const unitCost = d && Number.isFinite(Number(d.producedUnit)) ? Number(d.producedUnit) : null;

      rows.push({
        operationId: String(op._id || ''),
        reference: op.reference || '',
        when: op.doneAt || op.updatedAt || null,
        sourceCode,
        sourceName: nazwa(sourceCode),
        sourceCategory: kategoria(sourceCode),
        targetCode,
        targetName: nazwa(targetCode),
        targetCategory: kategoria(targetCode),
        qty,
        unitCost,
        value: unitCost == null ? null : Math.round(unitCost * qty * 100) / 100,
        actorEmail: op.doneByEmail || op.createdByEmail || '',
        sourceDocument: op.sourceDocument || '',
        imported: op.importedFrom === 'odoo'
      });
    }
  }

  rows.sort((a, b) => new Date(b.when || 0) - new Date(a.when || 0));

  const suma = rows.reduce((acc, r) => ({
    sztuk: acc.sztuk + r.qty,
    wartosc: acc.wartosc + (r.value || 0),
    zWyceną: acc.zWyceną + (r.value == null ? 0 : 1)
  }), { sztuk: 0, wartosc: 0, zWyceną: 0 });

  return {
    rows,
    total: {
      operations: new Set(rows.map(r => r.operationId)).size,
      lines: rows.length,
      qty: suma.sztuk,
      value: Math.round(suma.wartosc * 100) / 100,
      linesWithoutCost: rows.length - suma.zWyceną
    }
  };
}

export const GIFT_VAT_THRESHOLD = 20;

// Partia pochodzi z konwersji towar→gadżet (nota nadana w applyConversionBatches).
// Uwaga: „Zwrot z konwersji …" (cofnięcie) trafia na towar, nie gadżet, i nie zawiera
// frazy „konwersja z ”, więc nie jest tu mylnie łapany.
export function isConversionBatch(note) {
  return String(note || '').includes('konwersja z ');
}

export function computeGiftThresholdReport(items, threshold = GIFT_VAT_THRESHOLD) {
  const raw = Number(threshold);
  const limit = Number.isFinite(raw) && raw >= 0 ? raw : GIFT_VAT_THRESHOLD;
  const rows = [];
  let conversionItemCount = 0; // gadżety z dowolną partią konwersyjną na stanie (kontekst)

  for (const it of Array.isArray(items) ? items : []) {
    const batches = (Array.isArray(it.priceBatches) ? it.priceBatches : [])
      .filter(b => isConversionBatch(b.note) && (Number(b.qty) || 0) > 0);
    if (!batches.length) continue;
    conversionItemCount += 1;

    const over = batches.filter(b => (Number(b.unitPrice) || 0) > limit);
    if (!over.length) continue;

    const overQty = over.reduce((s, b) => s + (Number(b.qty) || 0), 0);
    const overValue = over.reduce((s, b) => s + (Number(b.qty) || 0) * (Number(b.unitPrice) || 0), 0);
    const maxUnitPrice = over.reduce((m, b) => Math.max(m, Number(b.unitPrice) || 0), 0);

    rows.push({
      itemCode: it.itemCode,
      name: it.name || '',
      category: it.category || '',
      maxUnitPrice: round2(maxUnitPrice),
      overQty,
      overValue: round2(overValue),
      batches: over
        .map(b => ({
          qty: Number(b.qty) || 0,
          unitPrice: round2(Number(b.unitPrice) || 0),
          note: b.note || '',
          addedAt: b.addedAt || null
        }))
        .sort((a, b) => b.unitPrice - a.unitPrice)
    });
  }

  rows.sort((a, b) => b.maxUnitPrice - a.maxUnitPrice
    || String(a.name).localeCompare(String(b.name), 'pl'));

  return {
    threshold: limit,
    items: rows,
    summary: {
      threshold: limit,
      riskItemCount: rows.length,
      riskQty: rows.reduce((s, r) => s + r.overQty, 0),
      riskValue: round2(rows.reduce((s, r) => s + r.overValue, 0)),
      conversionItemCount
    }
  };
}

// ===== Health-check spójności stanu (cache vs quanty vs partie cenowe) =====
//
// Diagnostyka, nie przepływ. Dla każdego produktu Magazynu zestawia trzy niezależnie
// utrzymywane liczby i pokazuje, gdzie się rozjeżdżają:
//   • `items.quantity` (cache),
//   • Σ `quants.quantity` na lokalizacjach realnych (internal/employee),
//   • Σ `priceBatches[].qty`.
// Te trzy powinny się zgadzać dla towaru prowadzonego ruchami; rozjazd wskazuje stałą
// cache po awarii, import bez ruchów (partie bez quantów) albo dane sprzed Fazy 0.
// Dodatkowo wyłapuje quanty ujemne NA STANIE REALNYM (lokalizacje wirtualne mogą
// schodzić < 0 z definicji — to nie błąd) oraz quanty-sieroty (nieznany `itemCode`
// albo nieistniejąca lokalizacja). Akcja „przelicz" (po stronie endpointu) woła
// recomputeQuants + refreshItemCache — odtwarza quanty z rejestru ruchów i synchronizuje
// cache. Czysta agregacja: wołający podaje produkty już zawężone do kategorii Magazynu,
// wszystkie quanty, lokalizacje oraz pełny zbiór znanych kodów (do wykrycia sierot).
export function computeStockHealth({ products = [], quants = [], locations = [], knownItemCodes = [] } = {}) {
  const stockableLocIds = new Set();
  const locNameById = new Map();
  for (const loc of locations) {
    const id = String(loc._id);
    locNameById.set(id, loc.name || id);
    if (isStockableKind(loc.kind)) stockableLocIds.add(id);
  }
  const known = knownItemCodes instanceof Set
    ? new Set([...knownItemCodes].map(String))
    : new Set((knownItemCodes || []).map(String));

  // Quanty pogrupowane wg produktu: suma na stanie realnym + obecność jakiegokolwiek quanta.
  const quantStockByItem = new Map();
  const hasQuantByItem = new Set();
  for (const q of quants) {
    const code = String(q.itemCode);
    hasQuantByItem.add(code);
    if (stockableLocIds.has(String(q.locationId))) {
      quantStockByItem.set(code, (quantStockByItem.get(code) || 0) + (Number(q.quantity) || 0));
    }
  }

  const mismatches = [];
  for (const it of Array.isArray(products) ? products : []) {
    const code = String(it.itemCode);
    const cacheQty = Number(it.quantity) || 0;
    const quantStockSum = quantStockByItem.get(code) || 0;
    const batches = Array.isArray(it.priceBatches) ? it.priceBatches : [];
    const hasBatches = batches.length > 0;
    const batchSum = batches.reduce((s, b) => s + (Number(b.qty) || 0), 0);

    // Każdy rozjeżdżający się PARÓW źródeł osobno — czytelny sygnał, która dwójka się nie zgadza.
    const issues = [];
    if (cacheQty !== quantStockSum) issues.push('cache_vs_quant');
    if (hasBatches && batchSum !== cacheQty) issues.push('batch_vs_cache');
    if (hasBatches && batchSum !== quantStockSum) issues.push('batch_vs_quant');
    if (!issues.length) continue;

    mismatches.push({
      itemCode: code,
      name: it.name || '',
      category: it.category || '',
      cacheQty,
      quantStockSum,
      batchSum,
      hasBatches,
      hasQuants: hasQuantByItem.has(code),
      issues
    });
  }
  mismatches.sort((a, b) => String(a.itemCode).localeCompare(String(b.itemCode), 'pl'));

  // Anomalie quantów (po wszystkich quantach, nie tylko produktach Magazynu).
  const negativeQuants = [];
  const orphanQuants = [];
  for (const q of Array.isArray(quants) ? quants : []) {
    const code = String(q.itemCode);
    const locId = String(q.locationId);
    const qty = Number(q.quantity) || 0;
    if (stockableLocIds.has(locId) && qty < 0) {
      negativeQuants.push({ itemCode: code, locationId: locId, locationName: locNameById.get(locId) || locId, quantity: qty });
    }
    const reasons = [];
    if (!known.has(code)) reasons.push('item');
    if (!locNameById.has(locId)) reasons.push('location');
    if (reasons.length) {
      orphanQuants.push({ itemCode: code, locationId: locId, locationName: locNameById.get(locId) || null, quantity: qty, reasons });
    }
  }
  negativeQuants.sort((a, b) => String(a.itemCode).localeCompare(String(b.itemCode), 'pl'));
  orphanQuants.sort((a, b) => String(a.itemCode).localeCompare(String(b.itemCode), 'pl'));

  return {
    mismatches,
    negativeQuants,
    orphanQuants,
    summary: {
      productCount: Array.isArray(products) ? products.length : 0,
      mismatchCount: mismatches.length,
      negativeQuantCount: negativeQuants.length,
      orphanQuantCount: orphanQuants.length,
      ok: mismatches.length === 0 && negativeQuants.length === 0 && orphanQuants.length === 0
    }
  };
}

// ===== Aging zalegania (wiek warstw partii cenowych) =====
//
// Ile stanu i jakiej wartości „leży" długo. Wiek liczymy z `priceBatches[].addedAt`
// (warstwy FIFO mają datę) względem `now` podanego przez wołającego (deterministyczne
// w testach). Liczą się tylko warstwy z qty > 0 — zużyte FIFO to już wydany towar.
// Kubełki: ≤30 / 31–90 / 91–180 / >180 dni. UWAGA: `addedAt` to data WEJŚCIA warstwy do
// systemu, nie zawsze zakupu — warstwy „Stan początkowy" i import dostają datę zapisu.
// Warstwa bez poprawnej daty trafia do najstarszego kubełka (>180) — zalegający stan bez
// daty traktujemy ostrożnie jako stary. Czysta agregacja (wołający zawęża do Magazynu).
const AGING_BANDS = [
  { key: 'le30', label: '≤30 dni', max: 30 },
  { key: 'd31_90', label: '31–90 dni', max: 90 },
  { key: 'd91_180', label: '91–180 dni', max: 180 },
  { key: 'gt180', label: '>180 dni', max: Infinity }
];

const DAY_MS = 24 * 60 * 60 * 1000;

function agingBandKey(ageDays) {
  for (const b of AGING_BANDS) {
    if (ageDays <= b.max) return b.key;
  }
  return 'gt180';
}

export function computeAging(items, now = new Date()) {
  const ref = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const refMs = ref.getTime();

  const bands = new Map(AGING_BANDS.map(b => [b.key, { key: b.key, label: b.label, qty: 0, value: 0 }]));
  const products = [];
  let totalQty = 0;
  let totalValue = 0;

  for (const it of Array.isArray(items) ? items : []) {
    const layers = (Array.isArray(it.priceBatches) ? it.priceBatches : [])
      .filter(b => (Number(b.qty) || 0) > 0);
    if (!layers.length) continue;

    let pQty = 0;
    let pValue = 0;
    let oldestDays = 0;
    let agedQty = 0;   // >180 dni
    let agedValue = 0;

    for (const b of layers) {
      const qty = Number(b.qty) || 0;
      const unit = Number(b.unitPrice) || 0;
      const value = qty * unit;
      const t = b.addedAt ? new Date(b.addedAt).getTime() : NaN;
      // Brak/zła data → wiek nieskończony (najstarszy kubełek).
      const ageDays = Number.isNaN(t) ? Infinity : Math.max(0, Math.floor((refMs - t) / DAY_MS));

      const band = bands.get(agingBandKey(ageDays));
      band.qty += qty;
      band.value += value;

      pQty += qty;
      pValue += value;
      if (ageDays > oldestDays) oldestDays = ageDays;
      if (ageDays > 180) { agedQty += qty; agedValue += value; }
    }

    totalQty += pQty;
    totalValue += pValue;
    products.push({
      itemCode: it.itemCode,
      name: it.name || '',
      category: it.category || '',
      qty: pQty,
      value: round2(pValue),
      oldestDays: Number.isFinite(oldestDays) ? oldestDays : null, // null = warstwa bez daty
      agedQty,
      agedValue: round2(agedValue)
    });
  }

  // Najpierw najbardziej zalegające (bez daty → traktowane jako najstarsze), potem wartość.
  products.sort((a, b) =>
    (b.oldestDays === null ? Infinity : b.oldestDays) - (a.oldestDays === null ? Infinity : a.oldestDays)
    || b.agedValue - a.agedValue
    || String(a.itemCode).localeCompare(String(b.itemCode), 'pl'));

  const bandRows = AGING_BANDS.map(b => {
    const r = bands.get(b.key);
    return { key: r.key, label: r.label, qty: r.qty, value: round2(r.value) };
  });

  return {
    bands: bandRows,
    products,
    totalQty,
    totalValue: round2(totalValue),
    productCount: products.length,
    // Skrót: ile „leży" >180 dni (suma kubełka gt180).
    agedQty: bands.get('gt180').qty,
    agedValue: round2(bands.get('gt180').value)
  };
}
