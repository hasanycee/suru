// Veri akisi defteri: hangi veri, hangi tarafa gitti?
//
// Kisisel kullanimda bile sorulmasi gereken soru: "bu projenin hangi dosyalari
// modele gitti, makineden disari ne cikti?" Defter bunu KOSU BASINA kaydeder.
//
// Kaynaklar:
//   istem    : gorev + ek sistem istemi (hafiza dizini, denetim bulgulari)   -> anthropic
//   baglam   : otomatik yuklenen CLAUDE.md / kural dosyalari (baglam.js)      -> anthropic
//   dosya    : BASARIYLA okunan dosyalar (kanit zinciri; reddedilen okuma yok) -> anthropic
//   arama    : Grep/Glob (eslesen icerik modele gider)                        -> anthropic
//   komut    : calistirilan Bash komutlari (ciktisi modele gider)            -> anthropic
//   web      : WebFetch adresi / WebSearch sorgusu                            -> host / arama
//   bildirim : yerel olmayan bildirim kanali (ntfy, webhook)                  -> kanal
//
// Gizli desene takilan dosya/baglam satiri `ihlal` alanina desenle yazilir: yasak
// uygulandiysa hic olusmamasi gerekir. Olusursa uygulama katmani sizdirmistir.
//
// Bilinen sinirlar: alt-ajanlarin (Task) ayri transkript dosyasina yazdigi okumalar
// ve Grep sonucunda gecen gizli dosya icerigi dosya olarak sayilmaz; arama satiri
// olarak gorunur.

import { yolNormal } from './cakisma.js';
import { yolEslesen } from './gizlilik.js';

export const AKIS = {
  ISTEM: 'istem', BAGLAM: 'baglam', DOSYA: 'dosya', ARAMA: 'arama',
  KOMUT: 'komut', WEB: 'web', BILDIRIM: 'bildirim', SIR: 'sir',
};

const GUN = 86_400_000;

function host(u) {
  try { return new URL(u).host || null; } catch { return null; }
}

/** Kosunun defter satirlari. Saf fonksiyon: dosya/db okumaz. */
export function kosuDefteri({ kosu, is, zincir = null, baglamDosyalari = [], istemBoyutu = 0, gizlilik = null, simdi = Date.now() }) {
  const proje = yolNormal(is.cwd);
  const s = [];
  const ekle = (tur, hedef, ayrinti, boyut = null, ihlal = null) => s.push({
    zaman: simdi, kosuId: kosu.id, proje, tur, hedef,
    ayrinti: String(ayrinti ?? '').slice(0, 500), boyut, ihlal,
  });
  const ihlal = (yol) => yolEslesen(gizlilik, is.cwd, yol);

  ekle(AKIS.ISTEM, 'anthropic', 'gorev + ek sistem istemi', istemBoyutu);
  for (const d of baglamDosyalari) ekle(AKIS.BAGLAM, 'anthropic', d.yol, d.bayt ?? null, ihlal(d.yol));
  if (zincir) {
    for (const y of zincir.veriAkisi.modeleGidenDosyalar) ekle(AKIS.DOSYA, 'anthropic', y, null, ihlal(y));
    for (const a of zincir.adimlar) {
      if ((a.arac === 'Grep' || a.arac === 'Glob') && !a.hata) ekle(AKIS.ARAMA, 'anthropic', a.arac + ': ' + a.girdi);
    }
    for (const k of zincir.veriAkisi.calistirilanKomutlar) ekle(AKIS.KOMUT, 'anthropic', k);
    for (const w of zincir.veriAkisi.disariIstekler) ekle(AKIS.WEB, host(w) ?? 'web-arama', w);
    // Koda gomulu sir modele gitti: yol yasagi yakalayamaz, her zaman ihlal.
    for (const x of zincir.sirlar ?? []) {
      ekle(AKIS.SIR, 'anthropic', x.arac + ': ' + x.girdi + ' (' + x.tur + ' ' + x.maske + ')', null, 'sir:' + x.tur);
    }
  }
  return s;
}

export function defterYaz(db, satirlar) {
  if (!satirlar?.length) return 0;
  const st = db.prepare(`INSERT INTO veri_akisi (zaman, kosu_id, proje, tur, hedef, ayrinti, boyut, ihlal)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (const r of satirlar) {
    st.run(r.zaman, r.kosuId ?? null, r.proje ?? null, r.tur, r.hedef ?? null, r.ayrinti ?? null,
      r.boyut ?? null, r.ihlal ?? null);
  }
  return satirlar.length;
}

/** Eski satirlari atar. */
export function defterKirp(db, { gun = 90, simdi = Date.now() } = {}) {
  return Number(db.prepare('DELETE FROM veri_akisi WHERE zaman < ?').run(simdi - gun * GUN).changes ?? 0);
}

/** Panel/rapor ozeti: son `gun` gunde, istenirse tek proje. */
export function ozet(db, { cwd = null, gun = 7, simdi = Date.now() } = {}) {
  const kosul = ['zaman >= ?'], arg = [simdi - gun * GUN];
  if (cwd) { kosul.push('proje = ?'); arg.push(yolNormal(cwd)); }
  const w = ' WHERE ' + kosul.join(' AND ');
  const q = (sql, ...ek) => db.prepare(sql).all(...arg, ...ek);

  return {
    gun,
    kosu: Number(db.prepare('SELECT COUNT(DISTINCT kosu_id) n FROM veri_akisi' + w).get(...arg)?.n ?? 0),
    hedefler: q('SELECT hedef, tur, COUNT(*) adet FROM veri_akisi' + w + ' GROUP BY hedef, tur ORDER BY adet DESC'),
    dosyalar: q(`SELECT ayrinti yol, tur, COUNT(*) adet, MAX(zaman) son, MAX(ihlal) ihlal FROM veri_akisi` + w
      + ` AND tur IN ('dosya','baglam') GROUP BY ayrinti, tur ORDER BY adet DESC LIMIT ?`, 40),
    web: q("SELECT hedef, ayrinti, COUNT(*) adet FROM veri_akisi" + w + " AND tur = 'web' GROUP BY hedef, ayrinti ORDER BY adet DESC LIMIT ?", 20),
    bildirim: q("SELECT hedef, COUNT(*) adet FROM veri_akisi" + w + " AND tur = 'bildirim' GROUP BY hedef"),
    ihlaller: q('SELECT zaman, kosu_id kosuId, tur, ayrinti, ihlal FROM veri_akisi' + w
      + ' AND ihlal IS NOT NULL ORDER BY zaman DESC LIMIT ?', 20),
  };
}
