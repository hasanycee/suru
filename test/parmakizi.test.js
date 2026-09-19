import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parmakIzi, gitParmakIzi, dosyaParmakIzi } from '../src/parmakizi.js';

function klasor() {
  const d = mkdtempSync(join(tmpdir(), 'suru-iz-'));
  return { d, temizle: () => { try { rmSync(d, { recursive: true, force: true }); } catch { /* sonra */ } } };
}

const git = (cwd, ...args) => execFileSync('git',
  ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
  { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();

// --- Git disi ---

test('degismeyen proje ayni izi verir', () => {
  const k = klasor();
  writeFileSync(join(k.d, 'a.py'), 'x = 1', 'utf8');
  assert.equal(dosyaParmakIzi(k.d), dosyaParmakIzi(k.d));
  assert.match(parmakIzi(k.d), /^fs:/);
  k.temizle();
});

test('yeni dosya ve degisen dosya izi degistirir', () => {
  const k = klasor();
  writeFileSync(join(k.d, 'a.py'), 'x = 1', 'utf8');
  const ilk = dosyaParmakIzi(k.d);

  writeFileSync(join(k.d, 'b.py'), 'y = 2', 'utf8');
  const ikinci = dosyaParmakIzi(k.d);
  assert.notEqual(ikinci, ilk, 'yeni dosya');

  // Ayni boyutta icerik degisikligi: zaman damgasi yakalar
  writeFileSync(join(k.d, 'a.py'), 'x = 9', 'utf8');
  const ileri = new Date(Date.now() + 60_000);
  utimesSync(join(k.d, 'a.py'), ileri, ileri);
  assert.notEqual(dosyaParmakIzi(k.d), ikinci, 'degisen dosya');
  k.temizle();
});

test('node_modules ve __pycache__ degisiklikleri projeyi degistirmez', () => {
  const k = klasor();
  writeFileSync(join(k.d, 'a.py'), 'x = 1', 'utf8');
  const ilk = dosyaParmakIzi(k.d);
  mkdirSync(join(k.d, 'node_modules', 'paket'), { recursive: true });
  writeFileSync(join(k.d, 'node_modules', 'paket', 'i.js'), 'x', 'utf8');
  mkdirSync(join(k.d, '__pycache__'));
  writeFileSync(join(k.d, '__pycache__', 'a.pyc'), 'x', 'utf8');
  assert.equal(dosyaParmakIzi(k.d), ilk, 'uretilmis dosyalar sayilmamali');
  k.temizle();
});

test('git olmayan klasorde git izi null', () => {
  const k = klasor();
  assert.equal(gitParmakIzi(k.d), null);
  k.temizle();
});

// --- Git ---

test('git deposunda iz HEAD e dayanir, commit izi degistirir', () => {
  const k = klasor();
  git(k.d, 'init', '-q');
  writeFileSync(join(k.d, 'a.py'), 'x = 1', 'utf8');
  git(k.d, 'add', '-A'); git(k.d, 'commit', '-q', '-m', 'ilk');
  const ilk = parmakIzi(k.d);
  assert.match(ilk, /^git:/);

  writeFileSync(join(k.d, 'b.py'), 'y = 2', 'utf8');
  git(k.d, 'add', '-A'); git(k.d, 'commit', '-q', '-m', 'ikinci');
  assert.notEqual(parmakIzi(k.d), ilk, 'yeni commit');
  k.temizle();
});

test('commit edilmemis degisiklik de izi degistirir, tekrar degisince yine', () => {
  const k = klasor();
  git(k.d, 'init', '-q');
  writeFileSync(join(k.d, 'a.py'), 'x = 1', 'utf8');
  git(k.d, 'add', '-A'); git(k.d, 'commit', '-q', '-m', 'ilk');
  const temiz = parmakIzi(k.d);

  writeFileSync(join(k.d, 'a.py'), 'x = 2', 'utf8');
  const kirli1 = parmakIzi(k.d);
  assert.notEqual(kirli1, temiz, 'kirli calisma agaci');

  // Zaten degismis dosya tekrar degisirse yol listesi ayni kalir; zaman yakalamali
  writeFileSync(join(k.d, 'a.py'), 'x = 3', 'utf8');
  const ileri = new Date(Date.now() + 60_000);
  utimesSync(join(k.d, 'a.py'), ileri, ileri);
  assert.notEqual(parmakIzi(k.d), kirli1, 'ikinci degisiklik de gorulmeli');
  k.temizle();
});

test('olmayan klasor patlamaz', () => {
  assert.equal(parmakIzi(null), null);
  assert.match(String(parmakIzi(join(tmpdir(), 'kesinlikle-yok-' + Date.now()))), /^fs:/);
});

test('ust klasordeki depoya ait olmayan proje git izi KULLANMAZ', () => {
  // Regresyon (gercek projede yakalandi): LiveDub'in kendi deposu yok, ama ust
  // klasordeki 'AI projects' deposunun icinde. Git yukari cikip o deponun
  // HEAD'ini buluyordu; LiveDub izlenmedigi icin degisiklikleri hic gorunmuyordu.
  const k = klasor();
  git(k.d, 'init', '-q');
  writeFileSync(join(k.d, 'kok.txt'), 'x', 'utf8');
  git(k.d, 'add', '-A'); git(k.d, 'commit', '-q', '-m', 'ilk');

  const alt = join(k.d, 'altproje');
  mkdirSync(alt);
  writeFileSync(join(alt, 'a.py'), 'x = 1', 'utf8');   // ust depoda izlenmiyor

  assert.equal(gitParmakIzi(alt), null, 'deponun koku olmayan klasor git izine baglanmamali');
  const ilk = parmakIzi(alt);
  assert.match(ilk, /^fs:/, 'dosya taramasina dusmeli');

  // Alt projede izlenmeyen degisiklik gorulmeli
  writeFileSync(join(alt, 'b.py'), 'y = 2', 'utf8');
  const ikinci = parmakIzi(alt);
  assert.notEqual(ikinci, ilk, 'izlenmeyen alt projedeki degisiklik yakalanmali');

  // Ust depodaki baska bir degisiklik alt projeyi etkilememeli
  writeFileSync(join(k.d, 'kok.txt'), 'degisti', 'utf8');
  git(k.d, 'add', '-A'); git(k.d, 'commit', '-q', '-m', 'baska proje');
  assert.equal(parmakIzi(alt), ikinci, 'baska projedeki commit bu projenin olgularini bayatlatmamali');
  k.temizle();
});

test('deponun kokunde git izi kullanilir', () => {
  const k = klasor();
  git(k.d, 'init', '-q');
  writeFileSync(join(k.d, 'a.py'), 'x = 1', 'utf8');
  git(k.d, 'add', '-A'); git(k.d, 'commit', '-q', '-m', 'ilk');
  assert.match(String(gitParmakIzi(k.d)), /^git:/);
  k.temizle();
});
