import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zincirCikar, transkriptBul, kanitZinciri, kanitMetni, girdiOzeti } from '../src/kanit.js';

const asistan = (content, ek = {}) => ({ type: 'assistant', timestamp: 't', message: { content }, ...ek });
const kullanici = (content, ek = {}) => ({ type: 'user', message: { content }, ...ek });

const ORNEK = [
  { type: 'queue-operation' },
  asistan([{ type: 'tool_use', id: 'a1', name: 'Read', input: { file_path: 'C:/p/a.py' } }]),
  kullanici([{ type: 'tool_result', tool_use_id: 'a1', content: 'dosya icerigi' }]),
  asistan([
    { type: 'text', text: 'Testler muhtemelen eksik. Simdi calistiriyorum.' },
    { type: 'tool_use', id: 'a2', name: 'Bash', input: { command: 'pytest -q' } },
  ]),
  kullanici([{ type: 'tool_result', tool_use_id: 'a2', is_error: true, content: [{ type: 'text', text: 'exit 1' }] }]),
  asistan([{ type: 'tool_use', id: 'a3', name: 'Edit', input: { file_path: 'C:/p/a.py', old_string: 'x', new_string: 'y' } }]),
  kullanici([{ type: 'tool_result', tool_use_id: 'a3', content: 'guncellendi' }]),
  asistan([{ type: 'tool_use', id: 'a4', name: 'WebFetch', input: { url: 'https://ornek.com' } }], { isSidechain: true }),
  asistan([{ type: 'tool_use', id: 'a5', name: 'Read', input: { file_path: 'C:/p/.env' } }]),
  kullanici([{ type: 'tool_result', tool_use_id: 'a5', is_error: true, content: 'Permission to read C:/p/.env has been denied.' }]),
];

test('arac cagrilari sonuclariyla tool_use_id uzerinden eslenir', () => {
  const z = zincirCikar(ORNEK);
  assert.equal(z.sayac.adim, 5);
  assert.deepEqual(z.adimlar.map((a) => a.arac), ['Read', 'Bash', 'Edit', 'WebFetch', 'Read']);
  assert.equal(z.adimlar[0].sonuc, 'dosya icerigi');
  assert.equal(z.adimlar[1].hata, true);
  assert.equal(z.adimlar[1].reddedildi, false, 'sifirdan farkli cikis kodu izin reddi degil');
  assert.equal(z.adimlar[3].sonuc, null, 'sonucu gelmeyen adim null kalir');
  assert.equal(z.adimlar[3].altAjan, true);
  assert.equal(z.adimlar[4].reddedildi, true);
  assert.equal(z.sayac.hata, 2);
  assert.equal(z.sayac.reddedilen, 1);
});

test('veri akisi SONUCA gore: reddedilen okuma ve sonucsuz istek modele gitmis sayilmaz', () => {
  // Regresyon: ilk surum denemeyi sayiyordu; yasak calistiginda bile gizli dosya
  // "modele gitti" gorunur, veri akisi defteri sahte ihlal uretirdi.
  const { veriAkisi } = zincirCikar(ORNEK);
  assert.deepEqual(veriAkisi.modeleGidenDosyalar, ['C:/p/a.py']);
  assert.deepEqual(veriAkisi.degistirilenDosyalar, ['C:/p/a.py']);
  assert.deepEqual(veriAkisi.calistirilanKomutlar, ['pytest -q'], 'hatali cikisli komut yine calismistir');
  assert.deepEqual(veriAkisi.disariIstekler, [], 'sonucu gelmeyen web istegi sayilmaz');
});

test('izin reddiyle donen Bash komutu calistirilmis sayilmaz', () => {
  const z = zincirCikar([
    asistan([{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'git push' } }]),
    kullanici([{ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: 'This command requires approval' }]),
  ]);
  assert.deepEqual(z.veriAkisi.calistirilanKomutlar, []);
  assert.equal(z.sayac.reddedilen, 1);
});

test('belirsizlik cumlesi yakalanir, onceki adima baglanir; kesin cumle yakalanmaz', () => {
  const z = zincirCikar(ORNEK);
  assert.equal(z.belirsizlikler.length, 1);
  assert.equal(z.belirsizlikler[0].cumle, 'Testler muhtemelen eksik.');
  assert.equal(z.belirsizlikler[0].oncekiAdim, 1);
});

test('risk tablosu satiri ve "olabilir" belirsizlik sayilmaz', () => {
  // Regresyon (saha): LiveDub raporundaki risk tablosu yanlis alarm verdi.
  const z = zincirCikar([asistan([{ type: 'text',
    text: '| speakers.py | hatalar kayba neden olabilir. |\nBu durum sorun olabilir.' }])]);
  assert.equal(z.belirsizlikler.length, 0);
});

test('adim siniri asilinca kirpilir ama sayac gercek sayiyi verir', () => {
  const z = zincirCikar(ORNEK, { enFazlaAdim: 2 });
  assert.equal(z.adimlar.length, 2);
  assert.equal(z.sayac.adim, 5);
  assert.equal(z.kirpildi, true);
  assert.deepEqual(z.veriAkisi.modeleGidenDosyalar, ['C:/p/a.py'], 'kirpma veri akisini etkilemez');
});

test('bozuk ve ilgisiz kayitlar zinciri bozmaz', () => {
  const z = zincirCikar([null, {}, { type: 'user', message: { content: 'duz metin' } },
    kullanici([{ type: 'tool_result', tool_use_id: 'yok', content: 'x' }])]);
  assert.equal(z.sayac.adim, 0);
});

test('girdi ozeti uzun komutu kisaltir, desen+yol birlestirir', () => {
  assert.equal(girdiOzeti('Glob', { pattern: '**/*.py', path: 'C:/p' }), '**/*.py @ C:/p');
  assert.ok(girdiOzeti('Bash', { command: 'a'.repeat(500) }).length <= 160);
});

test('transkript proje klasoru bilinmeden bulunur ve metne doner', () => {
  const kok = mkdtempSync(join(tmpdir(), 'suru-kanit-'));
  try {
    mkdirSync(join(kok, 'C--proje'));
    writeFileSync(join(kok, 'C--proje', 'oturum-1.jsonl'),
      ORNEK.map((s) => JSON.stringify(s)).join('\n') + '\n{yarim satir');
    assert.equal(transkriptBul('oturum-1', { projelerDizini: kok }), join(kok, 'C--proje', 'oturum-1.jsonl'));
    assert.equal(transkriptBul('yok', { projelerDizini: kok }), null);
    const z = kanitZinciri('oturum-1', { projelerDizini: kok });
    assert.equal(z.sayac.adim, 5);
    const m = kanitMetni(z);
    assert.match(m, /5 adim, 2 hata \(1 izin reddi\)/);
    assert.match(m, /2\. Bash: pytest -q {2}\[HATA\]/);
    assert.match(m, /5\. Read: C:\/p\/\.env {2}\[REDDEDILDI\]/);
    assert.match(m, /emin olmadigi/);
    assert.match(kanitMetni(null), /bulunamadi/);
  } finally { rmSync(kok, { recursive: true, force: true }); }
});

test('koda gomulu sir tespit edilir, deger saklanmaz ve gorunur sonucta maskelenir', () => {
  // Saha: Chatbot server.py icinde acik metin Hugging Face anahtari. Sahte deger:
  const sahte = 'hf_' + 'Q'.repeat(34);
  const z = zincirCikar([
    asistan([{ type: 'tool_use', id: 's1', name: 'Read', input: { file_path: 'C:/p/server.py' } }]),
    kullanici([{ type: 'tool_result', tool_use_id: 's1', content: 'HF_TOKEN = "' + sahte + '"' }]),
    asistan([{ type: 'text', text: 'Anahtar su: ' + sahte }]),
  ]);
  assert.equal(z.sayac.sir, 2);
  assert.deepEqual(z.sirlar.map((x) => x.arac), ['Read', 'yanit']);
  assert.equal(z.sirlar[0].tur, 'huggingface');
  assert.ok(!JSON.stringify(z).includes(sahte), 'tam deger zincirin hicbir yerinde yok');
  assert.match(z.adimlar[0].sonuc, /hf_Q…\(37\)/);
  assert.match(kanitMetni(z), /UYARI: modele sir benzeri deger gitti: huggingface/);
});

test('sir kaliplari: bilinen bicimler yakalanir, siradan metin yakalanmaz', async () => {
  const { sirBul } = await import('../src/kanit.js');
  const ornek = ['AKIA' + 'ABCDEFGHIJKLMNOP', 'ghp_' + 'a'.repeat(36), 'sk-ant-' + 'b'.repeat(30), '-----BEGIN RSA PRIVATE KEY-----'];
  assert.deepEqual(sirBul(ornek.join(' ')).map((x) => x.tur), ['openai-anthropic', 'github', 'aws', 'ozel-anahtar']);
  assert.deepEqual(sirBul('hf_kisa sk-deneme ghp_yok api_key = os.environ["X"]'), []);
});
