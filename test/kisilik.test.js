import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kisilik, kadroCikar, ajanKimligi, kimlikAnahtari, KADRO_BOYU } from '../src/kisilik.js';

test('ayni oturum her zaman ayni kimligi alir', () => {
  const a = kisilik('a3f9b2c1-0000-0000-0000-000000000001');
  const b = kisilik('a3f9b2c1-0000-0000-0000-000000000001');
  assert.deepEqual(a, b);
  assert.ok(a.ad.length > 1);
  assert.ok(a.simge.length > 0);
});

test('farkli oturumlar genelde farkli ad alir', () => {
  const adlar = new Set();
  for (let i = 0; i < 200; i++) adlar.add(kisilik('oturum-' + i).ad);
  // Kadro boyu kadar cesitlilik beklenir; yarisindan azi cikarsa dagilim bozuk.
  assert.ok(adlar.size > KADRO_BOYU / 2, 'cesitlilik dusuk: ' + adlar.size);
});

test('renk tonu gecerli aralikta', () => {
  for (let i = 0; i < 50; i++) {
    const k = kisilik('x' + i);
    assert.ok(k.hue >= 0 && k.hue < 360);
    assert.match(k.renk, /^hsl\(/);
  }
});

test('ayni adli iki oturum kadroda ek ile ayrisir', () => {
  // Ayni ada dusen iki kimlik bul
  let a = null, b = null;
  for (let i = 0; i < 5000 && !b; i++) {
    const id = 'k' + i;
    const ad = kisilik(id).ad;
    if (!a) { a = { id, ad }; continue; }
    if (ad === a.ad && id !== a.id) b = { id, ad };
  }
  assert.ok(b, 'cakisan ad bulunamadi');

  const kadro = kadroCikar([a.id, b.id]);
  const x = kadro.get(a.id).ad, y = kadro.get(b.id).ad;
  assert.notEqual(x, y, 'cakisan adlar ayrismali');
  assert.ok(x.includes('-') && y.includes('-'), 'ek gelmis olmali');
});

test('cakisma yoksa ad sade kalir', () => {
  const kadro = kadroCikar(['tekil-oturum-kimligi']);
  assert.equal(kadro.get('tekil-oturum-kimligi').ad, kisilik('tekil-oturum-kimligi').ad);
});

// --- Kimlik anahtari ---

test('ise bagli kosunun kimligi isten gelir, oturumdan degil', () => {
  // Regresyon: kimlik oturumdan turetilirse ajan HER KOSUDA ad degistirir;
  // ne karne birikir ne piksel ofiste ayni karakter gorunur.
  const birinci = ajanKimligi({ isId: 'is-1', sessionId: 'oturum-a' });
  const ikinci  = ajanKimligi({ isId: 'is-1', sessionId: 'oturum-b' });
  assert.deepEqual(birinci, ikinci, 'ayni is, ayni ajan');

  const baskaIs = ajanKimligi({ isId: 'is-2', sessionId: 'oturum-a' });
  assert.notDeepEqual(birinci, baskaIs, 'farkli is, farkli ajan');
});

test('is yoksa oturum kimligi kullanilir', () => {
  // Elle acilmis oturumlarin isi yok: gozlem duzlemi bunlari oturumdan tanir.
  assert.equal(kimlikAnahtari({ sessionId: 'o1' }), 'o1');
  assert.equal(kimlikAnahtari({ isId: 'i1', sessionId: 'o1' }), 'i1');
  assert.deepEqual(ajanKimligi({ sessionId: 'o1' }), kisilik('o1'));
});
