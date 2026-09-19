import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ntfyKanali, webhookKanali, kanalKur, gunlukKanali } from '../src/kanallar.js';
import { VARSAYILAN } from '../src/config.js';

/** Yerel alici: disariya hicbir sey gitmez. */
async function alici() {
  const gelenler = [];
  const s = createServer((req, res) => {
    let g = '';
    req.on('data', (d) => { g += d; });
    req.on('end', () => {
      gelenler.push({ yol: req.url, tur: req.headers['content-type'], govde: g });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  // Kapatma BEKLENIR ve acik baglantilar kesilir: fetch'in keep-alive soketi sunucuyu asili
  // birakip bir sonraki testle yarismasin (tam kosuda bir kez kalmisti, tek basina geciyordu).
  const kapat = async () => { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); };
  return { gelenler, adres: 'http://127.0.0.1:' + s.address().port, kapat };
}

test('ntfy simge ve Turkce karakterli basligi gonderebilir', async () => {
  // Regresyon: baslik HTTP basligina yazilirsa fetch patlar (ByteString sinirlamasi).
  // JSON yayinlama kullanildigi icin unicode sorunsuz gecmeli.
  const a = await alici();
  const k = ntfyKanali({ sunucu: a.adres, konu: 'deneme' });
  await k.gonder({ baslik: 'Kekik · Sürü', govde: 'onay bekliyor', onem: 'acil' });
  await a.kapat();

  assert.equal(a.gelenler.length, 1);
  const g = JSON.parse(a.gelenler[0].govde);
  assert.equal(g.topic, 'deneme');
  assert.equal(g.title, 'Kekik · Sürü');
  assert.equal(g.priority, 4, 'acil bildirim yuksek oncelikli gitmeli');
  assert.deepEqual(g.tags, ['rotating_light']);
});

test('normal bildirim varsayilan oncelikle gider', async () => {
  const a = await alici();
  const k = ntfyKanali({ sunucu: a.adres, konu: 'deneme' });
  await k.gonder({ baslik: 'x', govde: 'y', onem: 'normal' });
  await a.kapat();
  assert.equal(JSON.parse(a.gelenler[0].govde).priority, 3);
});

test('sunucu adresindeki fazladan egik cizgi temizlenir', async () => {
  const a = await alici();
  const k = ntfyKanali({ sunucu: a.adres + '///', konu: 'deneme' });
  await k.gonder({ baslik: 'x', govde: 'y', onem: 'normal' });
  await a.kapat();
  assert.equal(a.gelenler[0].yol, '/');
});

test('ntfy hata donerse gonderim hata firlatir', async () => {
  const s = createServer((_q, res) => res.writeHead(500).end('patladi'));
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const k = ntfyKanali({ sunucu: 'http://127.0.0.1:' + s.address().port, konu: 'd' });
  await assert.rejects(() => k.gonder({ baslik: 'x', govde: 'y', onem: 'normal' }), /ntfy 500/);
  s.closeAllConnections?.(); await new Promise((r) => s.close(r));
});

test('webhook paketi ham JSON olarak gonderir', async () => {
  const a = await alici();
  const k = webhookKanali({ url: a.adres + '/kanca' });
  await k.gonder({ baslik: 'b', govde: 'g', onem: 'acil', durum: 'takildi' });
  await a.kapat();
  assert.equal(a.gelenler[0].yol, '/kanca');
  assert.equal(JSON.parse(a.gelenler[0].govde).durum, 'takildi');
});

test('konu/url eksikse kanal kurulmaz', () => {
  assert.throws(() => ntfyKanali({ konu: null }), /konusu tanimli degil/);
  assert.throws(() => webhookKanali({ url: null }), /adresi tanimli degil/);
});

test('varsayilan kanal yerel gunluk - hicbir sey makineden cikmaz', () => {
  assert.equal(VARSAYILAN.bildirim.kanal, 'gunluk');
  assert.equal(kanalKur(VARSAYILAN).ad, 'gunluk');
  assert.equal(gunlukKanali().ad, 'gunluk');
});

test('bozuk yapilandirma paneli dusurmez, yerel gunluge duser', () => {
  const a = structuredClone(VARSAYILAN);
  a.bildirim.kanal = 'ntfy';
  a.bildirim.ntfy.konu = null; // eksik ayar
  assert.equal(kanalKur(a).ad, 'gunluk');
});
