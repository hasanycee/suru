// Is basina MCP sunucusu verme.
//
// Varsayilan: HICBIR kosuya MCP yok (--strict-mcp-config, bkz. yetki.MCP_KAPALI). Olculdu: bayraksiz
// kosuda kullanicinin butun MCP sunuculari ajana yukleniyordu (Unity Editor dahil). Unity isinde ajan
// editoru goremiyor (konsol, sahne); bu modul SECILEN sunucuyu, SECILEN modda acar:
//
//   okur : yalniz katalogdaki okuyan araclar izin listesine girer (permissions.allow). Headless kosuda
//          izin listesinde olmayan MCP araci sorulamaz, dolayisiyla REDDEDILIR (olculdu: plan kosusunda
//          claude.ai baglayici araci izin reddi aldi). Ayrica bilinen tehlikeliler acikca deny.
//   tam  : sunucunun butun araclari izinli (mcp__<sunucu>). Is basina elle secilir.
//
// Tanimlar kullanicinin ~/.claude.json > mcpServers ve projenin .mcp.json / projects[cwd].mcpServers
// kayitlarindan KOPYALANIR; gecici bir --mcp-config dosyasina yazilir. --strict-mcp-config KALIR: baska
// hicbir sunucu yuklenmez. Kanarya (kosucu): init.tools'ta secilen sunucu disinda mcp__ araci gorulurse
// kosu kesilir.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { VERI_DIZINI, veriDizini } from './paths.js';

const NL = String.fromCharCode(10);

function jsonOku(yol) {
  try { return JSON.parse(readFileSync(yol, 'utf8')); } catch { return null; }
}

/**
 * Kullanicinin bildigi MCP sunuculari: ad -> tanim. Kullanici duzeyi (~/.claude.json) + proje
 * duzeyi (.mcp.json, ~/.claude.json > projects[cwd].mcpServers). Proje tanimi ayni adi ezer.
 */
export function tanimlariOku(cwd = null, { ev = homedir() } = {}) {
  const out = {};
  const kok = jsonOku(join(ev, '.claude.json')) ?? {};
  for (const [ad, t] of Object.entries(kok.mcpServers ?? {})) out[ad] = t;
  if (cwd) {
    const projeler = kok.projects ?? {};
    const anahtarlar = Object.keys(projeler).filter((p) => yolAyni(p, cwd));
    for (const p of anahtarlar) for (const [ad, t] of Object.entries(projeler[p]?.mcpServers ?? {})) out[ad] = t;
    const yerel = jsonOku(join(cwd, '.mcp.json'));
    for (const [ad, t] of Object.entries(yerel?.mcpServers ?? {})) out[ad] = t;
  }
  return out;
}

function yolAyni(a, b) {
  const n = (s) => String(s ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return n(a) === n(b);
}

/** Panel/komut icin: sunucu adlari ve okur katalogunda kac arac oldugu. Tanimlarin icerigi disari verilmez. */
export function sunucuListesi(ayar, cwd = null, secenekler = {}) {
  const t = tanimlariOku(cwd, secenekler);
  return Object.keys(t).sort().map((ad) => ({ ad, okurArac: (ayar?.okur?.[ad] ?? []).length }));
}

/**
 * Bir isin MCP plani: argumanlar, izin/yasak kurallari, izinli on ekler (kanarya icin).
 * is.mcp bos -> { args: MCP_KAPALI, izin: [], yasak: [], onekler: [] } (mevcut davranis).
 */
export function mcpPlani(is, ayar, { cwd = null, tanimlar = null, dizin = join(VERI_DIZINI, 'mcp') } = {}) {
  const secilen = Array.isArray(is?.mcp) ? is.mcp.map((s) => String(s).trim()).filter(Boolean) : [];
  if (!secilen.length) return { args: ['--strict-mcp-config'], izin: [], yasak: [], onekler: [], sunucular: [], dosya: null };
  const hepsi = tanimlar ?? tanimlariOku(cwd ?? is?.cwd ?? null);
  const mcpServers = {};
  const eksik = [];
  for (const ad of secilen) {
    if (hepsi[ad]) mcpServers[ad] = hepsi[ad]; else eksik.push(ad);
  }
  if (eksik.length) throw new Error('MCP sunucusu tanimli degil: ' + eksik.join(', ') + ' (~/.claude.json > mcpServers ya da proje .mcp.json)');

  const mod = is.mcpMod === 'tam' ? 'tam' : 'okur';
  const izin = [], yasak = [];
  for (const ad of secilen) {
    for (const t of ayar?.yasak?.[ad] ?? []) yasak.push('mcp__' + ad + '__' + t);
    if (mod === 'tam') { izin.push('mcp__' + ad); continue; }
    const okur = ayar?.okur?.[ad] ?? [];
    for (const t of okur) if (!(ayar?.yasak?.[ad] ?? []).includes(t)) izin.push('mcp__' + ad + '__' + t);
  }

  veriDizini();
  mkdirSync(dizin, { recursive: true });
  const icerik = JSON.stringify({ mcpServers }, null, 2) + NL;
  const iz = createHash('sha1').update(icerik).digest('hex').slice(0, 10);
  const dosya = join(dizin, 'mcp-' + iz + '.json');
  let mevcut = null;
  try { mevcut = readFileSync(dosya, 'utf8'); } catch { /* ilk kez */ }
  if (mevcut !== icerik) writeFileSync(dosya, icerik, 'utf8');

  return {
    args: ['--mcp-config', dosya, '--strict-mcp-config'],
    izin, yasak, mod,
    onekler: secilen.map((ad) => 'mcp__' + ad + '__'),
    sunucular: secilen, dosya,
  };
}

/** Ajana MCP verildiginde istem notu: okur modda neyi yapamayacagini bilsin, bosuna denemesin. */
export function mcpTalimati(plan) {
  if (!plan?.sunucular?.length) return null;
  if (plan.mod === 'tam') return 'Bu kosuda su MCP sunuculari acik (tam yetki): ' + plan.sunucular.join(', ') + '.';
  return 'Bu kosuda su MCP sunuculari SALT-OKUR acik: ' + plan.sunucular.join(', ') + '. Yalniz okuyan araclar izinli ('
    + plan.izin.map((i) => i.replace(/^mcp__[^_]+(?:-[^_]+)*__/, '')).join(', ') + '); degistiren/calistiran araclar reddedilir, deneme.';
}
