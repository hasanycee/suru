// Git tetikleyici: "ben push edince Suru devreye girsin".
//
// Neden aga cikmiyoruz: basarili bir `git push` yerel refs/remotes/<uzak>/<dal>
// refini de gunceller. Yani push'u, uzak sunucuya hic sormadan, yerel depodan
// gormek mumkun. Olculdu: sadece commit atinca uzak-izleme refi kipirdamiyor,
// push edince HEAD'e esitleniyor. Bu yuzden tetik bedava ve aninda - `ls-remote`
// ile 30 saniyede bir ag cagrisi yapmaya gerek yok.
//
// Kurallar (zamanlama.js ile ayni aile):
//   - Ilk gorus TETIKLEMEZ: taban commit kaydedilir. Yoksa is eklenir eklenmez
//     eski bir commit icin kosardi.
//   - Is zaten kuyrukta/calisiyorsa ya da karar bekliyorsa tetik ATLANIR.
//   - Birikme yok: arada kac commit geldiyse tek kosu. Aralik ajana verilir.
//   - Depo yoksa/ref cozulmuyorsa is sessizce atlanir; hata olayi yazilir ama
//     kosu acilmaz (her 30 saniyede bir kuyruk sismesin).

import { execFileSync } from 'node:child_process';
import { OLAY, yaz as olayYaz } from './events.js';

const AKTIF_DURUMLAR = "('bekliyor','calisiyor','karar-bekliyor')";

/**
 * Tetik ifadesini normalize eder. Bos/null -> null (tetik yok).
 * 'HEAD'        : yerel commit (commit/merge/pull/checkout)
 * 'origin/main' : PUSH (uzak-izleme refi)
 * '@{u}'        : icinde bulunulan dalin upstream'i
 */
export function gitTetikNormal(ifade) {
  const t = String(ifade ?? '').trim();
  if (!t) return null;
  // Ref adi: git'in kendi kurallarindan daha dar bir kume yetiyor.
  if (!/^[A-Za-z0-9_./@{}-]{1,200}$/.test(t)) throw new Error('gecersiz git referansi: ' + t);
  if (t.includes('..')) throw new Error('gecersiz git referansi: ' + t);
  return t;
}

/** Referansin commit'i. Cozulemezse null (depo yok, ref yok, upstream yok). */
export function refOku(cwd, ref) {
  try {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
    const c = execFileSync('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', ref + '^{commit}'],
      { encoding: 'utf8', env, windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const t = c.trim();
    return /^[0-9a-f]{7,40}$/.test(t) ? t : null;
  } catch { return null; }
}

/** Iki commit arasindaki ozet (ajana verilecek): en fazla `enFazla` satir. */
export function araligiOzetle(cwd, oncekiCommit, yeniCommit, { enFazla = 20 } = {}) {
  if (!oncekiCommit || oncekiCommit === yeniCommit) return null;
  try {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
    const kos = (args) => execFileSync('git', ['-C', cwd, ...args],
      { encoding: 'utf8', env, windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const aralik = oncekiCommit + '..' + yeniCommit;
    const log = kos(['log', '--no-color', '--format=%h %s', '-n', String(enFazla), aralik]);
    const dosyalar = kos(['diff', '--no-color', '--name-status', aralik]);
    if (!log && !dosyalar) return null;
    return { aralik, log, dosyalar };
  } catch { return null; }
}

/** Ajana verilecek ek talimat: NE degistigini soyler, ne yapacagini gorev soyler. */
export function tetikTalimati(ozet, ref) {
  if (!ozet) return null;
  const s = ['# Bu kosuyu tetikleyen git degisikligi',
    'Izlenen referans: ' + ref + ' (aralik ' + ozet.aralik + ')'];
  if (ozet.log) { s.push('', 'Commitler:', ozet.log); }
  if (ozet.dosyalar) { s.push('', 'Degisen dosyalar:', ozet.dosyalar.slice(0, 4000)); }
  s.push('', 'Bu aralik gorevinin KAPSAMIDIR: gorev aksini soylemiyorsa bu degisiklige odaklan.');
  return s.join('\n');
}

/**
 * Izlenen referansi degismis isleri kuyruga alir. Sunucu periyodik cagirir.
 * `oku`/`ozetle` testte degistirilebilir.
 * Donus: [{ isId, ad, kosuId, commit } | { isId, ad, atlandi: true, neden }]
 */
export function tetikle(db, kuyruk, { oku = refOku, ozetle = araligiOzetle } = {}) {
  const isler = db.prepare(`SELECT id, ad, cwd, git_tetik, son_commit FROM isler
    WHERE etkin = 1 AND git_tetik IS NOT NULL`).all();
  const sonuc = [];

  for (const r of isler) {
    const commit = oku(r.cwd, r.git_tetik);
    if (!commit) {
      olayYaz(db, { kind: OLAY.HATA, project: r.ad,
        data: { isId: r.id, nerede: 'git-tetik', mesaj: 'referans cozulemedi: ' + r.git_tetik } });
      continue;
    }
    // Ilk gorus: taban. Eski bir commit icin kosmayalim.
    if (!r.son_commit) {
      db.prepare('UPDATE isler SET son_commit = ? WHERE id = ?').run(commit, r.id);
      olayYaz(db, { kind: OLAY.IS, project: r.ad,
        data: { asama: 'git-taban', isId: r.id, ref: r.git_tetik, commit } });
      continue;
    }
    if (commit === r.son_commit) continue;

    const onceki = r.son_commit;
    // Once kaydet: kosu acilamasa bile ayni commit her tikta yeniden denenmesin.
    db.prepare('UPDATE isler SET son_commit = ? WHERE id = ?').run(commit, r.id);

    const aktif = Number(db.prepare(`SELECT COUNT(*) n FROM kosular WHERE durum IN ${AKTIF_DURUMLAR} AND (is_id = ?
      OR dongu_id IN (SELECT dongu_id FROM kosular WHERE is_id = ? AND dongu_id IS NOT NULL))`).get(r.id, r.id).n);
    if (aktif) {
      const neden = 'onceki kosu bitmedi ya da karar bekliyor';
      olayYaz(db, { kind: OLAY.IS, project: r.ad,
        data: { asama: 'git-atlandi', isId: r.id, ref: r.git_tetik, commit, neden } });
      sonuc.push({ isId: r.id, ad: r.ad, atlandi: true, neden });
      continue;
    }

    const ekTalimat = tetikTalimati(ozetle(r.cwd, onceki, commit), r.git_tetik);
    const kosu = kuyruk.siraya(r.id, ekTalimat ? { ekTalimat } : {});
    olayYaz(db, { kind: OLAY.IS, sessionId: kosu.sessionId, project: r.ad,
      data: { asama: 'git-tetiklendi', isId: r.id, kosuId: kosu.id, ref: r.git_tetik, onceki, commit } });
    sonuc.push({ isId: r.id, ad: r.ad, kosuId: kosu.id, commit });
  }
  return sonuc;
}
