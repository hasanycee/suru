import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { OLAY, yaz as olayYaz } from '../src/events.js';
import { isEkle, KOSU_DURUMU } from '../src/isler.js';
import { VARSAYILAN } from '../src/config.js';
import { ozet, metinRapor, geceAraligi, sure } from '../src/gece-raporu.js';

const SIMDI = Date.parse('2026-03-10T08:00:00');

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-rapor-'));
  const db = openDb(join(dizin, 'r.db'));
  return { db, dizin, temizle: () => {
    db.close();
    try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra */ }
  } };
}

let n = 0;
function kosu(db, isId, { durum, usd = 0.1, bittiOnceDk = 60, sonuc = null, hata = null }) {
  const bitti = SIMDI - bittiOnceDk * 60_000;
  db.prepare(`INSERT INTO kosular (id, is_id, session_id, durum, basladi, bitti, usd, sonuc, hata)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('k' + (++n), isId, 's' + n, durum, bitti - 30_000, bitti, usd, sonuc, hata);
}

test('sure insan olcusune cevrilir', () => {
  assert.equal(sure(90_000), '2dk');
  assert.equal(sure(3 * 3600_000 + 20 * 60_000), '3sa 20dk');
  assert.equal(sure(null), '-');
});

test('gece araligi aksam 20:00 den baslar', () => {
  const { baslangic, bitis } = geceAraligi(SIMDI);
  assert.equal(bitis, SIMDI);
  const b = new Date(baslangic);
  assert.equal(b.getHours(), 20);
  assert.ok(baslangic < SIMDI, 'sabah bakiyorsan kasit DUN aksam');
  assert.equal(new Date(SIMDI).getDate() - b.getDate(), 1);
});

test('hicbir sey olmadiginda rapor sessiz kalmaz', () => {
  const o = ortam();
  const r = ozet(o.db, VARSAYILAN, { baslangic: SIMDI - 12 * 3600_000, bitis: SIMDI });
  assert.equal(r.kosu, 0);
  const m = metinRapor(r);
  assert.match(m, /hic kosu yok/, '"hicbir sey olmadi" da bir cevaptir');
  assert.match(m, /kota:/, 'kota satiri her zaman gorunur');
  o.temizle();
});

test('kosular sayilir, ayrilir ve toplanir', () => {
  const o = ortam();
  const is = isEkle(o.db, { ad: 'gece-testleri', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
  kosu(o.db, is.id, { durum: KOSU_DURUMU.BITTI, usd: 0.2, sonuc: 'butun testler gecti' });
  kosu(o.db, is.id, { durum: KOSU_DURUMU.HATA, usd: 0.1, hata: 'npm test patladi' });
  kosu(o.db, is.id, { durum: KOSU_DURUMU.KARAR_BEKLIYOR, usd: 0.3 });

  const r = ozet(o.db, VARSAYILAN, { baslangic: SIMDI - 12 * 3600_000, bitis: SIMDI });
  assert.equal(r.kosu, 3);
  assert.equal(r.bitti, 1);
  assert.equal(r.hatali, 1);
  assert.equal(r.kararda, 1);
  assert.ok(Math.abs(r.toplamUsd - 0.6) < 1e-9);

  const m = metinRapor(r);
  assert.match(m, /3 kosu/);
  assert.match(m, /butun testler gecti/, 'ajanin kendi cumlesi raporda gorunur');
  assert.match(m, /npm test patladi/);
  o.temizle();
});

test('aralik disindaki kosular rapora girmez', () => {
  const o = ortam();
  const is = isEkle(o.db, { ad: 'x', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
  kosu(o.db, is.id, { durum: KOSU_DURUMU.BITTI, bittiOnceDk: 30 });
  kosu(o.db, is.id, { durum: KOSU_DURUMU.BITTI, bittiOnceDk: 60 * 30 });  // 30 saat once
  const r = ozet(o.db, VARSAYILAN, { baslangic: SIMDI - 12 * 3600_000, bitis: SIMDI });
  assert.equal(r.kosu, 1);
  o.temizle();
});

test('ayni is hep ayni ajan adiyla raporlanir', () => {
  const o = ortam();
  const is = isEkle(o.db, { ad: 'tekrar', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
  kosu(o.db, is.id, { durum: KOSU_DURUMU.BITTI, bittiOnceDk: 100 });
  kosu(o.db, is.id, { durum: KOSU_DURUMU.BITTI, bittiOnceDk: 50 });
  const r = ozet(o.db, VARSAYILAN, { baslangic: SIMDI - 12 * 3600_000, bitis: SIMDI });
  assert.equal(r.satirlar[0].ajan.ad, r.satirlar[1].ajan.ad,
    'oturumlar farkli ama is ayni: ajan da ayni gorunmeli');
  o.temizle();
});

test('arac dagilimi akistan cikarilir', () => {
  const o = ortam();
  const is = isEkle(o.db, { ad: 'x', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
  kosu(o.db, is.id, { durum: KOSU_DURUMU.BITTI });
  const t = SIMDI - 30 * 60_000;
  olayYaz(o.db, { kind: OLAY.ARAC, at: t, data: { arac: 'Read' } });
  olayYaz(o.db, { kind: OLAY.ARAC, at: t, data: { arac: 'Read' } });
  olayYaz(o.db, { kind: OLAY.ARAC, at: t, data: { arac: 'Bash' } });

  const r = ozet(o.db, VARSAYILAN, { baslangic: SIMDI - 12 * 3600_000, bitis: SIMDI });
  assert.deepEqual(r.araclar[0], { arac: 'Read', adet: 2 });
  assert.match(metinRapor(r), /Read x2/);
  o.temizle();
});

test('bekleyen karar varsa rapor bunu one cikarir', () => {
  const o = ortam();
  const is = isEkle(o.db, { ad: 'x', gorev: 'g', cwd: o.dizin, profil: 'denetimli' });
  kosu(o.db, is.id, { durum: KOSU_DURUMU.KARAR_BEKLIYOR });
  o.db.prepare(`INSERT INTO kararlar (id, kosu_id, is_id, session_id, tur, soru, olusturuldu, durum)
                VALUES (?,?,?,?,?,?,?,?)`)
    .run('kr1', 'k' + n, is.id, 's' + n, 'izin', 'devam etsin mi?', SIMDI, 'bekliyor');

  const r = ozet(o.db, VARSAYILAN, { baslangic: SIMDI - 12 * 3600_000, bitis: SIMDI });
  assert.equal(r.bekleyenKarar, 1);
  assert.match(metinRapor(r), /1 karar seni bekliyor/);
  o.temizle();
});

test('gunleri asan aralikta baslikta tarih gorunur', () => {
  const o = ortam();
  // Regresyon: 24 saatlik aralik ayni saate denk gelince baslik
  // "20:27 -> 20:27" gorunuyor, rapor tek anlik saniliyordu.
  const r = ozet(o.db, VARSAYILAN, { baslangic: SIMDI - 24 * 3600_000, bitis: SIMDI });
  const m = metinRapor(r).split(String.fromCharCode(10))[0];
  assert.match(m, /\d{2}\.\d{2} \d{2}:\d{2} -> \d{2}\.\d{2} \d{2}:\d{2}/);

  // Ayni gun icindeyse tarih gereksiz gurultu
  const kisa = ozet(o.db, VARSAYILAN, { baslangic: SIMDI - 3600_000, bitis: SIMDI });
  assert.match(metinRapor(kisa).split(String.fromCharCode(10))[0], /^SURU RAPORU  \d{2}:\d{2} -> \d{2}:\d{2}$/);
  o.temizle();
});
