// Bildirim motoru: olay akisindaki durum gecislerini telefona iter.
//
// Tasarim: karar verme (kararVer) saf bir fonksiyon - ag yok, saat yok, disk yok.
// Gonderim ayri. Boylece "gece 3'te acil olmayan bildirim gitmemeli" gibi
// kurallar gercek zaman beklemeden test edilebiliyor.
//
// Gurultu bu isin can damari: bildirim spam yaparsa kullanici kapatir, arac olur.
// Bu yuzden uc kademe var - onemsiz durumlar hic gonderilmez, ayni durum
// soguma suresi dolmadan tekrarlanmaz, kisa surede birikenler tek ozete duser.

import { OLAY, oku as olayOku, yaz as olayYaz } from './events.js';
import { kvOku, kvYaz } from './db.js';
import { ajanKimligi, kimlikCoz } from './kisilik.js';

const IMLEC = 'bildirim.imlec';

const ETIKET = {
  'onay-bekliyor': 'onay bekliyor',
  'seni-bekliyor': 'seni bekliyor',
  'takildi':       'takildi',
  'limit-doldu':   'limit doldu',
  'calisiyor':     'calisiyor',
  'bosta':         'bosta',
};

const SIMGE = {
  'onay-bekliyor': '\u{1F513}',
  'seni-bekliyor': '\u{2705}',
  'takildi':       '\u{1F6A8}',
  'limit-doldu':   '\u{23F3}',
};

/** Yerel saate gore sessiz pencerede miyiz? Gece yarisini asan araliklari da kapsar. */
export function sessizMi(simdi, pencere) {
  if (!pencere?.etkin) return false;
  const saat = new Date(simdi).getHours();
  const { baslangic: b, bitis: s } = pencere;
  return b <= s ? saat >= b && saat < s : saat >= b || saat < s;
}

/**
 * Hangi olaylar bildirime donusur?
 * olaylar     : akistan gelen ham olaylar (durum disindakiler yok sayilir)
 * sonGonderim : Map<'oturum:durum', zaman> - soguma icin
 * Doner: { gonderilecek: [...], ozet: {...}|null, sonGonderim: guncellenmis Map }
 */
export function kararVer(olaylar, { ayarlar, sonGonderim = new Map(), simdi = Date.now(),
  // Kimlik cozucu: sunucu veritabanindan gorev etiketi verir; saf testlerde kadro kimligi.
  kimlik = (o) => ajanKimligi({ isId: o.data?.isId, sessionId: o.sessionId }) } = {}) {
  const a = ayarlar.bildirim;
  const sogumaMs = a.sogumaDk * 60_000;
  const sessiz = sessizMi(simdi, a.sessizSaatler);
  const gonderilecek = [];
  const yeniSon = new Map(sonGonderim);

  for (const o of olaylar) {
    // Karar olaylari: bir ajan tikandi ve senden cevap bekliyor. Bunlar her
    // zaman acil - cevaplanana kadar o ajan hicbir sey yapamiyor.
    if (o.kind === OLAY.KARAR && o.data?.asama === 'acildi') {
      const anahtar = o.sessionId + ':karar';
      const once = yeniSon.get(anahtar);
      if (once != null && simdi - once < sogumaMs) continue;
      yeniSon.set(anahtar, simdi);
      const k = kimlik(o);
      gonderilecek.push({
        seq: o.seq, at: o.at, sessionId: o.sessionId, durum: 'karar', onem: 'acil',
        // Kanal dugme kurabilsin diye (Telegram): karari tek dokunusla cevaplamak.
        kararId: o.data.kararId ?? null,
        proje: o.project || '?', ajan: k.ad, simge: '❓',
        baslik: '❓ ' + k.ad + ' · ' + (o.project || '?'),
        govde: o.data.soru || ('karar bekliyor (' + (o.data.tur ?? '?') + ')'),
      });
      continue;
    }
    if (o.kind !== OLAY.DURUM) continue;
    const durum = o.data?.durum;
    const onem = a.durumlar[durum] ?? 'yok';
    if (onem === 'yok') continue;

    // Sessiz saatte acil olmayan hicbir sey gitmez. Acil olanlar
    // acilGecer kapaliysa onlar da beklemez, dusurulur - biriktirip
    // sabah yigin halinde gondermek daha kotu bir deneyim.
    if (sessiz && !(onem === 'acil' && a.sessizSaatler.acilGecer)) continue;

    const anahtar = o.sessionId + ':' + durum;
    const once = yeniSon.get(anahtar);
    if (once != null && simdi - once < sogumaMs) continue;
    yeniSon.set(anahtar, simdi);

    const k = kimlik(o);
    const govdeParcalari = [ETIKET[durum] ?? durum];
    if (o.data?.arac) govdeParcalari.push('arac: ' + o.data.arac);
    if (o.data?.kesin === false && (durum === 'onay-bekliyor' || durum === 'takildi')) {
      govdeParcalari.push('(cikarim)');
    }
    // Son mesaj metni yalnizca acikca istenirse gonderilir: disari giden
    // kanalda (ntfy gibi) oturum icerigi sizdirmak istemeyiz.
    if (a.icerik === 'tam' && o.data?.metin) govdeParcalari.push('- ' + o.data.metin);

    gonderilecek.push({
      seq: o.seq,
      at: o.at,
      sessionId: o.sessionId,
      durum,
      onem,
      proje: o.project || '?',
      ajan: k.ad,
      simge: SIMGE[durum] ?? k.simge,
      baslik: k.simge + ' ' + k.ad + ' · ' + (o.project || '?'),
      govde: govdeParcalari.join(' '),
    });
  }

  // Kisa surede cok bildirim birikirse tek tek gondermek telefonu titretir
  // durur; tek ozet daha okunakli.
  let ozet = null;
  if (gonderilecek.length > a.topluEsigi) {
    const acil = gonderilecek.filter((g) => g.onem === 'acil').length;
    const projeler = [...new Set(gonderilecek.map((g) => g.proje))];
    ozet = {
      onem: acil ? 'acil' : 'normal',
      adet: gonderilecek.length,
      baslik: '\u{1F41D} Sürü: ' + gonderilecek.length + ' olay',
      govde: (acil ? acil + ' acil · ' : '') + projeler.slice(0, 4).join(', ')
        + (projeler.length > 4 ? ' +' + (projeler.length - 4) : ''),
    };
  }

  return { gonderilecek, ozet, sonGonderim: yeniSon };
}

/**
 * Akisi imlecten okur, karar verir, kanaldan gonderir, imleci ilerletir.
 * Gonderilenler akisa 'bildirim' olayi olarak da yazilir - Faz 3'teki
 * ajan karnesi ve denetim kaydi bunu okuyacak.
 */
// Yerel olmayan kanala giden her bildirim veri akisi defterine girer: makineden cikan veri.
import { defterYaz, AKIS } from './veriakisi.js';

export class Bildirimci {
  constructor(db, { ayarlar, kanal, simdi = () => Date.now() }) {
    this.db = db;
    this.ayarlar = ayarlar;
    this.kanal = kanal;
    this.simdi = simdi;
    this.sonGonderim = new Map();
  }

  /** Ilk calistirmada gecmisi yigin halinde gondermemek icin imleci sona alir. */
  basaSar(sonSeq) {
    if (kvOku(this.db, IMLEC, null) == null) kvYaz(this.db, IMLEC, sonSeq);
  }

  async calistir({ limit = 200 } = {}) {
    const imlec = Number(kvOku(this.db, IMLEC, 0)) || 0;
    // Tur suzgeci yok: imlec butun akista ilerlemeli, yoksa durum disi
    // olaylar (karar gibi) imlecin gerisinde kalip tekrar tekrar okunur.
    const olaylar = olayOku(this.db, { sinceSeq: imlec, limit });
    if (!olaylar.length) return { gonderildi: 0, imlec };

    const simdi = this.simdi();
    const { gonderilecek, ozet, sonGonderim } = kararVer(olaylar, {
      ayarlar: this.ayarlar, sonGonderim: this.sonGonderim, simdi,
      kimlik: (o) => kimlikCoz(this.db, { isId: o.data?.isId, sessionId: o.sessionId }),
    });
    this.sonGonderim = sonGonderim;

    const paketler = ozet ? [ozet] : gonderilecek;
    let gonderildi = 0;
    for (const p of paketler) {
      try {
        await this.kanal.gonder(p);
        gonderildi++;
        if (this.kanal.ad !== 'gunluk') {
          try {
            defterYaz(this.db, [{ zaman: simdi, kosuId: null, proje: p.proje ?? null, tur: AKIS.BILDIRIM,
              hedef: this.kanal.ad, ayrinti: String(p.baslik ?? p.durum ?? 'bildirim'), boyut: JSON.stringify(p).length }]);
          } catch { /* defter yazilamadi, bildirim gitti */ }
        }
        olayYaz(this.db, {
          at: simdi, kind: 'bildirim', sessionId: p.sessionId ?? null,
          project: p.proje ?? null,
          data: { durum: p.durum ?? 'ozet', onem: p.onem, kanal: this.kanal.ad, adet: p.adet ?? 1 },
        });
      } catch (e) {
        // Bildirim gidemedi diye imleci geri almiyoruz: aksi halde kanal
        // bozukken ayni olaylar sonsuza kadar yeniden denenir ve akis tikanir.
        olayYaz(this.db, {
          at: simdi, kind: 'hata', sessionId: p.sessionId ?? null,
          data: { nerede: 'bildirim', kanal: this.kanal.ad, mesaj: String(e.message ?? e) },
        });
      }
    }

    const yeniImlec = olaylar[olaylar.length - 1].seq;
    kvYaz(this.db, IMLEC, yeniImlec);
    return { gonderildi, imlec: yeniImlec, aday: gonderilecek.length, ozetlendi: !!ozet };
  }
}
