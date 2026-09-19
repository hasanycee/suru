import { createServer } from 'node:http';
import { readFileSync, writeFileSync, watch, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { listTranscripts } from './indexer.js';
import { oturumDurumu, olaylariYukle } from './state.js';
import { raporVerisi } from './api.js';
import { openDb } from './db.js';
import { GecisTakipcisi, oku as olayOku, kirp as olayKirp, sonSeq } from './events.js';
import { PROJECTS_DIR, DB_PATH, JETON_YOLU, VERI_DIZINI, veriDizini } from './paths.js';
import { ayarlariOku, AYAR_YOLU } from './config.js';
import { kanalKur, kararlarTelegramaDa } from './kanallar.js';
import { Bildirimci } from './bildirim.js';
import { kadroCikar, kimlikCoz } from './kisilik.js';
import { Kuyruk } from './kuyruk.js';
import { isEkle, isListesi, isSil, kosular, hayaletleriKapat, isGetir, yetimIcIsleriSil } from './isler.js';
import { kararlariTazele, bekleyenKararlar, kararKarti, cevapla, iptalEt, kabulEt, kapsamGenislet, planUygula } from './eskalasyon.js';
import { profilOzeti } from './yetki.js';
import { degerlendir as kotaDegerlendir } from './kota.js';
import { isKarnesi, tumKarneler, modelOnerisi, isModelOnerisi, projeModelRaporu, maliyetTahmini } from './karne.js';
import { ozet as raporOzet, geceAraligi } from './gece-raporu.js';
import { kayitlar as hafizaKayitlari, insanOlgusu, kayitSil as hafizaSil, damitmaIsiMi, budama as hafizaBudama } from './hafiza.js';
import { damitmaGerekiyorMu, damitmaIsiHazirla } from './damitma.js';
import { olc as baglamOlc } from './baglam.js';
import { kanitZinciri } from './kanit.js';
import { kosuGetir, acikKosular, kosuGuncelle } from './isler.js';
import { geriAlPlani, geriAl, budama, ortusenKosular } from './golge.js';
import { donguIlerlet, donguDurumu, denetciIsiMi, gorevKapsamCelismesi } from './dongu.js';
import { projeGizliligi, projeGizliliginiYaz } from './gizlilik.js';
import { ozet as veriAkisiOzeti, defterKirp } from './veriakisi.js';
import { tetikle as zamanlamaTetikle, sonrakiZaman } from './zamanlama.js';
import { tetikle as gitTetikle } from './gittetik.js';
import { OLAY, yaz as olayYaz } from './events.js';
import { Telegram } from './telegram.js';
import { komutCalistir } from './komut.js';
import { goruntu as komutaGoruntu, akis as komutaAkis } from './komuta.js';
import { bittiMesaji } from './bitti-bildirimi.js';
import { sunucuListesi as mcpSunucuListesi } from './mcp.js';
import { SABLONLAR, sablondanIs } from './sablon.js';
import { oneriUret, oneriMetni, oneriDugmeleri, oneriler, baglamDevami } from './oneri.js';

const KOK = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SURU_PORT ?? process.env.KULE_PORT ?? 7777);
const PENCERE = Number(process.env.SURU_PENCERE_SAAT ?? process.env.KULE_PENCERE_SAAT ?? 24) * 3600_000;
const NL = String.fromCharCode(10);

veriDizini();

// --- Jeton: panel oturum basliklarini ve son mesajlari gosteriyor, aciga cikmasin ---
function jetonAl() {
  try { return readFileSync(JETON_YOLU, 'utf8').trim(); } catch { /* yok, uret */ }
  const t = randomBytes(9).toString('base64url');
  writeFileSync(JETON_YOLU, t, 'utf8');
  return t;
}
const JETON = jetonAl();
const KEREZ = 'suru';

function jetonGecerli(verilen) {
  if (typeof verilen !== 'string') return false;
  const a = Buffer.from(verilen), b = Buffer.from(JETON);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Cerezleri ayristirir. Jeton adres satirindan cereze tasindi: query string
 * referrer'a, vekil sunucu loglarina ve tarayici gecmisine dusuyordu.
 */
function kerezOku(basliksatiri) {
  const h = new Map();
  for (const p of (basliksatiri || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0) h.set(p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim()));
  }
  return h;
}

// --- Olay akisi ---
const db = openDb(DB_PATH);
const takipci = new GecisTakipcisi(db);

// --- Bildirim ---
const AYARLAR = ayarlariOku();
// --- Telegram komut kanali (token varsa) ---
// Komut kapatmasi kuyrugu ISIM olarak tutar: kuyruk asagida kurulur, komutlar ancak
// sunucu ayaga kalktiktan sonra gelir.
let telegram = null;
if (AYARLAR.telegram?.token) {
  try {
    telegram = new Telegram(db, { token: AYARLAR.telegram.token, api: AYARLAR.telegram.api,
      // Telefondan gelen /sil ve /durdur ikinci onay ister (telegram.onayIste); panel istemez.
      komut: (metin, ek = {}) => komutCalistir(metin, { db, kuyruk,
        onayIste: ek.kanal === 'telegram' && AYARLAR.telegram.onayIste !== false }),
      log: (m) => console.log(m) });
  } catch (e) { console.error('telegram kurulamadi: ' + e.message); }
}
const bildirimci = new Bildirimci(db, { ayarlar: AYARLAR, kanal: kararlarTelegramaDa(kanalKur(AYARLAR, { telegram }), telegram) });
// Ilk acilista birikmis gecmisi yigin halinde gondermeyelim.
bildirimci.basaSar(sonSeq(db));
// Akis ekle-only ama sinirsiz degil: gunde bir kez yaslanmislari at.
olayKirp(db);
try { defterKirp(db); } catch { /* tablo henuz yoksa */ }
// Hafiza disiplini: olu/sahipsiz proje hafizasi, konu kopyalari, bayat olgular, eski raporlar.
function hafizayiBuda() {
  // Once yetim ic isler: hafiza budamasi "isi kalmamis gecici proje" kuralini is listesinden okur.
  try {
    const y = yetimIcIsleriSil(db);
    if (y.length) console.log('  yetim ic is silindi: ' + y.length + ' (hedefi silinmis denetci / projesi bosalmis damitma)');
  } catch (e) { console.error('yetim is temizligi: ' + e.message); }
  try {
    const r = hafizaBudama(db);
    if (r.toplam) console.log('  hafiza budandi: ' + r.toplam + ' kayit (olu proje ' + r.oluProje + ', sahipsiz ' + r.sahipsiz
      + ', kopya ' + r.kopya + ', bayat ' + r.bayat + ', tasan ' + r.tasan + ', eski rapor ' + r.eskiRapor + ')');
  } catch (e) { console.error('hafiza budama: ' + e.message); }
}
hafizayiBuda();
setInterval(() => {
  hafizayiBuda();
  try { olayKirp(db); } catch { /* sonraki turda */ }
  try { defterKirp(db); } catch { /* sonraki turda */ }
}, 24 * 3600_000);

// --- Insan mudahale kanali (terminal) ---
// KAPALI DOGAR. Bu uclar makinede keyfi komut calistirir; jeton sizarsa panel
// bir uzak kabuga doner. Acmak bilincli bir karar olmali.
const TERMINAL_ACIK = process.env.SURU_TERMINAL === '1';
let pty = null;
const ptyAboneler = new Map();   // terminalId -> Set<res>

async function ptyHazirla() {
  if (pty) return pty;
  const { OturumYoneticisi } = await import('./pty.js');
  pty = new OturumYoneticisi();
  pty.on('veri', (id, veri) => ptyYayinla(id, 'veri', veri));
  pty.on('cikis', (id, kod) => ptyYayinla(id, 'cikis', String(kod)));
  return pty;
}

function ptyYayinla(id, olay, veri) {
  const kume = ptyAboneler.get(id);
  if (!kume || !kume.size) return;
  // SSE'de veri satir satir gider; ANSI ciktisi satir sonu icerdigi icin
  // JSON'a sarip tek satira indiriyoruz.
  const paket = 'event: ' + olay + NL + 'data: ' + JSON.stringify(veri) + NL + NL;
  for (const res of kume) { try { res.write(paket); } catch { kume.delete(res); } }
}

// --- Otomasyon ---
// Cokme sonrasi 'calisiyor' asili kalmis kayitlari temizle: surecleri coktan olmus.
const hayalet = hayaletleriKapat(db);
if (hayalet) console.log('  ' + hayalet + ' asili kosu kaydi kapatildi (onceki cokme).');

const kuyruk = new Kuyruk(db, {
  esZamanli: Number(process.env.SURU_ES_ZAMANLI ?? 2),
  // 'uyar' | 'beklet' | 'yoksay'. Varsayilan uyarmak: engellemek erken bir
  // karar olurdu, once cakismanin gercekten olup olmadigini gormek lazim.
  cakismaPolitikasi: process.env.SURU_CAKISMA ?? 'uyar',
  // Kosular 3 saniye arayla acilir: ayni ana yigilmasin.
  baslatmaAraligiMs: Number(process.env.SURU_BASLATMA_ARALIGI ?? 3000),
  // gizlilikOku her kosuda dosyadan okur: panelden degisen kural bir sonraki kosuda gecerli.
  kosucuSecenekleri: { hafizaAyari: AYARLAR.hafiza, golgeAyari: AYARLAR.golge,
    worktreeAyari: AYARLAR.worktree,
    mcpAyari: AYARLAR.mcp,
    baglamAyari: AYARLAR.baglam,
    oneriAyari: AYARLAR.oneri,
    // Istem stdin'den gider; kosu surerken ara talimat yazilabilir (SURU_CANLI_TALIMAT=0 ile kapanir).
    canliTalimat: process.env.SURU_CANLI_TALIMAT !== '0',
    gizlilikOku: (cwd) => projeGizliligi(cwd) },
});
kuyruk.on('cakisma', (c) => console.warn('cakisma: ' + c.uyari));

// Yapici/denetci dongusu. kosuSonrasi'ndan ONCE kayitli olmali: dongu tikanirsa
// yapici kosuyu karar-bekliyor yapar; karar taramasi ayni 'bitti' olayinda bulsun.
kuyruk.on('bitti', ({ kosuId, isId }) => {
  try {
    const r = donguIlerlet(db, { siraya: (id, ek) => kuyruk.siraya(id, ek) }, { kosuId, isId });
    if (r) console.log('dongu: ' + r.asama + (r.neden ? ' (' + r.neden + ')' : '') + (r.tur ? ' tur ' + r.tur : ''));
  } catch (e) {
    console.error('dongu:', e.message);
  }
});

// Telegram'a "bitti" satiri (istege bagli). Dongu isleyicisinden SONRA: denetci kuyruga girdiyse
// bu bitis son bitis degildir ve mesaj gitmez (bkz. bitti-bildirimi.js).
kuyruk.on('bitti', ({ kosuId }) => {
  if (!AYARLAR.telegram?.bittiBildir || !telegram?.eslesmis()) return;
  try {
    const m = bittiMesaji(db, { kosuId });
    if (m) telegram.mesajYaz(telegram.sohbet(), m).catch((e) => console.error('telegram bitti: ' + e.message));
  } catch (e) { console.error('bitti bildirimi: ' + e.message); }
});

// Sonraki adim onerisi (varsayilan acik): ajanin "Sonraki adim:" satiri kv'ye yazilir, Telegram'a Ac/Gec ile gider.
// Otomatik baglam devami: esik asilip ozetle biten kosu icin ayni ise yeni oturum.
kuyruk.on('bitti', ({ kosuId }) => {
  try {
    if (AYARLAR.baglam?.esikToken > 0 && AYARLAR.baglam?.devamEt !== false) {
      const y = baglamDevami(db, kuyruk, { kosuId });
      if (y) { console.log('baglam: ozetten yeni oturum acildi [' + y.id.slice(0, 6) + ']'); return; }
    }
    if (!AYARLAR.oneri?.etkin) return;
    let kisitli = false;
    try { kisitli = !!kotaDegerlendir(db, AYARLAR).kisitli; } catch { /* kota olculemedi: kisitli sayma */ }
    const o = oneriUret(db, { kosuId, kotaKisitli: kisitli });
    if (o && telegram?.eslesmis()) {
      telegram.mesajYaz(telegram.sohbet(), oneriMetni(o), { dugmeler: oneriDugmeleri(o)[0].secenekler })
        .catch((e) => console.error('telegram oneri: ' + e.message));
    }
  } catch (e) { console.error('oneri/baglam: ' + e.message); }
});

// Golge budama: kosu bitince o projenin eski goruntuleri. Silinecek yoksa ucuz
// (tek for-each-ref); gc sadece silme olunca calisir.
kuyruk.on('bitti', ({ isId }) => {
  if (!AYARLAR.golge?.etkin) return;
  const is = isGetir(db, isId);
  if (!is) return;
  try { budama(is.cwd, { gun: AYARLAR.golge.gun, enFazla: AYARLAR.golge.enFazla }); }
  catch (e) { console.warn('golge budama: ' + e.message); }
});

// --- Kota beyni ---
// Pencere doldukca es zamanlilik kendiliginden duser, bosaldikca geri yukselir.
// Kuyrugu durdurmuyoruz: sinir 0 olunca yeni kosu baslamaz ama calisan biter.
let sonKotaGerekce = null;
function kotaUygula() {
  if (!AYARLAR.kota?.etkin) return null;
  let d;
  try { d = kotaDegerlendir(db, AYARLAR); }
  catch (e) { console.error('kota degerlendirme:', e.message); return null; }

  if (d.sinir !== kuyruk.esZamanli) kuyruk.sinirAyarla(d.sinir);
  if (d.gerekce !== sonKotaGerekce) {
    sonKotaGerekce = d.gerekce;
    console.log('kota: ' + d.gerekce + ' -> es zamanli ' + d.sinir);
  }
  return d;
}
setInterval(kotaUygula, 60_000);

// --- Zamanlama ---
// Vadesi gelen zamanlanmis isler normal kuyruga girer (kota beyni gecerli). Kacirilan
// tetikler birikmez; onceki kosu bitmediyse tetik atlanir. Bkz. zamanlama.js.
function zamanlamaTik() {
  try {
    for (const r of zamanlamaTetikle(db, kuyruk)) {
      console.log('zamanlama: ' + r.ad + (r.atlandi ? ' atlandi (' + r.neden + ')' : ' kuyruga alindi'));
    }
  } catch (e) {
    console.error('zamanlama:', e.message);
  }
}
setInterval(zamanlamaTik, 30_000);
setTimeout(zamanlamaTik, 5_000);

// --- Git tetikleyici ---
// Izlenen referans oynayinca is kuyruga girer. Uzak-izleme refi (origin/main)
// izleniyorsa bu fiilen bir PUSH tetigi olur ve aga cikmaz. Bkz. gittetik.js.
function gitTik() {
  try {
    for (const r of gitTetikle(db, kuyruk)) {
      console.log('git tetik: ' + r.ad + (r.atlandi ? ' atlandi (' + r.neden + ')' : ' kuyruga alindi ' + (r.commit ?? '')));
    }
  } catch (e) {
    console.error('git tetik:', e.message);
  }
}
setInterval(gitTik, 30_000);
setTimeout(gitTik, 7_000);

/** Kosu bittiginde: karar dogduysa ac, bildirimi durt, paneli tazele. */
function kosuSonrasi() {
  try { kararlariTazele(db); } catch (e) { console.error('karar tazeleme:', e.message); }
  kotaUygula();
  bildirimci.calistir().catch((e) => console.error('bildirim hatasi:', e.message));
  taramayiPlanla(200);
}
kuyruk.on('bitti', kosuSonrasi);

// Otomatik damitma: bir kosu bitince projesinde ham rapor birikti mi bak.
// Damitma isinin kendisi bitince tetikleme yok (dongu korumasi hafiza.js'te de var).
kuyruk.on('bitti', ({ isId }) => {
  const ayar = AYARLAR.hafiza?.damitma;
  if (!AYARLAR.hafiza?.etkin || !ayar?.etkin) return;
  try {
    const is = isGetir(db, isId);
    if (!is || damitmaIsiMi(is) || denetciIsiMi(is)) return;
    if (!damitmaGerekiyorMu(db, is.cwd, { esik: ayar.esik ?? 5 })) return;
    const d = damitmaIsiHazirla(db, is.cwd, { model: ayar.model ?? 'haiku', butceUsd: ayar.butceUsd ?? 0.25 });
    kuyruk.siraya(d.id);
    console.log('damitma siraya alindi: ' + d.ad);
  } catch (e) {
    console.error('damitma degerlendirme:', e.message);
  }
});
kuyruk.on('basladi', () => taramayiPlanla(200));

// --- Durum toplama ---
// Mobil icin kisa anahtarlar: yuk kucuk kalsin, eski telefonun parseri az calissin.
function kucult(s, kimlik, isId = null) {
  const o = {
    i: s.sessionId,
    // Ajan kimligi: panelde ve bildirimde ayni ad gorunsun.
    n: kimlik?.ad ?? null,
    e: kimlik?.simge ?? null,
    h: kimlik?.hue ?? null,
    d: s.durum,
    p: s.project,
    // Yas degil mutlak zaman: yas her taramada degisir ve yuku bosuna
    // farklilastirip telefonun telsigini uyandirirdi. Yasi istemci hesaplar.
    z: s.at,
    a: s.arac || null,
    k: s.kesin ? 1 : 0,
    q: s.kuyrukta || 0,
    b: (s.baslik || '').slice(0, 40),
    g: s.dal || null,
    m: (s.sonMetin || '').slice(0, 90),
    r: s.sifirlanma || null,
  };
  // Suru'nun kosturdugu isin oturumuysa hangi ise ait oldugu. Sadece varsa
  // eklenir: telefonun indirdigi yuk her oturumda bos alanla sismesin.
  // Ofis bununla ayni ajani iki kez (is + oturum) saymaz.
  if (isId) o.u = isId;
  return o;
}

const SEP = String.fromCharCode(92);
const projeAdi = (cwd) => {
  if (!cwd) return '?';
  const p = cwd.split(SEP).join('/').split('/').filter(Boolean);
  return p[p.length - 1] || '?';
};

let sonYuk = '[]';
let sonSurum = 0;

async function tara() {
  const olaylar = olaylariYukle();
  const anlik = [];
  for (const { file } of listTranscripts()) {
    let st;
    try { st = statSync(file); } catch { continue; }
    if (Date.now() - st.mtimeMs > PENCERE) continue;
    try {
      const d = await oturumDurumu(file, { olaylar });
      if (!d) continue;
      anlik.push({
        ...d,
        sessionId: basename(file, '.jsonl'),
        project: projeAdi(d.cwd),
        at: d.sonZaman,
        arac: d.bekleyenArac,
      });
    } catch { /* bu oturumu atla */ }
  }

  // Degisen durumlar akisa yazilir. Ayni durum tekrar yazilmaz, yoksa
  // 15 saniyelik tarama dongusu tabloyu tekrarla doldurur.
  let yeniGecis = [];
  try { yeniGecis = takipci.tara(anlik); } catch { /* akis yazilamadi, panel yine calisir */ }
  // Sadece gercekten bir sey degistiyse bildirimciyi durt: bos tarama
  // her 15 saniyede bosuna sorgu acmasin.
  if (yeniGecis.length) {
    bildirimci.calistir().catch((e) => console.error('bildirim hatasi:', e.message));
  }

  const ONCELIK = { 'onay-bekliyor': 0, 'seni-bekliyor': 1, takildi: 2, 'limit-doldu': 3, calisiyor: 4, bosta: 5 };
  const kadro = kadroCikar(anlik.map((x) => x.sessionId));
  // Hangi oturum Suru'nun kosturdugu bir ise ait? Tek sorgu, oturum listesi
  // JSON olarak verilir (degisken sayida ? yer tutucusu kurmadan).
  const suruKosusu = new Map();
  try {
    const kimlikler = JSON.stringify(anlik.map((x) => x.sessionId));
    for (const r of db.prepare(`SELECT k.session_id, k.is_id, i.ad is_ad FROM kosular k LEFT JOIN isler i ON i.id = k.is_id
        WHERE k.session_id IN (SELECT value FROM json_each(?))`).all(kimlikler)) {
      suruKosusu.set(r.session_id, { isId: r.is_id, isAd: r.is_ad ?? null });
    }
  } catch { /* eslesme kurulamadi: oturumlar yine gorunur, sadece ikilenebilir */ }
  // Ad gorevden: Suru'nun kosturdugu oturumda is adi, elle acilmis oturumda baslik.
  // Ikisi de yoksa kadro adi (cakisma eki ile) - eski davranis.
  const kimlikSec = (x) => {
    const is = suruKosusu.get(x.sessionId);
    if (is?.isAd) return kimlikCoz(db, { isId: is.isId, sessionId: x.sessionId, isAd: is.isAd });
    if (x.baslik && String(x.baslik).trim()) return kimlikCoz(db, { sessionId: x.sessionId, baslik: x.baslik });
    return kadro.get(x.sessionId);
  };
  const cikti = anlik.map((x) => kucult(x, kimlikSec(x), suruKosusu.get(x.sessionId)?.isId ?? null))
    .sort((a, b) => (ONCELIK[a.d] ?? 9) - (ONCELIK[b.d] ?? 9) || b.z - a.z);

  const yeni = JSON.stringify(cikti);
  if (yeni !== sonYuk) { sonYuk = yeni; sonSurum++; }
  return sonYuk;
}

// --- SSE abonelikleri ---
const abone = new Set();
function yayinla() {
  if (!abone.size) return;
  const paket = 'id: ' + sonSurum + NL + 'data: ' + sonYuk + NL + NL;
  for (const res of abone) { try { res.write(paket); } catch { abone.delete(res); } }
}

let bekleyenTara = null;
function taramayiPlanla(gecikme = 500) {
  if (bekleyenTara) return;
  bekleyenTara = setTimeout(async () => {
    bekleyenTara = null;
    const onceki = sonSurum;
    await tara();
    if (sonSurum !== onceki) yayinla(); // degismediyse telsigi uyandirma
  }, gecikme);
}

// --- HTTP yardimcilari ---

function json(res, kod, veri) {
  res.writeHead(kod, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(JSON.stringify(veri));
}

/** Istek govdesini JSON olarak okur. Sinir var: acik uclu govde bellek yemesin. */
function govdeOku(req, enFazla = 64 * 1024) {
  return new Promise((coz, red) => {
    let ham = '';
    req.on('data', (d) => {
      ham += d;
      if (ham.length > enFazla) { req.destroy(); red(new Error('govde cok buyuk')); }
    });
    req.on('end', () => {
      if (!ham) return coz({});
      try { coz(JSON.parse(ham)); } catch { red(new Error('gecersiz JSON')); }
    });
    req.on('error', red);
  });
}

// --- HTTP ---
const HTML = readFileSync(join(KOK, 'panel.html'));
const HTML_GZ = gzipSync(HTML, { level: 9 });
// Ofis ayri sayfa: telefon panelinin canvas kodunu indirmesi gereksiz.
const OFIS = readFileSync(join(KOK, 'ofis.html'));
const OFIS_GZ = gzipSync(OFIS, { level: 9 });
const KOMUTA = readFileSync(join(KOK, 'komuta.html'));
const KOMUTA_GZ = gzipSync(KOMUTA, { level: 9 });
const TERM = readFileSync(join(KOK, 'terminal.html'));
const TERM_GZ = gzipSync(TERM, { level: 9 });
// Service worker: onbellek yok (sayfa her zaman sunucudan), sadece kurulabilirlik + bildirim tiklamasi.
// Web Push (sunucu itmeli) yok: VAPID/sifreleme bagimlilik ister; Telegram o isi goruyor.
const SW_KODU = [
  "self.addEventListener('install', function(){ self.skipWaiting(); });",
  "self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });",
  "self.addEventListener('notificationclick', function(e){ e.notification.close();",
  "  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(function(l){ if (l.length) return l[0].focus(); return self.clients.openWindow('/komuta'); })); });",
].join(NL);

function sayfaVer(req, res, ham, gz) {
  const gzip = (req.headers['accept-encoding'] || '').includes('gzip');
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
    ...(gzip ? { 'content-encoding': 'gzip' } : {}),
  });
  return res.end(gzip ? gz : ham);
}

const sunucu = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');

  if (u.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  const kerez = kerezOku(req.headers.cookie);
  const sorgudan = u.searchParams.get('t');
  const kerezden = kerez.get(KEREZ);
  const yetkili = jetonGecerli(kerezden) || jetonGecerli(sorgudan);

  if (!yetkili) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Jeton gerekli. Dogru adresi terminalden al.');
  }

  // Adresteki jetonu bir kerelik kullan: cereze yaz ve temiz adrese yolla.
  if (jetonGecerli(sorgudan) && !jetonGecerli(kerezden)) {
    res.writeHead(302, {
      location: u.pathname,
      'set-cookie': KEREZ + '=' + JETON + '; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax',
    });
    return res.end();
  }

  if (u.pathname === '/') return sayfaVer(req, res, HTML, HTML_GZ);
  if (u.pathname === '/ofis') return sayfaVer(req, res, OFIS, OFIS_GZ);
  if (u.pathname === '/komuta') return sayfaVer(req, res, KOMUTA, KOMUTA_GZ);
  // Komuta merkezi verisi: acilis goruntusu ve imlecten beri akis (bkz. komuta.js).
  if (u.pathname === '/komuta/veri') { kararlariTazele(db); return json(res, 200, komutaGoruntu(db, kuyruk)); }
  if (u.pathname === '/komuta/akis') return json(res, 200, komutaAkis(db, u.searchParams.get('since')));
  if (u.pathname === '/terminal') return sayfaVer(req, res, TERM, TERM_GZ);
  // PWA: komuta sayfasi telefona uygulama gibi kurulabilsin (manifest + en kucuk service worker).
  if (u.pathname === '/manifest.webmanifest') {
    res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(JSON.stringify({ name: 'Sürü Komuta', short_name: 'Sürü', start_url: '/komuta', scope: '/',
      display: 'standalone', background_color: '#16130f', theme_color: '#1e1a15', lang: 'tr',
      icons: [{ src: '/simge.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] }));
  }
  if (u.pathname === '/simge.svg') {
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' });
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#1e1a15"/>'
      + '<text x="32" y="44" font-size="36" text-anchor="middle" font-family="sans-serif">🐝</text></svg>');
  }
  if (u.pathname === '/sw.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(SW_KODU);
  }
  // Is basina MCP secimi icin sunucu adlari (tanim icerigi verilmez) ve is sablonlari.
  if (u.pathname === '/mcp-sunucular') {
    return json(res, 200, { sunucular: mcpSunucuListesi(AYARLAR.mcp, u.searchParams.get('cwd') || null) });
  }
  if (u.pathname === '/sablonlar') {
    return json(res, 200, { sablonlar: Object.entries(SABLONLAR).map(([anahtar, s]) => ({ anahtar, ad: s.ad, aciklama: s.aciklama, profil: s.profil })) });
  }
  if (u.pathname === '/oneriler') return json(res, 200, { oneriler: oneriler(db).filter((o) => o.durum === 'acik') });
  // Maliyet tahmini (is acilmadan): ayni proje (+profil/model) gecmis kosularinin araligi. Veri azsa soyler.
  if (u.pathname === '/is/tahmin') {
    return json(res, 200, maliyetTahmini(db, { cwd: u.searchParams.get('cwd') || null,
      profil: u.searchParams.get('profil') || null, model: u.searchParams.get('model') || null }));
  }
  if (u.pathname === '/rapor/model') {
    const gun = Math.min(365, Math.max(1, Number(u.searchParams.get('gun') ?? 90) || 90));
    return json(res, 200, { gun, satirlar: projeModelRaporu(db, { gun }) });
  }

  // Telegram durumu: eslesme kodu SADECE eslesmemisken ve sadece jetonlu panele gider.
  if (u.pathname === '/telegram') {
    return json(res, 200, telegram ? telegram.durum() : { etkin: false, eslesti: false, kod: null });
  }

  if (u.pathname === '/durum') {
    await tara();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(sonYuk);
  }

  // Olay akisi: tuketici kaldigi seq'ten devam eder. Canli harita ve replay
  // bunu okuyacak (Faz 4).
  if (u.pathname === '/olaylar') {
    const since = Number(u.searchParams.get('since') ?? 0) || 0;
    const limit = Math.min(Number(u.searchParams.get('limit') ?? 500) || 500, 5000);
    const tur = u.searchParams.get('tur') || null;
    const olaylar = olayOku(db, { sinceSeq: since, kind: tur, limit });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(JSON.stringify({ son: sonSeq(db), olaylar }));
  }

  // --- Otomasyon ucu ---

  if (u.pathname === '/kararlar') {
    kararlariTazele(db);
    return json(res, 200, {
      kararlar: bekleyenKararlar(db).map((k) => kararKarti(db, k)),
      kuyruk: kuyruk.durum(),
    });
  }

  if (u.pathname === '/kota') {
    try {
      return json(res, 200, kotaDegerlendir(db, AYARLAR));
    } catch (e) {
      return json(res, 500, { hata: e.message });
    }
  }

  if (u.pathname === '/baglam') {
    const cwd = u.searchParams.get('cwd');
    if (!cwd) return json(res, 400, { hata: 'cwd gerekli' });
    try {
      return json(res, 200, baglamOlc(cwd, { otomatikHafiza: !!AYARLAR.hafiza?.claudeOtomatikHafiza }));
    } catch (e) {
      return json(res, 500, { hata: e.message });
    }
  }

  if (u.pathname === '/hafiza') {
    const cwd = u.searchParams.get('cwd');
    if (!cwd) return json(res, 400, { hata: 'cwd gerekli' });
    return json(res, 200, { kayitlar: hafizaKayitlari(db, { cwd, limit: 200 }) });
  }

  if (u.pathname === '/isler') {
    // Karne is satirinda gorunsun: hangi ayarin calistigi listeyi okurken belli olsun.
    // Baglam yuku: bu isin her kosusu ise baslamadan ne kadar otomatik talimat
    // yukluyor. Ajan kosularinin gercek ayariyla olculur (oto. hafiza dahil/haric).
    const otoHafiza = !!AYARLAR.hafiza?.claudeOtomatikHafiza;
    // Ic isler (damitma gibi) listede gorunmez: kullanici yanlislikla silmesin.
    const isler = isListesi(db).filter((i) => !String(i.ad).startsWith('_')).map((i) => {
      let baglam = null;
      try {
        const b = baglamOlc(i.cwd, { otomatikHafiza: otoHafiza });
        baglam = { token: b.toplam.token, dosya: b.dosyalar.length, uyarilar: b.uyarilar };
      } catch { /* olculemedi, satir yine gorunsun */ }
      let sonrakiTetik = null;
      try { sonrakiTetik = i.zamanlama ? sonrakiZaman(i.zamanlama) : null; } catch { /* gecersiz ifade */ }
      return { ...i, karne: isKarnesi(db, i.id), baglam, sonrakiTetik };
    });
    return json(res, 200, { isler, profiller: profilOzeti() });
  }

  // Ayni yolun POST'u asagida: metot kontrolu olmazsa bu dal POST'u da yutar
  // (uctan uca denemede POST /gizlilik "cwd gerekli" diye donuyordu).
  if (u.pathname === '/gizlilik' && req.method === 'GET') {
    const cwd = u.searchParams.get('cwd');
    if (!cwd) return json(res, 400, { hata: 'cwd gerekli' });
    return json(res, 200, projeGizliligi(cwd));
  }

  if (u.pathname === '/veri-akisi') {
    const gun = Math.min(90, Math.max(1, Number(u.searchParams.get('gun') ?? 7) || 7));
    return json(res, 200, veriAkisiOzeti(db, { cwd: u.searchParams.get('cwd') || null, gun }));
  }

  if (u.pathname === '/dongu') {
    const isId = u.searchParams.get('is');
    if (!isId) return json(res, 400, { hata: 'is gerekli' });
    return json(res, 200, donguDurumu(db, isId));
  }

  if (u.pathname === '/geri-al/plan') {
    const kosu = kosuGetir(db, u.searchParams.get('kosu'));
    if (!kosu) return json(res, 404, { hata: 'kosu yok' });
    if (!kosu.golgeOnce || !kosu.golgeSonra) return json(res, 404, { hata: 'bu kosunun checkpointi yok' });
    const is = isGetir(db, kosu.isId);
    if (!is) return json(res, 404, { hata: 'is silinmis' });
    try {
      const plan = geriAlPlani(is.cwd, kosu.golgeOnce, kosu.golgeSonra);
      return json(res, 200, { kosu: kosu.id, geriAlindi: kosu.geriAlindi, plan, ortusen: ortusenKosular(db, kosu) });
    } catch (e) {
      return json(res, 500, { hata: e.message });
    }
  }

  if (u.pathname === '/kanit') {
    const kosu = kosuGetir(db, u.searchParams.get('kosu'));
    if (!kosu) return json(res, 404, { hata: 'kosu yok' });
    const z = kanitZinciri(kosu.sessionId, { projelerDizini: PROJECTS_DIR });
    if (!z) return json(res, 404, { hata: 'transkript bulunamadi', sessionId: kosu.sessionId });
    return json(res, 200, { kosu: kosu.id, sessionId: kosu.sessionId, ...z });
  }

  if (u.pathname === '/karne') {
    const karneler = tumKarneler(db, { enAzKosu: 1 });
    return json(res, 200, {
      karneler,
      // Butun isleri bir torbaya atan karsilastirma: kaba bakis.
      model: modelOnerisi(db, { enAzKosu: 3 }),
      // Is basina karsilastirma: yonlendirme icin tek gecerli temel. Veri
      // yetmeyen isler icin 'oneri: null' doner, uydurma yapmaz.
      isModeli: Object.fromEntries(karneler
        .filter((k) => k.isId)
        .map((k) => [k.isId, isModelOnerisi(db, k.isId, { enAzKosu: 3 })])
        .filter(([, r]) => r.oneri || r.gruplar.length > 1)),
    });
  }

  // --- Terminal uclari ---
  if (u.pathname.startsWith('/pty')) {
    if (!TERMINAL_ACIK) {
      return json(res, 403, {
        hata: 'terminal kapali. Acmak icin: SURU_TERMINAL=1 npm run panel',
        not: 'bu uclar makinede keyfi komut calistirir',
      });
    }
    const y = await ptyHazirla();

    if (u.pathname === '/pty/liste' && req.method === 'GET') {
      return json(res, 200, { terminaller: y.liste() });
    }

    if (u.pathname === '/pty/akis' && req.method === 'GET') {
      const id = u.searchParams.get('id');
      if (!id) return json(res, 400, { hata: 'id gerekli' });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache', connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      // Gec katilana o ana kadarki ekran: bos terminal gormesin.
      const gecmis = y.gecmis(id);
      if (gecmis) res.write('event: veri' + NL + 'data: ' + JSON.stringify(gecmis) + NL + NL);

      if (!ptyAboneler.has(id)) ptyAboneler.set(id, new Set());
      ptyAboneler.get(id).add(res);
      const kalp = setInterval(() => { try { res.write(': .' + NL + NL); } catch { /* kapandi */ } }, 25_000);
      req.on('close', () => { clearInterval(kalp); ptyAboneler.get(id)?.delete(res); });
      return;
    }

    if (req.method !== 'POST') return json(res, 404, { hata: 'bilinmeyen uc' });
    if (!(req.headers['content-type'] || '').includes('application/json')) {
      return json(res, 415, { hata: 'content-type application/json olmali' });
    }
    let govde;
    try { govde = await govdeOku(req); }
    catch (e) { return json(res, 400, { hata: e.message }); }

    try {
      if (u.pathname === '/pty/ekle') return json(res, 200, { tamam: true, terminal: y.ajanEkle(govde) });
      if (u.pathname === '/pty/sil') { y.ajanSil(govde.id); return json(res, 200, { tamam: true }); }
      if (u.pathname === '/pty/baslat') {
        return json(res, 200, { tamam: true, terminal: await y.baslat(govde.id, govde) });
      }
      if (u.pathname === '/pty/yaz') { y.yaz(govde.id, govde.veri); return json(res, 200, { tamam: true }); }
      if (u.pathname === '/pty/boyut') {
        y.boyutlandir(govde.id, govde.cols, govde.rows);
        return json(res, 200, { tamam: true });
      }
      if (u.pathname === '/pty/durdur') return json(res, 200, { tamam: y.durdur(govde.id) });
    } catch (e) {
      return json(res, 400, { hata: e.message });
    }
    return json(res, 404, { hata: 'bilinmeyen uc' });
  }

  if (u.pathname === '/rapor/gece') {
    const saat = Number(u.searchParams.get('saat'));
    const a = Number.isFinite(saat) && saat > 0
      ? { baslangic: Date.now() - saat * 3600_000, bitis: Date.now() }
      : geceAraligi();
    return json(res, 200, raporOzet(db, AYARLAR, a));
  }

  if (u.pathname === '/kosular') {
    const isId = u.searchParams.get('is') || null;
    return json(res, 200, { kosular: kosular(db, { isId, limit: 30 }) });
  }

  // Yazan uclar yalnizca POST + JSON. Cerez SameSite=Lax oldugu icin baska
  // siteden gelen POST'a cerez eklenmiyor; JSON sarti da basit form
  // gonderimlerini eliyor.
  if (req.method === 'POST') {
    if (!(req.headers['content-type'] || '').includes('application/json')) {
      return json(res, 415, { hata: 'content-type application/json olmali' });
    }
    let govde;
    try { govde = await govdeOku(req); }
    catch (e) { return json(res, 400, { hata: e.message }); }

    try {
      if (u.pathname === '/karar/cevapla') {
        const { devamKosu } = cevapla(db, govde.id, govde.cevap);
        // Cevap verildi: devam kosusu kuyruga girer, ajan kaldigi yerden surer.
        kuyruk.pompala();
        return json(res, 200, { tamam: true, devamKosuId: devamKosu.id });
      }
      if (u.pathname === '/hafiza/olgu') {
        return json(res, 200, { tamam: true, kayit: insanOlgusu(db, govde) });
      }
      if (u.pathname === '/hafiza/sil') {
        hafizaSil(db, govde.id);
        return json(res, 200, { tamam: true });
      }
      if (u.pathname === '/hafiza/olgu/duzenle') {
        // Duzenleme = ayni konuya yeniden yazma (konu ile ezme kurali). Eski kayit konusuz ise silinir.
        const eski = govde.id ? db.prepare('SELECT * FROM hafiza WHERE id = ?').get(govde.id) : null;
        if (eski && !eski.konu) hafizaSil(db, eski.id);
        const kayit = insanOlgusu(db, { cwd: govde.cwd, icerik: govde.icerik,
          konu: eski?.konu ? String(eski.konu).replace(/^insan:/, '') : null });
        return json(res, 200, { tamam: true, kayit });
      }
      if (u.pathname === '/karar/kabul') {
        kabulEt(db, govde.id, { not: govde.not ?? null });
        taramayiPlanla(200);
        return json(res, 200, { tamam: true });
      }
      if (u.pathname === '/karar/kapsam') {
        const r = kapsamGenislet(db, govde.id, { yollar: Array.isArray(govde.yollar) ? govde.yollar : null });
        kuyruk.pompala();
        return json(res, 200, { tamam: true, kapsam: r.kapsam, eklenen: r.eklenen, devamKosuId: r.devamKosu.id });
      }
      if (u.pathname === '/karar/uygula') {
        const r = planUygula(db, govde.id);
        kuyruk.pompala();
        return json(res, 200, { tamam: true, profil: r.profil, devamKosuId: r.devamKosu.id });
      }
      if (u.pathname === '/karar/iptal') {
        iptalEt(db, govde.id);
        taramayiPlanla(200);
        return json(res, 200, { tamam: true });
      }
      if (u.pathname === '/is/ekle') {
        // Sablon: formdan "sablon" geldiyse gorev/profil/kapsam sablondan, kullanicinin yazdigi gorev "ek" olur.
        let alanlar = govde;
        if (govde.sablon) {
          const s = sablondanIs(govde.sablon, { ek: govde.gorev ?? '', ornek: { dogrulama: govde.dogrulama || null } });
          alanlar = { ...govde, ad: govde.ad || s.ad, gorev: s.gorev, profil: s.profil, kapsam: govde.kapsam || s.kapsam, dogrulama: s.dogrulama };
        }
        const is = isEkle(db, alanlar);
        // Engellemez: gorev kapsam disi dosya aniyorsa ekleyene hemen soyle (iki tur yakmadan).
        return json(res, 200, { tamam: true, is, kapsamUyarisi: gorevKapsamCelismesi(is.gorev, is.kapsam) });
      }
      if (u.pathname === '/is/sil') {
        // Once isin kosulari durdurulur ve acik kararlari kapatilir: silinmis ise ait
        // kosu bitip karar karti acmasin, zamanlanmis tetik de kalmasin (satir silinir).
        const durdurulan = kuyruk.isKosulariniDurdur(govde.id, 'is silindi');
        let iptalKarar = 0;
        for (const k of bekleyenKararlar(db, { limit: 1000 }).filter((x) => x.isId === govde.id)) {
          iptalEt(db, k.id);
          iptalKarar++;
        }
        isSil(db, govde.id);
        taramayiPlanla(200);
        return json(res, 200, { tamam: true, durdurulan: durdurulan.length, iptalKarar });
      }
      // Ara talimat: calisan kosuya canli, bitmis ise ayni oturumdan devam (bkz. kuyruk.talimat).
      if (u.pathname === '/is/talimat') {
        const r = kuyruk.talimat(govde.id, govde.metin);
        taramayiPlanla(200);
        return json(res, 200, { tamam: true, ...r });
      }
      if (u.pathname === '/is/siraya') {
        const kosu = kuyruk.siraya(govde.id);
        return json(res, 200, { tamam: true, kosuId: kosu.id, sessionId: kosu.sessionId });
      }
      if (u.pathname === '/gizlilik') {
        const g = projeGizliliginiYaz(govde.cwd, { yollar: Array.isArray(govde.yollar) ? govde.yollar : [],
          webYasak: !!govde.webYasak });
        return json(res, 200, { tamam: true, gizlilik: g });
      }
      if (u.pathname === '/geri-al') {
        const kosu = kosuGetir(db, govde.id);
        if (!kosu) throw new Error('kosu yok');
        if (!kosu.golgeOnce || !kosu.golgeSonra) throw new Error('bu kosunun checkpointi yok');
        const is = isGetir(db, kosu.isId);
        if (!is) throw new Error('is silinmis');
        // Ayni klasorde calisan ajan varsa dosyalar degisirken geri alma yapilmaz.
        const calisan = acikKosular(db).filter((k) => {
          const ki = isGetir(db, k.isId);
          return ki && ki.cwd === is.cwd;
        });
        if (calisan.length) throw new Error('bu klasorde calisan kosu var, once durdur ya da bitmesini bekle');
        const r = geriAl(is.cwd, kosu.golgeOnce, kosu.golgeSonra, { etiket: kosu.id + '-geri-al-' + Date.now() });
        kosuGuncelle(db, kosu.id, { geriAlindi: Date.now() });
        olayYaz(db, { kind: OLAY.IS, sessionId: kosu.sessionId, project: is.ad,
          data: { asama: 'geri-alindi', kosuId: kosu.id, geriAlinan: r.geriAlinan.length, cakisan: r.cakisan, guvenlik: r.guvenlik } });
        taramayiPlanla(200);
        return json(res, 200, { tamam: true, ...r });
      }
      // Panel komut satiri: Telegram ile AYNI ayristirici (komut.js).
      if (u.pathname === '/komut') {
        const r = komutCalistir(govde.metin, { db, kuyruk });
        taramayiPlanla(200);
        return json(res, 200, { tamam: true, metin: r.metin });
      }
      if (u.pathname === '/telegram/ayir') {
        if (!telegram) throw new Error('telegram kurulu degil');
        telegram.ayir();
        return json(res, 200, { tamam: true, ...telegram.durum() });
      }
      if (u.pathname === '/kosu/durdur') {
        const r = kuyruk.kosuDurdur(govde.id, 'panel');
        taramayiPlanla(200);
        return json(res, 200, { tamam: true, ...r });
      }
      if (u.pathname === '/kuyruk/sinir') {
        kuyruk.sinirAyarla(Number(govde.sinir));
        return json(res, 200, { tamam: true, kuyruk: kuyruk.durum() });
      }
    } catch (e) {
      // Kullanici hatasi (bos cevap, kapali karar) 400; beklenmedik olan 500.
      return json(res, 400, { hata: e.message });
    }
    return json(res, 404, { hata: 'bilinmeyen uc' });
  }

  if (u.pathname === '/rapor') {
    try {
      const r = await raporVerisi();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('rapor uretilemedi: ' + e.message);
    }
  }

  if (u.pathname === '/akis') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    await tara();
    res.write('event: saat' + NL + 'data: ' + Date.now() + NL + NL);
    res.write('id: ' + sonSurum + NL + 'data: ' + sonYuk + NL + NL);
    abone.add(res);
    // Aracilar baglantiyi kesmesin diye seyrek yorum satiri (yuk uretmez)
    const kalp = setInterval(() => { try { res.write(': .' + NL + NL); } catch { /* kapandi */ } }, 25_000);
    req.on('close', () => { clearInterval(kalp); abone.delete(res); });
    return;
  }

  res.writeHead(404).end();
});

watch(PROJECTS_DIR, { recursive: true }, (_o, ad) => {
  if (ad && ad.endsWith('.jsonl')) taramayiPlanla();
});
try {
  watch(VERI_DIZINI, () => taramayiPlanla(200));
} catch { /* veri dizini henuz yok */ }

// Dosya izleme kacirirsa diye seyrek guvenlik agi
setInterval(() => taramayiPlanla(0), 15_000);

sunucu.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('Port ' + PORT + ' zaten kullanimda - panel muhtemelen calisiyor.');
    console.error('Baska port icin: SURU_PORT=7778 node src/server.js');
  } else {
    console.error('Sunucu hatasi:', e.message);
  }
  process.exit(1);
});

await tara();
try { kararlariTazele(db); } catch { /* karar tablosu bos olabilir */ }
// Kararlar kosu bitince aciliyor ama emniyet agi: dosya izleme kacirirsa da bulunsun.
setInterval(kosuSonrasi, 60_000);
kotaUygula();

sunucu.listen(PORT, '0.0.0.0', () => {
  console.log('SURU paneli calisiyor.');
  console.log('  bu makine : http://localhost:' + PORT + '/?t=' + JETON);
  console.log('  ofis      : http://localhost:' + PORT + '/ofis?t=' + JETON);
  console.log('  komuta    : http://localhost:' + PORT + '/komuta?t=' + JETON);
  console.log('  terminal  : ' + (TERMINAL_ACIK
    ? 'http://localhost:' + PORT + '/terminal?t=' + JETON + '  (ACIK - keyfi komut calistirir)'
    : 'kapali  (acmak icin SURU_TERMINAL=1)'));
  console.log('  telefondan: http://<tailscale-adin>:' + PORT + '/?t=' + JETON);
  console.log('');
  console.log('  Jeton   : ' + JETON_YOLU + ' (ilk acilista cereze yazilir)');
  console.log('  Ayarlar : ' + AYAR_YOLU);
  console.log('  Kuyruk  : es zamanli ' + kuyruk.esZamanli
    + ', cakisma: ' + kuyruk.cakismaPolitikasi + ' (SURU_ES_ZAMANLI / SURU_CAKISMA)');
  console.log('  Bildirim: ' + AYARLAR.bildirim.kanal
    + (AYARLAR.bildirim.kanal === 'gunluk' ? '  (yerel - hicbir sey makineden cikmiyor)' : ''));
  if (telegram) {
    telegram.baslat();
    const d = telegram.durum();
    console.log('  Telegram: ' + (d.eslesti ? 'eslesmis, dinliyor' : 'ESLESMEMIS - bota su kodu yaz: ' + d.kod));
  } else {
    console.log('  Telegram: kapali (ayarlar.json > telegram.token)');
  }
  console.log('  Panel oturum basliklarini gosteriyor - adresi paylasma.');
});
