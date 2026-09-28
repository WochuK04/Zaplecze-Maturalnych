# Współpraca (CONTRIBUTING)

Krótkie zasady pracy nad Zapleczem Maturalni. Środowisko, zmienne i skrypty opisuje [README.md](README.md).

## Gałęzie

Pracujemy na gałęziach tematycznych odbijanych od `main`. Nazwa: `typ/krótki-opis-po-kresce`.

| Prefiks | Kiedy |
|---|---|
| `feat/…` | nowa funkcja (np. `feat/magazyn-jednostki-miary`) |
| `fix/…` | poprawka błędu (np. `fix/session-store-shared-client`) |
| `chore/…` | zadania utrzymaniowe, CI, konfiguracja |
| `test/…` | dodanie/rozszerzenie testów |
| `docs/…` | dokumentacja (np. `docs/readme`) |

Jedna gałąź = jeden spójny temat. Nie mieszaj niezwiązanych zmian w jednym PR.

## Commity

Stosujemy Conventional Commits, opisy **po polsku**:

```
typ(zakres): zwięzłe podsumowanie w trybie dokonanym

Opcjonalny akapit: co i dlaczego (nie „jak" — to widać w diffie).
```

Przykłady z historii repo:

```
feat(magazyn): jednostki miary na produktach (szt./kg)
fix(auth): session store współdzieli klienta Mongo + diagnostyka 401
chore(ci): npm test + GitHub Actions (unit + integracyjne)
test: pokrycie auth (bramki ról, /me, preferencje) + cykl życia wypożyczenia
docs: pełny README (stack, env, role, moduły, testy)
```

Typy: `feat`, `fix`, `chore`, `test`, `docs`, `refactor`. Zakres w nawiasie jest opcjonalny, ale pomaga (`auth`, `magazyn`, `licencje`, `ci`).

## Testy przed PR

Uruchom testy adekwatne do zmiany:

```bash
npm run test:unit   # logika stock.* — nie wymaga bazy, zawsze szybkie
npm test            # pełne (wymaga MongoDB + dummy GOOGLE_*); patrz README
```

- **Nie ustawiaj `MONGO_DB_NAME`** przy testach — używana jest izolowana baza testowa.
- Zmiany w logice magazynu (`src/stock.js`) powinny mieć pokrycie w `test/stock.*` lub `test/warehouse.*`.
- CI (unit + integracyjne) i tak przejdzie przez GitHub Actions na PR.

## Pull requesty

1. Odbij gałąź od aktualnego `main`.
2. Utrzymaj PR wąski i opisz **co** się zmienia i **dlaczego**.
3. Poczekaj na zielone CI.
4. Merge do `main` przez GitHub.

## Konwencje kodu

- Node.js ESM (`import`/`export`), bez frameworka na froncie (vanilla JS w `public/`).
- Logikę domenową trzymaj w modułach czystych i testowalnych (wzór: `src/stock.js`), trasy HTTP w `src/index.js`.
- Komentarze i teksty UI po polsku — spójnie z resztą kodu.
- Nazwy kolekcji tylko przez `collections` z `src/schema.js`, nigdy jako gołe stringi.
