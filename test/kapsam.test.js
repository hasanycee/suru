import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { openDb } from '../src/db.js';
import { isEkle, kosuAc } from '../src/isler.js';
import { kosuBaslat, kapsamTalimati, kapsamYazmaYasagi } from '../src/kosucu.js';
import { gorevKapsamCelismesi } from '../src/dongu.js';

const TAKLIT = join(dirname(fileURLToPath(import.meta.url)), 'sahte', 'claude-taklit.mjs');

test('gorev kapsam disi dosya aniyorsa uyarir (saha: config.yaml)', () => {
  const gorev = 'src/livedub/gender.py icindeki degerleri config.yaml dosyasindaki gender bolumunden okunur yap '
    + '(anahtarlar: gender.window_ms). tests/test_gender.py dosyasina test ekle. Surum 1.2.3.';
  assert.deepEqual(gorevKapsamCelismesi(gorev, ['src/livedub/gender.py', 'tests/test_gender.py']), ['config.yaml']);
});

test('yolsuz ad kapsamdaki yolun son parcasiysa uyari yok; kapsam yoksa uyari yok', () => {
  assert.deepEqual(gorevKapsamCelismesi('gender.py dosyasini duzelt', ['src/livedub/gender.py']), []);
  assert.deepEqual(gorevKapsamCelismesi('`README.md` ve src/a.js', ['src/a.js']), ['README.md']);
  assert.deepEqual(gorevKapsamCelismesi('config.yaml degistir', null), []);
  assert.deepEqual(gorevKapsamCelismesi('test/ altina test yaz, src/rapor.js', ['src/rapor.js', 'test/']), []);
});

test('yapici kapsam talimatini ek sistem isteminde alir', async () => {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-kapsam-'));
  const db = openDb(join(dizin, 'k.db'));
  try {
    const argDosyasi = join(dizin, 'args.json');
    const is = isEkle(db, { ad: 'k', gorev: 'g', cwd: dizin, profil: 'serbest', kapsam: 'src/a.js, test/' });
    const kosu = kosuAc(db, is.id);
    await kosuBaslat(db, {
      is, kosu, komut: process.execPath,
      spawnFn: (k, a, opt) => spawn(k, [TAKLIT, ...a], { ...opt, shell: false }),
      env: { ...process.env, SAHTE_SENARYO: 'basarili', SAHTE_ARG_DOSYASI: argDosyasi },
      hafizaAyari: { etkin: false },
    });
    const args = JSON.parse(readFileSync(argDosyasi, 'utf8'));
    const istem = args[args.indexOf('--append-system-prompt') + 1];
    assert.match(istem, /Bu isin kapsami .*src\/a\.js, test\//);
    assert.match(istem, /YAPMA; raporunda/);
    assert.equal(kapsamTalimati({ kapsam: null }), null);
  } finally {
    db.close();
    try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra */ }
  }
});

test('gorev kapsam disi dosya aniyorsa o dosyaya YAZMA izni kapanir, okuma acik kalir', async () => {
  // Saha (kampanya 5): istem talimati ulasti ama haiku gorevi tercih edip config.yaml'i degistirdi.
  assert.deepEqual(kapsamYazmaYasagi({ gorev: 'config.yaml degistir', kapsam: null }).kurallar, []);
  const dizin = mkdtempSync(join(tmpdir(), 'suru-kapsam-yazma-'));
  const db = openDb(join(dizin, 'k.db'));
  try {
    const argDosyasi = join(dizin, 'args.json');
    const is = isEkle(db, { ad: 'k2', cwd: dizin, profil: 'serbest', kapsam: 'src/a.js',
      gorev: 'src/a.js icindeki degeri config.yaml dosyasindan oku ve config.yaml dosyasina anahtar ekle.' });
    assert.deepEqual(kapsamYazmaYasagi(is), { celisen: ['config.yaml'], kurallar: ['Edit(./**/config.yaml)', 'Write(./**/config.yaml)'] });
    const kosu = kosuAc(db, is.id);
    await kosuBaslat(db, {
      is, kosu, komut: process.execPath,
      spawnFn: (k, a, opt) => spawn(k, [TAKLIT, ...a], { ...opt, shell: false }),
      env: { ...process.env, SAHTE_SENARYO: 'basarili', SAHTE_ARG_DOSYASI: argDosyasi },
      hafizaAyari: { etkin: false },
    });
    const args = JSON.parse(readFileSync(argDosyasi, 'utf8'));
    const deny = JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8')).permissions.deny;
    assert.ok(deny.includes('Edit(./**/config.yaml)') && deny.includes('Write(./**/config.yaml)'));
    assert.ok(!deny.includes('Read(./**/config.yaml)'), 'okuma acik kalmali');
    assert.ok(deny.includes('RemoteTrigger'), 'kanarya korunur');
    assert.match(args[args.indexOf('--append-system-prompt') + 1], /config\.yaml\. Bu dosyalara YAZMA IZNI KAPALI/);
  } finally {
    db.close();
    try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra */ }
  }
});
