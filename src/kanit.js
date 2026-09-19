// Kanit zinciri: "bu ajan X dedi" degil, "X dedi CUNKU su adimlari atti".
//
// Yeni loglama gerekmiyor. Her kosuya --session-id verdigimiz icin Claude Code'un
// kendi transkripti (~/.claude/projects/<proje>/<oturum>.jsonl) her arac cagrisinin
// GIRDISINI ve SONUCUNU tutuyor. Bu modul onu okuyup kosuya baglar.
//
// Ayni kayit veri akisi defterinin de cekirdegi: Read edilen her dosyanin icerigi
// modele gitmistir; Bash ciktisi modele gitmistir; WebFetch disari istek atmistir.
// Bu yuzden veri akisi listeleri SONUCA gore kurulur: reddedilen ya da hatayla
// donen okuma modele icerik tasimamistir ve listeye girmez. (Ilk surum denemeyi
// sayiyordu; yasak calistiginda bile gizlilik ihlali gibi gorunurdu.)
//
// Belirsizlik ifadeleri ("muhtemelen", "emin degilim") SEZGIDIR: metin taramasi,
// kesinlik iddiasi yok. Amac okuyana "burada ajan kendisi de emin degildi" demek.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const NL = String.fromCharCode(10);

export function varsayilanProjelerDizini() {
  return join(homedir(), '.claude', 'projects');
}

/** Oturumun transkriptini bulur (proje klasoru adini bilmeden). */
export function transkriptBul(sessionId, { projelerDizini = varsayilanProjelerDizini() } = {}) {
  if (!sessionId) return null;
  let klasorler;
  try { klasorler = readdirSync(projelerDizini, { withFileTypes: true }); } catch { return null; }
  for (const k of klasorler) {
    if (!k.isDirectory()) continue;
    const yol = join(projelerDizini, k.name, sessionId + '.jsonl');
    if (existsSync(yol)) return yol;
  }
  return null;
}

/** Arac girdisinden okunur kisa ozet: hangi dosya, hangi komut, hangi adres. */
export function girdiOzeti(arac, girdi = {}) {
  const g = girdi || {};
  const kisa = (m, n = 160) => { const t = String(m ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  if (g.file_path) return kisa(g.file_path);
  if (g.notebook_path) return kisa(g.notebook_path);
  if (arac === 'Bash' && g.command) return kisa(g.command);
  if (g.url) return kisa(g.url);
  if (g.query) return kisa(g.query);
  if (g.pattern) return kisa(g.pattern + (g.path ? '  @ ' + g.path : ''));
  if (g.description) return kisa(g.description);
  if (g.prompt) return kisa(g.prompt);
  return kisa(JSON.stringify(g), 120);
}

function sonucMetni(icerik) {
  if (typeof icerik === 'string') return icerik;
  if (Array.isArray(icerik)) {
    return icerik.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join(' ');
  }
  return icerik == null ? '' : JSON.stringify(icerik);
}

// Belirsizlik kaliplari (Turkce + Ingilizce). Kesin degil: isaretleme.
// "olabilir"/"might" yok: saha denemesinde risk tablosundaki "neden olabilir"
// satirini yakaladi - risk anlatimi belirsizlik degildir.
const BELIRSIZ = new RegExp([
  'emin de[gğ]il', 'muhtemelen', 'san[ıi]r[ıi]m', 'tahmin', 'g[öo]r[üu]n[üu]yor',
  'belirsiz', 'do[gğ]rulayamad', 'bulamad[ıi]m',
  'not sure', 'probably', 'unclear', 'i assume', 'assuming', 'could not verify', 'appears to',
].join('|'), 'i');

// Claude Code'un izin reddi arac sonucu metni. Sezgi: isletim sisteminin kendi
// "Permission denied" ciktisi da buna uyar (o komut aslinda calismistir).
const IZIN_REDDI = /permission|denied|not allowed|requires approval|izin/i;

function belirsizCumleler(metin) {
  const out = [];
  for (const c of String(metin).split(/(?<=[.!?])\s+|\n+/)) {
    const t = c.trim();
    if (t.startsWith('|')) continue; // markdown tablo satiri
    if (t.length > 8 && BELIRSIZ.test(t)) out.push(t.length > 200 ? t.slice(0, 199) + '…' : t);
  }
  return out;
}

// Koda gomulu sir kaliplari. Saha: Chatbot/backend/server.py icinde acik metin bir
// Hugging Face anahtari vardi; yol tabanli gizlilik yasagi bunu goremez. Tarama TESPIT
// eder (sir modele gitmistir), onlemez: amac hangi dosyanin yasaklanmasi gerektigini
// gostermek. Deger hicbir yerde tam haliyle saklanmaz.
export const SIR_KALIPLARI = [
  { tur: 'huggingface', re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { tur: 'openai-anthropic', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { tur: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { tur: 'aws', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { tur: 'slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { tur: 'google', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { tur: 'ozel-anahtar', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
];

const maskeDegeri = (d) => d.slice(0, 4) + '…(' + d.length + ')';

/** Metindeki sir benzeri degerler: [{ tur, maske }] (deger saklanmaz). */
export function sirBul(metin) {
  const out = [];
  for (const k of SIR_KALIPLARI) {
    for (const m of String(metin ?? '').matchAll(k.re)) out.push({ tur: k.tur, maske: maskeDegeri(m[0]) });
  }
  return out;
}

/** Metindeki sir benzeri degerleri maskeler. */
export function maskele(metin) {
  let t = String(metin ?? '');
  for (const k of SIR_KALIPLARI) t = t.replace(k.re, (d) => maskeDegeri(d));
  return t;
}

const OKUMA = new Set(['Read', 'NotebookRead']);
const YAZMA = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const WEB = new Set(['WebFetch', 'WebSearch']);
const ALT_AJAN = new Set(['Task', 'Agent']);

/**
 * Transkript satirlarindan kanit zinciri cikarir. Saf fonksiyon: dosya okumaz.
 * satirlar: JSONL'den ayristirilmis nesneler.
 */
export function zincirCikar(satirlar, { enFazlaAdim = 300 } = {}) {
  const adimlar = [];
  const bekleyen = new Map();       // tool_use_id -> { adim, ad, girdi }
  const belirsizlikler = [];
  const okunan = new Set(), yazilan = new Set(), komutlar = [], web = [], altAjanlar = [], reddedilen = [], sirlar = [];
  let toplamAdim = 0;

  for (const s of satirlar) {
    if (s?.type !== 'assistant' && s?.type !== 'user') continue;
    const icerik = Array.isArray(s.message?.content) ? s.message.content : [];
    const altAjanMi = !!s.isSidechain;

    for (const b of icerik) {
      if (s.type === 'assistant' && b?.type === 'tool_use') {
        toplamAdim++;
        const adim = {
          sira: toplamAdim,
          arac: b.name,
          girdi: girdiOzeti(b.name, b.input),
          zaman: s.timestamp ?? null,
          altAjan: altAjanMi,
          hata: false,
          reddedildi: false,
          sonuc: null,
        };
        if (adimlar.length < enFazlaAdim) adimlar.push(adim);
        bekleyen.set(b.id, { adim, ad: b.name, girdi: b.input || {} });
        if (ALT_AJAN.has(b.name)) altAjanlar.push(b.input?.description || b.input?.subagent_type || '');
      } else if (s.type === 'user' && b?.type === 'tool_result') {
        const k = bekleyen.get(b.tool_use_id);
        if (!k) continue;
        const m = sonucMetni(b.content).replace(/\s+/g, ' ').trim();
        for (const x of sirBul(m)) sirlar.push({ ...x, arac: k.ad, girdi: k.adim.girdi, altAjan: k.adim.altAjan });
        k.adim.hata = !!b.is_error;
        k.adim.reddedildi = !!b.is_error && IZIN_REDDI.test(m);
        const gorunur = maskele(m);
        k.adim.sonuc = gorunur.length > 200 ? gorunur.slice(0, 199) + '…' : gorunur;
        if (k.adim.reddedildi) reddedilen.push({ arac: k.ad, girdi: k.adim.girdi });

        const g = k.girdi;
        if (!b.is_error) {
          if (OKUMA.has(k.ad) && g.file_path) okunan.add(g.file_path);
          if (YAZMA.has(k.ad) && (g.file_path || g.notebook_path)) yazilan.add(g.file_path || g.notebook_path);
          if (WEB.has(k.ad)) web.push(g.url || g.query || '');
        }
        // Sifirdan farkli cikis kodu da hata sayilir ama komut calismis, ciktisi modele gitmistir.
        if (k.ad === 'Bash' && g.command && !k.adim.reddedildi) komutlar.push(String(g.command));
      } else if (s.type === 'assistant' && b?.type === 'text' && b.text) {
        for (const x of sirBul(b.text)) sirlar.push({ ...x, arac: 'yanit', girdi: 'ajanin metni', altAjan: altAjanMi });
        for (const c of belirsizCumleler(b.text)) {
          belirsizlikler.push({ oncekiAdim: toplamAdim, cumle: c, altAjan: altAjanMi });
        }
      }
    }
  }

  return {
    adimlar,
    kirpildi: toplamAdim > adimlar.length,
    sayac: {
      adim: toplamAdim,
      hata: adimlar.filter((a) => a.hata).length,
      reddedilen: reddedilen.length,
      sir: sirlar.length,
      okunanDosya: okunan.size,
      yazilanDosya: yazilan.size,
      komut: komutlar.length,
      web: web.length,
      altAjan: altAjanlar.length,
    },
    // Veri akisi: bu kosuda modele giden ve disari cikan ne varsa (sonuca gore).
    veriAkisi: {
      modeleGidenDosyalar: [...okunan],
      degistirilenDosyalar: [...yazilan],
      calistirilanKomutlar: komutlar,
      disariIstekler: web,
    },
    reddedilen,
    sirlar,
    altAjanlar,
    belirsizlikler,
  };
}

/** Oturum kimliginden tam kanit zinciri. Transkript yoksa null. */
export function kanitZinciri(sessionId, secenekler = {}) {
  const yol = transkriptBul(sessionId, secenekler);
  if (!yol) return null;
  const satirlar = [];
  for (const l of readFileSync(yol, 'utf8').split(NL)) {
    const t = l.trim();
    if (!t) continue;
    try { satirlar.push(JSON.parse(t)); } catch { /* yarim satir */ }
  }
  return { transkript: yol, ...zincirCikar(satirlar, secenekler) };
}

/** Insan okunur kisa kanit metni (karar kartinda, raporda). */
export function kanitMetni(z, { enFazla = 12 } = {}) {
  if (!z) return 'Kanit zinciri yok (transkript bulunamadi).';
  const s = [];
  s.push(z.sayac.adim + ' adim, ' + z.sayac.hata + ' hata (' + (z.sayac.reddedilen ?? 0) + ' izin reddi). Okunan dosya: '
    + z.sayac.okunanDosya + ', degistirilen: ' + z.sayac.yazilanDosya + ', komut: ' + z.sayac.komut + ', web: ' + z.sayac.web + '.');
  for (const a of z.adimlar.slice(0, enFazla)) {
    s.push(a.sira + '. ' + a.arac + (a.altAjan ? ' (alt-ajan)' : '') + ': ' + a.girdi
      + (a.reddedildi ? '  [REDDEDILDI]' : a.hata ? '  [HATA]' : ''));
  }
  if (z.adimlar.length > enFazla) s.push('... ' + (z.adimlar.length - enFazla) + ' adim daha');
  if (z.sirlar?.length) {
    s.push('UYARI: modele sir benzeri deger gitti: ' + z.sirlar.map((x) => x.tur + ' ' + x.maske + ' (' + x.arac + ': ' + x.girdi + ')').join(', '));
  }
  if (z.belirsizlikler.length) {
    s.push('Ajanin emin olmadigi yerler (sezgi):');
    for (const b of z.belirsizlikler.slice(0, 5)) s.push('- ' + b.cumle);
  }
  return s.join(NL);
}
