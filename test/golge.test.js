import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { openDb } from '../src/db.js';
import { isEkle, kosuAc, kosuGetir } from '../src/isler.js';
import { kosuBaslat } from '../src/kosucu.js';
import {
  anlikGoruntu, degisenler, geriAlPlani, geriAl, budama, golgeDizini, ortusenKosular,
} from '../src/golge.js';

const KOK = dirname(fileURLToPath(import.meta.url));
const TAKLIT = join(KOK, 'sahte', 'claude-taklit.mjs');

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-golge-'));
  const proje = join(dizin, 'proje');
  const kok = join(dizin, 'golge');
  mkdirSync(proje);
  return { dizin, proje, kok, temizle: () => {
    try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra silinir */ }
  } };
}
const yaz = (p, ad, icerik) => writeFileSync(join(p, ad), icerik, 'utf8');
const oku = (p, ad) => readFileSync(join(p, ad), 'utf8');
const sirali = (l) => l.map((d) => d.durum + ' ' + d.yol).sort();

test('git olmayan projede degisiklik bulunur ve geri alinir (ekle/degistir/sil)', () => {
  const o = ortam();
  yaz(o.proje, 'a.txt', 'eski\n');
  yaz(o.proje, 'silinecek.txt', 'x\n');
  mkdirSync(join(o.proje, 'alt'));
  yaz(join(o.proje, 'alt'), 'b.txt', 'b\n');
  const once = anlikGoruntu(o.proje, 'k1-once', { kok: o.kok });

  yaz(o.proje, 'a.txt', 'yeni\n');
  yaz(o.proje, 'eklendi.txt', 'e\n');
  rmSync(join(o.proje, 'silinecek.txt'));
  const sonra = anlikGoruntu(o.proje, 'k1-sonra', { kok: o.kok });

  assert.deepEqual(sirali(degisenler(o.proje, once, sonra, { kok: o.kok })),
    ['A eklendi.txt', 'D silinecek.txt', 'M a.txt']);

  const r = geriAl(o.proje, once, sonra, { kok: o.kok });
  assert.equal(r.uygun, 3);
  assert.equal(r.cakisan, 0);
  assert.ok(r.guvenlik, 'guvenlik goruntusu alinir');
  assert.equal(oku(o.proje, 'a.txt'), 'eski\n');
  assert.ok(!existsSync(join(o.proje, 'eklendi.txt')));
  assert.equal(oku(o.proje, 'silinecek.txt'), 'x\n');
  assert.equal(oku(join(o.proje, 'alt'), 'b.txt'), 'b\n', 'dokunulmayan dosya ayni');
  o.temizle();
});

test('kosudan sonra insan dosyayi degistirdiyse geri alma ona dokunmaz', () => {
  const o = ortam();
  yaz(o.proje, 'a.txt', 'eski\n');
  yaz(o.proje, 'b.txt', 'eski\n');
  const once = anlikGoruntu(o.proje, 'k-once', { kok: o.kok });
  yaz(o.proje, 'a.txt', 'ajan\n');
  yaz(o.proje, 'b.txt', 'ajan\n');
  const sonra = anlikGoruntu(o.proje, 'k-sonra', { kok: o.kok });
  yaz(o.proje, 'b.txt', 'insan duzeltti\n');

  const plan = geriAlPlani(o.proje, once, sonra, { kok: o.kok });
  assert.equal(plan.uygun, 1);
  assert.equal(plan.cakisan, 1);
  assert.equal(oku(o.proje, 'a.txt'), 'ajan\n', 'plan hicbir sey degistirmez');

  const r = geriAl(o.proje, once, sonra, { kok: o.kok });
  assert.deepEqual(r.geriAlinan, ['a.txt']);
  assert.equal(oku(o.proje, 'a.txt'), 'eski\n');
  assert.equal(oku(o.proje, 'b.txt'), 'insan duzeltti\n');
  o.temizle();
});

test('kullanicinin git deposu etkilenmez; .gitignore ve sirlar goruntuye girmez', () => {
  const o = ortam();
  const g = (...a) => execFileSync('git', ['-C', o.proje, ...a], { encoding: 'utf8' }).trim();
  g('init', '-q');
  yaz(o.proje, '.gitignore', 'gizli.log\n');
  yaz(o.proje, 'kod.js', '1\n');
  g('add', '-A');
  execFileSync('git', ['-C', o.proje, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', 'ilk']);
  const head = g('rev-parse', 'HEAD');
  yaz(o.proje, 'gizli.log', 'log\n');
  yaz(o.proje, '.env', 'SIR=1\n');

  const once = anlikGoruntu(o.proje, 'u-once', { kok: o.kok });
  yaz(o.proje, 'kod.js', '2\n');
  yaz(o.proje, '.env', 'SIR=2\n');
  yaz(o.proje, 'gizli.log', 'log2\n');
  const sonra = anlikGoruntu(o.proje, 'u-sonra', { kok: o.kok });

  assert.deepEqual(sirali(degisenler(o.proje, once, sonra, { kok: o.kok })), ['M kod.js']);
  assert.equal(g('rev-parse', 'HEAD'), head, 'kullanicinin HEAD\'i ayni');
  // .env kullanicinin deposunda izlenmeyen dosya olarak kalir (onun .gitignore'u
  // kapsamiyor); golge onu sadece kendi goruntusunden haric tutar.
  assert.equal(g('status', '--porcelain'), 'M kod.js\n?? .env', 'kullanicinin index\'i bozulmadi');
  assert.ok(!golgeDizini(o.proje, { kok: o.kok }).startsWith(o.proje), 'golge proje disinda');
  o.temizle();
});

test('budama eski ve fazla goruntuleri siler, yenileri tutar', () => {
  const o = ortam();
  yaz(o.proje, 'a.txt', '1\n');
  const gun = 86_400_000, simdi = Date.UTC(2026, 8, 11);
  anlikGoruntu(o.proje, 'eski-once', { kok: o.kok, simdi: simdi - 30 * gun });
  anlikGoruntu(o.proje, 'orta-once', { kok: o.kok, simdi: simdi - 2 * gun });
  anlikGoruntu(o.proje, 'yeni-once', { kok: o.kok, simdi: simdi - gun });

  assert.equal(budama(o.proje, { kok: o.kok, gun: 14, simdi }), 1);
  assert.equal(budama(o.proje, { kok: o.kok, gun: 14, enFazla: 1, simdi }), 1);
  const kalan = execFileSync('git', ['--git-dir=' + golgeDizini(o.proje, { kok: o.kok }), 'for-each-ref',
    '--format=%(refname)'], { encoding: 'utf8' }).trim();
  assert.equal(kalan, 'refs/suru/yeni-once');
  assert.equal(budama(join(o.dizin, 'hic-yok'), { kok: o.kok }), 0);
  o.temizle();
});

test('gecersiz etiket reddedilir', () => {
  const o = ortam();
  assert.throws(() => anlikGoruntu(o.proje, '../kacis', { kok: o.kok }), /gecersiz/);
  o.temizle();
});

test('kosucu golge acikken once/sonra goruntusu alir, Bash tarzi degisikligi de sayar', async () => {
  const o = ortam();
  const db = openDb(join(o.dizin, 'g.db'));
  yaz(o.proje, 'mevcut.txt', 'insan\n');
  yaz(o.proje, 'silinecek.txt', 's\n');
  const is = isEkle(db, { ad: 'yazar', gorev: 'g', cwd: o.proje, profil: 'serbest' });
  const kosu = kosuAc(db, is.id);
  const r = await kosuBaslat(db, {
    is, kosu, komut: process.execPath,
    spawnFn: (k, a, opt) => spawn(k, [TAKLIT, ...a], { ...opt, shell: false }),
    env: { ...process.env, SAHTE_SENARYO: 'yazar' },
    hafizaAyari: { etkin: false }, golgeAyari: { etkin: true, kok: o.kok },
  });
  const k = kosuGetir(db, kosu.id);
  assert.ok(k.golgeOnce && k.golgeSonra);
  assert.equal(k.degisenDosya, 3);
  assert.equal(r.golge.degisen, 3);

  const plan = geriAlPlani(o.proje, k.golgeOnce, k.golgeSonra, { kok: o.kok });
  assert.deepEqual(plan.degisiklik.map((d) => d.eylem + ' ' + d.yol).sort(),
    ['geri-yukle mevcut.txt', 'geri-yukle silinecek.txt', 'sil ajan-yazdi.txt']);
  geriAl(o.proje, k.golgeOnce, k.golgeSonra, { kok: o.kok });
  assert.equal(oku(o.proje, 'mevcut.txt'), 'insan\n');
  assert.ok(!existsSync(join(o.proje, 'ajan-yazdi.txt')));

  // Ortusen kosu: ayni klasorde ayni zaman araliginda baska kosu
  const is2 = isEkle(db, { ad: 'diger', gorev: 'g', cwd: o.proje, profil: 'serbest' });
  const k2 = kosuAc(db, is2.id);
  db.prepare("UPDATE kosular SET durum = 'calisiyor', basladi = ? WHERE id = ?").run(k.basladi + 1, k2.id);
  assert.deepEqual(ortusenKosular(db, kosuGetir(db, kosu.id)).map((x) => x.ad), ['diger']);
  db.close();
  o.temizle();
});

test('golge kapaliyken kosucu goruntu almaz', async () => {
  const o = ortam();
  const db = openDb(join(o.dizin, 'g.db'));
  const is = isEkle(db, { ad: 'x', gorev: 'g', cwd: o.proje, profil: 'serbest' });
  const kosu = kosuAc(db, is.id);
  await kosuBaslat(db, {
    is, kosu, komut: process.execPath,
    spawnFn: (k, a, opt) => spawn(k, [TAKLIT, ...a], { ...opt, shell: false }),
    env: { ...process.env, SAHTE_SENARYO: 'basarili' }, hafizaAyari: { etkin: false },
  });
  assert.equal(kosuGetir(db, kosu.id).golgeOnce, null);
  assert.ok(!existsSync(golgeDizini(o.proje, { kok: o.kok })));
  db.close();
  o.temizle();
});
