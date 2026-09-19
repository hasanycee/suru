// Gizli kabul testi: gecikme hesabi. Gorunur testler bu hatayi yakalamaz.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { gecikmeGunu, ceza } = require(path.join(process.cwd(), 'src', 'odunc.js'));

test('son teslim gunu iade gecikme degil', () => {
  assert.equal(gecikmeGunu('2026-01-10', '2026-01-10'), 0);
});

test('bir gun gec = 1 gun', () => {
  assert.equal(gecikmeGunu('2026-01-10', '2026-01-11'), 1);
});

test('erken iade 0', () => {
  assert.equal(gecikmeGunu('2026-01-10', '2026-01-01'), 0);
});

test('ay gecisi', () => {
  assert.equal(gecikmeGunu('2026-01-30', '2026-02-02'), 3);
});

test('ceza gun sayisiyla carpilir', () => {
  assert.equal(ceza('2026-01-10', '2026-01-13', 5), 15);
});

test('gecersiz tarih hala reddedilir', () => {
  assert.throws(() => gecikmeGunu('10.01.2026', '2026-01-11'), TypeError);
});
