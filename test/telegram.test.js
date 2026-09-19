import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, kvOku } from '../src/db.js';
import { isEkle, kosuAc, kosuGuncelle, KOSU_DURUMU } from '../src/isler.js';
import { kararlariTazele, bekleyenKararlar, kararGetir, KARAR_DURUMU } from '../src/eskalasyon.js';
import { Telegram, parcala } from '../src/telegram.js';
import { komutCalistir, kisa } from '../src/komut.js';
import { kanalKur } from '../src/kanallar.js';
import { VARSAYILAN } from '../src/config.js';

/** Sahte Telegram API: hicbir sey disari gitmez; cagrilar kaydedilir, getUpdates kuyruktan verilir. */
function sahteApi() {
  const cagrilar = [];
  const kuyruk = [];
  const fetchFn = async (url, sec) => {
    const yontem = url.split('/').pop();
    const govde = JSON.parse(sec.body);
    cagrilar.push({ yontem, govde });
    if (yontem === 'getUpdates') return { ok: true, json: async () => ({ ok: true, result: kuyruk.splice(0) }) };
    if (yontem === 'patlat') return { ok: false, status: 500, json: async () => ({ ok: false, description: 'bozuk' }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  return { cagrilar, kuyruk, fetchFn,
    gonderilen: () => cagrilar.filter((c) => c.yontem === 'sendMessage').map((c) => c.govde) };
}

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-tg-'));
  const db = openDb(join(dizin, 't.db'));
  const proje = join(dizin, 'p'); mkdirSync(proje);
  const api = sahteApi();
  const kuyruk = { siraya: (isId) => kosuAc(db, isId), pompala: () => {}, durum: () => ({ esZamanli: 2, calisan: 0, bekleyen: 0 }),
    kosuDurdur: () => ({ durum: 'x' }), isKosulariniDurdur: () => [] };
  const tg = new Telegram(db, { token: 'sahte-token', api: 'http://sahte', fetchFn: api.fetchFn,
    komut: (m) => komutCalistir(m, { db, kuyruk }) });
  return { db, dizin, proje, api, tg, kuyruk,
    temizle: () => { db.close(); try { rmSync(dizin, { recursive: true, force: true }); } catch { /* */ } } };
}

let sayac = 1;
const mesaj = (sohbet, text) => ({ update_id: sayac++, message: { chat: { id: sohbet }, text } });
const dugme = (sohbet, data) => ({ update_id: sayac++, callback_query: { id: 'cb' + sayac, data, message: { chat: { id: sohbet } } } });

test('token yoksa kurulmaz; kurulunca eslestirme kodu uretilir ve token adres disinda gorunmez', () => {
  const o = ortam();
  try {
    assert.throws(() => new Telegram(o.db, { token: null, komut: () => {} }), /token tanimli degil/);
    const d = o.tg.durum();
    assert.equal(d.eslesti, false);
    assert.match(d.kod, /^\d{6}$/);
    assert.equal(kanalKur({ ...VARSAYILAN, bildirim: { ...VARSAYILAN.bildirim, kanal: 'telegram' } }, { telegram: o.tg }).ad, 'telegram');
    // telegram nesnesi verilmeden 'telegram' kanali secilirse gunluge duser, patlamaz
    assert.equal(kanalKur({ ...VARSAYILAN, bildirim: { ...VARSAYILAN.bildirim, kanal: 'telegram' } }).ad, 'gunluk');
  } finally { o.temizle(); }
});

test('yabanci sohbet sessizce yok sayilir; dogru kod eslestirir ve kod yenilenir', async () => {
  const o = ortam();
  try {
    const kod = o.tg.eslestirmeKodu();
    o.api.kuyruk.push(mesaj(111, '/durum'), mesaj(111, '123456'), dugme(111, 'k:abc:1'));
    let r = await o.tg.tur();
    assert.deepEqual(r.map((x) => Object.keys(x)[0]), ['yabanci', 'yabanci', 'yabanci']);
    assert.equal(o.api.gonderilen().length, 0, 'yabanciya tek mesaj bile gitmemeli');
    // Yanlis kod eslestirmez, dogru kod eslestirir
    o.api.kuyruk.push(mesaj(222, kod));
    r = await o.tg.tur();
    assert.deepEqual(r, [{ eslesti: true }]);
    assert.equal(o.tg.sohbet(), 222);
    assert.notEqual(o.tg.eslestirmeKodu(), kod, 'kod tek kullanimlik');
    assert.match(o.api.gonderilen()[0].text, /eslestin/);
    // Artik baska bir sohbet ayni (eski) kodla giremez, eslesmis sohbet komut verebilir
    o.api.kuyruk.push(mesaj(333, kod), mesaj(222, '/durum'));
    r = await o.tg.tur();
    assert.equal(r[0].yabanci, true);
    assert.equal(r[1].komut, '/durum');
    assert.match(o.api.gonderilen().at(-1).text, /Sürü: 0 calisiyor/);
    assert.equal(o.api.gonderilen().at(-1).chat_id, 222);
    // Ofset ilerledi: ayni guncellemeler tekrar islenmez
    assert.equal(kvOku(o.db, 'telegram.ofset'), sayac);
    // Ayirma: sohbet silinir, kod yenilenir
    o.tg.ayir();
    assert.equal(o.tg.eslesmis(), false);
  } finally { o.temizle(); }
});

test('/kararlar her karari dugmeli ayri mesaj olarak gonderir; dugme karari cevaplar', async () => {
  const o = ortam();
  try {
    o.api.kuyruk.push(mesaj(5, o.tg.eslestirmeKodu()));
    await o.tg.tur();
    const is = isEkle(o.db, { ad: 'Onar', gorev: 'g', cwd: o.proje, profil: 'denetimli' });
    for (let i = 0; i < 2; i++) {
      const k = kosuAc(o.db, is.id);
      kosuGuncelle(o.db, k.id, { durum: KOSU_DURUMU.KARAR_BEKLIYOR, hata: 'h' + i });
    }
    kararlariTazele(o.db);
    const [k1] = bekleyenKararlar(o.db);
    o.api.kuyruk.push(mesaj(5, '/kararlar'));
    await o.tg.tur();
    const g = o.api.gonderilen().slice(1);
    assert.equal(g.length, 2, 'iki karar, iki mesaj');
    assert.ok(g[0].text.includes('[' + kisa(k1.id) + ']'), 'ilk mesaj ilk kararin kisa kimligini tasir');
    const klavye = g[0].reply_markup.inline_keyboard;
    assert.equal(klavye.length, 3);
    assert.equal(klavye[0][0].callback_data, 'k:' + kisa(k1.id) + ':1');
    assert.equal(klavye[2][0].text, 'Vazgec');

    // Dugmeye basildi: answerCallbackQuery + karar cevaplandi + sonuc mesaji
    o.api.kuyruk.push(dugme(5, klavye[0][0].callback_data));
    const r = await o.tg.tur();
    assert.equal(r[0].komut, '/cevap');
    assert.ok(o.api.cagrilar.some((c) => c.yontem === 'answerCallbackQuery'));
    assert.equal(kararGetir(o.db, k1.id).durum, KARAR_DURUMU.CEVAPLANDI);
    assert.match(o.api.gonderilen().at(-1).text, /cevaplandi, ajan devam ediyor/);
    // Bozuk dugme verisi patlatmaz
    o.api.kuyruk.push(dugme(5, 'sacma'));
    assert.deepEqual(await o.tg.tur(), [{ yok: true }]);
  } finally { o.temizle(); }
});

test('bildirim kanali olarak: eslesmemisken hata, karar bildirimi dugmeyle gider', async () => {
  const o = ortam();
  try {
    await assert.rejects(() => o.tg.gonder({ baslik: 'b', govde: 'g', onem: 'acil' }), /eslesmemis/);
    o.api.kuyruk.push(mesaj(9, o.tg.eslestirmeKodu()));
    await o.tg.tur();
    await o.tg.gonder({ baslik: 'Kekik · demo', govde: 'takildi', onem: 'acil' });
    let son = o.api.gonderilen().at(-1);
    assert.equal(son.text, 'Kekik · demo' + String.fromCharCode(10) + 'takildi');
    assert.equal(son.reply_markup, undefined);

    const is = isEkle(o.db, { ad: 'X', gorev: 'g', cwd: o.proje, profil: 'denetimli' });
    const k = kosuAc(o.db, is.id);
    kosuGuncelle(o.db, k.id, { durum: KOSU_DURUMU.KARAR_BEKLIYOR, hata: 'h' });
    const [karar] = kararlariTazele(o.db);
    await o.tg.gonder({ baslik: '❓ Kekik · X', govde: 'Takildi', onem: 'acil', kararId: karar.id });
    son = o.api.gonderilen().at(-1);
    assert.equal(son.reply_markup.inline_keyboard.length, 3);
    assert.match(son.text, /serbest cevap: \/cevap/);
  } finally { o.temizle(); }
});

test('uzun cikti parcalanir, dugmeler son parcaya gider; API hatasi tur hatasi olur, dongu olmez', async () => {
  const o = ortam();
  try {
    const NL = String.fromCharCode(10);
    const uzun = Array.from({ length: 400 }, (_, i) => 'satir ' + i + ' ' + 'x'.repeat(20)).join(NL);
    const p = parcala(uzun);
    assert.ok(p.length >= 3);
    assert.ok(p.every((x) => x.length <= 3900));
    assert.equal(p.join(NL), uzun, 'satir sonundan bolunur, veri kaybolmaz');
    o.api.kuyruk.push(mesaj(4, o.tg.eslestirmeKodu()));
    await o.tg.tur();
    await o.tg.mesajYaz(4, uzun, { dugmeler: [{ etiket: 'a', veri: 'k:1:1' }] });
    const g = o.api.gonderilen().slice(1);
    assert.equal(g.length, p.length);
    assert.equal(g.at(-1).reply_markup.inline_keyboard[0][0].text, 'a');
    assert.equal(g[0].reply_markup, undefined);

    // API 500: tur reddeder, durum hatayi gosterir
    const bozuk = new Telegram(o.db, { token: 't', api: 'http://sahte', komut: () => ({ metin: '' }),
      fetchFn: async () => ({ ok: false, status: 500, json: async () => ({ ok: false, description: 'bozuk' }) }) });
    await assert.rejects(() => bozuk.tur(), /telegram getUpdates 500 bozuk/);
  } finally { o.temizle(); }
});

test('kararlarTelegramaDa: ana kanal her seyi alir, Telegram yalniz kararlari; telegram hatasi ana kanali dusurmez', async () => {
  const { kararlarTelegramaDa } = await import('../src/kanallar.js');
  const ana = { ad: 'ntfy', gelen: [], async gonder(p) { this.gelen.push(p); } };
  const tg = { ad: 'telegram', gelen: [], esli: true, patla: false, eslesmis() { return this.esli; },
    async gonder(p) { if (this.patla) throw new Error('ag yok'); this.gelen.push(p); } };
  const k = kararlarTelegramaDa(ana, tg);
  assert.equal(k.ad, 'ntfy');
  await k.gonder({ baslik: 'durum', onem: 'normal' });
  await k.gonder({ baslik: 'karar', onem: 'acil', kararId: 'abc' });
  assert.equal(ana.gelen.length, 2);
  assert.deepEqual(tg.gelen.map((p) => p.kararId), ['abc']);
  tg.esli = false;
  await k.gonder({ baslik: 'karar2', kararId: 'def' });
  assert.equal(tg.gelen.length, 1, 'eslesmemisken telegrama gitmez');
  tg.esli = true; tg.patla = true;
  await k.gonder({ baslik: 'karar3', kararId: 'ghi' });
  assert.equal(ana.gelen.length, 4, 'telegram patlasa da ana kanal gitti');
  // Ana kanal zaten telegram ise ya da telegram yoksa sarmalanmaz (cift mesaj olmaz)
  assert.equal(kararlarTelegramaDa(tg, tg), tg);
  assert.equal(kararlarTelegramaDa(ana, null), ana);
});

test('kararlarTelegramaDa: ana kanal patlasa da karar Telegrama gider; ikisi de patlarsa hata yukari cikar', async () => {
  const { kararlarTelegramaDa } = await import('../src/kanallar.js');
  const ana = { ad: 'ntfy', async gonder() { throw new Error('fetch failed'); } };
  const tg = { gelen: [], patla: false, eslesmis: () => true,
    async gonder(p) { if (this.patla) throw new Error('tg yok'); this.gelen.push(p); } };
  const k = kararlarTelegramaDa(ana, tg);
  await k.gonder({ baslik: 'karar', kararId: 'abc' });          // firlatmaz: Telegramdan ulasti
  assert.equal(tg.gelen.length, 1);
  await assert.rejects(() => k.gonder({ baslik: 'durum' }), /fetch failed/);   // karar degil: ana hata gorunur
  tg.patla = true;
  await assert.rejects(() => k.gonder({ baslik: 'karar', kararId: 'x' }), /fetch failed/);
});

test('onay dugmesi: /sil once sorar, "Sil" dugmesi onayli komutu calistirir, "Vazgec" hicbir sey yapmaz', async () => {
  const o = ortam();
  try {
    // Sunucu gibi: Telegram kanalinda onay istenir
    o.tg.komut = (m, ek) => komutCalistir(m, { db: o.db, kuyruk: o.kuyruk, onayIste: ek?.kanal === 'telegram' });
    const is = isEkle(o.db, { ad: 'Silinecek', gorev: 'g', cwd: o.proje, profil: 'serbest' });
    o.api.kuyruk.push(mesaj(5, o.tg.eslestirmeKodu()));
    await o.tg.tur();
    o.api.kuyruk.push(mesaj(5, '/sil silinecek'));
    await o.tg.tur();
    const son = o.api.gonderilen().at(-1);
    assert.match(son.text, /silinsin mi: Silinecek/);
    assert.equal(son.reply_markup.inline_keyboard[0][0].callback_data, 'o:/sil ' + kisa(is.id));
    assert.equal(son.reply_markup.inline_keyboard[1][0].callback_data, 'o:vazgec');
    assert.ok(o.db.prepare('SELECT id FROM isler WHERE id = ?').get(is.id), 'henuz silinmedi');
    o.api.kuyruk.push(dugme(5, 'o:vazgec'));
    let r = await o.tg.tur();
    assert.equal(r[0].komut, 'vazgec');
    assert.ok(o.db.prepare('SELECT id FROM isler WHERE id = ?').get(is.id), 'vazgecince silinmedi');
    o.api.kuyruk.push(dugme(5, 'o:/sil ' + kisa(is.id)));
    r = await o.tg.tur();
    assert.equal(r[0].onayli, true);
    assert.match(o.api.gonderilen().at(-1).text, /silindi: Silinecek/);
    assert.equal(o.db.prepare('SELECT id FROM isler WHERE id = ?').get(is.id), undefined);
  } finally { o.temizle(); }
});
