import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { OLAY, yaz as olayYaz, sonSeq } from '../src/events.js';
import { isEkle, kosuAc, kosuGuncelle, KOSU_DURUMU } from '../src/isler.js';
import { kararlariTazele } from '../src/eskalasyon.js';
import { kayitEsle } from '../src/kosucu.js';
import { goruntu, akis, kosuListesi } from '../src/komuta.js';

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-komuta-'));
  const db = openDb(join(dizin, 'k.db'));
  return { db, dizin, temizle: () => { db.close(); try { rmSync(dizin, { recursive: true, force: true }); } catch { /* */ } } };
}

test('kosucu arac olayina ozet, metin bloguna soz olayi yazar; api hatasi ve alt ajan metni soz olmaz', () => {
  const b = { kosuId: 'k1', isId: 'i1', sessionId: 's1', project: 'demo' };
  const r = kayitEsle({ type: 'assistant', parent_tool_use_id: null, message: { content: [
    { type: 'text', text: 'Once dosyayi okuyorum.' },
    { type: 'tool_use', name: 'Read', input: { file_path: '/x/y/Kamera.cs' } }] } }, b);
  assert.deepEqual(r.olaylar.map((o) => o.kind), [OLAY.SOZ, OLAY.ARAC]);
  assert.equal(r.olaylar[0].data.metin, 'Once dosyayi okuyorum.');
  assert.equal(r.olaylar[1].data.ozet, 'okuyor: Kamera.cs');
  assert.equal(r.olaylar[1].data.kosuId, 'k1');
  const hata = kayitEsle({ type: 'assistant', is_api_error_message: true, error: 'x',
    message: { content: [{ type: 'text', text: 'Failed' }] } }, b);
  assert.ok(!hata.olaylar.some((o) => o.kind === OLAY.SOZ));
  const alt = kayitEsle({ type: 'assistant', parent_tool_use_id: 't9', message: { content: [{ type: 'text', text: 'alt ajan ic sesi' }] } }, b);
  assert.equal(alt.olaylar.length, 0);
  // Uzun metin kirpilir: olay akisi transkript deposu degil
  const uzun = kayitEsle({ type: 'assistant', message: { content: [{ type: 'text', text: 'a'.repeat(5000) }] } }, b);
  assert.equal(uzun.olaylar[0].data.metin.length, 400);
});

test('goruntu: canli kosular once gelir; satirlar ve token o KOSUYA aittir (ayni oturumdaki devam kosusu karismaz)', () => {
  const o = ortam();
  try {
    const is = isEkle(o.db, { ad: 'Onar', gorev: 'g', cwd: o.dizin, profil: 'denetimli' });
    const eski = kosuAc(o.db, is.id);
    kosuGuncelle(o.db, eski.id, { durum: KOSU_DURUMU.BITTI, bitti: Date.now(), usd: 0.2 });
    olayYaz(o.db, { kind: OLAY.ARAC, sessionId: eski.sessionId, data: { kosuId: eski.id, arac: 'Read', ozet: 'okuyor: eski.cs' } });
    olayYaz(o.db, { kind: OLAY.MALIYET, sessionId: eski.sessionId, data: { kosuId: eski.id, girdi: 1000, cikti: 10, usd: 0.01 } });
    // Ayni oturumdan devam kosusu
    const devam = kosuAc(o.db, is.id, { sessionId: eski.sessionId, devamCevabi: 'devam et' });
    kosuGuncelle(o.db, devam.id, { durum: KOSU_DURUMU.CALISIYOR });
    olayYaz(o.db, { kind: OLAY.ARAC, sessionId: devam.sessionId, data: { kosuId: devam.id, arac: 'Edit', ozet: 'duzenliyor: yeni.cs' } });
    olayYaz(o.db, { kind: OLAY.MALIYET, sessionId: devam.sessionId, data: { kosuId: devam.id, girdi: 500, cikti: 5, usd: 0.02 } });
    olayYaz(o.db, { kind: OLAY.MALIYET, sessionId: devam.sessionId, data: { kosuId: devam.id, girdi: 700, cikti: 7, usd: 0.03 } });

    const v = goruntu(o.db, { durum: () => ({ esZamanli: 3, calisan: 1, bekleyen: 0 }) });
    assert.equal(v.kosular[0].id, devam.id, 'calisan kosu basta');
    assert.equal(v.kosular[0].canli, true);
    assert.equal(v.kosular[0].devam, true);
    assert.deepEqual(v.kosular[0].satirlar.map((s) => s.metin), ['duzenliyor: yeni.cs']);
    assert.deepEqual(v.kosular[0].token, { girdi: 1200, cikti: 12 });
    assert.ok(Math.abs(v.kosular[0].usdCanli - 0.05) < 1e-9);
    const e = v.kosular.find((k) => k.id === eski.id);
    assert.deepEqual(e.satirlar.map((s) => s.metin), ['okuyor: eski.cs']);
    assert.deepEqual(e.token, { girdi: 1000, cikti: 10 });
    assert.equal(v.kosular[0].ajan.ad, e.ajan.ad, 'kimlik isten gelir: ayni is ayni ajan');
    assert.equal(v.kosular[0].is.proje.startsWith('suru-komuta-'), true);
    assert.equal(v.son, sonSeq(o.db));
    assert.equal(v.kuyruk.esZamanli, 3);
  } finally { o.temizle(); }
});

test('goruntu acik kararlari tasir; eski bitmis kosular pencere disinda kalir', () => {
  const o = ortam();
  try {
    const is = isEkle(o.db, { ad: 'Plan', gorev: 'g', cwd: o.dizin, profil: 'danisan' });
    const k = kosuAc(o.db, is.id);
    kosuGuncelle(o.db, k.id, { durum: KOSU_DURUMU.KARAR_BEKLIYOR, sonuc: 'plan' });
    kararlariTazele(o.db);
    const cokEski = kosuAc(o.db, is.id);
    kosuGuncelle(o.db, cokEski.id, { durum: KOSU_DURUMU.BITTI, basladi: Date.now() - 48 * 3600_000, bitti: Date.now() - 47 * 3600_000 });
    const v = goruntu(o.db, null);
    assert.equal(v.kararlar.length, 1);
    assert.equal(v.kararlar[0].kosuId, k.id);
    assert.equal(v.kararlar[0].secenekler[0].eylem, 'uygula');
    assert.deepEqual(kosuListesi(o.db).map((x) => x.id), [k.id], '47 saat once biten kosu listede yok');
    assert.equal(v.kuyruk, null);
  } finally { o.temizle(); }
});

test('yetim kosular masaya oturmaz: isi silinmis ya da karari kapanmis karar-bekliyor kosusu listede yok', () => {
  const o = ortam();
  try {
    const gun = 24 * 3600_000;
    // 1) Isi silinmis, gunler once karar-bekliyor'da asili kalmis kosu
    const silinecek = isEkle(o.db, { ad: 'Silinen', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
    const yetim = kosuAc(o.db, silinecek.id);
    kosuGuncelle(o.db, yetim.id, { durum: KOSU_DURUMU.KARAR_BEKLIYOR, basladi: Date.now() - 5 * gun });
    o.db.prepare('DELETE FROM isler WHERE id = ?').run(silinecek.id);
    // 2) Isi duran ama acik karari olmayan eski karar-bekliyor kosusu
    const is = isEkle(o.db, { ad: 'Duran', gorev: 'g', cwd: o.dizin, profil: 'serbest' });
    const kararsiz = kosuAc(o.db, is.id);
    kosuGuncelle(o.db, kararsiz.id, { durum: KOSU_DURUMU.KARAR_BEKLIYOR, basladi: Date.now() - 5 * gun });
    // 3) Acik karari olan eski kosu: gorunmeli (hala senden cevap bekliyor)
    const bekleyen = kosuAc(o.db, is.id);
    kosuGuncelle(o.db, bekleyen.id, { durum: KOSU_DURUMU.KARAR_BEKLIYOR, hata: 'x', basladi: Date.now() - 4 * gun });
    o.db.prepare(`INSERT INTO kararlar (id, kosu_id, is_id, session_id, tur, soru, olusturuldu, durum)
                  VALUES ('kr1', ?, ?, ?, 'hata', 'Takildi', ?, 'bekliyor')`).run(bekleyen.id, is.id, bekleyen.sessionId, Date.now());
    assert.deepEqual(kosuListesi(o.db).map((k) => k.id), [bekleyen.id]);
  } finally { o.temizle(); }
});

test('akis: imlecten sonrasini verir, maliyeti satirdan ayirir, liste degistiren olayda yenile ister', () => {
  const o = ortam();
  try {
    olayYaz(o.db, { kind: OLAY.ARAC, sessionId: 's', data: { kosuId: 'k', arac: 'Read', ozet: 'okuyor: a' } });
    const imlec = sonSeq(o.db);
    assert.deepEqual(akis(o.db, imlec), { son: imlec, satirlar: [], maliyet: [], yenile: false });
    olayYaz(o.db, { kind: OLAY.ARAC, sessionId: 's', data: { kosuId: 'k', arac: 'Grep', ozet: 'ariyor: "x"' } });
    olayYaz(o.db, { kind: OLAY.MALIYET, sessionId: 's', data: { kosuId: 'k', girdi: 10, cikti: 2, usd: 0.001 } });
    olayYaz(o.db, { kind: 'bildirim', sessionId: 's', data: { durum: 'karar' } });
    let a = akis(o.db, imlec);
    assert.deepEqual(a.satirlar.map((s) => s.metin), ['ariyor: "x"']);
    assert.deepEqual(a.maliyet, [{ kosu: 'k', girdi: 10, cikti: 2, usd: 0.001 }]);
    assert.equal(a.yenile, false);
    assert.equal(a.son, sonSeq(o.db), 'imlec gosterilmeyen olaylari da gecer');
    olayYaz(o.db, { kind: OLAY.IS, sessionId: 's', data: { asama: 'bitti', kosuId: 'k', usd: 0.1, turSayisi: 2 } });
    a = akis(o.db, a.son);
    assert.equal(a.yenile, true);
    assert.equal(a.satirlar[0].ses, 'bitti');
    assert.equal(akis(o.db, 'sacma').son >= 1, true, 'bozuk imlec bastan okur, patlamaz');
  } finally { o.temizle(); }
});
