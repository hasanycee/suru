// Golge checkpoint: her kosudan once ve sonra projenin anlik goruntusu.
//
// Kullanicinin deposuna DOKUNMAZ. Ayri bir git dizini (~/.claude/suru/golge/<proje>)
// ve calisma agaci olarak proje klasoru kullanilir. Git'i olmayan projede de calisir.
//
// Neden ajan adimlarini kullanicinin deposuna commit'lemiyoruz: gecmisi kirletir,
// git'siz projede calismaz, "geri al" kullanicinin elle yaptigi degisiklige karisir.
//
// Tasarim:
//   - Her goruntu EBEVEYNSIZ bir commit ve kendi ref'i: refs/suru/<kosuId>-once|-sonra.
//     Zincir yok, bu yuzden budama = eski ref'leri silmek + gc. Git icerigi adrese
//     gore sakladigi icin degismeyen dosyalar tekrar yer kaplamaz.
//   - Geri alma GUVENLI: bir dosya ancak simdiki hali kosunun biraktigi haliyle
//     AYNIYSA geri alinir. Arada insan ya da baska ajan degistirdiyse dokunulmaz,
//     cakisma olarak raporlanir. Geri almadan once guvenlik goruntusu alinir.
//   - Kanit zinciri sadece Write/Edit araclarini gorur; golge farki Bash'in
//     yaptigi degisiklikleri de yakalar.
//
// Kapsam disi (bilerek): projenin .gitignore'unun gizledigi dosyalar ve varsayilan
// haric listesi (.env, node_modules, model agirliklari...). Sirlar kopyalanmaz;
// bedeli, ajan onlari degistirirse geri alinamaz.

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { yolNormal } from './cakisma.js';
import { VERI_DIZINI } from './paths.js';
import { isGetir, KOSU_DURUMU } from './isler.js';

const NL = String.fromCharCode(10);
const NUL = String.fromCharCode(0);

export const VARSAYILAN_HARIC = [
  '.env', '.env.*', '*.pem', '*.key',
  'node_modules/', '.venv/', 'venv/', '__pycache__/', '.pytest_cache/', '.mypy_cache/',
  '.next/', 'dist/', 'build/', 'target/', '*.pyc',
  '*.pt', '*.pth', '*.onnx', '*.safetensors', '*.gguf', '*.ckpt', '*.bin',
  '*.zip', '*.7z', '*.iso', '*.mp4', '*.mkv',
];

const ETIKET = /^[A-Za-z0-9._-]{1,120}$/;
const REF_ONEK = 'refs/suru/';

export function golgeDizini(cwd, { kok = join(VERI_DIZINI, 'golge') } = {}) {
  const anahtar = yolNormal(cwd);
  const ad = basename(anahtar).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'proje';
  const iz = createHash('sha1').update(anahtar).digest('hex').slice(0, 8);
  return join(kok, ad + '-' + iz);
}

/** Kullanici yapilandirmasindan yalitilmis git: imzalama, hook, autocrlf etkilemesin. */
function git(gitDir, cwd, args, { girdi, tarihSn } = {}) {
  // devNull (\\.\nul) Git for Windows'ta dosya olarak acilamiyor. Olmayan bir yol
  // ise sessizce yok sayilir: global ayar yok, hook klasoru yok.
  const yok = join(gitDir, 'suru-yok');
  const env = { ...process.env,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(yok, 'gitconfig'), GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'suru', GIT_AUTHOR_EMAIL: 'suru@yerel',
    GIT_COMMITTER_NAME: 'suru', GIT_COMMITTER_EMAIL: 'suru@yerel' };
  // Disaridan miras kalan git ortami baska depoya yonlendirmesin.
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) delete env[k];
  if (tarihSn != null) env.GIT_AUTHOR_DATE = env.GIT_COMMITTER_DATE = Math.floor(tarihSn) + ' +0000';
  return execFileSync('git', ['--git-dir=' + gitDir, '--work-tree=' + cwd,
    '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.quotepath=false',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + join(yok, 'hooks'), ...args], {
    cwd, encoding: 'utf8', input: girdi, maxBuffer: 256 * 1024 * 1024, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'], env,
  });
}

function hazirla(cwd, { kok, ekHaric } = {}) {
  if (!existsSync(cwd)) throw new Error('proje klasoru yok: ' + cwd);
  const dizin = golgeDizini(cwd, { kok });
  if (!existsSync(join(dizin, 'HEAD'))) {
    mkdirSync(dizin, { recursive: true });
    execFileSync('git', ['init', '--bare', '--quiet', dizin], { windowsHide: true, stdio: 'ignore' });
    git(dizin, cwd, ['config', 'core.bare', 'false']);
    mkdirSync(join(dizin, 'info'), { recursive: true });
    writeFileSync(join(dizin, 'info', 'exclude'), VARSAYILAN_HARIC.join(NL) + NL, 'utf8');
    writeFileSync(join(dizin, 'suru-proje.txt'), cwd + NL, 'utf8');
  }
  // Proje gizlilik desenleri de goruntuye girmez (gitignore sozdizimi ayni).
  // Sadece goruntu alinirken verilir; diger islemler haric listesine dokunmaz.
  if (ekHaric) {
    const icerik = [...VARSAYILAN_HARIC, ...ekHaric].join(NL) + NL;
    const yol = join(dizin, 'info', 'exclude');
    let mevcut = null;
    try { mevcut = readFileSync(yol, 'utf8'); } catch { /* yok */ }
    if (mevcut !== icerik) { mkdirSync(join(dizin, 'info'), { recursive: true }); writeFileSync(yol, icerik, 'utf8'); }
  }
  return dizin;
}

/** Projenin kaba boyutu (bayt): varsayilan haric klasorler ve .git atlanir. */
export function projeBoyutu(cwd, { sinirBayt = Infinity } = {}) {
  const atla = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next']);
  let top = 0; const yigin = [cwd];
  while (yigin.length && top <= sinirBayt) {
    const d = yigin.pop(); let girdiler;
    try { girdiler = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const g of girdiler) {
      if (g.isDirectory()) { if (!atla.has(g.name)) yigin.push(join(d, g.name)); }
      else if (g.isFile()) { try { top += statSync(join(d, g.name)).size; } catch { /* */ } }
    }
  }
  return top;
}

/**
 * Ilk goruntu projenin tamamini gölgeye yazar. Olculdu (KorkuOyunu): 14 GB proje,
 * ilk goruntu 11.1 GB disk, diskte 21 GB bos vardi. Sonrakiler ~0.5 sn ve yer
 * kaplamaz. Bu yuzden SADECE ilk goruntuden once bakilir: yazildiktan sonra en az
 * enAzBosBayt kalmayacaksa goruntu alinmaz (kosu yine kosar, geri alma olmaz).
 */
export const GOLGE_EN_AZ_BOS = 5 * 1024 ** 3;
export function ilkGoruntuDiskKontrol(cwd, dizin, { enAzBosBayt = GOLGE_EN_AZ_BOS, bosBaytFn = null } = {}) {
  let ust = dizin; while (!existsSync(ust)) { const u = dirname(ust); if (u === ust) break; ust = u; }
  const bos = bosBaytFn ? bosBaytFn(ust) : (() => { const s = statfsSync(ust); return s.bavail * s.bsize; })();
  if (bos - enAzBosBayt <= 0) return { tamam: false, bos, gerekli: null };
  const boyut = projeBoyutu(cwd, { sinirBayt: bos });
  return { tamam: bos - boyut >= enAzBosBayt, bos, gerekli: boyut };
}

/** Projenin o anki halini kaydeder. Donus: commit kimligi. */
export function anlikGoruntu(cwd, etiket, { kok, simdi, ekHaric, diskKontrol = true, bosBaytFn = null } = {}) {
  if (!ETIKET.test(String(etiket))) throw new Error('gecersiz golge etiketi: ' + etiket);
  if (diskKontrol && existsSync(cwd) && !existsSync(join(golgeDizini(cwd, { kok }), 'HEAD'))) {
    const k = ilkGoruntuDiskKontrol(cwd, golgeDizini(cwd, { kok }), { bosBaytFn });
    if (!k.tamam) {
      const gb = (b) => (b / 1024 ** 3).toFixed(1) + ' GB';
      throw new Error('golge atlandi: disk yetersiz (bos ' + gb(k.bos)
        + (k.gerekli != null ? ', proje ~' + gb(k.gerekli) : '') + ', en az ' + gb(GOLGE_EN_AZ_BOS) + ' bos kalmali)');
    }
  }
  const dizin = hazirla(cwd, { kok, ekHaric });
  git(dizin, cwd, ['add', '-A', '--ignore-errors', '.']);
  const agac = git(dizin, cwd, ['write-tree']).trim();
  const tarihSn = simdi != null ? simdi / 1000 : undefined;
  const commit = git(dizin, cwd, ['commit-tree', agac, '-m', etiket], { tarihSn }).trim();
  git(dizin, cwd, ['update-ref', REF_ONEK + etiket, commit]);
  return commit;
}

/** Iki goruntu arasindaki degisiklikler: [{ durum: 'A'|'M'|'D', yol }] */
export function degisenler(cwd, once, sonra, { kok } = {}) {
  const dizin = hazirla(cwd, { kok });
  const cikti = git(dizin, cwd, ['diff', '--name-status', '--no-renames', '-z', once, sonra]);
  const p = cikti.split(NUL).filter((x) => x !== '');
  const out = [];
  for (let i = 0; i + 1 < p.length; i += 2) {
    const durum = p[i][0] === 'T' ? 'M' : p[i][0];
    out.push({ durum, yol: p[i + 1] });
  }
  return out;
}

/**
 * Geri alma plani; hicbir sey degistirmez.
 * uygun: dosyanin simdiki hali kosunun biraktigi halle ayni (guvenle geri alinir).
 */
export function geriAlPlani(cwd, once, sonra, { kok } = {}) {
  const dizin = hazirla(cwd, { kok });
  const liste = degisenler(cwd, once, sonra, { kok });
  if (!liste.length) return { degisiklik: [], uygun: 0, cakisan: 0 };

  // Kosunun biraktigi blob'lar (sonra goruntusu)
  const sonraBlob = new Map();
  const ls = git(dizin, cwd, ['ls-tree', '-r', '-z', sonra]);
  for (const satir of ls.split(NUL)) {
    const sekme = satir.indexOf('\t');
    if (sekme < 0) continue;
    sonraBlob.set(satir.slice(sekme + 1), satir.slice(0, sekme).split(' ')[2]);
  }
  // Simdiki hallerin blob kimlikleri (dosya yoksa null)
  const mevcut = liste.filter((d) => existsSync(join(cwd, d.yol))).map((d) => d.yol);
  const simdi = new Map();
  if (mevcut.length) {
    const h = git(dizin, cwd, ['hash-object', '--stdin-paths'], { girdi: mevcut.join(NL) + NL })
      .split(NL).filter(Boolean);
    mevcut.forEach((y, i) => simdi.set(y, h[i]));
  }

  const degisiklik = liste.map((d) => {
    const beklenen = d.durum === 'D' ? null : (sonraBlob.get(d.yol) ?? null);
    const suan = simdi.get(d.yol) ?? null;
    return { ...d, eylem: d.durum === 'A' ? 'sil' : 'geri-yukle', uygun: beklenen === suan };
  });
  return {
    degisiklik,
    uygun: degisiklik.filter((d) => d.uygun).length,
    cakisan: degisiklik.filter((d) => !d.uygun).length,
  };
}

/** Plani uygular. Once guvenlik goruntusu alinir: geri alma da geri alinabilir. */
export function geriAl(cwd, once, sonra, { kok, etiket } = {}) {
  const plan = geriAlPlani(cwd, once, sonra, { kok });
  if (!plan.uygun) return { ...plan, guvenlik: null, geriAlinan: [] };
  const dizin = hazirla(cwd, { kok });
  const guvenlik = anlikGoruntu(cwd, etiket || ('geri-al-' + Date.now()), { kok });

  const yukle = [], geriAlinan = [];
  for (const d of plan.degisiklik) {
    if (!d.uygun) continue;
    if (d.eylem === 'sil') rmSync(join(cwd, d.yol), { force: true });
    else yukle.push(d.yol);
    geriAlinan.push(d.yol);
  }
  for (let i = 0; i < yukle.length; i += 100) {
    git(dizin, cwd, ['checkout', once, '--', ...yukle.slice(i, i + 100)]);
  }
  return { ...plan, guvenlik, geriAlinan };
}

/**
 * Eski goruntuleri siler. gun'den eski ya da en yeni enFazla'nin disindakiler gider.
 * Silinen olduysa gc calisir. Donus: silinen ref sayisi.
 */
export function budama(cwd, { kok, gun = 14, enFazla = 400, simdi = Date.now() } = {}) {
  const dizin = golgeDizini(cwd, { kok });
  if (!existsSync(join(dizin, 'HEAD'))) return 0;
  const satirlar = git(dizin, cwd, ['for-each-ref', '--format=%(refname)%09%(committerdate:unix)', REF_ONEK])
    .split(NL).filter(Boolean)
    .map((s) => { const [ref, t] = s.split('\t'); return { ref, t: Number(t) * 1000 }; })
    .sort((a, b) => b.t - a.t);
  const sinir = simdi - gun * 86_400_000;
  const silinecek = satirlar.filter((r, i) => r.t < sinir || i >= enFazla);
  if (!silinecek.length) return 0;
  git(dizin, cwd, ['update-ref', '--stdin'], { girdi: silinecek.map((r) => 'delete ' + r.ref).join(NL) + NL });
  git(dizin, cwd, ['reflog', 'expire', '--expire=now', '--all']);
  git(dizin, cwd, ['gc', '--prune=now', '--quiet']);
  return silinecek.length;
}

/**
 * Ayni klasorde bu kosuyla zaman olarak ortusen diger kosular. Varsa geri alma
 * onlarin isini da iceriyor olabilir - panel uyarir.
 */
export function ortusenKosular(db, kosu, { simdi = Date.now() } = {}) {
  const is = isGetir(db, kosu.isId);
  if (!is) return [];
  const bas = kosu.basladi, bit = kosu.bitti ?? simdi;
  const adaylar = db.prepare(`SELECT k.id, k.is_id, k.durum, k.basladi, k.bitti, i.cwd, i.ad
    FROM kosular k JOIN isler i ON i.id = k.is_id
    WHERE k.id != ? AND k.basladi < ? AND COALESCE(k.bitti, ?) > ? AND k.durum != ?`)
    .all(kosu.id, bit, simdi, bas, KOSU_DURUMU.BEKLIYOR);
  const hedef = yolNormal(is.cwd);
  return adaylar.filter((r) => yolNormal(r.cwd) === hedef)
    .map((r) => ({ kosuId: r.id, isId: r.is_id, ad: r.ad, durum: r.durum }));
}

/**
 * Insanin degil aracin urettigi dosyalar: fark METNINE girmez, sadece sayilir.
 * Olculdu (KorkuOyunu, Unity): commit basina ~4 200 dosya, 14 committen 11inde
 * fark 8 000 karakter sinirini asti, ortanca ~694 KB. Denetci degisikligin ~%1ini
 * goruyordu ve o %1 de cogu zaman .meta satirlariydi.
 */
export const URETILMIS = [
  '*.meta', '*.asset', '*.unity', '*.prefab', '*.mat', '*.anim', '*.controller',
  '*.physicMaterial', '*.lighting', '*.shadergraph', '*.spriteatlas', '*.cubemap',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'Cargo.lock',
  '*.min.js', '*.min.css', '*.map', '*.snap', '*.svg',
];

const desenRegex = (d) => new RegExp('(^|/)' + d.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
const URETILMIS_RE = URETILMIS.map(desenRegex);

export function uretilmisMi(yol) {
  const y = String(yol).replace(/\\/g, '/');
  return URETILMIS_RE.some((r) => r.test(y));
}

/** Degisiklikleri kod ve uretilmis diye ayirir; uretilmisleri uzantiya gore sayar. */
export function degisiklikOzeti(degisiklik = []) {
  const kod = [], sayac = {};
  for (const d of degisiklik) {
    if (uretilmisMi(d.yol)) {
      const m = /\.[^./]+$/.exec(d.yol); const ek = m ? m[0] : d.yol.split('/').pop();
      sayac[ek] = (sayac[ek] || 0) + 1;
    } else kod.push(d);
  }
  const uretilmis = Object.entries(sayac).sort((a, b) => b[1] - a[1]).map(([ek, n]) => ({ ek, n }));
  return { kod, uretilmis, uretilmisToplam: degisiklik.length - kod.length };
}

/**
 * Iki goruntu arasindaki fark metni (denetci icin). Kirpilirsa sonuna not duser.
 * uretilmisHaric: URETILMIS desenleri pathspec ile disarida birakilir. Yollari tek
 * tek vermiyoruz: binlerce yol Windows komut satiri sinirini asar; desen sayisi sabit.
 */
export function farkMetni(cwd, once, sonra, { kok, enFazla = 12_000, uretilmisHaric = false } = {}) {
  const dizin = hazirla(cwd, { kok });
  const kapsam = uretilmisHaric ? ['--', '.', ...URETILMIS.map((d) => ':(exclude,glob)**/' + d)] : [];
  const t = git(dizin, cwd, ['diff', '--no-color', '--no-renames', '-U3', once, sonra, ...kapsam]);
  return t.length > enFazla ? t.slice(0, enFazla) + NL + '... (fark kirpildi: ' + t.length + ' karakter)' : t;
}
