// Komut katmani: telefondan (Telegram) ya da panelden gelen KISA metin komutlarini
// Suru eylemlerine cevirir. Kanal bagimsiz: Telegram, panel komut satiri ve ileride
// baska bir kanal AYNI ayristiriciyi kullanir - iki ayri komut seti bakimi yok.
//
// Tasarim:
//   - Kimlikler telefonda yazilmaz: kisa onek (ilk 6 karakter) yeter, tek eslesme sart.
//   - Her komut tek satir; cikti duz metin (Telegram'da da panelde de okunur).
//   - Komut motoru DB'yi degistiren islemleri eskalasyon/kuyruk uzerinden yapar;
//     kendi basina hicbir sey uydurmaz.

import { basename } from 'node:path';
import { bekleyenKararlar, kararKarti, cevapla, iptalEt, kabulEt, kapsamGenislet, planUygula } from './eskalasyon.js';
import { isListesi, isGetir, isEkle, isSil, acikKosular, kosuGetir, KOSU_DURUMU } from './isler.js';
import { kimlikCoz } from './kisilik.js';
import { insanOlgusu, insanOlgusuSil, kayitlar as hafizaKayitlari, HAFIZA_TURU, KAYNAK } from './hafiza.js';
import { profilAl } from './yetki.js';
import { kosuListesi, kosuAyrintisi } from './komuta.js';
import { projeModelRaporu } from './karne.js';
import { sablondanIs, sablonListesi } from './sablon.js';
import { oneriler, oneriBul, oneriKapat } from './oneri.js';

const NL = String.fromCharCode(10);
export const KISA = 6;
export const kisa = (id) => String(id ?? '').slice(0, KISA);

export const YARDIM = [
  '/durum            calisan ajanlar, kuyruk, acik kararlar',
  '/ozet             butun masalarin tek satirlik durumu',
  '/akis <is> [n]    isin son kosusundan son n (10) anlati satiri',
  '/kararlar         acik kararlar ve secenekleri',
  '/cevap <k> <n|metin>  karari secenek numarasi ya da serbest metinle cevapla',
  '/isler            tanimli isler',
  '/sira <is>        isi kuyruga al',
  '/durdur <kosu|is> kosuyu (ya da isin tum kosularini) durdur',
  '/talimat <is> <metin>  calisan ajana ARA TALIMAT (kosu surerken gorur); bitmisse ayni oturumdan devam ettirir',
  '/fork <is>        isin son oturumundan dallanma komutu (kendi terminalinde devral)',
  '/sil <is>         isi sil (kosulari durdurur, acik kararlarini kapatir)',
  '/yeni <proje> | <gorev>   bilinen projede yeni is ac ve kuyruga al',
  '/yeni <proje> #<sablon> [| ek]   sablondan is ac (/sablonlar)',
  '/sablonlar        is sablonlari',
  '/not <proje> <metin>      projeye kalici kural/bilgi yaz ("konu: metin" ayni konudaki eskisini ezer)',
  '/unut <proje> <konu>      insan olgusunu sil (/notlar ile konulari gor)',
  '/notlar <proje>   projenin insan olgulari',
  '/rapor [gun]      proje x model x basari tablosu (varsayilan 90 gun)',
  '/oneriler         ajanlarin onerdigi sonraki adimlar; /oneri-ac <id> is olarak acar, /oneri-gec <id> gecer',
  '/yardim',
].join(NL);

/** Bir isin son kosusunun son satirlari (Telegram /akis). */
export function akisMetni(db, is, { satir = 10 } = {}) {
  const k = db.prepare('SELECT * FROM kosular WHERE is_id = ? ORDER BY basladi DESC LIMIT 1').get(is.id);
  if (!k) throw new Error('bu is hic kosmamis: akis yok');
  const a = kosuAyrintisi(db, { id: k.id, oturum: k.session_id, basladi: k.basladi }, { satir: Math.max(1, Math.min(50, satir)) });
  const bas = is.ad + ' · ' + k.durum + ' · $' + Number(k.usd ?? 0).toFixed(2) + '  [' + kisa(k.id) + ']';
  if (!a.satirlar.length) return bas + NL + '(anlatilacak satir yok)';
  const saat = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  return bas + NL + a.satirlar.map((s) => saat(s.at) + ' ' + s.metin).join(NL);
}

/** Butun masalarin bir satirlik durumu (Telegram /ozet). */
export function ozetMetni(db, { simdi = Date.now() } = {}) {
  const liste = kosuListesi(db, { simdi, enFazla: 8 });
  if (!liste.length) return 'masalar bos: son 6 saatte kosu yok';
  const sonSatir = (k) => {
    const a = kosuAyrintisi(db, k, { satir: 6 });
    for (let i = a.satirlar.length - 1; i >= 0; i--) if (a.satirlar[i].ton === 'arac' || a.satirlar[i].ton === 'soz' || a.satirlar[i].ton === 'iyi' || a.satirlar[i].ton === 'kotu') return a.satirlar[i].metin;
    return a.satirlar.length ? a.satirlar[a.satirlar.length - 1].metin : '';
  };
  return liste.map((k) => k.ajan.simge + ' ' + k.ajan.ad + ' · ' + (k.is?.ad ?? '?') + ' · ' + k.durum
    + (k.durum === KOSU_DURUMU.CALISIYOR ? ' ' + sure(simdi - k.basladi) : '') + ' · ' + para(Math.max(k.usd || 0, k.usdCanli || 0))
    + '  [' + kisa(k.id) + ']' + NL + '   ' + (sonSatir(k) || '–').slice(0, 90)).join(NL);
}

/** Proje x model x basari (Telegram /rapor). Veri azsa bunu soyler, uydurmaz. */
export function raporMetni(db, { gun = 90 } = {}) {
  const r = projeModelRaporu(db, { gun });
  if (!r.length) return 'son ' + gun + ' gunde modeli olculmus kosu yok';
  const kisaModel = (m) => String(m).replace(/^claude-/, '').replace(/-\d{8}$/, '');
  const satirlar = ['proje · rol · model: kosu, gecti/kaldi/insana, ort $ (son ' + gun + ' gun)'];
  for (const g of r) {
    satirlar.push(g.proje + ' · ' + g.rol + ' · ' + kisaModel(g.model) + ': ' + g.kosu + ' kosu, '
      + g.gecti + '/' + g.kaldi + '/' + g.insana + ', ' + para(g.ortalamaUsd)
      + (g.kosu < 5 ? ' (veri az)' : ''));
  }
  return satirlar.join(NL);
}

/**
 * Isin son oturumundan DALLANMA komutu: ajanin bildigi her seyi bilen yeni bir etkilesimli oturum,
 * asil oturumu bozmadan (--fork-session). Olcum: maliyet kazandirmaz; sureklilik ozelligidir.
 */
export function forkKomutu(db, is) {
  const k = db.prepare('SELECT session_id s FROM kosular WHERE is_id = ? AND session_id IS NOT NULL AND basladi IS NOT NULL ORDER BY basladi DESC LIMIT 1').get(is.id);
  if (!k) throw new Error('bu is hic kosmamis: dallanacak oturum yok');
  const komut = 'claude --resume ' + k.s + ' --fork-session';
  return { komut, cwd: is.cwd, metin: 'dallanma komutu (' + is.ad + '):' + NL + 'cd "' + is.cwd + '"' + NL + komut };
}

/** Kisa onekle tek kayit bulur. Yoksa ya da birden fazlaysa acik hata: yanlis kosu durdurulmasin. */
export function onekleBul(liste, onek, { alan = 'id', ad = 'kayit' } = {}) {
  const o = String(onek ?? '').trim().toLowerCase();
  if (!o) throw new Error(ad + ' kimligi eksik');
  const e = liste.filter((x) => String(x[alan]).toLowerCase().startsWith(o));
  if (e.length === 1) return e[0];
  if (!e.length) throw new Error(ad + ' bulunamadi: ' + onek);
  throw new Error(onek + ' birden fazla ' + ad + ' ile eslesiyor, daha uzun yaz');
}

/** Isi kisa kimlik YA DA adiyla bulur (adda buyuk/kucuk harf farki yok). */
export function isBul(db, anahtar) {
  const liste = isListesi(db).filter((i) => !String(i.ad).startsWith('_'));
  const a = String(anahtar ?? '').trim().toLowerCase();
  const adla = liste.filter((i) => i.ad.toLowerCase() === a);
  if (adla.length === 1) return adla[0];
  // Kartlarda ve /yeni cevabinda gorunen kod KOSU kodudur: onu da kabul et (canli deneme yakaladi).
  if (/^[0-9a-f-]{4,}$/.test(a)) {
    const k = db.prepare('SELECT is_id i FROM kosular WHERE id LIKE ? LIMIT 2').all(a + '%');
    const is = k.length === 1 && liste.find((i) => i.id === k[0].i);
    if (is) return is;
  }
  return onekleBul(liste, anahtar, { ad: 'is' });
}

/**
 * Bilinen projeler: tanimli islerin klasorleri. Telefondan tam yol yazilmaz;
 * klasor adi (basename) ya da is adiyla eslestirilir.
 */
export function projeler(db) {
  const m = new Map();
  for (const i of isListesi(db)) {
    if (String(i.ad).startsWith('_')) continue;
    const ad = basename(i.cwd);
    const p = m.get(i.cwd) ?? { cwd: i.cwd, ad, isler: [] };
    p.isler.push(i);
    m.set(i.cwd, p);
  }
  return [...m.values()];
}

export function projeBul(db, anahtar) {
  const a = String(anahtar ?? '').trim().toLowerCase();
  if (!a) throw new Error('proje adi eksik');
  const p = projeler(db);
  const tam = p.filter((x) => x.ad.toLowerCase() === a || x.cwd.toLowerCase() === a);
  if (tam.length === 1) return tam[0];
  const onek = p.filter((x) => x.ad.toLowerCase().startsWith(a));
  if (onek.length === 1) return onek[0];
  if (!onek.length) throw new Error('bilinen proje yok: ' + anahtar + ' (once panelden bu klasorde bir is tanimla)');
  throw new Error(anahtar + ' birden fazla projeyle eslesiyor: ' + onek.map((x) => x.ad).join(', '));
}

const sure = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? s + ' sn' : s < 3600 ? Math.floor(s / 60) + ' dk' : (s / 3600).toFixed(1) + ' sa';
};
const para = (u) => '$' + Number(u ?? 0).toFixed(2);

/** Karar satiri: kisa kimlik, ajan, is, soru ve numarali secenekler. */
export function kararMetni(db, karar) {
  const k = kararKarti(db, karar);
  const satir = [k.ajan.simge + ' ' + k.ajan.ad + ' · ' + (k.is?.ad ?? '?') + '  [' + kisa(k.id) + ']', k.soru];
  k.secenekler.forEach((s, i) => satir.push('  ' + (i + 1) + ') ' + s.etiket));
  satir.push('cevap: /cevap ' + kisa(k.id) + ' <n|metin>');
  return { metin: satir.join(NL), kart: k };
}

/** Karar seceneklerini kanalin dugmeleri icin ham veri olarak verir. */
export function kararDugmeleri(kart) {
  return kart.secenekler.map((s, i) => ({ etiket: s.etiket, veri: 'k:' + kisa(kart.id) + ':' + (i + 1) }));
}

export function durumMetni(db, kuyruk, { simdi = Date.now() } = {}) {
  const acik = acikKosular(db);
  const satir = [];
  const q = kuyruk?.durum?.() ?? { esZamanli: '?', calisan: acik.length, bekleyen: 0 };
  satir.push('Sürü: ' + q.calisan + ' calisiyor, ' + q.bekleyen + ' bekliyor (sinir ' + q.esZamanli + ')');
  for (const k of acik) {
    const is = isGetir(db, k.isId);
    const kim = kimlikCoz(db, { isId: k.isId, sessionId: k.sessionId, isAd: is?.ad ?? null });
    satir.push('  ' + kim.simge + ' ' + kim.ad + ' · ' + k.durum
      + (k.durum === KOSU_DURUMU.CALISIYOR ? ' ' + sure(simdi - k.basladi) : '') + '  [' + kisa(k.id) + ']');
  }
  const kararlar = bekleyenKararlar(db);
  satir.push(kararlar.length ? kararlar.length + ' acik karar: /kararlar' : 'acik karar yok');
  return satir.join(NL);
}

/**
 * Bir karari secenek numarasi ya da serbest metinle kapatir. Numara: kararKarti'nin
 * secenek sirasi (panelle ayni). Doner: { metin, devamKosuId? }.
 */
export function kararCevapla(db, kuyruk, kararOnek, cevap) {
  const karar = onekleBul(bekleyenKararlar(db, { limit: 1000 }), kararOnek, { ad: 'acik karar' });
  const kart = kararKarti(db, karar);
  const c = String(cevap ?? '').trim();
  if (!c) throw new Error('cevap bos');
  const n = /^\d+$/.test(c) ? Number(c) : null;
  let secim = null;
  if (n != null) {
    secim = kart.secenekler[n - 1];
    if (!secim) throw new Error('secenek yok: ' + n + ' (1-' + kart.secenekler.length + ')');
  }
  if (secim?.eylem === 'iptal') { iptalEt(db, karar.id); return { metin: 'vazgecildi: ' + kart.is?.ad }; }
  if (secim?.eylem === 'kabul') { kabulEt(db, karar.id); return { metin: 'kabul edildi: ' + kart.is?.ad }; }
  if (secim?.eylem === 'uygula') {
    const r = planUygula(db, karar.id);
    kuyruk?.pompala?.();
    return { metin: 'plan onaylandi, ' + r.profil + ' profilinde uygulaniyor: ' + kart.is?.ad + ' [' + kisa(r.devamKosu.id) + ']',
      devamKosuId: r.devamKosu.id };
  }
  if (secim?.eylem === 'kapsam') {
    const r = kapsamGenislet(db, karar.id);
    kuyruk?.pompala?.();
    return { metin: 'kapsam genisletildi (' + r.eklenen.join(', ') + '), ajan devam ediyor', devamKosuId: r.devamKosu.id };
  }
  const { devamKosu } = cevapla(db, karar.id, secim ? secim.cevap : c);
  kuyruk?.pompala?.();
  return { metin: 'cevaplandi, ajan devam ediyor: ' + kart.is?.ad + ' [' + kisa(devamKosu.id) + ']', devamKosuId: devamKosu.id };
}

/**
 * Tek komut calistirir. Hata firlatmaz: cikti her zaman { metin, dugmeler? }.
 * Kanal kim olursa olsun kullaniciya gosterecegi sey budur.
 */
export function komutCalistir(metin, { db, kuyruk, simdi = Date.now(), onayIste = false }) {
  const ham = String(metin ?? '').trim();
  if (!ham) return { metin: YARDIM };
  const [komut, ...gerisiHam] = ham.split(/\s+/);
  // Geri alinamayan komutlarda (sil/durdur) kanal onay isteyebilir; onay dugmesi ayni komutu
  // sonuna '!' ekleyerek yollar. '!' baska hicbir komutta anlam tasimaz.
  const onayli = gerisiHam.length > 0 && gerisiHam[gerisiHam.length - 1] === '!';
  const gerisi = onayli ? gerisiHam.slice(0, -1) : gerisiHam;
  const kalan = gerisi.join(' ').trim();
  const k = komut.toLowerCase().replace(/@\S+$/, ''); // Telegram grup eki (/durum@bot)
  try {
    switch (k) {
      case '/yardim': case '/help': case '/start':
        return { metin: YARDIM };

      case '/durum':
        return { metin: durumMetni(db, kuyruk, { simdi }) };

      case '/ozet':
        return { metin: ozetMetni(db, { simdi }) };

      case '/akis': {
        if (!gerisi.length) throw new Error('kullanim: /akis <is> [satir]');
        const sayili = gerisi.length > 1 && /^\d+$/.test(gerisi[gerisi.length - 1]);
        const n = sayili ? Number(gerisi[gerisi.length - 1]) : 10;
        const isAd = sayili ? gerisi.slice(0, -1).join(' ') : kalan;
        return { metin: akisMetni(db, isBul(db, isAd), { satir: n }) };
      }

      case '/rapor': {
        const gun = /^\d+$/.test(kalan) ? Number(kalan) : 90;
        return { metin: raporMetni(db, { gun }) };
      }

      case '/sablonlar':
        return { metin: sablonListesi().join(NL) };

      case '/oneriler': {
        const acik = oneriler(db).filter((o) => o.durum === 'acik');
        if (!acik.length) return { metin: 'acik oneri yok' };
        return { metin: acik.map((o) => '[' + o.id + '] ' + o.isAd + ' → ' + o.metin).join(NL) + NL + 'ac: /oneri-ac <id> · gec: /oneri-gec <id>' };
      }
      case '/oneri-ac': {
        if (!kalan) throw new Error('kullanim: /oneri-ac <id>');
        const o = oneriBul(db, kalan);
        if (o.durum !== 'acik') throw new Error('oneri zaten kapali (' + o.durum + ')');
        const kaynak = isGetir(db, o.isId);
        const proje = projeBul(db, kaynak?.cwd ?? o.cwd);
        const ornek = [...proje.isler].sort((a, b) => b.olusturuldu - a.olusturuldu)[0];
        const ad = o.metin.length > 40 ? o.metin.slice(0, 40).trimEnd() + '…' : o.metin;
        const is = isEkle(db, { ad, gorev: o.metin + (kaynak ? NL + '(Onceki isten oneri: "' + kaynak.ad + '")' : ''), cwd: proje.cwd,
          profil: ornek?.profil ?? 'denetimli', model: ornek?.model ?? null, butceUsd: ornek?.butceUsd ?? null,
          dogrulama: ornek?.dogrulama ?? null, yedekModel: ornek?.yedekModel ?? null, izolasyon: ornek?.izolasyon ?? null,
          mcp: ornek?.mcp ?? null, mcpMod: ornek?.mcpMod ?? null });
        const kosu = kuyruk.siraya(is.id);
        oneriKapat(db, o.id, 'acildi');
        return { metin: 'oneri is oldu ve kuyruga alindi: ' + is.ad + ' · ' + proje.ad + '  [' + kisa(kosu.id) + ']' };
      }
      case '/oneri-gec': {
        if (!kalan) throw new Error('kullanim: /oneri-gec <id>');
        const o = oneriKapat(db, oneriBul(db, kalan).id, 'gecildi');
        return { metin: 'gecildi: ' + o.metin.slice(0, 80) };
      }

      case '/notlar': {
        if (!kalan) throw new Error('kullanim: /notlar <proje>');
        const proje = projeBul(db, kalan);
        const l = hafizaKayitlari(db, { cwd: proje.cwd, tur: HAFIZA_TURU.OLGU, limit: 100 }).filter((r) => r.kaynak === KAYNAK.INSAN);
        if (!l.length) return { metin: proje.ad + ': insan olgusu yok (/not ile yaz)' };
        return { metin: proje.ad + ' insan olgulari (konu → metin):' + NL
          + l.map((r) => '- ' + String(r.konu ?? '').replace(/^insan:/, '') + ' → ' + r.icerik.slice(0, 120)).join(NL) };
      }

      case '/unut': {
        if (gerisi.length < 2) throw new Error('kullanim: /unut <proje> <konu>');
        const proje = projeBul(db, gerisi[0]);
        const silinen = insanOlgusuSil(db, { cwd: proje.cwd, konu: kalan.slice(gerisi[0].length).trim() });
        return { metin: 'unutuldu (' + proje.ad + '): ' + silinen[0].icerik.slice(0, 120) };
      }

      case '/kararlar': {
        const liste = bekleyenKararlar(db);
        if (!liste.length) return { metin: 'acik karar yok' };
        const parcalar = liste.map((kr) => kararMetni(db, kr));
        return { metin: parcalar.map((p) => p.metin).join(NL + NL),
          dugmeler: parcalar.map((p) => ({ kararId: p.kart.id, secenekler: kararDugmeleri(p.kart) })) };
      }

      case '/cevap': {
        if (gerisi.length < 2) throw new Error('kullanim: /cevap <karar> <n|metin>');
        const r = kararCevapla(db, kuyruk, gerisi[0], kalan.slice(gerisi[0].length).trim());
        return { metin: r.metin };
      }

      case '/isler': {
        const liste = isListesi(db).filter((i) => !String(i.ad).startsWith('_'));
        if (!liste.length) return { metin: 'tanimli is yok' };
        return { metin: liste.map((i) => (i.etkin ? '' : '(kapali) ') + i.ad + ' · ' + basename(i.cwd) + ' · ' + i.profil
          + '  [' + kisa(i.id) + ']').join(NL) };
      }

      case '/sira': {
        if (!kalan) throw new Error('kullanim: /sira <is>');
        const is = isBul(db, kalan);
        const kosu = kuyruk.siraya(is.id);
        return { metin: 'kuyruga alindi: ' + is.ad + ' [' + kisa(kosu.id) + ']' };
      }

      case '/durdur': {
        if (!kalan) throw new Error('kullanim: /durdur <kosu|is>');
        const acik = acikKosular(db);
        let kosu = null;
        try { kosu = onekleBul(acik, kalan, { ad: 'acik kosu' }); } catch { /* is olabilir */ }
        if (onayIste && !onayli) {
          const hedef = kosu ? 'kosu ' + kisa(kosu.id) : 'is ' + isBul(db, kalan).ad + ' (tum kosulari)';
          return { metin: 'durdurulsun mu: ' + hedef + '?',
            dugmeler: [{ secenekler: [{ etiket: 'Durdur', veri: 'o:/durdur ' + kalan }, { etiket: 'Vazgec', veri: 'o:vazgec' }] }] };
        }
        if (kosu) {
          const r = kuyruk.kosuDurdur(kosu.id, 'telefon');
          return { metin: 'durduruldu: ' + kisa(kosu.id) + ' (' + r.durum + ')' };
        }
        const is = isBul(db, kalan);
        const d = kuyruk.isKosulariniDurdur(is.id, 'telefon');
        return { metin: d.length ? is.ad + ': ' + d.length + ' kosu durduruldu' : is.ad + ': calisan kosu yok' };
      }

      case '/talimat': case '/soyle': {
        if (gerisi.length < 2) throw new Error('kullanim: /talimat <is> <metin>');
        // Is adi bosluk icerebilir: once kisa kimlik/tek kelime dene, olmazsa en uzun eslesen on eki ara.
        let is = null, metinBas = 0;
        for (let n = gerisi.length - 1; n >= 1 && !is; n--) {
          try { is = isBul(db, gerisi.slice(0, n).join(' ')); metinBas = n; } catch { /* daha kisa dene */ }
        }
        if (!is) throw new Error('is bulunamadi: ' + gerisi[0]);
        const mesaj = gerisi.slice(metinBas).join(' ');
        const r = kuyruk.talimat(is.id, mesaj);
        return { metin: r.yol === 'canli'
          ? 'iletildi (canli): ' + is.ad + ' calisirken gorecek  [' + kisa(r.kosuId) + ']'
          : 'kosu bitmisti; ayni oturumdan devam kosusu acildi: ' + is.ad + '  [' + kisa(r.kosuId) + ']' };
      }

      case '/fork': {
        if (!kalan) throw new Error('kullanim: /fork <is>');
        return { metin: forkKomutu(db, isBul(db, kalan)).metin };
      }
      case '/sil': {
        if (!kalan) throw new Error('kullanim: /sil <is>');
        const is = isBul(db, kalan);
        if (onayIste && !onayli) {
          // Yanlis silme geri alinamaz: telefondan ikinci dokunus istenir (dugme '!' ekli komutu yollar).
          return { metin: 'silinsin mi: ' + is.ad + ' [' + kisa(is.id) + ']? Kosulari durdurulur, acik kararlari kapatilir.',
            dugmeler: [{ secenekler: [{ etiket: 'Sil: ' + is.ad, veri: 'o:/sil ' + kisa(is.id) }, { etiket: 'Vazgec', veri: 'o:vazgec' }] }] };
        }
        // Panelle ayni sira: once kosulari durdur ve acik kararlari kapat, sonra sil
        // (silinmis ise ait kosu bitip karar karti acmasin).
        const durdurulan = kuyruk.isKosulariniDurdur(is.id, 'is silindi');
        let iptal = 0;
        for (const kr of bekleyenKararlar(db, { limit: 1000 }).filter((x) => x.isId === is.id)) { iptalEt(db, kr.id); iptal++; }
        isSil(db, is.id);
        return { metin: 'silindi: ' + is.ad + (durdurulan.length ? ' · ' + durdurulan.length + ' kosu durduruldu' : '')
          + (iptal ? ' · ' + iptal + ' karar kapatildi' : '') };
      }

      case '/yeni': {
        // Iki bicim: "/yeni <proje> | <gorev>" ve "/yeni <proje> #<sablon> [| ek]".
        const sm = /^(\S+)\s+#(\S+)\s*(?:\|\s*([\s\S]*))?$/.exec(kalan);
        const i = kalan.indexOf('|');
        if (!sm && i < 0) throw new Error('kullanim: /yeni <proje> | <gorev>  ya da  /yeni <proje> #<sablon> [| ek]');
        const proje = projeBul(db, sm ? sm[1] : kalan.slice(0, i));
        // Ayarlar o projenin son isinden miras: profil/model/dogrulama/MCP telefondan yazilmaz.
        const ornek = [...proje.isler].sort((a, b) => b.olusturuldu - a.olusturuldu)[0];
        let alanlar;
        if (sm) {
          const s = sablondanIs(sm[2], { ek: sm[3] ?? '', ornek });
          alanlar = { ad: s.ad, gorev: s.gorev, profil: s.profil, dogrulama: s.dogrulama, kapsam: s.kapsam };
        } else {
          const gorev = kalan.slice(i + 1).trim();
          if (!gorev) throw new Error('gorev bos');
          alanlar = { ad: (gorev.length > 40 ? gorev.slice(0, 40).trimEnd() + '…' : gorev), gorev,
            profil: ornek?.profil ?? 'denetimli', dogrulama: ornek?.dogrulama ?? null, kapsam: null };
        }
        const is = isEkle(db, { ...alanlar, cwd: proje.cwd,
          model: ornek?.model ?? null, butceUsd: ornek?.butceUsd ?? null,
          yedekModel: ornek?.yedekModel ?? null, izolasyon: ornek?.izolasyon ?? null,
          mcp: ornek?.mcp ?? null, mcpMod: ornek?.mcpMod ?? null });
        const kosu = kuyruk.siraya(is.id);
        return { metin: 'is acildi ve kuyruga alindi: ' + is.ad + ' · ' + proje.ad + ' · ' + profilAl(is.profil).ad
          + (sm ? ' · #' + sm[2].replace(/^#/, '') : '') + '  [' + kisa(kosu.id) + ']' };
      }

      case '/not': {
        if (gerisi.length < 2) throw new Error('kullanim: /not <proje> <metin>');
        const proje = projeBul(db, gerisi[0]);
        const icerik = kalan.slice(gerisi[0].length).trim();
        insanOlgusu(db, { cwd: proje.cwd, icerik });
        return { metin: 'olgu yazildi (' + proje.ad + '): ' + icerik };
      }

      default:
        return { metin: 'bilinmeyen komut: ' + komut + NL + YARDIM };
    }
  } catch (e) {
    return { metin: 'olmadi: ' + (e?.message ?? e) };
  }
}
