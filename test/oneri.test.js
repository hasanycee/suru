import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { OLAY, yaz as olayYaz, oku as olayOku } from '../src/events.js';
import { isEkle, isListesi, kosuAc, kosuGuncelle, kosuGetir, KOSU_DURUMU } from '../src/isler.js';
import { sonrakiAdim, oneriUret, oneriler, oneriKapat, baglamDevami, oneriMetni, oneriDugmeleri } from '../src/oneri.js';
import { komutCalistir } from '../src/komut.js';
import { kosuBaslat, BAGLAM_TALIMATI } from '../src/kosucu.js';
import { maliyetTahmini } from '../src/karne.js';

const TAKLIT = join(dirname(fileURLToPath(import.meta.url)), 'sahte', 'claude-taklit.mjs');

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-oneri-'));
  const db = openDb(join(dizin, 'k.db'));
  const proje = join(dizin, 'oyun'); mkdirSync(proje);
  const cagrilar = [];
  const kuyruk = { siraya: (isId, ek) => { cagrilar.push(['siraya', isId, ek]); return kosuAc(db, isId, ek); }, pompala: () => {},
    durum: () => ({ esZamanli: 2, calisan: 0, bekleyen: 0 }), kosuDurdur: () => ({}), isKosulariniDurdur: () => [] };
  return { db, dizin, proje, kuyruk, cagrilar, ctx: { db, kuyruk },
    temizle: () => { db.close(); try { rmSync(dizin, { recursive: true, force: true }); } catch { /* */ } } };
}

test('sonrakiAdim: rapor sonundaki satiri cikarir; yoksa/kisaysa null; son eslesme kazanir', () => {
  assert.equal(sonrakiAdim('Is bitti.\nSonraki adim: README kurulum bolumunu Node 24 icin guncelle'), 'README kurulum bolumunu Node 24 icin guncelle');
  assert.equal(sonrakiAdim('- **Sonraki adım:** testleri CI\'a bagla\n'), 'testleri CI\'a bagla');
  assert.equal(sonrakiAdim('Sonraki adim: a\nSonraki adim: ikinci ve daha uzun oneri'), 'ikinci ve daha uzun oneri');
  assert.equal(sonrakiAdim('hic oneri yok'), null);
  assert.equal(sonrakiAdim('Sonraki adim: kisa'), null);
  assert.equal(sonrakiAdim(null), null);
});

test('oneriUret: BITTI kullanici kosusundan bir kez uretir, kv\'ye yazar, olay yazar; kota kisitliyken uretmez; /oneri-ac is acar, /oneri-gec kapatir', () => {
  const o = ortam();
  try {
    const is = isEkle(o.db, { ad: 'Onar', gorev: 'g', cwd: o.proje, profil: 'denetimli', model: 'haiku', mcp: ['unity-mcp'] });
    const k = kosuAc(o.db, is.id);
    kosuGuncelle(o.db, k.id, { durum: KOSU_DURUMU.BITTI, sonuc: 'yaptim.\nSonraki adim: SpectatorCamera icin birim testi yaz' });
    assert.equal(oneriUret(o.db, { kosuId: k.id, kotaKisitli: true }), null, 'kota kisitli: oneri yok');
    assert.equal(oneriler(o.db).length, 0);
    const on = oneriUret(o.db, { kosuId: k.id });
    assert.equal(on.metin, 'SpectatorCamera icin birim testi yaz');
    assert.equal(oneriUret(o.db, { kosuId: k.id }), null, 'ayni kosudan ikinci kez uretilmez');
    assert.ok(olayOku(o.db, { sinceSeq: 0 }).some((e) => e.data?.asama === 'oneri' && e.data.oneriId === on.id));
    assert.match(oneriMetni(on), /ajan sonraki adim oneriyor/);
    assert.equal(oneriDugmeleri(on)[0].secenekler[0].veri, 'o:/oneri-ac ' + on.id);
    // hata kosusu ve ic is: oneri yok
    const h = kosuAc(o.db, is.id); kosuGuncelle(o.db, h.id, { durum: KOSU_DURUMU.HATA, sonuc: 'Sonraki adim: bir seyler yap simdi' });
    assert.equal(oneriUret(o.db, { kosuId: h.id }), null);
    // komutlar
    assert.match(komutCalistir('/oneriler', o.ctx).metin, new RegExp('\\[' + on.id + '\\] Onar → SpectatorCamera'));
    const ac = komutCalistir('/oneri-ac ' + on.id, o.ctx).metin;
    assert.match(ac, /oneri is oldu ve kuyruga alindi: SpectatorCamera icin birim testi yaz · oyun/);
    const yeni = isListesi(o.db).find((i) => i.ad.startsWith('SpectatorCamera'));
    assert.equal(yeni.profil, 'denetimli'); assert.equal(yeni.model, 'haiku'); assert.deepEqual(yeni.mcp, ['unity-mcp']);
    assert.match(yeni.gorev, /Onceki isten oneri: "Onar"/);
    assert.equal(oneriler(o.db)[0].durum, 'acildi');
    assert.match(komutCalistir('/oneri-ac ' + on.id, o.ctx).metin, /zaten kapali/);
    assert.match(komutCalistir('/oneriler', o.ctx).metin, /acik oneri yok/);
    const k2 = kosuAc(o.db, is.id); kosuGuncelle(o.db, k2.id, { durum: KOSU_DURUMU.BITTI, sonuc: 'Sonraki adim: baska bir sey daha dene' });
    const on2 = oneriUret(o.db, { kosuId: k2.id });
    assert.match(komutCalistir('/oneri-gec ' + on2.id, o.ctx).metin, /gecildi/);
    assert.equal(oneriKapat(o.db, on2.id, 'gecildi').durum, 'gecildi');
    assert.match(komutCalistir('/oneri-ac yok', o.ctx).metin, /oneri bulunamadi/);
  } finally { o.temizle(); }
});

test('baglamDevami: esik olayi olan ve ozetle biten kosu icin ayni ise YENI oturum (ekTalimat = ozet); zincir 5 parcada durur; esik olayi yoksa hic', () => {
  const o = ortam();
  try {
    const is = isEkle(o.db, { ad: 'Uzun', gorev: 'g', cwd: o.proje, profil: 'serbest' });
    const k = kosuAc(o.db, is.id);
    kosuGuncelle(o.db, k.id, { durum: KOSU_DURUMU.BITTI, sonuc: 'OZET: 3 dosya degisti, kalan: testler' });
    assert.equal(baglamDevami(o.db, o.kuyruk, { kosuId: k.id }), null, 'esik olayi yok');
    olayYaz(o.db, { kind: OLAY.IS, sessionId: k.sessionId, data: { asama: 'baglam-esigi', kosuId: k.id, isId: is.id, girdi: 160000, esik: 150000 } });
    const y = baglamDevami(o.db, o.kuyruk, { kosuId: k.id });
    assert.ok(y);
    assert.notEqual(y.sessionId, k.sessionId, 'yeni oturum: baglam sifirlanir');
    assert.equal(y.devamCevabi, null, '--resume degil');
    assert.match(kosuGetir(o.db, y.id).ekTalimat, /Onceki kosu ozeti \(parca 1\)[\s\S]*OZET: 3 dosya degisti/);
    assert.ok(olayOku(o.db, { sinceSeq: 0 }).some((e) => e.data?.asama === 'baglam-devam' && e.data.parca === 1));
    // parca 5'ten sonra durur
    const p5 = kosuAc(o.db, is.id, { ekTalimat: 'Onceki kosu ozeti (parca 5): x' });
    kosuGuncelle(o.db, p5.id, { durum: KOSU_DURUMU.BITTI, sonuc: 'ozet' });
    olayYaz(o.db, { kind: OLAY.IS, sessionId: p5.sessionId, data: { asama: 'baglam-esigi', kosuId: p5.id, isId: is.id } });
    assert.equal(baglamDevami(o.db, o.kuyruk, { kosuId: p5.id }), null);
    assert.ok(olayOku(o.db, { kind: OLAY.HATA }).some((e) => /5 parcayi asti/.test(e.data?.mesaj)));
  } finally { o.temizle(); }
});

test('kosucu: girdi token esigi asilinca stdin\'e BAGLAM talimati bir kez gider ve olay yazilir (taklit stdin-yanki)', async () => {
  const o = ortam();
  try {
    const is = isEkle(o.db, { ad: 'Uzun', gorev: 'ilk gorev', cwd: o.proje, profil: 'serbest' });
    const kosu = kosuAc(o.db, is.id);
    // stdin-yanki: her stdin mesajina 'ALDIM#n' der, ikinci mesajdan sonra result verir. usage input 10 -> esik 5.
    const r = await kosuBaslat(o.db, { is, kosu, komut: process.execPath, zamanAsimiMs: 30_000, canliTalimat: true,
      spawnFn: (k, a, opt) => spawn(k, [TAKLIT, ...a], { ...opt, shell: false }),
      env: { ...process.env, SAHTE_SENARYO: 'stdin-yanki' }, hafizaAyari: { etkin: false }, baglamAyari: { esikToken: 5 } });
    assert.equal(r.durum, KOSU_DURUMU.BITTI);
    assert.equal(r.baglamEsigiGecildi, true);
    assert.match(kosuGetir(o.db, kosu.id).sonuc, new RegExp('ilk gorev \\| ' + BAGLAM_TALIMATI.slice(0, 20)));
    const olaylar = olayOku(o.db, { sinceSeq: 0 }).filter((e) => e.data?.asama === 'baglam-esigi');
    assert.equal(olaylar.length, 1);
    assert.equal(olaylar[0].data.esik, 5);
    // esik kapaliyken (0) hic gitmez: taklit ikinci mesaji beklerdi, o yuzden esigi yuksek tutup kontrol ediyoruz
    const kosu2 = kosuAc(o.db, is.id);
    const r2 = await kosuBaslat(o.db, { is, kosu: kosu2, komut: process.execPath, zamanAsimiMs: 30_000, canliTalimat: true,
      spawnFn: (k, a, opt) => spawn(k, [TAKLIT, ...a], { ...opt, shell: false }),
      env: { ...process.env, SAHTE_SENARYO: 'basarili' }, hafizaAyari: { etkin: false }, baglamAyari: { esikToken: 0 } });
    assert.equal(r2.baglamEsigiGecildi, false);
    // oneri talimati sistem istemine girer (oneriAyari.etkin)
    const argDosyasi = join(o.dizin, 'a.json');
    const kosu3 = kosuAc(o.db, is.id);
    await kosuBaslat(o.db, { is, kosu: kosu3, komut: process.execPath, zamanAsimiMs: 30_000,
      spawnFn: (k, a, opt) => spawn(k, [TAKLIT, ...a], { ...opt, shell: false }),
      env: { ...process.env, SAHTE_SENARYO: 'basarili', SAHTE_ARG_DOSYASI: argDosyasi }, hafizaAyari: { etkin: false }, oneriAyari: { etkin: true } });
    const args = JSON.parse(readFileSync(argDosyasi, 'utf8'));
    assert.match(args[args.indexOf('--append-system-prompt') + 1], /Sonraki adim:/);
  } finally { o.temizle(); }
});

test('maliyetTahmini: projenin kosularindan ceyreklikler; 5 altinda "veri az"; projesiz/verisiz aciklar', () => {
  const o = ortam();
  try {
    assert.equal(maliyetTahmini(o.db, {}).tahmin, null);
    const is = isEkle(o.db, { ad: 'A', gorev: 'g', cwd: o.proje, profil: 'serbest' });
    assert.match(maliyetTahmini(o.db, { cwd: o.proje }).neden, /olculmus kosu yok/);
    for (const usd of [0.1, 0.2, 0.3]) { const k = kosuAc(o.db, is.id); kosuGuncelle(o.db, k.id, { durum: KOSU_DURUMU.BITTI, usd }); }
    let t = maliyetTahmini(o.db, { cwd: o.proje });
    assert.equal(t.kosu, 3); assert.equal(t.veriAz, true); assert.equal(t.tahmin.orta, 0.2);
    for (const usd of [0.4, 0.5, 0.6]) { const k = kosuAc(o.db, is.id); kosuGuncelle(o.db, k.id, { durum: KOSU_DURUMU.HATA, usd }); }
    t = maliyetTahmini(o.db, { cwd: o.proje, profil: 'serbest' });
    assert.equal(t.kosu, 6); assert.equal(t.veriAz, false); assert.equal(t.tahmin.enCok, 0.6);
    assert.equal(maliyetTahmini(o.db, { cwd: o.proje, profil: 'gozlemci' }).kosu, 0);
    // ic isler sayilmaz
    const ic = isEkle(o.db, { ad: '_damitma:x', gorev: 'g', cwd: o.proje, profil: 'gozlemci', ic: true });
    const ik = kosuAc(o.db, ic.id); kosuGuncelle(o.db, ik.id, { durum: KOSU_DURUMU.BITTI, usd: 9 });
    assert.equal(maliyetTahmini(o.db, { cwd: o.proje }).tahmin.enCok, 0.6);
  } finally { o.temizle(); }
});
