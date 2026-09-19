import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSession, mergeSub, decodeProjectDir } from '../src/parser.js';

const KOK = dirname(fileURLToPath(import.meta.url));
const ORNEK = join(KOK, 'fixtures', 'ornek.jsonl');
const SEP = String.fromCharCode(92);

test('klasor adi gercek yola cozulur', () => {
  assert.equal(decodeProjectDir('C--Users-hasan-Masaustu'),
    'C:' + SEP + 'Users' + SEP + 'hasan' + SEP + 'Masaustu');
  // Kodlanmamis ad oldugu gibi kalir
  assert.equal(decodeProjectDir('duz-ad'), 'duz-ad');
});

test('oturum sayimlari dogru', async () => {
  const s = await parseSession(ORNEK, 'C--p-demo');
  assert.equal(s.lines, 4);
  assert.equal(s.humanTurns, 1, 'tool_result iceren user mesaji insan turu sayilmaz');
  assert.equal(s.assistantMsgs, 2);
  assert.equal(s.toolCalls, 1);
  assert.equal(s.errorResults, 1);
  assert.equal(s.tools.get('Bash'), 1);
  assert.equal(s.firstPrompt, 'merhaba dunya');
  assert.equal(s.gitBranch, 'main');
});

test('gercek cwd klasor adindaki kayipli kodlamayi ezer', async () => {
  const s = await parseSession(ORNEK, 'C--p-demo');
  assert.equal(s.projectPath, 'C:' + SEP + 'p' + SEP + 'demo');
});

test('aktif sure molalari saymaz, zaman araligi dogru', async () => {
  const s = await parseSession(ORNEK, 'C--p-demo');
  assert.equal(s.startedAt, Date.parse('2026-01-01T10:00:00.000Z'));
  assert.equal(s.endedAt, Date.parse('2026-01-01T10:00:20.000Z'));
  assert.equal(s.activeMs, 20_000);
});

test('maliyet iki mesajin toplami', async () => {
  const s = await parseSession(ORNEK, 'C--p-demo');
  // 0.025 (ilk mesaj, cache dahil) + 0.00375 (ikinci mesaj)
  assert.ok(Math.abs(s.usd - 0.02875) < 1e-12, 'beklenen 0.02875, gelen ' + s.usd);
  assert.equal(s.unknownCost, false);
  const m = s.models.get('claude-opus-5');
  assert.equal(m.msgs, 2);
  assert.equal(m.in, 1500);
  assert.equal(m.out, 150);
  assert.equal(m.cacheW, 2000);
  assert.equal(m.cacheR, 10000);
});

test('alt-ajan toplamlari ana oturuma katilir', async () => {
  const ana = await parseSession(ORNEK, 'C--p-demo');
  const alt = await parseSession(ORNEK, 'C--p-demo');
  const oncekiUsd = ana.usd;
  mergeSub(ana, alt);
  assert.equal(ana.subSessions, 1);
  assert.ok(Math.abs(ana.usd - oncekiUsd * 2) < 1e-12);
  assert.equal(ana.toolCalls, 2);
  assert.equal(ana.models.get('claude-opus-5').msgs, 4);
  // Insan turu alt-ajandan gelmez: alt-ajanin promptu senin promptun degil.
  assert.equal(ana.humanTurns, 1);
});
