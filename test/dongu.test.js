import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { isEkle, isGetir, kosuGetir, kosuGuncelle, KOSU_DURUMU } from '../src/isler.js';
import { Kuyruk } from '../src/kuyruk.js';
import { kararlariTazele, bekleyenKararlar, cevapla, KARAR_TURU, kararKarti, kapsamGenislet } from '../src/eskalasyon.js';
import {
  donguIlerlet, donguDurumu, hukumCoz, ilerlemeYok, denetimGorevi, yapiciTalimati, ROL, DENETCI_ONEK,
  testSayisiCoz, kalanTestler, kapsamDisi,
} from '../src/dongu.js';

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-dongu-'));
  const db = openDb(join(dizin, 'd.db'));
  return { db, dizin, temizle: () => {
    db.close();
    try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra */ }
  } };
}

const hukum = (karar, bulgular = []) => 'Inceledim.\n' + JSON.stringify({ karar, bulgular });
const B = (dosya, ciddiyet = 'orta') => ({ ciddiyet, dosya, sorun: dosya + ' hatali', oneri: 'duzelt' });

/** Surec baslatmayan kosucu: senaryodaki sonuclari sirayla yazar. */
function kur(o, senaryo, ekBag = {}) {
  const sayac = { yapici: 0, denetci: 0 };
  const gorulen = [];
  const kosucu = async (db, { is, kosu }) => {
    const rol = kosu.rol === ROL.DENETCI ? 'denetci' : 'yapici';
    const liste = senaryo[rol];
    const s = liste[Math.min(sayac[rol]++, liste.length - 1)];
    gorulen.push({ rol, tur: kosu.tur, ekTalimat: kosu.ekTalimat, gorev: is.gorev, profil: is.profil, model: is.model });
    const durum = s.durum ?? KOSU_DURUMU.BITTI;
    kosuGuncelle(db, kosu.id, { durum, bitti: Date.now(), sonuc: s.sonuc ?? null, usd: s.usd ?? 0.01, hata: s.hata ?? null,
      dogrulamaKod: s.dogrulamaKod ?? null, dogrulamaCikti: s.dogrulamaCikti ?? null });
    return { durum };
  };
  const k = new Kuyruk(o.db, { esZamanli: 2, kosucu });
  const sonuclar = [];
  k.on('bitti', ({ kosuId, isId }) => {
    const r = donguIlerlet(o.db, { siraya: (id, ek) => k.siraya(id, ek), kanit: () => null, golge: () => null, ...ekBag }, { kosuId, isId });
    if (r) sonuclar.push(r);
  });
  return { k, gorulen, sonuclar };
}

const yapildi = { sonuc: 'yaptim' };

test('hukum: son JSON cozulur, karar bulgulardan turetilir', () => {
  const t = 'once {"karar":"kaldi"} dedim ama\n```json\n' + JSON.stringify({ karar: 'gecti',
    bulgular: [{ ciddiyet: 'Yüksek', dosya: 'a.js', sorun: 'bos { parantez } var', oneri: 'x' }] }) + '\n```';
  const h = hukumCoz(t);
  assert.equal(h.karar, 'kaldi', 'model gecti dese de yuksek bulgu isi geri cevirir');
  assert.equal(h.modelKarari, 'gecti');
  assert.equal(h.bulgular[0].ciddiyet, 'yuksek');
  assert.equal(h.bulgular[0].sorun, 'bos { parantez } var');

  assert.equal(hukumCoz(hukum('kaldi', [B('a.js', 'dusuk')])).karar, 'gecti', 'sadece dusuk bulgu geri cevirmez');
  // Regresyon (saha): Turkce karakterli karar metni model kararini kaybettiriyordu.
  assert.equal(hukumCoz('{"karar":"kaldı","bulgular":[]}').modelKarari, 'kaldi');
  assert.equal(hukumCoz('{"karar":"Geçti","bulgular":[]}').modelKarari, 'gecti');
  assert.equal(hukumCoz('json yok'), null);
  assert.equal(hukumCoz('{"karar": "gecti", bozuk'), null);
});

test('ilerleme yok: ciddi bulgu dosyalari onceki turun alt kumesi', () => {
  assert.equal(ilerlemeYok([B('src/a.js')], [B('SRC\\A.js')]), true);
  assert.equal(ilerlemeYok([B('a.js')], [B('a.js'), B('b.js')]), false);
  assert.equal(ilerlemeYok([B('a.js')], [B('a.js', 'dusuk')]), false);
  assert.equal(ilerlemeYok([], [B('a.js')]), false);
});

test('denetim gorevi rapor ile kaniti ayirir, komutsuz yapiciyi isaretler', () => {
  const g = denetimGorevi({
    is: { gorev: 'testleri yaz', dogrulama: 'npm test' },
    yapiciKosu: { sonuc: '36 test yazdim ve gecti', dogrulamaKod: 0 },
    kanit: { sayac: { adim: 1, hata: 0, okunanDosya: 1, yazilanDosya: 0, komut: 0, web: 0 },
      adimlar: [{ sira: 1, arac: 'Read', girdi: 'a.js' }], belirsizlikler: [] },
    golge: { degisiklik: [{ durum: 'M', yol: 'a.js' }], fark: '-eski\n+yeni' },
    oncekiBulgular: [B('b.js')], tur: 2, enFazlaTur: 3,
  });
  assert.match(g, /DOGRULANMAMIS/);
  assert.match(g, /36 test yazdim/);
  assert.match(g, /npm test`: GECTI/);
  assert.match(g, /HIC KOMUT CALISTIRMADI/);
  assert.match(g, /- M a\.js/);
  assert.match(g, /\+yeni/);
  assert.match(g, /b\.js hatali/);
  assert.match(g, /tur 2\/3/);
  assert.match(yapiciTalimati([B('a.js')], 2, 3), /2\/3[\s\S]*a\.js hatali/);
});

test('kaldi -> taze yapici bulgularla -> gecti: dongu biter', async () => {
  const o = ortam();
  const { k, gorulen, sonuclar } = kur(o, { yapici: [yapildi], denetci: [{ sonuc: hukum('kaldi', [B('a.js')]) }, { sonuc: hukum('gecti') }] });
  const is = isEkle(o.db, { ad: 'insa', gorev: 'ozelligi yaz', cwd: o.dizin, profil: 'serbest', donguTur: 3 });
  k.siraya(is.id);
  await k.bekle();

  assert.deepEqual(gorulen.map((g) => g.rol), ['yapici', 'denetci', 'yapici', 'denetci']);
  assert.deepEqual(gorulen.map((g) => g.tur), [null, 1, 2, 2]);
  assert.equal(gorulen[1].profil, 'gozlemci', 'denetci yazamaz');
  assert.equal(gorulen[1].model, 'sonnet');
  assert.match(gorulen[1].gorev, /ozelligi yaz/);
  assert.equal(gorulen[0].ekTalimat, null);
  assert.match(gorulen[2].ekTalimat, /a\.js hatali/, 'yeni yapici bulgulari alir');
  assert.match(gorulen[3].gorev, /Onceki denetimin bulgulari[\s\S]*a\.js hatali/);
  assert.equal(sonuclar.at(-1).asama, 'gecti');

  const d = donguDurumu(o.db, is.id);
  assert.equal(d.turlar.length, 4);
  assert.equal(d.sonHukum.karar, 'gecti');
  assert.equal(o.db.prepare('SELECT COUNT(*) n FROM isler WHERE ad LIKE ?').get(DENETCI_ONEK + '%').n, 1, 'denetci isi tekrar kullanilir');
  o.temizle();
});

test('tur siniri: tek denetim karari acilir, cevap bulgularla ayni donguye doner', async () => {
  const o = ortam();
  const { k, sonuclar } = kur(o, { yapici: [yapildi],
    denetci: [{ sonuc: hukum('kaldi', [B('a.js')]) }, { sonuc: hukum('kaldi', [B('b.js', 'yuksek')]) }] });
  const is = isEkle(o.db, { ad: 'insa', gorev: 'g', cwd: o.dizin, profil: 'serbest', donguTur: 2 });
  k.siraya(is.id);
  await k.bekle();

  const son = sonuclar.at(-1);
  assert.equal(son.asama, 'tikandi');
  assert.equal(son.neden, 'tur siniri');
  kararlariTazele(o.db);
  const kararlar = bekleyenKararlar(o.db);
  assert.equal(kararlar.length, 1, 'tek karar');
  assert.equal(kararlar[0].tur, KARAR_TURU.DENETIM);
  assert.match(kararlar[0].ayrinti, /b\.js hatali/);

  const yapiciKosu = kosuGetir(o.db, kararlar[0].kosuId);
  assert.equal(yapiciKosu.rol, ROL.YAPICI);
  assert.equal(yapiciKosu.tur, 2);
  const { devamKosu } = cevapla(o.db, kararlar[0].id, 'Bulgulari duzelt');
  const devam = kosuGetir(o.db, devamKosu.id);
  assert.equal(devam.donguId, yapiciKosu.donguId);
  assert.match(devam.devamCevabi, /Bulgulari duzelt[\s\S]*b\.js hatali/);
  o.temizle();
});

test('ilerleme yok: ayni dosyada sorun suruyorsa tur siniri beklenmez', async () => {
  const o = ortam();
  const { k, sonuclar, gorulen } = kur(o, { yapici: [yapildi], denetci: [{ sonuc: hukum('kaldi', [B('a.js')]) }] });
  const is = isEkle(o.db, { ad: 'insa', gorev: 'g', cwd: o.dizin, profil: 'serbest', donguTur: 5 });
  k.siraya(is.id);
  await k.bekle();
  assert.equal(gorulen.length, 4);
  assert.match(sonuclar.at(-1).neden, /ilerleme yok/);
  o.temizle();
});

test('butce dolunca dongu durur', async () => {
  const o = ortam();
  const { k, sonuclar, gorulen } = kur(o, { yapici: [yapildi], denetci: [{ sonuc: hukum('kaldi', [B('a.js')]) }] });
  const is = isEkle(o.db, { ad: 'insa', gorev: 'g', cwd: o.dizin, profil: 'serbest', donguTur: 5, donguButceUsd: 0.015 });
  k.siraya(is.id);
  await k.bekle();
  assert.equal(gorulen.length, 2);
  assert.match(sonuclar.at(-1).neden, /butce/);
  o.temizle();
});

test('yapici basarisizsa denetci kosmaz; dongu kapaliysa hic kosmaz', async () => {
  const o = ortam();
  const a = kur(o, { yapici: [{ durum: KOSU_DURUMU.HATA, hata: 'patladi' }], denetci: [{ sonuc: hukum('gecti') }] });
  const is = isEkle(o.db, { ad: 'insa', gorev: 'g', cwd: o.dizin, profil: 'serbest', donguTur: 3 });
  a.k.siraya(is.id);
  await a.k.bekle();
  assert.deepEqual(a.gorulen.map((g) => g.rol), ['yapici']);

  const b = kur(o, { yapici: [yapildi], denetci: [{ sonuc: hukum('gecti') }] });
  const is2 = isEkle(o.db, { ad: 'dongusuz', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
  b.k.siraya(is2.id);
  await b.k.bekle();
  assert.deepEqual(b.gorulen.map((g) => g.rol), ['yapici']);
  o.temizle();
});

test('denetci hukum yazmazsa dongu tikanir, sessizce gecmez', async () => {
  const o = ortam();
  const { k, sonuclar } = kur(o, { yapici: [yapildi], denetci: [{ sonuc: 'guzel olmus bence' }] });
  const is = isEkle(o.db, { ad: 'insa', gorev: 'g', cwd: o.dizin, profil: 'serbest', donguTur: 3 });
  k.siraya(is.id);
  await k.bekle();
  assert.match(sonuclar.at(-1).neden, /hukum/);
  o.temizle();
});

// --- Dogrulama kalinca dongu (saha: FinancialDedective) ---

const UNITTEST_KALDI = 'test_a (t.T) ... ok\nERROR: test_hafta (test_logic.T)\n----\nRan 18 tests in 0.06s\n\nFAILED (errors=1)';
const kaldi = { durum: KOSU_DURUMU.KARAR_BEKLIYOR, dogrulamaKod: 1, dogrulamaCikti: UNITTEST_KALDI, sonuc: 'duzelttim' };
const gecti = { durum: KOSU_DURUMU.BITTI, dogrulamaKod: 0, dogrulamaCikti: 'Ran 18 tests\n\nOK', sonuc: 'duzelttim' };

test('test sayisi ve kalan testler dogrulama ciktisindan okunur', () => {
  assert.equal(testSayisiCoz(UNITTEST_KALDI), 18);
  assert.equal(testSayisiCoz('ℹ tests 23\nℹ pass 23'), 23);
  assert.equal(testSayisiCoz('==== 5 passed in 0.1s ===='), 5);
  assert.equal(testSayisiCoz('hic sayi yok'), null);
  // Regresyon (saha): zincirli dogrulama komutu iki ozet satiri uretir.
  assert.equal(testSayisiCoz('Ran 23 tests in 0.009s\nOK\nRan 20 tests in 0.039s\nOK'), 43);
  assert.deepEqual(kalanTestler(UNITTEST_KALDI), ['test_hafta']);
  assert.deepEqual(kalanTestler('FAILED tests/test_x.py::test_y - assert\n'), ['tests/test_x.py::test_y']);
  assert.deepEqual(kalanTestler('✖ kitap eklenir (1.2ms)\n✖ failing tests:\n✖ kitap eklenir (1.2ms)'), ['kitap eklenir'],
    'ozet basligi test adi degil');
  const g = denetimGorevi({ is: { gorev: 'g', dogrulama: 'npm test' }, yapiciKosu: { sonuc: '36 test yazdim', dogrulamaKod: 0, dogrulamaCikti: 'Ran 23 tests' } });
  assert.match(g, /calisan test sayisi: 23/);
});

test('dogrulama kalinca insana gitmeden yeni tur: cikti ve kalan test yeni yapiciya gider', async () => {
  const o = ortam();
  const { k, gorulen, sonuclar } = kur(o, { yapici: [kaldi, gecti], denetci: [{ sonuc: hukum('gecti') }] });
  const is = isEkle(o.db, { ad: 'fin', gorev: 'saglamlastir', cwd: o.dizin, profil: 'serbest', donguTur: 3, dogrulama: 'python -m unittest' });
  const ilk = k.siraya(is.id);
  await k.bekle();

  assert.deepEqual(gorulen.map((g) => g.rol), ['yapici', 'yapici', 'denetci']);
  assert.match(gorulen[1].ekTalimat, /GECMEDI[\s\S]*test_hafta[\s\S]*Ran 18 tests/);
  assert.equal(sonuclar[0].asama, 'dogrulama-yeni-tur');
  assert.equal(sonuclar.at(-1).asama, 'gecti');
  const ilkKayit = kosuGetir(o.db, ilk.id);
  assert.equal(ilkKayit.durum, KOSU_DURUMU.HATA);
  assert.equal(ilkKayit.terminalNeden, 'dogrulama-kaldi-dongu');
  kararlariTazele(o.db);
  assert.equal(bekleyenKararlar(o.db).length, 0, 'dongu devralinca karar acilmaz');
  o.temizle();
});

test('ayni testler kalmaya devam ederse insana gider; cevap dogrulama ciktisini tasir', async () => {
  const o = ortam();
  const { k, gorulen, sonuclar } = kur(o, { yapici: [kaldi], denetci: [{ sonuc: hukum('gecti') }] });
  const is = isEkle(o.db, { ad: 'fin', gorev: 'g', cwd: o.dizin, profil: 'serbest', donguTur: 5, dogrulama: 'python -m unittest' });
  k.siraya(is.id);
  await k.bekle();

  assert.deepEqual(gorulen.map((g) => g.rol), ['yapici', 'yapici']);
  assert.match(sonuclar.at(-1).neden, /ilerleme yok/);
  kararlariTazele(o.db);
  const [karar] = bekleyenKararlar(o.db);
  assert.equal(karar.tur, KARAR_TURU.DOGRULAMA);
  const { devamKosu } = cevapla(o.db, karar.id, 'Duzelt');
  assert.match(kosuGetir(o.db, devamKosu.id).devamCevabi, /Duzelt[\s\S]*test_hafta/, 'insan cevabiyla devam eden ajan da ciktiyi gorur');
  o.temizle();
});

test('dogrulama kaldi ve tur siniri 1 ise dogrudan insana', async () => {
  const o = ortam();
  const { k, gorulen, sonuclar } = kur(o, { yapici: [kaldi], denetci: [{ sonuc: hukum('gecti') }] });
  const is = isEkle(o.db, { ad: 'fin', gorev: 'g', cwd: o.dizin, profil: 'serbest', donguTur: 1, dogrulama: 'python -m unittest' });
  k.siraya(is.id);
  await k.bekle();
  assert.equal(gorulen.length, 1);
  assert.equal(sonuclar.at(-1).neden, 'tur siniri');
  kararlariTazele(o.db);
  assert.equal(bekleyenKararlar(o.db)[0].tur, KARAR_TURU.DOGRULAMA);
  o.temizle();
});

// --- Kapsam denetimi (saha: LiveDub yapicisi projeye yardimci betikler birakti) ---

test('kapsamDisi: desenler gitignore benzeri, kapsam yoksa kontrol yok', () => {
  const is = { kapsam: ['src/rapor.js', 'test/'] };
  assert.deepEqual(kapsamDisi(is, [{ yol: 'src/rapor.js' }, { yol: 'test/a/b.js' }, { yol: 'run_tests.py' }, { yol: 'src/kitap.js' }]),
    ['run_tests.py', 'src/kitap.js']);
  assert.deepEqual(kapsamDisi({ kapsam: null }, [{ yol: 'x.py' }]), []);
});

test('kapsam disi dosya denetci gecti dese de bulgu olur ve yeni tur acilir', async () => {
  const o = ortam();
  let n = 0;
  const donguDegisikligi = () => (++n === 1
    ? [{ durum: 'M', yol: 'src/rapor.js' }, { durum: 'A', yol: 'run_tests.py' }]
    : [{ durum: 'M', yol: 'src/rapor.js' }]);
  const { k, gorulen, sonuclar } = kur(o, { yapici: [yapildi], denetci: [{ sonuc: hukum('gecti') }] }, { donguDegisikligi });
  const is = isEkle(o.db, { ad: 'kap', gorev: 'g', cwd: o.dizin, profil: 'serbest', donguTur: 3, kapsam: 'src/rapor.js, test/' });
  assert.deepEqual(is.kapsam, ['src/rapor.js', 'test/']);
  k.siraya(is.id);
  await k.bekle();

  assert.deepEqual(gorulen.map((g) => g.rol), ['yapici', 'denetci', 'yapici', 'denetci']);
  assert.match(gorulen[1].gorev, /Gorev kapsami.*src\/rapor\.js, test\//);
  assert.match(gorulen[2].ekTalimat, /run_tests\.py: gorev kapsami disinda/);
  assert.equal(sonuclar[0].asama, 'denetim-siraya');
  assert.equal(sonuclar[1].asama, 'yeni-tur', 'model gecti dedi ama kapsam disi dosya isi geri cevirdi');
  assert.equal(sonuclar.at(-1).asama, 'gecti');
  o.temizle();
});

test('bulgu yazmasi yasak (gorev/kapsam celisen) dosyadaysa yeni tur acilmaz, dogrudan insana', async () => {
  // Saha (kampanya 6): config.yaml yazma yasakliyken 2. tur hicbir sey yapamadi, ~$0.18 bosa gitti.
  const o = ortam();
  const { k, gorulen, sonuclar } = kur(o, { yapici: [yapildi], denetci: [{ sonuc: hukum('kaldi', [B('config.yaml')]) }] });
  const is = isEkle(o.db, { ad: 'celiski', cwd: o.dizin, profil: 'serbest', donguTur: 3, kapsam: 'src/a.js',
    gorev: 'src/a.js degerleri config.yaml dosyasindan okusun ve config.yaml dosyasina anahtar ekle.' });
  k.siraya(is.id);
  await k.bekle();
  assert.deepEqual(gorulen.map((g) => g.rol), ['yapici', 'denetci'], 'ikinci yapici acilmaz');
  assert.equal(sonuclar.at(-1).asama, 'tikandi');
  assert.match(sonuclar.at(-1).neden, /kapsam celiskisi.*config\.yaml.*kapsami genislet/);
  kararlariTazele(o.db);
  const [karar] = bekleyenKararlar(o.db);
  assert.equal(karar.tur, KARAR_TURU.DENETIM);
  assert.match(karar.ayrinti, /kapsam celiskisi/);
  o.temizle();
});

test('celiski varken bulgu BASKA dosyadaysa dongu normal devam eder', async () => {
  const o = ortam();
  const { k, gorulen } = kur(o, { yapici: [yapildi], denetci: [{ sonuc: hukum('kaldi', [B('src/a.js')]) }, { sonuc: hukum('gecti') }] });
  const is = isEkle(o.db, { ad: 'celiski2', cwd: o.dizin, profil: 'serbest', donguTur: 3, kapsam: 'src/a.js',
    gorev: 'src/a.js degerleri config.yaml dosyasindan okusun.' });
  k.siraya(is.id);
  await k.bekle();
  assert.deepEqual(gorulen.map((g) => g.rol), ['yapici', 'denetci', 'yapici', 'denetci']);
  o.temizle();
});

test('kapsam celiskisi kararinda "kapsami genislet": kapsam guncellenir, ajan ayni donguyle devam eder, denetci yeniden bakar', async () => {
  const o = ortam();
  const { k, gorulen } = kur(o, { yapici: [yapildi], denetci: [{ sonuc: hukum('kaldi', [B('config.yaml')]) }, { sonuc: hukum('gecti') }] });
  const is = isEkle(o.db, { ad: 'genislet', cwd: o.dizin, profil: 'serbest', donguTur: 3, kapsam: 'src/a.js',
    gorev: 'src/a.js degerleri config.yaml dosyasindan okusun ve config.yaml dosyasina anahtar ekle.' });
  k.siraya(is.id);
  await k.bekle();
  kararlariTazele(o.db);
  const [karar] = bekleyenKararlar(o.db);
  const kart = kararKarti(o.db, karar);
  assert.equal(kart.secenekler[0].eylem, 'kapsam', 'kapsam genisletme ilk secenek');
  assert.match(kart.secenekler[0].etiket, /config\.yaml/);

  const r = kapsamGenislet(o.db, karar.id);
  assert.deepEqual(r.kapsam, ['src/a.js', 'config.yaml']);
  assert.deepEqual(isGetir(o.db, is.id).kapsam, ['src/a.js', 'config.yaml']);
  const devam = kosuGetir(o.db, r.devamKosu.id);
  assert.match(devam.devamCevabi, /Kapsam insan tarafindan genisletildi: config\.yaml/);
  assert.equal(devam.donguId, kosuGetir(o.db, karar.kosuId).donguId, 'ayni dongu');
  assert.throws(() => kapsamGenislet(o.db, karar.id), /kapali/);

  k.pompala();
  await k.bekle();
  assert.deepEqual(gorulen.map((g) => g.rol), ['yapici', 'denetci', 'yapici', 'denetci']);
  kararlariTazele(o.db);
  assert.equal(bekleyenKararlar(o.db).length, 0, 'genisletme sonrasi denetci gecti');
  o.temizle();
});

test('kapsam celiskisi olmayan kararda genisletme secenegi yok ve cagri reddedilir', async () => {
  const o = ortam();
  const { k } = kur(o, { yapici: [yapildi], denetci: [{ sonuc: hukum('kaldi', [B('a.js')]) }] });
  const is = isEkle(o.db, { ad: 'normal', gorev: 'g', cwd: o.dizin, profil: 'serbest', donguTur: 1 });
  k.siraya(is.id);
  await k.bekle();
  kararlariTazele(o.db);
  const [karar] = bekleyenKararlar(o.db);
  assert.ok(!kararKarti(o.db, karar).secenekler.some((s) => s.eylem === 'kapsam'));
  assert.throws(() => kapsamGenislet(o.db, karar.id), /kapsam celiskisi yok/);
  o.temizle();
});
