// Gercek claude'un yerine gecen taklit: --output-format stream-json ciktisinin
// dogrulanmis seklini uretir. Senaryo SAHTE_SENARYO ortam degiskeninden gelir.
const senaryo = process.env.SAHTE_SENARYO || 'basarili';
const args = process.argv.slice(2);
const sid = args[args.indexOf('--session-id') + 1] || 'yok';
const NL = String.fromCharCode(10);
const yaz = (o) => process.stdout.write(JSON.stringify(o) + NL);

// Argumanlari dogrulayabilmek icin diske dokelim.
if (process.env.SAHTE_ARG_DOSYASI) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.SAHTE_ARG_DOSYASI, JSON.stringify(args), 'utf8');
}
// Surecin gordugu ortami dogrulamak icin (sadece ilgili anahtarlar).
if (process.env.SAHTE_ENV_DOSYASI) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.SAHTE_ENV_DOSYASI, JSON.stringify({
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? null,
  }), 'utf8');
}

yaz({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd(),
      // ayar-yuklenmedi: gecersiz ayar dosyasi sessizce yok sayilmis gibi - kanarya
      // araci (butun olarak yasaklanmis olmasi gereken) listede gorunur.
      // mcp-sizdi: --strict-mcp-config islememis gibi - kullanicinin MCP araclari listede.
      tools: senaryo === 'ayar-yuklenmedi' ? ['Read', 'Bash', 'RemoteTrigger']
        : senaryo === 'mcp-sizdi' ? ['Read', 'Bash', 'mcp__unity-mcp__Unity_RunCommand', 'mcp__claude_ai_Claude_Docs__guide']
        // mcp-secili: is basina secilen sunucunun araclari yuklenmis (beklenen, gecer).
        // mcp-secili-yabanci: secilen sunucunun yaninda yabanci bir sunucu da yuklenmis (kesilir).
        : senaryo === 'mcp-secili' ? ['Read', 'Bash', 'mcp__unity-mcp__GetConsoleLogs', 'mcp__unity-mcp__Unity_RunCommand']
        : senaryo === 'mcp-secili-yabanci' ? ['Read', 'Bash', 'mcp__unity-mcp__GetConsoleLogs', 'mcp__claude_ai_Claude_Docs__guide']
        : ['Read', 'Bash'],
      model: 'claude-opus-5', permissionMode: 'acceptEdits' });

// stream-json GIRDI modu (ara talimat testi): ilk stdin mesaji gorev, ikincisi ara talimat.
// Gercek CLI gibi: ikinci mesaji ayni kosunun icinde isler, tek result verir ve stdin
// kapanana kadar YASAR (kapatmak kosucunun isi).
if (senaryo === 'stdin-yanki') {
  const gelen = [];
  let tampon = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    tampon += d;
    const s = tampon.split(NL); tampon = s.pop();
    for (const l of s) {
      if (!l.trim()) continue;
      const m = JSON.parse(l);
      gelen.push(m.message.content[0].text);
      yaz({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { id: 'm' + gelen.length,
        model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text', text: 'ALDIM#' + gelen.length + ': ' + gelen.at(-1) }],
        usage: { input_tokens: 10, output_tokens: 5 } } });
      if (gelen.length === 2) {
        yaz({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, session_id: sid,
          total_cost_usd: 0.01, permission_denials: [], terminal_reason: 'end_turn', result: gelen.join(' | ') });
      }
    }
  });
  await new Promise((r) => process.stdin.on('end', r));
  process.exit(0);
}

// Kanarya testinde taklit kendiliginden bitmez: kesen Suru olmali.
if (senaryo === 'ayar-yuklenmedi' || senaryo === 'mcp-sizdi' || senaryo === 'mcp-secili-yabanci') {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

// Uzun suren ve torun surec baslatan kosu (ajanin Bash ile test sunucusu acmasi gibi).
// Durdurma testi torunun da oldugunu dogrular.
if (senaryo === 'yavas') {
  const { spawn } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  // detached: Node/libuv, Windows'ta kendi baslattigi cocuklari "ebeveyn olunce
  // olsun" is nesnesine koyar. Taklit Node oldugu icin bu, torunu bedavaya
  // olduruyordu ve duz kill() testi de geciyordu. Gercek claude.exe Node degil;
  // ona guvenemeyiz. detached torun bu korumanin disinda kalir = gercekci durum.
  // Sonuc kaydi gelmeden durdurulacak: maliyet bu usage'dan tahmin edilmeli.
  // Ayni mesaj iki kez gelir (akista oldugu gibi): cift sayilmamali.
  for (let i = 0; i < 2; i++) {
    yaz({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { id: 'msg_yavas', model: 'claude-sonnet-5',
      role: 'assistant', content: [{ type: 'text', text: 'uzun is basliyor' }], usage: { input_tokens: 2000, output_tokens: 500 } } });
  }
  const torun = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: true });
  torun.unref();
  if (process.env.SAHTE_TORUN_DOSYASI) writeFileSync(process.env.SAHTE_TORUN_DOSYASI, String(torun.pid), 'utf8');
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

// Ajan calisma klasorunde dosya yazar ve siler (golge checkpoint testi icin).
if (senaryo === 'yazar') {
  const { writeFileSync, rmSync } = await import('node:fs');
  writeFileSync('ajan-yazdi.txt', 'ajan' + NL, 'utf8');
  writeFileSync('mevcut.txt', 'ajan degistirdi' + NL, 'utf8');
  rmSync('silinecek.txt', { force: true });
}

if (senaryo === 'cokme') { process.stderr.write('taklit cokuyor' + NL); process.exit(3); }

yaz({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: {
  model: 'claude-opus-5', role: 'assistant', content: [
    { type: 'text', text: 'basliyorum' },
    { type: 'tool_use', id: 't1', name: 'Read', input: {} },
  ], usage: { input_tokens: 100, output_tokens: 20 } } });

yaz({ type: 'user', session_id: sid, message: { role: 'user', content: [
  { type: 'tool_result', tool_use_id: 't1', is_error: senaryo === 'arac-hatasi' } ] } });

// Ikinci arac cagrisi bir alt-ajandan geliyor
yaz({ type: 'assistant', session_id: sid, parent_tool_use_id: 't1', message: {
  model: 'claude-opus-5', role: 'assistant',
  content: [{ type: 'tool_use', id: 't2', name: 'Grep', input: {} }],
  usage: { input_tokens: 50, output_tokens: 10 } } });

if (senaryo === 'api-hatasi') {
  yaz({ type: 'assistant', session_id: sid, error: 'authentication_failed',
        is_api_error_message: true, message: { model: '<synthetic>', role: 'assistant',
        content: [{ type: 'text', text: 'Failed to authenticate' }], usage: {} } });
}

const redler = senaryo === 'izin-reddi'
  ? [{ tool_name: 'Bash', tool_input: { command: 'git push' } }]
  : [];

yaz({ type: 'result', subtype: 'success', is_error: senaryo === 'basarisiz' || senaryo === 'api-hatasi',
  duration_ms: 1234, duration_api_ms: 1000, num_turns: 3, session_id: sid,
  total_cost_usd: 0.0425, permission_denials: redler,
  terminal_reason: senaryo === 'api-hatasi' ? 'api_error' : 'end_turn',
  result: senaryo === 'basarisiz' ? 'is yarim kaldi' : 'is bitti',
  usage: { input_tokens: 150, output_tokens: 30 } });
