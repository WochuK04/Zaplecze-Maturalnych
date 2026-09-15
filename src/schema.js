export const collections = {
  users: 'users',
  items: 'items',
  loans: 'loans',
  loanRequests: 'loanRequests',
  auditLogs: 'auditLogs',
  locations: 'locations',
  comments: 'comments',
  notifications: 'notifications',

  // Magazyn „w stylu Odoo" (Faza 0 – fundament: stan = suma ruchów).
  warehouses: 'warehouses',
  stockMoves: 'stockMoves',
  quants: 'quants',
  stockOperations: 'stockOperations',
  lots: 'lots',
  inventoryAdjustments: 'inventoryAdjustments',
  reorderRules: 'reorderRules',
  counters: 'counters',
  suppliers: 'suppliers',
  deliveryDestinations: 'deliveryDestinations',
  // Słownik „ten tekst z faktury = ten produkt". Uczy się z ręcznych poprawek przy
  // imporcie faktur, żeby kolejna faktura od tego samego dostawcy trafiała od razu.
  invoiceAliases: 'invoiceAliases',

  // Wyjazdy (eventy edukacyjne, np. Turbo Weekend) w miastach + lista pakowania
  // (ile czego zabrać wg liczby uczestników) + stan spakowania/powrotu.
  turboWeekends: 'turboWeekends',
  packingItems: 'packingItems',
  packingProgress: 'packingProgress',

  // Licencje / subskrypcje: koszty (mies./rok), stanowiska, odnowienia, dostępy
  // (login + URL + notatka „gdzie hasło" — haseł NIE trzymamy w bazie).
  licenses: 'licenses',

  // === Mapa dostępów ===
  // Podmioty / marki (maturalni.com, korki.pl, …) — właściciel biznesowy licencji.
  entities: 'entities',
  // Tożsamości: konta, KTÓRYMI się logujemy (nie usługi, DO których). Brakujące
  // ogniwo modelu — odpowiada na „co przestanie działać, gdy padnie to konto".
  // NIE trzymamy sekretów: `backupCodesAt` to lokalizacja, `recoveryPhoneSet` to flaga.
  identities: 'identities',
  // Dostępy: tabela łącząca użytkownik (email) × licencja. Zastępuje pole „Używają".
  accesses: 'accesses',
  // Konfiguracja modułu (m.in. kursy walut → PLN). Jeden dokument na klucz.
  settings: 'settings'
};

export const itemShape = {
  itemCode: 'K004',
  category: 'Kamera',
  name: 'Logitech C920',
  details: 'Webcam Full HD',
  quantity: 1,
  // Jednostka miary (Magazyn). Brak pola = „szt." — patrz src/lib/units.js.
  unit: 'szt.',
  currentLocation: 'Magazyn',
  operationalStatus: 'available',
  conditionStatus: 'good',
  assignedToName: null,
  assignedToEmail: null,
  notes: '',

  imageUrl: '',
  thumbnailUrl: '',
  brand: '',
  model: '',
  qrCodeValue: '',
  tags: [],
  serialNumber: '',
  warrantyUntil: '',
  detailedLocation: '',
  isStudioLocked: false,

  // Partie cenowe (produkty Magazynu): zakup tej samej pozycji w transzach po
  // różnych cenach. Gdy niepuste, łączna `quantity` = suma `qty` partii.
  priceBatches: [], // [{ qty, unitPrice, note, addedAt }]

  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date()
};

export async function ensureIndexes(db) {
  await db.collection(collections.users).createIndexes([
    { key: { email: 1 }, unique: true, name: 'uniq_user_email' },
    // `externalId` (OS-001…) — dopasowanie przy idempotentnym imporcie z CSV.
    { key: { externalId: 1 }, unique: true, sparse: true, name: 'uniq_user_external' }
  ]);

  await db.collection(collections.items).createIndexes([
    { key: { itemCode: 1 }, unique: true, name: 'uniq_item_code' },
    { key: { category: 1, name: 1 }, name: 'idx_item_category_name' },
    { key: { operationalStatus: 1, currentLocation: 1 }, name: 'idx_item_status_location' },
    { key: { isActive: 1, operationalStatus: 1 }, name: 'idx_item_active_status' }
  ]);

  await db.collection(collections.invoiceAliases).createIndexes([
    // Jeden tekst faktury wskazuje dokładnie jeden produkt — ostatnia decyzja wygrywa.
    { key: { normalized: 1 }, unique: true, name: 'uniq_invoice_alias' },
    { key: { itemCode: 1 }, name: 'idx_invoice_alias_item' }
  ]);

  await db.collection(collections.loans).createIndexes([
    { key: { userEmail: 1, status: 1 }, name: 'idx_loans_user_status' },
    { key: { itemCode: 1, status: 1 }, name: 'idx_loans_item_status' },
    { key: { borrowedAt: -1 }, name: 'idx_loans_borrowed_at' }
  ]);

  await db.collection(collections.loanRequests).createIndexes([
    { key: { requesterEmail: 1, status: 1 }, name: 'idx_lr_requester_status' },
    { key: { approverEmail: 1, status: 1 }, name: 'idx_lr_approver_status' },
    { key: { status: 1, requestedAt: -1 }, name: 'idx_lr_status_requested' }
  ]);

  await db.collection(collections.auditLogs).createIndexes([
    { key: { entityType: 1, entityId: 1, createdAt: -1 }, name: 'idx_audit_entity' },
    { key: { actorEmail: 1, createdAt: -1 }, name: 'idx_audit_actor' },
    { key: { createdAt: -1 }, name: 'idx_audit_created_at' }
  ]);

  await db.collection(collections.locations).createIndexes([
    { key: { name: 1 }, unique: true, name: 'uniq_location_name' },
    // Hierarchia „w stylu Odoo": kod ścieżki (WH/Stock/PolkaA), rodzic, przodkowie.
    { key: { code: 1 }, unique: true, sparse: true, name: 'uniq_location_code' },
    { key: { parentId: 1 }, name: 'idx_location_parent' },
    { key: { ancestors: 1 }, name: 'idx_location_ancestors' },
    { key: { kind: 1, isActive: 1 }, name: 'idx_location_kind_active' }
  ]);

  // Komentarze do wniosku (Pakiet C – wątek dyskusji wnioskodawca/decydent).
  await db.collection(collections.comments).createIndexes([
    { key: { requestId: 1, createdAt: 1 }, name: 'idx_comments_request' }
  ]);

  // Powiadomienia/zgłoszenia dla administracji (zgłoszenia pracowników o sprzęcie
  // + ślad o transferach). status: 'open' | 'resolved'.
  await db.collection(collections.notifications).createIndexes([
    { key: { status: 1, createdAt: -1 }, name: 'idx_notifications_status' }
  ]);

  // === Magazyn „w stylu Odoo" ===

  // Magazyny (grupują lokalizacje; zwykle jeden, ale model dopuszcza wiele).
  await db.collection(collections.warehouses).createIndexes([
    { key: { code: 1 }, unique: true, name: 'uniq_warehouse_code' }
  ]);

  // Rejestr ruchów (append-only) – źródło prawdy o stanie.
  await db.collection(collections.stockMoves).createIndexes([
    { key: { itemCode: 1, doneAt: -1 }, name: 'idx_moves_item_done' },
    { key: { toLocationId: 1, doneAt: -1 }, name: 'idx_moves_to_loc' },
    { key: { fromLocationId: 1, doneAt: -1 }, name: 'idx_moves_from_loc' },
    { key: { lot: 1 }, sparse: true, name: 'idx_moves_lot' },
    { key: { operationId: 1 }, sparse: true, name: 'idx_moves_operation' },
    { key: { kind: 1, doneAt: -1 }, name: 'idx_moves_kind' }
  ]);

  // Stan na lokalizację (materializowany z ruchów). Jeden dokument na (towar, lokalizacja, partia).
  await db.collection(collections.quants).createIndexes([
    { key: { itemCode: 1, locationId: 1, lot: 1 }, unique: true, name: 'uniq_quant_item_loc_lot' },
    { key: { locationId: 1 }, name: 'idx_quant_location' }
  ]);

  // Operacje magazynowe (przyjęcia/wydania/przesunięcia/inwentaryzacja) – Faza 2.
  await db.collection(collections.stockOperations).createIndexes([
    { key: { reference: 1 }, unique: true, name: 'uniq_operation_reference' },
    { key: { type: 1, state: 1, scheduledAt: -1 }, name: 'idx_operation_type_state' }
  ]);

  // Partie / numery seryjne – Faza 3.
  await db.collection(collections.lots).createIndexes([
    { key: { itemCode: 1, name: 1 }, unique: true, name: 'uniq_lot_item_name' }
  ]);

  // Inwentaryzacje (spis z natury) – Faza 3.
  await db.collection(collections.inventoryAdjustments).createIndexes([
    { key: { state: 1, createdAt: -1 }, name: 'idx_inv_adj_state' }
  ]);

  // Reguły uzupełniania zapasów (min-max / orderpoint) – „Zapotrzebowanie".
  // `scope` = 'category' | 'item'; `target` = nazwa kategorii albo itemCode.
  // Jedna reguła na cel (unikalność po scope+target).
  await db.collection(collections.reorderRules).createIndexes([
    { key: { scope: 1, target: 1 }, unique: true, name: 'uniq_reorder_scope_target' },
    { key: { isActive: 1 }, name: 'idx_reorder_active' }
  ]);

  // === Turbo Weekend ===

  // Eventy w miastach: liczba uczestników + pozycja na mapie (lat/lng) + bus.
  await db.collection(collections.turboWeekends).createIndexes([
    { key: { isActive: 1, eventDate: 1 }, name: 'idx_tw_active_date' },
    { key: { city: 1 }, name: 'idx_tw_city' }
  ]);

  // Lista pakowania: pozycje ze współczynnikiem na osobę albo stałą ilością.
  await db.collection(collections.packingItems).createIndexes([
    { key: { isActive: 1, sortOrder: 1 }, name: 'idx_packing_active_sort' },
    { key: { name: 1 }, name: 'idx_packing_name' }
  ]);

  // Stan spakowania/powrotu: jeden dokument na (wyjazd, pozycja listy).
  await db.collection(collections.packingProgress).createIndexes([
    { key: { turboWeekendId: 1, packingItemId: 1 }, unique: true, name: 'uniq_progress_tw_item' },
    { key: { turboWeekendId: 1 }, name: 'idx_progress_tw' }
  ]);

  // === Licencje ===
  await db.collection(collections.licenses).createIndexes([
    { key: { isActive: 1, name: 1 }, name: 'idx_licenses_active_name' },
    { key: { renewalDate: 1 }, name: 'idx_licenses_renewal' },
    // Mapa dostępów: „co zależy od tej tożsamości / podmiotu" + import po externalId.
    { key: { identityId: 1 }, name: 'idx_licenses_identity' },
    { key: { entityId: 1 }, name: 'idx_licenses_entity' },
    { key: { externalId: 1 }, unique: true, sparse: true, name: 'uniq_license_external' }
  ]);

  // === Mapa dostępów ===

  // Podmioty / marki. `externalId` (PD-01…) do idempotentnego importu z CSV.
  await db.collection(collections.entities).createIndexes([
    { key: { name: 1 }, unique: true, name: 'uniq_entity_name' },
    { key: { externalId: 1 }, unique: true, sparse: true, name: 'uniq_entity_external' }
  ]);

  // Tożsamości (konta logowania). `address` = adres/login konta (biuro@…), unikalny.
  await db.collection(collections.identities).createIndexes([
    { key: { address: 1 }, unique: true, name: 'uniq_identity_address' },
    { key: { externalId: 1 }, unique: true, sparse: true, name: 'uniq_identity_external' },
    { key: { entityId: 1 }, name: 'idx_identity_entity' },
    { key: { ownerEmail: 1 }, name: 'idx_identity_owner' },
    { key: { criticality: 1 }, name: 'idx_identity_criticality' }
  ]);

  // Dostępy: para (osoba, licencja) unikalna — jedna osoba ma jeden dostęp do usługi.
  await db.collection(collections.accesses).createIndexes([
    { key: { personEmail: 1, licenseId: 1 }, unique: true, name: 'uniq_access_person_license' },
    { key: { status: 1 }, name: 'idx_access_status' },
    { key: { licenseId: 1 }, name: 'idx_access_license' },
    { key: { externalId: 1 }, unique: true, sparse: true, name: 'uniq_access_external' }
  ]);
}