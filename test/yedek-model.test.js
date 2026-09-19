import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { isEkle, isGetir } from '../src/isler.js';
import { cliArgumanlari, devamArgumanlari } from '../src/yetki.js';

test('yedek model verilirse --fallback-model gecer', () => {
  const a = cliArgumanlari({ gorev: 'g', profil: 'serbest', sessionId: 's1', model: 'opus', yedekModel: 'sonnet' });
  assert.equal(a[a.indexOf('--fallback-model') + 1], 'sonnet');
  const d = devamArgumanlari({ cevap: 'devam', profil: 'serbest', sessionId: 's1', yedekModel: 'haiku' });
  assert.equal(d[d.indexOf('--fallback-model') + 1], 'haiku', 'devam kosusunda da yedek korunur');
});

test('yedek model yoksa bayrak hic eklenmez', () => {
  const a = cliArgumanlari({ gorev: 'g', profil: 'serbest', sessionId: 's1' });
  assert.ok(!a.includes('--fallback-model'));
});

test('yedek model is kaydinda saklanir, bos deger null olur', () => {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-yedek-'));
  const db = openDb(join(dizin, 'y.db'));
  const bir = isEkle(db, { ad: 'a', gorev: 'g', cwd: dizin, profil: 'serbest', yedekModel: 'sonnet' });
  const iki = isEkle(db, { ad: 'b', gorev: 'g', cwd: dizin, profil: 'serbest', yedekModel: '  ' });
  assert.equal(isGetir(db, bir.id).yedekModel, 'sonnet');
  assert.equal(isGetir(db, iki.id).yedekModel, null);
  db.close();
  try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra */ }
});
