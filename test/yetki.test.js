import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliArgumanlari, devamArgumanlari, PROFILLER, profilOzeti } from '../src/yetki.js';
import { SENARYOLAR, durumBelirle, nedenBelirle, DURUM } from '../src/yetki-canli.js';

test('Bash\'e ihtiyaci olmayan profiller --restricted ile kosar', () => {
  for (const ad of ['gozlemci', 'danisan']) {
    assert.ok(cliArgumanlari({ gorev: 'g', profil: ad, sessionId: 's' }).includes('--restricted'), ad);
    assert.ok(devamArgumanlari({ cevap: 'c', profil: ad, sessionId: 's' }).includes('--restricted'), ad + ' devam');
  }
  for (const ad of ['serbest', 'denetimli']) {
    assert.ok(!cliArgumanlari({ gorev: 'g', profil: ad, sessionId: 's' }).includes('--restricted'), ad);
  }
});

test('kisitli profillerde kod calistiran arac listede yok', () => {
  for (const ad of ['gozlemci', 'danisan']) {
    const araclar = PROFILLER[ad].araclar;
    assert.ok(araclar, ad + ' arac listesi acik olmali');
    assert.ok(!araclar.includes('Bash') && !araclar.includes('PowerShell'), ad);
  }
  assert.equal(profilOzeti().find((p) => p.ad === 'gozlemci').kisitli, true);
});

test('canli senaryo durumu: sonuc yoksa asla TUTTU degil', () => {
  assert.equal(durumBelirle({ tur: 'zorlama', sonucVar: false, ihlal: false }), DURUM.GECERSIZ);
  assert.equal(durumBelirle({ tur: 'olcum', sonucVar: false, ihlal: false }), DURUM.GECERSIZ);
  assert.equal(durumBelirle({ tur: 'zorlama', sonucVar: true, ihlal: false }), DURUM.TUTTU);
  assert.equal(durumBelirle({ tur: 'zorlama', sonucVar: true, ihlal: true }), DURUM.KALDI);
  assert.equal(durumBelirle({ tur: 'olcum', sonucVar: true, ihlal: true }), DURUM.ACIK);
});

test('canli senaryo nedeni: model reddi ile zorlama ayrilir', () => {
  assert.equal(nedenBelirle({ ihlal: true, redSayisi: 1 }), 'ihlal');
  assert.equal(nedenBelirle({ ihlal: false, redSayisi: 1 }), 'claude-engelledi');
  // Regresyon (saha): Read yasagi izin reddi kaydi uretmiyor, arac hatasi olarak donuyor.
  assert.equal(nedenBelirle({ ihlal: false, izinHatasi: true }), 'claude-engelledi');
  assert.equal(nedenBelirle({ ihlal: false, daraltilmis: true }), 'arac-listede-yok');
  assert.equal(nedenBelirle({ ihlal: false }), 'ajan-denemedi');
});

test('canli senaryolar tutarli tanimli', () => {
  const adlar = SENARYOLAR.map((s) => s.ad);
  assert.equal(new Set(adlar).size, adlar.length, 'adlar tekil');
  for (const s of SENARYOLAR) {
    assert.ok(['zorlama', 'olcum'].includes(s.tur), s.ad);
    assert.equal(typeof s.ihlal, 'function', s.ad);
    assert.ok(PROFILLER[s.profil], s.ad);
    if (s.tur === 'olcum') assert.ok(s.not, s.ad + ' olcum senaryosu ne sordugunu soylemeli');
  }
});
