// Is sablonlari: sik acilan isler icin hazir gorev metni + profil + dogrulama + kapsam.
// Kullanim: /yeni <proje> #inceleme  (Telegram/panel) ya da panel formunda sablon secimi.
// Sablon bir ONERI: gorev metni ve ayarlar is acilirken kopyalanir, sonra istenirse duzenlenir.
// Proje ozgu degerler (test komutu) sablonda yer tutucu olarak durur: sablon projenin son isinden
// dogrulama komutunu miras alir; yoksa dogrulama bos kalir (ajanin "bitti" demesi yeterli sayilir).

export const SABLONLAR = {
  inceleme: {
    ad: 'kod-incelemesi',
    aciklama: 'Salt-okur kod incelemesi; hata, risk ve iyilestirme listesi yazar, dosya degistirmez.',
    profil: 'gozlemci',
    gorev: [
      'Bu projede kod incelemesi yap. Hicbir dosyayi degistirme.',
      'Once yapiyi anla (giris noktasi, moduller, testler). Sonra su basliklarda kisa ve somut bir rapor yaz:',
      '1) Hatalar ve riskler (dosya:satir ile), 2) Test acigi olan yerler, 3) Sadelestirme firsatlari.',
      'Sayilari uydurma: bir sayi veriyorsan onu nasil olctugunu yaz. Rapor 40 satiri gecmesin.',
    ].join(' '),
  },
  test: {
    ad: 'test-kapsami',
    aciklama: 'Test kapsamini artirir: mevcut test duzenini takip eder, dogrulama komutuyla kosar.',
    profil: 'denetimli',
    gorev: [
      'Bu projede test kapsamini artir. Once mevcut test duzenini (calistirma komutu, klasor, adlandirma) bul ve AYNEN uy.',
      'Test edilmemis ama kritik davranislari sec (hata yollari, sinir degerleri). Her yeni test tek bir davranisi sinasin.',
      'Uretim kodunu sadece test edilebilirlik icin ZORUNLUYSA ve en kucuk sekilde degistir; degistirdiysen raporda yaz.',
      'Bitirmeden tum testleri kos; kalan test varsa duzelt ya da raporda acikca soyle.',
    ].join(' '),
  },
  readme: {
    ad: 'readme-guncelle',
    aciklama: 'README dosyasini koddaki gercek duruma gore gunceller; sadece README kapsaminda.',
    profil: 'denetimli',
    kapsam: ['README.md'],
    gorev: [
      'README.md dosyasini projenin GERCEK durumuna gore guncelle: kurulum, calistirma, komutlar, yapi.',
      'Her iddiayi koddan dogrula (komut adlari, dosya yollari, ayar anahtarlari). Olmayan ozelligi yazma.',
      'Sadece README.md degisir. Mevcut dil ve tonu koru; bolumleri silme, guncelle.',
    ].join(' '),
  },
  hata: {
    ad: 'hata-avi',
    aciklama: 'Belirtilen hatayi yeniden uretir, kok nedeni bulur, en kucuk duzeltmeyi yapar.',
    profil: 'denetimli',
    gorev: [
      'Su hatayi ele al: {ek}. Once hatayi yeniden uret (test ya da komutla), sonra kok nedeni bul.',
      'En kucuk ve en guvenli duzeltmeyi yap; yan etkileri raporda yaz. Duzeltmeyi kanitlayan bir test ekle.',
    ].join(' '),
  },
};

export const SABLON_ADLARI = Object.keys(SABLONLAR);

/** Sablon metni: "#inceleme" ya da "inceleme" -> sablon; yoksa hata. */
export function sablonAl(ad) {
  const a = String(ad ?? '').trim().replace(/^#/, '').toLowerCase();
  const s = SABLONLAR[a];
  if (!s) throw new Error('bilinmeyen sablon: ' + ad + ' (gecerli: ' + SABLON_ADLARI.map((x) => '#' + x).join(' ') + ')');
  return { anahtar: a, ...s };
}

/**
 * Sablondan is alanlari uretir. ek: kullanicinin sablona eklemek istedigi metin ("{ek}" yer tutucusu
 * varsa oraya, yoksa gorevin sonuna eklenir). ornek: projenin son isi (dogrulama komutu miras).
 */
export function sablondanIs(ad, { ek = '', ornek = null } = {}) {
  const s = sablonAl(ad);
  const e = String(ek ?? '').trim();
  let gorev = s.gorev;
  if (gorev.includes('{ek}')) {
    if (!e) throw new Error('#' + s.anahtar + ' sablonu ek metin ister: /yeni <proje> #' + s.anahtar + ' | <ne>');
    gorev = gorev.replace('{ek}', () => e);
  } else if (e) gorev = gorev + ' Ek: ' + e;
  return {
    ad: s.ad, gorev, profil: s.profil,
    kapsam: s.kapsam ?? null,
    dogrulama: s.dogrulama ?? ornek?.dogrulama ?? null,
    sablon: s.anahtar,
  };
}

export function sablonListesi() {
  return SABLON_ADLARI.map((a) => '#' + a.padEnd(10) + SABLONLAR[a].aciklama + ' (' + SABLONLAR[a].profil + ')');
}
