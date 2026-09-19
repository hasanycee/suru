import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OLAY } from '../src/events.js';
import { aracOzeti, olayCumlesi, anlat } from '../src/anlati.js';

test('aracOzeti: dosya adi, komut aciklamasi, desen; eksik/bozuk girdi patlatmaz', () => {
  assert.equal(aracOzeti('Read', { file_path: 'C:\\proje\\Assets\\Scripts\\SpectatorCamera.cs' }), 'okuyor: SpectatorCamera.cs');
  assert.equal(aracOzeti('Read', { file_path: '/a/b/x.py', offset: 120 }), 'okuyor: x.py (satir 120…)');
  assert.equal(aracOzeti('Edit', { file_path: 'src/a.js' }), 'duzenliyor: a.js');
  assert.equal(aracOzeti('Write', { file_path: 'yeni.md' }), 'yaziyor: yeni.md');
  assert.equal(aracOzeti('Grep', { pattern: 'VitalState', glob: '*.cs' }), 'ariyor: "VitalState" (*.cs)');
  assert.equal(aracOzeti('Bash', { command: 'npm test', description: 'Testleri kos' }), 'komut: Testleri kos');
  assert.match(aracOzeti('Bash', { command: 'x'.repeat(200) }), /^komut: x{69}…$/);
  assert.equal(aracOzeti('Task', { description: 'kod tabanini tara' }), 'alt ajan: kod tabanini tara');
  assert.equal(aracOzeti('BilinmeyenArac', { a: 1 }), 'BilinmeyenArac');
  assert.equal(aracOzeti('Read', null), 'okuyor: ?');
  assert.equal(aracOzeti('Read', 'dizgi'), 'okuyor: ?');
});

test('is yasam dongusu cumleleri: ton ve ses dogru', () => {
  const c = (asama, ek = {}) => olayCumlesi({ kind: OLAY.IS, data: { asama, ...ek } });
  assert.deepEqual(c('bitti', { usd: 0.107, turSayisi: 6, hataliMi: false }), { ses: 'bitti', metin: 'kosu bitti · $0.11 · 6 tur', ton: 'iyi' });
  assert.equal(c('bitti', { hataliMi: true, terminalNeden: 'budget_exhausted', usd: 0.19 }).ses, 'hata');
  assert.match(c('bitti', { hataliMi: true, terminalNeden: 'budget_exhausted', usd: 0.19 }).metin, /budget_exhausted/);
  assert.equal(c('dogrulandi', { gecti: true }).ton, 'iyi');
  assert.deepEqual(c('dogrulandi', { gecti: false, kod: 1 }), { ses: 'hata', metin: 'dogrulama KALDI (cikis 1)', ton: 'kotu' });
  assert.match(c('basladi', { model: 'claude-haiku-4-5-20251001' }).metin, /oturum acildi · haiku-4-5/);
  assert.match(c('worktree-acildi', { dal: 'suru/x-1' }).metin, /izole dalda/);
  // Gurultu olaylari satir olmaz
  assert.equal(c('git-taban'), null);
  assert.equal(c('zamanlama-atlandi'), null);
  assert.equal(c('hic-olmayan-asama'), null);
});

test('karar, arac, soz, hata, izin ve maliyet olaylari', () => {
  const k = olayCumlesi({ kind: OLAY.KARAR, data: { asama: 'acildi', soru: 'Planini hazirladi. Uygulasin mi?' } });
  assert.deepEqual(k, { ses: 'karar', metin: 'KARAR BEKLIYOR: Planini hazirladi. Uygulasin mi?', ton: 'soru' });
  assert.match(olayCumlesi({ kind: OLAY.KARAR, data: { asama: 'profil-degisti', onceki: 'danisan', yeni: 'denetimli', neden: 'plan onaylandi' } }).metin,
    /danisan → denetimli/);
  assert.equal(olayCumlesi({ kind: OLAY.ARAC, data: { arac: 'Read', ozet: 'okuyor: a.cs' } }).metin, 'okuyor: a.cs');
  assert.equal(olayCumlesi({ kind: OLAY.ARAC, data: { arac: 'Read' } }).metin, 'Read', 'ozetsiz eski olay ada duser');
  assert.equal(olayCumlesi({ kind: OLAY.ARAC, data: { arac: 'Grep', ozet: 'ariyor: "x"', altAjan: true } }).metin, '↳ ariyor: "x"');
  assert.equal(olayCumlesi({ kind: OLAY.SOZ, data: { metin: '  Dosyayi   inceliyorum.\n\nSonra duzeltecegim. ' } }).metin,
    'Dosyayi inceliyorum. Sonra duzeltecegim.');
  assert.equal(olayCumlesi({ kind: OLAY.SOZ, data: { metin: '' } }), null);
  assert.equal(olayCumlesi({ kind: OLAY.HATA, data: { nerede: 'golge', mesaj: 'disk dolu' } }).ses, 'hata');
  assert.equal(olayCumlesi({ kind: OLAY.IZIN, data: { arac: 'Bash', reddedildi: true } }).metin, 'izin reddedildi: Bash');
  assert.equal(olayCumlesi({ kind: OLAY.IZIN, data: { arac: 'Bash', reddedildi: false } }), null);
  assert.equal(olayCumlesi({ kind: OLAY.MALIYET, data: { girdi: 5 } }), null, 'maliyet satir degil sayac');
  assert.equal(olayCumlesi({ kind: 'bildirim', data: {} }), null);
  const a = anlat({ seq: 7, at: 1000, kind: OLAY.ARAC, sessionId: 's', project: 'p', data: { kosuId: 'k', arac: 'Read', ozet: 'okuyor: a' } });
  assert.deepEqual(a, { seq: 7, at: 1000, tur: 'arac', oturum: 's', proje: 'p', kosu: 'k', asama: null, metin: 'okuyor: a', ton: 'arac', ses: null });
  assert.equal(anlat({ seq: 1, kind: OLAY.MALIYET, data: {} }), null);
});
