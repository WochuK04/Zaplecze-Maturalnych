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
 * — warstwami, które zdjął FIFO (`consumed`). Obie odpowiedzi mogą nie istnieć i to
 * NIE jest to samo co zero: dokumenty odtworzone z Odoo (`importedFrom`) nie niosą
 * kosztów, bo Odoo nie podaje ich w eksporcie ruchów. Raport musi umieć powiedzieć
 * „nie wiem, bo import", zamiast pokazywać gołą kreskę, którą czyta się jak błąd —
 * dokładnie to zgłoszenie przyszło z Magazynu („eksport nie pobiera cen i wartości").
 *
 * @returns {{ batches: object[]|null, unpriced: null|'import'|'brak-danych' }}
 */
export function movePriceBatches(op, move) {
  if (!op) return { batches: null, unpriced: 'brak-danych' };
  const { added, consumed } = pricesFromOperation(op, move);
  const batches = consumed?.length ? consumed : (added?.length ? added : null);
  if (batches) return { batches, unpriced: null };
  return { batches: null, unpriced: op.importedFrom ? 'import' : 'brak-danych' };
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
