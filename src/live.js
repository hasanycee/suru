import { watch } from 'node:fs';
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { listTranscripts } from './indexer.js';
import { PROJECTS_DIR } from './paths.js';
import { oturumDurumu, olaylariYukle, DURUM } from './state.js';

const SAAT = 3600_000;
const PENCERE = Number(process.env.KULE_PENCERE_SAAT ?? 24) * SAAT;
const YENILE_MS = 2000;

const R = '\x1b[0m', B = '\x1b[1m', DIM = '\x1b[2m';
const renk = { kirmizi: '\x1b[31m', yesil: '\x1b[32m', sari: '\x1b[33m', mavi: '\x1b[36m', gri: '\x1b[90m', mor: '\x1b[35m' };

const ROZET = {
  [DURUM.ONAY]:      { et: 'ONAY BEKLIYOR', c: renk.sari,    on: 0 },
  [DURUM.SENI]:      { et: 'SENI BEKLIYOR', c: renk.yesil,   on: 1 },
  [DURUM.TAKILDI]:   { et: 'TAKILDI',       c: renk.kirmizi, on: 2 },
  [DURUM.LIMIT]:     { et: 'LIMIT DOLDU',   c: renk.mor,     on: 3 },
  [DURUM.CALISIYOR]: { et: 'calisiyor',     c: renk.mavi,    on: 4 },
  [DURUM.BOSTA]:     { et: 'bosta',         c: renk.gri,     on: 5 },
};
// Bilinmeyen durum gelirse panel cokmesin.
const rozetAl = (d) => ROZET[d] ?? { et: d || '?', c: renk.gri, on: 9 };

const sure = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const d = Math.round(s / 60);
  if (d < 60) return d + 'dk';
  const h = Math.floor(d / 60);
  return h + 's' + (d % 60 ? ' ' + (d % 60) + 'dk' : '');
};
const SEP_RE = new RegExp('[' + String.fromCharCode(92,92) + '/]');
const proje = (cwd) => (cwd || '').split(SEP_RE).filter(Boolean).slice(-1)[0] || '?';

const durumlar = new Map(); // file -> son durum
let olaylar = new Map();   // hook olaylari
const oncekiRozet = new Map();

async function tazele(file) {
  // olaylar cagiran tarafindan tazelenir
  try {
    const st = statSync(file);
    if (Date.now() - st.mtimeMs > PENCERE) { durumlar.delete(file); return; }
    const d = await oturumDurumu(file, { olaylar });
    if (d) durumlar.set(file, { ...d, file, id: basename(file, '.jsonl') });
  } catch { durumlar.delete(file); }
}

function ciz() {
  const liste = [...durumlar.values()].sort((a, b) => {
    const f = rozetAl(a.durum).on - rozetAl(b.durum).on;
    return f !== 0 ? f : b.sonZaman - a.sonZaman;
  });

  const bekleyen = liste.filter((s) => s.durum === DURUM.ONAY || s.durum === DURUM.SENI).length;
  process.stdout.write('\x1b[H\x1b[2J');
  console.log(`${B}KULE${R}  ${liste.length} oturum (son ${PENCERE / SAAT}s)  ` +
    (bekleyen ? `${renk.sari}${B}${bekleyen} tanesi seni bekliyor${R}` : `${DIM}bekleyen yok${R}`) +
    `  ${DIM}${new Date().toLocaleTimeString('tr-TR')}${R}`);
  console.log(DIM + '-'.repeat(96) + R);

  if (!liste.length) { console.log(DIM + '  son 24 saatte hicbir oturum yok.' + R); return; }

  for (const s of liste) {
    const rz = rozetAl(s.durum);
    const dal = s.dal ? `${DIM}(${s.dal})${R}` : '';
    console.log(
      `${rz.c}${B}${rz.et.padEnd(14)}${R}` +
      `${proje(s.cwd).slice(0, 22).padEnd(23)}` +
      `${DIM}${sure(s.yas).padStart(7)}${R}  ` +
      `${(s.baslik || s.id.slice(0, 8)).slice(0, 30)} ${dal}`
    );
    const ipucu = s.durum === DURUM.LIMIT
      ? `${rz.c}kullanim limiti doldu${s.sifirlanma ? ' - sifirlanma: ' + s.sifirlanma : ''}${R}`
      : s.durum === DURUM.ONAY || s.durum === DURUM.TAKILDI
      ? `${rz.c}bekleyen arac: ${s.bekleyenArac}${R}${s.kesin ? '' : DIM + ' (cikarim)' + R}`
      : s.sonMetin ? `${DIM}${s.sonMetin.slice(0, 84)}${R}` : '';
    if (ipucu) console.log('              ' + ipucu);
    if (s.kuyrukta > 0) console.log(`              ${DIM}kuyrukta ${s.kuyrukta} mesajin var${R}`);
  }

  console.log(DIM + '-'.repeat(96) + R);
  console.log(DIM + '  (cikarim) etiketi yoksa izin istemi hooktan dogrulanmistir. Cikis: Ctrl+C' + R);
}

// Bekleyen duruma yeni gecen oturum icin terminal zili
function bildir() {
  for (const s of durumlar.values()) {
    const onceki = oncekiRozet.get(s.file);
    if (onceki !== s.durum && (s.durum === DURUM.ONAY || s.durum === DURUM.SENI)) {
      process.stdout.write('\x07');
    }
    oncekiRozet.set(s.file, s.durum);
  }
}

olaylar = olaylariYukle();
const hepsi = listTranscripts();
await Promise.all(hepsi.map(({ file }) => tazele(file)));
ciz();

let kirli = new Set();
let zaman = null;
watch(PROJECTS_DIR, { recursive: true }, (_olay, ad) => {
  if (!ad || !ad.endsWith('.jsonl')) return;
  kirli.add(ad);
  if (zaman) return;
  zaman = setTimeout(async () => {
    zaman = null;
    const yollar = listTranscripts().filter(({ file }) =>
      [...kirli].some((k) => basename(file) === basename(k)));
    kirli.clear();
    olaylar = olaylariYukle();
    await Promise.all(yollar.map(({ file }) => tazele(file)));
    bildir();
    ciz();
  }, 400);
});

setInterval(async () => {
  olaylar = olaylariYukle();
  await Promise.all([...durumlar.keys()].map(tazele));
  bildir();
  ciz();
}, YENILE_MS);
