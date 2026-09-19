// Suru hafizasi: her ajan SIFIR baglamla baslar ama nereye bakacagini bilir.
//
// Iki saha denemesi tasarimi belirledi:
//   1. Ajan dogru analiz yazdi ama test sayilarini UYDURDU (14 dedi, 36'ydi).
//      Ajanin raporu "bilgi" diye sonraki ajana verilirse yanlis bilgi cogalir.
//   2. Eski raporu brife TAMAMEN gomunce ajan dogru sayiyi buldu ama maliyet
//      dusmedi ve eski metni kelimesi kelimesine kopyaladi. Butun gecmisi
//      baglama basmak hem token yakar hem papaganlik uretir.
//
// Bu yuzden kurallar:
//   - Hafizaya AJAN degil SURU yazar.
//   - Her kaydin turu (olgu / yorum / yarim) ve kaynagi (arac / ajan / insan) var.
//   - KADEMELI OKUMA: sistem istemine sadece kisa bir DIZIN gider (tek satirlik
//     olgular, yarim is basliklari, ayrinti dosyalarinin yolu). Ajan raporlari
//     diskte durur; ajan ancak ihtiyac duyarsa okur. Yorum baglama gomulmez.

import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, basename, dirname, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { yolNormal } from './cakisma.js';
import { kosuGetir, isGetir, KOSU_DURUMU } from './isler.js';
import { VERI_DIZINI } from './paths.js';
import { parmakIzi } from './parmakizi.js';

export const HAFIZA_TURU = { OLGU: 'olgu', YORUM: 'yorum', YARIM: 'yarim', OZET: 'ozet' };

/**
 * Damitma isleri bu onekle baslar (bkz. damitma.js). Kullanici bu onekle is
 * olusturamaz. Damitmanin kendi sonucu 'yorum' degil 'ozet' olarak yazilir;
 * yorum olsaydi bir sonraki damitmayi tetikler, sonsuz dongu dogardi.
 */
export const DAMITMA_ONEK = '_damitma:';
export const damitmaIsiMi = (is) => !!is?.ad && String(is.ad).startsWith(DAMITMA_ONEK);
export const KAYNAK = { ARAC: 'arac', AJAN: 'ajan', INSAN: 'insan' };

const NL = String.fromCharCode(10);

// Proje basina tutulacak en fazla yorum. Olgular kirpilmaz; yorumlar eskir.
const EN_FAZLA_YORUM = 30;

export function projeAnahtari(cwd) {
  return yolNormal(cwd);
}

/**
 * Projenin ayrinti dosyalarinin klasoru. Proje deposunun ICINE yazmiyoruz:
 * kullanicinin reposunu kirletmesin. Ajan --add-dir ile okuyabiliyor.
 */
export function hafizaDizini(cwd, { kok = join(VERI_DIZINI, 'hafiza') } = {}) {
  const anahtar = projeAnahtari(cwd);
  const ad = basename(anahtar).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'proje';
  const iz = createHash('sha1').update(anahtar).digest('hex').slice(0, 8);
  return join(kok, ad + '-' + iz);
}

/** Bir yorumun ayrinti dosyasi. Kosu kimliginden turetilir: ayrica sutun gerekmez. */
export function yorumDosyasi(cwd, kosuId, secenekler) {
  return join(hafizaDizini(cwd, secenekler), 'yorum-' + kosuId + '.md');
}

/** Damitilmis proje ozetinin dosyasi. */
export function ozetDosyasi(cwd, kosuId, secenekler) {
  return join(hafizaDizini(cwd, secenekler), 'ozet-' + kosuId + '.md');
}

/**
 * Metinde sayisal iddia var mi? ("14 test", "3 dosya", "%80")
 * Saha denemesinde uydurulan tam olarak bu turdu. Kesin tespit degil,
 * isaretleme: bu kayit okunurken sayilar ayrica kontrol edilmeli.
 */
const SAYISAL = new RegExp(
  '(\\d+\\s*(test|dosya|satir|satır|modul|modül|fonksiyon|hata|adet|kez|tane|sinif|sınıf|ms|saniye))'
  + '|(%\\s*\\d+)|(\\d+\\s*%)', 'i');

export function sayisalIddiaVar(metin) {
  return SAYISAL.test(String(metin ?? ''));
}

/**
 * Metinde gecen ama dogrulanmis olgularda GECMEYEN sayilar.
 *
 * Modele "sayi tasima" demek kurali uygulatmiyor: damitma saha denemesinde
 * damitici dogrulanmamis bir rapordaki "3 daemon thread" sayisini ozete tasidi.
 * Bu denetim deterministik: model uyarsa isaret cikmaz, uymazsa okuyan bilir.
 *
 * Sayiyi tek tek karakterle degil BUTUN BELIRTEC olarak ele aliyoruz:
 * test_turkish.py ve 1.5 tek belirtectir (harf ya da ic nokta var, sayilmaz);
 * "15." ise "15" belirteci + cumle noktasidir (sayilir). Karakter bazli ilk
 * surum cumle sonundaki sayilari atliyordu: dogrulanmis 15 sahte alarm veriyor,
 * cumle sonunda uydurulan bir sayi hic yakalanmiyordu.
 * Urun adindaki sayilar (GTA 6) da isaretlenir - gurultu ama durust.
 */
const TIK_H = String.fromCharCode(96);
const KOD_PARCASI = new RegExp(TIK_H + '[^' + TIK_H + ']*' + TIK_H, 'g');
const BELIRTEC = /[A-Za-z0-9_]+([.][A-Za-z0-9_]+)*/g;
const SADECE_RAKAM = /^[0-9]+$/;

function bagimsizSayilar(metin) {
  const t = String(metin ?? '').replace(KOD_PARCASI, ' ');
  const out = [];
  for (const m of t.matchAll(BELIRTEC)) if (SADECE_RAKAM.test(m[0])) out.push(m[0]);
  return out;
}

export function dogrulanmamisSayilar(metin, olguMetinleri = []) {
  const bilinen = new Set();
  for (const o of olguMetinleri) for (const s of bagimsizSayilar(o)) bilinen.add(s);
  const out = [];
  for (const s of bagimsizSayilar(metin)) if (!bilinen.has(s) && !out.includes(s)) out.push(s);
  return out;
}

/**
 * konu: "ayni seyi soyleyen" kayitlarin anahtari (ornek 'dogrulama:<isId>'). Verilirse ayni
 * proje+tur+konu'daki eski kayitlar SILINIR: hafiza birikmez, guncellenir. Konusuz kayit eklenir.
 */
export function kayitEkle(db, { cwd, tur, icerik, kaynak, dogrulandi = false,
  uyari = null, isId = null, kosuId = null, simdi = Date.now(), iz = null, konu = null }) {
  if (!Object.values(HAFIZA_TURU).includes(tur)) throw new Error('gecersiz hafiza turu: ' + tur);
  if (!Object.values(KAYNAK).includes(kaynak)) throw new Error('gecersiz kaynak: ' + kaynak);
  if (!icerik || !String(icerik).trim()) throw new Error('hafiza icerigi bos olamaz');
  const k = {
    id: randomUUID(), proje: projeAnahtari(cwd), tur, icerik: String(icerik).trim(),
    kaynak, dogrulandi: dogrulandi ? 1 : 0, uyari, isId, kosuId, olusturuldu: simdi,
    parmakIzi: iz, konu: konu ? String(konu) : null,
  };
  if (k.konu) db.prepare('DELETE FROM hafiza WHERE proje = ? AND tur = ? AND konu = ?').run(k.proje, k.tur, k.konu);
  db.prepare(`INSERT INTO hafiza (id, proje, tur, icerik, kaynak, dogrulandi, uyari,
              is_id, kosu_id, olusturuldu, parmak_izi, konu) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(k.id, k.proje, k.tur, k.icerik, k.kaynak, k.dogrulandi, k.uyari, k.isId, k.kosuId,
      k.olusturuldu, k.parmakIzi, k.konu);
  return k;
}

const coz = (r) => r && {
  id: r.id, proje: r.proje, tur: r.tur, icerik: r.icerik, kaynak: r.kaynak,
  dogrulandi: !!r.dogrulandi, uyari: r.uyari, isId: r.is_id, kosuId: r.kosu_id,
  olusturuldu: r.olusturuldu, kapandi: r.kapandi, parmakIzi: r.parmak_izi, konu: r.konu ?? null,
};

/** Bir projenin kayitlari, yeniden eskiye. sadeceAcik: kapanmamis 'yarim' kayitlar. */
export function kayitlar(db, { cwd, tur = null, sadeceAcik = false, limit = 100 } = {}) {
  const kosul = ['proje = ?'], arg = [projeAnahtari(cwd)];
  if (tur) { kosul.push('tur = ?'); arg.push(tur); }
  if (sadeceAcik) kosul.push('kapandi IS NULL');
  arg.push(limit);
  return db.prepare('SELECT * FROM hafiza WHERE ' + kosul.join(' AND ')
    + ' ORDER BY olusturuldu DESC LIMIT ?').all(...arg).map(coz);
}

export function kayitSil(db, id) {
  db.prepare('DELETE FROM hafiza WHERE id = ?').run(id);
}

/** Insanin bildigi kesin bilgi: dogrulanmis olgu olarak girer. */
export function insanOlgusu(db, { cwd, icerik, konu = null }) {
  // Iz saklanir ama insan olgusu bayat isaretlenmez: standart ve kurallar
  // kodla degil kararla degisir (bkz. hafizaIstemi).
  // Konu verilmezse metnin kendisi anahtardir: ayni cumle iki kez yazilirsa tek kayit kalir.
  // "konu: metin" bicimi (ornek "test komutu: python -m unittest") ayni konudaki eski beyani ezer.
  const metin = String(icerik ?? '').trim();
  const m = /^([^:]{2,40}):\s+\S/.exec(metin);
  const anahtar = 'insan:' + String(konu ?? (m ? m[1] : metin)).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
  return kayitEkle(db, { cwd, tur: HAFIZA_TURU.OLGU, icerik: metin, kaynak: KAYNAK.INSAN,
    dogrulandi: true, iz: parmakIzi(cwd), konu: anahtar });
}

/**
 * Insan olgusunu konuyla siler (/unut <proje> <konu>). Konu, insanOlgusu'nun anahtar kuralıyla aynı:
 * "konu: metin" bicimindeki kaydin konusu ya da metnin kendisi. Tam eslesme yoksa konu ile BASLAYAN
 * tek kayit da kabul edilir; birden fazla eslesirse silinmez (yanlis silme geri alinamaz).
 * Doner: silinen kayitlar.
 */
export function insanOlgusuSil(db, { cwd, konu }) {
  const k = String(konu ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!k) throw new Error('konu bos');
  const proje = projeAnahtari(cwd);
  const hepsi = db.prepare("SELECT * FROM hafiza WHERE proje = ? AND tur = 'olgu' AND kaynak = 'insan'").all(proje).map(coz);
  let e = hepsi.filter((r) => r.konu === 'insan:' + k.slice(0, 80));
  if (!e.length) e = hepsi.filter((r) => (r.konu ?? '').startsWith('insan:' + k) || r.icerik.toLowerCase().startsWith(k));
  if (!e.length) throw new Error('boyle bir insan olgusu yok: ' + konu);
  if (e.length > 1) throw new Error(konu + ' birden fazla kayitla eslesiyor (' + e.length + '), konuyu tam yaz');
  kayitSil(db, e[0].id);
  return e;
}

/** Arac olcumu olgusu: olculdugu anin parmak iziyle. */
export function aracOlgusu(db, { cwd, icerik, isId = null, kosuId = null }) {
  return kayitEkle(db, { cwd, tur: HAFIZA_TURU.OLGU, icerik, kaynak: KAYNAK.ARAC,
    dogrulandi: true, isId, kosuId, iz: parmakIzi(cwd) });
}

/** Ajan raporunu diske yazar. Basligi DOGRULANMAMIS oldugunu okuyana soyler. */
function yorumDosyasiYaz(is, kosu, metin, uyari, { kok } = {}) {
  const dizin = hafizaDizini(is.cwd, kok ? { kok } : undefined);
  mkdirSync(dizin, { recursive: true });
  const yol = yorumDosyasi(is.cwd, kosu.id, kok ? { kok } : undefined);
  const baslik = [
    '# DOGRULANMAMIS ajan raporu',
    '',
    '- is: ' + is.ad,
    '- kosu: ' + kosu.id,
    '- tarih: ' + new Date().toISOString(),
    uyari ? '- UYARI: ' + uyari : null,
    '',
    'Bu metin bir ajanin iddiasidir, olcum degildir. Icindeki sayilari, dosya',
    'adlarini ve sonuclari kullanmadan once kendin dogrula.',
    '',
    '---',
    '',
  ].filter((x) => x !== null).join(NL);
  writeFileSync(yol, baslik + metin + NL, 'utf8');
  return yol;
}

/**
 * Damitma kosusundan ogrenme. Sadece BASARILI damitma iz birakir: yarim kalan
 * bir damitma ham raporlari kapatirsa o bilgi kaybolur.
 *
 * Kapatilan raporlar: damitma kosusu BASLAMADAN once olusmus acik yorumlar.
 * Damitma surerken gelen yeni rapor acik kalir - damitici onu gormedi.
 */
function damitmadanOgren(db, is, kosu, { simdi = Date.now(), kok = null } = {}) {
  if (kosu.durum !== KOSU_DURUMU.BITTI || !kosu.sonuc || !String(kosu.sonuc).trim()) return 0;
  const onceden = db.prepare("SELECT COUNT(*) n FROM hafiza WHERE kosu_id = ? AND tur = 'ozet'").get(kosu.id);
  if (Number(onceden?.n ?? 0) > 0) return 0;

  const metin = String(kosu.sonuc).trim();
  const sec = kok ? { kok } : undefined;
  // Ozetteki her sayi dogrulanmis bir olgudan gelmeli; gelmeyenler isaretlenir.
  const olguMetinleri = kayitlar(db, { cwd: is.cwd, tur: HAFIZA_TURU.OLGU, limit: 100 }).map((o) => o.icerik);
  const yabanci = dogrulanmamisSayilar(metin, olguMetinleri);
  const uyari = yabanci.length ? 'dogrulanmamis sayi iceriyor: ' + yabanci.slice(0, 8).join(', ') : null;
  try {
    mkdirSync(hafizaDizini(is.cwd, sec), { recursive: true });
    const baslik = [
      '# DAMITILMIS proje ozeti (DOGRULANMAMIS)',
      '',
      '- kosu: ' + kosu.id,
      '- tarih: ' + new Date(simdi).toISOString(),
      uyari ? '- UYARI: ' + uyari + ' (olcumle gelmedi, kullanmadan once dogrula)' : null,
      '',
      'Onceki ajan raporlarindan ucuz bir modelle damitildi. Raporlar dogrulanmamisti,',
      'bu ozet de oyle. Kullanmadan once kaynak dosyalarda dogrula.',
      '',
      '---',
      '',
    ].filter((x) => x !== null).join(NL);
    writeFileSync(ozetDosyasi(is.cwd, kosu.id, sec), baslik + metin + NL, 'utf8');
  } catch { return 0; }   // dosya yazilamadiysa raporlari kapatma: bilgi kaybolmasin

  const proje = projeAnahtari(is.cwd);
  kayitEkle(db, { cwd: is.cwd, tur: HAFIZA_TURU.OZET, kaynak: KAYNAK.AJAN, dogrulandi: false,
    isId: is.id, kosuId: kosu.id, simdi, icerik: metin.slice(0, 1500), iz: parmakIzi(is.cwd),
    uyari });

  const esik = kosu.basladi ?? simdi;
  db.prepare(`UPDATE hafiza SET kapandi = ? WHERE proje = ? AND tur = 'yorum'
              AND kapandi IS NULL AND olusturuldu <= ?`).run(simdi, proje, esik);
  // Sadece en guncel ozet dizinde durur.
  db.prepare(`UPDATE hafiza SET kapandi = ? WHERE proje = ? AND tur = 'ozet'
              AND kapandi IS NULL AND kosu_id != ?`).run(simdi, proje, kosu.id);
  return 1;
}

/**
 * Biten bir kosudan ogrenir. Idempotent: ayni kosudan iki kez ogrenmez.
 * Doner: eklenen kayit sayisi.
 */
export function kosudanOgren(db, kosuId, { simdi = Date.now(), kok = null } = {}) {
  const kosu = kosuGetir(db, kosuId);
  if (!kosu) return 0;
  const is = isGetir(db, kosu.isId);
  if (!is) return 0;

  // Damitma kosusu ayri yoldan ogrenir: sonucu 'ozet' olur, ham raporlari kapatir.
  if (damitmaIsiMi(is)) return damitmadanOgren(db, is, kosu, { simdi, kok });
  // Diger ic isler (denetci gibi) hafizaya ham yorum birakmaz: bulgulari dongu tasir,
  // yorum olsaydi damitmayi da gereksiz yere tetiklerdi.
  if (String(is.ad).startsWith('_')) return 0;

  const onceden = db.prepare(
    "SELECT COUNT(*) n FROM hafiza WHERE kosu_id = ? AND tur != 'yarim'").get(kosuId);
  if (Number(onceden?.n ?? 0) > 0) return 0;

  // Kosu bittigi andaki proje: bu kosudan cikan olgular bu ize baglanir.
  const ortak = { cwd: is.cwd, isId: is.id, kosuId, simdi, iz: parmakIzi(is.cwd) };
  let n = 0;

  // Olgu: dogrulama komutunun sonucu. Bir aracin cikis kodu - guvenilir.
  if (kosu.dogrulamaKod != null) {
    // konu: isin SON dogrulama sonucu tek kayittir; her kosu bir oncekini ezer.
    kayitEkle(db, { ...ortak, tur: HAFIZA_TURU.OLGU, kaynak: KAYNAK.ARAC, dogrulandi: true,
      konu: 'dogrulama:' + is.id,
      // SONUC BASTA: brif satiri 180 karakterde kirpiliyor; uzun komut sonucu (asil bilgiyi) kesip atiyordu.
      icerik: '"' + is.ad + '" dogrulamasi '
        + (kosu.dogrulamaKod === 0 ? 'GECTI' : 'GECMEDI (cikis kodu ' + kosu.dogrulamaKod + ')')
        + '. Komut: ' + (is.dogrulama ?? '?') });
    n++;
  }

  // Olgu: kosu hatayla bittiyse hata mesaji. Gozlenmis bir durum.
  if (kosu.durum === KOSU_DURUMU.HATA && kosu.hata) {
    kayitEkle(db, { ...ortak, tur: HAFIZA_TURU.OLGU, kaynak: KAYNAK.ARAC, dogrulandi: true,
      konu: 'hata:' + is.id,
      icerik: '"' + is.ad + '" hatayla bitti: ' + String(kosu.hata).replace(/\s+/g, ' ').slice(0, 200) });
    n++;
  } else if (kosu.durum === KOSU_DURUMU.BITTI) {
    // Is basariyla bitti: "hatayla bitti" olgusu artik YANLIS bilgi. Guncellenen bilgi silinir.
    db.prepare("DELETE FROM hafiza WHERE proje = ? AND tur = 'olgu' AND konu = ?")
      .run(projeAnahtari(is.cwd), 'hata:' + is.id);
  }

  // Yorum: ajanin raporu. Veritabaninda kisa ozet, tam metin DOSYADA.
  if (kosu.sonuc && String(kosu.sonuc).trim()) {
    const metin = String(kosu.sonuc).trim();
    const uyari = sayisalIddiaVar(metin) ? 'sayisal iddia iceriyor - sayilari yeniden olc' : null;
    try { yorumDosyasiYaz(is, kosu, metin, uyari, { kok }); } catch { /* dosya yazilamadi, ozet yine kalir */ }
    kayitEkle(db, { ...ortak, tur: HAFIZA_TURU.YORUM, kaynak: KAYNAK.AJAN, dogrulandi: false,
      uyari, icerik: metin.slice(0, 1500) });
    n++;
  }

  // Yarim kalan is: karara dustu ya da hata verdi. Basariyla bitince kapanir.
  const acikYarim = db.prepare(
    "SELECT id FROM hafiza WHERE tur = 'yarim' AND is_id = ? AND kapandi IS NULL").all(is.id);
  if (kosu.durum === KOSU_DURUMU.BITTI) {
    for (const r of acikYarim) {
      db.prepare('UPDATE hafiza SET kapandi = ? WHERE id = ?').run(simdi, r.id);
    }
  } else if ((kosu.durum === KOSU_DURUMU.KARAR_BEKLIYOR || kosu.durum === KOSU_DURUMU.HATA)
             && acikYarim.length === 0) {
    kayitEkle(db, { ...ortak, tur: HAFIZA_TURU.YARIM, kaynak: KAYNAK.ARAC, dogrulandi: true,
      icerik: '"' + is.ad + '" yarim kaldi (' + kosu.durum + ').' });
    n++;
  }

  // Eski yorumlari kirp: ajan gorusu eskir, olgular kalir.
  const proje = projeAnahtari(is.cwd);
  db.prepare(`DELETE FROM hafiza WHERE tur = 'yorum' AND proje = ? AND id NOT IN (
                SELECT id FROM hafiza WHERE tur = 'yorum' AND proje = ?
                ORDER BY olusturuldu DESC LIMIT ?)`).run(proje, proje, EN_FAZLA_YORUM);
  return n;
}

/**
 * Raporun dosyasi diskte yoksa veritabanindaki ozetten yeniden kurar.
 * Doner: dosya yolu, ya da kurulamazsa null (o zaman dizinde GOSTERILMEZ).
 *
 * Gercek veride yakalandi: dosyaya yazmayan eski surumle ogrenilen raporlar
 * icin dizin ajani OLMAYAN dosyalara yolluyordu. Ayrica kosudanOgren dosya
 * yazma hatasini yutuyor; disk ya da izin sorunu ayni kopuk baglantiyi her
 * zaman uretebilir. Olu baglanti, hic baglanti vermemekten kotu.
 */
function raporDosyasiniGarantile(is, y, { kok = null } = {}) {
  if (!y.kosuId) return null;
  const sec = kok ? { kok } : undefined;
  const yol = yorumDosyasi(is.cwd, y.kosuId, sec);
  if (existsSync(yol)) return yol;
  try {
    mkdirSync(hafizaDizini(is.cwd, sec), { recursive: true });
    const baslik = [
      '# DOGRULANMAMIS ajan raporu (veritabanindaki ozetten yeniden kuruldu)',
      '',
      '- kosu: ' + y.kosuId,
      '- tarih: ' + new Date(y.olusturuldu).toISOString(),
      y.uyari ? '- UYARI: ' + y.uyari : null,
      '',
      'Tam metin kayip; asagidaki en fazla ilk 1500 karakter. Icindeki sayilari',
      've iddialari kullanmadan once kendin dogrula.',
      '',
      '---',
      '',
    ].filter((x) => x !== null).join(NL);
    writeFileSync(yol, baslik + y.icerik + NL, 'utf8');
    return yol;
  } catch {
    return null;
  }
}

/** Tek satira indirir: dizin kisa kalsin. */
const tekSatir = (m, n) => {
  const t = String(m).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/**
 * Sonraki kosuya verilecek hafiza DIZINI. Kayit yoksa null.
 *
 * Kasitli olarak kucuk: olgular tek satir, yarim isler baslik, ajan raporlari
 * sadece DOSYA YOLU. Ayrintiyi ajan ihtiyac duyarsa okur. Butun gecmisi
 * baglama basmak token yakiyor ve ajanin eski metni kopyalamasina yol aciyor.
 */
export function hafizaIstemi(db, is, { enFazlaOlgu = 8, enFazlaYorum = 3,
  enFazlaKarakter = 1500, kok = null } = {}) {
  if (!is?.cwd) return null;
  // Insan beyani once: kural/standart, arac olcumlerinin kalabaligi yuzunden brifin disinda kalmasin.
  const tumOlgular = kayitlar(db, { cwd: is.cwd, tur: HAFIZA_TURU.OLGU, limit: 60 });
  const olgular = [...tumOlgular.filter((o) => o.kaynak === KAYNAK.INSAN), ...tumOlgular.filter((o) => o.kaynak !== KAYNAK.INSAN)]
    .slice(0, enFazlaOlgu);
  const yarimlar = kayitlar(db, { cwd: is.cwd, tur: HAFIZA_TURU.YARIM, sadeceAcik: true, limit: 5 });
  // Sadece KAPANMAMIS raporlar: damitilanlar ozetle temsil ediliyor.
  const yorumlar = kayitlar(db, { cwd: is.cwd, tur: HAFIZA_TURU.YORUM, sadeceAcik: true, limit: enFazlaYorum });
  const [ozet] = kayitlar(db, { cwd: is.cwd, tur: HAFIZA_TURU.OZET, sadeceAcik: true, limit: 1 });

  if (!olgular.length && !yarimlar.length && !yorumlar.length && !ozet) return null;

  const tarih = (ms) => new Date(ms).toISOString().slice(0, 10);
  const s = ['# Suru hafizasi (dizin)'];

  if (olgular.length) {
    // Bayatlama: arac olcumu, olculdugu andan beri proje degistiyse artik
    // guvenilir degil. Insan olgusu (kural, standart) kodla eskimez.
    const simdikiIz = parmakIzi(is.cwd);
    s.push('Kesin bilgiler (olcum ya da insan beyani):');
    for (const o of olgular) {
      const bayat = o.kaynak === KAYNAK.ARAC && o.parmakIzi && simdikiIz && o.parmakIzi !== simdikiIz;
      const ek = bayat ? ' [kod o zamandan beri degisti, eski olabilir]' : '';
      s.push('- ' + tekSatir(o.icerik, 180 - ek.length) + ek);
    }
  }
  if (yarimlar.length) {
    s.push('Yarim isler:');
    for (const y of yarimlar) s.push('- ' + tekSatir(y.icerik, 120));
  }
  // Damitilmis ozet: gecmis raporlarin kisa hali. Yine DOGRULANMAMIS.
  if (ozet) {
    const oyol = ozetDosyasi(is.cwd, ozet.kosuId, kok ? { kok } : undefined);
    if (existsSync(oyol)) {
      const isaret = ozet.uyari ? ' [' + ozet.uyari.replace(' iceriyor: ', ': ') + ']' : '';
      s.push('Proje ozeti (onceki raporlardan damitilmis, DOGRULANMAMIS)' + isaret + ': ' + oyol);
    }
  }

  // Yalnizca diskte gercekten var olan (ya da yeniden kurulabilen) raporlar.
  const raporlar = [];
  for (const y of yorumlar) {
    const yol = raporDosyasiniGarantile(is, y, { kok });
    if (yol) raporlar.push({ y, yol });
  }
  if (raporlar.length) {
    // Klasor bir kez yazilir, satirlarda sadece dosya adi durur: ayni bilgi ~180
    // karakter yerine ~20 karaktere sigar (klasor zaten --add-dir ile ekli).
    s.push('Onceki ajan raporlari - DOGRULANMAMIS. Gerekirse oku; sayilari kendin olc.');
    s.push('Klasor: ' + dirname(raporlar[0].yol));
    for (const { y, yol } of raporlar) {
      // Konu, ajanin raporundan DEGIL o kosunun gorevinden gelir: gorev Suru'nun
      // kendi verisi, dogrulanmamis bir iddia degil. Ajan boylece dosyayi acmadan
      // ilgili olup olmadigina karar verir.
      const konu = raporKonusu(db, y.isId);
      s.push('- ' + basename(yol) + ' (' + tarih(y.olusturuldu) + (y.uyari ? ', sayisal iddia' : '')
        + (konu ? ') gorev: ' + konu : ')'));
    }
  }

  // Sadece baslik kaldiysa (butun raporlar kurulamadi) dizin vermeye degmez.
  if (s.length === 1) return null;

  let metin = s.join(NL);
  if (metin.length > enFazlaKarakter) metin = metin.slice(0, enFazlaKarakter) + NL + '...(kirpildi)';
  return metin;
}

/**
 * Raporun konusu: o kosunun gorevi. Ajanin iddiasi degil, isin tanimi - bu yuzden
 * isteme dogrudan girebilir. Is silinmisse null.
 */
function raporKonusu(db, isId, n = 100) {
  if (!isId) return null;
  try {
    const r = db.prepare('SELECT gorev FROM isler WHERE id = ?').get(isId);
    return r?.gorev ? tekSatir(r.gorev, n) : null;
  } catch { return null; }
}

/** Ajanin ayrinti dosyalarini okuyabilmesi icin eklenecek klasor (varsa). */
export function okumaDizini(is, { kok = null } = {}) {
  const d = hafizaDizini(is.cwd, kok ? { kok } : undefined);
  return existsSync(d) ? d : null;
}

/**
 * Hafiza budamasi: "her seyi kaydetme, guncelleneni sil". Sunucu acilista ve gunde bir cagirir.
 *
 * Olcum (2026-09-17, 211 kayit): cogu OLU projelere aitti (sinav senaryolarinin gecici
 * klasorleri) ve ayni isin dogrulama sonucu her kosuda yeniden yazilmisti. Kurallar:
 *   1. Klasoru artik olmayan projenin butun hafizasi ve rapor klasoru silinir. Surucusu
 *      takili olmayan yol (cikarilmis disk) OLU SAYILMAZ - kok yoksa dokunulmaz.
 *   1b. GECICI dizindeki (os.tmpdir) ve artik hicbir isi olmayan proje SAHIPSIZDIR: klasoru dursa
 *      da hafizasi silinir. Olcum: 190 kaydin 122'si %TEMP%/suru-sinav-* altindaki 60 sahte
 *      "projeye" aitti (sinav klasorlerini birakiyor), 29'u eski bir oturumun scratchpad'ine.
 *   2. Ayni proje+tur+konu'dan en yenisi kalir (goc oncesi kayitlarin kopyalari).
 *   3. Bayat arac olgusu (parmak izi degismis) 'gun' gunden eskiyse silinir: brifte zaten
 *      "eski olabilir" diye isaretleniyordu; bir sure sonra hic tasimamak daha durust.
 *   4. Proje basina en fazla 'enFazlaOlgu' arac olgusu (en yeniler). Insan olgusu sayilmaz, silinmez.
 *   5. Kapanmis (damitilmis) rapor ve eski ozetler 'gun' gunden eskiyse dosyasiyla birlikte silinir.
 * Doner: kural basina silinen kayit sayisi.
 */
export function budama(db, { simdi = Date.now(), gun = 30, enFazlaOlgu = 20, kok = null,
  varMi = existsSync, izAl = parmakIzi, geciciKok = tmpdir() } = {}) {
  const sec = kok ? { kok } : undefined;
  const sayac = { yenidenYazilan: 0, oluProje: 0, sahipsiz: 0, kopya: 0, bayat: 0, tasan: 0, eskiRapor: 0, projeler: [] };
  const gecici = geciciKok ? projeAnahtari(geciciKok) + '/' : null;
  const isiOlan = new Set(db.prepare('SELECT DISTINCT cwd FROM isler').all().map((r) => projeAnahtari(r.cwd)));
  const esik = simdi - gun * 24 * 3600_000;
  const sil = db.prepare('DELETE FROM hafiza WHERE id = ?');
  const dosyaSil = (yol) => { try { rmSync(yol, { force: true }); } catch { /* zaten yok */ } };

  // 0. Eski bicimli dogrulama olgulari: sonuc sonda, brifte kirpiliyordu -> sonuc basa.
  const ESKI = /^("[^"]*" dogrulamasi) \(([\s\S]*)\) (GECTI|GECMEDI, cikis kodu (\d+))\.$/;
  for (const r of db.prepare(`SELECT id, icerik FROM hafiza WHERE tur = 'olgu' AND konu LIKE 'dogrulama:%' AND icerik LIKE '%" dogrulamasi (%'`).all()) {
    const m = ESKI.exec(r.icerik);
    if (!m) continue;
    db.prepare('UPDATE hafiza SET icerik = ? WHERE id = ?').run(
      m[1] + ' ' + (m[4] ? 'GECMEDI (cikis kodu ' + m[4] + ')' : 'GECTI') + '. Komut: ' + m[2], r.id);
    sayac.yenidenYazilan++;
  }

  for (const { proje } of db.prepare('SELECT DISTINCT proje FROM hafiza').all()) {
    // 1. Olu proje
    const kokYol = parse(proje).root;
    if (kokYol && varMi(kokYol) && !varMi(proje)) {
      const n = db.prepare('DELETE FROM hafiza WHERE proje = ?').run(proje).changes;
      sayac.oluProje += Number(n);
      sayac.projeler.push(proje);
      try { rmSync(hafizaDizini(proje, sec), { recursive: true, force: true }); } catch { /* klasor yoksa sorun degil */ }
      continue;
    }
    if (!varMi(proje)) continue;   // kok de yok: disk takili degil, dokunma

    // 1b. Gecici dizinde, isi kalmamis proje
    if (gecici && proje.startsWith(gecici) && !isiOlan.has(proje)) {
      sayac.sahipsiz += Number(db.prepare('DELETE FROM hafiza WHERE proje = ?').run(proje).changes);
      sayac.projeler.push(proje);
      try { rmSync(hafizaDizini(proje, sec), { recursive: true, force: true }); } catch { /* klasor yoksa sorun degil */ }
      continue;
    }

    // 2. Konu kopyalari: en yenisi kalir
    const gorulen = new Set();
    for (const r of db.prepare("SELECT id, tur, konu FROM hafiza WHERE proje = ? AND konu IS NOT NULL ORDER BY olusturuldu DESC").all(proje)) {
      const a = r.tur + '|' + r.konu;
      if (gorulen.has(a)) { sil.run(r.id); sayac.kopya++; } else gorulen.add(a);
    }

    // 3. Bayat arac olgulari
    let iz = null;
    try { iz = izAl(proje); } catch { /* olculemedi: bayat diyemeyiz */ }
    if (iz) {
      for (const r of db.prepare("SELECT id FROM hafiza WHERE proje = ? AND tur = 'olgu' AND kaynak = 'arac' AND parmak_izi IS NOT NULL AND parmak_izi != ? AND olusturuldu < ?").all(proje, iz, esik)) {
        sil.run(r.id); sayac.bayat++;
      }
    }

    // 4. Ust sinir (arac olgulari)
    for (const r of db.prepare("SELECT id FROM hafiza WHERE proje = ? AND tur = 'olgu' AND kaynak = 'arac' ORDER BY olusturuldu DESC LIMIT -1 OFFSET ?").all(proje, enFazlaOlgu)) {
      sil.run(r.id); sayac.tasan++;
    }

    // 5. Kapanmis eski rapor/ozet: kayit + dosya
    for (const r of db.prepare("SELECT id, tur, kosu_id FROM hafiza WHERE proje = ? AND tur IN ('yorum','ozet','yarim') AND kapandi IS NOT NULL AND kapandi < ?").all(proje, esik)) {
      if (r.kosu_id && r.tur === 'yorum') dosyaSil(yorumDosyasi(proje, r.kosu_id, sec));
      if (r.kosu_id && r.tur === 'ozet') dosyaSil(ozetDosyasi(proje, r.kosu_id, sec));
      sil.run(r.id); sayac.eskiRapor++;
    }
  }
  sayac.toplam = sayac.oluProje + sayac.sahipsiz + sayac.kopya + sayac.bayat + sayac.tasan + sayac.eskiRapor;
  return sayac;
}
