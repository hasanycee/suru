import { open, stat } from 'node:fs/promises';
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { basename } from 'node:path';
import { OLAY_DOSYASI } from './paths.js';

const KUYRUK = 128 * 1024; // dosyanin son bu kadar baytina bak

export const DURUM = {
  CALISIYOR:  'calisiyor',
  ONAY:       'onay-bekliyor',
  SENI:       'seni-bekliyor',
  TAKILDI:    'takildi',
  LIMIT:      'limit-doldu',
  BOSTA:      'bosta',
};

/** Dosyanin sonundaki tam JSON satirlarini sirayla dondurur. */
async function kuyrukKayitlari(file, size) {
  const start = Math.max(0, size - KUYRUK);
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    let metin = buf.toString('utf8');
    if (start > 0) metin = metin.slice(metin.indexOf('\n') + 1); // yarim satiri at
    const out = [];
    for (const l of metin.split('\n')) {
      const t = l.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* yarim yazilmis son satir */ }
    }
    return out;
  } finally {
    await fh.close();
  }
}

/**
 * Oturumun su anki durumunu cikarir.
 * onayEsigiMs: bekleyen arac cagrisi bu sureden uzun sessiz kalirsa onay bekliyor sayilir.
 */
export async function oturumDurumu(file, { onayEsigiMs = 30_000, takildiMs = 15 * 60_000, olaylar = null } = {}) {
  const st = await stat(file);
  const kayitlar = await kuyrukKayitlari(file, st.size);
  if (!kayitlar.length) return null;

  let durum = DURUM.BOSTA;
  let sonZaman = null, cwd = null, dal = null, baslik = null, model = null;
  let sonMetin = null, sonArac = null;
  const bekleyen = new Set(); // cevabi gelmemis tool_use id'leri
  let kuyrukta = 0;

  for (const d of kayitlar) {
    if (d.timestamp) sonZaman = Date.parse(d.timestamp);
    if (d.cwd) cwd = d.cwd;
    if (d.gitBranch) dal = d.gitBranch;
    if (d.type === 'custom-title' && d.customTitle) baslik = d.customTitle;
    if (d.type === 'ai-title' && d.title && !baslik) baslik = d.title;
    if (d.type === 'queue-operation') {
      if (d.operation === 'enqueue') kuyrukta++;
      else if (kuyrukta > 0) kuyrukta--;
    }
    if (d.isSidechain) continue; // alt-ajan ana durumu belirlemez

    if (d.type === 'user') {
      const c = d.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) if (b?.type === 'tool_result') bekleyen.delete(b.tool_use_id);
        if (!d.isMeta && c.some((b) => b?.type === 'text')) durum = DURUM.CALISIYOR;
      } else if (typeof c === 'string' && !d.isMeta && c.trim()) {
        durum = DURUM.CALISIYOR;
      }
    } else if (d.type === 'assistant') {
      const m = d.message || {};
      if (m.model) model = m.model;
      for (const b of m.content || []) {
        if (b?.type === 'tool_use') { bekleyen.add(b.id); sonArac = b.name; }
        else if (b?.type === 'text' && b.text?.trim()) sonMetin = b.text.trim();
      }
      durum = m.stop_reason === 'end_turn' ? DURUM.SENI : DURUM.CALISIYOR;
    }
  }

  const yas = Date.now() - (sonZaman ?? st.mtimeMs);

  // Kullanim limiti mesaji: oturum kendiliginden devam edemez.
  const LIMIT_RE = /hit your (weekly|5-hour|usage) limit|usage limit reached/i;
  if (sonMetin && LIMIT_RE.test(sonMetin)) {
    const m = sonMetin.match(/resets?\s+([^.]{3,40})/i);
    return { durum: DURUM.LIMIT, yas, cwd, dal, baslik, model, kuyrukta,
      bekleyenArac: null, sifirlanma: m ? m[1].trim() : null,
      sonMetin: sonMetin.slice(0, 120), sonZaman: sonZaman ?? st.mtimeMs };
  }

  // Hook kuruluysa izin istemini tahmin etmeye gerek yok: olay dosyasi kesin soyler.
  const olay = olaylar?.get(basename(file, '.jsonl'));
  const kesinOnay = !!olay && bekleyen.size > 0 && olay.t >= sonZaman - 2000;

  if (kesinOnay) {
    return { durum: DURUM.ONAY, kesin: true, yas, cwd, dal, baslik, model, kuyrukta,
      bekleyenArac: olay.tool || sonArac, sonMetin: sonMetin?.replace(/\s+/g, ' ').slice(0, 120) ?? null,
      sonZaman: sonZaman ?? st.mtimeMs };
  }

  // Cevaplanmamis arac cagrisi + sessizlik = buyuk ihtimalle izin istemi bekliyor (cikarim).
  if (durum === DURUM.CALISIYOR && bekleyen.size > 0) {
    if (yas > takildiMs) durum = DURUM.TAKILDI;
    else if (yas > onayEsigiMs) durum = DURUM.ONAY;
  } else if (durum === DURUM.CALISIYOR && yas > takildiMs) {
    durum = DURUM.BOSTA;
  }

  return {
    durum, kesin: false, yas, cwd, dal, baslik, model, kuyrukta,
    bekleyenArac: bekleyen.size ? sonArac : null,
    sonMetin: sonMetin?.replace(/\s+/g, ' ').slice(0, 120) ?? null,
    sonZaman: sonZaman ?? st.mtimeMs,
  };
}

/**
 * Hook'un yazdigi olay dosyasini okur: oturum -> son izin istemi zamani.
 * Dosya yoksa bos harita doner (hook kurulu degilse panel yine calisir).
 *
 * Sadece dosyanin SONU okunur: bu fonksiyon her taramada cagriliyor, dosya
 * aylarca buyuyor. Tamamini okumak taramayi giderek yavaslatirdi.
 */
const OLAY_KUYRUK = 64 * 1024;
const NL = String.fromCharCode(10);

export function olaylariYukle() {
  const harita = new Map();
  let fd;
  try { fd = openSync(OLAY_DOSYASI, 'r'); } catch { return harita; }
  let ham = '';
  try {
    const boy = fstatSync(fd).size;
    const bas = Math.max(0, boy - OLAY_KUYRUK);
    const buf = Buffer.alloc(boy - bas);
    readSync(fd, buf, 0, buf.length, bas);
    ham = buf.toString('utf8');
    if (bas > 0) ham = ham.slice(ham.indexOf(NL) + 1); // yarim satiri at
  } catch { return harita; } finally { closeSync(fd); }

  for (const l of ham.split(NL)) {
    const t = l.trim();
    if (!t) continue;
    let d;
    try { d = JSON.parse(t); } catch { continue; }
    if (d.olay !== 'PermissionRequest' || !d.session_id) continue;
    const onceki = harita.get(d.session_id);
    if (!onceki || d.t > onceki.t) harita.set(d.session_id, { t: d.t, tool: d.tool });
  }
  return harita;
}
