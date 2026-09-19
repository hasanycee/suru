import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { openDb } from '../src/db.js';
import { OLAY, oku as olayOku } from '../src/events.js';
import { isEkle, kosuAc, kosuGetir, KOSU_DURUMU } from '../src/isler.js';
import { kosuBaslat } from '../src/kosucu.js';
import { calistir, ozetle } from '../src/dogrulama.js';
import {
  kararlariTazele, kararKarti, kabulEt, kararGetir,
  KARAR_TURU, KARAR_DURUMU,
} from '../src/eskalasyon.js';

const TAKLIT = join(dirname(fileURLToPath(import.meta.url)), 'sahte', 'claude-taklit.mjs');
// Dogrulama komutu KABUKTAN gecer: bosluklu yol tirnaklanmali.
// (Gercek kullanimda da kurali budur - komutu kullanici yaziyor.)
const TIRNAK = String.fromCharCode(34);
const NODE = TIRNAK + process.execPath + TIRNAK;

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-dg-'));
  const db = openDb(join(dizin, 'd.db'));
  return { db, dizin, temizle: () => {
    db.close();
    try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra */ }
  } };
}

// --- Komut calistirma ---

test('gecen komut gecti isaretlenir', async () => {
  const o = ortam();
  const r = await calistir('exit 0', o.dizin);
  assert.equal(r.gecti, true);
  assert.equal(r.kod, 0);
  assert.equal(r.calisti, true);
  o.temizle();
});

test('gecmeyen komut cikis kodunu ve ciktisini tasir', async () => {
  const o = ortam();
  const r = await calistir('echo TESTLER-KIRIK && exit 3', o.dizin);
  assert.equal(r.gecti, false);
  assert.equal(r.kod, 3);
  assert.match(r.cikti, /TESTLER-KIRIK/);
  o.temizle();
});

test('bos dogrulama komutu gecti sayilir ama calismadi isaretlenir', async () => {
  const o = ortam();
  for (const bos of [null, '', '   ']) {
    const r = await calistir(bos, o.dizin);
    assert.equal(r.gecti, true);
    assert.equal(r.calisti, false, 'dogrulama tanimli degilse calismis gibi gorunmemeli');
  }
  o.temizle();
});

test('zaman asimi gecmemis sayilir', async () => {
  const o = ortam();
  // Komutu dosyaya yaziyoruz: Windows'ta kabuktan gecen tirnakli tek satirlik
  // ifadeler bozulabiliyor, test urunun degil kabugun kurbani olmasin.
  const bekle = join(o.dizin, 'bekle.js');
  writeFileSync(bekle, 'setTimeout(function(){}, 9000);', 'utf8');
  const r = await calistir(NODE + ' bekle.js', o.dizin, { zamanAsimiMs: 700 });
  assert.equal(r.zamanAsimi, true);
  assert.equal(r.gecti, false, 'zaman asimina ugrayan dogrulama gecmis sayilmaz');
  o.temizle();
});

test('ozet insan okunur ve durumu dogru soyler', () => {
  assert.equal(ozetle({ calisti: false }, 'npm test'), null);
  assert.match(ozetle({ calisti: true, gecti: true }, 'npm test'), /gecti/);
  assert.match(ozetle({ calisti: true, gecti: false, kod: 1 }, 'npm test'), /BASARISIZ/);
  assert.match(ozetle({ calisti: true, gecti: false, zamanAsimi: true }, 'npm test'), /zaman asimi/);
});

// --- Kosucuyla birlikte ---

function kosuKur(o, dogrulama, profil = 'serbest') {
  const is = isEkle(o.db, { ad: 'dg', gorev: 'g', cwd: o.dizin, profil, dogrulama });
  const kosu = kosuAc(o.db, is.id);
  return { is, kosu, calistir: () => kosuBaslat(o.db, {
    is, kosu, komut: process.execPath,
    spawnFn: (k, a, opt) => spawn(k, [TAKLIT, ...a], { ...opt, shell: false }),
    env: { ...process.env, SAHTE_SENARYO: 'basarili' },
  }) };
}

test('dogrulama gecerse kosu bitti kalir', async () => {
  const o = ortam();
  const { kosu, calistir: kos } = kosuKur(o, 'exit 0');
  const r = await kos();
  assert.equal(r.durum, KOSU_DURUMU.BITTI);
  assert.equal(kosuGetir(o.db, kosu.id).dogrulamaKod, 0);
  o.temizle();
});

test('dogrulama gecmezse ajan bitti dese bile is bitmis sayilmaz', async () => {
  const o = ortam();
  // Taklit ajan "is bitti" diyor ve is_error false donuyor - yine de kabul etmiyoruz.
  const { kosu, calistir: kos } = kosuKur(o, 'echo TEST-KIRIK && exit 1');
  const r = await kos();

  assert.equal(r.durum, KOSU_DURUMU.KARAR_BEKLIYOR, 'iddia kanit degildir');
  const kayit = kosuGetir(o.db, kosu.id);
  assert.equal(kayit.dogrulamaKod, 1);
  assert.match(kayit.dogrulamaCikti, /TEST-KIRIK/);
  assert.match(kayit.hata, /Dogrulama BASARISIZ/);
  o.temizle();
});

test('gozlemci profilinde soracak kimse yok, dogrudan hata', async () => {
  const o = ortam();
  const { calistir: kos } = kosuKur(o, 'exit 1', 'gozlemci');
  const r = await kos();
  assert.equal(r.durum, KOSU_DURUMU.HATA);
  o.temizle();
});

test('dogrulama akisa yazilir', async () => {
  const o = ortam();
  const { calistir: kos } = kosuKur(o, 'exit 0');
  await kos();
  const asamalar = olayOku(o.db, { kind: OLAY.IS }).map((x) => x.data.asama);
  assert.ok(asamalar.includes('dogrulaniyor'));
  assert.ok(asamalar.includes('dogrulandi'));
  o.temizle();
});

test('dogrulama komutu IS KLASORUNDE calisir', async () => {
  const o = ortam();
  // Isaret dosyasi sadece is klasorunde var. Dogrulama baska bir klasorde
  // calissaydi bulamaz ve dusederdi.
  writeFileSync(join(o.dizin, 'isaret.txt'), 'burasi', 'utf8');
  const kontrol = join(o.dizin, 'kontrol.js');
  writeFileSync(kontrol,
    'const fs = require("fs");' + String.fromCharCode(10)
    + 'process.exit(fs.existsSync("isaret.txt") ? 0 : 7);', 'utf8');

  const { calistir: kos } = kosuKur(o, NODE + ' kontrol.js');
  const r = await kos();
  assert.equal(r.durum, KOSU_DURUMU.BITTI, 'dogrulama is klasorunde calismali');
  o.temizle();
});

// --- Karar tarafi ---

test('dogrulama basarisizligi kendi karar turunu dogurur', async () => {
  const o = ortam();
  const { calistir: kos } = kosuKur(o, 'echo KIRIK && exit 2');
  await kos();

  const [karar] = kararlariTazele(o.db);
  assert.equal(karar.tur, KARAR_TURU.DOGRULAMA);
  assert.match(karar.soru, /dogrulama gecmedi/);

  const kart = kararKarti(o.db, karar);
  const etiketler = kart.secenekler.map((x) => x.etiket);
  assert.deepEqual(etiketler, ['Duzelt', 'Yine de kabul et', 'Vazgec']);
  assert.match(kart.ayrinti, /KIRIK/, 'dogrulama ciktisi kararda gorunmeli');
  o.temizle();
});

test('kabul et kosuyu bitti sayar ve ajani yeniden kosturmaz', async () => {
  const o = ortam();
  const { kosu, calistir: kos } = kosuKur(o, 'exit 1');
  await kos();
  const [karar] = kararlariTazele(o.db);

  const oncekiKosuSayisi = o.db.prepare('SELECT COUNT(*) c FROM kosular').get().c;
  kabulEt(o.db, karar.id, { not: 'kirilgan test' });

  assert.equal(kararGetir(o.db, karar.id).durum, KARAR_DURUMU.CEVAPLANDI);
  assert.equal(kosuGetir(o.db, kosu.id).durum, KOSU_DURUMU.BITTI);
  assert.equal(o.db.prepare('SELECT COUNT(*) c FROM kosular').get().c, oncekiKosuSayisi,
    'kabul yeni kosu acmamali - para ve zaman yakmadan kapanir');

  // Kabul edildigi denetim kaydina gecmeli
  assert.ok(olayOku(o.db, { kind: OLAY.KARAR }).some((x) => x.data.asama === 'kabul'));
  o.temizle();
});

test('kapali karar ikinci kez kabul edilemez', async () => {
  const o = ortam();
  const { calistir: kos } = kosuKur(o, 'exit 1');
  await kos();
  const [karar] = kararlariTazele(o.db);
  kabulEt(o.db, karar.id);
  assert.throws(() => kabulEt(o.db, karar.id), /zaten kapali/);
  o.temizle();
});
