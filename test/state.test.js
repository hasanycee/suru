import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { oturumDurumu, DURUM } from '../src/state.js';

const ORNEK = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ornek.jsonl');

test('end_turn ile biten oturum seni bekliyor', async () => {
  const d = await oturumDurumu(ORNEK);
  assert.equal(d.durum, DURUM.SENI);
  assert.equal(d.model, 'claude-opus-5');
  assert.equal(d.dal, 'main');
  assert.equal(d.sonMetin, 'is bitti');
  assert.equal(d.bekleyenArac, null, 'arac sonucu geldiyse bekleyen arac kalmaz');
  assert.equal(d.kesin, false);
});
