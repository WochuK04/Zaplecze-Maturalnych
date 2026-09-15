// Jednostki miary produktów Magazynu.
//
// Odoo trzyma pełny słownik `uom.uom` (12 pozycji), ale realnie używane są dwie:
// sztuki i kilogramy (krówki, wypełniacz do paczek — stany ułamkowe, np. 9,5 kg).
// Zamiast wolnego tekstu — zamknięta lista, żeby „kg"/„Kg"/„kilogram" nie rozjechały
// się w bazie i żeby raporty mogły grupować po jednostce.
//
// Format zgodny z `packingItems.unit` (wyjazdy), które od początku używa „szt.".
export const UNITS = ['szt.', 'kg', 'l', 'm', 'opak.'];
export const DEFAULT_UNIT = 'szt.';

export function isUnit(value) {
  return UNITS.includes(String(value ?? '').trim());
}

// Nieznana/pusta jednostka → „szt.". Produkty sprzed wprowadzenia pola nie mają go
// wcale, więc domyślna wartość musi działać bez migracji danych.
export function normalizeUnit(value) {
  const v = String(value ?? '').trim();
  return UNITS.includes(v) ? v : DEFAULT_UNIT;
}

// Ilość magazynowa. Dopuszczamy ułamki (produkty na kg), ale nie zera ani wartości
// ujemnych — pozycja operacji z ilością 0 nie ma sensu. 3 miejsca po przecinku:
// starcza na gramy i obcina śmieci zmiennoprzecinkowe (0.1 + 0.2).
export function normalizeQty(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.round(n * 1000) / 1000;
}

// Wariant dopuszczający zero — dla partii cenowych i stanu policzonego przy
// inwentaryzacji, gdzie „0" jest poprawną odpowiedzią.
export function normalizeQtyOrZero(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1000) / 1000;
}

// Jednostki liczone sztukowo: zamówienie „7,9 opakowania" nie ma sensu, więc
// uzupełnianie zapasów zaokrągla je w dół. Kilogramy, litry i metry zostają
// ułamkowe — „zamów 7,9 kg" jest poprawną odpowiedzią.
export const DISCRETE_UNITS = ['szt.', 'opak.'];

export function isDiscreteUnit(value) {
  return DISCRETE_UNITS.includes(normalizeUnit(value));
}
