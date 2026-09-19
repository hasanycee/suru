import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { OLAY, yaz as olayYaz } from '../src/events.js';
import { VARSAYILAN } from '../src/config.js';
import {
  tuketim, limitDurumu, sinirOner, tahminiDolus, degerlendir, tavanOner, BES_SAAT, HAFTA,
} from '../src/kota.js';

const SAAT = 3600_000;
const SIMDI = Date.parse('2026-03-10T12:00:00Z');

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-kota-'));
  const db = openDb(join(dizin, 'k.db'));
  return { db, dizin, temizle: () => {
    db.close();
    try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra silinir */ }
  } };
}

/** Bitmis bir Suru kosusu birakir. */
function kosu(db, { usd, bittiOnceSaat }) {
  db.prepare(`INSERT INTO kosular (id, is_id, session_id, durum, basladi, bitti, usd)
              VALUES (?,?,?,?,?,?,?)`)
    .run('k' + Math.random(), 'i1', 's1', 'bitti',
      SIMDI - bittiOnceSaat * SAAT - 1000, SIMDI - bittiOnceSaat * SAAT, usd);
}

/** Kullanicinin kendi actigi bir oturum birakir. */
function oturum(db, { usd, bittiOnceSaat }) {
  db.prepare(`INSERT INTO sessions (session_id, project, ended_at, usd)
              VALUES (?,?,?,?)`)
    .run('o' + Math.random(), 'p', SIMDI - bittiOnceSaat * SAAT, usd);
}

function ayar(kota = {}) {
  const a = structuredClone(VARSAYILAN);
  Object.assign(a.kota, kota);
  return a;
}

// --- Tuketim ---

test('pencere disindaki tuketim sayilmaz', () => {
  const o = ortam();
  kosu(o.db, { usd: 5, bittiOnceSaat: 1 });    // pencere icinde
  kosu(o.db, { usd: 99, bittiOnceSaat: 9 });   // 5 saatlik pencerenin disinda
  const t = tuketim(o.db, { pencereMs: BES_SAAT, simdi: SIMDI });
  assert.equal(t.usd, 5);
  assert.equal(t.kosu, 1);
  o.temizle();
});

test('kendi oturumlarin da ayni kotayi yer', () => {
  const o = ortam();
  kosu(o.db, { usd: 3, bittiOnceSaat: 1 });
  oturum(o.db, { usd: 7, bittiOnceSaat: 2 });
  const t = tuketim(o.db, { pencereMs: BES_SAAT, simdi: SIMDI });
  assert.equal(t.usd, 10, 'Suru kosulari + elle acilan oturumlar toplanir');
  assert.equal(t.kosu, 1);
  assert.equal(t.oturum, 1);
  o.temizle();
});

test('haftalik pencere 5 saatlikten genis', () => {
  const o = ortam();
  kosu(o.db, { usd: 20, bittiOnceSaat: 30 });
  assert.equal(tuketim(o.db, { pencereMs: BES_SAAT, simdi: SIMDI }).usd, 0);
  assert.equal(tuketim(o.db, { pencereMs: HAFTA, simdi: SIMDI }).usd, 20);
  o.temizle();
});

// --- Sinir kademeleri ---

test('doluluk arttikca sinir kademeli duser, aniden sifirlanmaz', () => {
  const s = (oran) => sinirOner(oran, { taban: 6, enAz: 1 });
  assert.equal(s(0.10), 6);
  assert.equal(s(0.60), 3);
  assert.equal(s(0.80), 2);
  assert.equal(s(0.95), 1);
  assert.equal(s(1.00), 0, 'tavan asilinca durur');
  assert.equal(s(1.50), 0);
});

test('enAz siniri korunur', () => {
  assert.equal(sinirOner(0.95, { taban: 2, enAz: 2 }), 2);
  assert.equal(sinirOner(0.8, { taban: 2, enAz: 2 }), 2);
});

// --- Tahmini dolus ---

test('tahmini dolus mevcut hizdan hesaplanir', () => {
  // 5 saatte 10$ harcanmis, tavan 20$ -> kalan 10$ icin 5 saat daha
  const ms = tahminiDolus({ usd: 10, tavan: 20, pencereMs: BES_SAAT, gecenMs: BES_SAAT });
  assert.equal(ms, BES_SAAT);
  // Tavan zaten asilmissa sifir
  assert.equal(tahminiDolus({ usd: 30, tavan: 20, pencereMs: BES_SAAT, gecenMs: BES_SAAT }), 0);
  // Hic harcama yoksa tahmin yok
  assert.equal(tahminiDolus({ usd: 0, tavan: 20, pencereMs: BES_SAAT, gecenMs: BES_SAAT }), null);
});

// --- Gercek limit tespiti ---

test('limit-doldu olayi sert fren uretir', () => {
  const o = ortam();
  olayYaz(o.db, { kind: OLAY.DURUM, sessionId: 'a', at: SIMDI - 10 * 60_000,
    data: { durum: 'limit-doldu', sifirlanma: '14:00' } });
  const l = limitDurumu(o.db, { simdi: SIMDI });
  assert.equal(l.doldu, true);
  assert.equal(l.sifirlanma, '14:00');
  o.temizle();
});

test('ayni oturum sonradan calismaya donduyse limit kalkar', () => {
  const o = ortam();
  olayYaz(o.db, { kind: OLAY.DURUM, sessionId: 'a', at: SIMDI - 60 * 60_000,
    data: { durum: 'limit-doldu' } });
  olayYaz(o.db, { kind: OLAY.DURUM, sessionId: 'a', at: SIMDI - 5 * 60_000,
    data: { durum: 'calisiyor' } });
  assert.equal(limitDurumu(o.db, { simdi: SIMDI }).doldu, false);
  o.temizle();
});

test('cok eski limit kaydi bugunu baglamaz', () => {
  const o = ortam();
  olayYaz(o.db, { kind: OLAY.DURUM, sessionId: 'a', at: SIMDI - 20 * SAAT,
    data: { durum: 'limit-doldu' } });
  assert.equal(limitDurumu(o.db, { simdi: SIMDI }).doldu, false);
  o.temizle();
});

// --- Tam degerlendirme ---

test('pencereler rahatken taban sinir verilir', () => {
  const o = ortam();
  kosu(o.db, { usd: 1, bittiOnceSaat: 1 });
  const d = degerlendir(o.db, ayar({ besSaatlikUsd: 40, haftalikUsd: 500, tabanSinir: 3 }), { simdi: SIMDI });
  assert.equal(d.sinir, 3);
  assert.equal(d.kisitli, false);
  assert.match(d.gerekce, /rahat/);
  o.temizle();
});

test('5 saatlik pencere dolarken sinir kisilir ve gerekce soylenir', () => {
  const o = ortam();
  kosu(o.db, { usd: 32, bittiOnceSaat: 1 });  // 40'in %80'i
  const d = degerlendir(o.db, ayar({ besSaatlikUsd: 40, haftalikUsd: 5000, tabanSinir: 6 }), { simdi: SIMDI });
  assert.equal(d.sinir, 2);
  assert.equal(d.kisitli, true);
  assert.match(d.gerekce, /5 saatlik pencere %80 dolu/);
  o.temizle();
});

test('en dar pencere baglayicidir', () => {
  const o = ortam();
  // 5 saatlik rahat ama haftalik dolmus
  kosu(o.db, { usd: 2, bittiOnceSaat: 1 });
  kosu(o.db, { usd: 480, bittiOnceSaat: 40 });
  const d = degerlendir(o.db, ayar({ besSaatlikUsd: 40, haftalikUsd: 500, tabanSinir: 6 }), { simdi: SIMDI });
  assert.ok(d.sinir < 6);
  assert.match(d.gerekce, /haftalik/);
  o.temizle();
});

test('gercek limit dolmasi her seyi ezer', () => {
  const o = ortam();
  // Tuketim sifir ama limit kaydi var: yine de dur.
  olayYaz(o.db, { kind: OLAY.DURUM, sessionId: 'a', at: SIMDI - 5 * 60_000,
    data: { durum: 'limit-doldu', sifirlanma: 'saat 15:00' } });
  const d = degerlendir(o.db, ayar({ besSaatlikUsd: 40 }), { simdi: SIMDI });
  assert.equal(d.sinir, 0);
  assert.equal(d.limit.doldu, true);
  assert.match(d.gerekce, /limiti doldu/);
  assert.match(d.gerekce, /15:00/);
  o.temizle();
});

test('tavan tanimli degilse kisitlama yapilmaz', () => {
  const o = ortam();
  kosu(o.db, { usd: 9999, bittiOnceSaat: 1 });
  const d = degerlendir(o.db, ayar({ besSaatlikUsd: null, haftalikUsd: null, tabanSinir: 4 }), { simdi: SIMDI });
  assert.equal(d.sinir, 4, 'tavan yoksa oran hesaplanamaz, taban korunur');
  o.temizle();
});

// --- Olculmus tavan onerisi ---

test('yeterli gecmis yoksa oneri verilmez', () => {
  const o = ortam();
  oturum(o.db, { usd: 5, bittiOnceSaat: 1 });
  assert.equal(tavanOner(o.db), null);
  o.temizle();
});

test('tavan onerisi gecmisten olculur ve tepe degeri dogru cikar', () => {
  const o = ortam();
  // 20 oturum, hepsi ayni 5 saatlik pencerede: tepe = toplam
  for (let i = 0; i < 20; i++) oturum(o.db, { usd: 10, bittiOnceSaat: 1 + i * 0.1 });
  const r = tavanOner(o.db);
  assert.ok(r, 'yeterli veri var');
  assert.equal(r.olcum.oturumSayisi, 20);
  // Regresyon: dilim 1 iken indeks diziyi tasiyor ve tepe 0 gorunuyordu.
  assert.ok(r.olcum.besSaatTepe > 0, 'tepe sifir olamaz');
  assert.equal(r.olcum.besSaatTepe, 200);
  assert.ok(r.besSaatlikUsd > 0);
  assert.equal(r.besSaatlikUsd % 50, 0, 'oneri 50 katina yuvarlanir');
  o.temizle();
});

test('oneri tepe degil %90 dilimi olmali', () => {
  const o = ortam();
  // 19 kucuk oturum + 1 devasa. 10 ornekte %90 dilimi zaten en yuksege
  // denk geliyor; ayirt edebilmek icin ornek sayisi 20 olmali.
  for (let i = 0; i < 19; i++) oturum(o.db, { usd: 1, bittiOnceSaat: 10 + i * 12 });
  oturum(o.db, { usd: 1000, bittiOnceSaat: 2 });
  const r = tavanOner(o.db);
  assert.ok(r.besSaatlikUsd < r.olcum.besSaatTepe,
    'tavan tepeye esit olsa hicbir zaman devreye girmezdi');
  o.temizle();
});
