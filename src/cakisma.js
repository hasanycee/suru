// Cakisma sezgisi: iki ajan ayni yere dokunuyorsa once uyar.
//
// Cok ajanla calisirken bu olmadan felaket olur - iki ajan ayni dosyayi
// duzenler, biri digerinin isini ezer, ikisi de basarili raporlar. Kimse
// ne oldugunu anlamaz.
//
// Onlem degil SEZGI: Suru surecleri kilitlemiyor, dosya sistemine karismiyor.
// Yaptigi sey ayni klasorde/dalda calisan kosulari fark edip kuyrugun
// baslatmadan once uyarmasi. Gercek koruma is tanimini duzgun bolmekte.

import { OLAY, yaz as olayYaz } from './events.js';
import { KOSU_DURUMU } from './isler.js';
import { kisilik } from './kisilik.js';

const SEP = String.fromCharCode(92);

/** Yol karsilastirmasi icin normal hale getirir: ayrac ve buyuk/kucuk harf. */
export function yolNormal(yol) {
  if (!yol) return '';
  let y = String(yol).split(SEP).join('/').replace(/\/+$/, '');
  // Windows dosya sistemi buyuk/kucuk harf ayirmiyor: "C:/A" ile "c:/a" ayni yer.
  if (process.platform === 'win32') y = y.toLowerCase();
  return y;
}

/** a, b'nin icinde mi (ya da ayni mi)? */
export function iceriyorMu(ust, alt) {
  const u = yolNormal(ust), a = yolNormal(alt);
  if (!u || !a) return false;
  return a === u || a.startsWith(u + '/');
}

/**
 * Iki is ayni yere mi dokunuyor?
 * Ic ice klasorler de cakisir: biri kokte calisirken digeri alt klasorde
 * calisiyorsa ayni dosyalara denk gelebilirler.
 */
export function cakisirMi(a, b) {
  return iceriyorMu(a.cwd, b.cwd) || iceriyorMu(b.cwd, a.cwd);
}

/**
 * Su an calisan kosular arasinda bu isle cakisan var mi?
 * Doner: [{ kosuId, isAd, ajan, cwd }]
 */
export function cakisanlar(db, is, { hariçKosuId = null } = {}) {
  const satirlar = db.prepare(`
    SELECT k.id kosu_id, k.session_id, i.ad, i.cwd, i.id is_id
    FROM kosular k JOIN isler i ON i.id = k.is_id
    WHERE k.durum = ?
  `).all(KOSU_DURUMU.CALISIYOR);

  const out = [];
  for (const r of satirlar) {
    if (hariçKosuId && r.kosu_id === hariçKosuId) continue;
    if (!cakisirMi(is, { cwd: r.cwd })) continue;
    const k = kisilik(r.session_id);
    out.push({
      kosuId: r.kosu_id, isId: r.is_id, isAd: r.ad, cwd: r.cwd,
      ajan: { ad: k.ad, simge: k.simge },
      // Ayni is iki kez kosuyorsa bu daha ciddi: kesin ayni dosyalar.
      ayniIs: r.is_id === is.id,
    });
  }
  return out;
}

/** Insan okunur uyari metni. */
export function uyariMetni(is, liste) {
  if (!liste.length) return null;
  const kimler = liste.map((c) => c.ajan.simge + ' ' + c.ajan.ad + ' (' + c.isAd + ')').join(', ');
  const ayni = liste.some((c) => c.ayniIs);
  return (ayni ? 'Ayni is zaten calisiyor: ' : 'Ayni klasorde calisan var: ') + kimler
    + '. Ayni dosyalari duzenlerlerse biri digerinin isini ezebilir.';
}

/**
 * Kuyruk bir kosuyu baslatmadan once cagrilir.
 * politika:
 *   'uyar'    - olaya yaz, yine de baslat (varsayilan)
 *   'beklet'  - baslatma, cakisma bitince kuyruk tekrar dener
 *   'yoksay'  - hicbir sey yapma
 * Doner: { engelle: bool, cakisanlar, uyari }
 */
export function denetle(db, is, { politika = 'uyar', kosuId = null } = {}) {
  if (politika === 'yoksay') return { engelle: false, cakisanlar: [], uyari: null };

  const liste = cakisanlar(db, is, { hariçKosuId: kosuId });
  if (!liste.length) return { engelle: false, cakisanlar: [], uyari: null };

  const uyari = uyariMetni(is, liste);
  olayYaz(db, {
    kind: OLAY.HATA,
    project: is.ad,
    data: {
      nerede: 'cakisma', politika, kosuId, uyari,
      cakisanKosular: liste.map((c) => c.kosuId),
    },
  });
  return { engelle: politika === 'beklet', cakisanlar: liste, uyari };
}
