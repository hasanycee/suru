import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, goc, SEMA_SURUMU } from '../src/db.js';
import { OLAY, yaz, yazToplu, oku, sonSeq, sonDurumlar, GecisTakipcisi, kirp } from '../src/events.js';

function geciciDb() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-test-'));
  const db = openDb(join(dizin, 'test.db'));
  // Windows'ta db.close() sonrasi WAL/SHM dosyalarinin serbest kalmasi
  // gecikebiliyor; gecici klasor silinemezse testi dusurmeye degmez,
  // isletim sistemi zaten temizler.
  return {
    db,
    temizle: () => {
      db.close();
      try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra silinir */ }
    },
  };
}

test('yeni veritabani guncel semaya gocer', () => {
  const { db, temizle } = geciciDb();
  const surum = db.prepare('PRAGMA user_version').get();
  assert.equal(Number(Object.values(surum)[0]), SEMA_SURUMU);
  // Goc yeniden calistirilinca bir sey bozulmaz (idempotent)
  assert.equal(goc(db), SEMA_SURUMU);
  temizle();
});

test('olay yazilir ve seq ile geri okunur', () => {
  const { db, temizle } = geciciDb();
  assert.equal(sonSeq(db), 0);
  const s1 = yaz(db, { kind: OLAY.ARAC, sessionId: 'a', data: { arac: 'Bash' } });
  const s2 = yaz(db, { kind: OLAY.HATA, sessionId: 'a', data: { mesaj: 'patladi' } });
  assert.ok(s2 > s1, 'seq artmali');
  assert.equal(sonSeq(db), s2);

  const hepsi = oku(db, { sinceSeq: 0 });
  assert.equal(hepsi.length, 2);
  assert.deepEqual(hepsi[0].data, { arac: 'Bash' });

  // Imlec: ilk olaydan sonrasi
  assert.equal(oku(db, { sinceSeq: s1 }).length, 1);
  // Tur suzgeci
  assert.equal(oku(db, { kind: OLAY.HATA }).length, 1);
  temizle();
});

test('toplu yazim tek islemde gecer', () => {
  const { db, temizle } = geciciDb();
  yazToplu(db, [
    { kind: OLAY.ARAC, sessionId: 'a' },
    { kind: OLAY.ARAC, sessionId: 'b' },
    { kind: OLAY.ARAC, sessionId: 'c' },
  ]);
  assert.equal(oku(db).length, 3);
  temizle();
});

test('kind zorunlu', () => {
  const { db, temizle } = geciciDb();
  assert.throws(() => yaz(db, { sessionId: 'a' }), /kind/);
  temizle();
});

test('gecis takipcisi ayni durumu tekrar yazmaz', () => {
  const { db, temizle } = geciciDb();
  const t = new GecisTakipcisi(db);

  const ilk = t.tara([{ sessionId: 'a', durum: 'calisiyor', project: 'demo', at: 1000 }]);
  assert.equal(ilk.length, 1, 'ilk gorulen durum olay uretir');
  assert.equal(ilk[0].data.onceki, null);

  const ayni = t.tara([{ sessionId: 'a', durum: 'calisiyor', project: 'demo', at: 2000 }]);
  assert.equal(ayni.length, 0, 'degismeyen durum tekrar yazilmaz');

  const degisti = t.tara([{ sessionId: 'a', durum: 'seni-bekliyor', project: 'demo', at: 3000 }]);
  assert.equal(degisti.length, 1);
  assert.equal(degisti[0].data.onceki, 'calisiyor', 'onceki durum kayda gecer');

  assert.equal(oku(db, { kind: OLAY.DURUM }).length, 2);
  temizle();
});

test('takipci yeniden baslatinca gecmisi diskten okur', () => {
  const { db, temizle } = geciciDb();
  new GecisTakipcisi(db).tara([{ sessionId: 'a', durum: 'calisiyor', at: 1000 }]);

  // Yeni takipci (sunucu yeniden basladi): ayni durumu tekrar yazmamali
  const yeniden = new GecisTakipcisi(db);
  assert.equal(yeniden.tara([{ sessionId: 'a', durum: 'calisiyor', at: 4000 }]).length, 0);
  assert.equal(yeniden.tara([{ sessionId: 'a', durum: 'takildi', at: 5000 }]).length, 1);
  temizle();
});

test('son durumlar her oturumun en guncelini verir', () => {
  const { db, temizle } = geciciDb();
  const t = new GecisTakipcisi(db);
  t.tara([{ sessionId: 'a', durum: 'calisiyor', at: 1 }, { sessionId: 'b', durum: 'bosta', at: 1 }]);
  t.tara([{ sessionId: 'a', durum: 'seni-bekliyor', at: 2 }, { sessionId: 'b', durum: 'bosta', at: 2 }]);

  const son = sonDurumlar(db);
  assert.equal(son.size, 2);
  assert.equal(son.get('a').data.durum, 'seni-bekliyor');
  assert.equal(son.get('b').data.durum, 'bosta');
  temizle();
});

test('kirpma yaslanmis olaylari atar, yenileri birakir', () => {
  const { db, temizle } = geciciDb();
  const gun = 86400_000;
  yaz(db, { kind: OLAY.ARAC, at: Date.now() - 100 * gun });
  yaz(db, { kind: OLAY.ARAC, at: Date.now() - 1 * gun });

  const atilan = kirp(db, { saklaGun: 60 });
  assert.equal(atilan, 1);
  assert.equal(oku(db).length, 1);
  temizle();
});

test('kirpma sayi tavanini da uygular', () => {
  const { db, temizle } = geciciDb();
  yazToplu(db, Array.from({ length: 50 }, () => ({ kind: OLAY.ARAC, at: Date.now() })));
  kirp(db, { saklaGun: 60, enFazla: 20 });
  assert.equal(oku(db, { limit: 1000 }).length, 20);
  temizle();
});
