// Automatyczne wczytywanie pozycji z faktury (PDF) i wypełnianie formularza dodania sprzętu.
//
// Przepływ: przeglądarka czyta PDF jako base64 -> ten moduł wyciąga z niego tekst
// (deterministycznie) -> tekst trafia do Perplexity z wymuszonym JSON-em
// -> zwracamy listę pozycji, którą admin przegląda przed zapisem.
//
// Perplexity wołamy zwykłym fetch-em (bez SDK) przez Agent API (`/v1/agent`) — stary
// endpoint Sonar `chat/completions` zwraca 403 `chat_completions_not_available`.
//
// Do czytania PDF-a używamy `unpdf` (nie pdf-parse) — ma build pdf.js przeznaczony
// dla środowisk serverless/Node, bez zależności od API przeglądarki (DOMMatrix),
// które wywalało odczyt realnych faktur na Vercelu.

import { getDocumentProxy, extractText } from 'unpdf';

const PERPLEXITY_URL = 'https://api.perplexity.ai/v1/agent';
// ID w formacie `dostawca/model` (lista: docs.perplexity.ai/docs/agent-api/models).
const PERPLEXITY_MODEL = process.env.PERPLEXITY_MODEL || 'perplexity/sonar';

// Ostrożne limity – faktura to zwykle 1–2 strony. Chronią przed przypadkowym
// wrzuceniem wielkiego pliku (a i tak Vercel tnie body ~4.5 MB).
const MAX_PDF_BYTES = 8 * 1024 * 1024; // 8 MB surowego PDF
const MAX_TEXT_CHARS = 60000; // tekst wysyłany do modelu

// Schemat JSON, którego trzyma się model. Pola dopasowane do formularza sprzętu.
const ITEM_JSON_SCHEMA = {
  type: 'object',
  properties: {
    supplier: { type: 'string', description: 'Nazwa sprzedawcy / dostawcy z faktury' },
    invoiceNumber: { type: 'string', description: 'Numer faktury' },
    invoiceDate: { type: 'string', description: 'Data wystawienia w formacie RRRR-MM-DD, jeśli jest' },
    items: {
      type: 'array',
      description: 'Pozycje z faktury, po jednej na wiersz towaru',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Krótka, czytelna nazwa sprzętu' },
          category: { type: 'string', description: 'Zgadnięta kategoria po polsku, np. Lampy, Kamery, Statywy, Kable' },
          brand: { type: 'string', description: 'Marka/producent, jeśli da się ustalić, inaczej pusty' },
          model: { type: 'string', description: 'Model/oznaczenie, jeśli jest, inaczej pusty' },
          serialNumber: { type: 'string', description: 'Numer seryjny, jeśli jest na fakturze, inaczej pusty' },
          quantity: { type: 'integer', description: 'Ilość sztuk, minimum 1' },
          unitPrice: { type: 'number', description: 'Cena jednostkowa netto lub brutto, jeśli da się odczytać, inaczej 0' },
          currency: { type: 'string', description: 'Waluta, np. PLN, jeśli podana' }
        },
        required: ['name', 'category', 'quantity']
      }
    }
  },
  required: ['items']
};

// Schemat magazynowy. `unitPriceNet` celowo nazwany wprost — w wariancie sprzętowym
// pole `unitPrice` dopuszczało „netto lub brutto", co przy partiach FIFO byłoby błędem.
const WAREHOUSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    supplier: { type: 'string', description: 'Nazwa sprzedawcy / dostawcy z faktury' },
    invoiceNumber: { type: 'string', description: 'Numer faktury dokładnie tak, jak zapisany na dokumencie' },
    invoiceDate: { type: 'string', description: 'Data wystawienia w formacie RRRR-MM-DD, jeśli jest' },
    items: {
      type: 'array',
      description: 'Pozycje towarowe faktury, po jednej na wiersz',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nazwa towaru przepisana z faktury' },
          quantity: { type: 'number', description: 'Ilość; może być ułamkowa przy kilogramach' },
          unit: { type: 'string', description: 'Jednostka miary z faktury: szt., kg, opak., itp.' },
          unitPriceNet: { type: 'number', description: 'Cena jednostkowa NETTO. Jeśli na fakturze jest tylko brutto, przelicz na netto po stawce VAT z tego wiersza.' },
          currency: { type: 'string', description: 'Waluta, np. PLN' }
        },
        required: ['name', 'quantity']
      }
    }
  },
  required: ['items']
};

const WAREHOUSE_SYSTEM_PROMPT = [
  'Jesteś asystentem magazynu. Dostajesz surowy tekst faktury ZAKUPOWEJ (po polsku).',
  'Wypisz pozycje towarowe w ustrukturyzowanym JSON, pod dokument przyjęcia na magazyn.',
  'Zasady:',
  '- Jedna pozycja towarowa faktury = jeden element listy items.',
  '- Pomiń wiersze niebędące towarem: transport, wysyłka, rabaty, zaliczki, sumy, VAT, opłaty.',
  '- Nazwę PRZEPISZ z faktury, nie skracaj i nie upiększaj — służy do dopasowania do kartoteki.',
  '- unitPriceNet to cena jednostkowa NETTO. To najważniejsze pole: wchodzi do wyceny magazynu.',
  '  Jeśli faktura podaje tylko ceny brutto, przelicz na netto po stawce VAT z danego wiersza.',
  '  Jeśli wiersz podaje wartość netto pozycji zamiast ceny jednostkowej, podziel przez ilość.',
  '- quantity może być ułamkowa (np. 9.5 przy kilogramach) — nie zaokrąglaj.',
  '- unit przepisz z faktury (szt., kg, opak., kpl.).',
  '- Niczego nie zmyślaj. Brak danych to pusty string lub 0.',
  '- Zwróć wyłącznie dane zgodne ze schematem, bez komentarzy.'
].join('\n');

const SYSTEM_PROMPT = [
  'Jesteś asystentem ewidencji sprzętu. Dostajesz surowy tekst wyciągnięty z faktury zakupowej (po polsku).',
  'Twoim zadaniem jest wypisać pozycje sprzętu z faktury w ustrukturyzowanym JSON.',
  'Zasady:',
  '- Jedna pozycja towarowa faktury = jeden element listy items.',
  '- Pomiń wiersze niebędące towarem (usługi transportu, rabaty, sumy, VAT, opłaty).',
  '- Nazwa ma być krótka i ludzka (np. "Lampa Streamplify Light 10"), nie cały opis z faktury.',
  '- Kategorię ZGADNIJ po polsku na podstawie nazwy (Lampy, Kamery, Obiektywy, Statywy, Mikrofony, Kable, Akcesoria...).',
  '- Jeśli czegoś nie ma na fakturze, zostaw pusty string lub 0 – nie zmyślaj numerów seryjnych ani modeli.',
  '- Nie dodawaj komentarzy, zwróć wyłącznie dane zgodne ze schematem.'
].join('\n');

/**
 * Wyciąga tekst z PDF-a przekazanego jako base64 (z opcjonalnym prefiksem data:).
 * Zwraca { text, pages } albo rzuca czytelnym błędem.
 */
export async function extractPdfText(fileBase64) {
  if (typeof fileBase64 !== 'string' || !fileBase64.trim()) {
    const err = new Error('Brak pliku PDF.');
    err.status = 400;
    throw err;
  }

  // Odetnij ewentualny prefiks "data:application/pdf;base64,".
  const commaIdx = fileBase64.indexOf(',');
  const b64 = fileBase64.startsWith('data:') && commaIdx !== -1
    ? fileBase64.slice(commaIdx + 1)
    : fileBase64;

  let buffer;
  try {
    buffer = Buffer.from(b64, 'base64');
  } catch (_) {
    const err = new Error('Nie udało się odczytać pliku (błędny base64).');
    err.status = 400;
    throw err;
  }

  if (!buffer.length) {
    const err = new Error('Plik jest pusty.');
    err.status = 400;
    throw err;
  }
  if (buffer.length > MAX_PDF_BYTES) {
    const err = new Error('Plik za duży (max 8 MB). Zapisz fakturę jako mniejszy PDF.');
    err.status = 413;
    throw err;
  }
  // Sygnatura PDF: "%PDF".
  if (buffer.slice(0, 4).toString('latin1') !== '%PDF') {
    const err = new Error('To nie jest plik PDF.');
    err.status = 400;
    throw err;
  }

  // unpdf: getDocumentProxy + extractText -> { text, totalPages }.
  let parsed;
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    parsed = await extractText(pdf, { mergePages: true });
  } catch (e) {
    const err = new Error('Nie udało się odczytać zawartości PDF-a.');
    err.status = 422;
    err.cause = e;
    throw err;
  }

  const text = String(parsed.text || '').trim();
  if (text.length < 20) {
    const err = new Error(
      'PDF nie zawiera warstwy tekstowej (to prawdopodobnie skan). ' +
      'Ta funkcja obsługuje PDF-y generowane komputerowo.'
    );
    err.status = 422;
    throw err;
  }

  return { text: text.slice(0, MAX_TEXT_CHARS), pages: parsed.totalPages || null };
}

/**
 * Wysyła tekst faktury do Perplexity i zwraca sparsowany obiekt zgodny ze schematem.
 */
export async function extractItemsFromText(text) {
  return callPerplexity(text, SYSTEM_PROMPT, ITEM_JSON_SCHEMA, normalizeResult);
}

/**
 * Wariant magazynowy: pozycje towarowe z faktury zakupowej pod dokument PRZYJĘCIA.
 * Różnice wobec sprzętu: bez marki/modelu/numeru seryjnego i bez zgadywania kategorii
 * (kategorię niesie dopasowany produkt), za to z jednostką i TWARDO ceną NETTO —
 * z niej powstaje partia cenowa FIFO, a VAT odliczamy, więc kosztem towaru jest netto.
 */
export async function extractWarehouseItemsFromText(text) {
  return callPerplexity(text, WAREHOUSE_SYSTEM_PROMPT, WAREHOUSE_JSON_SCHEMA, normalizeWarehouseResult);
}

async function callPerplexity(text, systemPrompt, schema, normalize) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    const err = new Error('Brak PERPLEXITY_API_KEY – ustaw klucz w zmiennych środowiskowych.');
    err.status = 503;
    throw err;
  }

  // Bez `tools` agent nie szuka w sieci — faktura tego nie potrzebuje.
  const payload = {
    model: PERPLEXITY_MODEL,
    instructions: systemPrompt,
    input: `Tekst faktury:\n\n${text}`,
    max_output_tokens: 8000,
    // Wymuszony JSON zgodny ze schematem (structured output).
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'invoice_items', schema }
    }
  };

  let resp;
  try {
    resp = await fetch(PERPLEXITY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    const err = new Error('Nie udało się połączyć z Perplexity.');
    err.status = 502;
    err.cause = e;
    throw err;
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const err = new Error(
      resp.status === 401
        ? 'Perplexity odrzuciło klucz API (401). Sprawdź PERPLEXITY_API_KEY.'
        : `Perplexity zwróciło błąd ${resp.status}.`
    );
    err.status = 502;
    err.detail = body.slice(0, 500);
    throw err;
  }

  let data;
  try {
    data = await resp.json();
  } catch (_) {
    const err = new Error('Perplexity zwróciło nieczytelną odpowiedź.');
    err.status = 502;
    throw err;
  }

  const content = (Array.isArray(data?.output) ? data.output : [])
    .filter(item => item?.type === 'message')
    .flatMap(item => Array.isArray(item.content) ? item.content : [])
    .filter(part => part?.type === 'output_text' && part.text)
    .map(part => part.text)
    .join('');
  if (!content) {
    const err = new Error('Perplexity nie zwróciło treści.');
    err.status = 502;
    throw err;
  }

  return parseModelJson(content, normalize);
}

// Model powinien zwrócić czysty JSON, ale bywa, że opakuje go w ```json ... ```
// albo doda tekst wokół. Wyłuskujemy pierwszy obiekt {...} i parsujemy defensywnie.
function parseModelJson(content, normalize) {
  let raw = String(content).trim();

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();

  if (!raw.startsWith('{')) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) raw = raw.slice(start, end + 1);
  }

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (_) {
    const err = new Error('Nie udało się rozpoznać pozycji w odpowiedzi modelu.');
    err.status = 502;
    throw err;
  }

  return normalize(obj);
}

// Sprowadza wynik do bezpiecznego, przewidywalnego kształtu dla frontendu.
function normalizeResult(obj) {
  const rawItems = Array.isArray(obj?.items) ? obj.items : [];
  const items = rawItems
    .map((it) => ({
      name: str(it?.name),
      category: str(it?.category),
      brand: str(it?.brand),
      model: str(it?.model),
      serialNumber: str(it?.serialNumber),
      quantity: Math.max(1, Math.trunc(Number(it?.quantity)) || 1),
      unitPrice: Number.isFinite(Number(it?.unitPrice)) ? Number(it.unitPrice) : 0,
      currency: str(it?.currency)
    }))
    .filter((it) => it.name && it.category);

  return {
    supplier: str(obj?.supplier),
    invoiceNumber: str(obj?.invoiceNumber),
    invoiceDate: str(obj?.invoiceDate),
    items
  };
}

// Wariant magazynowy: ilości ułamkowe przechodzą (kilogramy), kategorii nie zgadujemy,
// a cena to zawsze netto. Wiersz bez nazwy albo bez dodatniej ilości odpada.
function normalizeWarehouseResult(obj) {
  const rawItems = Array.isArray(obj?.items) ? obj.items : [];
  const items = rawItems
    .map((it) => {
      const qty = Number(it?.quantity);
      const price = Number(it?.unitPriceNet);
      return {
        name: str(it?.name),
        quantity: Number.isFinite(qty) && qty > 0 ? Math.round(qty * 1000) / 1000 : 0,
        unit: str(it?.unit) || 'szt.',
        unitPriceNet: Number.isFinite(price) && price > 0 ? Math.round(price * 100) / 100 : 0,
        currency: str(it?.currency) || 'PLN'
      };
    })
    .filter((it) => it.name && it.quantity > 0);

  return {
    supplier: str(obj?.supplier),
    invoiceNumber: str(obj?.invoiceNumber),
    invoiceDate: str(obj?.invoiceDate),
    items
  };
}

function str(v) {
  return v == null ? '' : String(v).trim();
}
