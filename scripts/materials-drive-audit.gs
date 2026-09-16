/**
 * Audyt plików materiałów na Dysku Google — Apps Script.
 *
 * PO CO: analiza bazy materiałów utknęła na trzech pytaniach, których nie da się
 * odpowiedzieć z eksportów platformy, a Dysk odpowiada na nie wprost:
 *   1. Czy dwa rekordy o tej samej nazwie to ten sam PLIK (md5Checksum) — rozstrzyga
 *      177 z 191 dwuznacznych par duplikatów bez zgadywania po nazwie.
 *   2. Kiedy plik był naprawdę aktualizowany (modifiedTime) — daty w masterze są
 *      wpisywane ręcznie i pokrywają 76%.
 *   3. Czy wskaźnik jeszcze działa (404 = zepsuty) i kto jest właścicielem.
 *
 * Czego NIE da: autora merytorycznego, gotowości do druku, dostępności. Właściciel
 * pliku na Dysku to ten, kto go wgrał — proxy, nie odpowiedź.
 *
 * ── JAK URUCHOMIĆ ────────────────────────────────────────────────────────────
 * 1. Nowy arkusz Google → Rozszerzenia → Apps Script → wklej ten plik.
 * 2. W edytorze: Usługi (+) → „Drive API" → wersja v3 → Dodaj.  BEZ TEGO NIE ZADZIAŁA:
 *    md5Checksum nie jest dostępny przez zwykłe DriveApp, tylko przez usługę zaawansowaną.
 * 3. W arkuszu utwórz zakładkę „wejscie" i wklej identyfikatory plików w kolumnie A
 *    (pierwszy wiersz to nagłówek „fileId"). Plik z gotową listą: drive-ids.csv.
 * 4. Uruchom `audytDysku`. Autoryzuj dostęp, gdy poprosi.
 * 5. Skrypt sam się zatrzyma przed limitem 6 minut i zapamięta miejsce. Uruchom
 *    ponownie tyle razy, ile trzeba — dopisuje dalej. Postęp widać w logu.
 * 6. Na koniec: zakładka „wynik" → Plik → Pobierz → CSV.
 *
 * Przy ~3200 plikach spodziewaj się 3-6 uruchomień.
 */

var ARKUSZ_WEJSCIE = 'wejscie';
var ARKUSZ_WYNIK = 'wynik';
var LIMIT_MS = 4.5 * 60 * 1000;   // zapas względem limitu 6 minut
var KLUCZ_KURSORA = 'audyt_dysku_kursor';

var NAGLOWKI = ['fileId', 'status', 'nazwa', 'md5Checksum', 'rozmiar', 'typ',
                'utworzony', 'zmodyfikowany', 'wlasciciel', 'ostatnio_zmienil', 'w_koszu'];

function audytDysku() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var wejscie = ss.getSheetByName(ARKUSZ_WEJSCIE);
  if (!wejscie) throw new Error('Brak zakładki „' + ARKUSZ_WEJSCIE + '". Wklej identyfikatory do kolumny A.');

  var wynik = ss.getSheetByName(ARKUSZ_WYNIK);
  if (!wynik) {
    wynik = ss.insertSheet(ARKUSZ_WYNIK);
    wynik.appendRow(NAGLOWKI);
    wynik.setFrozenRows(1);
  }

  // Kolumna A bez nagłówka; puste pomijamy.
  var wiersze = wejscie.getRange(2, 1, Math.max(0, wejscie.getLastRow() - 1), 1).getValues();
  var idy = [];
  for (var i = 0; i < wiersze.length; i++) {
    var v = String(wiersze[i][0] || '').trim();
    if (v) idy.push(v);
  }

  var props = PropertiesService.getDocumentProperties();
  var start = Number(props.getProperty(KLUCZ_KURSORA) || 0);
  if (start >= idy.length) {
    Logger.log('Gotowe — przetworzono wszystkie ' + idy.length + ' pozycji. '
      + 'Aby zacząć od nowa, uruchom resetKursora().');
    return;
  }

  var t0 = new Date().getTime();
  var bufor = [];
  var i = start;

  for (; i < idy.length; i++) {
    if (new Date().getTime() - t0 > LIMIT_MS) break;
    bufor.push(pobierzPlik(idy[i]));

    // Zapis partiami — jeden appendRow na wiersz jest wolny i gubi się przy przerwaniu.
    if (bufor.length >= 50) {
      wynik.getRange(wynik.getLastRow() + 1, 1, bufor.length, NAGLOWKI.length).setValues(bufor);
      bufor = [];
      props.setProperty(KLUCZ_KURSORA, String(i + 1));
    }
  }

  if (bufor.length) {
    wynik.getRange(wynik.getLastRow() + 1, 1, bufor.length, NAGLOWKI.length).setValues(bufor);
  }
  props.setProperty(KLUCZ_KURSORA, String(i));

  var pct = Math.round((i / idy.length) * 100);
  Logger.log('Przetworzono ' + i + ' z ' + idy.length + ' (' + pct + '%).'
    + (i < idy.length ? ' Uruchom `audytDysku` ponownie, żeby kontynuować.' : ' GOTOWE.'));
}

/**
 * Jeden plik. Błąd NIE przerywa audytu — brak pliku to też wynik: dokładnie ten
 * przypadek „wskaźnik zepsuł się wykrywalnie", na który czekamy.
 */
function pobierzPlik(fileId) {
  var pola = 'id,name,md5Checksum,size,mimeType,createdTime,modifiedTime,trashed,'
    + 'owners(emailAddress),lastModifyingUser(emailAddress)';
  try {
    var f = Drive.Files.get(fileId, { fields: pola, supportsAllDrives: true });
    return [
      fileId,
      'ok',
      f.name || '',
      f.md5Checksum || '',            // puste dla Dokumentów/Arkuszy Google — nie mają binarnej treści
      f.size || '',
      f.mimeType || '',
      f.createdTime || '',
      f.modifiedTime || '',
      (f.owners && f.owners[0] && f.owners[0].emailAddress) || '',
      (f.lastModifyingUser && f.lastModifyingUser.emailAddress) || '',
      f.trashed ? 'tak' : 'nie'
    ];
  } catch (e) {
    var msg = String(e.message || e);
    // 404 = plik usunięty albo brak dostępu; 403 = brak uprawnień. Rozróżniamy,
    // bo to dwie różne historie: „pliku nie ma" vs „nie widzę go z tego konta".
    var status = msg.indexOf('404') > -1 || /not found/i.test(msg) ? 'brak-pliku'
      : msg.indexOf('403') > -1 ? 'brak-dostepu'
      : 'blad';
    return [fileId, status, msg.slice(0, 180), '', '', '', '', '', '', '', ''];
  }
}

/** Zaczyna audyt od początku (nie czyści zakładki „wynik" — usuń ją ręcznie). */
function resetKursora() {
  PropertiesService.getDocumentProperties().deleteProperty(KLUCZ_KURSORA);
  Logger.log('Kursor wyzerowany.');
}

/** Ile zostało do przetworzenia. */
function postep() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var wejscie = ss.getSheetByName(ARKUSZ_WEJSCIE);
  var wszystkie = Math.max(0, wejscie.getLastRow() - 1);
  var zrobione = Number(PropertiesService.getDocumentProperties().getProperty(KLUCZ_KURSORA) || 0);
  Logger.log(zrobione + ' / ' + wszystkie + ' (' + Math.round((zrobione / wszystkie) * 100) + '%)');
}
