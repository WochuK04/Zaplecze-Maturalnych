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
 * 2. Usługi (+) → „Drive API" → v3 → Dodaj.   ← bez tego nie ma md5Checksum
 * 3. Ustaw KATALOGI_STARTOWE poniżej.
 * 4. Uruchom `startMapowania` (raz), potem `mapujDalej` tyle razy, ile trzeba.
 *    `postepMapowania` mówi, ile folderów zostało w kolejce.
 * 5. Zakładka „AllFiles" → Plik → Pobierz → CSV.
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
      nazwa = Drive.Files.get(id, { fields: 'name', supportsAllDrives: true }).name;
    } catch (e) {
      throw new Error('Nie mogę otworzyć katalogu ' + id + ': ' + e.message);
    }
    wiersze.push([id, nazwa]);
  }
  kolejka.getRange(2, 1, wiersze.length, 2).setValues(wiersze);
  kolejka.hideSheet();

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
    var odp = Drive.Files.list({
      q: "'" + folderId + "' in parents and trashed = false",
      fields: 'nextPageToken, files(id,name,mimeType,md5Checksum,size,createdTime,'
        + 'modifiedTime,owners(emailAddress),lastModifyingUser(emailAddress))',
      pageSize: 1000,
      pageToken: token,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });

    var lista = odp.files || [];
    for (var i = 0; i < lista.length; i++) {
      var f = lista[i];
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        foldery.push([f.id, path + '/' + f.name]);
        continue;
      }
      pliki.push([
        path,
        f.name || '',
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
    token = odp.nextPageToken;
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
