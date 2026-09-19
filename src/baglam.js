// Baglam agirligi: bir ajan koşusu daha ise baslamadan kac token harciyor?
//
// Her ajan sifir baglamla baslar ama "sifir" gercekte sifir degil: Claude Code
// her oturuma bazi talimat dosyalarini OTOMATIK yukler. Bunlar her kosuda,
// her ajanda tekrar tekrar token yer. Paralel ajan sayisi arttikca bu maliyet
// dogrusal artar. Bu modul o yuku OLCER - tahmin etmez, dosyalari sayar.
//
// Kurallar resmi dokumandan (code.claude.com/docs/en/memory):
//   - CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md: calisma klasorunden ve
//     UST klasorlerin hepsinden, acilista yuklenir. Alt klasorlerdekiler
//     ihtiyac aninda yuklenir (burada sayilmaz).
//   - @import: acilista acilir, en fazla 4 atlama. Kod parcasi ve kod blogu
//     icindekiler import sayilmaz.
//   - .claude/rules/**/*.md: 'paths' on-bilgisi YOKSA acilista yuklenir;
//     varsa sadece eslesen dosya okununca (kosullu - ayri raporlanir).
//   - Kullanici duzeyi: ~/.claude/CLAUDE.md ve ~/.claude/rules/.
//   - Blok HTML yorumlari baglama girmeden once silinir.
//   - Otomatik hafiza (MEMORY.md): acikken ilk 200 satir ya da 25KB.
//   - --add-dir klasorlerinin CLAUDE.md'si varsayilan olarak yuklenmez.
//
// Token sayisi TAHMINDIR (karakter / 3.5). Kesin sayi icin model tokenizer'i
// gerekir; burada amac buyukluk sirasini ve buyuyeni gormek.

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute, parse } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const NL = String.fromCharCode(10);
const TIK = String.fromCharCode(96);           // backtick
const CIT = TIK + TIK + TIK;                    // kod blogu siniri

export const SINIR = {
  claudeMdSatir: 200,        // dokumanin hedefi: dosya basina 200 satirin alti
  importAtlama: 4,           // dokuman: en fazla 4 atlama
  hafizaSatir: 200,          // otomatik hafiza: ilk 200 satir
  hafizaBayt: 25 * 1024,     // ya da 25KB
  kosuBasiToken: 2000,       // bundan agir olursa uyar (bizim esigimiz)
};

export const tahminiToken = (metin) => Math.ceil(String(metin).length / 3.5);

function dosyaMi(yol) {
  try { return statSync(yol).isFile(); } catch { return false; }
}

/** Blok HTML yorumlarini siler (kod bloklari haric): dokuman bunlari baglama koymuyor. */
export function yorumlariSil(metin) {
  const parcalar = String(metin).split(CIT);
  // Cift indeksler kod blogu DISI
  return parcalar.map((p, i) => (i % 2 === 0 ? p.replace(/<!--[\s\S]*?-->/g, '') : p)).join(CIT);
}

/** Kod bloklarini ve satir ici kod parcalarini cikarir: oradaki @yol import degil. */
function koduCikar(metin) {
  const parcalar = String(metin).split(CIT);
  const disari = parcalar.filter((_, i) => i % 2 === 0).join(NL);
  return disari.replace(new RegExp(TIK + '[^' + TIK + ']*' + TIK, 'g'), ' ');
}

/** Metindeki @import yollarini bulur. E-posta gibi 'a@b' eslesmez: @ oncesi bosluk ya da satir basi. */
export function importlariBul(metin) {
  const temiz = koduCikar(metin);
  const out = [];
  const re = /(^|\s)@([^\s]+)/g;
  let m;
  while ((m = re.exec(temiz))) {
    const yol = m[2].replace(/[.,;:)\]]+$/, '');
    if (yol) out.push(yol);
  }
  return out;
}

function importYolu(ham, icerenDosya, ev) {
  if (ham.startsWith('~/') || ham.startsWith('~' + String.fromCharCode(92))) return join(ev, ham.slice(2));
  if (isAbsolute(ham)) return ham;
  return resolve(dirname(icerenDosya), ham);
}

/** Frontmatter'da 'paths' var mi? Varsa kural kosullu yuklenir. */
export function kosulluKuralMi(metin) {
  const t = String(metin);
  if (!t.startsWith('---')) return false;
  const son = t.indexOf(NL + '---', 3);
  if (son < 0) return false;
  return /^paths\s*:/m.test(t.slice(3, son));
}

function mdDosyalari(dizin) {
  const out = [];
  const yigin = [dizin];
  while (yigin.length) {
    const d = yigin.pop();
    let g;
    try { g = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const x of g) {
      const y = join(d, x.name);
      if (x.isDirectory()) yigin.push(y);
      else if (x.isFile() && x.name.toLowerCase().endsWith('.md')) out.push(y);
    }
  }
  return out.sort();
}

/** Kok dizinden cwd'ye kadar olan klasorler (kokten asagi dogru). durak verilirse onun ustune cikilmaz. */
function atalar(cwd, durak) {
  const zincir = [];
  let d = resolve(cwd);
  const kok = parse(d).root;
  const durakN = durak ? resolve(durak) : null;
  while (true) {
    zincir.push(d);
    if (durakN && d === durakN) break;
    if (d === kok) break;
    const ust = dirname(d);
    if (ust === d) break;
    d = ust;
  }
  return zincir.reverse();
}

/** Claude Code'un proje klasoru adlandirmasi: harf/rakam disi her karakter '-'. */
export function projeKlasorAdi(yol) {
  return String(resolve(yol)).replace(/[^a-zA-Z0-9]/g, '-');
}

/** Otomatik hafizanin baglandigi kok: git deposu (kok olmasa bile ust depo), yoksa cwd. */
function hafizaKoku(cwd, gitKokFn) {
  try {
    const k = gitKokFn(cwd);
    if (k) return k;
  } catch { /* git yok */ }
  return resolve(cwd);
}

function varsayilanGitKok(cwd) {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000, windowsHide: true,
  }).toString().trim() || null;
}

/**
 * Bir calisma klasoru icin otomatik yuklenen talimatlari olcer.
 *
 * secenekler:
 *   ev             : kullanici ana klasoru (testlerde sahte)
 *   durak          : ata taramasinin en ust noktasi (testlerde gecici kok)
 *   otomatikHafiza : ajan kosularinda Claude hafizasi acik mi (Suru varsayilani: kapali)
 *   projelerDizini : ~/.claude/projects (otomatik hafiza icin)
 *   gitKokFn       : git kokunu bulan fonksiyon (testlerde sahte)
 */
export function olc(cwd, {
  ev = homedir(),
  durak = null,
  otomatikHafiza = false,
  projelerDizini = null,
  gitKokFn = varsayilanGitKok,
} = {}) {
  const dosyalar = [];
  const kosullu = [];
  const uyarilar = [];
  const gorulen = new Set();
  const anahtar = (y) => (process.platform === 'win32' ? resolve(y).toLowerCase() : resolve(y));

  const ekle = (yol, tur, atlama = 0) => {
    if (!dosyaMi(yol) || gorulen.has(anahtar(yol))) return;
    gorulen.add(anahtar(yol));
    let ham;
    try { ham = readFileSync(yol, 'utf8'); } catch { return; }
    const icerik = yorumlariSil(ham);
    const satir = icerik.split(NL).length;
    dosyalar.push({ yol, tur, satir, bayt: Buffer.byteLength(icerik), token: tahminiToken(icerik), atlama });

    if ((tur === 'claude-md' || tur === 'kullanici') && satir > SINIR.claudeMdSatir) {
      uyarilar.push(yol + ': ' + satir + ' satir. Dokumanin hedefi ' + SINIR.claudeMdSatir
        + ' satirin alti; uzun dosya hem token yer hem uyumu dusurur. Kosullu kurala (.claude/rules + paths) tasi.');
    }

    if (atlama < SINIR.importAtlama) {
      for (const imp of importlariBul(icerik)) ekle(importYolu(imp, yol, ev), 'import', atlama + 1);
    }
  };

  // 1) Kullanici duzeyi (en genis kapsam once yuklenir)
  ekle(join(ev, '.claude', 'CLAUDE.md'), 'kullanici');
  for (const k of mdDosyalari(join(ev, '.claude', 'rules'))) {
    let t = '';
    try { t = readFileSync(k, 'utf8'); } catch { continue; }
    if (kosulluKuralMi(t)) kosullu.push({ yol: k, kapsam: 'kullanici' });
    else ekle(k, 'kural');
  }

  // 2) Atalar + calisma klasoru: kokten asagi
  for (const d of atalar(cwd, durak)) {
    ekle(join(d, 'CLAUDE.md'), 'claude-md');
    ekle(join(d, '.claude', 'CLAUDE.md'), 'claude-md');
    ekle(join(d, 'CLAUDE.local.md'), 'claude-md');
  }

  // 3) Proje kurallari (calisma klasorunun .claude/rules'u)
  for (const k of mdDosyalari(join(resolve(cwd), '.claude', 'rules'))) {
    let t = '';
    try { t = readFileSync(k, 'utf8'); } catch { continue; }
    if (kosulluKuralMi(t)) kosullu.push({ yol: k, kapsam: 'proje' });
    else ekle(k, 'kural');
  }

  // 4) Otomatik hafiza
  let hafiza = null;
  if (otomatikHafiza) {
    const kok = hafizaKoku(cwd, gitKokFn);
    const pd = projelerDizini ?? join(ev, '.claude', 'projects');
    const yol = join(pd, projeKlasorAdi(kok), 'memory', 'MEMORY.md');
    if (dosyaMi(yol)) {
      let t = readFileSync(yol, 'utf8');
      const satirlar = t.split(NL).slice(0, SINIR.hafizaSatir);
      t = satirlar.join(NL);
      if (Buffer.byteLength(t) > SINIR.hafizaBayt) t = t.slice(0, SINIR.hafizaBayt);
      dosyalar.push({ yol, tur: 'otomatik-hafiza', satir: t.split(NL).length,
        bayt: Buffer.byteLength(t), token: tahminiToken(t), atlama: 0 });
      hafiza = { yol, kok };
      if (anahtar(kok) !== anahtar(cwd)) {
        uyarilar.push('Otomatik hafiza BASKA bir kokten yukleniyor (' + kok + '). Kendi deposu olmayan proje '
          + 'ust deponun hafizasini gorur; ajan kosularinda kapali tutulmali.');
      }
    }
  }

  const toplam = dosyalar.reduce((t, d) => ({ satir: t.satir + d.satir, bayt: t.bayt + d.bayt,
    token: t.token + d.token }), { satir: 0, bayt: 0, token: 0 });

  if (toplam.token > SINIR.kosuBasiToken) {
    uyarilar.push('Her ajan kosusu ise baslamadan ~' + toplam.token + ' token otomatik talimat yukluyor. '
      + 'Paralel ajan sayisiyla carpilir.');
  }

  return { cwd: resolve(cwd), dosyalar, kosullu, toplam, uyarilar, hafiza };
}
