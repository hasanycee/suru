// Komuta merkezi verisi: "su an kim ne yapiyor" sorusunun tek paketi.
//
// Iki uc besler:
//   goruntu(db)      - acilista: kosular (calisan + karar bekleyen + yeni bitenler), her birinin
//                      son satirlari ve token sayaci, acik kararlar, imlec (son seq).
//   akis(db, since)  - sonrasinda: imlecten beri olan anlatilmis olaylar + maliyet tiklari.
// Sayfa sutun secimini kendi yapar; burasi sadece dogru ve kucuk veri verir.

import { basename } from 'node:path';
import { OLAY, oku as olayOku, sonSeq } from './events.js';
import { isGetir } from './isler.js';
import { bekleyenKararlar, kararKarti } from './eskalasyon.js';
import { ajanKimligi } from './kisilik.js';
import { anlat } from './anlati.js';

const ACIK = ['bekliyor', 'calisiyor', 'karar-bekliyor'];

/** Ic islerin (denetci, damitma) okunur adi: '_denetci:<uuid>' yerine 'denetim → <hedef is>'. */
export function gorunenAd(db, ad) {
  const s = String(ad ?? '');
  const m = /^_denetci:(.+)$/.exec(s);
  if (m) { const h = isGetir(db, m[1]); return 'denetim → ' + (h?.ad ?? m[1].slice(0, 6)); }
  if (s.startsWith('_damitma:')) return 'hafiza damitma';
  return s;
}

/** Sutunda gosterilecek kosular: once canli olanlar, sonra en yeni bitenler. */
export function kosuListesi(db, { simdi = Date.now(), pencereMs = 6 * 3600_000, enFazla = 12 } = {}) {
  // INNER JOIN: isi silinmis kosu masaya oturmaz. Saha: eski gunlerden 'karar-bekliyor'da asili
  // kalmis yetim kosular (is silme duzeltmesinden onceki veri) ilk iki masayi kapliyordu.
  // Karar bekleyen kosu ancak ACIK karari varsa canlidir; karari kapanmis olan gecmistir.
  const satirlar = db.prepare(`SELECT k.* FROM kosular k JOIN isler i ON i.id = k.is_id
      WHERE k.durum IN ('bekliyor','calisiyor')
         OR (k.durum = 'karar-bekliyor' AND EXISTS (SELECT 1 FROM kararlar r WHERE r.kosu_id = k.id AND r.durum = 'bekliyor'))
         OR COALESCE(k.bitti, k.basladi) >= ?
      ORDER BY CASE k.durum WHEN 'calisiyor' THEN 0 WHEN 'karar-bekliyor' THEN 1 WHEN 'bekliyor' THEN 2 ELSE 3 END,
               COALESCE(k.bitti, k.basladi) DESC LIMIT ?`).all(simdi - pencereMs, enFazla);
  return satirlar.map((r) => {
    const is = isGetir(db, r.is_id);
    const kim = ajanKimligi({ isId: r.is_id, sessionId: r.session_id });
    return {
      id: r.id, oturum: r.session_id, durum: r.durum, canli: ACIK.includes(r.durum),
      basladi: r.basladi, bitti: r.bitti ?? null, usd: r.usd ?? 0, model: r.model ?? is?.model ?? null,
      tur: r.tur ?? null, rol: r.rol ?? null, devam: !!r.devam_cevabi, dal: r.worktree_dal ?? null,
      degisen: r.degisen_dosya ?? null, turSayisi: r.tur_sayisi ?? null, aracSayisi: r.arac_sayisi ?? null,
      // Geri al dugmesi: golge checkpoint cifti varsa bu kosunun degisiklikleri tek tikla geri sarilabilir.
      geriAlinabilir: !!(r.golge_once && r.golge_sonra), geriAlindi: r.geri_alindi ?? null,
      is: is ? { id: is.id, ad: gorunenAd(db, is.ad), profil: is.profil, proje: basename(is.cwd), ic: String(is.ad).startsWith('_') } : null,
      ajan: { ad: kim.ad, simge: kim.simge, hue: kim.hue },
    };
  });
}

/** Bir kosunun son anlatilmis satirlari ve token toplami (o kosunun olaylarindan). */
export function kosuAyrintisi(db, kosu, { satir = 30 } = {}) {
  const olaylar = db.prepare(`SELECT * FROM events WHERE session_id = ? AND at >= ? ORDER BY seq DESC LIMIT 400`)
    .all(kosu.oturum, (kosu.basladi ?? 0) - 5000)
    .map((r) => ({ seq: Number(r.seq), at: r.at, kind: r.kind, sessionId: r.session_id, project: r.project,
      data: r.data ? JSON.parse(r.data) : null }))
    // Ayni oturumda birden cok kosu olabilir (devam kosulari): kosuId tasiyan olay bu kosuya ait olmali.
    .filter((o) => !o.data?.kosuId || o.data.kosuId === kosu.id);
  let girdi = 0, cikti = 0, usdCanli = 0;
  const satirlar = [];
  for (const o of olaylar) {
    if (o.kind === OLAY.MALIYET) { girdi += o.data?.girdi || 0; cikti += o.data?.cikti || 0; usdCanli += o.data?.usd || 0; continue; }
    if (satirlar.length < satir) { const a = anlat(o); if (a) satirlar.push(a); }
  }
  return { satirlar: satirlar.reverse(), token: { girdi, cikti }, usdCanli };
}

export function goruntu(db, kuyruk, secenekler = {}) {
  const kosular = kosuListesi(db, secenekler).map((k) => ({ ...k, ...kosuAyrintisi(db, k) }));
  return {
    simdi: Date.now(), son: sonSeq(db),
    kosular,
    kararlar: bekleyenKararlar(db).map((k) => ({ ...kararKarti(db, k), kosuId: k.kosuId })),
    kuyruk: kuyruk?.durum?.() ?? null,
  };
}

/** Imlecten beri: anlatilmis satirlar + maliyet tiklari. Yeni kosu/karar varsa sayfa goruntu'yu yeniden ceker. */
export function akis(db, since, { limit = 500 } = {}) {
  const olaylar = olayOku(db, { sinceSeq: Number(since) || 0, limit });
  const satirlar = [], maliyet = [];
  let yenile = false;
  for (const o of olaylar) {
    if (o.kind === OLAY.MALIYET) {
      if (o.data?.kosuId) maliyet.push({ kosu: o.data.kosuId, girdi: o.data.girdi || 0, cikti: o.data.cikti || 0, usd: o.data.usd || 0 });
      continue;
    }
    // Kosu listesini ya da karar seridini degistiren olaylar: tam goruntu yeniden cekilsin.
    if ((o.kind === OLAY.IS && ['siraya-alindi', 'kuyruktan-alindi', 'bitti', 'durduruldu', 'worktree-kapandi', 'dogrulandi'].includes(o.data?.asama))
        || o.kind === OLAY.KARAR) yenile = true;
    const a = anlat(o);
    // Ic is adlari (_denetci:<uuid>) okunur hale gelsin.
    if (a) satirlar.push({ ...a, proje: gorunenAd(db, a.proje) });
  }
  return { son: olaylar.length ? olaylar[olaylar.length - 1].seq : Number(since) || 0, satirlar, maliyet, yenile };
}
