// Insan mudahale kanali: gercek bir terminal, panelden.
//
// GUVENLIK: Bu dosya makinede KEYFI KOMUT calistirir. Jeton sizarsa panel bir
// uzak kabuga donusur. Bu yuzden sunucu tarafinda SURU_TERMINAL=1 olmadan
// terminal uclari hic acilmaz - kapali dogar, acmak bilincli bir karardir.
//
// Neden otomasyonun yerine gecmiyor: PTY'nin ciktisi ekran boyasidir (ANSI),
// makine okuyamaz. Ajan yonetimi stream-json uzerinden yurur (kosucu.js);
// burasi "bir sey ters gitti, elimi sokmam lazim" kanali.
//
// Sinir: PTY yalnizca KENDI baslattigi sureci kontrol edebilir. Baska bir
// terminalde acilmis oturuma sonradan baglanmak mumkun degil - onlar
// gozlem duzleminde salt-okunur kalir.

import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { veriDizini, KADRO_YOLU } from './paths.js';

// Gec katilan izleyiciye gosterilecek gecmis. Sinirsiz tutmak bellegi yer.
const TAMPON_BAYT = 96 * 1024;

let pty = null;
async function ptyYukle() {
  if (pty) return pty;
  try {
    pty = await import('node-pty');
  } catch {
    throw new Error('node-pty kurulu degil. Insan mudahale kanali icin: npm install node-pty');
  }
  return pty;
}

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
// CR? + LF -> CR. Duz metinle kuruluyor: kaynakta kacis dizisi tutmuyoruz.
const SATIR_SONU = new RegExp(CR + '?' + LF, 'g');

/** LF ve CRLF -> CR. Disa acik: testler dogrudan sinar. */
export function satirSonuNormal(veri) {
  return String(veri ?? '').replace(SATIR_SONU, CR);
}

export class OturumYoneticisi extends EventEmitter {
  constructor() {
    super();
    this.canli = new Map();   // id -> { proc, tampon, ajan, cols, rows }
    this.kadro = this.#kadroOku();
  }

  // --- Kadro (kalici tanimlar) ---
  #kadroOku() {
    try {
      const h = JSON.parse(readFileSync(KADRO_YOLU, 'utf8'));
      return Array.isArray(h) ? h : [];
    } catch { return []; }
  }

  #kadroYaz() {
    veriDizini();
    writeFileSync(KADRO_YOLU, JSON.stringify(this.kadro, null, 2), 'utf8');
  }

  ajanEkle({ ad, cwd, komut = 'claude', argumanlar = [] }) {
    if (!ad || !ad.trim()) throw new Error('terminal adi bos olamaz');
    if (!existsSync(cwd)) throw new Error('klasor yok: ' + cwd);
    if (this.kadro.some((a) => a.ad === ad.trim())) throw new Error('bu ad zaten var: ' + ad);
    const ajan = {
      id: randomUUID(), ad: ad.trim(), cwd, komut,
      argumanlar: Array.isArray(argumanlar) ? argumanlar : [],
    };
    this.kadro.push(ajan);
    this.#kadroYaz();
    this.emit('kadro', this.kadro);
    return ajan;
  }

  ajanSil(id) {
    this.durdur(id);
    this.kadro = this.kadro.filter((a) => a.id !== id);
    this.#kadroYaz();
    this.emit('kadro', this.kadro);
  }

  // --- Surec yonetimi ---
  async baslat(id, { cols = 100, rows = 30 } = {}) {
    const ajan = this.kadro.find((a) => a.id === id);
    if (!ajan) throw new Error('terminal bulunamadi: ' + id);
    if (this.canli.has(id)) return this.ozet(id);

    const p = await ptyYukle();
    const proc = p.spawn(ajan.komut, ajan.argumanlar, {
      name: 'xterm-256color',
      cols, rows,
      cwd: ajan.cwd,
      env: process.env,
      // ConPTY renk/imlec davranisinda daha sadik, TUI'ler icin dogru secim.
      // Ama konsolsuz bir ust surecten kapatilinca node-pty'nin yardimci sureci
      // "AttachConsole failed" yigin izi basiyor (surecler yine de temiz kapaniyor).
      // Rahatsiz ederse SURU_WINPTY=1 ile eski yola dus - sessiz ama daha az sadik.
      useConpty: process.platform === 'win32' && process.env.SURU_WINPTY !== '1',
    });

    const kayit = { proc, ajan, tampon: '', cols, rows, baslangic: Date.now(), cikisKodu: null };
    this.canli.set(id, kayit);

    proc.onData((veri) => {
      kayit.tampon += veri;
      if (kayit.tampon.length > TAMPON_BAYT) kayit.tampon = kayit.tampon.slice(-TAMPON_BAYT);
      this.emit('veri', id, veri);
    });

    proc.onExit(({ exitCode }) => {
      kayit.cikisKodu = exitCode;
      this.canli.delete(id);
      this.emit('cikis', id, exitCode);
    });

    this.emit('basladi', id, ajan);
    return this.ozet(id, ajan);
  }

  /**
   * Terminale girdi yazar.
   *
   * Satir sonu normallestirilir: PTY'de Enter CR demektir, ama mobil
   * klavyeler LF gonderiyor. Normallestirmezsek komut yazilir ama CALISMAZ -
   * kullanici Enter'a basar, hicbir sey olmaz. Cok satirli yapistirmada da
   * dogru olan bu: terminal her satiri CR bekler.
   */
  yaz(id, veri) {
    const k = this.canli.get(id);
    if (!k) throw new Error('terminal calismiyor: ' + id);
    k.proc.write(satirSonuNormal(veri));
  }

  boyutlandir(id, cols, rows) {
    const k = this.canli.get(id);
    if (!k) return;
    // Ayni boyuta tekrar ayarlamak bazi programlari gereksiz yere yeniden cizdiriyor.
    if (k.cols === cols && k.rows === rows) return;
    k.cols = cols; k.rows = rows;
    try { k.proc.resize(cols, rows); } catch { /* surec kapanmis olabilir */ }
  }

  durdur(id) {
    const k = this.canli.get(id);
    if (!k) return false;
    try { k.proc.kill(); } catch { /* zaten olmus */ }
    return true;
  }

  /** Gec katilan izleyici icin: o ana kadarki ekran. */
  gecmis(id) {
    return this.canli.get(id)?.tampon ?? '';
  }

  ozet(id, ajan = null) {
    const a = ajan ?? this.kadro.find((x) => x.id === id);
    const k = this.canli.get(id);
    return {
      id, ad: a?.ad ?? '?', cwd: a?.cwd ?? null, komut: a?.komut ?? null,
      calisiyor: !!k, pid: k?.proc?.pid ?? null,
      baslangic: k?.baslangic ?? null, cols: k?.cols ?? null, rows: k?.rows ?? null,
    };
  }

  /** Panelde gosterilecek ozet: kadro + hangisi calisiyor. */
  liste() {
    return this.kadro.map((a) => this.ozet(a.id, a));
  }

  hepsiniDurdur() {
    for (const id of [...this.canli.keys()]) this.durdur(id);
  }
}
