// Ajan karnesi: hangi isin hangi ayarla gercekten calistigi.
//
// Eglenceli tarafi seviye ve rozet, ama asil degeri su: bir isi 'serbest'
// profille haiku'da kosturmak mi yoksa 'denetimli' profille sonnet'te mi daha
// iyi sonuc veriyor - bunu tahmin etmek yerine olcuyoruz.
//
// Kimlik ISTEN gelir (bkz. kisilik.js): ayni is hep ayni ajan gorunur, boylece
// karne birikebilir.

import { ajanKimligi } from './kisilik.js';
import { KOSU_DURUMU } from './isler.js';

/** Basarili sayilan bitis durumlari. Karar bekleyen ne basari ne basarisizlik. */
const BASARILI = new Set([KOSU_DURUMU.BITTI]);
const BASARISIZ = new Set([KOSU_DURUMU.HATA, KOSU_DURUMU.IPTAL]);

// Seviye esikleri: basarili kosu sayisi. Sisirilmis olmasin diye yavas artiyor.
const SEVIYELER = [0, 3, 10, 25, 60, 150, 400];

export function seviye(basariliKosu) {
  let s = 0;
  for (let i = 0; i < SEVIYELER.length; i++) if (basariliKosu >= SEVIYELER[i]) s = i;
  return s;
}

/** Bir sonraki seviyeye kac kosu kaldi? */
export function sonrakiSeviye(basariliKosu) {
  const s = seviye(basariliKosu);
  if (s >= SEVIYELER.length - 1) return null;
  return { seviye: s + 1, kalan: SEVIYELER[s + 1] - basariliKosu };
}

/**
 * Rozetler. Kasitli olarak az ve anlamli - her sey rozet olursa hicbiri
 * bir sey ifade etmez.
 */
export function rozetler(k) {
  const r = [];
  if (k.kosu >= 5 && k.basariOrani === 1) r.push({ ad: 'kusursuz', not: 'hic basarisiz olmadi' });
  if (k.kosu >= 10 && k.basariOrani != null && k.basariOrani >= 0.9) r.push({ ad: 'guvenilir', not: '%90+ basari' });
  if (k.kosu >= 5 && k.kararSayisi === 0) r.push({ ad: 'ozerk', not: 'hic sormadan hallediyor' });
  if (k.kosu >= 5 && k.ortalamaUsd > 0 && k.ortalamaUsd < 0.05) r.push({ ad: 'tutumlu', not: 'kosu basi $0.05 alti' });
  if (k.kararSayisi >= 5 && k.kararSayisi / Math.max(1, k.kosu) > 0.6) {
    r.push({ ad: 'cekingen', not: 'cok sik soruyor - profili gevsetmeyi dusun' });
  }
  if (k.basariOrani != null && k.basariOrani < 0.5 && k.kosu >= 4) {
    r.push({ ad: 'zorlaniyor', not: 'gorevi bolmeyi ya da modeli yukseltmeyi dene' });
  }
  return r;
}

/** Ham sayimlardan karne cikarir. Saf: db yok. */
export function karneHesapla(satirlar, { isId = null, kararSayisi = 0 } = {}) {
  const k = {
    kosu: satirlar.length,
    basarili: 0, basarisiz: 0, kararaDusen: 0,
    toplamUsd: 0, toplamMs: 0, toplamTur: 0, toplamArac: 0, toplamRed: 0,
    kararSayisi,
  };
  for (const s of satirlar) {
    if (BASARILI.has(s.durum)) k.basarili++;
    else if (BASARISIZ.has(s.durum)) k.basarisiz++;
    else if (s.durum === KOSU_DURUMU.KARAR_BEKLIYOR) k.kararaDusen++;
    k.toplamUsd += Number(s.usd || 0);
    k.toplamTur += Number(s.turSayisi || 0);
    k.toplamArac += Number(s.aracSayisi || 0);
    k.toplamRed += Number(s.redSayisi || 0);
    // != null: 0 gecerli bir zaman damgasi, dogruluk kontrolu onu eler.
    if (s.basladi != null && s.bitti != null && s.bitti > s.basladi) {
      k.toplamMs += s.bitti - s.basladi;
    }
  }
  // Karar bekleyen kosu ne basari ne basarisizlik: hukumsuz, paydadan cikar.
  // Hic hukumlu kosu yoksa oran SIFIR DEGIL YOK: %0 gostermek "basarisiz"
  // demek olurdu, oysa henuz hukum verilmemis.
  const hukumlu = k.basarili + k.basarisiz;
  k.hukumlu = hukumlu;
  k.basariOrani = hukumlu ? k.basarili / hukumlu : null;
  k.ortalamaUsd = k.kosu ? k.toplamUsd / k.kosu : 0;
  k.ortalamaMs = k.kosu ? k.toplamMs / k.kosu : 0;
  k.ortalamaTur = k.kosu ? k.toplamTur / k.kosu : 0;
  k.seviye = seviye(k.basarili);
  k.sonraki = sonrakiSeviye(k.basarili);
  k.rozetler = rozetler(k);
  if (isId) k.isId = isId;
  return k;
}

const kosuCoz = (r) => ({
  durum: r.durum, usd: r.usd, basladi: r.basladi, bitti: r.bitti,
  turSayisi: r.tur_sayisi, aracSayisi: r.arac_sayisi, redSayisi: r.red_sayisi,
});

/** Tek bir isin karnesi. */
export function isKarnesi(db, isId) {
  const is = db.prepare('SELECT * FROM isler WHERE id = ?').get(isId);
  const satirlar = db.prepare('SELECT * FROM kosular WHERE is_id = ?').all(isId).map(kosuCoz);
  const kararSayisi = Number(
    db.prepare('SELECT COUNT(*) n FROM kararlar WHERE is_id = ?').get(isId)?.n ?? 0);

  const k = karneHesapla(satirlar, { isId, kararSayisi });
  k.ajan = ajanKimligi({ isId });
  k.is = is ? { ad: is.ad, profil: is.profil, model: is.model } : null;
  return k;
}

/**
 * Butun islerin karnesi. Silinmis isler de gorunur (kosu gecmisi kaliyor) -
 * "bu ayarla ne olmustu" sorusunun cevabi kaybolmasin.
 */
export function tumKarneler(db, { enAzKosu = 1 } = {}) {
  const idler = db.prepare('SELECT DISTINCT is_id FROM kosular').all().map((r) => r.is_id);
  return idler
    .map((id) => isKarnesi(db, id))
    .filter((k) => k.kosu >= enAzKosu)
    .sort((a, b) => b.kosu - a.kosu);
}

/**
 * Model karsilastirmasi: ayni isin farkli modellerdeki kosulari.
 *
 * Suru bir isi hangi modelde kostururken ne kadar odedigini ve ne kadar
 * basarili oldugunu biliyor. "Bu is haiku'da da bu kadar basariliysa opus'a
 * gerek yok" sorusunun cevabi burada - tahminle degil olcumle.
 */
export function modelKarsilastir(db, { enAzKosu = 3 } = {}) {
  const satirlar = db.prepare(`
    SELECT COALESCE(i.model, 'varsayilan') model, k.durum, k.usd,
           k.tur_sayisi, k.arac_sayisi, k.red_sayisi, k.basladi, k.bitti
    FROM kosular k LEFT JOIN isler i ON i.id = k.is_id
  `).all();

  const grup = new Map();
  for (const r of satirlar) {
    if (!grup.has(r.model)) grup.set(r.model, []);
    grup.get(r.model).push(kosuCoz(r));
  }

  return [...grup]
    .map(([model, liste]) => ({ model, ...karneHesapla(liste) }))
    .filter((g) => g.kosu >= enAzKosu)
    .sort((a, b) => a.ortalamaUsd - b.ortalamaUsd);
}

/**
 * Model onerisi. KASITLI olarak otomatik degistirmiyor - oneriyor.
 * Az veriyle model degistirmek, olcum degil kumar olur.
 */
export function modelOnerisi(db, { enAzKosu = 5 } = {}) {
  const g = modelKarsilastir(db, { enAzKosu });
  if (g.length < 2) {
    return { oneri: null, neden: 'karsilastirmak icin en az iki modelde ' + enAzKosu + '+ kosu lazim', gruplar: g };
  }
  const ucuz = g[0];
  const pahali = g[g.length - 1];
  if (ucuz.model === pahali.model) return { oneri: null, neden: 'tek model kullanilmis', gruplar: g };

  // Ucuz olan en az pahalinin kadar basariliysa oneri var.
  if (ucuz.basariOrani == null || pahali.basariOrani == null) {
    return { oneri: null, neden: 'hukumlu kosu yok, karsilastirilamaz', gruplar: g };
  }
  if (ucuz.basariOrani >= pahali.basariOrani - 0.05 && pahali.ortalamaUsd > ucuz.ortalamaUsd * 1.5) {
    const kat = pahali.ortalamaUsd / Math.max(ucuz.ortalamaUsd, 1e-9);
    return {
      oneri: ucuz.model,
      neden: ucuz.model + ' ile ' + pahali.model + ' basari orani benzer (%'
        + Math.round(ucuz.basariOrani * 100) + ' / %' + Math.round(pahali.basariOrani * 100)
        + ') ama ' + pahali.model + ' ' + kat.toFixed(1) + ' kat pahali',
      gruplar: g,
    };
  }
  return { oneri: null, neden: 'ucuz modelin basarisi yeterli degil, degistirmeye deger bulunmadi', gruplar: g };
}

/**
 * Proje x model x basari tablosu (/rapor). Amac: hangi proje/is tipinde ucuz modelin yettigini
 * VERIYLE gormek. Model kosunun kendi kaydindan (gozlenen), proje isin klasorunden. Ic isler
 * (denetci, damitma) ayri sayilmaz: denetci kosusu hedef isin projesine yazilir.
 * Hukum: bitti = gecti; hata/iptal = kaldi; karar-bekliyor = insana dustu (ne gecti ne kaldi).
 */
export function projeModelRaporu(db, { gun = 90, simdi = Date.now() } = {}) {
  const satirlar = db.prepare(`
    SELECT i.cwd, i.ad, k.model, k.durum, k.usd, k.rol
    FROM kosular k JOIN isler i ON i.id = k.is_id
    WHERE k.model IS NOT NULL AND k.basladi >= ? AND i.ad NOT LIKE '_damitma:%'
  `).all(simdi - gun * 24 * 3600_000);
  const grup = new Map();
  for (const r of satirlar) {
    const proje = String(r.cwd).replace(/\\/g, '/').split('/').filter(Boolean).pop() || '?';
    const rol = r.rol === 'denetci' || String(r.ad).startsWith('_denetci:') ? 'denetci' : 'yapici';
    const a = proje + '|' + r.model + '|' + rol;
    if (!grup.has(a)) grup.set(a, { proje, model: r.model, rol, kosu: 0, gecti: 0, kaldi: 0, insana: 0, usd: 0 });
    const g = grup.get(a);
    g.kosu++; g.usd += Number(r.usd ?? 0);
    if (r.durum === 'bitti') g.gecti++;
    else if (r.durum === 'hata' || r.durum === 'iptal') g.kaldi++;
    else if (r.durum === 'karar-bekliyor') g.insana++;
  }
  return [...grup.values()]
    .map((g) => ({ ...g, ortalamaUsd: g.kosu ? g.usd / g.kosu : 0,
      basariOrani: (g.gecti + g.kaldi) ? g.gecti / (g.gecti + g.kaldi) : null }))
    .sort((a, b) => a.proje.localeCompare(b.proje) || a.rol.localeCompare(b.rol) || a.ortalamaUsd - b.ortalamaUsd);
}

/**
 * Is acilmadan maliyet tahmini: ayni projenin (ve verildiyse ayni profil/modelin) son kosularindan
 * ceyreklik araligi. 5 kosudan az veri "tahmin" degil "ornek"tir; ayrica isaretlenir, uydurulmaz.
 */
export function maliyetTahmini(db, { cwd = null, profil = null, model = null, enAz = 5, gun = 90, simdi = Date.now() } = {}) {
  if (!cwd) return { tahmin: null, neden: 'proje klasoru gerekli', kosu: 0 };
  const yol = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const kosul = ["k.usd IS NOT NULL", "k.durum IN ('bitti','hata','karar-bekliyor')", 'k.basladi >= ?', "i.ad NOT LIKE '\\_%' ESCAPE '\\'"];
  const arg = [simdi - gun * 24 * 3600_000];
  if (profil) { kosul.push('i.profil = ?'); arg.push(profil); }
  const satirlar = db.prepare('SELECT k.usd, k.model, i.cwd FROM kosular k JOIN isler i ON i.id = k.is_id WHERE ' + kosul.join(' AND ')).all(...arg)
    .filter((r) => String(r.cwd).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === yol)
    .filter((r) => !model || !r.model || String(r.model).includes(model));
  const usd = satirlar.map((r) => Number(r.usd)).sort((a, b) => a - b);
  if (!usd.length) return { tahmin: null, kosu: 0,
    neden: 'bu projede' + (profil ? ' ' + profil + ' profilinde' : '') + (model ? ' ' + model + ' modelinde' : '') + ' olculmus kosu yok' };
  const q = (p) => usd[Math.min(usd.length - 1, Math.floor(p * (usd.length - 1)))];
  return { kosu: usd.length, veriAz: usd.length < enAz,
    tahmin: { alt: q(0.25), orta: q(0.5), ust: q(0.75), enCok: usd[usd.length - 1] },
    neden: usd.length < enAz ? 'yalniz ' + usd.length + ' kosu: ornek, tahmin degil' : usd.length + ' kosudan ceyreklikler' };
}

/**
 * AYNI isin modellere gore karnesi. Yonlendirme icin tek gecerli temel budur:
 * modelKarsilastir() butun isleri bir torbaya atar, ama isler ayni zorlukta
 * degil - orada 'sonnet pahali' cikmasi sonnet'in kotu oldugunu gostermez,
 * sadece sonnet'in baska isleri kostugunu gosterir.
 *
 * Model kosunun kendi kaydindan okunur (isler.model isin SIMDIKI ayari).
 * Modeli olculmemis eski kosular disarida kalir ve sayisi ayrica bildirilir.
 */
export function isModelKarsilastir(db, isId, { enAzKosu = 3 } = {}) {
  const satirlar = db.prepare('SELECT * FROM kosular WHERE is_id = ?').all(isId);
  const olculmemis = satirlar.filter((r) => !r.model).length;
  const grup = new Map();
  for (const r of satirlar) {
    if (!r.model) continue;
    if (!grup.has(r.model)) grup.set(r.model, []);
    grup.get(r.model).push(kosuCoz(r));
  }
  const gruplar = [...grup]
    .map(([model, liste]) => ({ model, ...karneHesapla(liste) }))
    .filter((g) => g.kosu >= enAzKosu)
    .sort((a, b) => a.ortalamaUsd - b.ortalamaUsd);
  return { gruplar, olculmemis, enAzKosu };
}

/**
 * Bu is icin model onerisi. Otomatik DEGISTIRMEZ - oneri verir.
 *
 * Esikler kasten muhafazakar: ucuz model en az pahalinin kadar basarili olacak
 * VE gozle gorulur derecede ucuz olacak. Veri yoksa oneri de yok; "veri yok"
 * cevabi bir kusur degil, dogru cevap (bkz. README 'Token olcumu').
 */
export function isModelOnerisi(db, isId, { enAzKosu = 3 } = {}) {
  const { gruplar, olculmemis } = isModelKarsilastir(db, isId, { enAzKosu });
  const taban = { oneri: null, gruplar, olculmemis };
  if (gruplar.length < 2) {
    return { ...taban, neden: 'bu is icin en az iki modelde ' + enAzKosu + '+ kosu lazim'
      + (olculmemis ? ' (' + olculmemis + ' kosunun modeli olculmemis)' : '') };
  }
  const ucuz = gruplar[0], pahali = gruplar[gruplar.length - 1];
  if (ucuz.basariOrani == null || pahali.basariOrani == null) {
    return { ...taban, neden: 'hukumlu kosu yok, karsilastirilamaz' };
  }
  if (ucuz.basariOrani < pahali.basariOrani - 0.05) {
    return { ...taban, neden: ucuz.model + ' daha ucuz ama basarisi dusuk (%'
      + Math.round(ucuz.basariOrani * 100) + ' / %' + Math.round(pahali.basariOrani * 100) + ')' };
  }
  if (pahali.ortalamaUsd <= ucuz.ortalamaUsd * 1.5) {
    return { ...taban, neden: 'maliyet farki degistirmeye deger degil (1.5 kattan az)' };
  }
  const kat = pahali.ortalamaUsd / Math.max(ucuz.ortalamaUsd, 1e-9);
  return { ...taban, oneri: ucuz.model,
    neden: 'bu iste ' + ucuz.model + ' ile ' + pahali.model + ' basari orani benzer (%'
      + Math.round(ucuz.basariOrani * 100) + ' / %' + Math.round(pahali.basariOrani * 100)
      + ') ama ' + pahali.model + ' ' + kat.toFixed(1) + ' kat pahali' };
}
