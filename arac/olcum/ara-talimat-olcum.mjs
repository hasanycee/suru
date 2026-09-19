// Olcum: -p --input-format stream-json ile KOSU SURERKEN ikinci kullanici mesaji gonderilebiliyor mu?
// Gozlenecek: ikinci mesaj ne zaman islendi (ilk result'tan once mi, sonra mi), surec ne zaman bitiyor.
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const CLAUDE = join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const CWD = join(process.env.LOCALAPPDATA, 'suru', 'deneme', 'ogrenme');
const env = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--permission-mode', 'dontAsk', '--restricted', '--tools', 'Read,Glob,Grep', '--strict-mcp-config',
  '--model', 'haiku', '--max-budget-usd', '0.30'];
const mesaj = (metin) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: metin }] } }) + '\n';

const t0 = Date.now(); const sn = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const p = spawn(CLAUDE, args, { cwd: CWD, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let buf = '', arac = 0, ikinciGitti = false, sonucSayisi = 0, err = '';
p.stdin.write(mesaj('Assets/_Project/Scripts/Core/Meta klasorundeki .cs dosyalarindan UC tanesini SIRAYLA (tek tek, her seferinde bir Read) oku ve her birini tek cumleyle ozetle. Kod degistirme.'));
const isle = (l) => {
  let k; try { k = JSON.parse(l); } catch { return; }
  if (k.type === 'system' && k.subtype === 'init') console.log(sn(), 'init oturum=' + k.session_id.slice(0, 8), 'arac=' + k.tools.length);
  if (k.type === 'assistant') for (const b of k.message?.content ?? []) {
    if (b.type === 'tool_use') { arac++; console.log(sn(), 'ARAC', b.name, JSON.stringify(b.input).slice(0, 80));
      if (arac === 1 && !ikinciGitti) { ikinciGitti = true;
        p.stdin.write(mesaj('ARA TALIMAT: ozetlerin en sonuna ayri bir satirda tam olarak su metni yaz: ARA-TALIMAT-ALINDI'));
        console.log(sn(), '>>> ikinci mesaj stdin\'e yazildi (kosu surerken)'); } }
    if (b.type === 'text') console.log(sn(), 'SOZ', b.text.replace(/\s+/g, ' ').slice(0, 160));
  }
  if (k.type === 'result') { sonucSayisi++;
    console.log(sn(), 'RESULT #' + sonucSayisi, 'tur=' + k.num_turns, 'usd=' + k.total_cost_usd, 'isaret=' + /ARA-TALIMAT-ALINDI/.test(k.result ?? ''));
    if (sonucSayisi >= 2 || /ARA-TALIMAT-ALINDI/.test(k.result ?? '')) { console.log(sn(), 'stdin kapatiliyor'); p.stdin.end(); } }
};
p.stdout.setEncoding('utf8');
p.stdout.on('data', (d) => { buf += d; const s = buf.split('\n'); buf = s.pop(); s.forEach(isle); });
p.stderr.on('data', (d) => err += d);
const bekci = setTimeout(() => { console.log(sn(), 'ZAMAN ASIMI - stdin kapatiliyor'); p.stdin.end(); setTimeout(() => p.kill(), 5000); }, 150_000);
p.on('close', (kod) => { clearTimeout(bekci); console.log(sn(), 'KAPANDI kod=' + kod, 'arac=' + arac, 'result=' + sonucSayisi, err.slice(-300)); });
