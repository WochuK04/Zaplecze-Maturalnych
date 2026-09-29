# Import z Odoo — checklista

Kolejność na kolejny pełny import (planowany ~06.10.2026). Wszystkie skrypty
chodzą domyślnie **na sucho** — bez `--zapisz` nic nie zmieniają.

## 0. Zanim zaczniesz

- [ ] Klucz API do Odoo jest ważny. Bywa zakładany na 7 dni, więc przy
      „Uwierzytelnianie nieudane" załóż nowy: awatar → Mój profil →
      Bezpieczeństwo konta → Nowy klucz API. Plik: `Materiały do gitignore/odoo-creds.json`.
- [ ] Połączenie do produkcji: `Materiały do gitignore/atlas.env`.

```bash
set -a && source "Materiały do gitignore/atlas.env" && set +a
```

## 1. Poprawki, które warto wcześniej załatwić w Odoo

Każda z nich pozwala usunąć wpis z `src/odoo-poprawki.js` — plik jest plastrem
i ma się kurczyć, nie rosnąć.

- [ ] „Taśma E8" i „Taśma Matura" — nadać odnośnik wewnętrzny (u nas `O018`/`O019`).
- [ ] „Szklana kula" — nadać odnośnik albo zostawić; u nas żyje jako sprzęt.
- [ ] `O010` „Wypełniacz do paczek niebieski" — przestawić jednostkę na `kg`
      (1 szt. = 10 kg), wtedy przelicznik po naszej stronie znika.
- [ ] `G041` — kod użyty w Odoo dwa razy („Krówki matura" zarchiwizowane
      i „Planer 8 mies mat" aktywny). Import bierze aktywny i zgłasza konflikt.
- [ ] **Kartoteki ze stanem, ale zerowym kosztem.** Na 29.09.2026 było ich 20,
      z czego **16 do uzupełnienia** (m.in. Karteczki samoprzylepne 600 szt.,
      Karton fasonowy niebieski mat 562, Egzaminatorium polski wydanie I 432,
      Teczki Ti 421). Koszt jest jedynym źródłem kwot, jakie Odoo w ogóle ma —
      bez niego pozycja nie da się wycenić ani w raportach, ani na wydruku.
      **Pomiń kategorię `sponsor`**: towar sponsorski dostajemy za 0 i wydajemy
      za 0, więc zero jest tam poprawne (Owolovo — galaretka, mus, sok, deser).
      Aktualną listę wyciąga `Materiały do gitignore/odoo-sonda.mjs`.

**Nie szukaj w Odoo faktur — nie ma ich tam.** Instalacja ma wyłącznie moduł
Magazyn: brak księgowości, zakupów, sprzedaży i wyceny zapasów, a
`stock.move.price_unit` jest zerowe. Szczegóły i tabela sprawdzonych modeli:
sekcja „Co Odoo wie o kwotach" w [README](../README.md#synchronizacja-z-odoo).

## 2. Pobranie danych

```bash
node scripts/odoo-pobierz.mjs --all
```

`--all` jest obowiązkowe: historia odwołuje się do kartotek zarchiwizowanych.
Sprawdź w podsumowaniu `produktowZKosztem` — jeśli 0, koszty nie przyszły
i wycena wyjdzie zerowa.

## 3. Próba na sucho

```bash
node scripts/odoo-od-zera.mjs
```

Czytaj uważnie:

- **host** ma mówić `← ATLAS (produkcja)`;
- **DO USUNIĘCIA** — liczby zgadzają się z oczekiwaniem?
- **ZOSTAJE NIETKNIĘTE** — sprzęt, użytkownicy, wypożyczenia.

Zakres `magazyn` (domyślny) nie tyka sprzętu ani modułów poza Magazynem.

## 4. Kopia zapasowa

Zrób zrzut tego, co ma zniknąć — operacja jest nieodwracalna. Wzór z 28.09:
`Materiały do gitignore/atlas-kopia-magazyn-…/` (items, stockMoves, quants,
stockOperations, suppliers, deliveryDestinations, counters).

## 5. Import

```bash
node scripts/odoo-od-zera.mjs --zapisz --potwierdz=maturalni_equipment
```

`--potwierdz` musi się zgadzać z nazwą bazy co do znaku.

## 6. Normalizacja kodów sprzętu

**To jest ta zmiana, która czeka na kolejny import.** Sprzęt ma dziś kody
`AS046`, `K004`, `PC005` — spoza schematu aplikacji. Schemat obowiązujący
(`src/lib/item-code.js`) to `PREFIKS-SUFIKS`: `AKCE-MQTBGLJ5`. Tego samego
używa aplikacja przy zakładaniu kartoteki i przy zmianie kategorii, więc kod
poza schematem i tak zostanie kiedyś przez nią przemianowany.

```bash
node scripts/kody-sprzetu.mjs --przywroc="Materiały do gitignore/mapowanie-kodow-2026-09-28.json"
```

`--przywroc` jest istotne: 32 kartotekom nadpisałem 28.09 ich wygenerowany kod
(`AKCE-MQ9LIJT0` → `AS046`). Ten plik pozwala oddać im oryginał zamiast losować
nowy — ich etykiety i kody QR mogą nadal nosić pierwotny.

Po przejrzeniu mapowania:

```bash
node scripts/kody-sprzetu.mjs --przywroc="…" --zapisz
```

**Uwaga:** zmienia się ~202 kartoteki, czyli cała ewidencja sprzętu. Etykiety
i kody QR trzeba przedrukować. Magazyn zostaje przy kodach z Odoo i nie jest
ruszany.

## 7. Mapowanie dla księgowości

```bash
node scripts/mapowanie-kodow.mjs "Materiały do gitignore/atlas-kopia-magazyn-…"
```

Składa tabelę stary → nowy dla sprzętu i magazynu. Wiersze, których nie da się
rozstrzygnąć automatycznie, są oznaczone w kolumnie `uwaga`.

## 8. Kontrola

- [ ] Magazyn → Raportowanie → **Spójność danych**: zero rozjazdów, zero ujemnych,
      zero sierot.
- [ ] Magazyn → Raportowanie → **Wycena stanu**: kwota różna od zera.
- [ ] Magazyn → Raportowanie → **Przetworzenia**: dokumenty są na liście.
- [ ] Import nie zgłosił nietrafionych poprawek z `src/odoo-poprawki.js`.
- [ ] Sprzęt, użytkownicy i wypożyczenia bez zmian.

## Rzeczy, które już raz poszły źle

- **Kody sprzętu i Odoo żyją w jednej kolekcji.** `T003` był naraz
  „Egzaminatorium matematyka" w Odoo i „Statywem lampowym" u nas — import nadpisał
  statyw. Dziś blokuje to `resolveCodeCollisions`, ale po normalizacji kodów
  problem znika u źródła.
- **Kilogramów nie wolno zaokrąglać.** Bilans wychodził 4 zamiast 5 kg
  i wyglądało to na ręczną edycję stanu w Odoo.
- **Stan otwarcia z `migrate-warehouse.js`** podwajał ilości — import go usuwa
  dla produktów objętych historią.
