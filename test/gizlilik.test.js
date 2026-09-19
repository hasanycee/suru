import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { openDb } from '../src/db.js';
import { OLAY, oku as olayOku } from '../src/events.js';
import { isEkle, kosuAc } from '../src/isler.js';
import { kosuBaslat } from '../src/kosucu.js';
import {
  desenNormal, desenRegex, yolEslesen, izinKurallari, projeGizliligi, projeGizliliginiYaz, VARSAYILAN_YOLLAR,
} from '../src/gizlilik.js';
import { kosuDefteri, defterYaz, defterKirp, ozet, AKIS } from '../src/veriakisi.js';

const TAKLIT = join(dirname(fileURLToPath(import.meta.url)), 'sahte', 'claude-taklit.mjs');

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-gizlilik-'));
  return { dizin, temizle: () => { try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra */ } } };
}

test('desenler gitignore benzeri normallesir; tehlikeli desen reddedilir', () => {
  assert.equal(desenNormal('*.pem'), '**/*.pem');
  assert.equal(desenNormal('secrets/'), '**/secrets/**');
  assert.equal(desenNormal('data/musteri/'), 'data/musteri/**');
  assert.equal(desenNormal('./data/x.csv'), 'data/x.csv');
  assert.equal(desenNormal('/kok.txt'), 'kok.txt');
  assert.equal(desenNormal('data\\musteri\\'), 'data/musteri/**');
  for (const kotu of ['', '# yorum', '!istisna', '../disari', 'a/../b', 'C:/mutlak', 'bozuk(parantez)']) {
    assert.equal(desenNormal(kotu), null, JSON.stringify(kotu));
  }
});

test('desen eslesmesi: derinlik, klasor ve kok sabitleme', () => {
  const e = (d, y) => desenRegex(desenNormal(d), { buyukKucuk: true }).test(y);
  assert.ok(e('*.pem', 'anahtar.pem'));
  assert.ok(e('*.pem', 'a/b/c.pem'));
  assert.ok(!e('*.pem', 'a.pem.txt'));
  assert.ok(e('secrets/', 'secrets/x.txt'));
  assert.ok(e('secrets/', 'alt/secrets/y/z.txt'));
  assert.ok(!e('secrets/', 'secretsx/y'));
  assert.ok(e('data/musteri/', 'data/musteri/k.txt'));
  assert.ok(!e('data/musteri/', 'x/data/musteri/k.txt'), 'egik cizgili desen koke sabit');
  assert.ok(e('/kok.txt', 'kok.txt'));
  assert.ok(!e('/kok.txt', 'alt/kok.txt'));
});

test('yolEslesen: proje ici goreli/mutlak yol, proje disi yok sayilir', () => {
  const g = { desenler: ['**/musteri/**'] };
  const cwd = join(tmpdir(), 'proje');
  assert.equal(yolEslesen(g, cwd, join(cwd, 'musteri', 'a.txt')), '**/musteri/**');
  assert.equal(yolEslesen(g, cwd, 'musteri/a.txt'), '**/musteri/**');
  assert.equal(yolEslesen(g, cwd, join(cwd, 'kod.js')), null);
  assert.equal(yolEslesen(g, cwd, join(tmpdir(), 'baska', 'musteri', 'a.txt')), null);
  assert.equal(yolEslesen(null, cwd, 'musteri/a.txt'), null);
});

test('izin kurallari okuma+yazma+duzenleme; web yasagi araci butunuyle kaldirir', () => {
  assert.deepEqual(izinKurallari(['**/musteri/**']),
    ['Read(./**/musteri/**)', 'Edit(./**/musteri/**)', 'Write(./**/musteri/**)']);
  assert.deepEqual(izinKurallari([], { webYasak: true }), ['WebFetch', 'WebSearch']);
});

test('proje gizliligi dosyaya yazilir, varsayilanla birlesir, gecersiz desen hicbir sey yazmaz', () => {
  const o = ortam();
  const yol = join(o.dizin, 'gizlilik.json');
  const cwd = join(o.dizin, 'proje');
  assert.deepEqual(projeGizliligi(cwd, { yol }).yollar, VARSAYILAN_YOLLAR);

  const g = projeGizliliginiYaz(cwd, { yollar: ['musteri/', '# not', ''], webYasak: true }, { yol });
  assert.deepEqual(g.projeYollari, ['musteri/']);
  assert.ok(g.desenler.includes('**/musteri/**') && g.desenler.includes('**/*.pem'));
  assert.equal(g.webYasak, true);

  assert.throws(() => projeGizliliginiYaz(cwd, { yollar: ['iyi/', '!kotu'] }, { yol }), /gecersiz desen/);
  assert.deepEqual(projeGizliligi(cwd, { yol }).projeYollari, ['musteri/'], 'hatali yazim oncekini bozmaz');
  assert.deepEqual(projeGizliligi(join(o.dizin, 'baska'), { yol }).projeYollari, []);
  o.temizle();
});

test('defter: gizli yol modele gittiyse satir ihlal tasir; ozet ve kirpma calisir', () => {
  const o = ortam();
  const db = openDb(join(o.dizin, 'v.db'));
  const cwd = join(o.dizin, 'proje');
  const is = { cwd };
  const gizlilik = { desenler: ['**/musteri/**'] };
  const zincir = {
    adimlar: [{ arac: 'Grep', girdi: 'SIR', hata: false }, { arac: 'Glob', girdi: '*.x', hata: true }],
    veriAkisi: {
      modeleGidenDosyalar: [join(cwd, 'musteri', 'k.txt'), join(cwd, 'kod.js')],
      calistirilanKomutlar: ['npm test'],
      disariIstekler: ['https://ornek.com/a', 'hava durumu'],
    },
  };
  const satirlar = kosuDefteri({ kosu: { id: 'k1' }, is, zincir, gizlilik, istemBoyutu: 120, simdi: 1000,
    baglamDosyalari: [{ yol: join(cwd, 'CLAUDE.md'), bayt: 50 }] });
  const turler = satirlar.map((s) => s.tur);
  assert.deepEqual(turler, [AKIS.ISTEM, AKIS.BAGLAM, AKIS.DOSYA, AKIS.DOSYA, AKIS.ARAMA, AKIS.KOMUT, AKIS.WEB, AKIS.WEB]);
  assert.deepEqual(satirlar.filter((s) => s.ihlal).map((s) => s.ayrinti), [join(cwd, 'musteri', 'k.txt')]);
  assert.deepEqual(satirlar.filter((s) => s.tur === AKIS.WEB).map((s) => s.hedef), ['ornek.com', 'web-arama']);

  defterYaz(db, satirlar);
  defterYaz(db, [{ zaman: 1000, tur: AKIS.BILDIRIM, hedef: 'ntfy', ayrinti: 'x', proje: null }]);
  const oz = ozet(db, { cwd, gun: 1, simdi: 2000 });
  assert.equal(oz.kosu, 1);
  assert.equal(oz.ihlaller.length, 1);
  assert.equal(oz.ihlaller[0].ihlal, '**/musteri/**');
  assert.equal(oz.dosyalar.length, 3);
  assert.equal(ozet(db, { gun: 1, simdi: 2000 }).bildirim[0].hedef, 'ntfy');
  assert.equal(defterKirp(db, { gun: 1, simdi: 1000 + 2 * 86_400_000 }), satirlar.length + 1);
  db.close();
  o.temizle();
});

test('kosucu: gizli yollar izin kurali olur, web yasagi araci listeden cikarir, defter yazilir', async () => {
  const o = ortam();
  const db = openDb(join(o.dizin, 'k.db'));
  const argDosyasi = join(o.dizin, 'args.json');
  const is = isEkle(db, { ad: 'gizli', gorev: 'rapor yaz', cwd: o.dizin, profil: 'gozlemci' });
  const kosu = kosuAc(db, is.id);
  const r = await kosuBaslat(db, {
    is, kosu, komut: process.execPath,
    spawnFn: (k, a, opt) => spawn(k, [TAKLIT, ...a], { ...opt, shell: false }),
    env: { ...process.env, SAHTE_SENARYO: 'basarili', SAHTE_ARG_DOSYASI: argDosyasi },
    hafizaAyari: { etkin: false },
    gizlilikOku: () => ({ yollar: ['musteri/'], desenler: ['**/musteri/**'], webYasak: true }),
    projelerDizini: join(o.dizin, 'transkript-yok'),
  });
  assert.equal(r.gizlilikIhlali, 0);

  const args = JSON.parse(readFileSync(argDosyasi, 'utf8'));
  const araclar = args[args.indexOf('--tools') + 1].split(',');
  assert.ok(!araclar.includes('WebFetch') && !araclar.includes('WebSearch'), 'web araci yuklenmez');
  const ayarYolu = args[args.indexOf('--settings') + 1];
  assert.ok(existsSync(ayarYolu));
  const deny = JSON.parse(readFileSync(ayarYolu, 'utf8')).permissions.deny;
  assert.ok(deny.includes('Read(./**/musteri/**)') && deny.includes('Write(./**/musteri/**)'));
  assert.ok(deny.includes('RemoteTrigger'), 'kanarya korunur');
  assert.ok(!ayarYolu.endsWith('gozlemci.json'), 'projeye ozel ayar dosyasi, genel profil dosyasi ezilmez');

  const satir = db.prepare("SELECT * FROM veri_akisi WHERE kosu_id = ? AND tur = 'istem'").get(kosu.id);
  assert.ok(satir && satir.boyut > 0, 'istem defterde');
  assert.ok(!olayOku(db, { kind: OLAY.HATA }).some((e) => e.data.nerede === 'gizlilik'));
  db.close();
  o.temizle();
});

test('defter: koda gomulu sir her zaman ihlal satiri uretir (yol yasagi olmasa da)', () => {
  const satirlar = kosuDefteri({ kosu: { id: 'k2' }, is: { cwd: join(tmpdir(), 'p') }, gizlilik: null, simdi: 1,
    zincir: { adimlar: [], veriAkisi: { modeleGidenDosyalar: [], calistirilanKomutlar: [], disariIstekler: [] },
      sirlar: [{ tur: 'huggingface', maske: 'hf_Q…(37)', arac: 'Read', girdi: 'server.py' }] } });
  const sir = satirlar.find((s) => s.tur === AKIS.SIR);
  assert.equal(sir.ihlal, 'sir:huggingface');
  assert.match(sir.ayrinti, /server\.py/);
});
