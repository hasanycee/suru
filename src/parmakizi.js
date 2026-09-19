// Proje parmak izi: hafizadaki bir olgunun hala gecerli olup olmadigini anlamak icin.
//
// Sorun: "turkish.py 36 test" olgusu olcum aninda dogruydu. Biri test eklerse
// yanlisa doner ama hafiza onu hala "kesin bilgi" diye sunar - uydurma sayiyla
// ayni zarar. Olgu, kaydedildigi andaki projenin parmak iziyle saklanir; iz
// degistiyse olgu "eski olabilir" diye isaretlenir.
//
// Iki yol:
//   git : HEAD + degismis izlenen dosyalarin yolu ve zamani. Hizli ve kesin.
//   fs  : git yoksa dosya agacinin sayisi, toplam boyutu ve en yeni zamani.
// Ikisi de ICERIK okumaz - buyuk projede de her kosu basinda ucuz kalmali.

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Uretilmis ya da disaridan gelen klasorler: degismeleri projenin degistigi
// anlamina gelmez, taramasi da pahali.
const ATLA = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'env',
  'dist', 'build', '.idea', '.vscode', '.pytest_cache', '.mypy_cache', 'target', '.next',
  // Claude Code proje icine ayar/oturum dosyasi yazabiliyor: bu bir kod degisikligi
  // degil. Sayilsaydi her ajan kosusu butun olgulari yanlislikla bayat gosterirdi.
  '.claude']);

// Cok buyuk dizinde tarama sonsuza gitmesin.
const EN_FAZLA_GIRDI = 20000;

const ozet = (metin) => createHash('sha1').update(metin).digest('hex').slice(0, 12);

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000, windowsHide: true,
  }).toString();
}

/** Yol karsilastirmasi: git '/' ile, Windows '\\' ile ve buyuk/kucuk harf farkli dondurebilir. */
function ayniYol(a, b) {
  const n = (y) => {
    let x = resolve(String(y)).split(String.fromCharCode(92)).join('/').replace(/\/+$/, '');
    if (process.platform === 'win32') x = x.toLowerCase();
    return x;
  };
  return n(a) === n(b);
}

/**
 * Proje kendi git deposunun KOKUYSE iz, degilse null.
 *
 * Kok sarti kritik: git ust klasorlerde depo arar. Kendi deposu olmayan bir
 * proje, ustundeki deponun icindeyse (ornek: 'AI projects' altindaki LiveDub)
 * iz o ust deponun HEAD'ine baglanirdi. Iki yonden yanlis: proje ust depoda
 * izlenmiyorsa degisiklikleri HIC gorunmez (olgular sessizce bayatlar), baska
 * projelerdeki degisiklikler ise bu projenin olgularini bayat gosterir.
 */
export function gitParmakIzi(cwd) {
  let kok;
  try { kok = git(cwd, ['rev-parse', '--show-toplevel']).trim(); } catch { return null; }
  if (!kok || !ayniYol(kok, cwd)) return null;

  let head;
  try { head = git(cwd, ['rev-parse', 'HEAD']).trim(); } catch { return null; }
  if (!head) return null;

  // Commit edilmemis degisiklikler de projeyi degistirir. Sadece yol listesi
  // yetmez: zaten degismis bir dosya tekrar degisirse liste ayni kalir. Bu
  // yuzden degismis dosyalarin zamanini da kataliyoruz.
  let kirli = '';
  try {
    const liste = git(cwd, ['status', '--porcelain', '--untracked-files=no'])
      .split(/\r?\n/).map((s) => s.slice(3).trim()).filter(Boolean);
    kirli = liste.map((yol) => {
      try { return yol + '@' + Math.floor(statSync(join(cwd, yol)).mtimeMs); } catch { return yol + '@silindi'; }
    }).join('|');
  } catch { /* status okunamadi: sadece HEAD */ }

  return 'git:' + head.slice(0, 12) + (kirli ? ':' + ozet(kirli).slice(0, 8) : '');
}

/** Git disi: dosya agacinin ozet istatistigi. */
export function dosyaParmakIzi(cwd) {
  let sayi = 0, boyut = 0, enYeni = 0, gezilen = 0;
  const yigin = [cwd];
  while (yigin.length && gezilen < EN_FAZLA_GIRDI) {
    const d = yigin.pop();
    let girdiler;
    try { girdiler = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const g of girdiler) {
      if (++gezilen > EN_FAZLA_GIRDI) break;
      if (g.isDirectory()) {
        if (!ATLA.has(g.name)) yigin.push(join(d, g.name));
        continue;
      }
      if (!g.isFile()) continue;
      try {
        const st = statSync(join(d, g.name));
        sayi++; boyut += st.size;
        if (st.mtimeMs > enYeni) enYeni = st.mtimeMs;
      } catch { /* dosya o arada silinmis */ }
    }
  }
  return 'fs:' + ozet(sayi + ':' + boyut + ':' + Math.floor(enYeni));
}

/** Projenin su anki parmak izi. Okunamazsa null (bu durumda bayatlik bilinmez). */
export function parmakIzi(cwd) {
  if (!cwd) return null;
  try { return gitParmakIzi(cwd) ?? dosyaParmakIzi(cwd); } catch { return null; }
}
