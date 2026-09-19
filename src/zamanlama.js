// Zamanlama: isleri takvime baglar (cron benzeri, yerel saat). "Otomatige baglama"nin ilk ayagi.
//
// Kurallar:
//   - Kacirilan tetikler BIRIKMEZ: sunucu kapaliyken bes tetik kacirildiysa acilista tek kosu.
//   - Is zaten kuyrukta/calisiyorsa ya da karar bekliyorsa (denetim dongusu dahil) tetik
//     ATLANIR ve olay yazilir: ayni is ust uste binmez, insana karar yigilmaz.
//   - Zamanlanan is normal kuyruktan gecer: kota beyni ve es zamanlilik siniri gecerli.
//   - Bicim: 5 alan "dakika saat gun ay haftagunu"; *, liste (1,2), aralik (1-5), adim (*/15, 1-10/2).
//     Haftagunu 0-6 (0 = Pazar), 7 de Pazar. Gun ve haftagunu ikisi de kisitliysa biri yeter (cron kurali).

import { OLAY, yaz as olayYaz } from './events.js';

const DK = 60_000;
const ALANLAR = [
  { ad: 'dakika', min: 0, max: 59 },
  { ad: 'saat', min: 0, max: 23 },
  { ad: 'gun', min: 1, max: 31 },
  { ad: 'ay', min: 1, max: 12 },
  { ad: 'haftagunu', min: 0, max: 7 },
];

function alanCoz(metin, { ad, min, max }) {
  const s = new Set();
  for (const parca of String(metin).split(',')) {
    const m = parca.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error('gecersiz ' + ad + ' alani: ' + parca);
    let bas, son;
    if (m[1] === '*') { bas = min; son = max; }
    else {
      [bas, son] = m[1].split('-').map(Number);
      if (son === undefined) son = m[2] ? max : bas;
    }
    const adim = m[2] ? Number(m[2]) : 1;
    if (adim < 1 || bas < min || son > max || bas > son) throw new Error(ad + ' araligi disinda: ' + parca);
    for (let v = bas; v <= son; v += adim) s.add(v);
  }
  return s;
}

/** Cron ifadesini cozer; gecersizse aciklayici hata atar. */
export function cronCoz(ifade) {
  const p = String(ifade ?? '').trim().split(/\s+/);
  if (p.length !== 5) throw new Error('zamanlama 5 alan olmali (dakika saat gun ay haftagunu): ' + ifade);
  const [dk, sa, gun, ay, hg] = p.map((x, i) => alanCoz(x, ALANLAR[i]));
  if (hg.has(7)) hg.add(0);
  return { dk, sa, gun, ay, hg, gunYildiz: p[2] === '*', hgYildiz: p[4] === '*' };
}

function gunUyar(c, d) {
  const g = c.gun.has(d.getDate()), h = c.hg.has(d.getDay());
  return (!c.gunYildiz && !c.hgYildiz) ? (g || h) : (g && h);
}

/** Verilen andan SONRAKI ilk tetik zamani (ms, yerel saat). Bulunamazsa null. */
export function sonrakiZaman(ifade, simdi = Date.now(), { enFazlaGun = 366 } = {}) {
  const c = typeof ifade === 'string' ? cronCoz(ifade) : ifade;
  const d = new Date(Math.floor(simdi / DK) * DK + DK);
  const son = simdi + enFazlaGun * 86_400_000;
  // Uyusmayan ay/gun/saat bastan atlanir: imkansiz ifadede bile tarama hizli kalir.
  while (d.getTime() <= son) {
    if (!c.ay.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    if (!gunUyar(c, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!c.sa.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!c.dk.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d.getTime();
  }
  return null;
}

/** Gecerli ifadeyse temizlenmis halini, bos ise null dondurur; gecersizse hata atar. */
export function zamanlamaNormal(ifade) {
  if (ifade == null || !String(ifade).trim()) return null;
  const t = String(ifade).trim().replace(/\s+/g, ' ');
  cronCoz(t);
  return t;
}

const AKTIF_DURUMLAR = "('bekliyor','calisiyor','karar-bekliyor')";

/**
 * Vadesi gelen zamanlanmis isleri kuyruga alir. Sunucu periyodik cagirir.
 * Donus: [{ isId, ad, kosuId } | { isId, ad, atlandi: true, neden }]
 */
export function tetikle(db, kuyruk, { simdi = Date.now() } = {}) {
  const isler = db.prepare('SELECT id, ad, zamanlama, son_tetik, olusturuldu FROM isler WHERE etkin = 1 AND zamanlama IS NOT NULL').all();
  const sonuc = [];
  for (const r of isler) {
    let vade;
    try { vade = sonrakiZaman(r.zamanlama, r.son_tetik ?? r.olusturuldu); } catch { continue; }
    if (vade == null || vade > simdi) continue;

    // Kacirilanlar birikmesin: son tetik SIMDIYE cekilir, arada kalan vadeler tek kosuda erir.
    db.prepare('UPDATE isler SET son_tetik = ? WHERE id = ?').run(Math.floor(simdi / DK) * DK, r.id);

    const aktif = Number(db.prepare(`SELECT COUNT(*) n FROM kosular WHERE durum IN ${AKTIF_DURUMLAR} AND (is_id = ?
      OR dongu_id IN (SELECT dongu_id FROM kosular WHERE is_id = ? AND dongu_id IS NOT NULL))`).get(r.id, r.id).n);
    if (aktif) {
      const neden = 'onceki kosu bitmedi ya da karar bekliyor';
      olayYaz(db, { kind: OLAY.IS, project: r.ad, data: { asama: 'zamanlama-atlandi', isId: r.id, vade, neden } });
      sonuc.push({ isId: r.id, ad: r.ad, atlandi: true, neden });
      continue;
    }
    const kosu = kuyruk.siraya(r.id);
    olayYaz(db, { kind: OLAY.IS, sessionId: kosu.sessionId, project: r.ad,
      data: { asama: 'zamanlandi', isId: r.id, kosuId: kosu.id, vade } });
    sonuc.push({ isId: r.id, ad: r.ad, kosuId: kosu.id });
  }
  return sonuc;
}
