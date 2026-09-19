import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { isEkle, isGetir, kosuAc, kosuGuncelle, KOSU_DURUMU } from '../src/isler.js';
import {
  kayitEkle, kayitlar, aracOlgusu, kosudanOgren, hafizaIstemi, yorumDosyasi, ozetDosyasi,
  dogrulanmamisSayilar,
  HAFIZA_TURU, DAMITMA_ONEK,
} from '../src/hafiza.js';
import { damitmaGerekiyorMu, damitmaIsiHazirla, damitmaIsiBul, damitmaGorevi } from '../src/damitma.js';

function ortam() {
  const kok = mkdtempSync(join(tmpdir(), 'suru-damitma-'));
  const proje = join(kok, 'proje');
  const hafizaKok = join(kok, '_hafiza');
  const db = openDb(join(kok, 'd.db'));
  return { db, kok, proje, hafizaKok, temizle: () => {
    db.close();
    try { rmSync(kok, { recursive: true, force: true }); } catch { /* sonra */ }
  } };
}

/** Projede biten bir kosu ve onun raporunu (yorum + dosya) uretir. */
function raporluKosu(o, metin, { simdi = Date.now() } = {}) {
  const { mkdirSync } = require_fs();
  mkdirSync(o.proje, { recursive: true });
  const is = isEkle(o.db, { ad: 'is-' + Math.random().toString(36).slice(2), gorev: 'g', cwd: o.proje, profil: 'serbest' });
  const k = kosuAc(o.db, is.id);
  kosuGuncelle(o.db, k.id, { durum: KOSU_DURUMU.BITTI, bitti: simdi, sonuc: metin });
  kosudanOgren(o.db, k.id, { kok: o.hafizaKok, simdi });
  return { is, kosuId: k.id };
}
import * as fsModulu from 'node:fs';
const require_fs = () => fsModulu;

// --- Esik ---

test('esik altinda damitma gerekmez, esikte gerekir', () => {
  const o = ortam();
  for (let i = 0; i < 4; i++) raporluKosu(o, 'rapor ' + i);
  assert.equal(damitmaGerekiyorMu(o.db, o.proje, { esik: 5 }), false);
  raporluKosu(o, 'rapor 4');
  assert.equal(damitmaGerekiyorMu(o.db, o.proje, { esik: 5 }), true);
  o.temizle();
});

test('surmekte olan damitma varken ikincisi tetiklenmez', () => {
  const o = ortam();
  for (let i = 0; i < 5; i++) raporluKosu(o, 'rapor ' + i);
  const d = damitmaIsiHazirla(o.db, o.proje, { kok: o.hafizaKok });
  kosuAc(o.db, d.id);   // sirada bekleyen damitma
  assert.equal(damitmaGerekiyorMu(o.db, o.proje, { esik: 5 }), false);
  o.temizle();
});

// --- Is hazirlama ---

test('damitma isi salt-okur, ucuz, dusuk oncelikli ve tekrar kullanilir', () => {
  const o = ortam();
  for (let i = 0; i < 5; i++) raporluKosu(o, 'rapor ' + i);
  const d1 = damitmaIsiHazirla(o.db, o.proje, { kok: o.hafizaKok });
  const kayit = isGetir(o.db, d1.id);
  assert.ok(kayit.ad.startsWith(DAMITMA_ONEK));
  assert.equal(kayit.profil, 'gozlemci', 'damitici dosya degistiremez');
  assert.equal(kayit.model, 'haiku');
  assert.equal(kayit.oncelik, 8, 'kullanicinin isleri once');
  assert.ok(kayit.butceUsd > 0, 'butce tavani olmali');

  const d2 = damitmaIsiHazirla(o.db, o.proje, { kok: o.hafizaKok });
  assert.equal(d2.id, d1.id, 'proje basina tek damitma isi');
  assert.equal(o.db.prepare('SELECT COUNT(*) c FROM isler WHERE ad LIKE ?').get(DAMITMA_ONEK + '%').c, 1);
  o.temizle();
});

test('gorev rapor yollarini ve dogrulanmis olgulari tasir, sayi tasimayi yasaklar', () => {
  const o = ortam();
  const { kosuId } = raporluKosu(o, 'turkish.py icin 14 test var');
  aracOlgusu(o.db, { cwd: o.proje, icerik: 'turkish.py 36 test (AST ile sayildi)' });
  const d = damitmaIsiHazirla(o.db, o.proje, { kok: o.hafizaKok });
  const g = isGetir(o.db, d.id).gorev;
  assert.ok(g.includes(yorumDosyasi(o.proje, kosuId, { kok: o.hafizaKok })), 'rapor yolu gorevde');
  assert.match(g, /36 test/, 'dogrulanmis olgu gorevde');
  assert.ok(!g.includes('14 test'), 'ham rapordaki iddia gorevin icine gomulmez');
  assert.match(g, /SAYI YAZMA/);
  assert.match(g, /tek kaynak/);
  assert.match(g, /celiski/);
  o.temizle();
});

test('kullanici alt cizgiyle baslayan is adi kullanamaz', () => {
  const o = ortam();
  const { mkdirSync } = require_fs();
  mkdirSync(o.proje, { recursive: true });
  assert.throws(() => isEkle(o.db, { ad: '_damitma:sahte', gorev: 'g', cwd: o.proje, profil: 'serbest' }),
    /ayrilmis/);
  o.temizle();
});

// --- Dongu tuzagi ---

test('damitma sonucu yorum DEGIL ozet olarak girer ve eski raporlari kapatir', () => {
  // Yorum olarak girseydi bir sonraki damitmayi tetikler, sonsuz dongu dogardi.
  const o = ortam();
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 5; i++) raporluKosu(o, 'rapor ' + i, { simdi: t0 + i });

  const d = damitmaIsiHazirla(o.db, o.proje, { kok: o.hafizaKok });
  const k = kosuAc(o.db, d.id);
  const basladi = t0 + 100;
  o.db.prepare('UPDATE kosular SET basladi = ? WHERE id = ?').run(basladi, k.id);

  // Damitma surerken yeni bir rapor geldi: bu KAPANMAMALI
  raporluKosu(o, 'damitma sirasinda gelen rapor', { simdi: t0 + 200 });

  kosuGuncelle(o.db, k.id, { durum: KOSU_DURUMU.BITTI, bitti: t0 + 300,
    sonuc: 'Proje haritasi: ... Dersler: ... (tek kaynak)' });
  const n = kosudanOgren(o.db, k.id, { kok: o.hafizaKok, simdi: t0 + 300 });
  assert.equal(n, 1);

  const ozetler = kayitlar(o.db, { cwd: o.proje, tur: HAFIZA_TURU.OZET });
  assert.equal(ozetler.length, 1);
  assert.ok(existsSync(ozetDosyasi(o.proje, k.id, { kok: o.hafizaKok })), 'ozet diskte');
  assert.match(readFileSync(ozetDosyasi(o.proje, k.id, { kok: o.hafizaKok }), 'utf8'), /DOGRULANMAMIS/);

  // Damitmanin kendi sonucu yeni yorum uretmemeli
  const acik = kayitlar(o.db, { cwd: o.proje, tur: HAFIZA_TURU.YORUM, sadeceAcik: true });
  assert.equal(acik.length, 1, 'sadece damitma sirasinda gelen rapor acik kalir');
  assert.match(acik[0].icerik, /sirasinda gelen/);

  // Tuketilen ham raporlar diskte denetim icin durur
  const tumu = kayitlar(o.db, { cwd: o.proje, tur: HAFIZA_TURU.YORUM });
  assert.equal(tumu.length, 6);
  assert.equal(damitmaGerekiyorMu(o.db, o.proje, { esik: 5 }), false, 'dongu yok');
  o.temizle();
});

test('ayni damitma kosusundan iki kez ogrenilmez', () => {
  const o = ortam();
  for (let i = 0; i < 5; i++) raporluKosu(o, 'rapor ' + i);
  const d = damitmaIsiHazirla(o.db, o.proje, { kok: o.hafizaKok });
  const k = kosuAc(o.db, d.id);
  kosuGuncelle(o.db, k.id, { durum: KOSU_DURUMU.BITTI, bitti: Date.now(), sonuc: 'ozet' });
  assert.equal(kosudanOgren(o.db, k.id, { kok: o.hafizaKok }), 1);
  assert.equal(kosudanOgren(o.db, k.id, { kok: o.hafizaKok }), 0);
  o.temizle();
});

test('basarisiz damitma hicbir raporu kapatmaz', () => {
  const o = ortam();
  for (let i = 0; i < 5; i++) raporluKosu(o, 'rapor ' + i);
  const d = damitmaIsiHazirla(o.db, o.proje, { kok: o.hafizaKok });
  const k = kosuAc(o.db, d.id);
  kosuGuncelle(o.db, k.id, { durum: KOSU_DURUMU.HATA, bitti: Date.now(), hata: 'butce asildi' });
  kosudanOgren(o.db, k.id, { kok: o.hafizaKok });
  assert.equal(kayitlar(o.db, { cwd: o.proje, tur: HAFIZA_TURU.YORUM, sadeceAcik: true }).length, 5,
    'yarim kalan damitma ham raporlari kaybettirmemeli');
  o.temizle();
});

// --- Dizin ---

test('damitmadan sonra dizin ozeti gosterir, kapanan raporlari gostermez', () => {
  const o = ortam();
  const eskiler = [];
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 5; i++) eskiler.push(raporluKosu(o, 'rapor ' + i, { simdi: t0 + i }).kosuId);
  const d = damitmaIsiHazirla(o.db, o.proje, { kok: o.hafizaKok });
  const k = kosuAc(o.db, d.id);
  o.db.prepare('UPDATE kosular SET basladi = ? WHERE id = ?').run(t0 + 100, k.id);
  kosuGuncelle(o.db, k.id, { durum: KOSU_DURUMU.BITTI, bitti: t0 + 300, sonuc: 'Proje haritasi ve dersler' });
  kosudanOgren(o.db, k.id, { kok: o.hafizaKok, simdi: t0 + 300 });

  const baskaIs = isEkle(o.db, { ad: 'kullanici-isi', gorev: 'g', cwd: o.proje, profil: 'serbest' });
  const dz = hafizaIstemi(o.db, baskaIs, { kok: o.hafizaKok });
  assert.ok(dz.includes(ozetDosyasi(o.proje, k.id, { kok: o.hafizaKok })), 'ozet dizinde');
  assert.match(dz, /damitilmis/i);
  for (const id of eskiler) {
    assert.ok(!dz.includes(yorumDosyasi(o.proje, id, { kok: o.hafizaKok })), 'damitilan ham rapor dizinden kalkmali');
  }
  o.temizle();
});

test('gorev metni olgu yoksa bunu acikca soyler', () => {
  const g = damitmaGorevi(['/a.md'], []);
  assert.match(g, /Dogrulanmis olgular:\s*\n- \(yok\)/);
  assert.equal(damitmaIsiBul.length >= 2, true);
});

// kayitEkle kullanilmadi uyarisi olmasin
void kayitEkle;

// --- Deterministik sayi denetimi ---

test('olguda gecmeyen bagimsiz sayilar yakalanir, kimlik ve kod icindekiler yakalanmaz', () => {
  const TIK = String.fromCharCode(96);
  const metin = 'turkish.py (36 test), 3 daemon thread, GTA 6, test_turkish.py, surum 1.5, '
    + TIK + 'v12 ve 99' + TIK + ', 15 test';
  const olgular = ['tests/test_turkish.py 36, tests/test_glossary.py 15'];
  assert.deepEqual(dogrulanmamisSayilar(metin, olgular), ['3', '6']);
});

test('cumle sonundaki sayi da sayi sayilir', () => {
  // Regresyon: karakter bazli ilk kural sayidan sonraki NOKTAYI kimlik parcasi
  // sandi. Olgudaki "15." ve "8." bilinmiyor gorundu (sahte alarm), ozette
  // cumle sonunda uydurulan sayi hic yakalanmiyordu (kacak).
  const olgu = 'tests/test_glossary.py 15. Fonksiyon sayisi 7 ve 8.';
  assert.deepEqual(dogrulanmamisSayilar('glossary 15 test, 8 fonksiyon', [olgu]), [],
    'cumle sonundaki olgu sayilari bilinmeli');
  assert.deepEqual(dogrulanmamisSayilar('Toplam 3.', [olgu]), ['3'],
    'cumle sonunda uydurulan sayi yakalanmali');
});

test('olgu yoksa her bagimsiz sayi dogrulanmamistir', () => {
  assert.deepEqual(dogrulanmamisSayilar('14 test ve 11 test', []), ['14', '11']);
  assert.deepEqual(dogrulanmamisSayilar('sayi yok', []), []);
});

/** Damitma kosusunu verilen govdeyle bitirir. */
function damitmayiBitir(o, govde) {
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 5; i++) raporluKosu(o, 'rapor ' + i, { simdi: t0 + i });
  const d = damitmaIsiHazirla(o.db, o.proje, { kok: o.hafizaKok });
  const k = kosuAc(o.db, d.id);
  o.db.prepare('UPDATE kosular SET basladi = ? WHERE id = ?').run(t0 + 100, k.id);
  kosuGuncelle(o.db, k.id, { durum: KOSU_DURUMU.BITTI, bitti: t0 + 300, sonuc: govde });
  kosudanOgren(o.db, k.id, { kok: o.hafizaKok, simdi: t0 + 300 });
  return k.id;
}

test('damitici dogrulanmamis sayi tasirsa ozet ve dizin isaretlenir', () => {
  // Regresyon (saha denemesi): ozete rapordan "3 daemon thread" tasindi.
  const o = ortam();
  aracOlgusu(o.db, { cwd: o.proje, icerik: 'turkish.py 36 test (AST ile sayildi).' });
  const kosuId = damitmayiBitir(o, 'turkish.py (36 test). pipeline 3 daemon thread yonetir.');

  const [ozet] = kayitlar(o.db, { cwd: o.proje, tur: HAFIZA_TURU.OZET, sadeceAcik: true });
  assert.match(ozet.uyari, /dogrulanmamis sayi/);
  assert.match(ozet.uyari, /: 3$/);
  assert.ok(!/36/.test(ozet.uyari), 'olcumle gelen sayi isaretlenmez');

  const dosya = readFileSync(ozetDosyasi(o.proje, kosuId, { kok: o.hafizaKok }), 'utf8');
  assert.match(dosya, /UYARI: dogrulanmamis sayi/);

  const is = isEkle(o.db, { ad: 'kullanici', gorev: 'g', cwd: o.proje, profil: 'serbest' });
  assert.ok(hafizaIstemi(o.db, is, { kok: o.hafizaKok }).includes('[dogrulanmamis sayi: 3]'));
  o.temizle();
});

test('sadece olcumle gelen sayilari kullanan ozet isaretlenmez', () => {
  const o = ortam();
  aracOlgusu(o.db, { cwd: o.proje, icerik: 'turkish.py 36 test, glossary.py 15 test.' });
  damitmayiBitir(o, 'turkish.py (36 test) ve glossary.py (15 test) kapsaniyor.');
  const [ozet] = kayitlar(o.db, { cwd: o.proje, tur: HAFIZA_TURU.OZET, sadeceAcik: true });
  assert.equal(ozet.uyari, null);
  const is = isEkle(o.db, { ad: 'kullanici', gorev: 'g', cwd: o.proje, profil: 'serbest' });
  assert.ok(!hafizaIstemi(o.db, is, { kok: o.hafizaKok }).includes('dogrulanmamis sayi'));
  o.temizle();
});
