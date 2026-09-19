// Kota beyni: surunun kendi yakitini yonetmesi.
//
// DURUST SINIR: Anthropic'in gercek kota sayacini okuyamiyoruz - oyle bir uc
// yok. Bu yuzden iki ayri sinyal kullaniyoruz:
//
//   1. KENDI TAVANIN (yumusak fren) - 5 saatlik ve haftalik pencerede ne kadar
//      "API liste fiyati degerinde" is yapildigini sayariz. Bu bir FATURA degil,
//      kota tuketiminin vekili. Tavan senin koydugun sayi (ayarlar.json).
//
//   2. GERCEK LIMIT DOLMASI (sert fren) - kayitlarda "usage limit reached"
//      gorunduyse bu tahmin degil kesin bilgi. O anda kuyruk durur ve
//      sifirlanma saatine kadar yeni kosu baslatilmaz.
//
// Neden onemli: 20 ajani ayni anda salarsan 5 saatlik pencereyi 40 dakikada
// yakarsin ve o gun baska is yapamazsin.

import { OLAY, oku as olayOku } from './events.js';

export const BES_SAAT = 5 * 3600_000;
export const HAFTA = 7 * 24 * 3600_000;

/**
 * Bir zaman penceresinde tuketilen deger (USD, API liste fiyati).
 *
 * Iki kaynak toplanir cunku ikisi de AYNI kotayi yer:
 *   - kosular : Surunun kendi baslattigi ajanlar
 *   - sessions: senin elle actigin Claude Code oturumlari
 *
 * Yaklasiklik: oturumlar bitis zamanina gore sayilir. Uzun bir oturumun
 * maliyeti tamamen bittigi ana yazilir. Kisa pencerede bu biraz kayar ama
 * yanlis tarafa kaymaz - tuketimi oldugundan az gostermez.
 */
export function tuketim(db, { pencereMs, simdi = Date.now() } = {}) {
  const esik = simdi - pencereMs;

  const k = db.prepare(`SELECT COALESCE(SUM(usd),0) usd, COUNT(*) n
                        FROM kosular WHERE bitti IS NOT NULL AND bitti >= ?`).get(esik);
  const o = db.prepare(`SELECT COALESCE(SUM(usd),0) usd, COUNT(*) n
                        FROM sessions WHERE ended_at IS NOT NULL AND ended_at >= ?`).get(esik);

  return {
    usd: Number(k.usd || 0) + Number(o.usd || 0),
    kosu: Number(k.n || 0),
    oturum: Number(o.n || 0),
    pencereMs,
    baslangic: esik,
  };
}

/**
 * Gercek limit dolmasi kayitlarda gorundu mu?
 * state.js bunu transkriptten kesin cikariyor; biz akistaki durum olayina bakiyoruz.
 */
export function limitDurumu(db, { simdi = Date.now(), gecerlilikMs = 6 * 3600_000 } = {}) {
  const olaylar = olayOku(db, { kind: OLAY.DURUM, limit: 400 });
  let son = null;
  for (const o of olaylar) {
    if (o.data?.durum === 'limit-doldu') son = o;
    // Ayni oturum sonradan calismaya donduyse limit kalkmis demektir.
    else if (son && o.sessionId === son.sessionId) son = null;
  }
  if (!son) return { doldu: false, sifirlanma: null, yas: null };
  const yas = simdi - son.at;
  // Cok eski bir limit kaydi bugunu baglamaz.
  if (yas > gecerlilikMs) return { doldu: false, sifirlanma: null, yas };
  return { doldu: true, sifirlanma: son.data?.sifirlanma ?? null, yas, sessionId: son.sessionId };
}

/**
 * Doluluk oranindan es zamanlilik sinirini cikarir.
 *
 * Kademeler kasitli olarak sert degil yumusak: pencere dolarken ajan sayisi
 * once azalir, en son durur. Aniden sifira dusurmek yarim kalmis isler birakir.
 */
export function sinirOner(oran, { taban = 3, enAz = 1 } = {}) {
  if (!Number.isFinite(oran) || oran < 0) return taban;
  if (oran >= 1.0) return 0;                       // tavan asildi: dur
  if (oran >= 0.9) return enAz;                    // son %10: tek ajan
  if (oran >= 0.75) return Math.max(enAz, Math.ceil(taban / 3));
  if (oran >= 0.5) return Math.max(enAz, Math.ceil(taban / 2));
  return taban;
}

/** Mevcut hizla tavana ne zaman varilir? Doner: ms (veya null). */
export function tahminiDolus({ usd, tavan, pencereMs, gecenMs }) {
  if (!tavan || usd <= 0 || !gecenMs) return null;
  const hiz = usd / gecenMs;                        // usd / ms
  const kalanUsd = tavan - usd;
  if (kalanUsd <= 0) return 0;
  const ms = kalanUsd / hiz;
  // Pencerenin kendisi zaten kayiyor: pencere sonundan oteye tahmin anlamsiz.
  return Math.min(ms, pencereMs);
}

/**
 * Tam degerlendirme. Kuyruk bunu periyodik cagirip sinirini gunceller.
 * Saf okuma - hicbir sey degistirmez, karar cagirana ait.
 */
export function degerlendir(db, ayarlar, { simdi = Date.now() } = {}) {
  const a = ayarlar.kota ?? {};
  const taban = a.tabanSinir ?? 3;
  const enAz = a.enAzSinir ?? 1;

  const bes = tuketim(db, { pencereMs: BES_SAAT, simdi });
  const hafta = tuketim(db, { pencereMs: HAFTA, simdi });

  const besOran = a.besSaatlikUsd ? bes.usd / a.besSaatlikUsd : 0;
  const haftaOran = a.haftalikUsd ? hafta.usd / a.haftalikUsd : 0;

  const limit = limitDurumu(db, { simdi });

  // En dar olan hangisiyse o baglar.
  const oran = Math.max(besOran, haftaOran);
  let sinir = sinirOner(oran, { taban, enAz });
  let gerekce;

  if (limit.doldu) {
    sinir = 0;
    gerekce = 'kullanim limiti doldu' + (limit.sifirlanma ? ' (sifirlanma: ' + limit.sifirlanma + ')' : '');
  } else if (oran >= 1) {
    gerekce = (besOran >= haftaOran ? '5 saatlik' : 'haftalik') + ' tavan asildi';
  } else if (sinir < taban) {
    gerekce = (besOran >= haftaOran ? '5 saatlik' : 'haftalik') + ' pencere %'
      + Math.round(oran * 100) + ' dolu';
  } else {
    gerekce = 'pencereler rahat';
  }

  return {
    sinir,
    gerekce,
    kisitli: sinir < taban,
    limit,
    besSaat: {
      ...bes,
      tavan: a.besSaatlikUsd ?? null,
      oran: besOran,
      tahminiDolusMs: tahminiDolus({ usd: bes.usd, tavan: a.besSaatlikUsd,
        pencereMs: BES_SAAT, gecenMs: BES_SAAT }),
    },
    haftalik: {
      ...hafta,
      tavan: a.haftalikUsd ?? null,
      oran: haftaOran,
      tahminiDolusMs: tahminiDolus({ usd: hafta.usd, tavan: a.haftalikUsd,
        pencereMs: HAFTA, gecenMs: HAFTA }),
    },
  };
}

/**
 * Gecmisten tavan onerir. Uydurma sayi yerine OLCUM.
 *
 * Mantik: tavan, ajanlarin geri cekilmesi gereken noktadir - senin kendi
 * calismana yer birakmasi icin. Gecmisteki %90'lik dilimi tavan yaparsak
 * normal gunlerde ajanlar tam hizda kosar, yogun gunlerde geri cekilir.
 * Tepe degeri tavan yapmak anlamsiz olurdu: hicbir zaman devreye girmezdi.
 */
export function tavanOner(db, { simdi = Date.now() } = {}) {
  const rows = db.prepare(`SELECT ended_at t, usd FROM sessions
                           WHERE ended_at IS NOT NULL AND usd > 0 ORDER BY ended_at`).all();
  if (rows.length < 5) return null;   // olcecek kadar veri yok

  const kayanDilim = (pencereMs, dilim) => {
    const toplamlar = [];
    let j = 0, top = 0;
    for (let i = 0; i < rows.length; i++) {
      top += rows[i].usd;
      while (rows[j].t < rows[i].t - pencereMs) { top -= rows[j].usd; j++; }
      toplamlar.push(top);
    }
    toplamlar.sort((a, b) => a - b);
    // Dilim 1 oldugunda indeks dizinin sonunu tasiyor: son elemana kelepcele.
    const i = Math.min(toplamlar.length - 1, Math.floor(toplamlar.length * dilim));
    return toplamlar[i] ?? 0;
  };

  const yuvarla = (x) => Math.max(10, Math.round(x / 50) * 50);
  return {
    besSaatlikUsd: yuvarla(kayanDilim(BES_SAAT, 0.9)),
    haftalikUsd: yuvarla(kayanDilim(HAFTA, 0.9)),
    olcum: {
      oturumSayisi: rows.length,
      besSaatMedyan: Math.round(kayanDilim(BES_SAAT, 0.5)),
      besSaatTepe: Math.round(kayanDilim(BES_SAAT, 1)),
      haftalikTepe: Math.round(kayanDilim(HAFTA, 1)),
    },
  };
}
