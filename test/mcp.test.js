import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { isEkle, kosuAc, kosuGetir, isGetir, KOSU_DURUMU } from '../src/isler.js';
import { kosuBaslat } from '../src/kosucu.js';
import { mcpPlani, tanimlariOku, sunucuListesi, mcpTalimati } from '../src/mcp.js';
import { mcpSizdiMi, cliArgumanlari, devamArgumanlari, ayarNesnesi, profilAl } from '../src/yetki.js';
import { VARSAYILAN } from '../src/config.js';

const TAKLIT = join(dirname(fileURLToPath(import.meta.url)), 'sahte', 'claude-taklit.mjs');
const TANIM = { 'unity-mcp': { command: 'relay.exe', args: ['--mcp'] }, 'baska': { command: 'x' } };

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-mcpsec-'));
  const db = openDb(join(dizin, 'k.db'));
  return { dizin, db, temizle: () => { db.close(); try { rmSync(dizin, { recursive: true, force: true }); } catch { /* */ } } };
}

test('is.mcp bos: plan strict, izin yok - mevcut davranis korunur', () => {
  const p = mcpPlani({ mcp: null }, VARSAYILAN.mcp, { tanimlar: TANIM });
  assert.deepEqual(p.args, ['--strict-mcp-config']);
  assert.deepEqual(p.izin, []);
  assert.deepEqual(p.onekler, []);
  assert.equal(mcpTalimati(p), null);
  // cliArgumanlari varsayilani da strict
  const a = cliArgumanlari({ gorev: 'g', profil: 'serbest', sessionId: 's' });
  assert.ok(a.includes('--strict-mcp-config'));
  assert.ok(!a.includes('--mcp-config'));
});

test('okur modu: yalniz katalogdaki okuyan araclar izinli, tehlikeliler deny, strict KALIR, tanim dosyaya kopyalanir', () => {
  const o = ortam();
  try {
    const is = { mcp: ['unity-mcp'], mcpMod: 'okur', cwd: o.dizin };
    const p = mcpPlani(is, VARSAYILAN.mcp, { tanimlar: TANIM, dizin: join(o.dizin, 'mcp') });
    assert.deepEqual(p.args.slice(0, 1), ['--mcp-config']);
    assert.ok(p.args.includes('--strict-mcp-config'), 'strict kalmali: secilmeyen sunucu yuklenmesin');
    const dosya = JSON.parse(readFileSync(p.args[1], 'utf8'));
    assert.deepEqual(Object.keys(dosya.mcpServers), ['unity-mcp'], 'yalniz secilen sunucu');
    assert.deepEqual(dosya.mcpServers['unity-mcp'], TANIM['unity-mcp']);
    assert.ok(p.izin.includes('mcp__unity-mcp__GetConsoleLogs'));
    assert.ok(!p.izin.includes('mcp__unity-mcp'), 'okur modda sunucu geneli izin YOK');
    assert.ok(p.yasak.includes('mcp__unity-mcp__Unity_RunCommand'));
    assert.deepEqual(p.onekler, ['mcp__unity-mcp__']);
    assert.match(mcpTalimati(p), /SALT-OKUR/);
    // Ayar nesnesine allow olarak girer; deny'a yasaklar
    const ayar = ayarNesnesi(profilAl('gozlemci'), { ekYasak: p.yasak, ekIzin: p.izin });
    assert.ok(ayar.permissions.allow.includes('mcp__unity-mcp__GetConsoleLogs'));
    assert.ok(ayar.permissions.deny.includes('mcp__unity-mcp__Unity_RunCommand'));
    // Devam kosusu da ayni argumanlari alir
    const d = devamArgumanlari({ cevap: 'c', profil: 'serbest', sessionId: 's', mcpArgs: p.args });
    assert.ok(d.includes('--mcp-config') && d.includes('--strict-mcp-config'));
  } finally { o.temizle(); }
});

test('tam mod: sunucu geneli izin; tanimsiz sunucu acik hata', () => {
  const o = ortam();
  try {
    const p = mcpPlani({ mcp: ['unity-mcp'], mcpMod: 'tam' }, VARSAYILAN.mcp, { tanimlar: TANIM, dizin: join(o.dizin, 'mcp') });
    assert.deepEqual(p.izin, ['mcp__unity-mcp']);
    assert.ok(p.yasak.includes('mcp__unity-mcp__Unity_RunCommand'), 'tam modda bile keyfi kod calistiran arac kapali');
    assert.match(mcpTalimati(p), /tam yetki/);
    assert.throws(() => mcpPlani({ mcp: ['yok-boyle'], mcpMod: 'okur' }, VARSAYILAN.mcp, { tanimlar: TANIM, dizin: join(o.dizin, 'mcp') }),
      /MCP sunucusu tanimli degil: yok-boyle/);
  } finally { o.temizle(); }
});

test('tanimlariOku: kullanici + proje duzeyi birlesir, proje ezer; sunucuListesi icerik sizdirmaz', () => {
  const o = ortam();
  try {
    const ev = join(o.dizin, 'ev'); mkdirSync(ev);
    const proje = join(o.dizin, 'proje'); mkdirSync(proje);
    writeFileSync(join(ev, '.claude.json'), JSON.stringify({ mcpServers: { a: { command: 'a1' } },
      projects: { [proje.replace(/\\/g, '/')]: { mcpServers: { b: { command: 'b1' } } } } }));
    writeFileSync(join(proje, '.mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'a2' } } }));
    const t = tanimlariOku(proje, { ev });
    assert.deepEqual(Object.keys(t).sort(), ['a', 'b']);
    assert.equal(t.a.command, 'a2', 'proje .mcp.json kullanici tanimini ezer');
    const l = sunucuListesi(VARSAYILAN.mcp, proje, { ev });
    assert.deepEqual(l, [{ ad: 'a', okurArac: 0 }, { ad: 'b', okurArac: 0 }]);
    assert.ok(!JSON.stringify(l).includes('a2'));
    // ev dosyasi yoksa bos
    assert.deepEqual(tanimlariOku(null, { ev: join(o.dizin, 'yok') }), {});
  } finally { o.temizle(); }
});

test('isEkle mcp alanini tasir: virgullu metin, varsayilan mod okur; /is kaydinda okunur', () => {
  const o = ortam();
  try {
    const is = isEkle(o.db, { ad: 'u', gorev: 'g', cwd: o.dizin, profil: 'gozlemci', mcp: 'unity-mcp, baska' });
    assert.deepEqual(isGetir(o.db, is.id).mcp, ['unity-mcp', 'baska']);
    assert.equal(isGetir(o.db, is.id).mcpMod, 'okur');
    const t = isEkle(o.db, { ad: 't', gorev: 'g', cwd: o.dizin, profil: 'gozlemci', mcp: ['unity-mcp'], mcpMod: 'tam' });
    assert.equal(isGetir(o.db, t.id).mcpMod, 'tam');
    const b = isEkle(o.db, { ad: 'b', gorev: 'g', cwd: o.dizin, profil: 'gozlemci' });
    assert.equal(isGetir(o.db, b.id).mcp, null);
    assert.equal(isGetir(o.db, b.id).mcpMod, null);
  } finally { o.temizle(); }
});

test('kanarya: secilen sunucunun araci beklenen, yabanci sunucu kesilir', () => {
  assert.deepEqual(mcpSizdiMi(['Read', 'mcp__unity-mcp__GetConsoleLogs'], ['mcp__unity-mcp__']), []);
  assert.deepEqual(mcpSizdiMi(['mcp__unity-mcp__X', 'mcp__claude_ai_Claude_Docs__guide'], ['mcp__unity-mcp__']),
    ['mcp__claude_ai_Claude_Docs__guide']);
});

async function taklitKosu(o, senaryo, isAlanlari) {
  const is = isEkle(o.db, { ad: 'k', gorev: 'g', cwd: o.dizin, profil: 'gozlemci', ...isAlanlari });
  const kosu = kosuAc(o.db, is.id);
  const ayarDosyasi = join(o.dizin, 'args.json');
  const r = await kosuBaslat(o.db, {
    is: isGetir(o.db, is.id), kosu, komut: process.execPath, zamanAsimiMs: 60_000,
    spawnFn: (k, a, opt) => spawn(k, [TAKLIT, ...a], { ...opt, shell: false }),
    env: { ...process.env, SAHTE_SENARYO: senaryo, SAHTE_ARG_DOSYASI: ayarDosyasi }, hafizaAyari: { etkin: false },
    mcpAyari: VARSAYILAN.mcp,
  });
  return { r, kosu: kosuGetir(o.db, kosu.id), args: JSON.parse(readFileSync(ayarDosyasi, 'utf8')) };
}

test('taklit mcp-secili: secilen sunucunun araclari listede -> kosu GECER, --mcp-config verilmis, strict kalmis', async () => {
  const o = ortam();
  try {
    // Tanim: gecici ev dosyasi yerine dogrudan sunucu tanimi olan bir .mcp.json projede
    writeFileSync(join(o.dizin, '.mcp.json'), JSON.stringify({ mcpServers: { 'unity-mcp': { command: 'relay' } } }));
    const { r, kosu, args } = await taklitKosu(o, 'mcp-secili', { mcp: ['unity-mcp'] });
    assert.equal(r.durum, KOSU_DURUMU.BITTI, kosu.hata ?? '');
    assert.ok(args.includes('--mcp-config'), 'mcp-config verilmeli');
    assert.ok(args.includes('--strict-mcp-config'), 'strict kalmali');
    const ayar = JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
    assert.ok(ayar.permissions.allow.includes('mcp__unity-mcp__GetConsoleLogs'));
    assert.ok(ayar.permissions.deny.includes('mcp__unity-mcp__Unity_RunCommand'));
    const istem = args[args.indexOf('--append-system-prompt') + 1];
    assert.match(istem, /SALT-OKUR/);
  } finally { o.temizle(); }
});

test('taklit mcp-secili-yabanci: yabanci sunucu da yuklenmisse kosu kesilir; MCP tanimi yoksa kosu baslamadan HATA', async () => {
  const o = ortam();
  try {
    writeFileSync(join(o.dizin, '.mcp.json'), JSON.stringify({ mcpServers: { 'unity-mcp': { command: 'relay' } } }));
    const bas = Date.now();
    const { r, kosu } = await taklitKosu(o, 'mcp-secili-yabanci', { mcp: ['unity-mcp'] });
    assert.ok(Date.now() - bas < 15_000);
    assert.equal(r.durum, KOSU_DURUMU.HATA);
    assert.equal(kosu.terminalNeden, 'mcp-sizdi');
    assert.match(kosu.hata, /1 secilmemis MCP araci/);

    const yok = await taklitKosu(o, 'basarili', { mcp: ['olmayan-sunucu'] });
    assert.equal(yok.r.durum, KOSU_DURUMU.HATA);
    assert.match(yok.kosu.hata, /MCP kurulamadi: MCP sunucusu tanimli degil: olmayan-sunucu/);
  } finally { o.temizle(); }
});
