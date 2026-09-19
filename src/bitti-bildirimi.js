// Telegram'a "is bitti" satiri (istege bagli, varsayilan kapali: telegram.bittiBildir).
//
// Gurultu kurali: denetci dongusunde her tur mesaj ATILMAZ; yalniz isin SON bitisi gider. "Son bitis":
// kosu bitti ve o is icin (denetci ic isi dahil) acik/bekleyen baska kosu KALMADI. Karar bekleyen kosu
// zaten karar kartiyla bildiriliyor; burada tekrar etmez. Ic isler (damitma) sessizdir.
//
// Saf: db + kosu kimligi -> metin ya da null. Gonderimi server.js yapar.

import { basename } from 'node:path';
import { kosuGetir, isGetir, KOSU_DURUMU } from './isler.js';
import { kimlikCoz } from './kisilik.js';

const para = (u) => '$' + Number(u ?? 0).toFixed(2);
const sure = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? s + ' sn' : s < 3600 ? Math.floor(s / 60) + ' dk' : (s / 3600).toFixed(1) + ' sa';
};

/** Denetci ic isi hedef isin kimligine cozulur; digerleri kendisi. */
export function hedefIsId(is) {
  const m = /^_denetci:(.+)$/.exec(String(is?.ad ?? ''));
  return m ? m[1] : is?.id ?? null;
}

/** Is icin hala acik (bekliyor/calisiyor) kosu var mi: kendisi ya da denetcisi. */
export function isAcikMi(db, isId) {
  const r = db.prepare(`SELECT COUNT(*) n FROM kosular k JOIN isler i ON i.id = k.is_id
    WHERE k.durum IN ('bekliyor','calisiyor') AND (i.id = ? OR i.ad = ?)`).get(isId, '_denetci:' + isId);
  return Number(r?.n ?? 0) > 0;
}

export function bittiMesaji(db, { kosuId }) {
  const kosu = kosuGetir(db, kosuId);
  if (!kosu) return null;
  const isKaydi = isGetir(db, kosu.isId);
  if (!isKaydi) return null;
  const hedefId = hedefIsId(isKaydi);
  const is = hedefId === isKaydi.id ? isKaydi : isGetir(db, hedefId);
  if (!is || String(is.ad).startsWith('_')) return null;           // damitma ve diger ic isler sessiz
  if (kosu.durum === KOSU_DURUMU.KARAR_BEKLIYOR) return null;      // karar karti zaten gidiyor
  if (isAcikMi(db, is.id)) return null;                             // dongu suruyor: son bitis degil

  // Son bitisin hukmu: denetci kosusu bittiyse hedef isin SON yapici kosusu ne halde?
  const son = db.prepare('SELECT * FROM kosular WHERE is_id = ? ORDER BY basladi DESC LIMIT 1').get(is.id);
  if (!son) return null;
  if (son.durum === KOSU_DURUMU.KARAR_BEKLIYOR) return null;
  const kim = kimlikCoz(db, { isId: is.id, sessionId: son.session_id, isAd: is.ad });
  const toplam = db.prepare(`SELECT COALESCE(SUM(k.usd),0) usd, COUNT(*) n FROM kosular k JOIN isler i ON i.id = k.is_id
    WHERE (i.id = ? OR i.ad = ?) AND k.basladi >= ?`).get(is.id, '_denetci:' + is.id, son.basladi - 12 * 3600_000);
  const durum = son.durum === KOSU_DURUMU.BITTI ? (kosu.rol === 'denetci' || isKaydi.id !== is.id ? 'bitti, denetimden gecti' : 'bitti')
    : son.durum === KOSU_DURUMU.HATA ? 'HATAYLA bitti' : son.durum === KOSU_DURUMU.IPTAL ? 'durduruldu' : son.durum;
  const parcalar = [kim.simge + ' ' + kim.ad + ' · ' + is.ad + ' (' + basename(is.cwd) + '): ' + durum];
  parcalar.push(para(toplam.usd) + (toplam.n > 1 ? ' / ' + toplam.n + ' kosu' : ''));
  if (son.bitti && son.basladi) parcalar.push(sure(son.bitti - son.basladi));
  if (son.degisen_dosya != null) parcalar.push(son.degisen_dosya + ' dosya degisti');
  if (son.worktree_dal) parcalar.push('dal ' + son.worktree_dal);
  return parcalar.join(' · ');
}
