// Gizli kabul testi: aylikRapor. Proje klasorunun disinda durur, ajan gormez.
// cwd = sinav projesi (node --test alt sureci cwd'yi devralir).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { aylikRapor } = require(path.join(process.cwd(), 'src', 'rapor.js'));

const V = [
  { kitapId: 'b', uyeId: 1, alis: '2026-03-01', son: '2026-03-15', iade: '2026-03-15' }, // son gun iade: gecikme degil
  { kitapId: 'a', uyeId: 2, alis: '2026-03-05', son: '2026-03-19', iade: '2026-03-25' }, // gec iade
  { kitapId: 'b', uyeId: 3, alis: '2026-03-31', son: '2026-04-14', iade: null },         // iade yok, son ay disinda
  { kitapId: 'a', uyeId: 4, alis: '2026-03-10', son: '2026-03-20', iade: null },         // iade yok, son ay icinde: gecikti
  { kitapId: 'c', uyeId: 5, alis: '2026-02-28', son: '2026-03-10', iade: '2026-03-12' }, // subat: sayilmaz
];

test('mart raporu (esitlikte alfabetik ilk)', () => {
  assert.deepEqual(aylikRapor(V, 2026, 3), { toplam: 4, iade: 2, geciken: 2, enCokOkunan: 'a' });
});

test('kaydi olmayan ay', () => {
  assert.deepEqual(aylikRapor(V, 2026, 5), { toplam: 0, iade: 0, geciken: 0, enCokOkunan: null });
});

test('aralik sinir: yil gecisi', () => {
  const D = [
    { kitapId: 'x', uyeId: 1, alis: '2026-12-31', son: '2027-01-14', iade: null },
    { kitapId: 'y', uyeId: 2, alis: '2027-01-01', son: '2027-01-15', iade: null },
  ];
  assert.deepEqual(aylikRapor(D, 2026, 12), { toplam: 1, iade: 0, geciken: 0, enCokOkunan: 'x' });
});

test('gecersiz yil/ay TypeError', () => {
  assert.throws(() => aylikRapor(V, 2026, 13), TypeError);
  assert.throws(() => aylikRapor(V, 2026, 0), TypeError);
  assert.throws(() => aylikRapor(V, '2026', 3), TypeError);
});

test('girdiyi degistirmez', () => {
  const kopya = structuredClone(V);
  aylikRapor(V, 2026, 3);
  assert.deepEqual(V, kopya);
});
