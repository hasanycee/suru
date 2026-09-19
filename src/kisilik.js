// Ajan kimligi: her oturum bir ad, bir simge ve bir renk alir.
//
// "oturum a3f9b2c1 seni bekliyor" ile "Kekik seni bekliyor" arasindaki fark
// kucuk gorunur ama butun aracin tonunu belirliyor - bildirimde, panelde ve
// Faz 4'teki piksel ofiste ayni kimlik kullanilacak.
//
// Kimlik SAKLANMAZ, oturum kimliginden hesaplanir: ayni oturum her yerde ayni
// ada sahip olur, hicbir yerde eslesme tablosu tutmaya gerek kalmaz.

const KADRO = [
  ['Kekik', '\u{1F33F}'], ['Zeytin', '\u{1FAD2}'], ['Nar', '\u{1F34E}'],
  ['Ceviz', '\u{1F330}'], ['Findik', '\u{1F95C}'], ['Badem', '\u{1F31E}'],
  ['Susam', '\u{1F33E}'], ['Tarcin', '\u{1F36A}'], ['Safran', '\u{1F338}'],
  ['Sumak', '\u{1F345}'], ['Pul', '\u{1F336}'], ['Reyhan', '\u{1F343}'],
  ['Nane', '\u{1F33F}'], ['Adaçay', '\u{1F375}'], ['Ihlamur', '\u{1F33C}'],
  ['Karabas', '\u{1F49C}'], ['Bogaz', '\u{1F30A}'], ['Poyraz', '\u{1F32C}'],
  ['Lodos', '\u{1F32A}'], ['Yildiz', '\u{2B50}'], ['Kutup', '\u{1F9ED}'],
  ['Pusula', '\u{1F9ED}'], ['Fener', '\u{1F3EE}'], ['Kandil', '\u{1F56F}'],
  ['Cinar', '\u{1F333}'], ['Kavak', '\u{1F332}'], ['Ardic', '\u{1F334}'],
  ['Sahin', '\u{1F985}'], ['Dogan', '\u{1F426}'], ['Turna', '\u{1F9A2}'],
  ['Kirlangic', '\u{1F54A}'], ['Bayku', '\u{1F989}'], ['Kartal', '\u{1F985}'],
  ['Tilki', '\u{1F98A}'], ['Vasak', '\u{1F408}'], ['Sansar', '\u{1F9A6}'],
  ['Ceylan', '\u{1F98C}'], ['Boztepe', '\u{1F3D4}'], ['Yayla', '\u{1F3D5}'],
  ['Deniz', '\u{1F30A}'], ['Kum', '\u{1F3D6}'], ['Cakil', '\u{1FAA8}'],
  ['Mercan', '\u{1FAB8}'], ['Inci', '\u{1F9AA}'], ['Kehribar', '\u{1F7E0}'],
  ['Firuze', '\u{1F499}'], ['Bakir', '\u{1F7EB}'], ['Tunc', '\u{1F949}'],
];

/** FNV-1a: kisa, hizli, dagilimi yeterli. Kriptografik amac yok. */
function karma(metin) {
  let h = 0x811c9dc5;
  for (let i = 0; i < metin.length; i++) {
    h ^= metin.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Oturum kimliginden kararli kimlik uretir.
 * Ayni kadro adi iki oturuma dusebilir; ayirt edici olan oturum kimligi,
 * ad sadece okunabilirlik icin. Cakisirsa ad sonuna kisa ek gelir.
 */
export function kisilik(sessionId, { ek = false } = {}) {
  const id = String(sessionId ?? '');
  const h = karma(id);
  const [ad, simge] = KADRO[h % KADRO.length];
  // Renk tonu addan bagimsiz olsun ki ayni adli iki ajan renkte ayrissin.
  const hue = karma(id + ':renk') % 360;
  return {
    ad: ek ? ad + '-' + id.slice(0, 4) : ad,
    simge,
    hue,
    // Doygunluk kasitli olarak dusuk, aciklik sabit: 48 ajan yan yana geldiginde
    // konfeti gibi degil tek bir aile gibi gorunsun. Panel ayni formulu kullaniyor.
    renk: 'hsl(' + hue + ' 46% 70%)',
  };
}

/**
 * Bir oturum kumesi icin kimlikleri uretir ve ad cakismalarini cozer.
 * Panelde ve bildirimde iki "Kekik" gorunmesin.
 */
export function kadroCikar(sessionIdler) {
  const sayim = new Map();
  for (const id of sessionIdler) {
    const { ad } = kisilik(id);
    sayim.set(ad, (sayim.get(ad) || 0) + 1);
  }
  const h = new Map();
  for (const id of sessionIdler) {
    const yalin = kisilik(id);
    h.set(id, sayim.get(yalin.ad) > 1 ? kisilik(id, { ek: true }) : yalin);
  }
  return h;
}

/**
 * Kimlik anahtari secimi.
 *
 * Otomasyon kosulari her seferinde YENI oturum acar. Kimligi oturumdan
 * turetirsek ajan her kosuda ad degistirir: ne karne birikir ne de piksel
 * ofiste ayni karakteri gorursun. Bu yuzden bir ISE bagli kosunun kimligi
 * isten gelir; elle acilmis oturumlarin (is yok) kimligi oturumdan.
 */
export function kimlikAnahtari({ isId = null, sessionId = null } = {}) {
  return isId || sessionId || '';
}

/** Bir kosu/karar/olay icin dogru kimlik. */
export function ajanKimligi(kaynak, secenekler) {
  return kisilik(kimlikAnahtari(kaynak), secenekler);
}

export const KADRO_BOYU = KADRO.length;
