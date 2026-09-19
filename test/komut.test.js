import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { isEkle, kosuAc, kosuGuncelle, kosuGetir, KOSU_DURUMU } from '../src/isler.js';
import { kararlariTazele, bekleyenKararlar, kararGetir, KARAR_DURUMU } from '../src/eskalasyon.js';
import { kayitlar as hafizaKayitlari } from '../src/hafiza.js';
import { komutCalistir, kisa, onekleBul, projeBul, YARDIM } from '../src/komut.js';

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-komut-'));
  const db = openDb(join(dizin, 'k.db'));
  const proje = join(dizin, 'oyun'); mkdirSync(proje);
  const proje2 = join(dizin, 'oyuncak'); mkdirSync(proje2);
  const cagrilar = [];
  // Sahte kuyruk: gercek surec yok, cagrilar kaydedilir.
  const kuyruk = {
    siraya: (isId) => { cagrilar.push(['siraya', isId]); return kosuAc(db, isId); },
    kosuDurdur: (id, neden) => { cagrilar.push(['durdur', id, neden]); kosuGuncelle(db, id, { durum: KOSU_DURUMU.IPTAL }); return { kosuId: id, durum: 'durduruluyor' }; },
    isKosulariniDurdur: (isId, neden) => { cagrilar.push(['isDurdur', isId, neden]); return ['x']; },
    pompala: () => cagrilar.push(['pompala']),
    durum: () => ({ esZamanli: 3, calisan: 1, bekleyen: 0 }),
  };
  const ctx = { db, kuyruk };
  return { db, dizin, proje, proje2, kuyruk, cagrilar, ctx,
    temizle: () => { db.close(); try { rmSync(dizin, { recursive: true, force: true }); } catch { /* */ } } };
}

/** Karar-bekleyen bir kosu ve karari yaratir. */
function kararAc(db, isId, { hata = 'patladi' } = {}) {
  const kosu = kosuAc(db, isId);
  kosuGuncelle(db, kosu.id, { durum: KOSU_DURUMU.KARAR_BEKLIYOR, hata, bitti: Date.now() });
  kararlariTazele(db);
  return bekleyenKararlar(db).find((k) => k.kosuId === kosu.id);
}

test('bos ve bilinmeyen komut yardim doner; hata metne cevrilir, firlatilmaz', () => {
  const o = ortam();
  try {
    assert.equal(komutCalistir('', o.ctx).metin, YARDIM);
    assert.match(komutCalistir('/abc', o.ctx).metin, /bilinmeyen komut/);
    assert.match(komutCalistir('/sira yok-boyle-is', o.ctx).metin, /^olmadi: /);
    assert.match(komutCalistir('/durum@surubot', o.ctx).metin, /Sürü:/);
  } finally { o.temizle(); }
});

test('onekleBul: tek eslesme doner, belirsizlik ve yokluk acik hata', () => {
  const l = [{ id: 'abc123-x' }, { id: 'abc999-y' }, { id: 'zzz000' }];
  assert.equal(onekleBul(l, 'zzz').id, 'zzz000');
  assert.equal(onekleBul(l, 'ABC1').id, 'abc123-x');
  assert.throws(() => onekleBul(l, 'abc'), /birden fazla/);
  assert.throws(() => onekleBul(l, 'q'), /bulunamadi/);
  assert.throws(() => onekleBul(l, ''), /eksik/);
});

test('/isler, /sira ve /durdur kisa kimlik ya da adla calisir', () => {
  const o = ortam();
  try {
    const is = isEkle(o.db, { ad: 'Testleri yaz', gorev: 'g', cwd: o.proje, profil: 'serbest' });
    assert.match(komutCalistir('/isler', o.ctx).metin, /Testleri yaz · oyun · serbest  \[/);
    const r = komutCalistir('/sira testleri yaz', o.ctx);
    assert.match(r.metin, /kuyruga alindi: Testleri yaz/);
    assert.equal(o.cagrilar[0][0], 'siraya');
    const kosu = o.db.prepare('SELECT id FROM kosular').get();
    kosuGuncelle(o.db, kosu.id, { durum: KOSU_DURUMU.CALISIYOR });
    // Kosu onekiyle durdur
    assert.match(komutCalistir('/durdur ' + kisa(kosu.id), o.ctx).metin, /durduruldu: /);
    assert.equal(o.cagrilar.at(-1)[2], 'telefon');
    // Is adiyla durdur: isin butun kosulari
    assert.match(komutCalistir('/durdur ' + kisa(is.id), o.ctx).metin, /1 kosu durduruldu/);
    assert.equal(o.cagrilar.at(-1)[0], 'isDurdur');
  } finally { o.temizle(); }
});

test('/kararlar numarali secenek verir; /cevap numarayla hazir cevabi, metinle serbest cevabi uygular', () => {
  const o = ortam();
  try {
    const is = isEkle(o.db, { ad: 'Onar', gorev: 'g', cwd: o.proje, profil: 'denetimli' });
    const k1 = kararAc(o.db, is.id);
    const r = komutCalistir('/kararlar', o.ctx);
    assert.match(r.metin, /Takildi: Onar/);
    assert.match(r.metin, /1\) Tekrar dene/);
    assert.match(r.metin, /3\) Vazgec/);
    assert.equal(r.dugmeler.length, 1);
    assert.equal(r.dugmeler[0].secenekler[0].veri, 'k:' + kisa(k1.id) + ':1');

    // Numara: hazir cevap -> devam kosusu acilir, kuyruk pompalanir
    const c = komutCalistir('/cevap ' + kisa(k1.id) + ' 1', o.ctx);
    assert.match(c.metin, /cevaplandi, ajan devam ediyor/);
    const kapali = kararGetir(o.db, k1.id);
    assert.equal(kapali.durum, KARAR_DURUMU.CEVAPLANDI);
    assert.match(kapali.cevap, /Hatayi tekrar incele/);
    assert.ok(o.cagrilar.some((c2) => c2[0] === 'pompala'));
    assert.equal(kosuGetir(o.db, kapali.devamKosuId).devamCevabi, kapali.cevap);

    // Serbest metin
    const k2 = kararAc(o.db, is.id);
    const c2 = komutCalistir('/cevap ' + kisa(k2.id) + ' once loglara bak sonra dene', o.ctx);
    assert.match(c2.metin, /cevaplandi/);
    assert.equal(kararGetir(o.db, k2.id).cevap, 'once loglara bak sonra dene');

    // Vazgec (eylem: iptal)
    const k3 = kararAc(o.db, is.id);
    assert.match(komutCalistir('/cevap ' + kisa(k3.id) + ' 3', o.ctx).metin, /vazgecildi/);
    assert.equal(kararGetir(o.db, k3.id).durum, KARAR_DURUMU.IPTAL);

    // Olmayan secenek ve kapali karar
    const k4 = kararAc(o.db, is.id);
    assert.match(komutCalistir('/cevap ' + kisa(k4.id) + ' 9', o.ctx).metin, /secenek yok: 9/);
    assert.match(komutCalistir('/cevap ' + kisa(k3.id) + ' 1', o.ctx).metin, /bulunamadi/);
    assert.match(komutCalistir('/cevap ' + kisa(k4.id), o.ctx).metin, /kullanim/);
  } finally { o.temizle(); }
});

test('/yeni bilinen projede is acar, ayarlari son isten miras alir ve kuyruga koyar', () => {
  const o = ortam();
  try {
    assert.match(komutCalistir('/yeni oyun | bir sey yap', o.ctx).metin, /bilinen proje yok/);
    isEkle(o.db, { ad: 'eski', gorev: 'g', cwd: o.proje, profil: 'gozlemci', model: 'haiku', dogrulama: 'npm test' });
    isEkle(o.db, { ad: 'oyuncak-is', gorev: 'g', cwd: o.proje2, profil: 'serbest' });
    // 'oyun' hem oyun hem oyuncak'in oneki ama tam eslesme kazanir
    const r = komutCalistir('/yeni oyun | README dosyasina kurulum bolumu ekle', o.ctx);
    assert.match(r.metin, /is acildi ve kuyruga alindi: README dosyasina kurulum bolumu ekle · oyun · gozlemci/);
    const yeni = o.db.prepare("SELECT * FROM isler WHERE ad LIKE 'README%'").get();
    assert.equal(yeni.cwd, o.proje);
    assert.equal(yeni.model, 'haiku');
    assert.equal(yeni.dogrulama, 'npm test');
    assert.equal(o.cagrilar.at(-1)[0], 'siraya');
    // Belirsiz onek
    assert.match(komutCalistir('/yeni oyu | x', o.ctx).metin, /birden fazla projeyle/);
    assert.match(komutCalistir('/yeni oyun x', o.ctx).metin, /kullanim/);
    assert.equal(projeBul(o.db, 'oyuncak').cwd, o.proje2);
  } finally { o.temizle(); }
});

test('/not projeye insan olgusu yazar; /durum calisan kosuyu ve karar sayisini gosterir', () => {
  const o = ortam();
  try {
    const is = isEkle(o.db, { ad: 'A', gorev: 'g', cwd: o.proje, profil: 'serbest' });
    assert.match(komutCalistir('/not oyun testler python -m unittest ile kosar', o.ctx).metin, /olgu yazildi \(oyun\)/);
    const h = hafizaKayitlari(o.db, { cwd: o.proje });
    assert.equal(h.length, 1);
    assert.equal(h[0].kaynak, 'insan');
    assert.equal(h[0].icerik, 'testler python -m unittest ile kosar');

    const kosu = kosuAc(o.db, is.id);
    kosuGuncelle(o.db, kosu.id, { durum: KOSU_DURUMU.CALISIYOR, basladi: Date.now() - 90_000 });
    kararAc(o.db, is.id);
    const d = komutCalistir('/durum', o.ctx).metin;
    assert.match(d, /Sürü: 1 calisiyor, 0 bekliyor \(sinir 3\)/);
    assert.match(d, / A · calisiyor 1 dk  \[/); // ajan adi isten: 'A'
    assert.match(d, /1 acik karar: \/kararlar/);
  } finally { o.temizle(); }
});

test('/cevap ile plan "Uygula": is denetimli profile gecer, devam kosusu ayni oturumda acilir, olay yazilir', async () => {
  const { isGetir } = await import('../src/isler.js');
  const { oku } = await import('../src/events.js');
  const o = ortam();
  try {
    const is = isEkle(o.db, { ad: 'Planla', gorev: 'g', cwd: o.proje, profil: 'danisan' });
    const kosu = kosuAc(o.db, is.id);
    kosuGuncelle(o.db, kosu.id, { durum: KOSU_DURUMU.KARAR_BEKLIYOR, sonuc: 'plan metni', redSayisi: 1, terminalNeden: 'completed' });
    kararlariTazele(o.db);
    const [k] = bekleyenKararlar(o.db);
    assert.match(komutCalistir('/kararlar', o.ctx).metin, /1\) Uygula \(denetimli profilde\)/);
    const r = komutCalistir('/cevap ' + kisa(k.id) + ' 1', o.ctx);
    assert.match(r.metin, /plan onaylandi, denetimli profilinde uygulaniyor: Planla/);
    assert.equal(isGetir(o.db, is.id).profil, 'denetimli');
    const kapali = kararGetir(o.db, k.id);
    const devam = kosuGetir(o.db, kapali.devamKosuId);
    assert.equal(devam.sessionId, kosu.sessionId, 'ayni oturum: ajan planini hatirlar');
    assert.match(devam.devamCevabi, /Simdi UYGULA/);
    assert.ok(oku(o.db, { sinceSeq: 0, limit: 100 }).some((e) => e.data?.asama === 'profil-degisti' && e.data.yeni === 'denetimli'));
    // Plan olmayan kararda 'uygula' yolu yok: hata karari ayni numarayla hazir cevabi alir
    const is2 = isEkle(o.db, { ad: 'B', gorev: 'g', cwd: o.proje, profil: 'serbest' });
    const k2 = kararAc(o.db, is2.id);
    komutCalistir('/cevap ' + kisa(k2.id) + ' 1', o.ctx);
    assert.equal(isGetir(o.db, is2.id).profil, 'serbest');
  } finally { o.temizle(); }
});

test('/sil: kosulari durdurur, acik kararlari kapatir, isi siler; belirsiz ad silmez', async () => {
  const { isListesi } = await import('../src/isler.js');
  const o = ortam();
  try {
    const is = isEkle(o.db, { ad: 'Silinecek', gorev: 'g', cwd: o.proje, profil: 'serbest' });
    isEkle(o.db, { ad: 'Silinmeyecek', gorev: 'g', cwd: o.proje, profil: 'serbest' });
    const karar = kararAc(o.db, is.id);
    assert.match(komutCalistir('/sil', o.ctx).metin, /kullanim/);
    assert.match(komutCalistir('/sil yok-boyle', o.ctx).metin, /^olmadi: /);
    const r = komutCalistir('/sil silinecek', o.ctx);
    assert.match(r.metin, /silindi: Silinecek · 1 kosu durduruldu · 1 karar kapatildi/);
    assert.equal(o.cagrilar.at(-1)[0], 'isDurdur');
    assert.equal(kararGetir(o.db, karar.id).durum, KARAR_DURUMU.IPTAL);
    assert.deepEqual(isListesi(o.db).map((i) => i.ad), ['Silinmeyecek']);
  } finally { o.temizle(); }
});
