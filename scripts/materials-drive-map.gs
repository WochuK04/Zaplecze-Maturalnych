/**
 * Mapa plików materiałów na Dysku — przejście po drzewie folderów.
 *
 * Rozwinięcie wcześniejszego `mapAllFiles` (rekurencja po DriveApp) o trzy rzeczy,
 * bez których nie dowiezie przy tej skali:
 *
 *   1. Drive API v3 `files.list` zamiast `DriveApp`. Powód zasadniczy: `md5Checksum`
 *      nie istnieje w DriveApp, a to po niego głównie idziemy — rozstrzyga, czy dwa
 *      rekordy o tej samej nazwie to ten sam plik. Powód praktyczny: jedno wywołanie
 *      na folder (do 1000 plików) zamiast jednego na plik plus osobnego na getSize().
 *   2. Kolejka folderów w arkuszu zamiast rekurencji. Apps Script ma 6 minut na
 *      uruchomienie; rekurencja po dużym drzewie przerwie się w losowym miejscu
 *      i zacznie od zera. Kolejka pozwala dopisywać przy kolejnych startach.
 *   3. `path` budowany przy schodzeniu w dół — kolumna, której nie ma w żadnym
 *      eksporcie, a która może wskazać folder „baza materiałów dodatkowych"
 *      (~300 kluczowych materiałów do pełnego opisu).
 *
 * ── JAK URUCHOMIĆ ────────────────────────────────────────────────────────────
 * 1. Arkusz Google → Rozszerzenia → Apps Script → wklej ten plik.
 * 2. Usługi (+) → „Drive API" → Dodaj (v3 zalecane, v2 też zadziała).
 *    ← bez tej usługi nie ma md5Checksum; zwykłe DriveApp go nie udostępnia
 * 3. Ustaw KATALOGI_STARTOWE poniżej.
 * 4. Uruchom `diagnostyka` — sprawdzi usługę, wersję API i dostęp do katalogów.
 * 5. Uruchom `startMapowania` (raz), potem `mapujDalej` tyle razy, ile trzeba.
 *    `postepMapowania` mówi, ile folderów zostało w kolejce.
 * 6. Zakładka „AllFiles" → Plik → Pobierz → CSV.
 *
 * Skrypt działa z Drive API v2 i v3 — wersję wykrywa sam i tłumaczy nazwy pól.
 */

// Można podać kilka korzeni — materiały bywają w różnych miejscach.
var KATALOGI_STARTOWE = [
  '10B3ep0v6w5GIkMTpNGWQ6ugYapF0yPd_'
];

var ARKUSZ_PLIKI = 'AllFiles';
var ARKUSZ_KOLEJKA = '_kolejka';
var LIMIT_MS = 4.5 * 60 * 1000;

var NAGLOWKI = ['path', 'file_name', 'file_id', 'md5', 'size_bytes', 'mime_type',
                'created', 'modified', 'owner', 'last_editor', 'link'];

// ─────────────────────────────────────────────────────────────────────────────
// ZGODNOŚĆ v2 / v3
//
// Usługa zaawansowana „Drive API" w Apps Script występuje w dwóch wersjach i mają
// one RÓŻNE nazwy pól. To najczęstsza przyczyna komunikatu „Wystąpił nieznany błąd":
// żądanie z polem `name` leci do v2, które zna tylko `title`, i API odrzuca je bez
// czytelnego powodu.
//
//            v2                      v3
//   nazwa    title                   name
//   lista    items                   files
//   limit    maxResults              pageSize
//   daty     createdDate/            createdTime/
//            modifiedDate            modifiedTime
//   MIME     mimeType                mimeType          (tu zgodne)
//   md5      md5Checksum             md5Checksum       (tu zgodne)
//
// Wersję wykrywamy raz, przy pierwszym użyciu, i dalej tłumaczymy pola.
var _wersjaApi = null;

function wersjaApi_() {
  if (_wersjaApi) return _wersjaApi;
  if (typeof Drive === 'undefined') {
    throw new Error('Usługa „Drive API" nie jest dodana. Edytor → Usługi (+) → Drive API → Dodaj.');
  }
  try {
    Drive.Files.list({ pageSize: 1, fields: 'files(id)' });
    _wersjaApi = 3;
  } catch (e) {
    _wersjaApi = 2;
  }
  return _wersjaApi;
}

/** Nazwa pliku/folderu, niezależnie od wersji API. */
function nazwaPliku_(f) { return f.name || f.title || ''; }

/** Jedno żądanie listujące zawartość folderu; zwraca { pozycje, token }. */
function listujFolder_(folderId, token) {
  var q = "'" + folderId + "' in parents and trashed = false";
  if (wersjaApi_() === 3) {
    var o3 = Drive.Files.list({
      q: q, pageSize: 1000, pageToken: token,
      fields: 'nextPageToken, files(id,name,mimeType,md5Checksum,size,createdTime,'
        + 'modifiedTime,owners(emailAddress),lastModifyingUser(emailAddress))',
      supportsAllDrives: true, includeItemsFromAllDrives: true
    });
    return { pozycje: o3.files || [], token: o3.nextPageToken };
  }
  var o2 = Drive.Files.list({
    q: q, maxResults: 1000, pageToken: token,
    supportsAllDrives: true, includeItemsFromAllDrives: true
  });
  var poz = (o2.items || []).map(function (f) {
    return {
      id: f.id, name: f.title, mimeType: f.mimeType, md5Checksum: f.md5Checksum,
      size: f.fileSize, createdTime: f.createdDate, modifiedTime: f.modifiedDate,
      owners: f.owners, lastModifyingUser: f.lastModifyingUser
    };
  });
  return { pozycje: poz, token: o2.nextPageToken };
}

/**
 * URUCHOM TO NAJPIERW, gdy coś nie działa. Zamienia „nieznany błąd" w konkret.
 */
function diagnostyka() {
  var linie = [];
  if (typeof Drive === 'undefined') {
    Logger.log('BŁĄD: usługa „Drive API" nie jest dodana.\n'
      + 'Edytor Apps Script → Usługi (+) → Drive API → Dodaj.');
    return;
  }
  linie.push('Usługa Drive: dodana');
  var w;
  try { w = wersjaApi_(); } catch (e) { Logger.log('BŁĄD: ' + e.message); return; }
  linie.push('Wykryta wersja API: v' + w + (w === 2 ? '  (działa, pola tłumaczone)' : ''));

  for (var i = 0; i < KATALOGI_STARTOWE.length; i++) {
    var id = KATALOGI_STARTOWE[i];
    try {
      var f = (w === 3)
        ? Drive.Files.get(id, { fields: 'id,name,mimeType', supportsAllDrives: true })
        : Drive.Files.get(id, { supportsAllDrives: true });
      var typ = f.mimeType === 'application/vnd.google-apps.folder' ? 'katalog' : 'NIE KATALOG';
      linie.push('Katalog ' + id + ': „' + nazwaPliku_(f) + '" (' + typ + ')');
      var probka = listujFolder_(id, null);
      linie.push('  zawartość pierwszej strony: ' + probka.pozycje.length + ' pozycji');
      var zMd5 = 0;
      for (var k = 0; k < probka.pozycje.length; k++) if (probka.pozycje[k].md5Checksum) zMd5++;
      linie.push('  z sumą kontrolną: ' + zMd5
        + (zMd5 === 0 && probka.pozycje.length > 0
            ? '  ← same podfoldery albo pliki Google (Dokumenty/Arkusze nie mają md5)' : ''));
    } catch (e) {
      linie.push('Katalog ' + id + ': BŁĄD — ' + e.message);
      linie.push('  → sprawdź, czy identyfikator jest poprawny i czy masz dostęp z TEGO konta.');
    }
  }
  Logger.log(linie.join('\n'));
}

function startMapowania() {
  var ss = SpreadsheetApp.getActive();

  var pliki = ss.getSheetByName(ARKUSZ_PLIKI) || ss.insertSheet(ARKUSZ_PLIKI);
  pliki.clearContents();
  pliki.getRange(1, 1, 1, NAGLOWKI.length).setValues([NAGLOWKI]);
  pliki.setFrozenRows(1);

  var kolejka = ss.getSheetByName(ARKUSZ_KOLEJKA) || ss.insertSheet(ARKUSZ_KOLEJKA);
  kolejka.clearContents();
  kolejka.appendRow(['folderId', 'path']);

  var wiersze = [];
  for (var i = 0; i < KATALOGI_STARTOWE.length; i++) {
    var id = KATALOGI_STARTOWE[i];
    var nazwa;
    try {
      var meta = (wersjaApi_() === 3)
        ? Drive.Files.get(id, { fields: 'id,name', supportsAllDrives: true })
        : Drive.Files.get(id, { supportsAllDrives: true });
      nazwa = nazwaPliku_(meta);
    } catch (e) {
      throw new Error('Nie mogę otworzyć katalogu ' + id + ': ' + e.message
        + '  — uruchom `diagnostyka`, żeby zobaczyć, co dokładnie odmawia.');
    }
    wiersze.push([id, nazwa]);
  }
  kolejka.getRange(2, 1, wiersze.length, 2).setValues(wiersze);
  // Ukrycie arkusza potrafi rzucić, gdy jest jedynym widocznym — to kosmetyka, nie błąd.
  try { kolejka.hideSheet(); } catch (e) {}

  Logger.log('Kolejka zasiana (' + wiersze.length + ' katalogów). Uruchom `mapujDalej`.');
}

function mapujDalej() {
  var ss = SpreadsheetApp.getActive();
  var pliki = ss.getSheetByName(ARKUSZ_PLIKI);
  var kolejka = ss.getSheetByName(ARKUSZ_KOLEJKA);
  if (!pliki || !kolejka) throw new Error('Najpierw uruchom `startMapowania`.');

  var t0 = new Date().getTime();
  var bufor = [];
  var noweFoldery = [];
  var przetworzone = 0;

  while (new Date().getTime() - t0 < LIMIT_MS) {
    var zadanie = zdejmijZKolejki_(kolejka);
    if (!zadanie) break;

    var wynik = przejdzFolder_(zadanie.folderId, zadanie.path);
    for (var i = 0; i < wynik.pliki.length; i++) bufor.push(wynik.pliki[i]);
    for (var j = 0; j < wynik.foldery.length; j++) noweFoldery.push(wynik.foldery[j]);
    przetworzone++;

    if (bufor.length >= 200) {
      zapisz_(pliki, bufor); bufor = [];
      dopiszDoKolejki_(kolejka, noweFoldery); noweFoldery = [];
    }
  }

  if (bufor.length) zapisz_(pliki, bufor);
  if (noweFoldery.length) dopiszDoKolejki_(kolejka, noweFoldery);

  var zostalo = Math.max(0, kolejka.getLastRow() - 1);
  Logger.log('Przetworzono ' + przetworzone + ' katalogów w tym przebiegu. '
    + 'Plików łącznie: ' + (pliki.getLastRow() - 1) + '. W kolejce: ' + zostalo + '.'
    + (zostalo ? ' Uruchom `mapujDalej` ponownie.' : ' GOTOWE.'));
}

/**
 * Jeden folder: pliki (z sumą kontrolną) i podfoldery do kolejki. Stronicowanie
 * po 1000 — foldery z tysiącami plików są tu realne.
 */
function przejdzFolder_(folderId, path) {
  var pliki = [];
  var foldery = [];
  var token = null;

  do {
    var odp = listujFolder_(folderId, token);
    var lista = odp.pozycje;
    for (var i = 0; i < lista.length; i++) {
      var f = lista[i];
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        foldery.push([f.id, path + '/' + nazwaPliku_(f)]);
        continue;
      }
      pliki.push([
        path,
        nazwaPliku_(f),
        f.id,
        f.md5Checksum || '',   // puste dla Dokumentów/Arkuszy Google — nie mają binarnej treści
        f.size || '',
        f.mimeType || '',
        f.createdTime || '',
        f.modifiedTime || '',
        (f.owners && f.owners[0] && f.owners[0].emailAddress) || '',
        (f.lastModifyingUser && f.lastModifyingUser.emailAddress) || '',
        'https://drive.google.com/file/d/' + f.id + '/view'
      ]);
    }
    token = odp.token;
  } while (token);

  return { pliki: pliki, foldery: foldery };
}

function zdejmijZKolejki_(kolejka) {
  if (kolejka.getLastRow() < 2) return null;
  var w = kolejka.getRange(2, 1, 1, 2).getValues()[0];
  kolejka.deleteRow(2);
  return { folderId: String(w[0]), path: String(w[1]) };
}

function dopiszDoKolejki_(kolejka, wiersze) {
  if (!wiersze.length) return;
  kolejka.getRange(kolejka.getLastRow() + 1, 1, wiersze.length, 2).setValues(wiersze);
}

function zapisz_(arkusz, wiersze) {
  arkusz.getRange(arkusz.getLastRow() + 1, 1, wiersze.length, NAGLOWKI.length).setValues(wiersze);
}

function postepMapowania() {
  var ss = SpreadsheetApp.getActive();
  var kolejka = ss.getSheetByName(ARKUSZ_KOLEJKA);
  var pliki = ss.getSheetByName(ARKUSZ_PLIKI);
  Logger.log('Plików: ' + (pliki ? pliki.getLastRow() - 1 : 0)
    + ' · katalogów w kolejce: ' + (kolejka ? Math.max(0, kolejka.getLastRow() - 1) : 0));
}
