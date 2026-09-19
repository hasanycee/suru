// Kendi kendine is uretme - DIKKATLI: ajanin rapor sonundaki "Sonraki adim: ..." satiri bir ONERIDIR.
// Suru bunu is olarak acmaz; kv'ye yazar, Telegram'da "Ac / Gec" dugmesiyle sunar, panel/komutla listelenir.
// Kota beynine bagli: pencere kisitliyken oneri uretilmez (butce dusukken yeni is acmaya tesvik olmasin).
//
// Ayrica otomatik baglam yonetiminin devam adimi burada: esik asilip ozetle biten kosu icin ayni ise
// YENI oturum (taze baglam) acilir; ozet ekTalimat olarak sistem istemine gider.

import { randomBytes } from 'node:crypto';
import { kvOku, kvYaz } from './db.js';
import { kosuGetir, isGetir, KOSU_DURUMU } from './isler.js';
import { OLAY, yaz as olayYaz, oku as olayOku } from './events.js';

const KV = 'oneriler';
const NL = String.fromCharCode(10);

/** Rapor metninden "Sonraki adim: ..." satirini cikarir (son eslesme). Yoksa null. */
export function sonrakiAdim(sonuc) {
  const m = [...String(sonuc ?? '').matchAll(/^\s*(?:[-*]\s*)?(?:\*\*)?Sonraki ad[iı]m:?(?:\*\*)?\s*:?\s*(.+?)\s*$/gim)];
  if (!m.length) return null;
  const metin = m[m.length - 1][1].replace(/\s+/g, ' ').trim();
  return metin.length >= 8 ? metin.slice(0, 300) : null;
}

export function oneriler(db) {
  const l = kvOku(db, KV, []);
  return Array.isArray(l) ? l : [];
}

function yaz(db, liste) { kvYaz(db, KV, liste.slice(-50)); }

/**
 * Biten kosudan oneri cikarir ve kaydeder. Doner: oneri ya da null.
 * Yalniz BITTI kosular, kullanici isleri; ayni kosudan ikinci kez uretilmez; kota kisitliyken uretilmez.
 */
export function oneriUret(db, { kosuId, kotaKisitli = false }) {
  const kosu = kosuGetir(db, kosuId);
  if (!kosu || kosu.durum !== KOSU_DURUMU.BITTI) return null;
  const is = isGetir(db, kosu.isId);
  if (!is || String(is.ad).startsWith('_')) return null;
  const metin = sonrakiAdim(kosu.sonuc);
  if (!metin) return null;
  const liste = oneriler(db);
  if (liste.some((o) => o.kosuId === kosuId)) return null;
  if (kotaKisitli) {
    olayYaz(db, { kind: OLAY.IS, sessionId: kosu.sessionId, project: is.ad,
      data: { asama: 'oneri', kosuId, isId: is.id, metin, atlandi: 'kota kisitli' } });
    return null;
  }
  const o = { id: randomBytes(3).toString('hex'), kosuId, isId: is.id, cwd: is.cwd, isAd: is.ad, metin, zaman: Date.now(), durum: 'acik' };
  yaz(db, [...liste, o]);
  olayYaz(db, { kind: OLAY.IS, sessionId: kosu.sessionId, project: is.ad, data: { asama: 'oneri', kosuId, isId: is.id, metin, oneriId: o.id } });
  return o;
}

export function oneriBul(db, id) {
  const o = oneriler(db).find((x) => x.id === String(id ?? '').trim().toLowerCase());
  if (!o) throw new Error('oneri bulunamadi: ' + id);
  return o;
}

/** Oneriyi kapatir ('acildi' | 'gecildi'). */
export function oneriKapat(db, id, durum) {
  const liste = oneriler(db);
  const o = liste.find((x) => x.id === id);
  if (!o) throw new Error('oneri bulunamadi: ' + id);
  o.durum = durum; o.kapandi = Date.now();
  yaz(db, liste);
  return o;
}

export function oneriMetni(o) {
  return '💡 ' + o.isAd + ' bitti; ajan sonraki adim oneriyor:' + NL + o.metin + NL + '[' + o.id + '] ac: /oneri-ac ' + o.id + ' · gec: /oneri-gec ' + o.id;
}

export function oneriDugmeleri(o) {
  return [{ secenekler: [{ etiket: 'Ac (is olarak kuyruga al)', veri: 'o:/oneri-ac ' + o.id }, { etiket: 'Gec', veri: 'o:/oneri-gec ' + o.id }] }];
}

/**
 * Otomatik baglam devami: kosu 'baglam-esigi' olayi yazdiysa ve ozetle bittiyse, ayni ise ozetle
 * YENI oturum acilir (--resume degil: baglam sifirlanir). Ozet sistem istemine ekTalimat olarak gider.
 * Doner: yeni kosu ya da null. En fazla 'enFazlaParca' zincir: sonsuz ozet dongusu olmasin.
 */
export function baglamDevami(db, kuyruk, { kosuId, enFazlaParca = 5 }) {
  const kosu = kosuGetir(db, kosuId);
  if (!kosu || kosu.durum !== KOSU_DURUMU.BITTI || !kosu.sonuc) return null;
  const esik = olayOku(db, { sinceSeq: 0, sessionId: kosu.sessionId, limit: 5000 })
    .some((o) => o.kind === OLAY.IS && o.data?.asama === 'baglam-esigi' && o.data?.kosuId === kosuId);
  if (!esik) return null;
  const is = isGetir(db, kosu.isId);
  if (!is) return null;
  const onceki = /Onceki kosu ozeti \(parca (\d+)\)/.exec(kosu.ekTalimat ?? '');
  const parca = onceki ? Number(onceki[1]) + 1 : 1;
  if (parca > enFazlaParca) {
    olayYaz(db, { kind: OLAY.HATA, sessionId: kosu.sessionId, project: is.ad,
      data: { kosuId, nerede: 'baglam', mesaj: 'baglam zinciri ' + enFazlaParca + ' parcayi asti, otomatik devam durduruldu' } });
    return null;
  }
  const ekTalimat = 'Onceki kosu ozeti (parca ' + parca + '): baglam dolunca ajan ozet yazip durdu. Bu YENI oturum; kalan isleri '
    + 'ozetten surdur, bitenleri tekrar yapma. Ozet:' + NL + String(kosu.sonuc).trim().slice(0, 6000);
  const yeni = kuyruk.siraya(is.id, { ekTalimat });
  olayYaz(db, { kind: OLAY.IS, sessionId: yeni.sessionId, project: is.ad, data: { asama: 'baglam-devam', kosuId: yeni.id, isId: is.id, onceki: kosuId, parca } });
  return yeni;
}
