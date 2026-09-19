import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateFor, costOf, bilinmeyenModeller, fiyatBilgisi } from '../src/pricing.js';

test('bilinen modelin fiyati tablodan gelir', () => {
  assert.deepEqual(rateFor('claude-opus-5'), { in: 5, out: 25 });
  assert.deepEqual(rateFor('claude-haiku-4-5'), { in: 1, out: 5 });
});

test('tanitim fiyati sadece bitis tarihinden once gecerli', () => {
  const once = Date.parse('2026-08-01T00:00:00Z');
  const sonra = Date.parse('2026-09-02T00:00:00Z');
  assert.deepEqual(rateFor('claude-sonnet-5', once), { in: 2, out: 10 });
  assert.deepEqual(rateFor('claude-sonnet-5', sonra), { in: 3, out: 15 });
  // Zaman verilmezse tanitim varsayilmaz: guncel fiyat kullanilir.
  assert.deepEqual(rateFor('claude-sonnet-5'), { in: 3, out: 15 });
});

test('tarih sonekli model kimligi tarihsiz karsiligina duser', () => {
  assert.deepEqual(rateFor('claude-opus-5-20260401'), { in: 5, out: 25 });
});

test('cache carpanlari dogru uygulanir', () => {
  // in=5, out=25. (1000*5 + 2000*5*1.25 + 10000*5*0.1 + 100*25) / 1e6
  const { usd, unknown } = costOf('claude-opus-5', {
    input_tokens: 1000, output_tokens: 100,
    cache_creation_input_tokens: 2000, cache_read_input_tokens: 10000,
  });
  assert.equal(unknown, false);
  assert.equal(usd, 0.025);
});

test('1 saatlik cache yazmasi 5 dakikalikttan pahali', () => {
  const bes = costOf('claude-opus-5', {
    input_tokens: 0, output_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 },
  }).usd;
  const bir = costOf('claude-opus-5', {
    input_tokens: 0, output_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
  }).usd;
  assert.equal(bes, (1000 * 5 * 1.25) / 1e6);
  assert.equal(bir, (1000 * 5 * 2.0) / 1e6);
});

test('synthetic ucretsizdir, bilinmeyen isaretlenmez', () => {
  const r = costOf('<synthetic>', { input_tokens: 9999, output_tokens: 9999 });
  assert.deepEqual(r, { usd: 0, unknown: false });
});

test('bilinmeyen model 0 doner ama sessiz kalmaz', () => {
  const r = costOf('claude-olmayan-model-9', { input_tokens: 100 });
  assert.equal(r.usd, 0);
  assert.equal(r.unknown, true);
  assert.ok(bilinmeyenModeller().some((b) => b.model === 'claude-olmayan-model-9'));
});

test('fiyat tablosu tarihini bildirir', () => {
  assert.match(fiyatBilgisi().guncellendi, /^\d{4}-\d{2}-\d{2}$/);
});
