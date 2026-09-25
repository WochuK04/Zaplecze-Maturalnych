// Dopasowanie pozycji z faktury do produktów w kartotece.
//
// To jest właściwa trudność importu faktur do Magazynu (w module Sprzęt jej nie ma:
// tam każdy wiersz faktury zakłada NOWY rekord, więc nie ma z czym dopasowywać).
// Tutaj wiersz przyjęcia musi wskazać istniejący `itemCode`, bo inaczej nie ma do
// czego doczepić partii cenowej FIFO.
//
// Trzy stopnie, w tej kolejności — najpewniejszy wygrywa:
//   1. ALIAS  – zapamiętane wcześniej „ten tekst z faktury to ten produkt". Człowiek
//               raz poprawił, system pamięta. Najważniejszy stopień: przy drugiej
//               fakturze od tego samego dostawcy trafia od razu.
//   2. EXACT  – znormalizowana nazwa faktury == znormalizowana nazwa produktu.
//   3. FUZZY  – podobieństwo zbiorów słów (Jaccard + premia za zawieranie się).
// Poniżej progu nie zgadujemy: pozycja wraca jako niedopasowana i czeka na człowieka.

// Słowa, które na fakturach są szumem i tylko psują podobieństwo.
const NOISE = new Set([
  'szt', 'sztuk', 'sztuki', 'kpl', 'komplet', 'opak', 'opakowanie', 'kg', 'g', 'ml', 'l',
  'z', 'ze', 'do', 'na', 'w', 'we', 'i', 'oraz', 'dla', 'o', 'a', 'the',
  'nadruk', 'nadrukiem', 'logo', 'wg', 'wzoru', 'projektu', 'kolor', 'kolorze'
]);

/** Sprowadza nazwę do porównywalnej postaci: bez ogonków, znaków i wielkości liter. */
export function normalizeInvoiceName(value) {
  return String(value || '')
    .toLowerCase()
    // ł to osobny znak Unicode, a nie litera z diakrytykiem — NFD go NIE rozłoży,
    // więc bez tej podmiany „Wypełniacz" rozpada się na „wype" + „niacz".
    .replace(/ł/g, 'l')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // ą→a, ż→z, ó→o…
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Zbiór znaczących słów nazwy (bez szumu i bez jednoliterowców). */
export function nameTokens(value) {
  return new Set(
    normalizeInvoiceName(value)
      .split(' ')
      .filter(t => t.length > 1 && !NOISE.has(t))
  );
}

/**
 * Podobieństwo dwóch nazw w skali 0–1. Jaccard na zbiorach słów, podbity, gdy jedna
 * nazwa zawiera się w drugiej — „Długopis plastikowy z nadrukiem E8" ma trafić
 * w „Długopis E8", choć ma dwa razy więcej słów.
 */
export function nameSimilarity(a, b) {
  const A = nameTokens(a);
  const B = nameTokens(b);
  if (!A.size || !B.size) return 0;

  let common = 0;
  for (const t of A) if (B.has(t)) common += 1;
  if (!common) return 0;

  const union = A.size + B.size - common;
  const jaccard = common / union;
  const containment = common / Math.min(A.size, B.size);
  // Zawieranie się waży więcej niż surowy Jaccard, bo faktury są rozwlekłe.
  return Math.round((0.4 * jaccard + 0.6 * containment) * 100) / 100;
}

// Poniżej tego progu wolimy powiedzieć „nie wiem" niż podstawić zły produkt —
// zła partia cenowa na złym produkcie jest trudniejsza do wykrycia niż pusty wiersz.
export const MATCH_THRESHOLD = 0.6;

/**
 * Dobiera produkt do pojedynczej nazwy z faktury.
 *
 * @param {string} invoiceName    nazwa przepisana z faktury
 * @param {object[]} products     [{ itemCode, name, category }]
 * @param {Map<string,string>} aliasByText  znormalizowany tekst faktury -> itemCode
 * @returns {{ itemCode, name, score, source } | null}
 */
export function matchInvoiceLine(invoiceName, products, aliasByText = new Map()) {
  const byCode = new Map(products.map(p => [p.itemCode, p]));

  const aliasCode = aliasByText.get(normalizeInvoiceName(invoiceName));
  if (aliasCode && byCode.has(aliasCode)) {
    const p = byCode.get(aliasCode);
    return { itemCode: p.itemCode, name: p.name, score: 1, source: 'alias' };
  }

  const target = normalizeInvoiceName(invoiceName);
  if (target) {
    const exact = products.find(p => normalizeInvoiceName(p.name) === target);
    if (exact) return { itemCode: exact.itemCode, name: exact.name, score: 1, source: 'exact' };
  }

  let best = null;
  for (const p of products) {
    const score = nameSimilarity(invoiceName, p.name);
    if (!best || score > best.score) best = { itemCode: p.itemCode, name: p.name, score, source: 'fuzzy' };
  }
  return best && best.score >= MATCH_THRESHOLD ? best : null;
}

/**
 * Dopasowuje całą fakturę. Zwraca pozycje w kolejności z dokumentu, każdą z polem
 * `suggestion` (może być null). Nic nie zapisuje — decyzję zawsze podejmuje człowiek.
 */
export function matchInvoiceLines({ items = [], products = [], aliases = [] } = {}) {
  const aliasByText = new Map(
    aliases.map(a => [normalizeInvoiceName(a.invoiceText), a.itemCode])
  );

  return items.map(it => {
    const suggestion = matchInvoiceLine(it.name, products, aliasByText);
    return {
      invoiceName: it.name,
      quantity: it.quantity,
      unit: it.unit || 'szt.',
      unitPriceNet: it.unitPriceNet || 0,
      currency: it.currency || 'PLN',
      suggestion
    };
  });
}
