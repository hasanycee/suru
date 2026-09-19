import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { openDb } from '../src/db.js';
import { OLAY, oku as olayOku } from '../src/events.js';
import { isEkle, kosuAc, kosuGuncelle, kosuGetir, KOSU_DURUMU } from '../src/isler.js';
import { kosuBaslat } from '../src/kosucu.js';
import { Kuyruk } from '../src/kuyruk.js';
import { cliArgumanlari, devamArgumanlari, stdinMesaji } from '../src/yetki.js';
import { komutCalistir } from '../src/komut.js';
import { olayCumlesi } from '../src/anlati.js';

const TAKLIT = join(dirname(fileURLToPath(import.meta.url)), 'sahte', 'claude-taklit.mjs');

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-talimat-'));
  const db = openDb(join(dizin, 't.db'));
  return { db, dizin, temizle: () => { db.close(); try { rmSync(dizin, { recursive: true, force: true }); } catch { /* */ } } };
}
const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
async function kadar(kosul, { ms = 8000 } = {}) {
  const son = Date.now() + ms;
  while (Date.now() < son) { if (kosul()) return true; await bekle(25); }
  return false;
}

test('stdinIstem: istem metni komut satirinda YOK, stream-json girdi bayragi var; kapaliyken eski bicim', () => {
  const a = cliArgumanlari({ gorev: 'gizli gorev metni', profil: 'serbest', sessionId: 's', stdinIstem: true });
  assert.deepEqual(a.slice(0, 3), ['-p', '--input-format', 'stream-json']);
  assert.ok(!a.includes('gizli gorev metni'));
  const d = devamArgumanlari({ cevap: 'devam metni', profil: 'serbest', sessionId: 's', stdinIstem: true });
  assert.deepEqual(d.slice(0, 3), ['-p', '--input-format', 'stream-json']);
  assert.ok(d.includes('--resume') && !d.includes('devam metni'));
  assert.deepEqual(cliArgumanlari({ gorev: 'g', profil: 'serbest', sessionId: 's' }).slice(0, 2), ['-p', 'g']);
  const m = JSON.parse(stdinMesaji('merhaba "tirnak" ve\nsatir'));
  assert.equal(m.type, 'user');
  assert.equal(m.message.content[0].text, 'merhaba "tirnak" ve\nsatir');
  assert.ok(stdinMesaji('x').endsWith('\n') && stdinMesaji('a\nb').split('\n').length === 2, 'tek satir NDJSON');
});

test('kosucu: gorev stdin\'den gider; kosu surerken verilen ara talimat ayni kosuda islenir; result gelince stdin kapanir', async () => {
  const o = ortam();
  try {
    const argDosyasi = join(o.dizin, 'args.json');
    const is = isEkle(o.db, { ad: 'canli', gorev: 'ILK GOREV', cwd: o.dizin, profil: 'serbest' });
    const kosu = kosuAc(o.db, is.id);
    const kontrol = {};
    const p = kosuBaslat(o.db, {
      is, kosu, kontrol, canliTalimat: true, komut: process.execPath, zamanAsimiMs: 30_000,
      spawnFn: (k, a, opt) => spawn(k, [TAKLIT, ...a], { ...opt, shell: false }),
      env: { ...process.env, SAHTE_SENARYO: 'stdin-yanki', SAHTE_ARG_DOSYASI: argDosyasi }, hafizaAyari: { etkin: false },
    });
    // Ajan ilk mesaji (gorevi) stdin'den aldi
    assert.ok(await kadar(() => olayOku(o.db, { kind: OLAY.SOZ }).some((e) => e.data.metin === 'ALDIM#1: ILK GOREV')), 'gorev stdin\'den ulasmali');
    assert.equal(typeof kontrol.talimat, 'function');
    assert.throws(() => kontrol.talimat('   '), /bos/);
    assert.equal(kontrol.talimat('testleri de kos'), true);
    const r = await p;   // taklit stdin kapanana kadar yasar: bitmesi, kosucunun stdin'i kapattigini kanitlar
    assert.equal(r.durum, KOSU_DURUMU.BITTI);
    assert.equal(r.sonuc, 'ILK GOREV | testleri de kos', 'ara talimat AYNI kosunun sonucunda');
    assert.equal(kontrol.talimat, null, 'result\'tan sonra kol kapali');
    const args = JSON.parse(readFileSync(argDosyasi, 'utf8'));
    assert.ok(args.includes('--input-format') && !args.includes('ILK GOREV'));
    const t = olayOku(o.db, { kind: OLAY.IS }).find((e) => e.data.asama === 'talimat');
    assert.deepEqual([t.data.metin, t.data.canli, t.data.kosuId], ['testleri de kos', true, kosu.id]);
    assert.deepEqual(olayCumlesi(t), { ses: null, metin: 'SEN (canli): testleri de kos', ton: 'insan' });
  } finally { o.temizle(); }
});

test('kuyruk.talimat: calisan kosuya canli; bitmis ise ayni oturumdan devam kosusu; karar bekleyen ve hic kosmamis is reddedilir', async () => {
  const o = ortam();
  try {
    const kollar = new Map();
    // Sahte kosucu: talimat kolunu takar, disaridan bitirilene kadar "calisir".
    const kosucu = (db, { kosu, kontrol, devamCevabi }) => new Promise((coz) => {
      const gelen = [];
      kontrol.talimat = (m) => { gelen.push(m); return true; };
      kollar.set(kosu.id, { gelen, devamCevabi, bitir: () => { kosuGuncelle(db, kosu.id, { durum: KOSU_DURUMU.BITTI, bitti: Date.now() }); coz({ durum: KOSU_DURUMU.BITTI }); } });
    });
    const kuyruk = new Kuyruk(o.db, { esZamanli: 2, kosucu });
    const is = isEkle(o.db, { ad: 'Uzun is', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
    assert.throws(() => kuyruk.talimat(is.id, 'x'), /hic kosmamis/);
    assert.throws(() => kuyruk.talimat(is.id, '  '), /bos/);

    const k1 = kuyruk.siraya(is.id);
    assert.ok(await kadar(() => kollar.has(k1.id)));
    assert.deepEqual(kuyruk.talimat(is.id, 'once testleri kos'), { yol: 'canli', kosuId: k1.id });
    assert.deepEqual(kollar.get(k1.id).gelen, ['once testleri kos']);

    kollar.get(k1.id).bitir();
    await kuyruk.bekle();
    const r = kuyruk.talimat(is.id, 'simdi README yaz');
    assert.equal(r.yol, 'devam');
    const devam = kosuGetir(o.db, r.kosuId);
    assert.equal(devam.sessionId, k1.sessionId, 'ayni oturum: ajan onceki isini hatirlar');
    assert.equal(devam.devamCevabi, 'simdi README yaz');
    assert.ok(await kadar(() => kollar.has(r.kosuId)), 'devam kosusu kuyruktan basladi');
    assert.equal(kollar.get(r.kosuId).devamCevabi, 'simdi README yaz');
    assert.ok(olayOku(o.db, { kind: OLAY.IS }).some((e) => e.data.asama === 'talimat' && e.data.canli === false));
    kollar.get(r.kosuId).bitir();
    await kuyruk.bekle();

    // Karar bekleyen is
    const k3 = kosuAc(o.db, is.id);
    kosuGuncelle(o.db, k3.id, { durum: KOSU_DURUMU.KARAR_BEKLIYOR, basladi: Date.now() + 1000 });
    assert.throws(() => kuyruk.talimat(is.id, 'x'), /karar bekliyor.*\/cevap/);

    // Komut katmani: bosluklu is adi + cok kelimeli talimat
    kosuGuncelle(o.db, k3.id, { durum: KOSU_DURUMU.BITTI });
    const c = komutCalistir('/talimat uzun is bir de changelog ekle', { db: o.db, kuyruk });
    assert.match(c.metin, /devam kosusu acildi: Uzun is/);
    const sonKosu = o.db.prepare('SELECT devam_cevabi d FROM kosular WHERE is_id = ? ORDER BY rowid DESC LIMIT 1').get(is.id);
    assert.equal(sonKosu.d, 'bir de changelog ekle');
    assert.match(komutCalistir('/talimat uzun', { db: o.db, kuyruk }).metin, /kullanim/);
    // Kosu koduyla da is bulunur (/yeni ve kartlar kosu kodunu gosterir)
    assert.doesNotMatch(komutCalistir('/talimat ' + k1.id.slice(0, 6) + ' kosu koduyla', { db: o.db, kuyruk }).metin, /bulunamadi/);
    // /fork: isin son oturumundan dallanma komutu; hic kosmamis iste acik hata
    const f = komutCalistir('/fork ' + k1.id.slice(0, 6), { db: o.db, kuyruk }).metin;
    assert.ok(f.includes('claude --resume ' + kosuGetir(o.db, k3.id).sessionId + ' --fork-session') && f.includes('cd "' + o.dizin + '"'), f);
    const bos = isEkle(o.db, { ad: 'hic-kosmadi', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
    assert.match(komutCalistir('/fork hic-kosmadi', { db: o.db, kuyruk }).metin, /hic kosmamis/);
    assert.ok(bos.id);
    kuyruk.durdur();
    // Komutun actigi devam kosusu kolunu gec takabilir: calisan bitene kadar bitirmeyi surdur.
    assert.ok(await kadar(() => { for (const k of kollar.values()) k.bitir(); return kuyruk.calisan.size === 0; }), 'calisan kosu kalmamali');
  } finally { o.temizle(); }
});
