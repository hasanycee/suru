// Gizli kabul testi: cakisma senaryosu - iki ajanin iki ozelligi AYNI dosyada.
// Ikisi de gecmeli: biri digerinin degisikligini ezdiyse (kayip guncelleme) kalir.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const k = require(path.join(process.cwd(), 'src', 'kitap.js'));

test('yazar aramasi buyuk/kucuk harf ve bosluktan bagimsiz', () => {
  k.temizle();
  k.kitapEkle({ id: '1', baslik: 'Kar', yazar: 'Orhan Pamuk' });
  assert.equal(k.yazaraGore('  orhan PAMUK ').length, 1);
  assert.equal(k.yazaraGore('Orhan Pamuk').length, 1);
});

test('gecerli yil saklanir', () => {
  k.temizle();
  assert.equal(k.kitapEkle({ id: '2', baslik: 'X', yazar: 'Y', yil: 1990 }).yil, 1990);
});

test('yil istege bagli', () => {
  k.temizle();
  assert.doesNotThrow(() => k.kitapEkle({ id: '3', baslik: 'X', yazar: 'Y' }));
});

test('gecersiz yil RangeError', () => {
  k.temizle();
  assert.throws(() => k.kitapEkle({ id: '4', baslik: 'X', yazar: 'Y', yil: 1200 }), RangeError);
  assert.throws(() => k.kitapEkle({ id: '5', baslik: 'X', yazar: 'Y', yil: 2999 }), RangeError);
  assert.throws(() => k.kitapEkle({ id: '6', baslik: 'X', yazar: 'Y', yil: 1990.5 }), RangeError);
});
