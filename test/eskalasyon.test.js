import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { openDb } from '../src/db.js';
import { OLAY, oku as olayOku } from '../src/events.js';
import { isEkle, kosuAc, kosuGuncelle, kosuGetir, KOSU_DURUMU } from '../src/isler.js';
import { kosuBaslat } from '../src/kosucu.js';
import { Kuyruk } from '../src/kuyruk.js';
import { devamArgumanlari } from '../src/yetki.js';
import { kisilik } from '../src/kisilik.js';
import {
  kararlariTazele, bekleyenKararlar, kararGetir, cevapla, iptalEt,
  kararTanimla, kararKarti, KARAR_DURUMU, KARAR_TURU, HAZIR_CEVAPLAR,
} from '../src/eskalasyon.js';

const TAKLIT = join(dirname(fileURLToPath(import.meta.url)), 'sahte', 'claude-taklit.mjs');

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-esk-'));
  const db = openDb(join(dizin, 'e.db'));
  return { db, dizin, temizle: () => {
    db.close();
    try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra silinir */ }
  } };
}

/** karar-bekliyor durumunda bir kosu hazirlar. */
function karardaKosu(o, alanlar = {}, profil = 'denetimli') {
  const is = isEkle(o.db, { ad: 'is', gorev: 'g', cwd: o.dizin, profil });
  const kosu = kosuAc(o.db, is.id);
  kosuGuncelle(o.db, kosu.id, { durum: KOSU_DURUMU.KARAR_BEKLIYOR, bitti: Date.now(), ...alanlar });
  return { is, kosu };
}

// --- Karar turu tanimlama ---

test('izin reddi izin karari, hata hata karari, digeri plan karari dogurur', () => {
  const izin = kararTanimla({ sessionId: 's1', redSayisi: 2, hata: null }, { ad: 'x' });
  assert.equal(izin.tur, KARAR_TURU.IZIN);
  assert.match(izin.soru, /sinira dayandi/);

  const hata = kararTanimla({ sessionId: 's1', redSayisi: 0, hata: 'patladi' }, { ad: 'x' });
  assert.equal(hata.tur, KARAR_TURU.HATA);
  assert.equal(hata.ayrinti, 'patladi');

  const plan = kararTanimla({ sessionId: 's1', redSayisi: 0, hata: null, sonuc: 'su plani yapayim' }, { ad: 'x' });
  assert.equal(plan.tur, KARAR_TURU.PLAN);
  assert.equal(plan.ayrinti, 'su plani yapayim');
});

test('soru ajan kimligini tekrarlamaz, ham oturum kimligi hic gecmez', () => {
  const k = kararTanimla({ sessionId: 'a3f9b2c1-1111-2222-3333-444455556666', redSayisi: 1 }, { ad: 'x' });
  assert.ok(!k.soru.includes('a3f9b2c1'), 'ham oturum kimligi kullaniciya gosterilmez');
  // Kimligi kart zaten basliginda gosteriyor; soruda tekrarlamak gurultu.
  const kimlik = kisilik('a3f9b2c1-1111-2222-3333-444455556666');
  assert.ok(!k.soru.includes(kimlik.ad), 'ajan adi soruda tekrarlanmamali');
});

// --- Tazeleme ---

test('karar-bekliyor kosu icin karar acilir ve akisa yazilir', () => {
  const o = ortam();
  const { kosu } = karardaKosu(o, { redSayisi: 1 });

  const yeni = kararlariTazele(o.db);
  assert.equal(yeni.length, 1);
  assert.equal(yeni[0].tur, KARAR_TURU.IZIN);
  assert.equal(yeni[0].kosuId, kosu.id);
  assert.equal(yeni[0].sessionId, kosu.sessionId, 'karar oturuma bagli kalmali');

  const olay = olayOku(o.db, { kind: OLAY.KARAR });
  assert.equal(olay.length, 1);
  assert.equal(olay[0].data.asama, 'acildi');
  o.temizle();
});

test('tazeleme idempotent: ikinci tarama ayni karari tekrar acmaz', () => {
  const o = ortam();
  karardaKosu(o, { redSayisi: 1 });
  assert.equal(kararlariTazele(o.db).length, 1);
  assert.equal(kararlariTazele(o.db).length, 0, 'sunucu yeniden baslasa da kopya karar olmaz');
  assert.equal(bekleyenKararlar(o.db).length, 1);
  o.temizle();
});

test('bitmis kosular karar dogurmaz', () => {
  const o = ortam();
  const is = isEkle(o.db, { ad: 'i', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
  const k = kosuAc(o.db, is.id);
  kosuGuncelle(o.db, k.id, { durum: KOSU_DURUMU.BITTI });
  assert.equal(kararlariTazele(o.db).length, 0);
  o.temizle();
});

// --- Cevaplama ---

test('cevap devam kosusunu ayni oturumda acar', () => {
  const o = ortam();
  const { kosu } = karardaKosu(o, { redSayisi: 1 });
  const [karar] = kararlariTazele(o.db);

  const { karar: sonrasi, devamKosu } = cevapla(o.db, karar.id, 'Devam et, o adimi atla.');

  assert.equal(sonrasi.durum, KARAR_DURUMU.CEVAPLANDI);
  assert.equal(sonrasi.cevap, 'Devam et, o adimi atla.');
  assert.equal(devamKosu.sessionId, kosu.sessionId,
    'devam kosusu ayni oturumu tasimali - ajan baglami korusun');
  assert.notEqual(devamKosu.id, kosu.id, 'yeni bir kosu kaydi olmali');
  assert.equal(devamKosu.durum, KOSU_DURUMU.BEKLIYOR, 'kuyruk alsin diye bekliyor durumunda acilir');
  assert.equal(kosuGetir(o.db, kosu.id).durum, KOSU_DURUMU.BITTI, 'eski kosu kapanir');
  assert.equal(bekleyenKararlar(o.db).length, 0);
  o.temizle();
});

test('ayni karar iki kez cevaplanamaz', () => {
  const o = ortam();
  karardaKosu(o, { redSayisi: 1 });
  const [karar] = kararlariTazele(o.db);
  cevapla(o.db, karar.id, 'devam');
  assert.throws(() => cevapla(o.db, karar.id, 'yine devam'), /zaten kapali/);
  o.temizle();
});

test('bos cevap ve olmayan karar reddedilir', () => {
  const o = ortam();
  karardaKosu(o, { redSayisi: 1 });
  const [karar] = kararlariTazele(o.db);
  assert.throws(() => cevapla(o.db, karar.id, '   '), /cevap bos/);
  assert.throws(() => cevapla(o.db, 'yok-boyle', 'x'), /bulunamadi/);
  o.temizle();
});

test('iptal kosuyu kapatir, devam kosusu acmaz', () => {
  const o = ortam();
  const { kosu } = karardaKosu(o, { redSayisi: 1 });
  const [karar] = kararlariTazele(o.db);

  iptalEt(o.db, karar.id);
  assert.equal(kararGetir(o.db, karar.id).durum, KARAR_DURUMU.IPTAL);
  assert.equal(kosuGetir(o.db, kosu.id).durum, KOSU_DURUMU.IPTAL);
  assert.equal(o.db.prepare('SELECT COUNT(*) c FROM kosular').get().c, 1, 'yeni kosu acilmamali');
  o.temizle();
});

// --- Panel karti ---

test('karar karti ajan kimligi ve hazir cevaplar tasir', () => {
  const o = ortam();
  karardaKosu(o, { redSayisi: 1 });
  const [karar] = kararlariTazele(o.db);
  const kart = kararKarti(o.db, karar);

  assert.ok(kart.ajan.ad.length > 1);
  assert.ok(kart.ajan.simge);
  assert.equal(kart.is.profil, 'denetimli');
  assert.deepEqual(kart.secenekler, HAZIR_CEVAPLAR[KARAR_TURU.IZIN]);
  assert.ok(kart.secenekler.some((s) => s.etiket === 'Devam et'));
  o.temizle();
});

// --- Devam argumanlari ---

test('devam argumanlari --resume kullanir, --session-id vermez', () => {
  const args = devamArgumanlari({ cevap: 'devam et', profil: 'serbest', sessionId: 'oturum-1' });
  assert.equal(args[args.indexOf('--resume') + 1], 'oturum-1');
  assert.ok(!args.includes('--session-id'), '--resume ile --session-id birlikte verilmez');
  assert.equal(args[args.indexOf('-p') + 1], 'devam et');
  assert.throws(() => devamArgumanlari({ cevap: '', profil: 'serbest', sessionId: 'x' }), /cevap bos/);
  assert.throws(() => devamArgumanlari({ cevap: 'x', profil: 'serbest' }), /sessionId zorunlu/);
});

test('devam kosusu gercekten --resume ile baslar', async () => {
  const o = ortam();
  const argDosyasi = join(o.dizin, 'devam-args.json');
  const { is } = karardaKosu(o, { redSayisi: 1 }, 'serbest');
  const [karar] = kararlariTazele(o.db);
  const { devamKosu } = cevapla(o.db, karar.id, 'Devam et, o adimi atla.');

  await kosuBaslat(o.db, {
    is, kosu: devamKosu, komut: process.execPath,
    devamCevabi: karar.cevap ?? 'Devam et, o adimi atla.',
    spawnFn: (k, a, opt) => spawn(k, [TAKLIT, ...a], { ...opt, shell: false }),
    env: { ...process.env, SAHTE_SENARYO: 'basarili', SAHTE_ARG_DOSYASI: argDosyasi },
  });

  const { readFileSync } = await import('node:fs');
  const args = JSON.parse(readFileSync(argDosyasi, 'utf8'));
  assert.equal(args[args.indexOf('--resume') + 1], devamKosu.sessionId);
  assert.ok(!args.includes('--session-id'));
  assert.equal(kosuGetir(o.db, devamKosu.id).durum, KOSU_DURUMU.BITTI);
  o.temizle();
});

test('devam cevabi kosu kaydinda tasinir', () => {
  const o = ortam();
  karardaKosu(o, { redSayisi: 1 });
  const [karar] = kararlariTazele(o.db);
  const { devamKosu } = cevapla(o.db, karar.id, 'Devam et.');
  // Cevap kayitta durmazsa kuyruk bu kosuyu sifirdan baslatir.
  assert.equal(kosuGetir(o.db, devamKosu.id).devamCevabi, 'Devam et.');
  o.temizle();
});

test('KUYRUKTAN gecen devam kosusu --resume kullanir, --session-id kullanmaz', async () => {
  // Regresyon: kuyruk devam kosusunu siradan kosu sanip --session-id ile
  // baslatiyordu; o kimlik zaten var oldugu icin CLI
  // "Session ID ... is already in use" deyip aninda cikiyordu.
  const o = ortam();
  const argDosyasi = join(o.dizin, 'kuyruk-devam-args.json');
  karardaKosu(o, { redSayisi: 1 }, 'serbest');
  const [karar] = kararlariTazele(o.db);
  const { devamKosu } = cevapla(o.db, karar.id, 'Devam et, o adimi atla.');

  const kuyruk = new Kuyruk(o.db, {
    esZamanli: 1,
    kosucuSecenekleri: {
      komut: process.execPath,
      spawnFn: (k, a, opt) => spawn(k, [TAKLIT, ...a], { ...opt, shell: false }),
      env: { ...process.env, SAHTE_SENARYO: 'basarili', SAHTE_ARG_DOSYASI: argDosyasi },
    },
  });
  kuyruk.pompala();
  await kuyruk.bekle();

  const { readFileSync } = await import('node:fs');
  const args = JSON.parse(readFileSync(argDosyasi, 'utf8'));
  assert.ok(args.includes('--resume'), 'kuyruk devam kosusunu --resume ile baslatmali');
  assert.equal(args[args.indexOf('--resume') + 1], devamKosu.sessionId);
  assert.ok(!args.includes('--session-id'), 'var olan oturum kimligi --session-id ile verilemez');
  assert.equal(args[args.indexOf('-p') + 1], 'Devam et, o adimi atla.', 'cevap istem olarak gecmeli');
  o.temizle();
});

test('butce biten kosu "takildi" degil BUTCE karari acar; hazir cevap kesfi tekrarlatmaz', () => {
  const t = kararTanimla({ terminalNeden: 'budget_exhausted', usd: 0.189, hata: 'kosu basarisiz', durum: KOSU_DURUMU.KARAR_BEKLIYOR, redSayisi: 0 },
    { ad: 'plan', butceUsd: 0.15 });
  assert.equal(t.tur, KARAR_TURU.BUTCE);
  assert.match(t.soru, /Butce bitti: \$0\.19 harcadi \(sinir \$0\.15\)/);
  assert.equal(HAZIR_CEVAPLAR[KARAR_TURU.BUTCE].length, 2);
  assert.match(HAZIR_CEVAPLAR[KARAR_TURU.BUTCE][0].cevap, /bastan kesif yapma/);
  // Dogrulama ve denetim oncelikleri degismedi
  assert.equal(kararTanimla({ terminalNeden: 'budget_exhausted', dogrulamaKod: 1 }, {}).tur, KARAR_TURU.DOGRULAMA);
});

test('plan profilinde izin reddi PLAN kararidir; "Uygula" isi denetimli profile gecirip ayni oturumdan devam eder', () => {
  const o = ortam();
  try {
    // Temiz biten plan kosusu + 1 izin reddi (ajan plani dosyaya yazmayi denedi)
    const temiz = { redSayisi: 1, hata: null, terminalNeden: 'completed', sonuc: 'plan...' };
    assert.equal(kararTanimla(temiz, { profil: 'danisan' }).tur, KARAR_TURU.PLAN);
    // Ayni kosu uygulayan profilde hala bir sinirdir
    assert.equal(kararTanimla(temiz, { profil: 'denetimli' }).tur, KARAR_TURU.IZIN);
    // Plan profilinde hatali biten kosu plan sayilmaz
    assert.equal(kararTanimla({ ...temiz, hata: 'x' }, { profil: 'danisan' }).tur, KARAR_TURU.IZIN);

    const is = isEkle(o.db, { ad: 'planla', gorev: 'g', cwd: o.dizin, profil: 'danisan' });
    const kosu = kosuAc(o.db, is.id);
    kosuGuncelle(o.db, kosu.id, { durum: KOSU_DURUMU.KARAR_BEKLIYOR, redSayisi: 1, sonuc: 'plan', terminalNeden: 'completed' });
    const [karar] = kararlariTazele(o.db);
    assert.equal(karar.tur, KARAR_TURU.PLAN);
    assert.equal(kararKarti(o.db, karar).secenekler[0].eylem, 'uygula');
  } finally { o.temizle(); }
});
