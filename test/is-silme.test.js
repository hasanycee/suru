import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { isEkle, isSil, isListesi, yetimIcIsleriSil, kosuAc, kosuGetir, kosuGuncelle, KOSU_DURUMU } from '../src/isler.js';
import { Kuyruk } from '../src/kuyruk.js';
import { kararlariTazele, bekleyenKararlar } from '../src/eskalasyon.js';

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-is-silme-'));
  const db = openDb(join(dizin, 's.db'));
  return { db, dizin, temizle: () => {
    db.close();
    try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra */ }
  } };
}
const bekle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test('is silinmeden once bekleyen ve calisan kosulari (dongudeki denetci dahil) durdurulur', async () => {
  // Saha: calisan kosusu olan is silindi, kosu 8 sn sonra bitip silinmis ise ait karar acti.
  const o = ortam();
  const durdurulan = [];
  const kosucu = (db, { kosu, kontrol }) => new Promise((coz) => {
    kontrol.durdur = (neden) => {
      durdurulan.push(kosu.id);
      kosuGuncelle(db, kosu.id, { durum: KOSU_DURUMU.IPTAL, bitti: Date.now(), hata: 'durduruldu: ' + neden });
      coz({ durum: KOSU_DURUMU.IPTAL });
      return true;
    };
  });
  const k = new Kuyruk(o.db, { esZamanli: 1, kosucu });
  const is = isEkle(o.db, { ad: 'silinecek', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
  const baska = isEkle(o.db, { ad: 'dokunulmayacak', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
  const calisan = k.siraya(is.id);           // calisir (sinir 1)
  const sirada = k.siraya(is.id);            // bekler
  const baskasi = k.siraya(baska.id);        // bekler, baska is
  await bekle();
  // Ayni donguye ait (baska iste) denetci kosusu da durmali
  const denetciIs = isEkle(o.db, { ad: '_denetci:x', gorev: 'g', cwd: o.dizin, profil: 'gozlemci', ic: true });
  kosuGuncelle(o.db, calisan.id, { donguId: 'd1', rol: 'yapici', tur: 1 });
  const denetci = kosuAc(o.db, denetciIs.id, { donguId: 'd1', rol: 'denetci', tur: 1 });

  const liste = k.isKosulariniDurdur(is.id, 'is silindi');
  assert.equal(liste.length, 3, 'calisan + sirada + dongudeki denetci');
  // k.bekle() kullanilmaz: yer bosalinca baslayan baska isin kosucusu bu testte hic bitmez.
  await bekle(30);
  assert.deepEqual(durdurulan, [calisan.id]);
  assert.equal(kosuGetir(o.db, sirada.id).durum, KOSU_DURUMU.IPTAL);
  assert.equal(kosuGetir(o.db, denetci.id).durum, KOSU_DURUMU.IPTAL);
  assert.equal(kosuGetir(o.db, baskasi.id).durum, KOSU_DURUMU.CALISIYOR, 'baska is durdurulmaz; yer bosalinca basladi');
  o.temizle();
});

test('isi silinmis kosu karar bekliyor olsa bile karar karti acilmaz, kosu iptal olur', () => {
  const o = ortam();
  const is = isEkle(o.db, { ad: 'gecici', gorev: 'g', cwd: o.dizin, profil: 'danisan' });
  const kosu = kosuAc(o.db, is.id);
  isSil(o.db, is.id);
  kosuGuncelle(o.db, kosu.id, { durum: KOSU_DURUMU.KARAR_BEKLIYOR, sonuc: 'plan' });
  assert.deepEqual(kararlariTazele(o.db), []);
  assert.equal(bekleyenKararlar(o.db).length, 0);
  const k = kosuGetir(o.db, kosu.id);
  assert.equal(k.durum, KOSU_DURUMU.IPTAL);
  assert.match(k.hata, /is silinmis/);
  o.temizle();
});

test('is silinince denetci ic isi de silinir; baska isin denetcisi kalir', () => {
  const o = ortam();
  try {
    const a = isEkle(o.db, { ad: 'A', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
    const b = isEkle(o.db, { ad: 'B', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
    for (const x of [a, b]) isEkle(o.db, { ad: '_denetci:' + x.id, gorev: 'g', cwd: o.dizin, profil: 'gozlemci', ic: true });
    isSil(o.db, a.id);
    assert.deepEqual(isListesi(o.db).map((i) => i.ad).sort(), ['B', '_denetci:' + b.id]);
  } finally { o.temizle(); }
});

test('yetimIcIsleriSil: hedefi silinmis denetci ve projesi bosalmis damitma gider; mesgul ve sahipli olanlar kalir', () => {
  const o = ortam();
  try {
    const bos = mkdtempSync(join(tmpdir(), 'suru-yetim-'));
    try {
      const sahip = isEkle(o.db, { ad: 'Sahip', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
      const ic = (ad, cwd = o.dizin) => isEkle(o.db, { ad, gorev: 'g', cwd, profil: 'gozlemci', ic: true });
      ic('_denetci:' + sahip.id);                       // sahibi var: kalir
      ic('_denetci:silinmis-is-kimligi');               // yetim: gider
      const mesgul = ic('_denetci:baska-silinmis-is');  // yetim ama kosusu calisiyor: kalir
      kosuGuncelle(o.db, kosuAc(o.db, mesgul.id).id, { durum: KOSU_DURUMU.CALISIYOR });
      ic('_damitma:dolu');                              // projede kullanici isi var: kalir
      ic('_damitma:bos', bos);                          // projede kullanici isi yok: gider
      const silinen = yetimIcIsleriSil(o.db).sort();
      assert.deepEqual(silinen, ['_damitma:bos', '_denetci:silinmis-is-kimligi']);
      assert.equal(isListesi(o.db).length, 4);
      assert.deepEqual(yetimIcIsleriSil(o.db), [], 'idempotent');
    } finally { rmSync(bos, { recursive: true, force: true }); }
  } finally { o.temizle(); }
});
