import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, kvOku } from '../src/db.js';
import { OLAY, yaz as olayYaz, oku as olayOku, sonSeq } from '../src/events.js';
import { kararVer, sessizMi, Bildirimci } from '../src/bildirim.js';
import { VARSAYILAN } from '../src/config.js';

function ayar(ustune = {}) {
  const a = structuredClone(VARSAYILAN);
  Object.assign(a.bildirim, ustune);
  return a;
}

/** Akistan gelmis gibi bir durum olayi. */
function gecis(sessionId, durum, { seq = 1, at = 1000, project = 'demo', ...ek } = {}) {
  return { seq, at, kind: OLAY.DURUM, sessionId, project, agent: null,
    data: { durum, onceki: null, kesin: true, ...ek } };
}

const OGLEN = Date.parse('2026-03-10T12:00:00');
const GECE = Date.parse('2026-03-10T03:00:00');

test('sessiz pencere gece yarisini asan araligi da kapsar', () => {
  const p = { etkin: true, baslangic: 23, bitis: 7, acilGecer: true };
  assert.equal(sessizMi(Date.parse('2026-03-10T23:30:00'), p), true);
  assert.equal(sessizMi(Date.parse('2026-03-10T02:00:00'), p), true);
  assert.equal(sessizMi(Date.parse('2026-03-10T12:00:00'), p), false);
  // Kapaliysa hicbir saat sessiz degil
  assert.equal(sessizMi(GECE, { etkin: false, baslangic: 1, bitis: 8 }), false);
});

test('onemsiz durumlar hic bildirim uretmez', () => {
  const { gonderilecek } = kararVer(
    [gecis('a', 'calisiyor'), gecis('b', 'bosta', { seq: 2 })],
    { ayarlar: ayar(), simdi: OGLEN });
  assert.equal(gonderilecek.length, 0);
});

test('bekleyen ve takilan oturum bildirilir, onem dogru', () => {
  const { gonderilecek } = kararVer(
    [gecis('a', 'seni-bekliyor'), gecis('b', 'onay-bekliyor', { seq: 2 })],
    { ayarlar: ayar(), simdi: OGLEN });
  assert.equal(gonderilecek.length, 2);
  assert.equal(gonderilecek[0].onem, 'normal');
  assert.equal(gonderilecek[1].onem, 'acil');
  // Baslikta oturum kimligi degil ajan adi olmali
  assert.ok(!gonderilecek[0].baslik.includes('a'.repeat(8)));
  assert.ok(gonderilecek[0].ajan.length > 1);
});

test('sessiz saatte acil geciyor, normal dusuyor', () => {
  const olaylar = [gecis('a', 'seni-bekliyor'), gecis('b', 'limit-doldu', { seq: 2 })];
  const { gonderilecek } = kararVer(olaylar, { ayarlar: ayar(), simdi: GECE });
  assert.equal(gonderilecek.length, 1);
  assert.equal(gonderilecek[0].durum, 'limit-doldu');
});

test('acilGecer kapaliysa sessiz saatte hicbir sey gitmez', () => {
  const a = ayar({ sessizSaatler: { etkin: true, baslangic: 1, bitis: 8, acilGecer: false } });
  const { gonderilecek } = kararVer([gecis('b', 'limit-doldu')], { ayarlar: a, simdi: GECE });
  assert.equal(gonderilecek.length, 0);
});

test('soguma ayni oturum+durum tekrarini engeller, farkli durum gecer', () => {
  const a = ayar({ sogumaDk: 10 });
  const ilk = kararVer([gecis('a', 'seni-bekliyor')], { ayarlar: a, simdi: OGLEN });
  assert.equal(ilk.gonderilecek.length, 1);

  // 5 dakika sonra ayni durum: soguma icinde
  const erken = kararVer([gecis('a', 'seni-bekliyor', { seq: 2 })],
    { ayarlar: a, sonGonderim: ilk.sonGonderim, simdi: OGLEN + 5 * 60_000 });
  assert.equal(erken.gonderilecek.length, 0);

  // Ayni anda farkli durum: soguma anahtari farkli, gecer
  const farkli = kararVer([gecis('a', 'takildi', { seq: 3 })],
    { ayarlar: a, sonGonderim: ilk.sonGonderim, simdi: OGLEN + 5 * 60_000 });
  assert.equal(farkli.gonderilecek.length, 1);

  // 11 dakika sonra ayni durum: soguma bitti
  const gec = kararVer([gecis('a', 'seni-bekliyor', { seq: 4 })],
    { ayarlar: a, sonGonderim: ilk.sonGonderim, simdi: OGLEN + 11 * 60_000 });
  assert.equal(gec.gonderilecek.length, 1);
});

test('esikten cok bildirim tek ozete duser', () => {
  const olaylar = ['a', 'b', 'c', 'd', 'e'].map((id, i) =>
    gecis(id, 'seni-bekliyor', { seq: i + 1, project: 'p' + i }));
  const { gonderilecek, ozet } = kararVer(olaylar, { ayarlar: ayar({ topluEsigi: 3 }), simdi: OGLEN });
  assert.equal(gonderilecek.length, 5);
  assert.ok(ozet, 'ozet uretilmeli');
  assert.equal(ozet.adet, 5);
  assert.match(ozet.baslik, /5 olay/);
});

test('acil varsa ozet de acil olur', () => {
  const olaylar = ['a', 'b', 'c'].map((id, i) => gecis(id, 'seni-bekliyor', { seq: i + 1 }));
  olaylar.push(gecis('d', 'takildi', { seq: 4 }));
  const { ozet } = kararVer(olaylar, { ayarlar: ayar({ topluEsigi: 3 }), simdi: OGLEN });
  assert.equal(ozet.onem, 'acil');
});

test('icerik az ise son mesaj metni sizmaz, tam ise eklenir', () => {
  const o = [gecis('a', 'seni-bekliyor', { metin: 'gizli proje detayi' })];
  const az = kararVer(o, { ayarlar: ayar({ icerik: 'az' }), simdi: OGLEN });
  assert.ok(!az.gonderilecek[0].govde.includes('gizli'));

  const tam = kararVer(o, { ayarlar: ayar({ icerik: 'tam' }), simdi: OGLEN });
  assert.ok(tam.gonderilecek[0].govde.includes('gizli proje detayi'));
});

test('cikarim etiketi tahmini durumlarda gorunur', () => {
  const kesin = kararVer([gecis('a', 'onay-bekliyor', { kesin: true })],
    { ayarlar: ayar(), simdi: OGLEN }).gonderilecek[0];
  const tahmin = kararVer([gecis('b', 'onay-bekliyor', { kesin: false })],
    { ayarlar: ayar(), simdi: OGLEN }).gonderilecek[0];
  assert.ok(!kesin.govde.includes('cikarim'));
  assert.ok(tahmin.govde.includes('cikarim'));
});

// --- Bildirimci: imlec ve kanal davranisi ---

function geciciDb() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-bildirim-'));
  const db = openDb(join(dizin, 'test.db'));
  return { db, temizle: () => {
    db.close();
    try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra silinir */ }
  } };
}

function sahteKanal({ patla = false } = {}) {
  const gidenler = [];
  return {
    ad: 'sahte', gidenler,
    async gonder(p) { if (patla) throw new Error('kanal bozuk'); gidenler.push(p); },
  };
}

test('basaSar gecmisi gondermez, sonrasini gonderir', async () => {
  const { db, temizle } = geciciDb();
  olayYaz(db, { kind: OLAY.DURUM, sessionId: 'eski', data: { durum: 'seni-bekliyor' } });

  const kanal = sahteKanal();
  const b = new Bildirimci(db, { ayarlar: ayar(), kanal, simdi: () => OGLEN });
  b.basaSar(sonSeq(db));

  assert.deepEqual(await b.calistir(), { gonderildi: 0, imlec: 1 });
  assert.equal(kanal.gidenler.length, 0, 'acilistan onceki olaylar gonderilmez');

  olayYaz(db, { kind: OLAY.DURUM, sessionId: 'yeni', project: 'p', data: { durum: 'takildi' } });
  const r = await b.calistir();
  assert.equal(r.gonderildi, 1);
  assert.equal(kanal.gidenler[0].durum, 'takildi');
  temizle();
});

test('imlec ilerler, ayni olay iki kez gonderilmez', async () => {
  const { db, temizle } = geciciDb();
  const kanal = sahteKanal();
  const b = new Bildirimci(db, { ayarlar: ayar(), kanal, simdi: () => OGLEN });
  b.basaSar(sonSeq(db));

  olayYaz(db, { kind: OLAY.DURUM, sessionId: 'a', data: { durum: 'takildi' } });
  await b.calistir();
  await b.calistir();
  assert.equal(kanal.gidenler.length, 1);
  temizle();
});

test('kanal patlarsa imlec yine ilerler ve hata akisa yazilir', async () => {
  const { db, temizle } = geciciDb();
  const kanal = sahteKanal({ patla: true });
  const b = new Bildirimci(db, { ayarlar: ayar(), kanal, simdi: () => OGLEN });
  b.basaSar(sonSeq(db));

  olayYaz(db, { kind: OLAY.DURUM, sessionId: 'a', data: { durum: 'takildi' } });
  const r = await b.calistir();
  assert.equal(r.gonderildi, 0);
  // Imlec ilerlemezse bozuk kanal akisi sonsuza kadar tikar.
  assert.equal(Number(kvOku(db, 'bildirim.imlec')), r.imlec);
  assert.equal(olayOku(db, { kind: 'hata' }).length, 1);
  temizle();
});

test('gonderilen bildirim akisa denetim olayi olarak yazilir', async () => {
  const { db, temizle } = geciciDb();
  const kanal = sahteKanal();
  const b = new Bildirimci(db, { ayarlar: ayar(), kanal, simdi: () => OGLEN });
  b.basaSar(sonSeq(db));

  olayYaz(db, { kind: OLAY.DURUM, sessionId: 'a', project: 'demo', data: { durum: 'limit-doldu' } });
  await b.calistir();

  const denetim = olayOku(db, { kind: 'bildirim' });
  assert.equal(denetim.length, 1);
  assert.equal(denetim[0].data.onem, 'acil');
  assert.equal(denetim[0].data.kanal, 'sahte');
  temizle();
});
