// Gece raporu: sabah kalktiginda "surum ne yapti" sorusunun tek ekranlik cevabi.
//
// Uyurken calisan bir sistem varsa bu vazgecilmez olur. Ama sadece gece degil,
// herhangi bir zaman araligi icin de calisir - "son 4 saatte ne oldu".
//
// Kural: rapor SESSIZ KALMAZ. Hicbir sey olmadiysa da bunu soyler, cunku
// "hicbir sey olmadi" ile "rapor uretilemedi" ayni sey degil.

import { OLAY, aralik } from './events.js';
import { kimlikCoz } from './kisilik.js';
import { KOSU_DURUMU } from './isler.js';
import { degerlendir as kotaDegerlendir } from './kota.js';

const usd = (n) => '$' + Number(n ?? 0).toFixed(2);

/** Sureyi insan olcusune cevirir. */
export function sure(ms) {
  if (!ms || ms < 0) return '-';
  const dk = Math.round(ms / 60_000);
  if (dk < 60) return dk + 'dk';
  return Math.floor(dk / 60) + 'sa ' + (dk % 60) + 'dk';
}

/**
 * Bir zaman araliginda ne oldu?
 * Kosular kaydin kendisinden, olaylar akistan okunur.
 */
export function ozet(db, ayarlar, { baslangic, bitis = Date.now() } = {}) {
  const kosular = db.prepare(`
    SELECT k.*, i.ad is_ad, i.profil, i.model
    FROM kosular k LEFT JOIN isler i ON i.id = k.is_id
    WHERE k.bitti IS NOT NULL AND k.bitti >= ? AND k.bitti <= ?
    ORDER BY k.bitti
  `).all(baslangic, bitis);

  const bitti = kosular.filter((k) => k.durum === KOSU_DURUMU.BITTI);
  const hatali = kosular.filter((k) => k.durum === KOSU_DURUMU.HATA);
  const kararda = kosular.filter((k) => k.durum === KOSU_DURUMU.KARAR_BEKLIYOR);

  const bekleyenKarar = db.prepare(
    'SELECT COUNT(*) n FROM kararlar WHERE durum = ?').get('bekliyor')?.n ?? 0;

  // Akistan arac dagilimi ve hatalar
  const olaylar = aralik(db, { baslangic, bitis, limit: 20000 });
  const araclar = new Map();
  let hataOlayi = 0;
  for (const o of olaylar) {
    if (o.kind === OLAY.ARAC && o.data?.arac) {
      araclar.set(o.data.arac, (araclar.get(o.data.arac) || 0) + 1);
    } else if (o.kind === OLAY.HATA) hataOlayi++;
  }

  const toplamUsd = kosular.reduce((t, k) => t + Number(k.usd || 0), 0);

  return {
    baslangic, bitis,
    kosu: kosular.length,
    bitti: bitti.length,
    hatali: hatali.length,
    kararda: kararda.length,
    bekleyenKarar: Number(bekleyenKarar),
    toplamUsd,
    hataOlayi,
    araclar: [...araclar].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([arac, adet]) => ({ arac, adet })),
    // Her kosu icin tek satirlik ozet - ajanin kendi agzindan sonucu.
    satirlar: kosular.map((k) => ({
      ajan: kimlikCoz(db, { isId: k.is_id, sessionId: k.session_id, isAd: k.is_ad ?? null }),
      is: k.is_ad ?? '(silinmis is)',
      durum: k.durum,
      usd: Number(k.usd || 0),
      sureMs: k.bitti && k.basladi ? k.bitti - k.basladi : null,
      profil: k.profil ?? null,
      model: k.model ?? null,
      // Ajanin kendi cumlesi; yoksa hata metni.
      soz: (k.sonuc || k.hata || '').replace(/\s+/g, ' ').slice(0, 160) || null,
    })),
    kota: kotaDegerlendir(db, ayarlar, { simdi: bitis }),
  };
}

/** Onceki gece: dun aksam 20:00'den bu sabaha. */
export function geceAraligi(simdi = Date.now()) {
  const s = new Date(simdi);
  const bitis = simdi;
  const baslangic = new Date(s);
  baslangic.setHours(20, 0, 0, 0);
  // Sabah 20:00'den once bakiyorsan kastettigin DUN aksam.
  if (baslangic.getTime() > simdi) baslangic.setDate(baslangic.getDate() - 1);
  return { baslangic: baslangic.getTime(), bitis };
}

const DURUM_ISARETI = {
  [KOSU_DURUMU.BITTI]: 'tamam',
  [KOSU_DURUMU.HATA]: 'HATA',
  [KOSU_DURUMU.KARAR_BEKLIYOR]: 'SORUYOR',
  [KOSU_DURUMU.IPTAL]: 'iptal',
};

/** Terminal icin metin rapor. */
export function metinRapor(o) {
  const NL = String.fromCharCode(10);
  const s = [];
  const bas = new Date(o.baslangic), bit = new Date(o.bitis);
  const iki = (n) => String(n).padStart(2, '0');
  const saat = (d) => iki(d.getHours()) + ':' + iki(d.getMinutes());
  // Ayni gun degilse tarih de gorunmeli: 24 saatlik aralik ayni saate denk
  // gelip rapor tek anlik gibi gorunuyordu.
  const ayniGun = bas.toDateString() === bit.toDateString();
  const damga = (d) => (ayniGun ? '' : iki(d.getDate()) + '.' + iki(d.getMonth() + 1) + ' ') + saat(d);

  s.push('SURU RAPORU  ' + damga(bas) + ' -> ' + damga(bit));
  s.push('-'.repeat(46));

  if (!o.kosu) {
    // Sessiz kalma: "hicbir sey olmadi" da bir cevaptir.
    s.push('Bu aralikta hic kosu yok. Suru bekliyor.');
  } else {
    s.push(o.kosu + ' kosu  ·  ' + o.bitti + ' tamam, ' + o.hatali + ' hata, '
      + o.kararda + ' soruyor  ·  ' + usd(o.toplamUsd));
    s.push('');
    for (const r of o.satirlar) {
      s.push('  ' + (r.ajan.simge + ' ' + r.ajan.ad).padEnd(14)
        + (DURUM_ISARETI[r.durum] ?? r.durum).padEnd(9)
        + usd(r.usd).padStart(8) + '  ' + sure(r.sureMs).padStart(7) + '  ' + r.is);
      if (r.soz) s.push('      ' + r.soz);
    }
    if (o.araclar.length) {
      s.push('');
      s.push('  araclar: ' + o.araclar.map((a) => a.arac + ' x' + a.adet).join(', '));
    }
  }

  if (o.bekleyenKarar) {
    s.push('');
    s.push('>> ' + o.bekleyenKarar + ' karar seni bekliyor.');
  }

  const k = o.kota;
  s.push('');
  s.push('kota: 5 saat ' + usd(k.besSaat.usd) + '/' + usd(k.besSaat.tavan ?? 0)
    + '  hafta ' + usd(k.haftalik.usd) + '/' + usd(k.haftalik.tavan ?? 0)
    + '  ·  ' + k.gerekce);

  return s.join(NL);
}
