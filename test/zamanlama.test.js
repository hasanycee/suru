import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { OLAY, oku as olayOku } from '../src/events.js';
import { isEkle, isGetir, kosuAc, kosuGuncelle, KOSU_DURUMU } from '../src/isler.js';
import { cronCoz, sonrakiZaman, zamanlamaNormal, tetikle } from '../src/zamanlama.js';

const yerel = (y, a, g, s = 0, d = 0) => new Date(y, a - 1, g, s, d).getTime();

test('cron alanlari: yildiz, adim, aralik, liste; gecersiz ifade reddedilir', () => {
  assert.deepEqual([...cronCoz('*/15 * * * *').dk], [0, 15, 30, 45]);
  assert.deepEqual([...cronCoz('0 9 * * 1-5').hg], [1, 2, 3, 4, 5]);
  assert.deepEqual([...cronCoz('5,10 0-4/2 * * *').sa], [0, 2, 4]);
  assert.ok(cronCoz('0 0 * * 7').hg.has(0), '7 = Pazar');
  for (const kotu of ['60 * * * *', '* * *', 'a * * * *', '* 24 * * *', '*/0 * * * *', '5-1 * * * *']) {
    assert.throws(() => cronCoz(kotu), undefined, kotu);
  }
  assert.equal(zamanlamaNormal('  0  3 * *   * '), '0 3 * * *');
  assert.equal(zamanlamaNormal(''), null);
});

test('sonraki tetik zamani yerel saatle hesaplanir', () => {
  const cuma = yerel(2026, 9, 11, 10, 7); // 11 Eylul 2026 Cuma
  assert.equal(sonrakiZaman('*/15 * * * *', cuma), yerel(2026, 9, 11, 10, 15));
  assert.equal(sonrakiZaman('0 3 * * *', cuma), yerel(2026, 9, 12, 3, 0));
  assert.equal(sonrakiZaman('30 9 * * 1', cuma), yerel(2026, 9, 14, 9, 30), 'pazartesi');
  assert.equal(sonrakiZaman('0 0 13 * 5', cuma), yerel(2026, 9, 13, 0, 0), 'gun VEYA haftagunu');
  assert.equal(sonrakiZaman('0 0 1 1 *', cuma), yerel(2027, 1, 1, 0, 0));
  assert.equal(sonrakiZaman('0 10 * * *', yerel(2026, 9, 11, 10, 0)), yerel(2026, 9, 12, 10, 0), 'ayni dakika degil sonraki');
  const t0 = Date.now();
  assert.equal(sonrakiZaman('0 0 31 2 *', cuma), null, 'imkansiz tarih');
  assert.ok(Date.now() - t0 < 500, 'imkansiz ifade taramasi hizli');
});

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-zamanlama-'));
  const db = openDb(join(dizin, 'z.db'));
  const kuyruk = { siraya: (id) => kosuAc(db, id) };
  return { db, dizin, kuyruk, temizle: () => {
    db.close();
    try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra */ }
  } };
}

test('vadesi gelen is kuyruga alinir; kacirilan tetikler birikmez', () => {
  const o = ortam();
  const is = isEkle(o.db, { ad: 'gece', gorev: 'g', cwd: o.dizin, profil: 'gozlemci', zamanlama: '*/5 * * * *' });
  assert.equal(isGetir(o.db, is.id).zamanlama, '*/5 * * * *');
  const bas = yerel(2026, 9, 11, 10, 1);
  o.db.prepare('UPDATE isler SET olusturuldu = ? WHERE id = ?').run(bas, is.id);

  assert.deepEqual(tetikle(o.db, o.kuyruk, { simdi: yerel(2026, 9, 11, 10, 3) }), [], 'vade gelmedi');
  // 10:05, 10:10, 10:15, 10:20 kacirildi: tek kosu
  const r = tetikle(o.db, o.kuyruk, { simdi: yerel(2026, 9, 11, 10, 22) });
  assert.equal(r.length, 1);
  assert.ok(r[0].kosuId);
  assert.equal(tetikle(o.db, o.kuyruk, { simdi: yerel(2026, 9, 11, 10, 23) }).length, 0, 'ayni vade tekrar tetiklenmez');
  assert.ok(olayOku(o.db, { kind: OLAY.IS }).some((e) => e.data.asama === 'zamanlandi'));
  o.temizle();
});

test('onceki kosu bitmediyse ya da karar bekliyorsa tetik atlanir, bitince yeniden tetiklenir', () => {
  const o = ortam();
  const is = isEkle(o.db, { ad: 'saatlik', gorev: 'g', cwd: o.dizin, profil: 'gozlemci', zamanlama: '0 * * * *' });
  o.db.prepare('UPDATE isler SET olusturuldu = ? WHERE id = ?').run(yerel(2026, 9, 11, 9, 30), is.id);

  const [ilk] = tetikle(o.db, o.kuyruk, { simdi: yerel(2026, 9, 11, 10, 1) });
  const atla = tetikle(o.db, o.kuyruk, { simdi: yerel(2026, 9, 11, 11, 1) });
  assert.equal(atla.length, 1);
  assert.equal(atla[0].atlandi, true, 'kosu hala bekliyor');

  kosuGuncelle(o.db, ilk.kosuId, { durum: KOSU_DURUMU.KARAR_BEKLIYOR });
  assert.equal(tetikle(o.db, o.kuyruk, { simdi: yerel(2026, 9, 11, 12, 1) })[0].atlandi, true, 'karar bekliyor');

  kosuGuncelle(o.db, ilk.kosuId, { durum: KOSU_DURUMU.BITTI });
  const yeni = tetikle(o.db, o.kuyruk, { simdi: yerel(2026, 9, 11, 13, 1) });
  assert.ok(yeni[0].kosuId && !yeni[0].atlandi);
  assert.ok(olayOku(o.db, { kind: OLAY.IS }).some((e) => e.data.asama === 'zamanlama-atlandi'));
  o.temizle();
});

test('denetim dongusu suruyorsa (denetci kosusu baska iste) tetik atlanir', () => {
  const o = ortam();
  const is = isEkle(o.db, { ad: 'dongulu', gorev: 'g', cwd: o.dizin, profil: 'serbest', zamanlama: '0 * * * *' });
  const denetci = isEkle(o.db, { ad: '_denetci:x', gorev: 'g', cwd: o.dizin, profil: 'gozlemci', ic: true });
  o.db.prepare('UPDATE isler SET olusturuldu = ? WHERE id = ?').run(yerel(2026, 9, 11, 9, 30), is.id);
  const yapici = kosuAc(o.db, is.id, { donguId: 'd1', tur: 1, rol: 'yapici' });
  kosuGuncelle(o.db, yapici.id, { durum: KOSU_DURUMU.BITTI });
  kosuAc(o.db, denetci.id, { donguId: 'd1', tur: 1, rol: 'denetci' }); // bekliyor
  assert.equal(tetikle(o.db, o.kuyruk, { simdi: yerel(2026, 9, 11, 10, 1) })[0].atlandi, true);
  o.temizle();
});

test('gecersiz zamanlamayla is eklenemez; etkin olmayan is tetiklenmez', () => {
  const o = ortam();
  assert.throws(() => isEkle(o.db, { ad: 'x', gorev: 'g', cwd: o.dizin, profil: 'gozlemci', zamanlama: '99 * * * *' }), /dakika/);
  const is = isEkle(o.db, { ad: 'kapali', gorev: 'g', cwd: o.dizin, profil: 'gozlemci', zamanlama: '* * * * *' });
  o.db.prepare('UPDATE isler SET etkin = 0, olusturuldu = ? WHERE id = ?').run(yerel(2026, 9, 11, 9, 0), is.id);
  assert.deepEqual(tetikle(o.db, o.kuyruk, { simdi: yerel(2026, 9, 11, 10, 0) }), []);
  o.temizle();
});
