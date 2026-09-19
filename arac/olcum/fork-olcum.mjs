// Fork olcumu: temel (kesif) oturumu + --fork-session ile acilan is, sifirdan acilan ise gore
// token/maliyet/sure kazandiriyor mu? Haiku, salt-okunur, kosu basina $0.25 butce.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const CLAUDE = join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const CWD = join(process.env.LOCALAPPDATA, 'suru', 'deneme', 'ogrenme');
const OUT = join(process.cwd(), 'fork-olcum-sonuc.json');
const env = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };

const KESIF = 'Bu Unity projesinin mimarisini ogren: ana sistemler, onemli scriptler (Assets/_Project ve TerrorByte Games altina bak), '
  + 'oyuncu/dusman/oyun durumu akisi, test duzeni. Sonunda 15-20 satirlik bir mimari ozet ver. Kod degistirme.';
const GOREV = 'Oyuncu oldugunde tam olarak ne oluyor? Olumu tetikleyen siniftan baslayip UI/kamera/oyun durumu tepkilerine kadar '
  + 'akisi dosya yolu ve satir numarasiyla acikla. Sonra bu akista olasi bir hata ya da eksik varsa tek cumleyle soyle. Kod degistirme.';

function kos(etiket, prompt, { resume = null, fork = false } = {}) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'dontAsk', '--restricted', '--tools', 'Read,Glob,Grep',
    '--model', 'haiku', '--max-budget-usd', '0.25'];
  if (resume) args.push('--resume', resume);
  if (fork) args.push('--fork-session');
  const t0 = Date.now();
  return new Promise((res) => {
    const p = spawn(CLAUDE, args, { cwd: CWD, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let buf = '', err = '';
    const usage = new Map(); let sessionId = null, result = null, araclar = 0;
    const isle = (line) => {
      let k; try { k = JSON.parse(line); } catch { return; }
      if (k.type === 'system' && k.subtype === 'init') sessionId = k.session_id;
      if (k.type === 'assistant' && k.message) {
        if (k.message.usage) usage.set(k.message.id ?? '#' + usage.size, k.message.usage);
        for (const b of k.message.content || []) if (b.type === 'tool_use') araclar++;
      }
      if (k.type === 'result') result = k;
    };
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => { buf += d; const s = buf.split('\n'); buf = s.pop(); s.forEach(isle); });
    p.stderr.setEncoding('utf8'); p.stderr.on('data', (d) => err += d);
    p.on('close', (kod) => {
      if (buf.trim()) isle(buf);
      const t = { girdi: 0, onbellekOkuma: 0, onbellekYazma: 0, cikti: 0 };
      for (const u of usage.values()) {
        t.girdi += u.input_tokens || 0; t.onbellekOkuma += u.cache_read_input_tokens || 0;
        t.onbellekYazma += u.cache_creation_input_tokens || 0; t.cikti += u.output_tokens || 0;
      }
      res({ etiket, kod, sessionId, sureSn: Math.round((Date.now() - t0) / 1000), araclar, mesaj: usage.size,
        usd: result?.total_cost_usd ?? null, tur: result?.num_turns ?? null, hata: result?.is_error ?? null,
        ...t, toplamGirdi: t.girdi + t.onbellekOkuma + t.onbellekYazma,
        cevap: (result?.result ?? '').slice(0, 1500), stderr: err.slice(-400) });
    });
  });
}

const sonuc = [];
const kaydet = () => writeFileSync(OUT, JSON.stringify(sonuc, null, 2));
const temel = await kos('kesif', KESIF); sonuc.push(temel); kaydet();
console.log('kesif', temel.sessionId, temel.usd, temel.sureSn + 's', temel.toplamGirdi);
if (!temel.sessionId) process.exit(1);
for (const i of [1, 2]) {
  const s = await kos('sifirdan-' + i, GOREV); sonuc.push(s); kaydet();
  console.log(s.etiket, s.usd, s.sureSn + 's', s.toplamGirdi, 'arac=' + s.araclar);
  const f = await kos('fork-' + i, GOREV, { resume: temel.sessionId, fork: true }); sonuc.push(f); kaydet();
  console.log(f.etiket, f.usd, f.sureSn + 's', f.toplamGirdi, 'arac=' + f.araclar, 'oturum=' + f.sessionId);
}
console.log('BITTI');
