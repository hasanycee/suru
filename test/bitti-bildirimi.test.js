import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { isEkle, kosuAc, kosuGuncelle, KOSU_DURUMU } from '../src/isler.js';
import { bittiMesaji, isAcikMi } from '../src/bitti-bildirimi.js';
import { VARSAYILAN } from '../src/config.js';

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-bitti-'));
  const db = openDb(join(dizin, 'k.db'));
  const proje = join(dizin, 'oyun'); mkdirSync(proje);
  return { db, dizin, proje, temizle: () => { db.close(); try { rmSync(dizin, { recursive: true, force: true }); } catch { /* */ } } };
}

test('varsayilan kapali; basit bitis tek satir; hata ve durdurma da bildirilir; karar bekleyen sessiz', () => {
  assert.equal(VARSAYILAN.telegram.bittiBildir, false);
  const o = ortam();
  try {
    const is = isEkle(o.db, { ad: 'Onar', gorev: 'g', cwd: o.proje, profil: 'serbest' });
    const k = kosuAc(o.db, is.id);
    kosuGuncelle(o.db, k.id, { durum: KOSU_DURUMU.BITTI, basladi: Date.now() - 65_000, bitti: Date.now(), usd: 0.12, degisenDosya: 3, worktreeDal: 'suru/onar' });
    const m = bittiMesaji(o.db, { kosuId: k.id });
    assert.match(m, /· Onar \(oyun\): bitti · \$0\.12 · 1 dk · 3 dosya degisti · dal suru\/onar$/);
    const h = kosuAc(o.db, is.id); kosuGuncelle(o.db, h.id, { durum: KOSU_DURUMU.HATA, bitti: Date.now(), usd: 0.01 });
    assert.match(bittiMesaji(o.db, { kosuId: h.id }), /HATAYLA bitti/);
    const d = kosuAc(o.db, is.id); kosuGuncelle(o.db, d.id, { durum: KOSU_DURUMU.IPTAL, bitti: Date.now() });
    assert.match(bittiMesaji(o.db, { kosuId: d.id }), /durduruldu/);
    const kr = kosuAc(o.db, is.id); kosuGuncelle(o.db, kr.id, { durum: KOSU_DURUMU.KARAR_BEKLIYOR, bitti: Date.now() });
    assert.equal(bittiMesaji(o.db, { kosuId: kr.id }), null, 'karar karti zaten gidiyor');
    assert.equal(bittiMesaji(o.db, { kosuId: 'yok' }), null);
  } finally { o.temizle(); }
});

test('denetci dongusu: yapici bitip denetci kuyruktayken SESSIZ; denetci bitince (dongu kapandi) tek mesaj, toplam maliyetle', () => {
  const o = ortam();
  try {
    const is = isEkle(o.db, { ad: 'Dongulu', gorev: 'g', cwd: o.proje, profil: 'denetimli', donguTur: 2 });
    const denetci = isEkle(o.db, { ad: '_denetci:' + is.id, gorev: 'd', cwd: o.proje, profil: 'gozlemci', ic: true });
    const y = kosuAc(o.db, is.id, { donguId: 'dg', tur: 1, rol: 'yapici' });
    kosuGuncelle(o.db, y.id, { durum: KOSU_DURUMU.BITTI, bitti: Date.now(), usd: 0.08 });
    // dongu denetciyi kuyruga aldi
    const dk = kosuAc(o.db, denetci.id, { donguId: 'dg', tur: 1, rol: 'denetci', hedefKosu: y.id });
    assert.equal(isAcikMi(o.db, is.id), true);
    assert.equal(bittiMesaji(o.db, { kosuId: y.id }), null, 'denetci bekliyor: son bitis degil');
    // denetci bitti, hukum gecti (yeni tur acilmadi)
    kosuGuncelle(o.db, dk.id, { durum: KOSU_DURUMU.BITTI, bitti: Date.now(), usd: 0.12 });
    assert.equal(isAcikMi(o.db, is.id), false);
    const m = bittiMesaji(o.db, { kosuId: dk.id });
    assert.match(m, /Dongulu \(oyun\): bitti, denetimden gecti · \$0\.20 \/ 2 kosu/);
    // damitma ic isi hic bildirilmez
    const dam = isEkle(o.db, { ad: '_damitma:x', gorev: 'd', cwd: o.proje, profil: 'gozlemci', ic: true });
    const dmk = kosuAc(o.db, dam.id); kosuGuncelle(o.db, dmk.id, { durum: KOSU_DURUMU.BITTI, bitti: Date.now() });
    assert.equal(bittiMesaji(o.db, { kosuId: dmk.id }), null);
  } finally { o.temizle(); }
});
