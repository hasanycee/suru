import { openDb } from './db.js';
import { runIndex } from './indexer.js';
import { DB_PATH } from './paths.js';
import { bilinmeyenModeller, fiyatBilgisi } from './pricing.js';

const usd = (n) => '$' + (n ?? 0).toFixed(2);
const kt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1e3) + 'K');
const gun = (ms) => new Date(ms).toISOString().slice(0, 10);
const sure = (ms) => {
  if (!ms || ms < 0) return '-';
  const d = Math.round(ms / 60000);
  return d >= 60 ? `${Math.floor(d / 60)}s ${d % 60}dk` : `${d}dk`;
};
const bar = (v, max, w = 22) => '#'.repeat(Math.max(0, Math.round((v / (max || 1)) * w)));
const SEP_RE = new RegExp('[' + String.fromCharCode(92,92) + '/]');
const kisa = (p) => (p || '').split(SEP_RE).filter(Boolean).slice(-2).join('/');
const baslik = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));

await runIndex({ quiet: true });
const db = openDb(DB_PATH);

const g = db.prepare(`SELECT COUNT(*) n, SUM(usd) usd, MIN(started_at) ilk, MAX(ended_at) son,
  SUM(human_turns) ht, SUM(assistant_msgs) am, SUM(tool_calls) tc, SUM(error_results) er,
  SUM(CASE WHEN unknown_cost=1 THEN 1 ELSE 0 END) bilinmeyen FROM sessions`).get();

baslik('GENEL');
console.log(`oturum        : ${g.n}`);
console.log(`tarih araligi : ${gun(g.ilk)} -> ${gun(g.son)}`);
console.log(`toplam maliyet: ${usd(g.usd)}  <- API listesi fiyatiyla karsilik degeri`);
console.log(`                (abonelikteysen bu kadar ODEMEDIN; abonelik karsiliginda`);
console.log(`                 aldigin degerin API fiyatiyla olcusu bu.)`);
console.log(`senin turun   : ${g.ht}  (ajan mesaji: ${g.am}, arac cagrisi: ${g.tc})`);
console.log(`arac hatasi   : ${g.er}  (%${((g.er / (g.tc || 1)) * 100).toFixed(1)} basarisiz)`);
if (g.bilinmeyen) console.log(`! ${g.bilinmeyen} oturumda fiyati bilinmeyen model var, maliyet eksik.`);

baslik('PROJE BAZLI');
const projeler = db.prepare(`SELECT project_path pp, COUNT(*) n, SUM(usd) usd,
  SUM(active_ms) sure, SUM(human_turns) ht, SUM(error_results) er
  FROM sessions GROUP BY project_path ORDER BY usd DESC`).all();
const maxP = projeler[0]?.usd || 1;
console.log('proje'.padEnd(26) + 'otr'.padStart(4) + 'maliyet'.padStart(10) + ' aktif'.padEnd(10) + ' pay');
for (const p of projeler) {
  console.log(
    kisa(p.pp).slice(0, 25).padEnd(26) +
    String(p.n).padStart(4) +
    usd(p.usd).padStart(10) + '  ' +
    sure(p.sure).padEnd(9) +
    bar(p.usd, maxP)
  );
}

baslik('SON 14 GUN');
const gunluk = db.prepare(`SELECT date(started_at/1000,'unixepoch') d, COUNT(*) n, SUM(usd) usd
  FROM sessions WHERE started_at IS NOT NULL GROUP BY d ORDER BY d DESC LIMIT 14`).all().reverse();
const maxG = Math.max(...gunluk.map((r) => r.usd), 0.01);
for (const r of gunluk) console.log(`${r.d}  ${String(r.n).padStart(3)} otr ${usd(r.usd).padStart(9)}  ${bar(r.usd, maxG)}`);

baslik('MODEL DAGILIMI');
const modeller = db.prepare(`SELECT model, SUM(msgs) msgs, SUM(in_tok) i, SUM(out_tok) o,
  SUM(cache_w) cw, SUM(cache_r) cr, SUM(usd) usd FROM session_models GROUP BY model ORDER BY usd DESC`).all();
console.log('model'.padEnd(28) + 'mesaj'.padStart(7) + 'cikti'.padStart(8) + 'cache-oku'.padStart(11) + 'maliyet'.padStart(10));
for (const m of modeller) {
  console.log(m.model.padEnd(28) + String(m.msgs).padStart(7) + kt(m.o).padStart(8) + kt(m.cr).padStart(11) + usd(m.usd).padStart(10));
}

baslik('CACHE VERIMI');
const c = db.prepare('SELECT SUM(in_tok) i, SUM(cache_w) cw, SUM(cache_r) cr FROM session_models').get();
const girdi = c.i + c.cw + c.cr;
console.log(`toplam girdi token : ${kt(girdi)}`);
console.log(`  cache okuma      : ${kt(c.cr)}  (%${((c.cr / girdi) * 100).toFixed(1)}) <- ucuz, x0.1`);
console.log(`  cache yazma      : ${kt(c.cw)}  (%${((c.cw / girdi) * 100).toFixed(1)}) <- pahali`);
console.log(`  ham girdi        : ${kt(c.i)}  (%${((c.i / girdi) * 100).toFixed(1)})`);

baslik('EN COK KULLANILAN ARACLAR');
const araclar = db.prepare('SELECT tool, SUM(calls) n FROM session_tools GROUP BY tool ORDER BY n DESC LIMIT 12').all();
const maxA = araclar[0]?.n || 1;
for (const a of araclar) console.log(a.tool.slice(0, 32).padEnd(34) + String(a.n).padStart(6) + '  ' + bar(a.n, maxA, 18));

baslik('EN PAHALI 10 OTURUM');
const top = db.prepare(`SELECT project_path pp, title, usd, human_turns ht, tool_calls tc,
  error_results er, started_at sa, ended_at ea, first_prompt fp FROM sessions ORDER BY usd DESC LIMIT 10`).all();
for (const s of top) {
  const ad = s.title || (s.fp || '').replace(/\s+/g, ' ').slice(0, 46) || '(basliksiz)';
  console.log(`${usd(s.usd).padStart(9)}  ${gun(s.sa)}  ${kisa(s.pp).slice(0, 20).padEnd(21)} ${sure(s.ea - s.sa).padStart(7)}  ${s.ht} tur  ${ad}`);
}

// Sonnet 5 tanitim fiyati bitisinin etkisi
const S5_BITIS = Date.parse('2026-09-01T00:00:00Z');
const s5 = db.prepare("SELECT SUM(usd) usd FROM session_models WHERE model='claude-sonnet-5'").get();
if (s5?.usd) {
  const gecti = Date.now() >= S5_BITIS;
  baslik(gecti ? 'SONNET 5 ZAMMI (YURURLUKTE)' : 'UYARI: SONNET 5 ZAMMI');
  console.log(gecti
    ? "Sonnet 5 tanitim fiyati 2026-08-31'de bitti ($2/$10 -> $3/$15, +%50)."
    : "Sonnet 5 tanitim fiyati 2026-08-31'de bitiyor ($2/$10 -> $3/$15, +%50).");
  console.log(`Bugune kadarki Sonnet 5 harcaman: ${usd(s5.usd)}`);
  console.log(`Ayni kullanim yeni fiyatla       : ${usd(s5.usd * 1.5)}  (+${usd(s5.usd * 0.5)})`);
}

// Fiyat tablosunda olmayan model gorulduyse rakamlar eksiktir - sessizce gecme.
const bilinmeyen = bilinmeyenModeller();
if (bilinmeyen.length) {
  baslik('UYARI: FIYATI BILINMEYEN MODEL');
  const f = fiyatBilgisi();
  console.log(`Fiyat tablosu (${f.guncellendi}) su modelleri tanimiyor, maliyetleri 0 sayildi:`);
  for (const b of bilinmeyen) console.log(`  ${b.model.padEnd(34)} ${b.mesaj} mesaj`);
  console.log(`Duzeltmek icin: data/pricing.json`);
}

db.close();
