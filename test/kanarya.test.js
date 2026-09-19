import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { openDb } from '../src/db.js';
import { OLAY, oku as olayOku } from '../src/events.js';
import { isEkle, kosuAc, kosuGetir, KOSU_DURUMU } from '../src/isler.js';
import { kosuBaslat } from '../src/kosucu.js';
import { ayarYuklendiMi, ayarNesnesi, KANARYA, PROFILLER, cliArgumanlari, devamArgumanlari, mcpSizdiMi } from '../src/yetki.js';

test('her profilde hem yeni hem devam kosusu MCPsiz baslar (--strict-mcp-config)', () => {
  for (const ad of Object.keys(PROFILLER)) {
    const yeni = cliArgumanlari({ gorev: 'g', profil: ad, sessionId: 's1' });
    const devam = devamArgumanlari({ cevap: 'c', profil: ad, sessionId: 's1' });
    assert.ok(yeni.includes('--strict-mcp-config'), ad + ' yeni kosu');
    assert.ok(devam.includes('--strict-mcp-config'), ad + ' devam kosusu');
    assert.ok(!yeni.includes('--mcp-config'), 'acikca MCP verilmiyor');
  }
  assert.deepEqual(mcpSizdiMi(['Read', 'mcp__unity-mcp__Unity_RunCommand', 'Bash']), ['mcp__unity-mcp__Unity_RunCommand']);
  assert.deepEqual(mcpSizdiMi(['Read', 'Bash']), []);
  assert.deepEqual(mcpSizdiMi(undefined), []);
});

test('MCP araclari ajana sizdiysa kosu arac cagrisi olmadan HATA ile kesilir', async () => {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-mcp-'));
  const db = openDb(join(dizin, 'k.db'));
  try {
    // gozlemci: arac listesi daraltilmis profilde ayar kanaryasi olcemez (null) - MCP kanaryasi yine calismali.
    const is = isEkle(db, { ad: 'k', gorev: 'g', cwd: dizin, profil: 'gozlemci' });
    const kosu = kosuAc(db, is.id);
    const bas = Date.now();
    const r = await kosuBaslat(db, {
      is, kosu, komut: process.execPath, zamanAsimiMs: 60_000,
      spawnFn: (k, a, opt) => spawn(k, [TAKLIT, ...a], { ...opt, shell: false }),
      env: { ...process.env, SAHTE_SENARYO: 'mcp-sizdi' }, hafizaAyari: { etkin: false },
    });
    assert.ok(Date.now() - bas < 15_000, 'zaman asimini beklemeden kesilmeli');
    assert.equal(r.durum, KOSU_DURUMU.HATA);
    assert.equal(r.aracSayisi, 0);
    const k = kosuGetir(db, kosu.id);
    assert.match(k.hata, /GUVENLIK: --strict-mcp-config verildigi halde 2 secilmemis MCP araci/);
    assert.equal(k.terminalNeden, 'mcp-sizdi');
    assert.ok(olayOku(db, { kind: OLAY.HATA }).some((o) => /MCP araclari ajana sizdi/.test(o.data.mesaj)));
  } finally {
    db.close();
    try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra */ }
  }
});

const TAKLIT = join(dirname(fileURLToPath(import.meta.url)), 'sahte', 'claude-taklit.mjs');

test('ayarYuklendiMi: kanarya listedeyse false, degilse true, olculemiyorsa null', () => {
  assert.equal(ayarYuklendiMi('serbest', ['Read', 'Bash']), true);
  assert.equal(ayarYuklendiMi('serbest', ['Read', 'Bash', KANARYA]), false);
  assert.equal(ayarYuklendiMi('denetimli', ['Read', KANARYA]), false);
  assert.equal(ayarYuklendiMi('gozlemci', ['Read', KANARYA]), null, 'arac listesi zaten daraltilmis');
  assert.equal(ayarYuklendiMi('serbest', undefined), null);
});

test('her profil kanaryayi ve disari acilan araclari butunuyle yasaklar', () => {
  for (const p of Object.values(PROFILLER)) {
    const deny = ayarNesnesi(p).permissions.deny;
    for (const arac of [KANARYA, 'Artifact', 'PushNotification', 'SendMessage', 'CronCreate']) {
      assert.ok(deny.includes(arac), p.ad + ' ' + arac);
    }
  }
});

test('ayar dosyasi yuklenmediyse kosu arac cagrisi olmadan HATA ile kesilir', async () => {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-kanarya-'));
  const db = openDb(join(dizin, 'k.db'));
  try {
    // denetimli: normalde sorar - burada profilden bagimsiz HATA beklenir.
    const is = isEkle(db, { ad: 'k', gorev: 'g', cwd: dizin, profil: 'denetimli' });
    const kosu = kosuAc(db, is.id);
    const bas = Date.now();
    const r = await kosuBaslat(db, {
      is, kosu, komut: process.execPath, zamanAsimiMs: 60_000,
      spawnFn: (k, a, opt) => spawn(k, [TAKLIT, ...a], { ...opt, shell: false }),
      env: { ...process.env, SAHTE_SENARYO: 'ayar-yuklenmedi' }, hafizaAyari: { etkin: false },
    });
    assert.ok(Date.now() - bas < 15_000, 'zaman asimini beklemeden kesilmeli');
    assert.equal(r.durum, KOSU_DURUMU.HATA);
    assert.equal(r.aracSayisi, 0);
    const k = kosuGetir(db, kosu.id);
    assert.match(k.hata, /GUVENLIK/);
    assert.equal(k.terminalNeden, 'ayar-yuklenmedi');
    assert.ok(olayOku(db, { kind: OLAY.HATA }).some((o) => o.data.nerede === 'yetki'));
  } finally {
    db.close();
    try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra */ }
  }
});
