// MCP sizintisi olcumu: ayni istem, ayni profil bayraklari; tek fark --strict-mcp-config.
// init kaydindan arac listesi + mcp_servers, ilk mesajdan girdi token'i okunur.
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const CLAUDE = join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const CWD = join(process.env.LOCALAPPDATA, 'suru', 'deneme', 'ogrenme');
const env = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };

function kos(etiket, ek) {
  const args = ['-p', 'Sadece "tamam" yaz, hicbir arac cagirma.', '--output-format', 'stream-json', '--verbose',
    '--model', 'haiku', '--max-budget-usd', '0.05', ...ek];
  return new Promise((res) => {
    const p = spawn(CLAUDE, args, { cwd: CWD, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let buf = '', init = null, usage = null, result = null, err = '';
    const isle = (l) => { let k; try { k = JSON.parse(l); } catch { return; }
      if (k.type === 'system' && k.subtype === 'init') init = k;
      if (k.type === 'assistant' && k.message?.usage && !usage) usage = k.message.usage;
      if (k.type === 'result') result = k; };
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => { buf += d; const s = buf.split('\n'); buf = s.pop(); s.forEach(isle); });
    p.stderr.on('data', (d) => err += d);
    p.on('close', () => {
      if (buf.trim()) isle(buf);
      const araclar = init?.tools ?? [];
      const mcp = araclar.filter((t) => t.startsWith('mcp__'));
      const girdi = usage ? (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) : null;
      console.log('== ' + etiket);
      console.log('  arac sayisi:', araclar.length, '| mcp araci:', mcp.length, '| mcp_servers:', JSON.stringify((init?.mcp_servers ?? []).map((s) => s.name + ':' + s.status)));
      console.log('  mcp sunuculari (adlardan):', [...new Set(mcp.map((t) => t.split('__')[1]))].join(', ') || '-');
      console.log('  ilk istek girdi token:', girdi, '| usd:', result?.total_cost_usd, '| hata:', result?.is_error, err.slice(-200));
      res({ etiket, araclar: araclar.length, mcp: mcp.length, girdi });
    });
  });
}

const a = await kos('varsayilan (Suru bugun boyle kosuyor)', []);
const b = await kos('--strict-mcp-config', ['--strict-mcp-config']);
const c = await kos('gozlemci bayraklari: --restricted --tools Read,Glob,Grep', ['--restricted', '--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep']);
const d = await kos('gozlemci + --strict-mcp-config', ['--restricted', '--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep', '--strict-mcp-config']);
console.log('\nFARK (token): varsayilan-strict =', a.girdi - b.girdi, '| gozlemci-strict =', c.girdi - d.girdi);
