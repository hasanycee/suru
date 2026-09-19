import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { openDb } from '../src/db.js';
import { isEkle, kosuAc, kosuGuncelle, KOSU_DURUMU } from '../src/isler.js';
import { kosuBaslat } from '../src/kosucu.js';
import {
  kayitEkle, kayitlar, insanOlgusu, aracOlgusu, kosudanOgren, hafizaIstemi, sayisalIddiaVar,
  yorumDosyasi, hafizaDizini, HAFIZA_TURU, KAYNAK,
} from '../src/hafiza.js';

const TAKLIT = join(dirname(fileURLToPath(import.meta.url)), 'sahte', 'claude-taklit.mjs');

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-hafiza-'));
  const kok = join(dizin, '_hafiza');   // testler gercek ~/.claude/suru'ya yazmasin
  const db = openDb(join(dizin, 'h.db'));
  return { db, dizin, kok, temizle: () => {
    db.close();
    try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra */ }
  } };
}

function bitmisKosu(o, alanlar, isAlanlari = {}) {
  const is = isEkle(o.db, { ad: 'is', gorev: 'testleri incele', cwd: o.dizin, profil: 'serbest', ...isAlanlari });
  const k = kosuAc(o.db, is.id);
  kosuGuncelle(o.db, k.id, { bitti: Date.now(), ...alanlar });
  return { is, kosuId: k.id };
}

// --- Sayisal iddia ---

test('sayisal iddialar isaretlenir', () => {
  assert.equal(sayisalIddiaVar('turkish.py icin 14 test var'), true);
  assert.equal(sayisalIddiaVar('3 dosyada sorun var'), true);
  assert.equal(sayisalIddiaVar('kapsam %80'), true);
  assert.equal(sayisalIddiaVar('pipeline.py riskli gorunuyor'), false);
});

// --- Kosudan ogrenme ---

test('ajan raporu DOGRULANMAMIS yorum olarak girer ve tam metni dosyaya yazilir', () => {
  const o = ortam();
  const { kosuId } = bitmisKosu(o, { durum: KOSU_DURUMU.BITTI, sonuc: 'turkish.py icin 14 test var' });
  kosudanOgren(o.db, kosuId, { kok: o.kok });

  const [y] = kayitlar(o.db, { cwd: o.dizin, tur: HAFIZA_TURU.YORUM });
  assert.equal(y.kaynak, KAYNAK.AJAN);
  assert.equal(y.dogrulandi, false, 'ajanin sozu kanit degil');
  assert.match(y.uyari, /sayisal iddia/);

  const yol = yorumDosyasi(o.dizin, kosuId, { kok: o.kok });
  assert.ok(existsSync(yol), 'tam rapor diskte olmali');
  const dosya = readFileSync(yol, 'utf8');
  assert.match(dosya, /^# DOGRULANMAMIS/, 'dosyayi acan ilk satirda uyarilmali');
  assert.match(dosya, /14 test/);
  o.temizle();
});

test('dogrulama sonucu DOGRULANMIS olgu olarak girer', () => {
  const o = ortam();
  const { kosuId } = bitmisKosu(o, { durum: KOSU_DURUMU.BITTI, dogrulamaKod: 0 }, { dogrulama: 'npm test' });
  kosudanOgren(o.db, kosuId, { kok: o.kok });
  const [ol] = kayitlar(o.db, { cwd: o.dizin, tur: HAFIZA_TURU.OLGU });
  assert.equal(ol.kaynak, KAYNAK.ARAC);
  assert.equal(ol.dogrulandi, true);
  assert.match(ol.icerik, /npm test/);
  assert.match(ol.icerik, /GECTI/);
  o.temizle();
});

test('ayni kosudan iki kez ogrenilmez', () => {
  const o = ortam();
  const { kosuId } = bitmisKosu(o, { durum: KOSU_DURUMU.BITTI, sonuc: 'rapor' });
  assert.equal(kosudanOgren(o.db, kosuId, { kok: o.kok }), 1);
  assert.equal(kosudanOgren(o.db, kosuId, { kok: o.kok }), 0);
  assert.equal(kayitlar(o.db, { cwd: o.dizin }).length, 1);
  o.temizle();
});

test('yarim kalan is kaydi acilir, ayni is basariyla bitince kapanir', () => {
  const o = ortam();
  const is = isEkle(o.db, { ad: 'gece', gorev: 'g', cwd: o.dizin, profil: 'denetimli' });
  const a = kosuAc(o.db, is.id);
  kosuGuncelle(o.db, a.id, { durum: KOSU_DURUMU.KARAR_BEKLIYOR, bitti: Date.now() });
  kosudanOgren(o.db, a.id, { kok: o.kok });
  assert.equal(kayitlar(o.db, { cwd: o.dizin, tur: HAFIZA_TURU.YARIM, sadeceAcik: true }).length, 1);

  const b = kosuAc(o.db, is.id);
  kosuGuncelle(o.db, b.id, { durum: KOSU_DURUMU.HATA, bitti: Date.now(), hata: 'patladi' });
  kosudanOgren(o.db, b.id, { kok: o.kok });
  assert.equal(kayitlar(o.db, { cwd: o.dizin, tur: HAFIZA_TURU.YARIM, sadeceAcik: true }).length, 1);

  const c = kosuAc(o.db, is.id);
  kosuGuncelle(o.db, c.id, { durum: KOSU_DURUMU.BITTI, bitti: Date.now() });
  kosudanOgren(o.db, c.id, { kok: o.kok });
  assert.equal(kayitlar(o.db, { cwd: o.dizin, tur: HAFIZA_TURU.YARIM, sadeceAcik: true }).length, 0);
  o.temizle();
});

test('hafiza proje bazli: baska klasorun kayitlari karismaz', () => {
  const o = ortam();
  const baska = mkdtempSync(join(tmpdir(), 'suru-baska-'));
  kayitEkle(o.db, { cwd: o.dizin, tur: 'olgu', icerik: 'burasi', kaynak: 'insan', dogrulandi: true });
  kayitEkle(o.db, { cwd: baska, tur: 'olgu', icerik: 'orasi', kaynak: 'insan', dogrulandi: true });
  const b = kayitlar(o.db, { cwd: o.dizin });
  assert.equal(b.length, 1);
  assert.equal(b[0].icerik, 'burasi');
  assert.notEqual(hafizaDizini(o.dizin, { kok: o.kok }), hafizaDizini(baska, { kok: o.kok }));
  try { rmSync(baska, { recursive: true, force: true }); } catch { /* sonra */ }
  o.temizle();
});

test('gecersiz tur ve bos icerik reddedilir', () => {
  const o = ortam();
  assert.throws(() => kayitEkle(o.db, { cwd: o.dizin, tur: 'dedikodu', icerik: 'x', kaynak: 'ajan' }), /gecersiz hafiza turu/);
  assert.throws(() => kayitEkle(o.db, { cwd: o.dizin, tur: 'olgu', icerik: '  ', kaynak: 'ajan' }), /bos olamaz/);
  o.temizle();
});

// --- Dizin (kademeli okuma) ---

test('kayit yoksa dizin yok', () => {
  const o = ortam();
  const is = isEkle(o.db, { ad: 'x', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
  assert.equal(hafizaIstemi(o.db, is, { kok: o.kok }), null);
  o.temizle();
});

test('dizin ajan raporunu GOMMEZ, sadece dosya yolunu verir', () => {
  // Regresyon (saha denemesi 2): eski raporun tamami brife gomulunce ajan onu
  // kelimesi kelimesine kopyaladi ve maliyet dusmedi.
  const o = ortam();
  insanOlgusu(o.db, { cwd: o.dizin, icerik: 'Testler pytest ile kosar.' });
  const uzunRapor = 'turkish.py icin 14 test var. ' + 'ayrinti '.repeat(300);
  const { is, kosuId } = bitmisKosu(o, { durum: KOSU_DURUMU.BITTI, sonuc: uzunRapor });
  kosudanOgren(o.db, kosuId, { kok: o.kok });

  const d = hafizaIstemi(o.db, is, { kok: o.kok });
  assert.match(d, /pytest/, 'olgular satir olarak gelir');
  assert.ok(!d.includes('14 test'), 'dogrulanmamis iddia baglama girmemeli');
  assert.ok(!d.includes('ayrinti ayrinti'), 'rapor govdesi baglama girmemeli');
  // Yol bolundu: klasor bir kez, satirda sadece dosya adi (istem kisaldi).
  const rYol = yorumDosyasi(o.dizin, kosuId, { kok: o.kok });
  assert.ok(d.includes(dirname(rYol)), 'klasor bir kez verilmeli');
  assert.ok(d.includes(basename(rYol)), 'satirda dosya adi verilmeli');
  assert.match(d, /gorev: /, 'ajan dosyayi acmadan konuyu gorebilmeli');
  assert.match(d, /DOGRULANMAMIS/);
  assert.match(d, /sayisal iddia/);
  o.temizle();
});

test('dizin kucuk kalir', () => {
  const o = ortam();
  for (let i = 0; i < 40; i++) insanOlgusu(o.db, { cwd: o.dizin, icerik: 'olgu ' + i + ' ' + 'x'.repeat(400) });
  const is = isEkle(o.db, { ad: 'x', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
  const d = hafizaIstemi(o.db, is, { kok: o.kok });
  assert.ok(d.length <= 1520, 'dizin tokeni sinirli olmali: ' + d.length);
  // Olgular tek satira indirilmis olmali
  for (const satir of d.split(String.fromCharCode(10)).filter((x) => x.startsWith('- '))) {
    assert.ok(satir.length <= 185, 'olgu satiri kisaltilmali');
  }
  o.temizle();
});

// --- Kosucuyla birlikte ---

test('yeni kosu dizini ve okuma klasorunu alir, bitince ogrenir', async () => {
  const o = ortam();
  // Once bir yorum olsun ki okuma klasoru olussun
  const hazirlik = bitmisKosu(o, { durum: KOSU_DURUMU.BITTI, sonuc: 'onceki rapor' });
  kosudanOgren(o.db, hazirlik.kosuId, { kok: o.kok });

  const argDosyasi = join(o.dizin, 'args.json');
  const is = isEkle(o.db, { ad: 'hafizali', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
  const kosu = kosuAc(o.db, is.id);
  await kosuBaslat(o.db, {
    is, kosu, komut: process.execPath, hafizaAyari: { etkin: true, kok: o.kok },
    spawnFn: (k, a, opt) => spawn(k, [TAKLIT, ...a], { ...opt, shell: false }),
    env: { ...process.env, SAHTE_SENARYO: 'basarili', SAHTE_ARG_DOSYASI: argDosyasi },
  });

  const args = JSON.parse(readFileSync(argDosyasi, 'utf8'));
  const i = args.indexOf('--append-system-prompt');
  assert.ok(i >= 0, 'hafiza dizini gecmeli');
  assert.match(args[i + 1], /Suru hafizasi/);
  const d = args.indexOf('--add-dir');
  assert.ok(d >= 0, 'ajan ayrinti dosyalarini okuyabilmeli');
  assert.equal(args[d + 1], hafizaDizini(o.dizin, { kok: o.kok }));

  assert.equal(kayitlar(o.db, { cwd: o.dizin, tur: HAFIZA_TURU.YORUM }).length, 2);
  o.temizle();
});

test('hafiza kapaliysa dizin gecmez ve ogrenilmez', async () => {
  const o = ortam();
  insanOlgusu(o.db, { cwd: o.dizin, icerik: 'olgu' });
  const argDosyasi = join(o.dizin, 'args2.json');
  const is = isEkle(o.db, { ad: 'hafizasiz', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
  const kosu = kosuAc(o.db, is.id);
  await kosuBaslat(o.db, {
    is, kosu, komut: process.execPath, hafizaAyari: { etkin: false },
    spawnFn: (k, a, opt) => spawn(k, [TAKLIT, ...a], { ...opt, shell: false }),
    env: { ...process.env, SAHTE_SENARYO: 'basarili', SAHTE_ARG_DOSYASI: argDosyasi },
  });
  const args = JSON.parse(readFileSync(argDosyasi, 'utf8'));
  assert.ok(!args.includes('--append-system-prompt'));
  assert.ok(!args.includes('--add-dir'));
  assert.equal(kayitlar(o.db, { cwd: o.dizin, tur: HAFIZA_TURU.YORUM }).length, 0);
  o.temizle();
});

// --- Bayatlama ---

/**
 * Proje, veritabani ve hafiza klasorunden AYRI bir alt klasorde kurulur.
 * Ortak klasorde kurulunca her veritabani yazmasi parmak izini kaydiriyor ve
 * proje hic degismeden olgular bayat gorunuyordu (gercekte db ~/.claude/suru'da).
 */
function projeKlasoru(o) {
  const p = join(o.dizin, 'proje');
  mkdirSync(p, { recursive: true });
  return p;
}

test('proje degisince arac olgusu eski olabilir diye isaretlenir', () => {
  // "36 test" olculdu; biri test ekledi. Hafiza artik bunu kesin diye sunmamali.
  const o = ortam();
  const p = projeKlasoru(o);
  writeFileSync(join(p, 'test_a.py'), 'def test_x(): pass', 'utf8');
  aracOlgusu(o.db, { cwd: p, icerik: 'test_a.py icinde 1 test var' });
  const is = isEkle(o.db, { ad: 'x', gorev: 'g', cwd: p, profil: 'serbest' });

  assert.ok(!hafizaIstemi(o.db, is, { kok: o.kok }).includes('eski olabilir'), 'degismemis proje: taze');

  writeFileSync(join(p, 'test_b.py'), 'def test_y(): pass', 'utf8');
  const ileri = new Date(Date.now() + 60_000);
  utimesSync(join(p, 'test_b.py'), ileri, ileri);
  assert.match(hafizaIstemi(o.db, is, { kok: o.kok }), /eski olabilir/, 'proje degisti: bayat');
  o.temizle();
});

test('.claude klasorundeki degisiklik olgulari bayatlatmaz', () => {
  const o = ortam();
  const p = projeKlasoru(o);
  writeFileSync(join(p, 'a.py'), 'x = 1', 'utf8');
  aracOlgusu(o.db, { cwd: p, icerik: 'a.py var' });
  const is = isEkle(o.db, { ad: 'x', gorev: 'g', cwd: p, profil: 'serbest' });

  mkdirSync(join(p, '.claude'), { recursive: true });
  writeFileSync(join(p, '.claude', 'settings.local.json'), '{}', 'utf8');
  assert.ok(!hafizaIstemi(o.db, is, { kok: o.kok }).includes('eski olabilir'),
    'ajan oturumunun yazdigi ayar dosyasi kod degisikligi sayilmamali');
  o.temizle();
});

test('insan olgusu kodla eskimez', () => {
  const o = ortam();
  const p = projeKlasoru(o);
  insanOlgusu(o.db, { cwd: p, icerik: 'Testler pytest ile kosar.' });
  writeFileSync(join(p, 'yeni.py'), 'x = 1', 'utf8');
  const ileri = new Date(Date.now() + 60_000);
  utimesSync(join(p, 'yeni.py'), ileri, ileri);
  const is = isEkle(o.db, { ad: 'x', gorev: 'g', cwd: p, profil: 'serbest' });
  const d = hafizaIstemi(o.db, is, { kok: o.kok });
  assert.match(d, /pytest/);
  assert.ok(!d.includes('eski olabilir'), 'kural ve standartlar kararla degisir, kodla degil');
  o.temizle();
});

test('kosudan ogrenilen olgu o anin parmak izini tasir', () => {
  const o = ortam();
  const { kosuId } = bitmisKosu(o, { durum: KOSU_DURUMU.BITTI, dogrulamaKod: 0 }, { dogrulama: 'npm test' });
  kosudanOgren(o.db, kosuId, { kok: o.kok });
  const [ol] = kayitlar(o.db, { cwd: o.dizin, tur: HAFIZA_TURU.OLGU });
  assert.ok(ol.parmakIzi, 'olgu parmak izi olmadan kaydedilmemeli');
  o.temizle();
});

// --- Olu baglanti ---

test('dosyasi kaybolmus rapor veritabanindaki ozetten yeniden kurulur', () => {
  // Regresyon (gercek veride yakalandi): dizin ajani olmayan dosyalara yolluyordu.
  const o = ortam();
  const is = isEkle(o.db, { ad: 'x', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
  // Dosyasi hic yazilmamis eski kayit
  kayitEkle(o.db, { cwd: o.dizin, tur: 'yorum', kaynak: 'ajan', kosuId: 'kosu-eski',
    icerik: 'eski rapor: 14 test var', uyari: 'sayisal iddia iceriyor - sayilari yeniden olc' });

  const yol = yorumDosyasi(o.dizin, 'kosu-eski', { kok: o.kok });
  assert.ok(!existsSync(yol), 'baslangicta dosya yok');

  const d = hafizaIstemi(o.db, is, { kok: o.kok });
  assert.ok(d.includes(dirname(yol)) && d.includes(basename(yol)), 'rapor dizinde listelenmeli');
  assert.ok(existsSync(yol), 'listelenen dosya GERCEKTEN var olmali');
  const icerik = readFileSync(yol, 'utf8');
  assert.match(icerik, /yeniden kuruldu/, 'yeniden kuruldugu belirtilmeli');
  assert.match(icerik, /DOGRULANMAMIS/);
  assert.match(icerik, /14 test var/);
  o.temizle();
});

test('kurulamayan rapor dizinde hic gosterilmez', () => {
  const o = ortam();
  // Hafiza kokunu bir DOSYA yap: altina klasor acilamaz, rapor kurulamaz.
  const engel = join(o.dizin, 'engel');
  writeFileSync(engel, 'dosya', 'utf8');
  const is = isEkle(o.db, { ad: 'x', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
  kayitEkle(o.db, { cwd: o.dizin, tur: 'yorum', kaynak: 'ajan', kosuId: 'kosu-z', icerik: 'rapor' });

  assert.equal(hafizaIstemi(o.db, is, { kok: engel }), null,
    'tek kayit kurulamayan rapor ise dizin hic verilmemeli - olu baglanti yok');

  insanOlgusu(o.db, { cwd: o.dizin, icerik: 'Testler pytest ile kosar.' });
  const d = hafizaIstemi(o.db, is, { kok: engel });
  assert.match(d, /pytest/, 'olgular yine gelir');
  assert.ok(!d.includes('DOGRULANMAMIS'), 'kurulamayan rapor bolumu hic acilmamali');
  o.temizle();
});

test('kosu kimligi olmayan yorum dosya yolu uretmez', () => {
  const o = ortam();
  const is = isEkle(o.db, { ad: 'x', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
  kayitEkle(o.db, { cwd: o.dizin, tur: 'yorum', kaynak: 'ajan', icerik: 'elle eklenmis yorum' });
  const d = hafizaIstemi(o.db, is, { kok: o.kok });
  assert.equal(d, null, 'yorum-null.md gibi sahte yol uretilmemeli');
  o.temizle();
});
