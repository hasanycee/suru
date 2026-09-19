// Is tanimlari ve kosu kayitlari. Saf veri katmani - surec baslatmaz.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { profilAl } from './yetki.js';
import { zamanlamaNormal } from './zamanlama.js';
import { gitTetikNormal } from './gittetik.js';

export const KOSU_DURUMU = {
  BEKLIYOR:       'bekliyor',
  CALISIYOR:      'calisiyor',
  BITTI:          'bitti',
  HATA:           'hata',
  KARAR_BEKLIYOR: 'karar-bekliyor',
  IPTAL:          'iptal',
};

/** Bitmis sayilan durumlar: kuyruk bunlari yeniden ele almaz. */
export const BITMIS = new Set([KOSU_DURUMU.BITTI, KOSU_DURUMU.HATA, KOSU_DURUMU.IPTAL]);

// --- Isler ---

export function isEkle(db, { ad, gorev, cwd, profil, model = null, butceUsd = null,
  oncelik = 5, dogrulama = null, yedekModel = null, ic = false,
  donguTur = null, denetciModel = null, donguButceUsd = null, kapsam = null, zamanlama = null, gitTetik = null, izolasyon = null,
  mcp = null, mcpMod = null }) {
  if (!ad || !ad.trim()) throw new Error('is adi bos olamaz');
  // '_' ile baslayan adlar Suru'nun ic isleri (damitma gibi) icin ayrilmis.
  if (!ic && ad.trim().startsWith('_')) throw new Error("'_' ile baslayan is adlari ayrilmis: " + ad);
  if (!gorev || !gorev.trim()) throw new Error('gorev bos olamaz');
  if (!existsSync(cwd)) throw new Error('klasor yok: ' + cwd);
  profilAl(profil); // gecersiz profil burada patlasin, kosu aninda degil

  const i = {
    id: randomUUID(),
    ad: ad.trim(),
    gorev: gorev.trim(),
    cwd,
    profil,
    model,
    butceUsd,
    oncelik,
    etkin: 1,
    olusturuldu: Date.now(),
    // Bos birakilirsa dogrulama yok: ajanin "bitti" demesi yeterli sayilir.
    dogrulama: dogrulama && dogrulama.trim() ? dogrulama.trim() : null,
    yedekModel: yedekModel && String(yedekModel).trim() ? String(yedekModel).trim() : null,
    // Denetim dongusu: bos/0 = kapali. Deger = en fazla kac yapici turu (10 ile sinirli).
    donguTur: Number(donguTur) > 0 ? Math.min(10, Math.floor(Number(donguTur))) : null,
    denetciModel: denetciModel && String(denetciModel).trim() ? String(denetciModel).trim() : null,
    donguButceUsd: Number(donguButceUsd) > 0 ? Number(donguButceUsd) : null,
    // Kapsam: dizi ya da virgul/satir ayracli metin. Bos = sinirsiz.
    kapsam: kapsamNormal(kapsam),
    // Cron ifadesi (yerel saat); bos = elle. Gecersizse is eklenmeden hata.
    zamanlama: zamanlamaNormal(zamanlama),
    // Izlenecek git referansi; bos = git tetigi yok. Bkz. gittetik.js.
    gitTetik: gitTetikNormal(gitTetik),
    // 'worktree' = ajan izole klasorde kosar; bos = senin calisma kopyanda.
    izolasyon: String(izolasyon ?? '').trim() === 'worktree' ? 'worktree' : null,
    // MCP: sunucu adlari (dizi ya da virgullu metin). Bos = hic MCP yok. Mod varsayilan 'okur'.
    mcp: kapsamNormal(mcp),
    mcpMod: String(mcpMod ?? '').trim() === 'tam' ? 'tam' : (kapsamNormal(mcp) ? 'okur' : null),
  };
  db.prepare(`INSERT INTO isler (id, ad, gorev, cwd, profil, model, butce_usd, oncelik,
              etkin, olusturuldu, dogrulama, yedek_model, dongu_tur, denetci_model, dongu_butce_usd, kapsam, zamanlama,
              git_tetik, izolasyon, mcp, mcp_mod)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(i.id, i.ad, i.gorev, i.cwd, i.profil, i.model, i.butceUsd, i.oncelik,
      i.etkin, i.olusturuldu, i.dogrulama, i.yedekModel, i.donguTur, i.denetciModel, i.donguButceUsd,
      i.kapsam ? JSON.stringify(i.kapsam) : null, i.zamanlama, i.gitTetik, i.izolasyon,
      i.mcp ? JSON.stringify(i.mcp) : null, i.mcpMod);
  return i;
}

const isCoz = (r) => r && {
  id: r.id, ad: r.ad, gorev: r.gorev, cwd: r.cwd, profil: r.profil,
  model: r.model, butceUsd: r.butce_usd, oncelik: r.oncelik,
  etkin: !!r.etkin, olusturuldu: r.olusturuldu, dogrulama: r.dogrulama,
  yedekModel: r.yedek_model,
  donguTur: r.dongu_tur ?? null, denetciModel: r.denetci_model ?? null,
  donguButceUsd: r.dongu_butce_usd ?? null,
  kapsam: kapsamCoz(r.kapsam),
  zamanlama: r.zamanlama ?? null, sonTetik: r.son_tetik ?? null,
  gitTetik: r.git_tetik ?? null, sonCommit: r.son_commit ?? null,
  izolasyon: r.izolasyon ?? null,
  mcp: kapsamCoz(r.mcp), mcpMod: r.mcp_mod ?? null,
};

function kapsamNormal(k) {
  if (k == null) return null;
  const liste = (Array.isArray(k) ? k : String(k).split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean);
  return liste.length ? liste : null;
}

function kapsamCoz(metin) {
  if (!metin) return null;
  try { return kapsamNormal(JSON.parse(metin)); } catch { return null; }
}

export function isGetir(db, id) {
  return isCoz(db.prepare('SELECT * FROM isler WHERE id = ?').get(id));
}

export function isListesi(db, { sadeceEtkin = false } = {}) {
  const sql = 'SELECT * FROM isler' + (sadeceEtkin ? ' WHERE etkin = 1' : '') + ' ORDER BY oncelik, olusturuldu';
  return db.prepare(sql).all().map(isCoz);
}

export function isEtkinlik(db, id, etkin) {
  db.prepare('UPDATE isler SET etkin = ? WHERE id = ?').run(etkin ? 1 : 0, id);
}

export function isSil(db, id) {
  // Kosu gecmisi kalsin: neyin ne zaman calistigi silinen is icin de bilgi.
  db.prepare('DELETE FROM isler WHERE id = ?').run(id);
  // Isin denetci ic isi de gider. Olculdu: 44 isin 15'i hedefi silinmis yetim '_denetci:<id>'
  // isiydi (cogu sinavdan) - is silinince denetcisi geride kaliyordu.
  db.prepare('DELETE FROM isler WHERE ad = ?').run('_denetci:' + id);
}

/**
 * Yetim ic isleri temizler (acilista): hedefi silinmis denetci isleri ve projesinde hicbir
 * kullanici isi kalmamis damitma isleri. Calisan/bekleyen kosusu olan ise dokunulmaz.
 */
export function yetimIcIsleriSil(db) {
  const mesgul = new Set(db.prepare("SELECT DISTINCT is_id FROM kosular WHERE durum IN ('bekliyor','calisiyor')").all().map((r) => r.is_id));
  const hepsi = db.prepare('SELECT id, ad, cwd FROM isler').all();
  const kimlikler = new Set(hepsi.map((i) => i.id));
  const kullaniciIsiOlan = new Set(hepsi.filter((i) => !String(i.ad).startsWith('_')).map((i) => i.cwd));
  const silinen = [];
  for (const i of hepsi) {
    if (mesgul.has(i.id)) continue;
    const yetimDenetci = i.ad.startsWith('_denetci:') && !kimlikler.has(i.ad.slice('_denetci:'.length));
    const yetimDamitma = i.ad.startsWith('_damitma:') && !kullaniciIsiOlan.has(i.cwd);
    if (yetimDenetci || yetimDamitma) { db.prepare('DELETE FROM isler WHERE id = ?').run(i.id); silinen.push(i.ad); }
  }
  return silinen;
}

// --- Kosular ---

/**
 * Kosu kaydini ONCE acar, sonra surec baslatilir. session_id burada uretilir
 * cunku claude'a --session-id ile veriliyor: kayit ile transkript ayni kimlikte.
 */
export function kosuAc(db, isId, { sessionId = randomUUID(), devamCevabi = null,
  donguId = null, tur = null, rol = null, ekTalimat = null, hedefKosu = null } = {}) {
  const k = {
    id: randomUUID(),
    isId,
    sessionId,
    durum: KOSU_DURUMU.BEKLIYOR,
    basladi: Date.now(),
    // Dolu ise bu bir devam kosusu: gorev bastan verilmez, oturum surdurulur.
    devamCevabi,
    // Denetim dongusu alanlari (bkz. dongu.js); dongu disi kosuda hepsi null.
    donguId, tur, rol, ekTalimat, hedefKosu,
  };
  db.prepare(`INSERT INTO kosular (id, is_id, session_id, durum, basladi, devam_cevabi,
              dongu_id, tur, rol, ek_talimat, hedef_kosu) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(k.id, k.isId, k.sessionId, k.durum, k.basladi, k.devamCevabi,
      k.donguId, k.tur, k.rol, k.ekTalimat, k.hedefKosu);
  return k;
}

const ALAN = {
  durum: 'durum', bitti: 'bitti', cikisKodu: 'cikis_kodu', usd: 'usd',
  turSayisi: 'tur_sayisi', aracSayisi: 'arac_sayisi', redSayisi: 'red_sayisi',
  terminalNeden: 'terminal_neden', sonuc: 'sonuc', hata: 'hata', sessionId: 'session_id',
  devamCevabi: 'devam_cevabi',
  dogrulamaKod: 'dogrulama_kod', dogrulamaCikti: 'dogrulama_cikti',
  golgeOnce: 'golge_once', golgeSonra: 'golge_sonra', degisenDosya: 'degisen_dosya',
  geriAlindi: 'geri_alindi',
  donguId: 'dongu_id', tur: 'tur', rol: 'rol', ekTalimat: 'ek_talimat', hedefKosu: 'hedef_kosu',
  denetim: 'denetim',
  // Akistan gozlenen model (isin ayari degil, gercekten kosan model).
  model: 'model',
  // Izole kosuda isin teslim edildigi dal.
  worktreeDal: 'worktree_dal',
  // kosuAc'ta sira zamani yazilir; kuyruk kosuyu FIILEN baslatinca guncellenir.
  basladi: 'basladi',
};

export function kosuGuncelle(db, kosuId, alanlar) {
  const set = [], arg = [];
  for (const [k, v] of Object.entries(alanlar)) {
    const sutun = ALAN[k];
    if (!sutun) throw new Error('bilinmeyen kosu alani: ' + k);
    set.push(sutun + ' = ?');
    arg.push(v);
  }
  if (!set.length) return;
  arg.push(kosuId);
  db.prepare('UPDATE kosular SET ' + set.join(', ') + ' WHERE id = ?').run(...arg);
}

const kosuCoz = (r) => r && {
  id: r.id, isId: r.is_id, sessionId: r.session_id, durum: r.durum,
  basladi: r.basladi, bitti: r.bitti, cikisKodu: r.cikis_kodu, usd: r.usd,
  turSayisi: r.tur_sayisi, aracSayisi: r.arac_sayisi, redSayisi: r.red_sayisi,
  terminalNeden: r.terminal_neden, sonuc: r.sonuc, hata: r.hata,
  devamCevabi: r.devam_cevabi,
  dogrulamaKod: r.dogrulama_kod, dogrulamaCikti: r.dogrulama_cikti,
  golgeOnce: r.golge_once ?? null, golgeSonra: r.golge_sonra ?? null,
  degisenDosya: r.degisen_dosya ?? null, geriAlindi: r.geri_alindi ?? null,
  donguId: r.dongu_id ?? null, tur: r.tur ?? null, rol: r.rol ?? null,
  ekTalimat: r.ek_talimat ?? null, hedefKosu: r.hedef_kosu ?? null, denetim: r.denetim ?? null,
  model: r.model ?? null, worktreeDal: r.worktree_dal ?? null,
};

export function kosuGetir(db, id) {
  return kosuCoz(db.prepare('SELECT * FROM kosular WHERE id = ?').get(id));
}

export function kosular(db, { isId = null, durum = null, limit = 50 } = {}) {
  const kosul = [], arg = [];
  if (isId) { kosul.push('is_id = ?'); arg.push(isId); }
  if (durum) { kosul.push('durum = ?'); arg.push(durum); }
  arg.push(limit);
  return db.prepare('SELECT * FROM kosular'
    + (kosul.length ? ' WHERE ' + kosul.join(' AND ') : '')
    + ' ORDER BY basladi DESC LIMIT ?').all(...arg).map(kosuCoz);
}

/** Calisiyor gorunen kosular. Yeniden baslatmada temizlik icin de kullanilir. */
export function acikKosular(db) {
  return db.prepare("SELECT * FROM kosular WHERE durum IN ('bekliyor','calisiyor') ORDER BY basladi")
    .all().map(kosuCoz);
}

/**
 * Sunucu cokup yeniden basladiginda 'calisiyor' kalmis kosular vardir ama
 * surecleri olmustur. Hayalet kayit birakmamak icin acilista kapatilir.
 */
export function hayaletleriKapat(db) {
  const n = db.prepare(`UPDATE kosular SET durum = ?, bitti = ?, hata = ?
                        WHERE durum IN ('bekliyor','calisiyor')`)
    .run(KOSU_DURUMU.HATA, Date.now(), 'sunucu yeniden basladi, surec kayboldu');
  return Number(n.changes ?? 0);
}
