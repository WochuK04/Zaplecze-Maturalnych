// Kanoniczna postać kodu produktu (trim + wielkie litery). Współdzielone przez
// warehouse (index.js) i moduł wyjazdów (src/routes/turbo-weekends.js).
export function normalizeItemCode(value) {
  return String(value || '').trim().toUpperCase();
}

// Schemat kodu produktu obowiązujący w aplikacji: PREFIKS-SUFIKS, gdzie prefiks to
// cztery pierwsze litery kategorii (bez znaków diakrytycznych), a sufiks jest
// generowany. „Akcesoria" → `AKCE-MQTBGLJ5`.
//
// Reguła mieszka TUTAJ, a nie w `src/index.js`, bo korzystają z niej oba światy:
// aplikacja przy zakładaniu i przekategoryzowaniu kartoteki oraz skrypty
// normalizujące numerację. Gdy definicja była tylko w index.js, skrypt jej nie
// widział i dorobił konkurencyjny schemat (`AS046`) — dwa schematy w jednej
// kolekcji to dokładnie ten problem, którego nie chcemy powtórzyć.
export function itemCodePrefix(category) {
  return String(category || 'ZAK')
    .normalize('NFD')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 4)
    .toUpperCase() || 'ZAK';
}

// Sufiks: znacznik czasu w base36. Zwięzły i rosnący, więc kody z jednej partii
// importu układają się chronologicznie. `rozroznik` rozsuwa kody generowane w tej
// samej milisekundzie (import paczki).
export function itemCodeSuffix(rozroznik = '') {
  return `${Date.now().toString(36).toUpperCase()}${rozroznik}`;
}

export function buildItemCode(category, rozroznik = '') {
  return `${itemCodePrefix(category)}-${itemCodeSuffix(rozroznik)}`;
}

// Czy kod trzyma się schematu aplikacji dla swojej kategorii. Kod bez „-"
// (`AS046`, `K004` — numeracja z ręcznych importów) schematu nie spełnia.
export function matchesScheme(code, category) {
  const c = String(code || '');
  const dash = c.indexOf('-');
  if (dash <= 0) return false;
  return c.slice(0, dash).toUpperCase() === itemCodePrefix(category);
}
