import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { OLAY, oku as olayOku } from '../src/events.js';
import { isEkle, kosuGetir, KOSU_DURUMU } from '../src/isler.js';
import { Kuyruk, bekleyenKosular } from '../src/kuyruk.js';

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-kuyruk-'));
  const db = openDb(join(dizin, 'q.db'));
  return { db, dizin, temizle: () => {
    db.close();
    try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra silinir */ }
  } };
}

/**
 * Elle cozulen sahte kosucu: es zamanliligi gozlemleyebilmek icin kosular
 * bizim istedigimiz anda biter.
 */
function sahteKosucu() {
  const acik = new Map();      // kosuId -> cozumle
  let enYuksek = 0;
  const kosucu = (db, { kosu }) => new Promise((coz) => {
    enYuksek = Math.max(enYuksek, acik.size + 1);
    acik.set(kosu.id, () => {
      db.prepare('UPDATE kosular SET durum = ?, bitti = ? WHERE id = ?')
        .run(KOSU_DURUMU.BITTI, Date.now(), kosu.id);
      acik.delete(kosu.id);
      coz({ durum: KOSU_DURUMU.BITTI });
    });
  });
  return {
    kosucu,
    get acikSayisi() { return acik.size; },
    get enYuksekEsZaman() { return enYuksek; },
    acikIdler: () => [...acik.keys()],
    bitir: (kosuId) => acik.get(kosuId)?.(),
    hepsiniBitir: () => [...acik.values()].forEach((f) => f()),
  };
}

const bekle = () => new Promise((r) => setImmediate(r));

test('es zamanlilik siniri asilmaz', async () => {
  const o = ortam();
  const s = sahteKosucu();
  const k = new Kuyruk(o.db, { esZamanli: 2, kosucu: s.kosucu });
  const is = isEkle(o.db, { ad: 'a', gorev: 'g', cwd: o.dizin, profil: 'gozlemci' });

  for (let i = 0; i < 5; i++) k.siraya(is.id);
  await bekle();

  assert.equal(s.acikSayisi, 2, 'ayni anda en fazla 2 kosu');
  assert.equal(k.durum().bekleyen, 3);

  s.hepsiniBitir();
  await bekle(); await bekle();
  assert.equal(s.acikSayisi, 2, 'bir yer bosalinca siradaki alinir');

  s.hepsiniBitir(); await bekle(); await bekle();
  s.hepsiniBitir(); await bekle(); await bekle();
  assert.equal(k.durum().bekleyen, 0);
  assert.ok(s.enYuksekEsZaman <= 2, 'hicbir anda sinir asilmadi');
  o.temizle();
});

test('dusuk oncelikli is once alinir', async () => {
  const o = ortam();
  const s = sahteKosucu();
  const k = new Kuyruk(o.db, { esZamanli: 1, kosucu: s.kosucu });

  const dusuk = isEkle(o.db, { ad: 'dusuk', gorev: 'g', cwd: o.dizin, profil: 'gozlemci', oncelik: 9 });
  const acil  = isEkle(o.db, { ad: 'acil',  gorev: 'g', cwd: o.dizin, profil: 'gozlemci', oncelik: 0 });

  const ilk = k.siraya(dusuk.id);   // once siraya girdi ama onceligi dusuk
  const ikinci = k.siraya(acil.id);
  await bekle();

  // Ilk siraya giren zaten baslamis olur; asil sinav: siradaki hangisi?
  assert.equal(s.acikIdler()[0], ilk.id);
  const ucuncu = k.siraya(dusuk.id);
  s.bitir(ilk.id);
  await bekle(); await bekle();

  assert.equal(s.acikIdler()[0], ikinci.id, 'acil is, once siraya giren dusuk isten once alinmali');
  assert.equal(kosuGetir(o.db, ucuncu.id).durum, KOSU_DURUMU.BEKLIYOR);
  o.temizle();
});

test('sinir calisirken yukseltilince bosluk hemen dolar', async () => {
  const o = ortam();
  const s = sahteKosucu();
  const k = new Kuyruk(o.db, { esZamanli: 1, kosucu: s.kosucu });
  const is = isEkle(o.db, { ad: 'a', gorev: 'g', cwd: o.dizin, profil: 'gozlemci' });
  for (let i = 0; i < 4; i++) k.siraya(is.id);
  await bekle();
  assert.equal(s.acikSayisi, 1);

  k.sinirAyarla(3);
  await bekle();
  assert.equal(s.acikSayisi, 3, 'sinir yukselince hemen doldurulur');

  // Sinir degisimi denetim icin akisa yazilir
  const olay = olayOku(o.db, { kind: OLAY.IS }).find((x) => x.data.asama === 'sinir-degisti');
  assert.ok(olay);
  assert.equal(olay.data.onceki, 1);
  assert.equal(olay.data.yeni, 3);
  o.temizle();
});

test('sinir dusurulunce calisanlar kesilmez, yenisi baslamaz', async () => {
  const o = ortam();
  const s = sahteKosucu();
  const k = new Kuyruk(o.db, { esZamanli: 3, kosucu: s.kosucu });
  const is = isEkle(o.db, { ad: 'a', gorev: 'g', cwd: o.dizin, profil: 'gozlemci' });
  for (let i = 0; i < 5; i++) k.siraya(is.id);
  await bekle();
  assert.equal(s.acikSayisi, 3);

  k.sinirAyarla(1);
  await bekle();
  assert.equal(s.acikSayisi, 3, 'calisan kosu yarida kesilmez');

  s.hepsiniBitir();
  await bekle(); await bekle();
  assert.equal(s.acikSayisi, 1, 'yeni sinira gore tek kosu');
  o.temizle();
});

test('durdurulan kuyruk yeni kosu baslatmaz, devam edince alir', async () => {
  const o = ortam();
  const s = sahteKosucu();
  const k = new Kuyruk(o.db, { esZamanli: 2, kosucu: s.kosucu });
  const is = isEkle(o.db, { ad: 'a', gorev: 'g', cwd: o.dizin, profil: 'gozlemci' });

  k.durdur();
  k.siraya(is.id);
  k.siraya(is.id);
  await bekle();
  assert.equal(s.acikSayisi, 0);
  assert.equal(k.durum().bekleyen, 2);

  k.devam();
  await bekle();
  assert.equal(s.acikSayisi, 2);
  o.temizle();
});

test('kosucu patlarsa kosu asili kalmaz ve kuyruk akmaya devam eder', async () => {
  const o = ortam();
  let ilk = true;
  const kosucu = async (db, { kosu }) => {
    if (ilk) { ilk = false; throw new Error('beklenmedik cokme'); }
    db.prepare('UPDATE kosular SET durum = ? WHERE id = ?').run(KOSU_DURUMU.BITTI, kosu.id);
    return { durum: KOSU_DURUMU.BITTI };
  };
  const k = new Kuyruk(o.db, { esZamanli: 1, kosucu });
  const is = isEkle(o.db, { ad: 'a', gorev: 'g', cwd: o.dizin, profil: 'gozlemci' });
  const a = k.siraya(is.id);
  const b = k.siraya(is.id);
  await k.bekle();

  const kayitA = kosuGetir(o.db, a.id);
  assert.equal(kayitA.durum, KOSU_DURUMU.HATA, 'patlayan kosu calisiyor asili kalmamali');
  assert.match(kayitA.hata, /beklenmedik cokme/);
  assert.equal(kosuGetir(o.db, b.id).durum, KOSU_DURUMU.BITTI, 'sonraki kosu yine de calisti');
  o.temizle();
});

test('etkin olmayan is siraya alinmaz', () => {
  const o = ortam();
  const k = new Kuyruk(o.db, { esZamanli: 1, kosucu: sahteKosucu().kosucu });
  const is = isEkle(o.db, { ad: 'a', gorev: 'g', cwd: o.dizin, profil: 'gozlemci' });
  o.db.prepare('UPDATE isler SET etkin = 0 WHERE id = ?').run(is.id);
  assert.throws(() => k.siraya(is.id), /etkin degil/);
  assert.throws(() => k.siraya('olmayan-id'), /bulunamadi/);
  o.temizle();
});

test('bekleyen kosular oncelik ve sira ile listelenir', async () => {
  const o = ortam();
  const k = new Kuyruk(o.db, { esZamanli: 0, kosucu: sahteKosucu().kosucu });
  const dusuk = isEkle(o.db, { ad: 'd', gorev: 'g', cwd: o.dizin, profil: 'gozlemci', oncelik: 8 });
  const acil = isEkle(o.db, { ad: 'a', gorev: 'g', cwd: o.dizin, profil: 'gozlemci', oncelik: 1 });
  k.siraya(dusuk.id);
  const b = k.siraya(acil.id);

  const sira = bekleyenKosular(o.db);
  assert.equal(sira.length, 2);
  assert.equal(sira[0].kosuId, b.id, 'once acil olan');
  o.temizle();
});

test('kademeli baslatma kosulari aralikla acar', async () => {
  const o = ortam();
  const acilanlar = [];
  // Hic bitmeyen kosucu: sadece baslama anlarini olcuyoruz.
  const kosucu = () => { acilanlar.push(Date.now()); return new Promise(() => {}); };
  const k = new Kuyruk(o.db, { esZamanli: 3, kosucu, baslatmaAraligiMs: 120 });
  const is = isEkle(o.db, { ad: 'a', gorev: 'g', cwd: o.dizin, profil: 'gozlemci' });
  for (let i = 0; i < 3; i++) k.siraya(is.id);
  await new Promise((r) => setImmediate(r));
  assert.equal(acilanlar.length, 1, 'ilk an sadece bir kosu acilir');

  await new Promise((r) => setTimeout(r, 450));
  assert.equal(acilanlar.length, 3, 'aralik doldukca digerleri acilir');
  for (let i = 1; i < acilanlar.length; i++) {
    assert.ok(acilanlar[i] - acilanlar[i - 1] >= 100, 'kosular arasi aralik korunmali');
  }
  o.temizle();
});

test('basladi kuyruga alinma degil calismaya baslama zamanidir', async () => {
  // Regresyon (sinav): basladi sira zamaniydi; sirayla calisan iki kosu ayni anda
  // gorunuyor, golge ortusme uyarisi ve karne sureleri yanlis cikiyordu.
  const o = ortam();
  const k = new Kuyruk(o.db, { esZamanli: 0, kosucu: () => new Promise(() => {}) });
  const is = isEkle(o.db, { ad: 'a', gorev: 'g', cwd: o.dizin, profil: 'gozlemci' });
  const kosu = k.siraya(is.id);
  const sira = kosuGetir(o.db, kosu.id).basladi;
  await new Promise((r) => setTimeout(r, 30));
  k.sinirAyarla(1);
  await bekle();
  assert.equal(kosuGetir(o.db, kosu.id).durum, KOSU_DURUMU.CALISIYOR);
  assert.ok(kosuGetir(o.db, kosu.id).basladi >= sira + 25, 'basladi calismaya baslayinca guncellenmeli');
  o.temizle();
});
