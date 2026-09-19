// Worktree izolasyonu: ajan senin calisma kopyanda degil, kendi git worktree'sinde calisir.
//
// Neden: es zamanli iki ajan ayni dosyaya dokununca birbirinin isini eziyor
// (bkz. sinav 'cakisma' senaryosu). Golge checkpoint bunu SONRADAN gorur;
// worktree ONCEDEN engeller - iki ajan iki ayri klasorde calisir.
//
// Tasarim kararlari:
//   - Sonuc KENDI DALINDA teslim edilir, senin dalina dokunulmaz. Birlestirme
//     bir karardir; otomatik merge yapmak ezme riskini geri getirir.
//   - Kosu bitince worktree klasoru SILINIR ama once degisiklikler dala
//     commit edilir: is kaybolmaz, klasorler de birikmez.
//   - Worktree HEAD'den (commit'lenmis durumdan) acilir. Senin kaydedilmemis
//     degisikliklerini ajan GORMEZ - bu bir kusur degil, izolasyonun tanimi;
//     ama sessiz kalmasin diye uyari olarak bildirilir.
//   - Git deposu olmayan projede izolasyon KURULAMAZ ve kosu acikca hata verir.
//     Sessizce gercek klasorde kosmak izolasyon sozunu bozardi.

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AJAN_DIZINI } from './paths.js';

const NL = '\n';

function git(cwd, args, { yoksay = false } = {}) {
  // GIT_LFS_SKIP_SMUDGE: LFS'li depoda her izole kosu GB'larca varligi indirmeye kalkmasin;
  // ajan isaretci dosyalarla calisir (kod isi icin yeterli).
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) delete env[k];
  try {
    // core.longPaths: Windows 260 karakter siniri. Olculdu (KorkuOyunu): derin
    // ThirdParty yollari yuzunden 'worktree add' "Filename too long" ile dustu.
    return execFileSync('git', ['-C', cwd, '-c', 'core.longPaths=true', ...args],
      // 20 dk: 16 bin dosyalik bir oyun projesinde checkout 60 sn'yi rahat asar.
      { encoding: 'utf8', env, windowsHide: true, timeout: 20 * 60_000, maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    if (yoksay) return null;
    const ayrinti = String(e?.stderr ?? e?.message ?? e).trim().split(NL).slice(-2).join(' ');
    throw new Error('git ' + args[0] + ' basarisiz: ' + ayrinti);
  }
}

/** Proje bir git deposu mu (ve worktree acilabilir mi)? */
export function depoMu(cwd) {
  return git(cwd, ['rev-parse', '--is-inside-work-tree'], { yoksay: true }) === 'true';
}

/**
 * Worktree'lerin kok klasoru: kullanicinin deposunun DISINDA ve ~/.claude'un da
 * DISINDA. Ikincisi sart: ~/.claude altinda ajan dosya duzenleyemiyor (olculdu,
 * bkz. paths.js AJAN_DIZINI) - worktree oraya konulursa izole kosu hicbir sey
 * yazamaz ve sessizce bos dal uretir.
 */
export function worktreeKoku({ kok = join(AJAN_DIZINI, 'worktree') } = {}) {
  return kok;
}

/** Bu kosunun worktree klasoru. */
export function worktreeDizini(kosuId, secenekler = {}) {
  // Kisa ad: yol uzunlugu Windows'ta gercek bir sinir (bkz. core.longPaths).
  return join(worktreeKoku(secenekler), 'k-' + String(kosuId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8));
}

/** Dal adi: hangi is, hangi kosu - gecmise bakinca anlasilsin. */
export function dalAdi(is, kosuId) {
  const temiz = String(is?.ad ?? 'is').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return 'suru/' + (temiz || 'is') + '-' + String(kosuId).slice(0, 8);
}

/** Kaydedilmemis degisiklik var mi? Ajan bunlari GORMEYECEK. */
export function kirliMi(cwd) {
  const t = git(cwd, ['status', '--porcelain'], { yoksay: true });
  return !!(t && t.length);
}

/**
 * Kosu icin izole bir worktree acar.
 * Doner: { yol, dal, taban, kirliydi }
 */
export function worktreeAc(is, kosuId, { kok = undefined, taban = 'HEAD' } = {}) {
  const cwd = is.cwd;
  if (!depoMu(cwd)) {
    throw new Error('worktree izolasyonu icin git deposu gerekiyor: ' + cwd
      + ' (izolasyonu kapat ya da klasoru `git init` ile depoya cevir)');
  }
  const yol = worktreeDizini(kosuId, kok ? { kok } : undefined);
  const dal = dalAdi(is, kosuId);
  const kirliydi = kirliMi(cwd);
  // Bayat klasor kalmissa temizle: 'worktree add' var olan yola yazmaz.
  if (existsSync(yol)) {
    git(cwd, ['worktree', 'remove', '--force', yol], { yoksay: true });
    try { rmSync(yol, { recursive: true, force: true }); } catch { /* zaten yok */ }
  }
  git(cwd, ['worktree', 'add', '--quiet', '-b', dal, yol, taban]);
  const tabanCommit = git(yol, ['rev-parse', 'HEAD'], { yoksay: true });
  return { yol, dal, taban: tabanCommit, kirliydi };
}

/**
 * Kosu bitince: degisiklikleri dala commit eder, worktree klasorunu siler.
 * Dal kalir - is kaybolmaz. Doner: { dal, commit, degisen, bosSonuc }
 */
export function worktreeKapat(is, { yol, dal }, { kosuId = null, sil = true } = {}) {
  const cwd = is.cwd;
  let commit = null;
  let degisen = 0;
  if (existsSync(yol)) {
    const durum = git(yol, ['status', '--porcelain'], { yoksay: true });
    degisen = durum ? durum.split(NL).filter((s) => s.trim()).length : 0;
    if (degisen) {
      git(yol, ['add', '-A'], { yoksay: true });
      const mesaj = 'suru: ' + (is.ad ?? 'is') + (kosuId ? ' (kosu ' + String(kosuId).slice(0, 8) + ')' : '');
      git(yol, ['-c', 'user.name=suru', '-c', 'user.email=suru@yerel', 'commit', '--quiet', '-m', mesaj], { yoksay: true });
      commit = git(yol, ['rev-parse', 'HEAD'], { yoksay: true });
    }
  }
  if (sil) {
    git(cwd, ['worktree', 'remove', '--force', yol], { yoksay: true });
    try { rmSync(yol, { recursive: true, force: true }); } catch { /* kalabilir */ }
    git(cwd, ['worktree', 'prune'], { yoksay: true });
  }
  return { dal, commit, degisen, bosSonuc: degisen === 0 };
}

/** Dalda taban disinda ne var? Insan okunur ozet (karar kartinda / raporda). */
export function dalOzeti(cwd, dal, taban) {
  if (!dal || !taban) return null;
  const log = git(cwd, ['log', '--no-color', '--format=%h %s', '-n', '20', taban + '..' + dal], { yoksay: true });
  const dosyalar = git(cwd, ['diff', '--no-color', '--name-status', taban + '..' + dal], { yoksay: true });
  if (!log && !dosyalar) return null;
  return { dal, taban, log: log ?? '', dosyalar: dosyalar ?? '' };
}

/**
 * Yol karsilastirmasi icin normal bicim. `git worktree list` Windows'ta da
 * ILERI egik cizgi kullanir, bizim yollarimiz ters egik cizgilidir: ham
 * karsilastirma hicbir zaman tutmaz (olculdu - temizlik sessizce 0 donuyordu).
 */
function yolNormal(y) {
  const t = String(y).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? t.toLowerCase() : t;
}

/** Suru'nun actigi ve geride kalmis worktree'ler (kosu cokerse temizlik icin). */
export function artiklariTemizle(cwd, { kok = undefined } = {}) {
  if (!depoMu(cwd)) return 0;
  const liste = git(cwd, ['worktree', 'list', '--porcelain'], { yoksay: true });
  if (!liste) return 0;
  const kokDizin = yolNormal(worktreeKoku(kok ? { kok } : undefined));
  let n = 0;
  for (const satir of liste.split(NL)) {
    if (!satir.startsWith('worktree ')) continue;
    const yol = satir.slice('worktree '.length).trim();
    if (!yolNormal(yol).startsWith(kokDizin)) continue;   // sadece Suru'nun actiklari
    if (existsSync(yol)) continue;             // hala duruyorsa dokunma
    git(cwd, ['worktree', 'remove', '--force', yol], { yoksay: true });
    n++;
  }
  git(cwd, ['worktree', 'prune'], { yoksay: true });
  return n;
}
