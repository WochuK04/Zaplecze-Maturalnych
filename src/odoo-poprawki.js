// Poprawki do danych z Odoo — decyzje, których Odoo o sobie nie wie.
//
// UWAGA: to jest PLASTER, nie docelowe miejsce. Każda pozycja poniżej istnieje
// dlatego, że czegoś brakuje po stronie Odoo. Gdy tam zostanie to uzupełnione,
// odpowiedni wpis trzeba stąd usunąć — inaczej będziemy nadpisywać poprawne dane
// starą decyzją.
//
// Plik siedzi w repo (a nie w „Materiały do gitignore/"), bo to ustalenia
// biznesowe: mają przejść przez review, działać na każdej maszynie i dać się
// prześledzić w historii.
//
// Dopasowanie idzie po NAZWIE (dla kartotek bez odnośnika) albo po KODZIE.
// Nazwa jest kruchym kluczem — jej zmiana w Odoo zerwie dopasowanie — więc
// `zastosujPoprawki` zwraca listę wpisów, które w nic nie trafiły, a skrypty
// importu wypisują ją głośno zamiast milczeć.

import { normalizeName } from './odoo.js';

// --- kartoteki bez odnośnika wewnętrznego ---------------------------------------
// Odoo ma trzy aktywne produkty bez `default_code`, więc import nie ma ich jak
// zidentyfikować ani ponumerować. Kody `O018`/`O019` kontynuują serię opakowań
// z Odoo (ostatnie zajęte to O017). Docelowo te odnośniki powinny powstać
// w Odoo — wtedy cała ta sekcja znika.
export const BEZ_ODNOSNIKA = [
  { nazwa: 'Taśma E8',     kod: 'O018', kategoria: 'opakowanie' },
  { nazwa: 'Taśma Matura', kod: 'O019', kategoria: 'opakowanie' },
  // Szklana kula to rekwizyt, nie materiał zużywalny — należy do modułu Sprzęt,
  // którego import magazynu nie prowadzi. Pomijamy ją świadomie; kartotekę
  // sprzętową zakłada się raz, ręcznie.
  { nazwa: 'Szklana kula', doSprzetu: true }
];

// --- jednostki, których Odoo nie zna --------------------------------------------
// `O010` „Wypełniacz do paczek niebieski" stoi w Odoo na sztukach, ale jedna
// sztuka to ta sama 10-kilogramowa paczka, którą `O011` liczy już w kilogramach.
// Bez przeliczenia obie kartoteki nie dają się scalić (różne jednostki), a stan
// „1 szt. + 10 kg" nie znaczy nic.
//
// `mnoznik` przelicza ilość; koszt jednostkowy dzielimy przez ten sam mnożnik,
// więc wartość pozycji zostaje bez zmian (1 × 165,60 = 10 × 16,56).
export const PRZELICZNIKI = [
  { kod: 'O010', jednostka: 'kg', mnoznik: 10 }
];

// Kod nadany kartotece, która w Odoo go nie ma — po nazwie. Potrzebne także
// przy liniach ruchu: te podają produkt nazwą, więc bez tego ruchy taśm nie
// miałyby się do czego podpiąć.
export function kodZNazwy(nazwa) {
  const wpis = BEZ_ODNOSNIKA.find((b) => normalizeName(b.nazwa) === normalizeName(nazwa));
  return wpis && !wpis.doSprzetu ? wpis.kod : null;
}

// Mnożnik jednostki dla kodu — ruchy trzeba przeliczyć tak samo jak stan
// kartoteki, inaczej rejestr rozjedzie się z ilością (O010: 4 ruchy w sztukach
// przy kartotece prowadzonej w kilogramach).
export function mnoznikDlaKodu(kod) {
  const wpis = PRZELICZNIKI.find((p) => p.kod === String(kod ?? '').toUpperCase());
  return wpis ? wpis.mnoznik : 1;
}

// Stosuje poprawki do listy kartotek z Odoo. Zwraca nowe kartoteki oraz raport:
// co zostało zmienione i które wpisy w nic nie trafiły.
export function zastosujPoprawki(kartoteki) {
  const wejscie = Array.isArray(kartoteki) ? kartoteki : [];
  const uzyte = new Set();
  const zastosowane = [];
  const pominiete = [];

  const wynik = [];
  for (const k of wejscie) {
    let poprawiona = { ...k };

    if (!String(k.kod ?? '').trim()) {
      const wpis = BEZ_ODNOSNIKA.find((b) => normalizeName(b.nazwa) === normalizeName(k.nazwa));
      if (!wpis) { wynik.push(poprawiona); continue; }
      uzyte.add(wpis.nazwa);
      if (wpis.doSprzetu) {
        pominiete.push({ nazwa: k.nazwa, stan: k.stan, powod: 'należy do modułu Sprzęt' });
        continue;
      }
      poprawiona = { ...poprawiona, kod: wpis.kod, kategoria: wpis.kategoria };
      zastosowane.push({ nazwa: k.nazwa, nadanyKod: wpis.kod, kategoria: wpis.kategoria });
    }

    const prze = PRZELICZNIKI.find((p) => p.kod === String(poprawiona.kod ?? '').toUpperCase());
    if (prze) {
      uzyte.add(prze.kod);
      const stan = Number(poprawiona.stan) || 0;
      const koszt = Number(poprawiona.koszt) || 0;
      poprawiona = {
        ...poprawiona,
        jednostka: prze.jednostka,
        stan: Math.round(stan * prze.mnoznik * 1000) / 1000,
        koszt: Math.round((koszt / prze.mnoznik) * 100) / 100
      };
      zastosowane.push({
        kod: prze.kod,
        przeliczono: `${stan} × ${koszt} zł → ${poprawiona.stan} ${prze.jednostka} × ${poprawiona.koszt} zł`
      });
    }

    wynik.push(poprawiona);
  }

  // Wpisy, które w nic nie trafiły — najczęściej znaczy to, że w Odoo zmieniono
  // nazwę albo produkt wreszcie dostał odnośnik. Jedno i drugie wymaga reakcji.
  const nietrafione = [
    ...BEZ_ODNOSNIKA.filter((b) => !uzyte.has(b.nazwa)).map((b) => `bez odnośnika: „${b.nazwa}"`),
    ...PRZELICZNIKI.filter((p) => !uzyte.has(p.kod)).map((p) => `przelicznik: ${p.kod}`)
  ];

  return { kartoteki: wynik, zastosowane, pominiete, nietrafione };
}
