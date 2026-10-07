import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildInvoiceFileName, pdfBufferFromBase64, uploadInvoicePdf, isDriveConfigured } from '../src/drive.js';

const pdf = Buffer.from('%PDF-1.4\nfaktura\n');

test('buildInvoiceFileName: data, numer i dostawca bez znaków specjalnych', () => {
  const name = buildInvoiceFileName({ invoiceDate: '2026-10-07', invoiceNumber: 'FS-92/26/10/B2C', supplier: 'Biuro Sp. z o.o.' });
  assert.equal(name, '2026-10-07_FS-92-26-10-B2C_Biuro-Sp.-z-o.o..pdf');
});

test('buildInvoiceFileName: brak daty -> dzisiejsza', () => {
  const name = buildInvoiceFileName({ invoiceNumber: '1/2026' }, new Date('2026-03-04T10:00:00Z'));
  assert.equal(name, '2026-03-04_1-2026.pdf');
});

test('pdfBufferFromBase64: przyjmuje data URL, odrzuca nie-PDF i pusty plik', () => {
  const b64 = pdf.toString('base64');
  assert.deepEqual(pdfBufferFromBase64('data:application/pdf;base64,' + b64), pdf);
  assert.throws(() => pdfBufferFromBase64(Buffer.from('hello').toString('base64')), /nie jest plik PDF/);
  assert.throws(() => pdfBufferFromBase64(''), /Brak pliku/);
});

test('uploadInvoicePdf: token, foldery RRRR/MM i upload multipart', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = {
    client_email: 'test@proj.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: 'https://oauth.test/token'
  };
  process.env.GOOGLE_SERVICE_ACCOUNT_B64 = Buffer.from(JSON.stringify(sa)).toString('base64');
  process.env.DRIVE_INVOICES_FOLDER_ID = 'ROOT';
  assert.equal(isDriveConfigured(), true);

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    calls.push({ url, method: opts.method || 'GET', body: opts.body });
    const json = body => ({ ok: true, status: 200, json: async () => body });
    if (url.startsWith('https://oauth.test/token')) {
      const params = new URLSearchParams(String(opts.body));
      assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      return json({ access_token: 'TOK', expires_in: 3600 });
    }
    assert.equal(opts.headers.Authorization, 'Bearer TOK');
    if (url.includes('/upload/drive/v3/files')) {
      return json({ id: 'FILE1', name: 'x.pdf', webViewLink: 'https://drive.google.com/file/d/FILE1/view' });
    }
    if (opts.method === 'POST') return json({ id: 'NEW' + calls.length });
    return json({ files: [] });
  };
  try {
    const out = await uploadInvoicePdf({ buffer: pdf, invoiceDate: '2026-10-07', invoiceNumber: 'FS-1', supplier: 'Dost' });
    assert.equal(out.driveId, 'FILE1');
    assert.equal(out.folderPath, '2026/10');
    assert.equal(out.webViewLink, 'https://drive.google.com/file/d/FILE1/view');
    assert.equal(out.size, pdf.length);
    assert.equal(out.sha256, crypto.createHash('sha256').update(pdf).digest('hex'));

    const upload = calls.find(c => c.url.includes('/upload/drive/v3/files'));
    assert.ok(Buffer.isBuffer(upload.body) && upload.body.includes(pdf), 'PDF jest w treści multipart');
    assert.ok(upload.body.toString('latin1').includes('"name":"2026-10-07_FS-1_Dost.pdf"'));
    assert.ok(calls.filter(c => c.method === 'POST' && !c.url.includes('/upload/') && !c.url.includes('oauth.test')).length === 2, 'utworzono folder roku i miesiąca');
  } finally {
    globalThis.fetch = realFetch;
  }
});
