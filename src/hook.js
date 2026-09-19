// Claude Code hook'undan cagrilir. stdin'den JSON okur, olay satirini diske yazar.
// Kritik: ASLA hata firlatmaz ve stdout'a bir sey yazmaz - aksi halde izin
// istemini bloke edebilir. Her durumda 0 ile cikar.
import { appendFileSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { veriDizini, OLAY_DOSYASI } from './paths.js';

const OLAY = process.argv[2] || 'bilinmeyen';
const NL = String.fromCharCode(10);

// Dosya bu boyu gecerse son satirlar korunup gerisi atilir. Sinirsiz buyumesin.
const KIRPMA_ESIGI = 256 * 1024;
const SAKLANAN_SATIR = 500;

function kirp() {
  try {
    if (statSync(OLAY_DOSYASI).size <= KIRPMA_ESIGI) return;
    const satirlar = readFileSync(OLAY_DOSYASI, 'utf8').split(NL).filter((l) => l.trim());
    if (satirlar.length <= SAKLANAN_SATIR) return;
    writeFileSync(OLAY_DOSYASI, satirlar.slice(-SAKLANAN_SATIR).join(NL) + NL, 'utf8');
  } catch { /* kirpma basarisizsa dosya buyuk kalir, is yine yurur */ }
}

let ham = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { ham += d; });
process.stdin.on('end', () => {
  try {
    const j = ham.trim() ? JSON.parse(ham) : {};
    veriDizini();
    appendFileSync(OLAY_DOSYASI, JSON.stringify({
      t: Date.now(),
      olay: OLAY,
      session_id: j.session_id ?? null,
      cwd: j.cwd ?? null,
      tool: j.tool_name ?? null,
    }) + NL, 'utf8');
    kirp();
  } catch { /* sessizce yut */ }
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
