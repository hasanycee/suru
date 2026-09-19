// Denetci farki: uretilmis dosyalar fark metnine girmez, sadece sayilir.
// Regresyon (olculdu, KorkuOyunu): Unity commitlerinde fark 8 000 karakter sinirini
// 14 committen 11inde asti; denetci degisikligin ~%1ini, cogunlukla .meta satirlarini goruyordu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uretilmisMi, degisiklikOzeti, anlikGoruntu, farkMetni } from '../src/golge.js';
import { denetimGorevi } from '../src/dongu.js';

test('uretilmis dosya desenleri: unity, kilit dosyalari, kucultulmus', () => {
  for (const y of ['Assets/Oyuncu.cs.meta', 'Assets/Sahne.unity', 'a/b/Karakter.prefab',
    'package-lock.json', 'web/app.min.js', 'Assets\\Veri.asset']) assert.ok(uretilmisMi(y), y);
  for (const y of ['Assets/Scripts/Oyuncu.cs', 'src/app.js', 'package.json', 'README.md', 'meta.js'])
    assert.ok(!uretilmisMi(y), y);
});

test('degisiklik ozeti kodu ayirir, uretilmisleri uzantiya gore sayar', () => {
  const d = [
    { durum: 'M', yol: 'Assets/Scripts/Oyuncu.cs' },
    ...Array.from({ length: 300 }, (_, i) => ({ durum: 'A', yol: 'Assets/x' + i + '.png.meta' })),
    ...Array.from({ length: 5 }, (_, i) => ({ durum: 'M', yol: 'Assets/s' + i + '.prefab' })),
  ];
  const o = degisiklikOzeti(d);
  assert.deepEqual(o.kod.map((x) => x.yol), ['Assets/Scripts/Oyuncu.cs']);
  assert.equal(o.uretilmisToplam, 305);
  assert.deepEqual(o.uretilmis[0], { ek: '.meta', n: 300 });
});

test('GERCEK golge: uretilmisHaric farkta kod kalir, .meta gurultusu cikar', () => {
  const kok = mkdtempSync(join(tmpdir(), 'suru-fark-'));
  const proje = join(kok, 'proje'); mkdirSync(join(proje, 'Assets'), { recursive: true });
  writeFileSync(join(proje, 'Assets', 'Oyuncu.cs'), 'class A {}\n');
  const once = anlikGoruntu(proje, 't-once', { kok: join(kok, 'g') });
  writeFileSync(join(proje, 'Assets', 'Oyuncu.cs'), 'class A { int can = 3; }\n');
  for (let i = 0; i < 200; i++) writeFileSync(join(proje, 'Assets', 'd' + i + '.png.meta'), 'guid: ' + 'x'.repeat(60) + i + '\n');
  const sonra = anlikGoruntu(proje, 't-sonra', { kok: join(kok, 'g') });

  const ham = farkMetni(proje, once, sonra, { kok: join(kok, 'g'), enFazla: 8000 });
  const temiz = farkMetni(proje, once, sonra, { kok: join(kok, 'g'), enFazla: 8000, uretilmisHaric: true });
  assert.match(ham, /fark kirpildi/, 'ham fark sinira dayanmali (on kosul)');
  assert.match(temiz, /int can = 3/, 'kod degisikligi gorunmeli');
  assert.doesNotMatch(temiz, /\.meta/, '.meta farki olmamali');
  assert.doesNotMatch(temiz, /kirpildi/);
  try { rmSync(kok, { recursive: true, force: true }); } catch { /* */ }
});

test('denetim paketi: once kod dosyalari, uretilmisler tek satir ozet', () => {
  const degisiklik = [
    ...Array.from({ length: 4000 }, (_, i) => ({ durum: 'A', yol: 'Assets/t' + i + '.meta' })),
    { durum: 'M', yol: 'Assets/Scripts/Oyuncu.cs' },
  ];
  const g = denetimGorevi({ is: { gorev: 'x' }, yapiciKosu: { sonuc: 'r' }, golge: { degisiklik, fark: '+kod' } });
  assert.match(g, /M Assets\/Scripts\/Oyuncu\.cs/, 'kod dosyasi listede (60 sinirinin arkasinda kaybolmamali)');
  assert.match(g, /4000 uretilmis dosya/);
  assert.match(g, /\.meta: 4000/);
  assert.ok(g.length < 6000, 'paket 4000 satirla sismemeli: ' + g.length);
});

// --- Golge disk kontrolu ---
import { ilkGoruntuDiskKontrol, GOLGE_EN_AZ_BOS } from '../src/golge.js';

test('ilk goruntu: disk yetmiyorsa ATLANIR, yetiyorsa alinir, sonrakiler kontrol edilmez', () => {
  const kok = mkdtempSync(join(tmpdir(), 'suru-disk-'));
  const proje = join(kok, 'p'); mkdirSync(proje);
  writeFileSync(join(proje, 'buyuk.bin.dat'), Buffer.alloc(2 * 1024 * 1024));   // 2 MB
  const g = join(kok, 'g');
  const az = () => GOLGE_EN_AZ_BOS + 1024 * 1024;       // yazinca 5 GB'nin altina iner
  const cok = () => GOLGE_EN_AZ_BOS + 1024 ** 3;

  assert.equal(ilkGoruntuDiskKontrol(proje, g, { bosBaytFn: az }).tamam, false);
  assert.throws(() => anlikGoruntu(proje, 'd-1', { kok: g, bosBaytFn: az }), /disk yetersiz/);
  const c1 = anlikGoruntu(proje, 'd-2', { kok: g, bosBaytFn: cok });
  assert.ok(c1, 'yer varken goruntu alinmali');
  // Golge deposu artik var: ikinci goruntu disk dar olsa da alinir (yer kaplamaz).
  assert.ok(anlikGoruntu(proje, 'd-3', { kok: g, bosBaytFn: az }));
  try { rmSync(kok, { recursive: true, force: true }); } catch { /* */ }
});
