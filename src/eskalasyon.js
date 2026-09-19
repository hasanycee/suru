// Eskalasyon: ajanin kendi cozemedigi seyin sana gelmesi.
//
// Sozlesme su: ajan tikandiginda kaybolmaz, bir KARAR birakir. Sen cevap
// verince ayni oturumdan devam eder (--resume) - gorevi bastan anlatmak
// gerekmez, ajan neyi neden yaptigini hatirliyor.
//
// Kararlar kosulardan TURETILIR, elle yaratilmaz: karar-bekliyor durumundaki
// her kosu icin bir karar acilir. Boylece sunucu cokup yeniden basladiginda
// da kayip karar olmaz - tarama tekrar bulur.

import { randomUUID } from 'node:crypto';
import { OLAY, yaz as olayYaz } from './events.js';
import { kosuAc, kosuGetir, isGetir, KOSU_DURUMU } from './isler.js';
import { ajanKimligi } from './kisilik.js';
import { profilAl } from './yetki.js';

const NL = String.fromCharCode(10);
const para = (u) => String.fromCharCode(36) + Number(u ?? 0).toFixed(2);

export const KARAR_DURUMU = {
  BEKLIYOR:   'bekliyor',
  CEVAPLANDI: 'cevaplandi',
  IPTAL:      'iptal',
};

export const KARAR_TURU = {
  HATA:      'hata',      // kosu basarisiz oldu
  IZIN:      'izin',      // bir sinira dayandi (izin reddi)
  PLAN:      'plan',      // plan uretti, uygulamak icin onay istiyor
  DOGRULAMA: 'dogrulama', // ajan bitti dedi ama dogrulama komutu gecmedi
  DENETIM:   'denetim',   // yapici/denetci dongusu tur siniri, butce ya da ilerleme yok ile durdu
  BUTCE:    'butce',     // kosu butce sinirina dayandi (hata degil: is yarim, para bitti)
};

/**
 * Kosunun neden karara dustugunu ve sorulacak soruyu cikarir.
 *
 * Soru ajan adini TASIMAZ: panel karti kimligi zaten basliginda gosteriyor,
 * iki kez yazmak gurultu. Adi gerektigi yerde (bildirim basligi) cagiran ekler.
 */
export function kararTanimla(kosu, is) {
  // Denetim dongusu durdu: denetci N tur sonunda hala ciddi sorun buluyor.
  if (kosu.terminalNeden === 'denetim-tikandi') {
    return {
      tur: KARAR_TURU.DENETIM,
      soru: 'Denetim dongusu durdu: denetci hala sorun buluyor. Ne yapilsin?',
      ayrinti: (kosu.hata || '').slice(0, 2000) || null,
    };
  }
  // Dogrulama basarisizligi once bakilir: ajan "bitti" dedi ama kanit tutmadi.
  // Bu, siradan bir hatadan farkli - ajan hata almadi, YANLIS is yapti.
  if (kosu.dogrulamaKod != null && kosu.dogrulamaKod !== 0) {
    return {
      tur: KARAR_TURU.DOGRULAMA,
      soru: 'Bitti dedi ama dogrulama gecmedi. Ne yapsin?',
      ayrinti: (kosu.dogrulamaCikti || kosu.hata || '').slice(0, 2000) || null,
    };
  }
  // Plan profilinde (her-karar) izin reddi BEKLENEN seydir: ajan planini dosyaya yazmayi dener,
  // plan modu reddeder. Kosu temiz bittiyse bu bir "sinira dayandi" degil, hazir bir plandir.
  // Saha (ogrenme plani): plan hazirdi ama kart "1 izin reddi, devam etsin mi?" diye acildi.
  const planProfili = (() => { try { return profilAl(is?.profil).eskalasyon === 'her-karar'; } catch { return false; } })();
  const temizBitti = !kosu.hata && kosu.terminalNeden !== 'budget_exhausted';
  if (kosu.redSayisi > 0 && !(planProfili && temizBitti)) {
    return {
      tur: KARAR_TURU.IZIN,
      soru: 'Bir sinira dayandi (' + kosu.redSayisi + ' izin reddi). Devam etsin mi?',
      ayrinti: kosu.sonuc || kosu.hata || null,
    };
  }
  // Butce bitti: ajan hata yapmadi, para bitti. 'Takildi' demek yaniltir ve 'hatayi incele'
  // cevabi ajani yanlis yere yollar. Saha (ogrenme plani): $0.15 sinirda kesif $0.19 yakti,
  // kart sebebi soylemiyordu.
  if (kosu.terminalNeden === 'budget_exhausted') {
    return {
      tur: KARAR_TURU.BUTCE,
      soru: 'Butce bitti: ' + para(kosu.usd) + ' harcadi'
        + (is?.butceUsd != null ? ' (sinir ' + para(is.butceUsd) + ')' : '') + ', is yarim. Devam etsin mi?',
      ayrinti: (kosu.sonuc || '').slice(0, 800) || null,
    };
  }
  if (kosu.hata || kosu.durum === KOSU_DURUMU.HATA) {
    return {
      tur: KARAR_TURU.HATA,
      soru: 'Takildi: ' + (is?.ad ?? 'is') + '. Ne yapsin?',
      ayrinti: (kosu.hata || '').slice(0, 800) || null,
    };
  }
  return {
    tur: KARAR_TURU.PLAN,
    soru: 'Planini hazirladi. Uygulasin mi?',
    ayrinti: (kosu.sonuc || '').slice(0, 2000) || null,
  };
}

/**
 * karar-bekliyor kosulari icin eksik kararlari acar.
 * Idempotent: kosu_id benzersiz, ikinci taramada tekrar acilmaz.
 */
export function kararlariTazele(db) {
  const kosular = db.prepare(`
    SELECT k.* FROM kosular k
    LEFT JOIN kararlar r ON r.kosu_id = k.id
    WHERE k.durum = ? AND r.id IS NULL
  `).all(KOSU_DURUMU.KARAR_BEKLIYOR);

  const yeni = [];
  for (const row of kosular) {
    const kosu = kosuGetir(db, row.id);
    const is = isGetir(db, kosu.isId);
    // Isi silinmis kosu icin karar acilmaz: cevaplanacak bir is yok. (Silme sirasinda durdurma
    // kacarsa ya da yaris olursa son savunma hatti.)
    if (!is) {
      db.prepare('UPDATE kosular SET durum = ?, bitti = COALESCE(bitti, ?), hata = ? WHERE id = ?')
        .run(KOSU_DURUMU.IPTAL, Date.now(), 'is silinmis; karar acilmadi', kosu.id);
      continue;
    }
    const { tur, soru, ayrinti } = kararTanimla(kosu, is);
    const karar = {
      id: randomUUID(), kosuId: kosu.id, isId: kosu.isId, sessionId: kosu.sessionId,
      tur, soru, ayrinti, olusturuldu: Date.now(), durum: KARAR_DURUMU.BEKLIYOR,
    };
    db.prepare(`INSERT INTO kararlar (id, kosu_id, is_id, session_id, tur, soru, ayrinti, olusturuldu, durum)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(karar.id, karar.kosuId, karar.isId, karar.sessionId, karar.tur,
        karar.soru, karar.ayrinti, karar.olusturuldu, karar.durum);

    olayYaz(db, { kind: OLAY.KARAR, sessionId: kosu.sessionId, project: is?.ad ?? null,
      data: { asama: 'acildi', kararId: karar.id, tur, kosuId: kosu.id,
        isId: kosu.isId, soru } });
    yeni.push(karar);
  }
  return yeni;
}

const coz = (r) => r && {
  id: r.id, kosuId: r.kosu_id, isId: r.is_id, sessionId: r.session_id,
  tur: r.tur, soru: r.soru, ayrinti: r.ayrinti, olusturuldu: r.olusturuldu,
  durum: r.durum, cevap: r.cevap, cevaplandi: r.cevaplandi, devamKosuId: r.devam_kosu_id,
};

export function kararGetir(db, id) {
  return coz(db.prepare('SELECT * FROM kararlar WHERE id = ?').get(id));
}

export function bekleyenKararlar(db, { limit = 50 } = {}) {
  return db.prepare('SELECT * FROM kararlar WHERE durum = ? ORDER BY olusturuldu LIMIT ?')
    .all(KARAR_DURUMU.BEKLIYOR, limit).map(coz);
}

/**
 * Hazir cevaplar. Telefondan uzun metin yazmak zahmetli - tek dokunusla
 * gonderilecek secenekler.
 */
export const HAZIR_CEVAPLAR = {
  [KARAR_TURU.IZIN]: [
    { etiket: 'Devam et',   cevap: 'Devam et. Reddedilen adimi atla, yapabildigin kadarini tamamla.' },
    { etiket: 'Vazgec',     eylem: 'iptal' },
  ],
  [KARAR_TURU.HATA]: [
    { etiket: 'Tekrar dene', cevap: 'Hatayi tekrar incele ve baska bir yol dene.' },
    { etiket: 'Aciklama iste', cevap: 'Neden basarisiz oldugunu ayrintili anlat, hicbir sey degistirme.' },
    { etiket: 'Vazgec',      eylem: 'iptal' },
  ],
  [KARAR_TURU.BUTCE]: [
    { etiket: 'Devam et (ayni butce kadar daha)', cevap: 'Butce yenilendi. Kaldigin yerden devam et; bastan kesif yapma, isi tamamla.' },
    { etiket: 'Vazgec', eylem: 'iptal' },
  ],
  [KARAR_TURU.DOGRULAMA]: [
    { etiket: 'Duzelt', cevap: 'Dogrulama komutu gecmedi. Ciktiya bak, sorunu bul ve duzelt, sonra tekrar dogrula.' },
    { etiket: 'Yine de kabul et', eylem: 'kabul' },
    { etiket: 'Vazgec', eylem: 'iptal' },
  ],
  [KARAR_TURU.DENETIM]: [
    { etiket: 'Bulgulari duzelt', cevap: 'Denetcinin bulgularini duzelt. Iddia ettigin her seyi gercekten calistirarak dogrula.' },
    { etiket: 'Yine de kabul et', eylem: 'kabul' },
    { etiket: 'Vazgec', eylem: 'iptal' },
  ],
  [KARAR_TURU.PLAN]: [
    // eylem: plan profili yazamaz; 'Uygula' isi uygulayan profile gecirir (bkz. planUygula).
    { etiket: 'Uygula (denetimli profilde)', eylem: 'uygula' },
    { etiket: 'Revize et', cevap: 'Plani gozden gecir: daha kucuk ve geri alinabilir adimlara bol.' },
    { etiket: 'Vazgec',   eylem: 'iptal' },
  ],
};

export function iptalEt(db, kararId) {
  const karar = kararGetir(db, kararId);
  if (!karar) throw new Error('karar bulunamadi: ' + kararId);
  if (karar.durum !== KARAR_DURUMU.BEKLIYOR) throw new Error('karar zaten kapali: ' + karar.durum);
  db.prepare('UPDATE kararlar SET durum = ?, cevaplandi = ? WHERE id = ?')
    .run(KARAR_DURUMU.IPTAL, Date.now(), kararId);
  db.prepare('UPDATE kosular SET durum = ?, bitti = ? WHERE id = ?')
    .run(KOSU_DURUMU.IPTAL, Date.now(), karar.kosuId);
  olayYaz(db, { kind: OLAY.KARAR, sessionId: karar.sessionId,
    data: { asama: 'iptal', kararId, kosuId: karar.kosuId } });
  return karar;
}

/**
 * Karari kapatir ve kosuyu BASARILI sayar - ajani tekrar calistirmadan.
 *
 * Dogrulama basarisizliklarinin bir kismi gercek degil (kirilgan test, ortam
 * sorunu). O durumda ajani yeniden kosturmak para ve zaman yakmak olur;
 * insan "bu sorun degil" diyebilmeli. Kabul edildigi denetim kaydina gecer.
 */
export function kabulEt(db, kararId, { not = null } = {}) {
  const karar = kararGetir(db, kararId);
  if (!karar) throw new Error('karar bulunamadi: ' + kararId);
  if (karar.durum !== KARAR_DURUMU.BEKLIYOR) throw new Error('karar zaten kapali: ' + karar.durum);

  db.prepare(`UPDATE kararlar SET durum = ?, cevap = ?, cevaplandi = ? WHERE id = ?`)
    .run(KARAR_DURUMU.CEVAPLANDI, not ?? 'insan tarafindan kabul edildi', Date.now(), kararId);
  db.prepare('UPDATE kosular SET durum = ? WHERE id = ?')
    .run(KOSU_DURUMU.BITTI, karar.kosuId);

  olayYaz(db, { kind: OLAY.KARAR, sessionId: karar.sessionId,
    data: { asama: 'kabul', kararId, kosuId: karar.kosuId, tur: karar.tur } });
  return kararGetir(db, kararId);
}

/**
 * Karari cevaplar ve devam kosusunu ACAR (baslatmaz - onu kuyruk yapar).
 * Devam kosusu ayni session_id'yi tasir: --resume ile ayni sohbet surer.
 */
export function cevapla(db, kararId, cevap) {
  const karar = kararGetir(db, kararId);
  if (!karar) throw new Error('karar bulunamadi: ' + kararId);
  if (karar.durum !== KARAR_DURUMU.BEKLIYOR) throw new Error('karar zaten kapali: ' + karar.durum);
  if (!cevap || !String(cevap).trim()) throw new Error('cevap bos olamaz');

  // Ayni oturumdan devam: yeni kosu kaydi, eski session_id, ve cevabin kendisi.
  // Cevap kayitta durmazsa kuyruk bu kosuyu sifirdan baslatir.
  // Denetim ve dogrulama kararinda ajan ayrintiyi (bulgular / dogrulama ciktisi) kartta
  // gordugumuz haliyle bilmez: cevaba eklenir. Saha: "Duzelt, ciktiya bak" diyen cevapla
  // devam eden ajan ciktiyi hic gormuyordu.
  const metin = (karar.tur === KARAR_TURU.DENETIM || karar.tur === KARAR_TURU.DOGRULAMA) && karar.ayrinti
    ? String(cevap).trim() + NL + NL + karar.ayrinti
    : String(cevap).trim();
  // Dongu kosusuysa kimligi devamda da surer: devam bitince denetci yeniden bakar.
  const onceki = kosuGetir(db, karar.kosuId);
  const devam = kosuAc(db, karar.isId, {
    sessionId: karar.sessionId,
    devamCevabi: metin,
    donguId: onceki?.donguId ?? null, tur: onceki?.tur ?? null, rol: onceki?.rol ?? null,
  });

  db.prepare(`UPDATE kararlar SET durum = ?, cevap = ?, cevaplandi = ?, devam_kosu_id = ?
              WHERE id = ?`)
    .run(KARAR_DURUMU.CEVAPLANDI, String(cevap).trim(), Date.now(), devam.id, kararId);

  // Cevaplanan kosu artik kapali; devami yeni kosuda surecek.
  db.prepare('UPDATE kosular SET durum = ? WHERE id = ?')
    .run(KOSU_DURUMU.BITTI, karar.kosuId);

  olayYaz(db, { kind: OLAY.KARAR, sessionId: karar.sessionId,
    data: { asama: 'cevaplandi', kararId, kosuId: karar.kosuId, devamKosuId: devam.id,
      cevap: String(cevap).trim().slice(0, 200) } });

  return { karar: kararGetir(db, kararId), devamKosu: devam };
}

/**
 * Kapsam celiskisi kararinin dosyalari. dongu.js tikandi gerekcesinden okunur:
 * "kapsam celiskisi: gorev yazmasi yasak dosyayi gerektiriyor (config.yaml, x.json) - ..."
 */
export function kapsamCeliskiDosyalari(karar) {
  if (karar?.tur !== KARAR_TURU.DENETIM) return [];
  const m = String(karar.ayrinti ?? '').match(/kapsam celiskisi: gorev yazmasi yasak dosyayi gerektiriyor \(([^)]+)\)/);
  return m ? m[1].split(',').map((x) => x.trim()).filter(Boolean) : [];
}

/**
 * "Kapsami genislet ve devam et": celisen dosyalar isin kapsamina eklenir, karar cevaplanir,
 * ajan ayni oturumdan (ve ayni dongu kimligiyle) devam eder. Devam kosusunun ayar dosyasi
 * guncel kapsamdan uretildigi icin yazma yasagi kalkar; bitince denetci yeniden bakar.
 * Saha (kampanya 7): celiskide tek secenek kabul/iptaldi; kapsami duzeltmek isi silip
 * yeniden eklemek demekti.
 */
export function kapsamGenislet(db, kararId, { yollar = null } = {}) {
  const karar = kararGetir(db, kararId);
  if (!karar) throw new Error('karar bulunamadi: ' + kararId);
  if (karar.durum !== KARAR_DURUMU.BEKLIYOR) throw new Error('karar zaten kapali: ' + karar.durum);
  const dosyalar = Array.isArray(yollar) && yollar.length ? yollar.map(String) : kapsamCeliskiDosyalari(karar);
  if (!dosyalar.length) throw new Error('bu kararda kapsam celiskisi yok');
  const is = isGetir(db, karar.isId);
  if (!is) throw new Error('is silinmis');

  const yeni = [...new Set([...(is.kapsam ?? []), ...dosyalar])];
  db.prepare('UPDATE isler SET kapsam = ? WHERE id = ?').run(JSON.stringify(yeni), is.id);
  olayYaz(db, { kind: OLAY.KARAR, sessionId: karar.sessionId, project: is.ad,
    data: { asama: 'kapsam-genisletildi', kararId, eklenen: dosyalar, kapsam: yeni } });

  const cevap = 'Kapsam insan tarafindan genisletildi: ' + dosyalar.join(', ') + ' artik yazilabilir. '
    + 'Gorevin bu dosyalarda eksik kalan kismini tamamla; baska dosyaya dokunma.';
  return { ...cevapla(db, kararId, cevap), kapsam: yeni, eklenen: dosyalar };
}

/** Plani uygulayacak profil: duzenler ama riskli komutlarda sorar. */
export const UYGULAMA_PROFILI = 'denetimli';

/**
 * "Plani uygula": plan profili (danisan) yazma araci tasimaz, devam kosusu da ayni profille
 * acilirdi - "Uygula" sonsuza kadar yeni bir plan karari uretiyordu (saha: ogrenme plani).
 * Is UYGULAMA_PROFILI'ne gecirilir ve ayni oturumdan devam eder: ajan planini hatirliyor,
 * CLI bayraklari kosu basina verildigi icin yazma araclari devam kosusunda acilir.
 * Profil degisikligi kalicidir ve olay akisina yazilir - sessiz yetki yukseltme yok.
 */
export function planUygula(db, kararId) {
  const karar = kararGetir(db, kararId);
  if (!karar) throw new Error('karar bulunamadi: ' + kararId);
  if (karar.durum !== KARAR_DURUMU.BEKLIYOR) throw new Error('karar zaten kapali: ' + karar.durum);
  if (karar.tur !== KARAR_TURU.PLAN) throw new Error('bu bir plan karari degil: ' + karar.tur);
  const is = isGetir(db, karar.isId);
  if (!is) throw new Error('is silinmis');
  const onceki = is.profil;
  if (onceki !== UYGULAMA_PROFILI) {
    db.prepare('UPDATE isler SET profil = ? WHERE id = ?').run(UYGULAMA_PROFILI, is.id);
    olayYaz(db, { kind: OLAY.KARAR, sessionId: karar.sessionId, project: is.ad,
      data: { asama: 'profil-degisti', kararId, onceki, yeni: UYGULAMA_PROFILI, neden: 'plan onaylandi' } });
  }
  const cevap = 'Plan onaylandi. Simdi UYGULA: artik dosya duzenleyebilirsin. Plandaki adimlari sirayla hayata gecir, '
    + 'plan disina cikma, bitince hangi dosyada ne degistirdigini raporla.';
  return { ...cevapla(db, kararId, cevap), profil: UYGULAMA_PROFILI, oncekiProfil: onceki };
}

/** Panelde gosterilecek hali: ajan kimligi ve hazir cevaplarla birlikte. */
export function kararKarti(db, karar) {
  const is = isGetir(db, karar.isId);
  // Kimlik isten: ayni is hep ayni ajan tarafindan yapiliyormus gibi gorunsun.
  const k = ajanKimligi({ isId: karar.isId, sessionId: karar.sessionId });
  return {
    id: karar.id,
    tur: karar.tur,
    soru: karar.soru,
    ayrinti: karar.ayrinti,
    olusturuldu: karar.olusturuldu,
    ajan: { ad: k.ad, simge: k.simge, hue: k.hue },
    is: is ? { ad: is.ad, profil: is.profil, cwd: is.cwd } : null,
    // Kapsam celiskisinde en one "kapsami genislet": en olasi ve en ucuz insan karari.
    secenekler: (() => {
      const hazir = HAZIR_CEVAPLAR[karar.tur] ?? [];
      const dosyalar = kapsamCeliskiDosyalari(karar);
      return dosyalar.length
        ? [{ etiket: 'Kapsami genislet (' + dosyalar.join(', ') + ') ve devam et', eylem: 'kapsam' }, ...hazir]
        : hazir;
    })(),
  };
}
