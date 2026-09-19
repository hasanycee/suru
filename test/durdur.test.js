import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { openDb } from '../src/db.js';
import { OLAY, oku as olayOku } from '../src/events.js';
import { isEkle, kosuAc, kosuGetir, KOSU_DURUMU } from '../src/isler.js';
import { kosuBaslat } from '../src/kosucu.js';
import { Kuyruk } from '../src/kuyruk.js';
import { agaciOldur, ayrikGrup } from '../src/surec.js';

const KOK = dirname(fileURLToPath(import.meta.url));
const TAKLIT = join(KOK, 'sahte', 'claude-taklit.mjs');
const uyu = (ms) => new Promise((r) => setTimeout(r, ms));

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-durdur-'));
  const db = openDb(join(dizin, 'd.db'));
  return { db, dizin, temizle: () => {
    db.close();
    try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra silinir */ }
  } };
}

function yasiyor(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function bekleKosul(f, ms = 8000) {
  const bas = Date.now();
  while (Date.now() - bas < ms) { if (f()) return true; await uyu(50); }
  return false;
}

test('calisan kosu durdurulur: kayit iptal, torun surec de olur, dogrulama kosmaz', async () => {
  const o = ortam();
  const torunDosyasi = join(o.dizin, 'torun.pid');
  // Dogrulama komutu kosarsa bu dosyayi olusturur - kosmamali.
  const isaret = join(o.dizin, 'dogrulama-kostu');
  const is = isEkle(o.db, { ad: 'uzun', gorev: 'g', cwd: o.dizin, profil: 'serbest',
    dogrulama: 'node -e "require(\'fs\').writeFileSync(\'dogrulama-kostu\',\'1\')"' });
  const kosu = kosuAc(o.db, is.id);
  const kontrol = {};
  const bitis = kosuBaslat(o.db, {
    is, kosu, kontrol, komut: process.execPath,
    spawnFn: (k, a, opt) => spawn(k, [TAKLIT, ...a], { ...opt, shell: false }),
    env: { ...process.env, SAHTE_SENARYO: 'yavas', SAHTE_TORUN_DOSYASI: torunDosyasi },
    hafizaAyari: { etkin: false },
  });

  assert.equal(typeof kontrol.durdur, 'function', 'kosucu durdurma kolunu takar');
  assert.ok(await bekleKosul(() => existsSync(torunDosyasi)), 'taklit torun baslatmali');
  const torunPid = Number(readFileSync(torunDosyasi, 'utf8'));
  assert.ok(yasiyor(torunPid));

  assert.equal(kontrol.durdur('test'), true);
  assert.equal(kontrol.durdur('test'), false, 'ikinci durdurma etkisiz');
  const r = await bitis;

  assert.equal(r.durum, KOSU_DURUMU.IPTAL);
  // Regresyon (sinav): durdurulan kosu $0 gorunuyordu.
  assert.equal(r.usdTahmini, true, 'sonuc kaydi gelmeyen kosunun maliyeti tahmin edilir');
  const { costOf } = await import('../src/pricing.js');
  const tek = costOf('claude-sonnet-5', { input_tokens: 2000, output_tokens: 500 }).usd;
  assert.ok(tek > 0, 'fiyat tablosunda model olmali');
  assert.ok(Math.abs(r.usd - tek) < 1e-9, 'ayni mesaj kimligi cift sayilmaz');
  const kayit = kosuGetir(o.db, kosu.id);
  assert.equal(kayit.durum, KOSU_DURUMU.IPTAL);
  assert.equal(kayit.hata, 'durduruldu: test');
  assert.equal(kayit.terminalNeden, 'durduruldu');
  assert.equal(r.dogrulama, null, 'durdurulan kosuda dogrulama kosmaz');
  assert.ok(!existsSync(isaret));
  assert.ok(olayOku(o.db, { kind: OLAY.IS }).some((e) => e.data.asama === 'durduruluyor'));

  assert.ok(await bekleKosul(() => !yasiyor(torunPid)), 'torun surec sahipsiz kalmamali');
  o.temizle();
});

test('kuyruk: bekleyen kosu baslamadan iptal edilir ve bir daha baslamaz', async () => {
  const o = ortam();
  let baslayan = 0;
  const k = new Kuyruk(o.db, { esZamanli: 0, kosucu: () => { baslayan++; return new Promise(() => {}); } });
  const is = isEkle(o.db, { ad: 'a', gorev: 'g', cwd: o.dizin, profil: 'gozlemci' });
  const kosu = k.siraya(is.id);

  assert.deepEqual(k.kosuDurdur(kosu.id), { kosuId: kosu.id, durum: KOSU_DURUMU.IPTAL });
  assert.equal(kosuGetir(o.db, kosu.id).durum, KOSU_DURUMU.IPTAL);
  k.sinirAyarla(2);
  await uyu(10);
  assert.equal(baslayan, 0);
  assert.throws(() => k.kosuDurdur(kosu.id), /calismiyor/);
  assert.throws(() => k.kosuDurdur('yok'), /bulunamadi/);
  o.temizle();
});

test('kuyruk: calisan kosunun durdurma kolu cagrilir, yer bosalir', async () => {
  const o = ortam();
  const nedenler = [];
  const kosucu = (db, { kosu, kontrol }) => new Promise((coz) => {
    kontrol.durdur = (neden) => {
      nedenler.push(neden);
      db.prepare('UPDATE kosular SET durum = ? WHERE id = ?').run(KOSU_DURUMU.IPTAL, kosu.id);
      coz({ durum: KOSU_DURUMU.IPTAL });
      return true;
    };
  });
  const k = new Kuyruk(o.db, { esZamanli: 1, kosucu });
  const is = isEkle(o.db, { ad: 'a', gorev: 'g', cwd: o.dizin, profil: 'gozlemci' });
  const kosu = k.siraya(is.id);
  await uyu(10);

  assert.equal(k.kosuDurdur(kosu.id, 'panel').durum, 'durduruluyor');
  await k.bekle();
  assert.deepEqual(nedenler, ['panel']);
  assert.equal(k.durum().calisan, 0);
  assert.equal(k.kontroller.size, 0, 'kol birakilir');
  o.temizle();
});

test('agaciOldur: Windows yolu taskkill /T /F kullanir', async () => {
  const cagri = [];
  const sahteSpawn = (k, a) => { cagri.push([k, a]); const e = new EventEmitter(); setImmediate(() => e.emit('close', 0)); return e; };
  const cocuk = { pid: 123, exitCode: null, signalCode: null, kill() {} };
  assert.equal(await agaciOldur(cocuk, { platform: 'win32', spawnFn: sahteSpawn }), true);
  assert.deepEqual(cagri, [['taskkill', ['/pid', '123', '/T', '/F']]]);
});

test('agaciOldur: POSIX yolu gruba once SIGTERM sonra SIGKILL gonderir', async () => {
  const gercek = process.kill;
  const sinyaller = [];
  process.kill = (pid, sinyal) => { sinyaller.push([pid, sinyal]); return true; };
  try {
    await agaciOldur({ pid: 456, exitCode: null, signalCode: null, kill() {} }, { platform: 'linux', beklemeMs: 5 });
    await uyu(40);
  } finally { process.kill = gercek; }
  assert.deepEqual(sinyaller, [[-456, 'SIGTERM'], [-456, 'SIGKILL']]);
  assert.equal(ayrikGrup('linux'), true);
  assert.equal(ayrikGrup('win32'), false);
});

test('agaciOldur: bitmis surece dokunmaz', async () => {
  let dokundu = false;
  const s = () => { dokundu = true; };
  assert.equal(await agaciOldur({ pid: 1, exitCode: 0, signalCode: null }, { platform: 'win32', spawnFn: s }), false);
  assert.equal(await agaciOldur(null), false);
  assert.equal(dokundu, false);
});
