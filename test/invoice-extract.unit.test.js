import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractWarehouseItemsFromText } from '../src/invoice-extract.js';

test('Perplexity Agent API: żądanie na /v1/agent i odczyt output[].content[].text', async () => {
  process.env.PERPLEXITY_API_KEY = 'pplx-test';
  const realFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, opts) => {
    seen = { url: String(url), headers: opts.headers, body: JSON.parse(opts.body) };
    return {
      ok: true, status: 200,
      json: async () => ({
        status: 'completed',
        output: [
          { type: 'search_results', results: [] },
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
            supplier: 'Dostawca Sp. z o.o.', invoiceNumber: 'FS-1/26', invoiceDate: '2026-10-07',
            items: [{ name: 'Papier A4', quantity: 2, unit: 'szt.', unitPriceNet: 12.5, currency: 'PLN' }]
          }) }] }
        ]
      })
    };
  };
  try {
    const out = await extractWarehouseItemsFromText('Faktura FS-1/26 Papier A4 2 szt. 12,50');
    assert.equal(seen.url, 'https://api.perplexity.ai/v1/agent');
    assert.equal(seen.headers.Authorization, 'Bearer pplx-test');
    assert.ok(seen.body.model && seen.body.instructions && seen.body.input.includes('Papier A4'));
    assert.equal(seen.body.response_format.type, 'json_schema');
    assert.equal(seen.body.response_format.json_schema.name, 'invoice_items');
    assert.equal(seen.body.messages, undefined);
    assert.equal(seen.body.tools, undefined, 'bez narzędzi — brak wyszukiwania w sieci');
    assert.equal(out.invoiceNumber, 'FS-1/26');
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].unitPriceNet, 12.5);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Perplexity Agent API: pusta odpowiedź i błąd HTTP dają czytelny błąd 502', async () => {
  process.env.PERPLEXITY_API_KEY = 'pplx-test';
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ output: [] }) });
    await assert.rejects(extractWarehouseItemsFromText('x'), e => e.status === 502 && /nie zwróciło treści/.test(e.message));

    globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => '{"type":"chat_completions_not_available"}' });
    await assert.rejects(extractWarehouseItemsFromText('x'), e => e.status === 502 && /403/.test(e.message) && /not_available/.test(e.detail));
  } finally {
    globalThis.fetch = realFetch;
  }
});
