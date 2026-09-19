// Proje bazli gizlilik: bazi dosyalar modele HIC gitmemeli (musteri verisi, anahtarlar).
//
// Kurallar proje klasorunun DISINDA durur (~/.claude/suru/gizlilik.json): proje
// icinde olsaydi yazma yetkili bir ajan kendi yasagini degistirebilirdi.
//
// Desenler gitignore benzeri:
//   *.pem          her derinlikte (egik cizgi yok)
//   secrets/       her derinlikte klasor
//   data/musteri/  proje kokune gore
//   /kok.txt       sadece kokte
// Desteklenmeyen (reddedilir): '!' ile istisna (yasak kaldirmak icin kullanilamaz),
// '..', mutlak yol, parantez. Parantez Claude Code izin kuralini bozar ve olculdu:
// TEK bozuk kural butun ayar dosyasini sessizce dusurur.
//
// Uygulama katmanlari (bkz. kosucu.js):
//   1. Claude Code izin kurallari: Read(./desen), Edit(./desen), Write(./desen)
//   2. webYasak: WebFetch/WebSearch butunuyle kaldirilir (arac yoklugu)
//   3. Golge goruntusune kopyalanmaz
//   4. Denetim: kosu sonunda veri akisi defteri gizli yolun modele gidip gitmedigine bakar

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, isAbsolute, resolve } from 'node:path';
import { VERI_DIZINI } from './paths.js';
import { yolNormal } from './cakisma.js';

export const GIZLILIK_YOLU = join(VERI_DIZINI, 'gizlilik.json');

// Her projede gecerli anahtar/sertifika desenleri. .env zaten yetki.js ORTAK_YASAK'ta.
export const VARSAYILAN_YOLLAR = ['*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*', '.ssh/', '.aws/'];

/** Kullanici desenini proje kokune gore glob'a cevirir. Gecersizse null. */
export function desenNormal(desen) {
  let t = String(desen ?? '').trim().replace(/\\/g, '/');
  if (!t || t.startsWith('#') || t.startsWith('!')) return null;
  if (/[()]/.test(t) || /^[a-zA-Z]:/.test(t) || t.split('/').includes('..')) return null;
  t = t.replace(/^\.\//, '');
  const kokte = t.startsWith('/');
  t = t.replace(/^\/+/, '');
  const klasor = t.endsWith('/');
  let g = t.replace(/\/+$/, '');
  if (!g) return null;
  if (!kokte && !g.includes('/')) g = '**/' + g;
  if (klasor) g = g + '/**';
  return g;
}

/** Normallesmis glob -> RegExp (proje kokune gore goreli, '/' ayracli yol). */
export function desenRegex(glob, { buyukKucuk = process.platform !== 'win32' } = {}) {
  let r = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (glob.startsWith('**/', i)) { r += '(?:.*/)?'; i += 2; continue; }
    if (glob.startsWith('/**', i) && i + 3 === glob.length) { r += '(?:/.*)?'; i += 2; continue; }
    if (glob.startsWith('**', i)) { r += '.*'; i += 1; continue; }
    if (c === '*') { r += '[^/]*'; continue; }
    if (c === '?') { r += '[^/]'; continue; }
    r += c.replace(/[.+^${}|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + r + '$', buyukKucuk ? '' : 'i');
}

/** Mutlak ya da goreli yol, projenin hangi gizli desenine takiliyor? Yoksa null. */
export function yolEslesen(gizlilik, cwd, yol) {
  if (!gizlilik?.desenler?.length || !yol) return null;
  const mutlak = isAbsolute(yol) ? yol : resolve(cwd, yol);
  const gor = relative(resolve(cwd), mutlak).replace(/\\/g, '/');
  if (!gor || gor.startsWith('..') || isAbsolute(gor)) return null; // proje disi
  for (const g of gizlilik.desenler) if (desenRegex(g).test(gor)) return g;
  return null;
}

/** Claude Code izin kurallari. Desenler desenNormal'den gecmis olmali. */
export function izinKurallari(desenler = [], { webYasak = false } = {}) {
  const k = [];
  for (const g of desenler) {
    if (!g) continue;
    k.push('Read(./' + g + ')', 'Edit(./' + g + ')', 'Write(./' + g + ')');
  }
  if (webYasak) k.push('WebFetch', 'WebSearch');
  return k;
}

export function gizlilikOku(yol = GIZLILIK_YOLU) {
  try {
    const j = JSON.parse(readFileSync(yol, 'utf8'));
    return {
      varsayilanYollar: Array.isArray(j.varsayilanYollar) ? j.varsayilanYollar : [...VARSAYILAN_YOLLAR],
      projeler: j.projeler && typeof j.projeler === 'object' ? j.projeler : {},
    };
  } catch {
    return { varsayilanYollar: [...VARSAYILAN_YOLLAR], projeler: {} };
  }
}

/** Projenin gecerli gizliligi: varsayilan + proje desenleri. */
export function projeGizliligi(cwd, { yol = GIZLILIK_YOLU } = {}) {
  const g = gizlilikOku(yol);
  const p = g.projeler[yolNormal(cwd)] ?? {};
  const projeYollari = Array.isArray(p.yollar) ? p.yollar : [];
  const yollar = [...new Set([...g.varsayilanYollar, ...projeYollari])];
  return {
    cwd,
    yollar,
    projeYollari,
    desenler: [...new Set(yollar.map(desenNormal).filter(Boolean))],
    webYasak: !!p.webYasak,
  };
}

/** Projenin desenlerini kaydeder. Gecersiz desen varsa HICBIR SEY yazmadan hata atar. */
export function projeGizliliginiYaz(cwd, { yollar = [], webYasak = false } = {}, { yol = GIZLILIK_YOLU } = {}) {
  if (!cwd) throw new Error('cwd gerekli');
  const temiz = [];
  for (const y of yollar) {
    const t = String(y ?? '').trim();
    if (!t || t.startsWith('#')) continue;
    if (!desenNormal(t)) throw new Error('gecersiz desen: "' + t + '" (istisna !, .., mutlak yol ve parantez desteklenmez)');
    temiz.push(t);
  }
  const g = gizlilikOku(yol);
  g.projeler[yolNormal(cwd)] = { cwd, yollar: [...new Set(temiz)], webYasak: !!webYasak, guncellendi: Date.now() };
  mkdirSync(dirname(yol), { recursive: true });
  writeFileSync(yol, JSON.stringify(g, null, 2) + String.fromCharCode(10), 'utf8');
  return projeGizliligi(cwd, { yol });
}
