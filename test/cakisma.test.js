import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { OLAY, oku as olayOku } from '../src/events.js';
import { isEkle, kosuGetir, KOSU_DURUMU } from '../src/isler.js';
import { Kuyruk } from '../src/kuyruk.js';
import { yolNormal, iceriyorMu, cakisirMi, cakisanlar, denetle, uyariMetni } from '../src/cakisma.js';

const SEP = String.fromCharCode(92);

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-cak-'));
  const db = openDb(join(dizin, 'c.db'));
  return { db, dizin, temizle: () => {
    db.close();
    try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra silinir */ }
  } };
}

// --- Yol karsilastirma ---

test('ters bolu ve duz bolu ayni yola cozulur', () => {
  const a = 'C:' + SEP + 'proje' + SEP + 'alt';
  assert.equal(yolNormal(a), yolNormal('C:/proje/alt'));
  assert.equal(yolNormal('C:/proje/alt/'), yolNormal('C:/proje/alt'), 'sondaki bolu onemsiz');
});

test('ic ice klasorler cakisir, kardes klasorler cakismaz', () => {
  assert.equal(iceriyorMu('C:/proje', 'C:/proje/alt'), true);
  assert.equal(iceriyorMu('C:/proje', 'C:/proje'), true);
  assert.equal(iceriyorMu('C:/proje/alt', 'C:/proje'), false);
  // Ad benzerligi tuzagi: proje-yedek, proje'nin altinda DEGIL
  assert.equal(iceriyorMu('C:/proje', 'C:/proje-yedek'), false);
});

test('cakisma iki yonlu bakar', () => {
  assert.equal(cakisirMi({ cwd: 'C:/p' }, { cwd: 'C:/p/alt' }), true);
  assert.equal(cakisirMi({ cwd: 'C:/p/alt' }, { cwd: 'C:/p' }), true);
  assert.equal(cakisirMi({ cwd: 'C:/a' }, { cwd: 'C:/b' }), false);
});

// --- Calisan kosulara karsi denetim ---

/** Verilen klasorde 'calisiyor' durumunda bir kosu birakir. */
function calisanKosu(o, ad, cwd) {
  const is = isEkle(o.db, { ad, gorev: 'g', cwd, profil: 'gozlemci' });
  const k = o.db.prepare('INSERT INTO kosular (id, is_id, session_id, durum, basladi) VALUES (?,?,?,?,?)');
  const id = 'kosu-' + ad;
  k.run(id, is.id, 'oturum-' + ad, KOSU_DURUMU.CALISIYOR, Date.now());
  return { is, kosuId: id };
}

test('ayni klasorde calisan varsa cakisma bulunur', () => {
  const o = ortam();
  const alt = join(o.dizin, 'alt');
  mkdirSync(alt, { recursive: true });
  calisanKosu(o, 'a', o.dizin);

  const yeni = isEkle(o.db, { ad: 'b', gorev: 'g', cwd: alt, profil: 'gozlemci' });
  const liste = cakisanlar(o.db, yeni);
  assert.equal(liste.length, 1);
  assert.equal(liste[0].isAd, 'a');
  assert.ok(liste[0].ajan.ad, 'uyari ajan adiyla verilmeli');
  assert.equal(liste[0].ayniIs, false);
  o.temizle();
});

test('ayrik klasorler cakisma uretmez', () => {
  const o = ortam();
  const bir = join(o.dizin, 'bir'), iki = join(o.dizin, 'iki');
  mkdirSync(bir); mkdirSync(iki);
  calisanKosu(o, 'a', bir);
  const yeni = isEkle(o.db, { ad: 'b', gorev: 'g', cwd: iki, profil: 'gozlemci' });
  assert.equal(cakisanlar(o.db, yeni).length, 0);
  o.temizle();
});

test('ayni is iki kez kosuyorsa ayrica isaretlenir', () => {
  const o = ortam();
  const { is } = calisanKosu(o, 'a', o.dizin);
  const liste = cakisanlar(o.db, is);
  assert.equal(liste[0].ayniIs, true);
  assert.match(uyariMetni(is, liste), /Ayni is zaten calisiyor/);
  o.temizle();
});

test('bitmis kosular cakisma saymaz', () => {
  const o = ortam();
  const { is, kosuId } = calisanKosu(o, 'a', o.dizin);
  o.db.prepare('UPDATE kosular SET durum = ? WHERE id = ?').run(KOSU_DURUMU.BITTI, kosuId);
  assert.equal(cakisanlar(o.db, is).length, 0);
  o.temizle();
});

// --- Politikalar ---

test('uyar politikasi engellemez ama akisa yazar', () => {
  const o = ortam();
  const { is } = calisanKosu(o, 'a', o.dizin);
  const r = denetle(o.db, is, { politika: 'uyar' });
  assert.equal(r.engelle, false);
  assert.ok(r.uyari);
  const olay = olayOku(o.db, { kind: OLAY.HATA }).find((x) => x.data.nerede === 'cakisma');
  assert.ok(olay, 'cakisma denetim kaydina gecmeli');
  o.temizle();
});

test('beklet politikasi engeller, yoksay hicbir sey yapmaz', () => {
  const o = ortam();
  const { is } = calisanKosu(o, 'a', o.dizin);
  assert.equal(denetle(o.db, is, { politika: 'beklet' }).engelle, true);

  const y = denetle(o.db, is, { politika: 'yoksay' });
  assert.equal(y.engelle, false);
  assert.equal(y.uyari, null);
  o.temizle();
});

// --- Kuyrukla birlikte ---

test('beklet politikasinda cakisan is baslatilmaz, cakisma bitince alinir', async () => {
  const o = ortam();
  const acik = new Map();
  const kosucu = (db, { kosu }) => new Promise((coz) => {
    acik.set(kosu.id, () => {
      db.prepare('UPDATE kosular SET durum = ? WHERE id = ?').run(KOSU_DURUMU.BITTI, kosu.id);
      acik.delete(kosu.id);
      coz({ durum: KOSU_DURUMU.BITTI });
    });
  });

  const k = new Kuyruk(o.db, { esZamanli: 3, kosucu, cakismaPolitikasi: 'beklet' });
  const is = isEkle(o.db, { ad: 'ayni', gorev: 'g', cwd: o.dizin, profil: 'gozlemci' });

  const bir = k.siraya(is.id);
  const iki = k.siraya(is.id);
  await new Promise((r) => setImmediate(r));

  assert.equal(acik.size, 1, 'ayni klasordeki ikinci kosu beklemeli');
  assert.equal(kosuGetir(o.db, iki.id).durum, KOSU_DURUMU.BEKLIYOR);

  acik.get(bir.id)();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(acik.size, 1, 'ilk kosu bitince ikincisi alinir');
  assert.ok(acik.has(iki.id));
  o.temizle();
});

test('uyar politikasinda ikisi de calisir ama uyari verilir', async () => {
  const o = ortam();
  const kosucu = () => new Promise(() => { /* hic bitmesin */ });
  const k = new Kuyruk(o.db, { esZamanli: 3, kosucu, cakismaPolitikasi: 'uyar' });
  const uyarilar = [];
  k.on('cakisma', (c) => uyarilar.push(c));

  const is = isEkle(o.db, { ad: 'ayni', gorev: 'g', cwd: o.dizin, profil: 'gozlemci' });
  k.siraya(is.id);
  k.siraya(is.id);
  await new Promise((r) => setImmediate(r));

  assert.equal(k.durum().calisan, 2, 'uyar politikasi engellemez');
  assert.equal(uyarilar.length, 1);
  assert.match(uyarilar[0].uyari, /ezebilir/);
  o.temizle();
});
