// Zapis faktur zakupowych (PDF) na Google Drive przez service account.
//
// Bez zależności npm: JWT podpisujemy wbudowanym `crypto`, resztę robi `fetch` po REST
// Drive v3. Konfiguracja przez env (puste = zapis wyłączony, import faktury działa dalej):
//   GOOGLE_SERVICE_ACCOUNT_B64  — plik JSON klucza konta usługi zakodowany w base64
//   DRIVE_INVOICES_FOLDER_ID    — ID folderu / Dysku współdzielonego na faktury
// Konto usługi widzi tylko to, co mu udostępniono, więc zakres `drive` jest bezpieczny.

import crypto from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/drive';
const FILES_API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const MAX_INVOICE_PDF_BYTES = 8 * 1024 * 1024;

let cachedToken = null;

export function isDriveConfigured() {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_B64 && process.env.DRIVE_INVOICES_FOLDER_ID);
}

function loadServiceAccount() {
  let sa;
  try {
    sa = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_B64 || '', 'base64').toString('utf8'));
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_B64 nie jest poprawnym base64 z JSON-em klucza.');
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error('Klucz konta usługi nie zawiera client_email / private_key.');
  }
  return sa;
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.value;

  const sa = loadServiceAccount();
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: sa.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600
  });
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + signature
    })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Google odrzucił klucz konta usługi (${res.status}${json.error ? ' ' + json.error : ''}).`);
  }
  cachedToken = { value: json.access_token, exp: now + (Number(json.expires_in) || 3600) };
  return cachedToken.value;
}

async function driveJson(url, options, token) {
  const res = await fetch(url, { ...options, headers: { ...(options?.headers || {}), Authorization: 'Bearer ' + token } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Drive: ${json.error?.message || 'błąd'} (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function ensureFolder(parentId, name, token) {
  const q = `name = '${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const params = new URLSearchParams({
    q, fields: 'files(id)', pageSize: '1',
    supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', corpora: 'allDrives'
  });
  const found = await driveJson(`${FILES_API}?${params}`, {}, token);
  if (found.files?.[0]?.id) return found.files[0].id;

  const created = await driveJson(`${FILES_API}?supportsAllDrives=true&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] })
  }, token);
  return created.id;
}

// Zwraca Buffer z PDF-a podanego jako base64 (z opcjonalnym prefiksem data:) albo rzuca.
export function pdfBufferFromBase64(fileBase64) {
  if (typeof fileBase64 !== 'string' || !fileBase64.trim()) throw new Error('Brak pliku PDF.');
  const comma = fileBase64.indexOf(',');
  const b64 = fileBase64.startsWith('data:') && comma !== -1 ? fileBase64.slice(comma + 1) : fileBase64;
  const buffer = Buffer.from(b64, 'base64');
  if (!buffer.length || buffer.length > MAX_INVOICE_PDF_BYTES) throw new Error('Plik PDF jest pusty albo za duży.');
  if (buffer.subarray(0, 4).toString('latin1') !== '%PDF') throw new Error('To nie jest plik PDF.');
  return buffer;
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(new Date(value).getTime());
}

export function buildInvoiceFileName({ invoiceDate, invoiceNumber, supplier }, today = new Date()) {
  const date = validDate(invoiceDate) ? invoiceDate : today.toISOString().slice(0, 10);
  const clean = s => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '');
  const base = [date, clean(invoiceNumber), clean(supplier)].filter(Boolean).join('_').slice(0, 150);
  return base + '.pdf';
}

// Zapisuje PDF w <folder faktur>/RRRR/MM/ i zwraca dane do zapisania na dokumencie.
export async function uploadInvoicePdf({ buffer, invoiceDate, invoiceNumber, supplier }, today = new Date()) {
  const token = await getAccessToken();
  const date = validDate(invoiceDate) ? invoiceDate : today.toISOString().slice(0, 10);
  const [year, month] = date.split('-');
  const yearId = await ensureFolder(process.env.DRIVE_INVOICES_FOLDER_ID, year, token);
  const monthId = await ensureFolder(yearId, month, token);

  const name = buildInvoiceFileName({ invoiceDate, invoiceNumber, supplier }, today);
  const boundary = 'zaplecze' + crypto.randomBytes(8).toString('hex');
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
    + JSON.stringify({ name, parents: [monthId], mimeType: 'application/pdf' })
    + `\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`;
  const body = Buffer.concat([Buffer.from(head), buffer, Buffer.from(`\r\n--${boundary}--`)]);

  const file = await driveJson(
    `${UPLOAD_API}?uploadType=multipart&supportsAllDrives=true&fields=id,name,size,webViewLink`,
    { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body },
    token
  );
  return {
    driveId: file.id,
    name: file.name,
    webViewLink: file.webViewLink || null,
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    folderPath: `${year}/${month}`,
    uploadedAt: new Date()
  };
}
