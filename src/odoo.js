// Odoo → zaplecze: czysta logika scalania kartotek i odtwarzania historii.
//
// Odoo jest aktywnym magazynem firmy, więc wszystko tutaj jest BEZ DOSTĘPU DO BAZY
// i bez zapisu do Odoo — same funkcje na danych. Skrypty w `scripts/odoo-*.mjs`
// dokładają warstwę we/wy (JSON-RPC, xlsx, Mongo), a testy jadą po tym pliku.
//
// Dwa pojęcia, których NIE wolno mylić (to była wprost postawiona zasada):
//   • PARTIA        — ta sama nazwa i ta sama kategoria na dwóch kartotekach
//                     (G039 + G046 „Arkusz polski e8"). To jeden produkt kupiony
//                     w dwóch transzach, różniący się kosztem. Scalamy.
//   • PRZETWORZENIE — ta sama nazwa, ale kartoteka Towar i kartoteka gadżet
//                     (T003 + G060 „Egzaminatorium matematyka wydanie I"). To NIE
//                     duplikat, tylko ślad po zmianie towaru w gadżet. Zostawiamy
//                     osobno — inaczej znika historia i raport „prezent ≤20 zł".

import { DEFAULT_UNIT } from './lib/units.js';

// Jednostka z Odoo → jednostka zaplecza (src/lib/units.js). Odoo pisze „Units",
// „kg", „Litry"; nieznane lądują na „szt.", bo tak zachowuje się normalizeUnit.
const JEDNOSTKI = [
  [/^(units?|szt|sztuk)/i, 'szt.'],
  [/^(kg|kilogram)/i, 'kg'],
  [/^(l|litr)/i, 'l'],
  [/^(m|metr)/i, 'm'],
  [/^(opak|pack)/i, 'opak.']
];

export function mapUnit(jednostka) {
  const s = String(jednostka ?? '').trim();
  for (const [re, u] of JEDNOSTKI) if (re.test(s)) return u;
  return DEFAULT_UNIT;
}

// Ilość magazynowa z Odoo. NIE zaokrąglamy do sztuk: krówki i wypełniacz idą
// na kilogramy i mają stany ułamkowe (0,5 kg). Zaokrąglenie gubiło towar —
// bilans T016 wychodził 4 zamiast 5 kg i wyglądało to na ręczną edycję w Odoo.
export function normalizeStock(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1000) / 1000;
}

// „[G039] Arkusz polski e8" → { kod: 'G039', nazwa: 'Arkusz polski e8' }.
// Odoo w eksporcie ruchów podaje produkt w tym formacie; bywa też sama nazwa.
export function parseProductRef(raw) {
  const s = String(raw ?? '').trim();
  const m = /^\[([^\]]+)\]\s*(.*)$/.exec(s);
  if (m) return { kod: m[1].trim().toUpperCase(), nazwa: m[2].trim() };
  return { kod: null, nazwa: s };
}

export function normalizeName(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Rdzeń nazwy do parowania przetworzeń: bez dopisków, którymi w Odoo rozróżnia się
// kartotekę tego samego wyrobu („Kubek E8 towar" vs „Kubek E8"). Interpunkcja leci,
// bo warianty typu „Granat/róż" zapisywane są raz z ukośnikiem, raz ze spacją.
export function productCore(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\b(towar|towary|gadżet|gadzet|gadżety|stare|stary)\b/g, ' ')
    .replace(/[^a-z0-9ąćęłńóśźż]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Klucz scalania: nazwa + kategoria + JEDNOSTKA. Kategoria trzyma osobno towar
// i gadżet. Jednostka jest równie istotna: „Wypełniacz do paczek niebieski" ma
// w Odoo kartotekę na sztuki (O010, 1 szt.) i na kilogramy (O011, 10 kg). Zlanie
// ich dałoby „11 szt." — liczbę bez znaczenia. Przeliczenie kg→opakowania wymaga
// wiedzy, ile waży paczka, więc zostawiamy je osobno i raportujemy.
export function mergeKey(nazwa, kategoria, jednostka = DEFAULT_UNIT) {
  return `${normalizeName(nazwa)}|${normalizeName(kategoria)}|${jednostka}`;
}

// Porządek kodów kartotek: najpierw litera, potem numer („G9" przed „G46").
export function compareCodes(a, b) {
  const pa = /^([A-Za-z]*)(\d*)/.exec(String(a || '')) || [];
  const pb = /^([A-Za-z]*)(\d*)/.exec(String(b || '')) || [];
  const la = (pa[1] || '').toUpperCase(), lb = (pb[1] || '').toUpperCase();
  if (la !== lb) return la < lb ? -1 : 1;
  const na = Number(pa[2] || 0), nb = Number(pb[2] || 0);
  if (na !== nb) return na - nb;
  return String(a).localeCompare(String(b));
}

// Kartoteka wiodąca w grupie: ta z największym stanem (to na niej realnie pracuje
// magazyn), a przy remisie — o najniższym numerze, czyli najstarsza.
export function pickCanonical(kartoteki) {
  return kartoteki.slice().sort((a, b) => {
    const sa = Number(a.stan) || 0, sb = Number(b.stan) || 0;
    if (sa !== sb) return sb - sa;
    return compareCodes(a.kod, b.kod);
  })[0];
}

// Scala kartoteki Odoo w produkty zaplecza.
//
// Wejście: [{ kod, nazwa, kategoria, stan, koszt, zaktualizowano }]
// Wyjście: [{ itemCode, name, category, quantity, priceBatches, mergedCodes, zrodla }]
//
// Każda kartoteka wchodzi jako osobna PARTIA CENOWA — bo to jest ta „inna partia
// o innym koszcie". Ilość produktu = suma partii, dokładnie jak liczy to reszta
// magazynu (patrz applyConversionBatches w src/stock.js).
export function mergeProducts(kartoteki, { teraz = new Date() } = {}) {
  const grupy = new Map();
  for (const k of kartoteki) {
    const kod = String(k.kod ?? '').trim().toUpperCase();
    const nazwa = String(k.nazwa ?? '').trim();
    const kategoria = String(k.kategoria ?? '').trim();
    if (!kod || !nazwa || !kategoria) continue;
    const jednostka = mapUnit(k.jednostka);
    const key = mergeKey(nazwa, kategoria, jednostka);
    if (!grupy.has(key)) grupy.set(key, []);
    grupy.get(key).push({ ...k, kod, nazwa, kategoria, jednostka, stan: normalizeStock(k.stan) });
  }

  const produkty = [];
  for (const czlonkowie of grupy.values()) {
    const wiodaca = pickCanonical(czlonkowie);
    const pozostale = czlonkowie.filter((c) => c.kod !== wiodaca.kod).sort((a, b) => compareCodes(a.kod, b.kod));

    // Partia na kartotekę. Kartoteka ze stanem wchodzi zawsze; kartoteka BEZ stanu,
    // ale ze znanym kosztem, wchodzi jako partia o ilości 0.
    //
    // To drugie wygląda dziwnie, a jest konieczne: Odoo trzyma koszt na kartotece
    // niezależnie od tego, czy coś na niej leży, a historia ruchów sięga wstecz — do
    // czasów, gdy towar jeszcze był. Bez tej partii cała historia takiego produktu
    // zostawała u nas bez wyceny, mimo że koszt był znany. Realnie dotyczyło to 37
    // kartotek i samego „Biletu energylandia" za 193,52 zł (sprawdzone 29.09.2026).
    //
    // Partia zerowa nie zmienia żadnej sumy: wycena stanu, wiek zapasu i próg
    // prezentów liczą wyłącznie partie o ilości > 0. Jej jedyną rolą jest podanie ceny
    // kolejce FIFO (`newFifoQueue` zapamiętuje ją jako ostatnią znaną cenę warstwy).
    //
    // Kartoteki bez stanu I bez kosztu nadal partii nie dostają — zerowa cena
    // wyglądałaby jak „towar za darmo", a to nieprawda, po prostu nie wiemy.
    const priceBatches = czlonkowie
      .slice()
      .sort((a, b) => compareCodes(a.kod, b.kod))
      .filter((c) => c.stan > 0 || (Number(c.koszt) || 0) > 0)
      .map((c) => ({
        qty: c.stan > 0 ? c.stan : 0,
        unitPrice: Math.round((Number(c.koszt) || 0) * 100) / 100,
        note: `Odoo ${c.kod}`,
        addedAt: c.zaktualizowano instanceof Date ? c.zaktualizowano : teraz
      }));

    produkty.push({
      itemCode: wiodaca.kod,
      name: wiodaca.nazwa,
      category: wiodaca.kategoria,
      unit: wiodaca.jednostka,
      quantity: normalizeStock(priceBatches.reduce((s, b) => s + b.qty, 0)),
      priceBatches,
      mergedCodes: pozostale.map((c) => c.kod),
      zrodla: czlonkowie.slice().sort((a, b) => compareCodes(a.kod, b.kod))
        .map((c) => ({ kod: c.kod, stan: c.stan, koszt: Number(c.koszt) || 0 }))
    });
  }

  return produkty.sort((a, b) => compareCodes(a.itemCode, b.itemCode));
}

// Kartoteki zarchiwizowane w Odoo są wycofane z obrotu — jako produkty do zaplecza
// nie wchodzą. Historia potrafi się do nich odwoływać (np. konwersja z 01.2026 idzie
// z kartoteki, której dziś już nie ma) i wtedy `odoo-historia.mjs` zakłada je jako
// nieaktywne. Eksport .xlsx oddaje same aktywne i nie ma tego pola, więc brak
// informacji traktujemy jak „aktywna".
export function tylkoAktywne(kartoteki) {
  return (Array.isArray(kartoteki) ? kartoteki : []).filter((k) => k.aktywny !== false);
}

// Odoo NIE pilnuje unikalności odnośnika wewnętrznego — potrafią istnieć dwie
// kartoteki o tym samym kodzie (G041 to naraz zarchiwizowane „Krówki matura" i
// aktywny „Planer 8 mies mat"). U nas `items.itemCode` jest unikalny, więc taki
// zbieg trzeba wyłapać, zanim import wywali się na indeksie.
//
// Zwraca [{ itemCode, wygrywa, przegrywaja }] — kod zostaje przy grupie o większym
// stanie (przy remisie: o większej liczbie kartotek), reszta jest do pominięcia
// i do ręcznego rozstrzygnięcia w Odoo.
export function findDuplicateCodes(produkty) {
  const wgKodu = new Map();
  for (const p of Array.isArray(produkty) ? produkty : []) {
    if (!wgKodu.has(p.itemCode)) wgKodu.set(p.itemCode, []);
    wgKodu.get(p.itemCode).push(p);
  }

  const out = [];
  for (const [itemCode, grupy] of wgKodu) {
    if (grupy.length < 2) continue;
    const posortowane = grupy.slice().sort((a, b) => {
      if (a.quantity !== b.quantity) return b.quantity - a.quantity;
      return b.zrodla.length - a.zrodla.length;
    });
    out.push({ itemCode, wygrywa: posortowane[0], przegrywaja: posortowane.slice(1) });
  }
  return out;
}

// Kody magazynu i kody sprzętu żyją w JEDNEJ kolekcji `items`, a numeracja Odoo
// nie wie o istnieniu zaplecza. Realny przypadek: `T003` to w Odoo „Egzaminatorium
// matematyka", a w zapleczu — od importu z Excela — „Statyw lampowy". Kartoteki
// sprzętu są cudzą własnością tego modułu; import magazynu NIE MOŻE ich dotknąć
// ani przejąć ich kodu.
//
// Dlatego kolidującej kartotece Odoo nadajemy własny kod z prefiksem `MAG-`.
// Prefiks, nie sufiks, bo od razu widać, że to pozycja magazynu, a nie wariant
// sprzętu. Oryginalny kod Odoo zostaje w `odooCode`, żeby dało się go wyświetlić
// i żeby powrót do parytetu (gdy sprzęt dostanie inne kody) był mechaniczny.
//
// `zajeteKody` to kody kartotek NIEMAGAZYNOWYCH z bazy. Zwraca produkty z ewentualnie
// zmienionym `itemCode` oraz mapę { stary → nowy } do przepisania historii.
export const KOD_KOLIZJI = (kod) => `MAG-${kod}`;

export function resolveCodeCollisions(produkty, zajeteKody = new Set()) {
  const zajete = new Set([...zajeteKody].map((k) => String(k).toUpperCase()));
  const mapa = new Map();
  const kolizje = [];

  const out = (Array.isArray(produkty) ? produkty : []).map((p) => {
    const kolidujace = [p.itemCode, ...p.mergedCodes].filter((k) => zajete.has(String(k).toUpperCase()));
    if (!kolidujace.length) return p;

    const nowy = KOD_KOLIZJI(p.itemCode);
    kolizje.push({ odooCode: p.itemCode, itemCode: nowy, name: p.name, kolidujace });
    for (const k of [p.itemCode, ...p.mergedCodes]) mapa.set(k, nowy);
    return { ...p, itemCode: nowy, odooCode: p.itemCode };
  });

  return { produkty: out, mapa, kolizje };
}

// Pary kartotek o tej samej nazwie, ale różnych kategoriach — kandydaci na
// przetworzenie, NIE na scalenie. Zwracamy je osobno, żeby dało się je przejrzeć.
export function findConversionCandidates(kartoteki) {
  const wgNazwy = new Map();
  for (const k of kartoteki) {
    const n = normalizeName(k.nazwa);
    if (!n) continue;
    if (!wgNazwy.has(n)) wgNazwy.set(n, []);
    wgNazwy.get(n).push(k);
  }
  const out = [];
  for (const [nazwa, v] of wgNazwy) {
    if (new Set(v.map((x) => normalizeName(x.kategoria))).size < 2) continue;
    out.push({ nazwa, kartoteki: v.slice().sort((a, b) => compareCodes(a.kod, b.kod)) });
  }
  return out.sort((a, b) => a.nazwa.localeCompare(b.nazwa, 'pl'));
}

// === Historia ===================================================================

// Lokalizacje Odoo → lokalizacje zaplecza (kody z STANDARD_LOCATIONS w src/stock.js).
// „mag/Strefa składowania" i „WH/Stock" to ten sam realny magazyn — Odoo ma dwa
// magazyny z historii, u nas jest jeden „Magazyn".
const MAPA_LOKALIZACJI = [
  [/inventory adjustment/i, 'VIRT/Inventory'],
  [/^vendors$/i, 'VIRT/Suppliers'],
  [/^customers$/i, 'VIRT/Customers'],
  [/^partner locations/i, 'VIRT/Customers'],
  [/strefa składowania|^wh\/stock$|^wh$|^mag$/i, 'WH/Stock']
];

// Dopasowanie kartoteki Odoo do dokumentu już istniejącego w bazie.
//
// Kluczowe przy przenumerowaniu kodów: po zmianie `itemCode` na schemat aplikacji
// (`GADZ-MQTBGLJ5`) kartoteka nie da się już znaleźć po kodzie z Odoo. Gdyby import
// szukał tylko po `itemCode`, przy najbliższej synchronizacji NIE znalazłby jej
// i założył wszystko drugi raz — sto duplikatów i rozjechany stan.
//
// Dlatego kartoteka niesie `odooCode` (odnośnik, z którego powstała) i dopasowanie
// idzie po jednym ALBO drugim. `kodDocelowy` to kod, pod którym produkt ma dalej żyć:
// lokalny, jeśli ktoś go przenumerował — import nie cofa decyzji podjętej w zapleczu.
export function dopasujKartoteke(produkt, istniejace = []) {
  const wiodacy = istniejace.find(
    (d) => d.itemCode === produkt.itemCode || d.odooCode === produkt.itemCode
  ) || null;
  return {
    wiodacy,
    kodDocelowy: wiodacy ? wiodacy.itemCode : produkt.itemCode,
    doWchloniecia: istniejace.filter((d) => d !== wiodacy)
  };
}

export function mapLocation(nazwa) {
  const s = String(nazwa ?? '').trim();
  for (const [re, kod] of MAPA_LOKALIZACJI) if (re.test(s)) return kod;
  return null;
}

// Przestrzeń nazw odnośników dokumentów z importu.
//
// Odoo nazywa swoje przekazy `mag/IN/00057`, bo jego magazyn ma skrót „mag" — czyli
// DOKŁADNIE tak samo, jak numeruje się dokument założony w Zapleczu. Dopóki obie serie
// dzielą prefiks, kolizja jest kwestią czasu: licznik aplikacji wydaje numer, a przy
// najbliższym imporcie Odoo sięga po ten sam i zapis wywraca się na unikalnym indeksie
// `reference` — w połowie, zostawiając historię rozbitą.
//
// Dlatego dokumenty z importu dostają własną przestrzeń `odoo/…`, tak jak od początku
// mają ją konwersje (`odoo/CONV`) i korekty (`odoo/ADJ`). Oryginalny numer zostaje
// widoczny w środku odnośnika, żeby dało się go zestawić z Odoo bez zaglądania do bazy.
export const PRZESTRZEN_IMPORTU = 'odoo';

export function odnosnikImportu(referencjaOdoo) {
  const s = String(referencjaOdoo ?? '').trim();
  if (!s) return '';
  // Idempotentnie: ponowny import nie ma dokładać kolejnego „odoo/".
  if (s === PRZESTRZEN_IMPORTU || s.startsWith(PRZESTRZEN_IMPORTU + '/')) return s;
  return `${PRZESTRZEN_IMPORTU}/${s}`;
}

// Rodzaj ruchu wg pary lokalizacji — ta sama taksonomia, co `stockMoves.kind`
// w magazynie (receipt/delivery/adjustment/internal).
export function classifyMove(fromKod, toKod) {
  if (fromKod === 'VIRT/Suppliers') return 'receipt';
  if (toKod === 'VIRT/Customers') return 'delivery';
  if (fromKod === 'VIRT/Inventory' || toKod === 'VIRT/Inventory') return 'adjustment';
  return 'internal';
}

// Normalizuje linię ruchu Odoo (stock.move.line) do postaci niezależnej od źródła.
export function normalizeMoveLine(row) {
  const { kod, nazwa } = parseProductRef(row.produkt);
  const fromKod = mapLocation(row.od);
  const toKod = mapLocation(row.do);
  return {
    kod,
    nazwa,
    when: row.data instanceof Date ? row.data : new Date(row.data),
    qty: normalizeStock(row.ilosc),
    jednostka: mapUnit(row.jednostka),
    odNazwa: String(row.od ?? ''),
    doNazwa: String(row.do ?? ''),
    fromKod,
    toKod,
    kind: classifyMove(fromKod, toKod),
    referencja: String(row.odnosnik ?? '').trim(),
    status: String(row.status ?? '').trim()
  };
}

// Odtwarza przetworzenia towar→gadżet z korekt stanu.
//
// Odoo nie ma osobnego dokumentu „przetworzenie" — magazyn robi to dwiema korektami:
// zdejmuje X sztuk z kartoteki towaru i po chwili dopisuje X sztuk na kartotece
// gadżetu. Parujemy więc korekty, które:
//   1. mają przeciwne znaki i identyczną ilość,
//   2. dotyczą tego samego wyrobu (rdzeń nazwy),
//   3. siedzą na różnych kartotekach (inny prefiks kodu — T↔G),
//   4. dzieli je nie więcej niż `oknoMs`.
// Warunek 2 jest kluczowy: bez niego w gęstych sesjach korekt (28.01.2026 zrobiono
// kilkanaście pod rząd) parują się przypadkowe wiersze o tej samej ilości.
// Reszta korekt zostaje zwykłą korektą stanu — nie zgadujemy.
export function detectConversions(linieKorekt, { oknoMs = 2 * 60 * 60 * 1000 } = {}) {
  const korekty = linieKorekt
    .filter((l) => l.fromKod === 'VIRT/Inventory' || l.toKod === 'VIRT/Inventory')
    .map((l) => ({ ...l, plus: l.fromKod === 'VIRT/Inventory' }))
    .sort((a, b) => a.when - b.when);

  const zuzyte = new Set();
  const pary = [];

  for (let i = 0; i < korekty.length; i++) {
    if (zuzyte.has(i) || !korekty[i].kod) continue;
    const a = korekty[i];
    let najlepszy = -1, najblizej = Infinity;
    for (let j = 0; j < korekty.length; j++) {
      if (i === j || zuzyte.has(j) || !korekty[j].kod) continue;
      const b = korekty[j];
      if (a.plus === b.plus) continue;
      if (a.qty !== b.qty || a.qty <= 0) continue;
      if (a.kod[0] === b.kod[0]) continue;
      if (productCore(a.nazwa) !== productCore(b.nazwa)) continue;
      const d = Math.abs(a.when - b.when);
      if (d > oknoMs || d >= najblizej) continue;
      najblizej = d; najlepszy = j;
    }
    if (najlepszy < 0) continue;
    zuzyte.add(i); zuzyte.add(najlepszy);
    const b = korekty[najlepszy];
    const plus = a.plus ? a : b;
    const minus = a.plus ? b : a;
    pary.push({
      when: plus.when > minus.when ? plus.when : minus.when,
      qty: plus.qty,
      sourceCode: minus.kod,
      sourceName: minus.nazwa,
      targetCode: plus.kod,
      targetName: plus.nazwa,
      referencja: plus.referencja || minus.referencja
    });
  }

  return {
    conversions: pary.sort((a, b) => a.when - b.when),
    pozostaleKorekty: korekty.filter((_, i) => !zuzyte.has(i))
  };
}
