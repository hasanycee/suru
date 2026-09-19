import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { openDb } from '../src/db.js';
import { OLAY, oku as olayOku } from '../src/events.js';
import { isEkle, kosuAc, kosuGetir, KOSU_DURUMU } from '../src/isler.js';
import { SatirCozucu, kayitEsle, sonucDurumu, kosuBaslat, komutCoz, enCokKullanilanModel } from '../src/kosucu.js';

const KOK = dirname(fileURLToPath(import.meta.url));
const TAKLIT = join(KOK, 'sahte', 'claude-taklit.mjs');

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-kosucu-'));
  const db = openDb(join(dizin, 'k.db'));
  return { db, dizin, temizle: () => {
    db.close();
    try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra silinir */ }
  } };
}

/** Taklit claude'u node ile calistiran spawn: gercek CLI cagrilmaz, para gitmez. */
function taklitle(db, dizin, senaryo, ekOrtam = {}) {
  const is = isEkle(db, { ad: 'deneme', gorev: 'bir sey yap', cwd: dizin, profil: 'serbest' });
  const kosu = kosuAc(db, is.id);
  return { is, kosu, calistir: () => kosuBaslat(db, {
    is, kosu,
    komut: process.execPath,
    spawnFn: (komut, args, opt) => spawn(komut, [TAKLIT, ...args], { ...opt, shell: false }),
    env: { ...process.env, SAHTE_SENARYO: senaryo, ...ekOrtam },
  }) };
}

// --- SatirCozucu ---

test('yarim satir tamponda bekler, tamamlaninca cozulur', () => {
  const c = new SatirCozucu();
  assert.deepEqual(c.ekle('{"type":"a"}\n{"type":'), [{ type: 'a' }]);
  assert.deepEqual(c.ekle('"b"}\n'), [{ type: 'b' }]);
  assert.deepEqual(c.ekle(''), []);
});

test('JSON olmayan gurultu atlanir, akis kirilmaz', () => {
  const c = new SatirCozucu();
  const r = c.ekle('uyari: bir sey\n{"type":"a"}\n');
  assert.deepEqual(r, [{ type: 'a' }]);
});

test('bitir tamponda kalan tam kaydi verir', () => {
  const c = new SatirCozucu();
  c.ekle('{"type":"son"}');
  assert.deepEqual(c.bitir(), [{ type: 'son' }]);
  assert.deepEqual(c.bitir(), [], 'tampon temizlenmis olmali');
});

// --- kayitEsle ---

const baglam = { kosuId: 'k1', isId: 'i1', sessionId: 's1', project: 'demo' };

test('arac cagrisi sayilir ve alt-ajan isaretlenir', () => {
  const a = kayitEsle({ type: 'assistant', parent_tool_use_id: null, message: {
    content: [{ type: 'tool_use', name: 'Read' }] } }, baglam);
  assert.equal(a.sayac.aracSayisi, 1);
  assert.equal(a.olaylar[0].kind, OLAY.ARAC);
  assert.equal(a.olaylar[0].data.altAjan, false);

  const b = kayitEsle({ type: 'assistant', parent_tool_use_id: 't1', message: {
    content: [{ type: 'tool_use', name: 'Grep' }] } }, baglam);
  assert.equal(b.olaylar[0].data.altAjan, true);
});

test('api hatasi assistant kiligindaysa yine hata olayi uretir', () => {
  const r = kayitEsle({ type: 'assistant', is_api_error_message: true, error: 'authentication_failed',
    message: { content: [{ type: 'text', text: 'Failed to authenticate' }] } }, baglam);
  const h = r.olaylar.find((o) => o.kind === OLAY.HATA);
  assert.ok(h, 'hata olayi bekleniyor');
  assert.equal(h.data.kod, 'authentication_failed');
});

test('result kaydindan maliyet, tur ve izin reddi cikarilir', () => {
  const r = kayitEsle({ type: 'result', is_error: false, total_cost_usd: 0.25, num_turns: 4,
    terminal_reason: 'end_turn', result: 'bitti',
    permission_denials: [{ tool_name: 'Bash' }, { tool_name: 'Write' }] }, baglam);
  assert.equal(r.sayac.usd, 0.25);
  assert.equal(r.sayac.turSayisi, 4);
  assert.equal(r.sayac.redSayisi, 2);
  assert.equal(r.sayac.hataliMi, false);
  assert.equal(r.olaylar.filter((o) => o.kind === OLAY.IZIN).length, 2);
  assert.ok(r.olaylar.some((o) => o.kind === OLAY.IS && o.data.asama === 'bitti'));
});

// --- sonucDurumu: yetki profilinin eskalasyon sozlesmesi ---

test('gozlemci hicbir sey sormaz, hata bile karara donmez', () => {
  assert.equal(sonucDurumu({ hataliMi: false, eskalasyon: 'yok' }), KOSU_DURUMU.BITTI);
  assert.equal(sonucDurumu({ hataliMi: true, eskalasyon: 'yok' }), KOSU_DURUMU.HATA);
});

test('serbest sadece hatada sorar, izin reddi tek basina karar dogurmaz', () => {
  assert.equal(sonucDurumu({ hataliMi: false, redSayisi: 2, eskalasyon: 'hata' }), KOSU_DURUMU.BITTI);
  assert.equal(sonucDurumu({ hataliMi: true, eskalasyon: 'hata' }), KOSU_DURUMU.KARAR_BEKLIYOR);
});

test('denetimli sinira dayaninca sorar', () => {
  assert.equal(sonucDurumu({ hataliMi: false, redSayisi: 1, eskalasyon: 'sinir' }), KOSU_DURUMU.KARAR_BEKLIYOR);
  assert.equal(sonucDurumu({ hataliMi: false, redSayisi: 0, eskalasyon: 'sinir' }), KOSU_DURUMU.BITTI);
});

test('danisan basarili olsa bile karara duser', () => {
  assert.equal(sonucDurumu({ hataliMi: false, redSayisi: 0, eskalasyon: 'her-karar' }), KOSU_DURUMU.KARAR_BEKLIYOR);
});

// --- Uctan uca: taklit claude ile ---

test('basarili kosu: sayaclar, maliyet ve olaylar kaydedilir', async () => {
  const o = ortam();
  const { is, kosu, calistir } = taklitle(o.db, o.dizin, 'basarili');
  const r = await calistir();

  assert.equal(r.durum, KOSU_DURUMU.BITTI);
  assert.equal(r.cikisKodu, 0);
  assert.equal(r.usd, 0.0425, 'maliyet CLI result kaydindan geliyor');
  assert.equal(r.turSayisi, 3);
  assert.equal(r.aracSayisi, 2, 'ana ajan + alt-ajan arac cagrisi');

  const kayit = kosuGetir(o.db, kosu.id);
  assert.equal(kayit.durum, KOSU_DURUMU.BITTI);
  assert.equal(kayit.usd, 0.0425);
  assert.equal(kayit.sonuc, 'is bitti');
  assert.equal(kayit.hata, null);

  // Akista is yasam dongusu var mi
  const isOlaylari = olayOku(o.db, { kind: OLAY.IS }).map((x) => x.data.asama);
  assert.deepEqual(isOlaylari, ['kuyruktan-alindi', 'basladi', 'bitti']);
  // Olaylar kosuya baglanmis olmali
  assert.ok(olayOku(o.db, { kind: OLAY.ARAC }).every((x) => x.data.kosuId === kosu.id));
  assert.equal(olayOku(o.db, { kind: OLAY.IS })[0].sessionId, kosu.sessionId, 'is oturum kimligine bagli');
  assert.equal(is.profil, 'serbest');
  o.temizle();
});

test('izin reddi denetimli profilde karara duser ve akisa yazilir', async () => {
  const o = ortam();
  const is = isEkle(o.db, { ad: 'd', gorev: 'g', cwd: o.dizin, profil: 'denetimli' });
  const kosu = kosuAc(o.db, is.id);
  const r = await kosuBaslat(o.db, {
    is, kosu, komut: process.execPath,
    spawnFn: (k, a, opt) => spawn(k, [TAKLIT, ...a], { ...opt, shell: false }),
    env: { ...process.env, SAHTE_SENARYO: 'izin-reddi' },
  });

  assert.equal(r.redSayisi, 1);
  assert.equal(r.durum, KOSU_DURUMU.KARAR_BEKLIYOR, 'denetimli profil sinira dayaninca sorar');
  const izin = olayOku(o.db, { kind: OLAY.IZIN });
  assert.equal(izin.length, 1);
  assert.equal(izin[0].data.arac, 'Bash');
  assert.equal(izin[0].data.reddedildi, true);
  o.temizle();
});

test('surec cokerse hata yakalanir ve stderr saklanir', async () => {
  const o = ortam();
  const { kosu, calistir } = taklitle(o.db, o.dizin, 'cokme');
  const r = await calistir();
  assert.equal(r.cikisKodu, 3);
  const kayit = kosuGetir(o.db, kosu.id);
  assert.equal(kayit.durum, KOSU_DURUMU.KARAR_BEKLIYOR, 'serbest profil hatada sorar');
  assert.match(kayit.hata, /taklit cokuyor/);
  o.temizle();
});

test('api hatasi basarisiz sayilir', async () => {
  const o = ortam();
  const { calistir } = taklitle(o.db, o.dizin, 'api-hatasi');
  const r = await calistir();
  assert.equal(r.hataliMi, true);
  assert.equal(r.terminalNeden, 'api_error');
  assert.ok(olayOku(o.db, { kind: OLAY.HATA }).some((h) => h.data.nerede === 'api'));
  o.temizle();
});

test('komut satiri profilin sinirlarini gercekten tasiyor', async () => {
  const o = ortam();
  const argDosyasi = join(o.dizin, 'args.json');
  const is = isEkle(o.db, { ad: 'g', gorev: 'oku bakalim', cwd: o.dizin,
    profil: 'gozlemci', model: 'haiku', butceUsd: 0.5 });
  const kosu = kosuAc(o.db, is.id);
  await kosuBaslat(o.db, {
    is, kosu, komut: process.execPath,
    spawnFn: (k, a, opt) => spawn(k, [TAKLIT, ...a], { ...opt, shell: false }),
    env: { ...process.env, SAHTE_SENARYO: 'basarili', SAHTE_ARG_DOSYASI: argDosyasi },
  });

  const args = JSON.parse(readFileSync(argDosyasi, 'utf8'));
  assert.ok(args.includes('-p'));
  assert.deepEqual(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2),
    ['--output-format', 'stream-json']);
  assert.equal(args[args.indexOf('--session-id') + 1], kosu.sessionId,
    'kosu kaydi ile transkript ayni oturum kimligini paylasmali');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--model') + 1], 'haiku');
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '0.5');
  // Gozlemci arac kumesi daraltilmis olmali ve yazma araci icermemeli
  const araclar = args[args.indexOf('--tools') + 1].split(',');
  assert.ok(araclar.includes('Read'));
  assert.ok(!araclar.includes('Write') && !araclar.includes('Bash'));
  // Yasaklar --settings ile gitmeli ve satir ici JSON DEGIL dosya yolu olmali:
  // kabuktan gecen satir ici JSON Windows'ta parcalaniyordu.
  const ayarArg = args[args.indexOf('--settings') + 1];
  assert.ok(!ayarArg.trim().startsWith('{'), 'ayarlar satir ici JSON olarak gecmemeli');
  const ayarlar = JSON.parse(readFileSync(ayarArg, 'utf8'));
  assert.ok(ayarlar.permissions.deny.includes('Bash'));
  assert.ok(ayarlar.permissions.deny.some((d) => d.startsWith('Read(./.env')), 'sirlar her profilde yasak');
  o.temizle();
});

test('komut cozumu kabugu devre disi birakir', () => {
  const r = komutCoz('claude');
  if (process.platform === 'win32') {
    // Regresyon: kabuk kullanildiginda argumanlar kacirilmadan birlestiriliyor
    // ve gorev metnindeki tirnaklar komutu bozuyor.
    assert.equal(r.shell, false, 'claude.exe dogrudan bulunmali, kabuk gerekmemeli');
    assert.match(r.komut, /claude\.exe$/);
  } else {
    assert.equal(r.shell, false);
  }
  // Kendi programimiz verilirse oldugu gibi kalir
  assert.deepEqual(komutCoz(process.execPath), { komut: process.execPath, shell: false });
});

test('tirnak ve ozel karakter iceren gorev komutu bozmaz', async () => {
  const o = ortam();
  const argDosyasi = join(o.dizin, 'zor-args.json');
  const T = String.fromCharCode(34), TT = String.fromCharCode(39);
  const zorGorev = "Sunu yap: " + T + "tirnakli" + T + " & <isaretli> | borulu %yuzde% ^sapka^ " + TT + "tek tirnak" + TT;
  const is = isEkle(o.db, { ad: 'zor', gorev: zorGorev, cwd: o.dizin, profil: 'gozlemci' });
  const kosu = kosuAc(o.db, is.id);
  await kosuBaslat(o.db, {
    is, kosu, komut: process.execPath,
    spawnFn: (k, a, opt) => spawn(k, [TAKLIT, ...a], { ...opt, shell: false }),
    env: { ...process.env, SAHTE_SENARYO: 'basarili', SAHTE_ARG_DOSYASI: argDosyasi },
  });
  const args = JSON.parse(readFileSync(argDosyasi, 'utf8'));
  assert.equal(args[args.indexOf('-p') + 1], zorGorev, 'gorev metni bozulmadan gecmeli');
  o.temizle();
});

// --- Otomatik hafiza ---

async function ortamiDok(o, hafizaAyari) {
  const envDosyasi = join(o.dizin, 'env-' + Math.random().toString(36).slice(2) + '.json');
  const is = isEkle(o.db, { ad: 'oh-' + Math.random(), gorev: 'g', cwd: o.dizin, profil: 'serbest' });
  const kosu = kosuAc(o.db, is.id);
  await kosuBaslat(o.db, {
    is, kosu, komut: process.execPath, hafizaAyari,
    spawnFn: (k, a, opt) => spawn(k, [TAKLIT, ...a], { ...opt, shell: false }),
    env: { ...process.env, SAHTE_SENARYO: 'basarili', SAHTE_ENV_DOSYASI: envDosyasi },
  });
  return JSON.parse(readFileSync(envDosyasi, 'utf8'));
}

test('ajan kosusunda Claude otomatik hafizasi varsayilan olarak kapali', async () => {
  // Acik kalsa ajan dogrulanmamis notlarini MEMORY.md'ye kendi yazar ve her
  // sonraki kosuya sizar; kendi deposu olmayan proje ust deponun hafizasini yukler.
  const o = ortam();
  const e = await ortamiDok(o, { etkin: true });
  assert.equal(e.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  const e2 = await ortamiDok(o, { etkin: false });
  assert.equal(e2.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1', 'Suru hafizasi kapaliyken de Claude hafizasi kapali kalir');
  o.temizle();
});

test('ayarla acikca izin verilirse otomatik hafiza acik kalir', async () => {
  const o = ortam();
  const oncekiDeger = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  try {
    const e = await ortamiDok(o, { etkin: true, claudeOtomatikHafiza: true });
    assert.equal(e.CLAUDE_CODE_DISABLE_AUTO_MEMORY, null);
  } finally {
    if (oncekiDeger !== undefined) process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = oncekiDeger;
  }
  o.temizle();
});

// --- Gozlenen model ---

test('gozlenen model: cikti agirligi en yuksek olan (yedek modele dusen kosu)', () => {
  const k = new Map([
    ['m1', { model: 'claude-haiku', usage: { output_tokens: 20 } }],
    ['m2', { model: 'claude-sonnet', usage: { output_tokens: 300 } }],
    ['m3', { model: 'claude-sonnet', usage: { output_tokens: 100 } }],
  ]);
  assert.equal(enCokKullanilanModel(k), 'claude-sonnet');
});

test('usage hic gelmediyse model null - varsayim yazilmaz', () => {
  assert.equal(enCokKullanilanModel(new Map()), null);
  assert.equal(enCokKullanilanModel(undefined), null);
  // Modeli bildirilmeyen mesaj sayilmaz.
  assert.equal(enCokKullanilanModel(new Map([['m', { model: null, usage: { output_tokens: 9 } }]])), null);
});
