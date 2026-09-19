import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { isEkle, kosuAc, kosuGuncelle, KOSU_DURUMU } from '../src/isler.js';
import {
  kayitEkle, kayitlar, insanOlgusu, kosudanOgren, hafizaIstemi, budama,
  hafizaDizini, yorumDosyasi, HAFIZA_TURU, KAYNAK,
} from '../src/hafiza.js';

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-hd-'));
  const db = openDb(join(dizin, 'h.db'));
  const proje = join(dizin, 'proje'); mkdirSync(proje);
  const kok = join(dizin, 'hafiza');
  return { db, dizin, proje, kok, temizle: () => { db.close(); try { rmSync(dizin, { recursive: true, force: true }); } catch { /* */ } } };
}
const GUN = 24 * 3600_000;

test('konu: ayni konudaki yeni kayit eskisini ezer; konusuz kayitlar birikir; baska tur/proje etkilenmez', () => {
  const o = ortam();
  try {
    const ortak = { cwd: o.proje, tur: HAFIZA_TURU.OLGU, kaynak: KAYNAK.ARAC, dogrulandi: true };
    kayitEkle(o.db, { ...ortak, konu: 'dogrulama:is1', icerik: 'GECMEDI', simdi: 1000 });
    kayitEkle(o.db, { ...ortak, konu: 'dogrulama:is2', icerik: 'baska is', simdi: 1500 });
    kayitEkle(o.db, { ...ortak, konu: 'dogrulama:is1', icerik: 'GECTI', simdi: 2000 });
    kayitEkle(o.db, { ...ortak, icerik: 'konusuz a', simdi: 2100 });
    kayitEkle(o.db, { ...ortak, icerik: 'konusuz b', simdi: 2200 });
    kayitEkle(o.db, { cwd: o.proje, tur: HAFIZA_TURU.YARIM, kaynak: KAYNAK.ARAC, konu: 'dogrulama:is1', icerik: 'yarim', simdi: 2300 });
    const olgu = kayitlar(o.db, { cwd: o.proje, tur: HAFIZA_TURU.OLGU }).map((k) => k.icerik).sort();
    assert.deepEqual(olgu, ['GECTI', 'baska is', 'konusuz a', 'konusuz b']);
    assert.equal(kayitlar(o.db, { cwd: o.proje, tur: HAFIZA_TURU.YARIM }).length, 1, 'tur farkliysa ezilmez');
  } finally { o.temizle(); }
});

test('kosudanOgren: isin dogrulama sonucu TEK kayit kalir; basari eski "hatayla bitti" olgusunu siler', () => {
  const o = ortam();
  try {
    const is = isEkle(o.db, { ad: 'Onar', gorev: 'g', cwd: o.proje, profil: 'serbest', dogrulama: 'npm test' });
    const kos = (alanlar) => { const k = kosuAc(o.db, is.id); kosuGuncelle(o.db, k.id, alanlar); kosudanOgren(o.db, k.id, { kok: o.kok }); return k; };
    kos({ durum: KOSU_DURUMU.KARAR_BEKLIYOR, dogrulamaKod: 1 });
    kos({ durum: KOSU_DURUMU.KARAR_BEKLIYOR, dogrulamaKod: 1 });
    kos({ durum: KOSU_DURUMU.HATA, hata: 'surec coktu' });
    let olgu = kayitlar(o.db, { cwd: o.proje, tur: HAFIZA_TURU.OLGU });
    assert.equal(olgu.filter((x) => x.konu === 'dogrulama:' + is.id).length, 1, 'uc kosu, tek dogrulama kaydi');
    assert.equal(olgu.filter((x) => x.konu === 'hata:' + is.id).length, 1);
    kos({ durum: KOSU_DURUMU.BITTI, dogrulamaKod: 0 });
    olgu = kayitlar(o.db, { cwd: o.proje, tur: HAFIZA_TURU.OLGU });
    assert.deepEqual(olgu.map((x) => x.konu), ['dogrulama:' + is.id], 'hata olgusu silindi, dogrulama guncellendi');
    assert.match(olgu[0].icerik, /GECTI/);
  } finally { o.temizle(); }
});

test('insan olgusu: ayni cumle tek kayit; "konu: metin" ayni konudaki eski beyani ezer; brifte once insan', () => {
  const o = ortam();
  try {
    insanOlgusu(o.db, { cwd: o.proje, icerik: 'Commit atma.' });
    insanOlgusu(o.db, { cwd: o.proje, icerik: 'commit   ATMA.' });
    insanOlgusu(o.db, { cwd: o.proje, icerik: 'test komutu: pytest' });
    insanOlgusu(o.db, { cwd: o.proje, icerik: 'Test komutu: python -m unittest discover -s tests' });
    const insan = kayitlar(o.db, { cwd: o.proje, tur: HAFIZA_TURU.OLGU }).map((k) => k.icerik).sort();
    assert.deepEqual(insan, ['Test komutu: python -m unittest discover -s tests', 'commit   ATMA.']);
    // 12 arac olgusu insan beyanini brifin disina itemez
    for (let i = 0; i < 12; i++) kayitEkle(o.db, { cwd: o.proje, tur: HAFIZA_TURU.OLGU, kaynak: KAYNAK.ARAC, dogrulandi: true, icerik: 'olcum ' + i, simdi: Date.now() + 1000 + i });
    const brif = hafizaIstemi(o.db, { cwd: o.proje, id: 'x' }, { kok: o.kok });
    assert.match(brif, /Test komutu: python -m unittest/);
    assert.match(brif, /commit {3}ATMA\.|commit ATMA\./);
    assert.ok(brif.includes('- olcum 11'), 'en yeni arac olcumu de brifte');
    assert.ok(brif.indexOf('Test komutu') < brif.indexOf('- olcum 11'), 'insan beyani arac olcumlerinden once');
    assert.ok(!brif.includes('- olcum 0'), 'sinir asilinca en eski arac olcumu disarida kalir, insan beyani degil');
  } finally { o.temizle(); }
});

test('budama: olu projenin hafizasi ve klasoru silinir; diski takili olmayan proje ve yasayan proje kalir', () => {
  const o = ortam();
  try {
    const olu = join(o.dizin, 'silinmis-proje'); mkdirSync(olu);
    kayitEkle(o.db, { cwd: olu, tur: HAFIZA_TURU.YORUM, kaynak: KAYNAK.AJAN, icerik: 'rapor', kosuId: 'k1' });
    mkdirSync(hafizaDizini(olu, { kok: o.kok }), { recursive: true });
    writeFileSync(yorumDosyasi(olu, 'k1', { kok: o.kok }), 'x');
    kayitEkle(o.db, { cwd: o.proje, tur: HAFIZA_TURU.OLGU, kaynak: KAYNAK.ARAC, icerik: 'yasayan' });
    const takisiz = 'q:/cikarilmis-disk/proje';
    kayitEkle(o.db, { cwd: takisiz, tur: HAFIZA_TURU.OLGU, kaynak: KAYNAK.INSAN, icerik: 'disk yok' });
    rmSync(olu, { recursive: true, force: true });

    const r = budama(o.db, { geciciKok: null, kok: o.kok, varMi: (y) => (String(y).toLowerCase().startsWith('q:') ? false : existsSync(y)) });
    assert.equal(r.oluProje, 1);
    assert.equal(kayitlar(o.db, { cwd: olu }).length, 0);
    assert.equal(existsSync(hafizaDizini(olu, { kok: o.kok })), false, 'rapor klasoru de gitti');
    assert.equal(kayitlar(o.db, { cwd: o.proje }).length, 1);
    assert.equal(kayitlar(o.db, { cwd: takisiz }).length, 1, 'kok surucu yoksa olu sayilmaz');
  } finally { o.temizle(); }
});

test('budama: konu kopyalari, eski bayat olgular, ust sinir ve kapanmis eski raporlar', () => {
  const o = ortam();
  try {
    const simdi = Date.now();
    const olgu = { cwd: o.proje, tur: HAFIZA_TURU.OLGU, kaynak: KAYNAK.ARAC, dogrulandi: true };
    // Goc oncesi kopyalar: kayitEkle ezerdi, o yuzden dogrudan SQL
    const ham = o.db.prepare(`INSERT INTO hafiza (id, proje, tur, icerik, kaynak, dogrulandi, olusturuldu, konu, parmak_izi)
      VALUES (?,?,?,?,?,1,?,?,?)`);
    const proje = kayitlar(o.db, { cwd: o.proje }).length === 0 && kayitEkle(o.db, { ...olgu, icerik: 'tohum', iz: 'IZ-SIMDI', simdi }).proje;
    ham.run('a1', proje, 'olgu', 'eski kopya', 'arac', simdi - 5000, 'dogrulama:is1', 'IZ-SIMDI');
    ham.run('a2', proje, 'olgu', 'yeni kopya', 'arac', simdi - 1000, 'dogrulama:is1', 'IZ-SIMDI');
    // Bayat: iz farkli. Biri 40 gun once (silinir), biri dun (kalir: henuz isaretli tasinir)
    ham.run('b1', proje, 'olgu', 'bayat eski', 'arac', simdi - 40 * GUN, null, 'IZ-ESKI');
    ham.run('b2', proje, 'olgu', 'bayat yeni', 'arac', simdi - 1 * GUN, null, 'IZ-ESKI');
    // Insan olgusu eski ve izi farkli olsa da silinmez
    ham.run('i1', proje, 'olgu', 'insan kurali', 'insan', simdi - 400 * GUN, 'insan:kural', 'IZ-ESKI');
    // Kapanmis eski rapor + dosyasi; kapanmis ama yeni rapor kalir; acik eski rapor kalir
    mkdirSync(hafizaDizini(o.proje, { kok: o.kok }), { recursive: true });
    writeFileSync(yorumDosyasi(o.proje, 'kr1', { kok: o.kok }), 'eski rapor');
    o.db.prepare(`INSERT INTO hafiza (id, proje, tur, icerik, kaynak, dogrulandi, olusturuldu, kapandi, kosu_id) VALUES
      ('r1', ?, 'yorum', 'damitilmis eski', 'ajan', 0, ?, ?, 'kr1'),
      ('r2', ?, 'yorum', 'damitilmis yeni', 'ajan', 0, ?, ?, 'kr2'),
      ('r3', ?, 'yorum', 'acik eski', 'ajan', 0, ?, NULL, 'kr3')`)
      .run(proje, simdi - 60 * GUN, simdi - 50 * GUN, proje, simdi - 3 * GUN, simdi - 2 * GUN, proje, simdi - 60 * GUN);

    const r = budama(o.db, { simdi, gun: 30, enFazlaOlgu: 3, geciciKok: null, kok: o.kok, izAl: () => 'IZ-SIMDI' });
    assert.equal(r.kopya, 1);
    assert.equal(r.bayat, 1);
    assert.equal(r.eskiRapor, 1);
    const kalan = o.db.prepare('SELECT id FROM hafiza WHERE proje = ? ORDER BY id').all(proje).map((x) => x.id);
    assert.ok(!kalan.includes('a1') && kalan.includes('a2'), 'konudan en yenisi kaldi');
    assert.ok(!kalan.includes('b1') && kalan.includes('b2'));
    assert.ok(kalan.includes('i1'), 'insan olgusu dokunulmaz');
    assert.ok(!kalan.includes('r1') && kalan.includes('r2') && kalan.includes('r3'));
    assert.equal(existsSync(yorumDosyasi(o.proje, 'kr1', { kok: o.kok })), false, 'rapor dosyasi da silindi');
    // Ust sinir 3: arac olgulari tohum, a2, b2 = 3 -> tasan yok. Bir tane daha ekleyince en eskisi gider.
    assert.equal(r.tasan, 0);
    kayitEkle(o.db, { ...olgu, icerik: 'en yeni', iz: 'IZ-SIMDI', simdi: simdi + 10 });
    const r2 = budama(o.db, { simdi: simdi + 20, gun: 30, enFazlaOlgu: 3, geciciKok: null, kok: o.kok, izAl: () => 'IZ-SIMDI' });
    assert.equal(r2.tasan, 1);
    assert.ok(!o.db.prepare('SELECT id FROM hafiza WHERE proje = ?').all(proje).map((x) => x.id).includes('b2'), 'en eski arac olgusu tasti');
    // Idempotent
    assert.equal(budama(o.db, { simdi: simdi + 30, gun: 30, enFazlaOlgu: 3, geciciKok: null, kok: o.kok, izAl: () => 'IZ-SIMDI' }).toplam, 0);
  } finally { o.temizle(); }
});

test('goc 19: eski dogrulama/hata olgulari metinden konuya baglanir', () => {
  const o = ortam();
  try {
    // Gocten sonra da ayni SQL calisir: eski bicimli kaydi elle koyup backfill ifadesini sinariz
    o.db.prepare(`INSERT INTO hafiza (id, proje, tur, icerik, kaynak, dogrulandi, is_id, olusturuldu)
      VALUES ('e1', 'p', 'olgu', '"Onar" dogrulamasi (npm test) GECTI.', 'arac', 1, 'is9', 1)`).run();
    o.db.exec(`UPDATE hafiza SET konu = 'dogrulama:' || is_id
      WHERE tur = 'olgu' AND kaynak = 'arac' AND is_id IS NOT NULL AND icerik LIKE '%" dogrulamasi (%'`);
    assert.equal(o.db.prepare("SELECT konu FROM hafiza WHERE id = 'e1'").get().konu, 'dogrulama:is9');
    assert.ok(o.db.prepare("SELECT 1 x FROM pragma_table_info('hafiza') WHERE name = 'konu'").get());
  } finally { o.temizle(); }
});

test('budama: gecici dizindeki ISSIZ projenin hafizasi silinir; isi olan gecici proje ve gecici olmayan proje kalir', () => {
  const o = ortam();
  try {
    // o.dizin gecici kok gibi davranir: altinda uc proje
    const sinav = join(o.dizin, 'suru-sinav-abc', 'cakisma'); mkdirSync(sinav, { recursive: true });
    const isli = join(o.dizin, 'suru-deneme', 'aktif'); mkdirSync(isli, { recursive: true });
    const disarda = mkdtempSync(join(tmpdir(), 'suru-hd-disari-'));
    try {
      for (const p of [sinav, isli, disarda]) kayitEkle(o.db, { cwd: p, tur: HAFIZA_TURU.YORUM, kaynak: KAYNAK.AJAN, icerik: 'rapor', kosuId: 'k' });
      isEkle(o.db, { ad: 'aktif is', gorev: 'g', cwd: isli, profil: 'serbest' });
      mkdirSync(hafizaDizini(sinav, { kok: o.kok }), { recursive: true });
      const r = budama(o.db, { kok: o.kok, geciciKok: o.dizin });
      assert.equal(r.sahipsiz, 1);
      assert.equal(kayitlar(o.db, { cwd: sinav }).length, 0, 'klasoru dursa da hafizasi gitti');
      assert.equal(existsSync(sinav), true, 'proje klasorune DOKUNULMAZ, sadece hafiza');
      assert.equal(existsSync(hafizaDizini(sinav, { kok: o.kok })), false);
      assert.equal(kayitlar(o.db, { cwd: isli }).length, 1, 'isi olan gecici proje kalir');
      assert.equal(kayitlar(o.db, { cwd: disarda }).length, 1, 'gecici kokun disindaki proje kalir');
    } finally { rmSync(disarda, { recursive: true, force: true }); }
  } finally { o.temizle(); }
});

test('budama: eski bicimli dogrulama olgusu sonuc basta olacak sekilde yeniden yazilir (brifte kirpilmasin)', () => {
  const o = ortam();
  try {
    const uzun = 'set PYTHONPATH=src&& python -m unittest discover -s tests -p test_config.py && python -m unittest discover -s tests -p test_gender.py';
    const ham = o.db.prepare("INSERT INTO hafiza (id, proje, tur, icerik, kaynak, dogrulandi, olusturuldu, konu) VALUES (?,?,'olgu',?,'arac',1,?,?)");
    const proje = kayitEkle(o.db, { cwd: o.proje, tur: HAFIZA_TURU.YARIM, kaynak: KAYNAK.ARAC, icerik: 'tohum' }).proje;
    ham.run('d1', proje, '"is-a" dogrulamasi (' + uzun + ') GECTI.', 1, 'dogrulama:a');
    ham.run('d2', proje, '"is-b" dogrulamasi (' + uzun + ') GECMEDI, cikis kodu 2.', 2, 'dogrulama:b');
    const r = budama(o.db, { geciciKok: null, kok: o.kok });
    assert.equal(r.yenidenYazilan, 2);
    assert.equal(o.db.prepare("SELECT icerik FROM hafiza WHERE id='d1'").get().icerik, '"is-a" dogrulamasi GECTI. Komut: ' + uzun);
    assert.equal(o.db.prepare("SELECT icerik FROM hafiza WHERE id='d2'").get().icerik, '"is-b" dogrulamasi GECMEDI (cikis kodu 2). Komut: ' + uzun);
    const brif = hafizaIstemi(o.db, { cwd: o.proje, id: 'x' }, { kok: o.kok });
    assert.ok(brif.includes('"is-b" dogrulamasi GECMEDI (cikis kodu 2)'), 'sonuc 180 karakter sinirinin icinde');
    assert.equal(budama(o.db, { geciciKok: null, kok: o.kok }).yenidenYazilan, 0, 'idempotent');
  } finally { o.temizle(); }
});
