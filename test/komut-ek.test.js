// Telegram/panel komutlarinin ikinci dalgasi: /akis /ozet /notlar /unut /rapor /sablonlar, sablonlu /yeni,
// onayli /sil ve /durdur, /yeni'de MCP mirasi.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { OLAY, yaz as olayYaz } from '../src/events.js';
import { isEkle, isGetir, isListesi, kosuAc, kosuGuncelle, KOSU_DURUMU } from '../src/isler.js';
import { kayitlar as hafizaKayitlari } from '../src/hafiza.js';
import { komutCalistir, kisa } from '../src/komut.js';
import { SABLON_ADLARI, sablondanIs } from '../src/sablon.js';

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-komut2-'));
  const db = openDb(join(dizin, 'k.db'));
  const proje = join(dizin, 'oyun'); mkdirSync(proje);
  const cagrilar = [];
  const kuyruk = {
    siraya: (isId) => { cagrilar.push(['siraya', isId]); return kosuAc(db, isId); },
    kosuDurdur: (id, neden) => { cagrilar.push(['durdur', id, neden]); kosuGuncelle(db, id, { durum: KOSU_DURUMU.IPTAL }); return { kosuId: id, durum: 'durduruluyor' }; },
    isKosulariniDurdur: (isId, neden) => { cagrilar.push(['isDurdur', isId, neden]); return ['x']; },
    pompala: () => cagrilar.push(['pompala']),
    durum: () => ({ esZamanli: 3, calisan: 1, bekleyen: 0 }),
  };
  return { db, dizin, proje, kuyruk, cagrilar, ctx: { db, kuyruk },
    temizle: () => { db.close(); try { rmSync(dizin, { recursive: true, force: true }); } catch { /* */ } } };
}

test('/akis: isin son kosusundan anlatilmis satirlar, sayi ile kirpma; hic kosmamis is acik hata', () => {
  const o = ortam();
  try {
    const is = isEkle(o.db, { ad: 'Onar', gorev: 'g', cwd: o.proje, profil: 'serbest' });
    assert.match(komutCalistir('/akis onar', o.ctx).metin, /hic kosmamis/);
    const k = kosuAc(o.db, is.id);
    kosuGuncelle(o.db, k.id, { durum: KOSU_DURUMU.CALISIYOR, usd: 0.05 });
    for (let i = 1; i <= 12; i++) {
      olayYaz(o.db, { kind: OLAY.ARAC, sessionId: k.sessionId, data: { kosuId: k.id, arac: 'Read', ozet: 'okuyor: d' + i + '.cs' } });
    }
    olayYaz(o.db, { kind: OLAY.MALIYET, sessionId: k.sessionId, data: { kosuId: k.id, girdi: 10, cikti: 1, usd: 0.001 } });
    const r = komutCalistir('/akis onar', o.ctx).metin;
    const satirlar = r.split(String.fromCharCode(10));
    assert.match(satirlar[0], /Onar · calisiyor · \$0\.05/);
    assert.equal(satirlar.length, 11, 'baslik + 10 satir');
    assert.match(satirlar[1], /^\d\d:\d\d okuyor: d3\.cs$/, 'en eski 2 satir disarida kalir');
    assert.match(satirlar[10], /okuyor: d12\.cs$/);
    assert.equal(komutCalistir('/akis onar 3', o.ctx).metin.split(String.fromCharCode(10)).length, 4);
    assert.match(komutCalistir('/akis', o.ctx).metin, /kullanim/);
  } finally { o.temizle(); }
});

test('/ozet: masalarin tek satirlik durumu + son satir', () => {
  const o = ortam();
  try {
    assert.match(komutCalistir('/ozet', o.ctx).metin, /masalar bos/);
    const is = isEkle(o.db, { ad: 'Onar', gorev: 'g', cwd: o.proje, profil: 'serbest' });
    const k = kosuAc(o.db, is.id);
    kosuGuncelle(o.db, k.id, { durum: KOSU_DURUMU.CALISIYOR, basladi: Date.now() - 120_000 });
    olayYaz(o.db, { kind: OLAY.ARAC, sessionId: k.sessionId, data: { kosuId: k.id, arac: 'Edit', ozet: 'duzenliyor: a.cs' } });
    const r = komutCalistir('/ozet', o.ctx).metin;
    assert.match(r, /Onar · calisiyor 2 dk · \$0\.00  \[/);
    assert.match(r, /\n   duzenliyor: a\.cs/);
  } finally { o.temizle(); }
});

test('/notlar ve /unut: insan olgusu konuyla silinir; belirsiz konu silmez', () => {
  const o = ortam();
  try {
    isEkle(o.db, { ad: 'A', gorev: 'g', cwd: o.proje, profil: 'serbest' });
    komutCalistir('/not oyun test komutu: npm test', o.ctx);
    komutCalistir('/not oyun test verisi: fixtures altinda', o.ctx);
    komutCalistir('/not oyun README Turkce yazilir', o.ctx);
    const n = komutCalistir('/notlar oyun', o.ctx).metin;
    assert.match(n, /- test komutu → test komutu: npm test/);
    assert.match(n, /- readme turkce yazilir → README Turkce yazilir/);
    // Belirsiz onek: iki kayit 'test' ile basliyor
    assert.match(komutCalistir('/unut oyun test', o.ctx).metin, /birden fazla kayitla/);
    assert.equal(hafizaKayitlari(o.db, { cwd: o.proje }).length, 3);
    assert.match(komutCalistir('/unut oyun test komutu', o.ctx).metin, /unutuldu \(oyun\): test komutu: npm test/);
    assert.match(komutCalistir('/unut oyun readme', o.ctx).metin, /unutuldu/);
    assert.equal(hafizaKayitlari(o.db, { cwd: o.proje }).length, 1);
    assert.match(komutCalistir('/unut oyun yok-boyle', o.ctx).metin, /boyle bir insan olgusu yok/);
    assert.match(komutCalistir('/unut oyun', o.ctx).metin, /kullanim/);
  } finally { o.temizle(); }
});

test('/rapor: proje x rol x model tablosu; az veri isaretlenir; veri yoksa soyler', () => {
  const o = ortam();
  try {
    assert.match(komutCalistir('/rapor', o.ctx).metin, /modeli olculmus kosu yok/);
    const is = isEkle(o.db, { ad: 'A', gorev: 'g', cwd: o.proje, profil: 'serbest' });
    for (const [model, durum, usd] of [['claude-haiku-4-5-20251001', 'bitti', 0.05], ['claude-haiku-4-5-20251001', 'hata', 0.03], ['claude-sonnet-5', 'bitti', 0.2]]) {
      const k = kosuAc(o.db, is.id); kosuGuncelle(o.db, k.id, { durum, usd, model });
    }
    const r = komutCalistir('/rapor 30', o.ctx).metin;
    assert.match(r, /oyun · yapici · haiku-4-5: 2 kosu, 1\/1\/0, \$0\.04 \(veri az\)/);
    assert.match(r, /oyun · yapici · sonnet-5: 1 kosu, 1\/0\/0, \$0\.20 \(veri az\)/);
  } finally { o.temizle(); }
});

test('sablonlar: /sablonlar listeler; /yeni proje #inceleme sablondan gozlemci is acar; #hata ek ister; ek gorevin sonuna eklenir', () => {
  const o = ortam();
  try {
    assert.ok(SABLON_ADLARI.includes('inceleme') && SABLON_ADLARI.includes('test') && SABLON_ADLARI.includes('readme'));
    assert.match(komutCalistir('/sablonlar', o.ctx).metin, /#inceleme/);
    isEkle(o.db, { ad: 'eski', gorev: 'g', cwd: o.proje, profil: 'serbest', dogrulama: 'npm test', mcp: ['unity-mcp'], mcpMod: 'tam' });
    const r = komutCalistir('/yeni oyun #inceleme', o.ctx).metin;
    assert.match(r, /is acildi ve kuyruga alindi: kod-incelemesi · oyun · gozlemci · #inceleme/);
    const yeni = isListesi(o.db).find((i) => i.ad === 'kod-incelemesi');
    assert.equal(yeni.profil, 'gozlemci');
    assert.match(yeni.gorev, /Hicbir dosyayi degistirme/);
    assert.equal(yeni.dogrulama, 'npm test', 'dogrulama son isten miras');
    assert.deepEqual(yeni.mcp, ['unity-mcp'], 'MCP secimi de miras');
    assert.equal(yeni.mcpMod, 'tam');
    // readme sablonu kapsamli
    komutCalistir('/yeni oyun #readme | kurulum bolumune Node 24 yaz', o.ctx);
    const rd = isListesi(o.db).find((i) => i.ad === 'readme-guncelle');
    assert.deepEqual(rd.kapsam, ['README.md']);
    assert.match(rd.gorev, /Ek: kurulum bolumune Node 24 yaz$/);
    // hata sablonu ek metin ister
    assert.match(komutCalistir('/yeni oyun #hata', o.ctx).metin, /olmadi: #hata sablonu ek metin ister/);
    assert.match(sablondanIs('#hata', { ek: 'giris ekrani donuyor' }).gorev, /Su hatayi ele al: giris ekrani donuyor\./);
    assert.match(komutCalistir('/yeni oyun #yok', o.ctx).metin, /bilinmeyen sablon/);
    // Duz bicim hala calisir ve MCP'yi miras alir
    komutCalistir('/yeni oyun | duz gorev', o.ctx);
    assert.deepEqual(isListesi(o.db).find((i) => i.ad === 'duz gorev').mcp, ['unity-mcp']);
  } finally { o.temizle(); }
});

test('onayIste: /sil ve /durdur once dugme doner, "!" ile onaylaninca calisir; panelde (onaysiz) dogrudan calisir', () => {
  const o = ortam();
  try {
    const is = isEkle(o.db, { ad: 'Silinecek', gorev: 'g', cwd: o.proje, profil: 'serbest' });
    const k = kosuAc(o.db, is.id); kosuGuncelle(o.db, k.id, { durum: KOSU_DURUMU.CALISIYOR });
    const tg = { ...o.ctx, onayIste: true };
    const r = komutCalistir('/sil silinecek', tg);
    assert.match(r.metin, /silinsin mi: Silinecek/);
    assert.equal(r.dugmeler.length, 1);
    assert.equal(r.dugmeler[0].secenekler[0].veri, 'o:/sil ' + kisa(is.id));
    assert.equal(r.dugmeler[0].secenekler[1].veri, 'o:vazgec');
    assert.ok(isGetir(o.db, is.id), 'onaysiz silinmedi');
    const d = komutCalistir('/durdur ' + kisa(k.id), tg);
    assert.match(d.metin, /durdurulsun mu: kosu/);
    assert.ok(!o.cagrilar.some((c) => c[0] === 'durdur'));
    // Onayli
    assert.match(komutCalistir('/durdur ' + kisa(k.id) + ' !', tg).metin, /durduruldu: /);
    assert.equal(o.cagrilar.at(-1)[0], 'durdur');
    assert.match(komutCalistir('/sil ' + kisa(is.id) + ' !', tg).metin, /silindi: Silinecek/);
    assert.ok(!isGetir(o.db, is.id));
    // Panel: onay istemez
    const is2 = isEkle(o.db, { ad: 'Hemen', gorev: 'g', cwd: o.proje, profil: 'serbest' });
    assert.match(komutCalistir('/sil hemen', o.ctx).metin, /silindi: Hemen/);
    // '!' baska komutta zararsiz
    assert.match(komutCalistir('/durum !', o.ctx).metin, /Sürü:/);
    assert.equal(is2.ad, 'Hemen');
  } finally { o.temizle(); }
});
