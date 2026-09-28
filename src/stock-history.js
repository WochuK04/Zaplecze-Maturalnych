// Odtwarzanie stanu magazynu na wskazany dzień („stan na dzień").
//
// Po co: `quants` trzymają stan BIEŻĄCY. Pytanie „ile czego mieliśmy 31.08" wymaga
// przewinięcia rejestru ruchów do tamtej chwili. Rejestr jest append-only (cofnięcie
// operacji dopisuje storno, nie kasuje ruchów — patrz reverseOperation), więc raz
// wyeksportowany stan na dzień pozostaje prawdziwy.
//
// Dwie warstwy:
//   1. ILOŚCI — dokładne. Suma ruchów do końca danego dnia, per (produkt, lokalizacja, partia).
//      To ta sama arytmetyka co recomputeQuants, tylko z filtrem daty.
//   2. WARTOŚĆ — best-effort. Partie cenowe (`items.priceBatches`) są nadpisywane w miejscu,
//      więc ich historii nie ma; odtwarzamy ją, przegrywając ruchy po kolei i czytając ceny
//      z dokumentów (przyjęcie → lines.unitPrice, rozchód → *Detail.consumed). Gdy dokumentu
//      brakuje albo nie zapisał detalu (stare operacje sprzed wprowadzenia partii), wpadamy
//      w przybliżenie i oznaczamy produkt `valueExact: false`. Eksport to pokazuje.
//
// Funkcja `replayStockAt` jest czysta (bez Mongo) — cała logika jest testowalna
// jednostkowo, tak jak fifoConsume.

import { LOCATION_KINDS, isStockableKind } from './stock.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const quantKey = (itemCode, locationId, lot) => `${itemCode}::${locationId}::${lot ?? ''}`;

// Dokłada warstwy na koniec kolejki FIFO (najnowsze schodzą ostatnie).
function addLayers(layers, entries) {
  for (const e of entries) {
    const qty = Number(e.qty) || 0;
    if (qty <= 0) continue;
    layers.push({ qty, unitPrice: Number(e.unitPrice) || 0 });
  }
}

// Zdejmuje `qty` z kolejki. `preferPrice` obsługuje storno: cofnięcie przyjęcia ma
// zdjąć to, co TO przyjęcie dołożyło, a nie najstarszą warstwę — więc najpierw
// szukamy od końca warstwy w tej samej cenie, a dopiero resztę bierzemy FIFO.
// Zwraca { consumed, cost, short } — `short` to ilość, na którą zabrakło warstw
// (stan bez pokrycia w cenach, np. sprzed wprowadzenia partii).
function takeLayers(layers, qty, preferPrice = null) {
  let left = Number(qty) || 0;
  const consumed = [];
  let cost = 0;

  const take = (idx, amount) => {
    const layer = layers[idx];
    layer.qty -= amount;
    cost += amount * layer.unitPrice;
    consumed.push({ qty: amount, unitPrice: layer.unitPrice });
    left -= amount;
  };

  if (preferPrice != null) {
    for (let i = layers.length - 1; i >= 0 && left > 0; i -= 1) {
      if (layers[i].qty <= 0 || layers[i].unitPrice !== preferPrice) continue;
      take(i, Math.min(layers[i].qty, left));
    }
  }
  for (let i = 0; i < layers.length && left > 0; i += 1) {
    if (layers[i].qty <= 0) continue;
    take(i, Math.min(layers[i].qty, left));
  }

  const short = left > 0 ? left : 0;
  // Warstwy wyzerowane wypadają z kolejki (jak w fifoConsume + filtrze wywołujących).
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    if (layers[i].qty <= 0) layers.splice(i, 1);
  }
  return { consumed, cost: round2(cost), short };
}

// Ceny, jakie dokument przypisuje danemu ruchowi. Zwraca:
//   added    – warstwy do dołożenia (gdy ruch zwiększa stan fizyczny)
//   consumed – warstwy zdjęte przez oryginalną operację (gdy zmniejsza), jeśli zapisano detal
// Brak informacji = null, wywołujący wpada wtedy w przybliżenie.
export function pricesFromOperation(op, move) {
  if (!op) return { added: null, consumed: null };
  const code = move.itemCode;

  if (op.type === 'receipt') {
    const line = (op.lines || []).find(l => String(l.itemCode) === code);
    if (line && line.unitPrice != null) {
      return { added: [{ qty: move.quantity, unitPrice: Number(line.unitPrice) || 0 }], consumed: null };
    }
    return { added: null, consumed: null };
  }

  if (op.type === 'delivery' || op.type === 'scrap') {
    const detail = op.type === 'delivery' ? op.deliveryDetail : op.scrapDetail;
    const d = Array.isArray(detail) ? detail.find(x => String(x.itemCode) === code) : null;
    return { added: null, consumed: d?.consumed?.length ? d.consumed : null };
  }

  if (op.type === 'conversion' && Array.isArray(op.conversionDetail)) {
    const asSource = op.conversionDetail.find(x => String(x.sourceCode) === code);
    if (asSource?.consumed?.length) return { added: null, consumed: asSource.consumed };
    const asTarget = op.conversionDetail.find(x => String(x.targetCode) === code);
    if (asTarget) {
      const qty = Number(asTarget.qty) || 0;
      const cost = (asTarget.consumed || []).reduce((s, c) => s + (Number(c.qty) || 0) * (Number(c.unitPrice) || 0), 0);
      return { added: [{ qty: move.quantity, unitPrice: qty > 0 ? round2(cost / qty) : 0 }], consumed: null };
    }
  }

  if (op.type === 'adjustment' && Array.isArray(op.adjustmentDetail)) {
    const d = op.adjustmentDetail.find(x => String(x.itemCode) === code);
    if (d?.consumed?.length) return { added: null, consumed: d.consumed };
    if (d?.added) return { added: [{ qty: move.quantity, unitPrice: Number(d.added.unitPrice) || 0 }], consumed: null };
  }

  return { added: null, consumed: null };
}

/**
 * Partie cenowe pojedynczego ruchu — do raportów, które pokazują cenę obok ilości.
 *
 * Ruch zwiększający stan wycenia się warstwami, które wniósł (`added`); zmniejszający
 * — warstwami, które zdjął FIFO (`consumed`). Dokumenty odtworzone z Odoo własnych cen
 * nie mają (eksport ruchów z Odoo nie niesie kosztu) — takim ruchom cenę dokłada
 * `assignFifoPrices`, już z partii kartoteki.
 *
 * @returns {{ batches: object[]|null, source: 'dokument'|null,
 *             unpriced: null|'import'|'brak-danych' }}
 */
export function movePriceBatches(op, move) {
  const { added, consumed } = op ? pricesFromOperation(op, move) : { added: null, consumed: null };
  const batches = consumed?.length ? consumed : (added?.length ? added : null);
  if (batches) return { batches, source: 'dokument', unpriced: null };
  return { batches: null, source: null, unpriced: op?.importedFrom ? 'import' : 'brak-danych' };
}

const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/**
 * Kolejka FIFO z partii cenowych kartoteki.
 *
 * Kolejność zapisu partii JEST kolejnością FIFO — tak konsumuje je `fifoConsume`
 * przy realnych wydaniach i konwersjach, więc raport nie ma prawa układać ich inaczej.
 * `ostatniaCena` jest zapasem na sytuację, gdy historia zdejmie więcej, niż zostało
 * warstw: partie opisują stan DZISIEJSZY, a ruchy sięgają wstecz, więc kolejka
 * potrafi się wyczerpać wcześniej niż lista ruchów.
 */
export function newFifoQueue(batches) {
  const partie = (Array.isArray(batches) ? batches : [])
    .map(b => ({ qty: Number(b.qty) || 0, unitPrice: Number(b.unitPrice) || 0 }));
  return {
    warstwy: partie.filter(b => b.qty > 0),
    ostatniaCena: partie.length ? partie[partie.length - 1].unitPrice : null
  };
}

/** Zdejmuje `qty` z kolejki FIFO i zwraca warstwy, które na to poszły. */
export function takeFifoLayers(queue, qty) {
  let left = round3(qty) > 0 ? round3(qty) : 0;
  const layers = [];
  while (left > 0 && queue.warstwy.length) {
    const w = queue.warstwy[0];
    const take = Math.min(left, w.qty);
    if (take > 0) {
      layers.push({ qty: round3(take), unitPrice: w.unitPrice });
      queue.ostatniaCena = w.unitPrice;
      w.qty = round3(w.qty - take);
      left = round3(left - take);
    }
    if (w.qty <= 0) queue.warstwy.shift();
  }
  // Kolejka pusta, a ruch jeszcze trwa — dociągamy po ostatniej znanej cenie warstwy.
  if (left > 0 && queue.ostatniaCena != null) layers.push({ qty: left, unitPrice: queue.ostatniaCena });
  return layers;
}

/**
 * Dokłada ceny ruchom, których dokument ich nie niesie (historia odtworzona z Odoo).
 *
 * Reguła to FIFO, a nie średnia: kolumna nazywa się „Cena wg partii" i ma pokazywać
 * partie, a uśrednienie właśnie je zaciera — ruch 9,5 kg krówek to 4,5 kg po 22,10 zł
 * i 5 kg po 24,00 zł, nie 9,5 kg po 23,10 zł. Tak samo liczy każde realne wydanie
 * (`fifoConsume`), więc raport i magazyn mówią jednym językiem.
 *
 * Ruchy idą chronologicznie, od najstarszego, i zdejmują ze wspólnej kolejki per
 * kartoteka — inaczej każdy ruch zjadałby tę samą pierwszą partię i wartości by się
 * dublowały. Ruchy z ceną z dokumentu kolejki nie ruszają: wiedzą swoje.
 *
 * Ograniczenie, które trzeba znać: partie opisują stan dzisiejszy, bo tylko taki
 * przyszedł z Odoo. Warstw sprzed importu nie ma i nikt ich nie odtworzy — wycena
 * historii jest więc przybliżeniem i dlatego wiersz dostaje `source: 'fifo'`.
 */
export function assignFifoPrices(rows, batchesByCode = new Map()) {
  const kolejki = new Map();
  const kolejka = (kod) => {
    if (!kolejki.has(kod)) kolejki.set(kod, newFifoQueue(batchesByCode.get(kod)));
    return kolejki.get(kod);
  };

  const doWyceny = (Array.isArray(rows) ? rows : [])
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !(r.priceBatches && r.priceBatches.length))
    .sort((a, b) => (new Date(a.r.doneAt || 0) - new Date(b.r.doneAt || 0)) || (a.i - b.i));

  for (const { r } of doWyceny) {
    const q = kolejka(r.itemCode);
    if (q.ostatniaCena == null) continue; // kartoteka bez partii — nie ma czym wycenić
    const layers = takeFifoLayers(q, r.quantity);
    if (!layers.length) continue;
    r.priceBatches = layers;
    r.source = 'fifo';
    r.unpriced = null;
  }
  return rows;
}

/**
 * Przewija rejestr ruchów i zwraca stan na koniec wskazanego dnia.
 *
 * @param {object[]} moves       ruchy z doneAt <= koniec dnia, POSORTOWANE rosnąco
 * @param {object[]} locations   [{ id, kind, name, code }]
 * @param {Map}      opById      operationId -> dokument operacji (typ, lines, *Detail)
 * @returns {{ rows, byItem }}   rows: stan per (produkt, lokalizacja, partia);
 *                               byItem: ilość, wartość i flaga dokładności wyceny
 */
export function replayStockAt({ moves = [], locations = [], opById = new Map() } = {}) {
  const kindById = new Map(locations.map(l => [String(l.id), l.kind]));
  const isPhysical = (locId) => (locId ? isStockableKind(kindById.get(String(locId))) : false);

  const quants = new Map();      // (produkt, lokalizacja, partia) -> ilość
  const layersByItem = new Map(); // produkt -> kolejka FIFO
  const inexact = new Set();      // produkty, dla których wycena jest przybliżona

  const layersFor = (code) => {
    if (!layersByItem.has(code)) layersByItem.set(code, []);
    return layersByItem.get(code);
  };

  for (const m of moves) {
    const code = String(m.itemCode);
    const qty = Number(m.quantity) || 0;
    if (!code || qty <= 0) continue;
    const lot = m.lot ?? null;

    // --- ilości: dokładnie jak recomputeQuants ---
    for (const [locId, sign] of [[m.fromLocationId, -1], [m.toLocationId, 1]]) {
      if (!locId) continue;
      const k = quantKey(code, String(locId), lot);
      quants.set(k, {
        itemCode: code,
        locationId: String(locId),
        lot,
        quantity: (quants.get(k)?.quantity || 0) + sign * qty
      });
    }

    // --- wartość: zmienia się tylko, gdy zmienia się stan FIZYCZNY ---
    // Przesunięcie między dwiema realnymi lokalizacjami nic nie zmienia w wycenie.
    const delta = (isPhysical(m.toLocationId) ? qty : 0) - (isPhysical(m.fromLocationId) ? qty : 0);
    if (delta === 0) continue;

    const layers = layersFor(code);
    const op = m.operationId ? opById.get(String(m.operationId)) : null;
    const { added, consumed } = pricesFromOperation(op, m);

    if (delta > 0) {
      if (m.isReversal) {
        // Storno rozchodu: oddajemy warstwy, które rozchód zdjął.
        if (consumed?.length) addLayers(layers, consumed);
        else { addLayers(layers, [{ qty: delta, unitPrice: averagePrice(layers) }]); inexact.add(code); }
      } else if (added?.length) {
        addLayers(layers, added);
      } else {
        addLayers(layers, [{ qty: delta, unitPrice: 0 }]);
        inexact.add(code);
      }
    } else {
      const want = -delta;
      if (m.isReversal && added?.length) {
        // Storno przyjęcia: zdejmujemy po cenie, którą to przyjęcie wniosło.
        const { short } = takeLayers(layers, want, Number(added[0].unitPrice) || 0);
        if (short > 0) inexact.add(code);
      } else {
        const { short } = takeLayers(layers, want);
        if (short > 0) inexact.add(code);
      }
    }
  }

  const rows = [...quants.values()].filter(q => q.quantity !== 0);

  const byItem = new Map();
  for (const r of rows) {
    if (!isPhysical(r.locationId)) continue;
    const prev = byItem.get(r.itemCode) || { itemCode: r.itemCode, quantity: 0, value: 0, valueExact: true };
    prev.quantity += r.quantity;
    byItem.set(r.itemCode, prev);
  }
  for (const [code, agg] of byItem) {
    const layers = layersByItem.get(code) || [];
    agg.value = round2(layers.reduce((s, l) => s + l.qty * l.unitPrice, 0));
    agg.layers = layers.map(l => ({ qty: l.qty, unitPrice: l.unitPrice }));
    // Wycena jest wiarygodna tylko wtedy, gdy kolejka warstw zgadza się ze stanem.
    const layersQty = layers.reduce((s, l) => s + l.qty, 0);
    agg.valueExact = !inexact.has(code) && round2(layersQty) === round2(agg.quantity);
  }

  return { rows, byItem };
}

function averagePrice(layers) {
  const qty = layers.reduce((s, l) => s + l.qty, 0);
  if (qty <= 0) return 0;
  return round2(layers.reduce((s, l) => s + l.qty * l.unitPrice, 0) / qty);
}

// Koniec wskazanego dnia w formacie RRRR-MM-DD. Zwraca null dla śmieci na wejściu.
export function endOfDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T23:59:59.999`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export { LOCATION_KINDS };
