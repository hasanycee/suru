import { openDb } from './db.js';
import { runIndex } from './indexer.js';
import { DB_PATH } from './paths.js';
import { bilinmeyenModeller, fiyatBilgisi } from './pricing.js';

// Indeksleme pahali degil ama her istekte calistirmaya da gerek yok.
const TAZELIK_MS = 60_000;
let sonIndeks = 0;
let db = null;

async function hazirla() {
  if (Date.now() - sonIndeks > TAZELIK_MS) {
    const r = await runIndex({ quiet: true });
    r.db.close();
    sonIndeks = Date.now();
    if (db) { db.close(); db = null; }
  }
  if (!db) db = openDb(DB_PATH);
  return db;
}

const SEP = String.fromCharCode(92);
function parcala(p) {
  return (p || '').split(SEP).join('/').split('/').filter(Boolean);
}
/** Yolun son iki parcasi: tam yol hem uzun hem gizlilik acisindan gereksiz. */
function kisaYol(p) {
  if (!p) return '?';
  return parcala(p).slice(-2).join('/');
}
/**
 * Iki farkli klasorun son iki parcasi ayni olabilir (Documents/KorkuOyunu/game ve
 * Documents/GitHub/KorkuOyunu/game). Cakisanlari bir parca daha gostererek ayir.
 */
function etiketle(satirlar) {
  // Olcut ayni etiket degil, ayni etiketin FARKLI yollara denk gelmesi.
  // Ayni projeden birden cok oturum olmasi cakisma degildir.
  const yollar = new Map();
  for (const s of satirlar) {
    if (!yollar.has(s.ad)) yollar.set(s.ad, new Set());
    yollar.get(s.ad).add(s.tamYol);
  }
  for (const s of satirlar) {
    if (yollar.get(s.ad).size > 1) {
      const par = parcala(s.tamYol);
      s.ad = par.slice(-3).join('/') || s.ad;
    }
    delete s.tamYol;
  }
  return satirlar;
}

export async function raporVerisi() {
  const d = await hazirla();

  const genel = d.prepare(`SELECT COUNT(*) oturum, SUM(usd) usd, MIN(started_at) ilk, MAX(ended_at) son,
    SUM(human_turns) turlar, SUM(assistant_msgs) mesajlar, SUM(tool_calls) araclar,
    SUM(error_results) hatalar, SUM(active_ms) aktif FROM sessions`).get();

  const projeler = d.prepare(`SELECT project_path yol, COUNT(*) oturum, SUM(usd) usd,
    SUM(active_ms) aktif, SUM(error_results) hatalar
    FROM sessions GROUP BY project_path ORDER BY usd DESC LIMIT 15`).all()
    .map((r) => ({ oturum: r.oturum, usd: r.usd, aktif: r.aktif, hatalar: r.hatalar,
      ad: kisaYol(r.yol), tamYol: r.yol }));
  etiketle(projeler);

  const gunluk = d.prepare(`SELECT date(started_at/1000,'unixepoch') gun, COUNT(*) oturum, SUM(usd) usd
    FROM sessions WHERE started_at IS NOT NULL GROUP BY gun ORDER BY gun DESC LIMIT 30`).all().reverse();

  const modeller = d.prepare(`SELECT model, SUM(msgs) mesajlar, SUM(in_tok) girdi, SUM(out_tok) cikti,
    SUM(cache_w) cacheYaz, SUM(cache_r) cacheOku, SUM(usd) usd
    FROM session_models GROUP BY model ORDER BY usd DESC`).all();

  const araclar = d.prepare(`SELECT tool arac, SUM(calls) adet FROM session_tools
    GROUP BY tool ORDER BY adet DESC LIMIT 12`).all();

  const enPahali = d.prepare(`SELECT project_path yol, title baslik, usd, human_turns turlar,
    active_ms aktif, started_at basladi, first_prompt ilkMesaj
    FROM sessions ORDER BY usd DESC LIMIT 10`).all()
    .map((r) => ({
      ad: kisaYol(r.yol), tamYol: r.yol,
      baslik: r.baslik || (r.ilkMesaj || '').replace(/\s+/g, ' ').slice(0, 50) || '(basliksiz)',
      usd: r.usd, turlar: r.turlar, aktif: r.aktif, basladi: r.basladi,
    }));
  etiketle(enPahali);

  // Cache verimi: girdinin ne kadari ucuz okumadan geliyor
  const c = d.prepare('SELECT SUM(in_tok) ham, SUM(cache_w) yaz, SUM(cache_r) oku FROM session_models').get();
  const toplamGirdi = (c.ham || 0) + (c.yaz || 0) + (c.oku || 0);

  const s5 = d.prepare("SELECT SUM(usd) usd FROM session_models WHERE model='claude-sonnet-5'").get();

  return {
    genel, projeler, gunluk, modeller, araclar, enPahali,
    // Fiyat tablosunda olmayan modeller: rakamlar eksik demektir, panel sussun diye degil
    // gorunur olsun diye tasiniyor.
    bilinmeyen: bilinmeyenModeller(),
    fiyat: fiyatBilgisi(),
    cache: { ham: c.ham || 0, yaz: c.yaz || 0, oku: c.oku || 0, toplam: toplamGirdi },
    sonnet5: s5?.usd || 0,
    uretildi: Date.now(),
  };
}
