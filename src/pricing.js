// Fiyatlar artik kodda degil: data/pricing.json. Yeni model cikinca kod
// degistirmeye gerek yok, tabloyu guncellemek yeter.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERI = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'pricing.json');
const T = JSON.parse(readFileSync(VERI, 'utf8'));

const UCRETSIZ = new Set(T.ucretsiz ?? []);
const CW5 = T.cache?.yazma5dk ?? 1.25;
const CW1 = T.cache?.yazma1saat ?? 2.0;
const CR  = T.cache?.okuma ?? 0.1;

// Tabloda olmayan modelleri say: rapor sussuz kalmasin, panel uyari bassin.
const BILINMEYEN = new Map();

/** Model kimligindeki tarih sonekini atar: claude-opus-5-20260401 -> claude-opus-5 */
const tarihsiz = (m) => m.replace(/-\d{8}$/, '');

export function rateFor(model, atMs) {
  let e = T.modeller[model];
  if (!e) {
    const k = tarihsiz(model);
    // Tarihli surum tabloda yoksa tarihsiz karsiligi ayni fiyattir.
    if (k !== model) e = T.modeller[k];
  }
  if (!e) return null;
  const t = e.tanitim;
  if (t && atMs != null && atMs < Date.parse(t.bitis)) return { in: t.in, out: t.out };
  return { in: e.in, out: e.out };
}

/**
 * Tek bir assistant mesajinin usage blogundan USD maliyet cikarir.
 * Bilinmeyen model -> 0 dondurur ama unknown=true isaretler.
 */
export function costOf(model, usage, atMs) {
  if (!usage) return { usd: 0, unknown: false };
  // <synthetic>: API cagrisi degil, istemcinin urettigi yer tutucu. Ucretsiz.
  if (UCRETSIZ.has(model)) return { usd: 0, unknown: false };
  const r = rateFor(model, atMs);
  if (!r) {
    BILINMEYEN.set(model, (BILINMEYEN.get(model) || 0) + 1);
    return { usd: 0, unknown: true };
  }

  const M = 1e6;
  const cc = usage.cache_creation || {};
  // Detayli kirilim varsa onu kullan, yoksa toplami 5dk varsay (muhafazakar alt sinir).
  const has5 = typeof cc.ephemeral_5m_input_tokens === 'number';
  const has1 = typeof cc.ephemeral_1h_input_tokens === 'number';
  const w5 = has5 ? cc.ephemeral_5m_input_tokens : (has1 ? 0 : (usage.cache_creation_input_tokens || 0));
  const w1 = has1 ? cc.ephemeral_1h_input_tokens : 0;

  const usd =
    ((usage.input_tokens || 0) * r.in +
     w5 * r.in * CW5 +
     w1 * r.in * CW1 +
     (usage.cache_read_input_tokens || 0) * r.in * CR +
     (usage.output_tokens || 0) * r.out) / M;

  return { usd, unknown: false };
}

/** Bu surecte rastlanan bilinmeyen modeller: [{model, mesaj}] */
export function bilinmeyenModeller() {
  return [...BILINMEYEN].map(([model, mesaj]) => ({ model, mesaj }))
    .sort((a, b) => b.mesaj - a.mesaj);
}

export function fiyatBilgisi() {
  return { guncellendi: T.guncellendi, kaynak: T.kaynak, notlar: T.notlar ?? {} };
}
