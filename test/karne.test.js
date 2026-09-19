import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { isEkle, KOSU_DURUMU } from '../src/isler.js';
import { ajanKimligi } from '../src/kisilik.js';
import {
  seviye, sonrakiSeviye, rozetler, karneHesapla,
  isKarnesi, tumKarneler, modelKarsilastir, modelOnerisi,
  isModelKarsilastir, isModelOnerisi,
} from '../src/karne.js';

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-karne-'));
  const db = openDb(join(dizin, 'k.db'));
  return { db, dizin, temizle: () => {
    db.close();
    try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra silinir */ }
  } };
}

let sayac = 0;
function kosuEkle(db, isId, { durum, usd = 0.1, sureMs = 30_000, tur = 5, arac = 4, red = 0, model = null }) {
  const bas = 1_700_000_000_000 + (sayac++) * 1000;
  db.prepare(`INSERT INTO kosular (id, is_id, session_id, durum, basladi, bitti, usd,
              tur_sayisi, arac_sayisi, red_sayisi, model) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('k' + sayac, isId, 's' + sayac, durum, bas, bas + sureMs, usd, tur, arac, red, model);
}

// --- Seviye ---

test('seviye basarili kosu sayisiyla yavas artar', () => {
  assert.equal(seviye(0), 0);
  assert.equal(seviye(2), 0);
  assert.equal(seviye(3), 1);
  assert.equal(seviye(10), 2);
  assert.equal(seviye(1000), 6);
});

test('sonraki seviye kalan kosuyu soyler, tepede null doner', () => {
  assert.deepEqual(sonrakiSeviye(0), { seviye: 1, kalan: 3 });
  assert.deepEqual(sonrakiSeviye(5), { seviye: 2, kalan: 5 });
  assert.equal(sonrakiSeviye(1000), null);
});

// --- Karne hesabi ---

test('karar bekleyen kosu ne basari ne basarisizlik sayilir', () => {
  const k = karneHesapla([
    { durum: KOSU_DURUMU.BITTI, usd: 1 },
    { durum: KOSU_DURUMU.KARAR_BEKLIYOR, usd: 1 },
  ]);
  assert.equal(k.kosu, 2);
  assert.equal(k.basarili, 1);
  assert.equal(k.basarisiz, 0);
  assert.equal(k.kararaDusen, 1);
  // Hukumsuz kosu paydayi bozmamali: 1/1 = %100
  assert.equal(k.basariOrani, 1);
  assert.equal(k.hukumlu, 1);
});

test('hic hukumlu kosu yoksa oran SIFIR degil YOK', () => {
  // Regresyon: sadece karar bekleyen bir ajan "%0 basari" gorunuyordu -
  // bu "basarisiz" demek olurdu, oysa henuz hukum verilmemis.
  const k = karneHesapla([{ durum: KOSU_DURUMU.KARAR_BEKLIYOR, usd: 1 }]);
  assert.equal(k.basariOrani, null);
  assert.equal(k.hukumlu, 0);
  assert.equal(k.kararaDusen, 1);
  // Null oran rozet mantigini patlatmamali
  assert.deepEqual(k.rozetler, []);
});

test('hukumsuz karne model onerisini patlatmaz', () => {
  const k = karneHesapla([]);
  assert.equal(k.basariOrani, null);
  assert.deepEqual(rozetler(k), []);
});

test('ortalamalar butun kosular uzerinden', () => {
  const k = karneHesapla([
    { durum: KOSU_DURUMU.BITTI, usd: 0.2, basladi: 0, bitti: 10_000, turSayisi: 4 },
    { durum: KOSU_DURUMU.HATA, usd: 0.4, basladi: 0, bitti: 30_000, turSayisi: 6 },
  ]);
  assert.ok(Math.abs(k.ortalamaUsd - 0.3) < 1e-9);
  assert.equal(k.ortalamaMs, 20_000);
  assert.equal(k.ortalamaTur, 5);
  assert.equal(k.basariOrani, 0.5);
});

test('hic kosu yoksa sifira bolme olmaz', () => {
  const k = karneHesapla([]);
  assert.equal(k.basariOrani, null);
  assert.equal(k.ortalamaUsd, 0);
  assert.equal(k.seviye, 0);
});

// --- Rozetler ---

test('kusursuz ve ozerk rozetleri hak edilerek gelir', () => {
  const r = rozetler({ kosu: 6, basariOrani: 1, kararSayisi: 0, ortalamaUsd: 0.5 });
  const adlar = r.map((x) => x.ad);
  assert.ok(adlar.includes('kusursuz'));
  assert.ok(adlar.includes('ozerk'));
});

test('az kosuyla rozet verilmez', () => {
  assert.deepEqual(rozetler({ kosu: 2, basariOrani: 1, kararSayisi: 0, ortalamaUsd: 0.01 }), []);
});

test('sorunlu ayarlar rozetle isaret edilir', () => {
  const cekingen = rozetler({ kosu: 10, basariOrani: 1, kararSayisi: 8, ortalamaUsd: 1 })
    .find((x) => x.ad === 'cekingen');
  assert.ok(cekingen, 'cok soran ajan icin uyari rozeti');
  assert.match(cekingen.not, /profili gevsetmeyi/);

  const zor = rozetler({ kosu: 6, basariOrani: 0.2, kararSayisi: 0, ortalamaUsd: 1 })
    .find((x) => x.ad === 'zorlaniyor');
  assert.ok(zor);
});

// --- Veritabaniyla ---

test('is karnesi kimligi ISTEN alir', () => {
  const o = ortam();
  const is = isEkle(o.db, { ad: 'gece', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
  kosuEkle(o.db, is.id, { durum: KOSU_DURUMU.BITTI });
  kosuEkle(o.db, is.id, { durum: KOSU_DURUMU.BITTI });

  const k = isKarnesi(o.db, is.id);
  assert.equal(k.kosu, 2);
  assert.equal(k.basarili, 2);
  assert.equal(k.is.ad, 'gece');
  // Oturumlar farkli ama ajan ayni olmali - karne ancak boyle birikir.
  assert.deepEqual(k.ajan, ajanKimligi({ isId: is.id }));
  o.temizle();
});

test('tum karneler kosu sayisina gore siralanir', () => {
  const o = ortam();
  const az = isEkle(o.db, { ad: 'az', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
  const cok = isEkle(o.db, { ad: 'cok', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
  kosuEkle(o.db, az.id, { durum: KOSU_DURUMU.BITTI });
  for (let i = 0; i < 3; i++) kosuEkle(o.db, cok.id, { durum: KOSU_DURUMU.BITTI });

  const hepsi = tumKarneler(o.db);
  assert.equal(hepsi[0].is.ad, 'cok');
  assert.equal(hepsi.length, 2);
  assert.equal(tumKarneler(o.db, { enAzKosu: 2 }).length, 1);
  o.temizle();
});

// --- Model karsilastirma ---

test('model karsilastirmasi ucuzdan pahaliya siralar', () => {
  const o = ortam();
  const h = isEkle(o.db, { ad: 'h', gorev: 'g', cwd: o.dizin, profil: 'serbest', model: 'haiku' });
  const p = isEkle(o.db, { ad: 'o', gorev: 'g', cwd: o.dizin, profil: 'serbest', model: 'opus' });
  for (let i = 0; i < 5; i++) kosuEkle(o.db, h.id, { durum: KOSU_DURUMU.BITTI, usd: 0.02 });
  for (let i = 0; i < 5; i++) kosuEkle(o.db, p.id, { durum: KOSU_DURUMU.BITTI, usd: 0.5 });

  const g = modelKarsilastir(o.db, { enAzKosu: 3 });
  assert.equal(g[0].model, 'haiku');
  assert.equal(g[1].model, 'opus');
  o.temizle();
});

test('ucuz model ayni basariyi veriyorsa onerilir', () => {
  const o = ortam();
  const h = isEkle(o.db, { ad: 'h', gorev: 'g', cwd: o.dizin, profil: 'serbest', model: 'haiku' });
  const p = isEkle(o.db, { ad: 'o', gorev: 'g', cwd: o.dizin, profil: 'serbest', model: 'opus' });
  for (let i = 0; i < 6; i++) kosuEkle(o.db, h.id, { durum: KOSU_DURUMU.BITTI, usd: 0.02 });
  for (let i = 0; i < 6; i++) kosuEkle(o.db, p.id, { durum: KOSU_DURUMU.BITTI, usd: 0.6 });

  const r = modelOnerisi(o.db, { enAzKosu: 5 });
  assert.equal(r.oneri, 'haiku');
  assert.match(r.neden, /kat pahali/);
  o.temizle();
});

test('ucuz model basarisizsa oneri verilmez', () => {
  const o = ortam();
  const h = isEkle(o.db, { ad: 'h', gorev: 'g', cwd: o.dizin, profil: 'serbest', model: 'haiku' });
  const p = isEkle(o.db, { ad: 'o', gorev: 'g', cwd: o.dizin, profil: 'serbest', model: 'opus' });
  for (let i = 0; i < 6; i++) kosuEkle(o.db, h.id, { durum: KOSU_DURUMU.HATA, usd: 0.02 });
  for (let i = 0; i < 6; i++) kosuEkle(o.db, p.id, { durum: KOSU_DURUMU.BITTI, usd: 0.6 });

  assert.equal(modelOnerisi(o.db, { enAzKosu: 5 }).oneri, null);
  o.temizle();
});

test('az veriyle model onerisi yapilmaz', () => {
  const o = ortam();
  const h = isEkle(o.db, { ad: 'h', gorev: 'g', cwd: o.dizin, profil: 'serbest', model: 'haiku' });
  kosuEkle(o.db, h.id, { durum: KOSU_DURUMU.BITTI });
  const r = modelOnerisi(o.db, { enAzKosu: 5 });
  assert.equal(r.oneri, null, 'olcum degil kumar olurdu');
  assert.match(r.neden, /en az iki modelde/);
  o.temizle();
});

// --- Is basina model yonlendirmesi ---

function isVeKosular(o, liste) {
  const is = isEkle(o.db, { ad: 'y' + (++sayac), gorev: 'g', cwd: o.dizin, profil: 'serbest' });
  for (const k of liste) kosuEkle(o.db, is.id, k);
  return is;
}

test('is basina karsilastirma modeli KOSUDAN okur, isin ayarindan degil', () => {
  const o = ortam();
  // Is simdi sonnet'te; gecmis kosularin bir kismi haiku'da kosmus.
  const is = isEkle(o.db, { ad: 'z', gorev: 'g', cwd: o.dizin, profil: 'serbest', model: 'sonnet' });
  for (let i = 0; i < 3; i++) kosuEkle(o.db, is.id, { durum: KOSU_DURUMU.BITTI, usd: 0.02, model: 'haiku' });
  for (let i = 0; i < 3; i++) kosuEkle(o.db, is.id, { durum: KOSU_DURUMU.BITTI, usd: 0.20, model: 'sonnet' });
  const { gruplar } = isModelKarsilastir(o.db, is.id);
  assert.deepEqual(gruplar.map((g) => g.model), ['haiku', 'sonnet'], 'ucuzdan pahaliya');
  assert.equal(gruplar[0].kosu, 3);
  o.temizle();
});

test('modeli olculmemis eski kosular disarida kalir ve sayilir', () => {
  const o = ortam();
  const is = isVeKosular(o, [
    { durum: KOSU_DURUMU.BITTI, model: null },
    { durum: KOSU_DURUMU.BITTI, model: null },
  ]);
  const r = isModelKarsilastir(o.db, is.id);
  assert.equal(r.gruplar.length, 0);
  assert.equal(r.olculmemis, 2);
  o.temizle();
});

test('tek modelde veri varsa oneri YOK - veri yok dogru cevaptir', () => {
  const o = ortam();
  const is = isVeKosular(o, Array.from({ length: 5 }, () => ({ durum: KOSU_DURUMU.BITTI, model: 'haiku' })));
  const r = isModelOnerisi(o.db, is.id);
  assert.equal(r.oneri, null);
  assert.match(r.neden, /en az iki modelde/);
  o.temizle();
});

test('ucuz model ayni basariyi veriyor ve belirgin ucuzsa onerilir', () => {
  const o = ortam();
  const is = isVeKosular(o, [
    ...Array.from({ length: 3 }, () => ({ durum: KOSU_DURUMU.BITTI, usd: 0.02, model: 'haiku' })),
    ...Array.from({ length: 3 }, () => ({ durum: KOSU_DURUMU.BITTI, usd: 0.20, model: 'sonnet' })),
  ]);
  const r = isModelOnerisi(o.db, is.id);
  assert.equal(r.oneri, 'haiku');
  assert.match(r.neden, /10.0 kat pahali/);
  o.temizle();
});

test('ucuz model basarisizsa ucuz oldugu icin onerilmez', () => {
  const o = ortam();
  const is = isVeKosular(o, [
    ...Array.from({ length: 3 }, () => ({ durum: KOSU_DURUMU.HATA, usd: 0.02, model: 'haiku' })),
    ...Array.from({ length: 3 }, () => ({ durum: KOSU_DURUMU.BITTI, usd: 0.20, model: 'sonnet' })),
  ]);
  const r = isModelOnerisi(o.db, is.id);
  assert.equal(r.oneri, null);
  assert.match(r.neden, /basarisi dusuk/);
  o.temizle();
});

test('maliyet farki kucukse model degistirmeye deger bulunmaz', () => {
  const o = ortam();
  const is = isVeKosular(o, [
    ...Array.from({ length: 3 }, () => ({ durum: KOSU_DURUMU.BITTI, usd: 0.10, model: 'haiku' })),
    ...Array.from({ length: 3 }, () => ({ durum: KOSU_DURUMU.BITTI, usd: 0.13, model: 'sonnet' })),
  ]);
  const r = isModelOnerisi(o.db, is.id);
  assert.equal(r.oneri, null);
  assert.match(r.neden, /degistirmeye deger degil/);
  o.temizle();
});
