// Panel testi: panel.html'deki JS'in EN AZINDAN ayristigini garanti eder.
//
// Regresyon: panel.html icinde tek bir kacirilmis tirnak ("worktree'sinde")
// butun paneli komple bosalti - sayfa "Baglaniyor" yazip duruyordu. O sirada
// 327 birim testin hepsi geciyordu, cunku panelin icindeki JS hicbir zaman
// ayristirilmiyordu. Bu dosya o bosluk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const KOK = join(dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = readFileSync(join(KOK, 'src', 'panel.html'), 'utf8');

/** Sayfadaki gomulu <script> bloklari (src= ile disaridan gelenler haric). */
function betikler(html) {
  const bulunan = [];
  const kalip = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = kalip.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(m[1])) continue;      // disaridan yuklenen
    if (/type\s*=\s*["'](?!text\/javascript|module)/i.test(m[1])) continue;  // sablon vb.
    if (m[2].trim()) bulunan.push({ kod: m[2], konum: m.index });
  }
  return bulunan;
}

/** Hangi satirda patladigini soyleyebilmek icin: karakter -> satir numarasi. */
function satirNo(html, indeks) {
  return html.slice(0, indeks).split('\n').length;
}

test('panel.html en az bir gomulu betik iceriyor (test bos yere gecmesin)', () => {
  assert.ok(betikler(PANEL).length > 0, 'gomulu <script> bulunamadi - ayiklama kalibi bozulmus olabilir');
});

test('panel.html icindeki JS sozdizimsel olarak gecerli', () => {
  for (const { kod, konum } of betikler(PANEL)) {
    try {
      // Sadece AYRISTIRIR, calistirmaz: tarayici global'leri gerekmiyor.
      new Function(kod);
    } catch (e) {
      assert.fail('panel.html betigi ayrisamadi (yaklasik satir '
        + satirNo(PANEL, konum) + '): ' + e.message);
    }
  }
});

// Ofis de ayni tuzaga acik: tek sayfa, gomulu betik, sunucu testi onu gormuyor.
const OFIS = readFileSync(join(KOK, 'src', 'ofis.html'), 'utf8');

test('ofis.html icindeki JS sozdizimsel olarak gecerli', () => {
  const liste = betikler(OFIS);
  assert.ok(liste.length > 0, 'ofis.html icinde gomulu betik bulunamadi');
  for (const { kod, konum } of liste) {
    try { new Function(kod); }
    catch (e) { assert.fail('ofis.html betigi ayrisamadi (yaklasik satir ' + satirNo(OFIS, konum) + '): ' + e.message); }
  }
});

const KOMUTA = readFileSync(join(KOK, 'src', 'komuta.html'), 'utf8');

test('komuta.html icindeki JS sozdizimsel olarak gecerli ve kullandigi uclar sunucuda tanimli', () => {
  const liste = betikler(KOMUTA);
  assert.ok(liste.length > 0, 'komuta.html icinde gomulu betik bulunamadi');
  for (const { kod, konum } of liste) {
    try { new Function(kod); }
    catch (e) { assert.fail('komuta.html betigi ayrisamadi (yaklasik satir ' + satirNo(KOMUTA, konum) + '): ' + e.message); }
  }
  // Sayfanin cagirdigi her uc server.js'te olmali: ad degisirse sayfa sessizce bos kalir.
  const sunucu = readFileSync(join(KOK, 'src', 'server.js'), 'utf8');
  for (const uc of ['/komuta/veri', '/komuta/akis', '/komut', '/telegram', '/kosu/durdur', '/is/talimat',
    '/karar/cevapla', '/karar/iptal', '/karar/kabul', '/karar/kapsam', '/karar/uygula', '/geri-al/plan', '/geri-al',
    '/manifest.webmanifest', '/sw.js']) {
    assert.ok(KOMUTA.includes("'" + uc) || KOMUTA.includes('"' + uc), 'komuta.html ' + uc + ' ucunu kullanmiyor');
    assert.ok(sunucu.includes("'" + uc + "'"), 'server.js ' + uc + ' ucunu tanimlamiyor');
  }
  // Panelin hafiza ve MCP uclari da sunucuda olmali.
  for (const uc of ['/hafiza', '/hafiza/olgu', '/hafiza/sil', '/hafiza/olgu/duzenle', '/mcp-sunucular', '/sablonlar']) {
    assert.ok(PANEL.includes("'" + uc), 'panel.html ' + uc + ' ucunu kullanmiyor');
    assert.ok(sunucu.includes("'" + uc + "'"), 'server.js ' + uc + ' ucunu tanimlamiyor');
  }
});

test('panel formundaki alanlar gonderilen govdede de var', () => {
  // Forma alan eklenip gonderime eklenmezse alan sessizce calismaz.
  for (const alan of ['zamanlama', 'gitTetik', 'izolasyon', 'kapsam', 'dogrulama', 'denetciModel', 'mcp', 'mcpMod', 'sablon']) {
    assert.match(PANEL, new RegExp('name="' + alan + '"'), alan + ' formda olmali');
    assert.match(PANEL, new RegExp('form\\.' + alan + '\\.value'), alan + ' gonderilen govdede olmali');
  }
});
