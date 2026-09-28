# Zaplecze Maturalni

Wewnętrzny system Maturalni do zarządzania **sprzętem, magazynem i licencjami**. Node.js + Express + MongoDB, front to vanilla-JS SPA. Uruchamiany jako aplikacja serverless na Vercelu (`export default app`), lokalnie jako klasyczny serwer HTTP.

## Stack

- **Backend:** Node.js (ESM), Express 4, MongoDB (driver `mongodb`), sesje przez `express-session` + `connect-mongo`
- **Auth:** Google OAuth 2.0 (`passport-google-oauth20`), ograniczone do domeny firmowej
- **Frontend:** vanilla JS SPA w `public/` (bez frameworka i bez builda)
- **PDF:** `pdfkit` (wydruki operacji magazynowych)
- **Import danych:** `xlsx` (import listy sprzętu z Excela)
- **Testy:** wbudowany `node:test`

## Wymagania

- Node.js 20+ (używamy `node --test` i `--watch`)
- Dostęp do instancji MongoDB (lokalny `mongod` lub Atlas)
- Poświadczenia Google OAuth (Client ID / Secret / Callback URL)

## Szybki start (lokalnie)

```bash
npm install
# utwórz plik .env i uzupełnij wartości (patrz sekcja Zmienne środowiskowe)
npm run seed           # opcjonalnie: dane startowe
npm run dev            # http://localhost:3000
```

`npm run dev` odpala `node --watch src/index.js`. Aplikacja domyślnie serwuje **nowy interfejs (v2)** pod `/`; stary interfejs jest dostępny pod `/v1`.

> **Uwaga (serverless):** na Vercelu moduł eksportuje `app`. Jeśli chcesz sprawdzić boot bez pełnego HTTP, użyj harnessu importującego `src/index.js`.

## Zmienne środowiskowe

Aplikacja akceptuje dwa warianty nazw dla Mongo, bo lokalny `.env` używa `MONGODB_URI` / `DB_NAME`, a produkcja `MONGO_URI` / `MONGO_DB_NAME`.

| Zmienna | Wymagana | Opis |
|---|---|---|
| `MONGODB_URI` / `MONGO_URI` | ✅ | Connection string do MongoDB |
| `DB_NAME` / `MONGO_DB_NAME` | — | Nazwa bazy (domyślnie `equipment_db`) |
| `SESSION_SECRET` | ✅ | Sekret sesji Express |
| `GOOGLE_CLIENT_ID` | ✅ | Google OAuth Client ID |
| `GOOGLE_CLIENT_SECRET` | ✅ | Google OAuth Client Secret |
| `GOOGLE_CALLBACK_URL` | ✅ | np. `http://localhost:3000/auth/google/callback` |
| `ALLOWED_EMAIL_DOMAIN` | — | Ogranicza logowanie do domeny (np. `maturalni.com`) |
| `PORT` | — | Port lokalny (domyślnie `3000`) |
| `NODE_ENV` | — | `production` włącza ustawienia sesji dla proda |

**Środowiska bazy:** lokalny `.env` wskazuje na `localhost`; Vercel/prod używa Atlasa (baza `maturalni_equipment`). Operacje na danych produkcyjnych muszą celować w Atlas, nie w lokalną bazę.

## Logowanie i role

Logowanie przez Google OAuth (`/auth/google`). Przy pierwszym logowaniu tworzy się użytkownik; jeśli ustawiony jest `ALLOWED_EMAIL_DOMAIN`, dopuszczane są tylko maile z tej domeny.

Role (bramki w [`src/auth.js`](src/auth.js)):

- **user** — pracownik: własny sprzęt, wnioski o wypożyczenie
- **manager** — dodatkowo akceptacja wniosków zespołu
- **viewer** — wgląd read-only do magazynu
- **admin** — pełne uprawnienia (magazyn, użytkownicy, konfiguracja)

Pierwszy admin (`k.woch@<domena>`) nadawany jest automatycznie; pozostałe role nadaje admin w panelu „Użytkownicy".

## Moduły

- **Sprzęt** — rejestr sprzętu (per sztuka), wypożyczenia, zwroty, zgłaszanie usterek, transfery, historia
- **Magazyn** — model w stylu Odoo: operacje jako dokumenty ze stanami, partie FIFO, wyceny stanu, rezerwacje, aging, reguły uzupełnień, dostawcy, lokalizacje, wydruki PDF
- **Licencje** — ewidencja licencji/subskrypcji oprogramowania
- **Wyjazdy** — planowanie wyjazdów: mapa Polski, autobusy, interaktywna checklista pakowania zintegrowana ze stanem magazynu
- **Administracja** — użytkownicy, powiadomienia, statystyki, dziennik audytu

## Struktura kodu

```
src/
  index.js          # aplikacja Express + wszystkie trasy HTTP (~120 endpointów)
  db.js             # połączenie z MongoDB + współdzielony klient (dla session store)
  auth.js           # Passport (Google OAuth) + bramki ról (requireAuth/Admin/Manager/…)
  schema.js         # nazwy kolekcji + ensureIndexes
  stock.js          # logika magazynu (operacje, FIFO, rezerwacje, wyceny, aging) — czysta, testowalna
  operation-pdf.js  # generowanie PDF operacji (pdfkit)
  seed.js           # dane startowe
  person-email-map.js, manager-map.js
public/             # SPA v1 (klasyczny interfejs, /v1)
public/v2/          # SPA v2 (domyślny interfejs, /)
scripts/            # import z Excela, migracje kodów, backfille
test/               # testy node:test (jednostkowe stock.* + integracyjne warehouse.*/auth/loans)
```

Sesje przechowywane są w kolekcji `sessions`; `connect-mongo` **współdzieli** klienta Mongo aplikacji (bez osobnej puli połączeń), co na serverless redukuje liczbę połączeń do Atlasa i eliminuje gubienie sesji przy cold-startach.

## Skrypty npm

| Komenda | Opis |
|---|---|
| `npm run dev` | Serwer deweloperski z auto-restartem (`node --watch`) |
| `npm run seed` | Załaduj dane startowe |
| `npm run import:excel` | Import listy sprzętu z pliku Excel |
| `npm run backfill:emails` | Backfill maili osób |
| `npm run rename:codes` | Zmiana kodów produktów |
| `npm run odoo:pobierz` | Pobranie z Odoo (produkty z kosztem, ruchy, przekazy) — tylko odczyt |
| `npm run odoo:import` | Import bazy produktów z Odoo ze scaleniem partii (domyślnie na sucho) |
| `npm run odoo:historia` | Zaciągnięcie historii ruchów i przetworzeń z Odoo (domyślnie na sucho) |
| `npm test` | Wszystkie testy (wymaga MongoDB; ustaw też dummy `GOOGLE_*`) |
| `npm run test:unit` | Testy jednostkowe `stock.*` (bez MongoDB) |
| `npm run test:int` | Testy integracyjne magazynu (wymaga MongoDB) |

## Synchronizacja z Odoo

Odoo (`maturalni.odoo.com`) jest aktywnym magazynem firmy, więc cały ruch w tę stronę jest **wyłącznie odczytem** — klient JSON-RPC ma twardą białą listę metod (`scripts/odoo/rpc.mjs`) i odrzuca wszystko inne, zanim cokolwiek wyśle.

Klucz API trzymaj w `Materiały do gitignore/odoo-creds.json` (katalog jest w `.gitignore`); zakładasz go w Odoo: awatar → Mój profil → Bezpieczeństwo konta → Nowy klucz API. Klucze bywają ważne 7 dni.

```bash
node scripts/odoo-pobierz.mjs --all     # produkty (z kosztem), ruchy, przekazy → Materiały do gitignore/odoo/
node scripts/odoo-import.mjs            # próba na sucho: co się scali i w jakie partie
node scripts/odoo-import.mjs --zapisz   # produkty + partie cenowe
node scripts/odoo-historia.mjs --zapisz # ruchy, przekazy i przetworzenia towar→gadżet
```

Bez klucza oba importy przyjmują ścieżki do ręcznych eksportów `.xlsx` z Odoo (`product.template`, `stock.move.line`, `stock.picking`). Eksport `.xlsx` **nie zawiera kosztu** — dołóż w widoku eksportu kolumnę „Koszt" albo używaj RPC, inaczej partie wejdą po 0 zł.

**Co się scala, a co nie.** Kartoteki o tej samej nazwie i tej samej kategorii (`G039` + `G046` „Arkusz polski e8") to jeden produkt kupiony w transzach — scalamy je, a każda kartoteka zostaje osobną partią cenową. Para Towar↔gadżet o tej samej nazwie (`T003` + `G060`) to **nie** duplikat, tylko ślad przetworzenia towaru w gadżet; te zostają osobno, bo inaczej znika historia przetworzeń i raport „prezenty ≤20 zł". Kody wchłonięte lądują w `items.mergedCodes` i są kaskadowo przepisane w ruchach, stanie i operacjach.

**Historia przetworzeń.** Odoo nie ma dokumentu „przetworzenie" — magazyn robi to dwiema korektami stanu (minus na kartotece towaru, plus na kartotece gadżetu chwilę później). `odoo-historia.mjs` paruje je w operacje typu `conversion`, widoczne w Magazyn → Raportowanie → **Przetworzenia**. Dokumenty z importu są oznaczone `importedFrom: 'odoo'` i nie da się ich cofnąć — to zapis zdarzeń, nie operacja do odwracania.

## Dostęp do Magazynu

Moduł chodzi po **imiennej liście**, nie po roli: rola mówi, co wolno w środku (podgląd vs. operacje), a flaga `users.warehouseAccess` — kto w ogóle wchodzi. Zaznacza się ją w panelu Użytkownicy, w kolumnie „Magazyn".

Domyślnie dostępu **nie ma** — pole nieustawione znaczy „nie". Administrator wchodzi zawsze i nie da mu się flagi odebrać, żeby nie dało się zamknąć modułu dla całej firmy.

Bramka (`requireWarehouseAccess`) jest wpięta na prefiks tras — `/warehouse`, `/tw` i `/packing-products` — więc obejmuje też każdy przyszły endpoint modułu bez pamiętania o dopisaniu middleware. Wyjazdy idą pod tę samą bramkę, bo pakowanie realnie zdejmuje sztuki ze stanu.

## Testy i CI

Testy używają `node:test`. `test:unit` nie wymaga bazy; `test`/`test:int` wymagają dostępnego MongoDB oraz dummy zmiennych `GOOGLE_*`. **Nie ustawiaj `MONGO_DB_NAME`** przy testach — używana jest izolowana baza testowa. CI (unit + integracyjne) działa w GitHub Actions.

## Deploy

Wdrażane na Vercelu jako funkcja serverless (moduł eksportuje `app`). Zmienne środowiskowe konfigurowane w panelu Vercela; produkcja łączy się z Atlasem.

## Troubleshooting

- **Po „Sign in with Google" wraca na ekran logowania (sesja gubiona).** Objaw to `/me` zwracające 401 tuż po zalogowaniu. Zwykle znaczy, że session store nie zapisał sesji — sprawdź logi Vercela pod kątem `[session-store] błąd:`. Store współdzieli klienta Mongo aplikacji (`getMongoClient`), więc wymaga poprawnego `MONGODB_URI`/`MONGO_URI` **oraz** ustawionego `SESSION_SECRET`. Na serverless upewnij się, że `app.set('trust proxy', 1)` działa i cookie sesji nie jest blokowane (HTTPS na prodzie).
- **`Brak MONGO_URI / MONGODB_URI w zmiennych środowiskowych`.** Aplikacja nie wystartuje bez connection stringa. Ustaw `MONGODB_URI` (lokalnie) lub `MONGO_URI` (prod).
- **`401 Brak autoryzacji` na endpointach API.** Nie ma aktywnej sesji — zaloguj się przez `/auth/google`. Jeśli logowanie odrzuca maila: sprawdź `ALLOWED_EMAIL_DOMAIN` (dopuszcza tylko `@<domena>`).
- **`403 Brak uprawnień…`.** Konto ma za niską rolę. Role nadaje admin w panelu „Użytkownicy"; pierwszy admin (`k.woch@<domena>`) tworzy się automatycznie przy logowaniu.
- **Testy nie łączą się z bazą.** `test`/`test:int` wymagają dostępnego MongoDB i dummy zmiennych `GOOGLE_*`. **Nie ustawiaj `MONGO_DB_NAME`** — testy używają izolowanej bazy. Jeśli nie masz lokalnego Mongo, odpal same testy jednostkowe: `npm run test:unit`.
- **Zmiana roli/kierownika nie działa bez ponownego logowania?** Powinna działać — `deserializeUser` pobiera świeży dokument użytkownika przy każdym żądaniu. Jeśli nie widać efektu, sprawdź, czy zmiana zapisała się w kolekcji `users`.

## Dalsza dokumentacja

Konwencje pracy (gałęzie, commity, testy przed PR) opisuje [CONTRIBUTING.md](CONTRIBUTING.md).
