// Kuyruk: ayni anda kac ajanin kosacagina karar verir.
//
// Bu dosya olmadan "otomatige baglamak" bir kota yakma makinesidir. 20 ajani
// ayni anda salarsan 5 saatlik pencereyi 40 dakikada bitirirsin. Es zamanlilik
// sinirlanabilir olmakla kalmiyor, CALISIRKEN degistirilebilir - Faz 3'teki
// kota beyni pencere daralinca bu sayiyi asagi cekecek.
//
// Oncelik: is.oncelik kucukse once (0 en acil), esitse once gelen.

import { EventEmitter } from 'node:events';
import { OLAY, yaz as olayYaz } from './events.js';
import { kosuAc, kosuGetir, kosuGuncelle, isGetir, KOSU_DURUMU } from './isler.js';
import { kosuBaslat } from './kosucu.js';
import { denetle } from './cakisma.js';

/** Bekleyen kosular, oncelik ve sira ile. */
export function bekleyenKosular(db, { limit = 100 } = {}) {
  return db.prepare(`
    SELECT k.id kosu_id, k.is_id, i.oncelik
    FROM kosular k JOIN isler i ON i.id = k.is_id
    WHERE k.durum = ?
    ORDER BY i.oncelik ASC, k.basladi ASC
    LIMIT ?
  `).all(KOSU_DURUMU.BEKLIYOR, limit).map((r) => ({ kosuId: r.kosu_id, isId: r.is_id, oncelik: r.oncelik }));
}

export class Kuyruk extends EventEmitter {
  /**
   * esZamanli : ayni anda en fazla kac kosu
   * kosucu    : kosuBaslat imzasi - testler gercek surec baslatmadan degistirir
   */
  constructor(db, { esZamanli = 2, kosucu = kosuBaslat, kosucuSecenekleri = {},
                    cakismaPolitikasi = 'uyar', baslatmaAraligiMs = 0 } = {}) {
    super();
    this.db = db;
    this.esZamanli = esZamanli;
    // 'uyar' | 'beklet' | 'yoksay' - bkz. cakisma.js
    this.cakismaPolitikasi = cakismaPolitikasi;
    this.kosucu = kosucu;
    this.kosucuSecenekleri = kosucuSecenekleri;
    this.calisan = new Map();  // kosuId -> promise
    // kosuId -> { durdur }: kosucu calisan surecin durdurma kolunu buraya takar.
    this.kontroller = new Map();
    // Cakisma yuzunden bu turda atlananlar; bir kosu bitince tekrar denenir.
    this.bekletilen = new Set();
    this.durduruldu = false;
    this.pompaliyor = false;
    // Kademeli baslatma: kosular ayni anda degil, aralikla acilir. Ayni saniyede
    // uc claude sureci baslatmak hem makineyi hem API'yi ayni ana yigar.
    // Varsayilan 0 (aninda); sunucu gercek kullanimda aralik veriyor.
    this.baslatmaAraligiMs = baslatmaAraligiMs;
    this.sonBaslatma = 0;
    this.bekleyenPompa = null;
  }

  /** Aralik dolunca tekrar pompalar. Tek zamanlayici: ust uste kurulmaz. */
  #sonraPompala(ms) {
    if (this.bekleyenPompa) return;
    this.bekleyenPompa = setTimeout(() => {
      this.bekleyenPompa = null;
      this.pompala();
    }, Math.max(1, ms));
  }

  /** Isi kuyruga alir; kosu kaydi 'bekliyor' durumunda acilir. */
  siraya(isId, ek = {}) {
    const is = isGetir(this.db, isId);
    if (!is) throw new Error('is bulunamadi: ' + isId);
    if (!is.etkin) throw new Error('is etkin degil: ' + is.ad);
    const kosu = kosuAc(this.db, isId, ek);
    olayYaz(this.db, { kind: OLAY.IS, sessionId: kosu.sessionId, project: is.ad,
      data: { asama: 'siraya-alindi', kosuId: kosu.id, isId, oncelik: is.oncelik } });
    this.emit('siraya', kosu);
    this.pompala();
    return kosu;
  }

  /** Es zamanlilik siniri calisirken degisebilir (kota beyni bunu kullanacak). */
  sinirAyarla(n) {
    const yeni = Math.max(0, Math.floor(n));
    if (yeni === this.esZamanli) return;
    const onceki = this.esZamanli;
    this.esZamanli = yeni;
    olayYaz(this.db, { kind: OLAY.IS, data: { asama: 'sinir-degisti', onceki, yeni } });
    this.emit('sinir', yeni);
    // Sinir yukseldiyse hemen doldur; dustuyse calisanlar kesilmez, biterler.
    this.pompala();
  }

  /**
   * Bos yer olduğu surece bekleyenleri baslatir.
   * Yeniden girisi engellenmis: her tetikleme tek bir gecis yapar.
   */
  pompala() {
    if (this.pompaliyor || this.durduruldu) return;
    this.pompaliyor = true;
    try {
      // Bekletilenleri her pompada yeniden degerlendir: cakisan kosu bitmis olabilir.
      this.bekletilen.clear();
      while (this.calisan.size < this.esZamanli) {
        const sira = bekleyenKosular(this.db, { limit: 20 })
          .filter((x) => !this.bekletilen.has(x.kosuId));
        if (!sira.length) break;
        const gecen = Date.now() - this.sonBaslatma;
        if (this.baslatmaAraligiMs > 0 && gecen < this.baslatmaAraligiMs) {
          this.#sonraPompala(this.baslatmaAraligiMs - gecen);
          break;
        }
        const onceki = this.calisan.size;
        this.#baslat(sira[0]);
        if (this.calisan.size > onceki) this.sonBaslatma = Date.now();
        // Cakisma yuzunden baslamadiysa dongu sonsuza girmesin.
        if (this.calisan.size === onceki && this.bekletilen.has(sira[0].kosuId)) continue;
        if (this.calisan.size === onceki) break;
      }
    } finally {
      this.pompaliyor = false;
    }
  }

  #baslat({ kosuId, isId }) {
    const is = isGetir(this.db, isId);
    const kosu = kosuGetir(this.db, kosuId);
    if (!is || !kosu) {
      // Is silinmis ama kosusu kalmis: kuyrugu tikamasin.
      kosuGuncelle(this.db, kosuId, { durum: KOSU_DURUMU.IPTAL, bitti: Date.now(), hata: 'is bulunamadi' });
      return;
    }
    // Ayni klasorde calisan baska ajan var mi? 'beklet' politikasinda
    // baslatmayiz; kuyruk cakisma bitince tekrar dener.
    const c = denetle(this.db, is, { politika: this.cakismaPolitikasi, kosuId });
    if (c.engelle) {
      this.emit('cakisma', { kosuId, isId, ...c });
      this.bekletilen.add(kosuId);
      return;
    }
    if (c.uyari) this.emit('cakisma', { kosuId, isId, ...c });

    // Durumu HEMEN calisiyor yap: pompa ayni kosuyu ikinci kez almasin.
    // basladi burada guncellenir: kuyrukta bekleme sure sayilmasin. Sinav yakaladi -
    // sira zamani kalinca sirayla calisan iki kosu "ayni anda" gorunuyor, golge
    // ortusme uyarisi ve karne sureleri yanlis cikiyordu.
    kosuGuncelle(this.db, kosuId, { durum: KOSU_DURUMU.CALISIYOR, basladi: Date.now() });

    const kontrol = {};
    this.kontroller.set(kosuId, kontrol);
    const p = Promise.resolve()
      // devamCevabi doluysa kosucu --resume yolunu secer.
      .then(() => this.kosucu(this.db, {
        is, kosu, devamCevabi: kosu.devamCevabi ?? null, kontrol, ...this.kosucuSecenekleri,
      }))
      .catch((e) => {
        // Kosucu beklenmedik sekilde patlarsa kayit 'calisiyor' asili kalmasin.
        kosuGuncelle(this.db, kosuId, {
          durum: KOSU_DURUMU.HATA, bitti: Date.now(), hata: 'kosucu hatasi: ' + (e?.message ?? e),
        });
        return { durum: KOSU_DURUMU.HATA, hata: String(e?.message ?? e) };
      })
      .then((sonuc) => {
        this.calisan.delete(kosuId);
        this.kontroller.delete(kosuId);
        this.emit('bitti', { kosuId, isId, sonuc });
        // Bir yer bosaldi: siradakini al.
        this.pompala();
        return sonuc;
      });

    this.calisan.set(kosuId, p);
    this.emit('basladi', { kosuId, isId, is });
  }

  /**
   * Bir ise insan talimati iletir. Iki yol:
   *   canli  - isin CALISAN kosusu varsa mesaj o kosunun stdin'ine yazilir; ajan ayni kosunun
   *            icinde gorur (kosucu.kontrol.talimat). Oldurme/yeniden baslatma yok.
   *   devam  - calisan kosu yoksa ve son kosu bitmisse, ayni oturumdan (--resume) talimatla
   *            devam kosusu acilir: ajan onceki isini hatirlar.
   * Karar bekleyen is talimat almaz: o is zaten bir cevap bekliyor (/cevap).
   */
  talimat(isId, metin) {
    const m = String(metin ?? '').trim();
    if (!m) throw new Error('talimat bos olamaz');
    const is = isGetir(this.db, isId);
    if (!is) throw new Error('is bulunamadi: ' + isId);

    const son = this.db.prepare('SELECT id, durum, session_id, dongu_id, tur, rol FROM kosular WHERE is_id = ? ORDER BY basladi DESC LIMIT 1').get(isId);
    for (const r of this.db.prepare("SELECT id FROM kosular WHERE is_id = ? AND durum = 'calisiyor' ORDER BY basladi DESC").all(isId)) {
      const kol = this.kontroller.get(r.id);
      if (kol?.talimat && kol.talimat(m)) return { yol: 'canli', kosuId: r.id };
    }
    if (!son) throw new Error('bu is hic kosmamis: once kuyruga al (/sira)');
    if (son.durum === KOSU_DURUMU.KARAR_BEKLIYOR) throw new Error('is karar bekliyor: talimat yerine karari cevapla (/cevap)');
    if (son.durum === KOSU_DURUMU.BEKLIYOR) throw new Error('kosu kuyrukta, henuz baslamadi: baslayinca tekrar dene');
    if (son.durum === KOSU_DURUMU.CALISIYOR) throw new Error('calisan kosu talimat kabul etmiyor (bitmek uzere olabilir): birazdan tekrar dene');

    // Bitmis kosu: ayni oturumdan devam. Dongu kimligi tasinmaz - bu yeni bir insan istegi.
    const devam = kosuAc(this.db, isId, { sessionId: son.session_id, devamCevabi: m });
    olayYaz(this.db, { kind: OLAY.IS, sessionId: son.session_id, project: is.ad,
      data: { asama: 'talimat', kosuId: devam.id, metin: m.slice(0, 400), canli: false } });
    this.emit('siraya', devam);
    this.pompala();
    return { yol: 'devam', kosuId: devam.id };
  }

  /**
   * Tek bir kosuyu durdurur.
   *   bekliyor  -> hic baslamadan iptal
   *   calisiyor -> surec agaci oldurulur, kosucu kaydi 'iptal' olarak kapatir
   * Bitmis kosu icin hata atar: durdurulacak bir sey yok.
   */
  kosuDurdur(kosuId, neden = 'kullanici') {
    const kosu = kosuGetir(this.db, kosuId);
    if (!kosu) throw new Error('kosu bulunamadi: ' + kosuId);
    const kontrol = this.kontroller.get(kosuId);
    if (kontrol?.durdur) {
      kontrol.durdur(neden);
      return { kosuId, durum: 'durduruluyor' };
    }
    if (kosu.durum === KOSU_DURUMU.BEKLIYOR) {
      kosuGuncelle(this.db, kosuId, { durum: KOSU_DURUMU.IPTAL, bitti: Date.now(), hata: 'durduruldu: ' + neden });
      olayYaz(this.db, { kind: OLAY.IS, sessionId: kosu.sessionId,
        data: { asama: 'durduruldu', kosuId, neden, baslamadan: true } });
      this.emit('bitti', { kosuId, isId: kosu.isId, sonuc: { durum: KOSU_DURUMU.IPTAL } });
      return { kosuId, durum: KOSU_DURUMU.IPTAL };
    }
    if (this.calisan.has(kosuId)) throw new Error('kosu henuz durdurulamiyor (surec baslatiliyor), tekrar dene');
    throw new Error('kosu calismiyor (durum: ' + kosu.durum + ')');
  }

  /**
   * Bir isin bekleyen ve calisan tum kosularini durdurur (denetim dongusundeki denetci
   * kosulari dahil). Is silinmeden once cagrilir. Donus: durdurulan kosu kimlikleri.
   * Saha (zamanlama atlama denemesi): calisan kosusu olan is silindi, kosu 8 sn sonra bitti
   * ve silinmis ise ait bir karar karti acildi.
   */
  isKosulariniDurdur(isId, neden = 'is silindi') {
    const satirlar = this.db.prepare(`SELECT id FROM kosular WHERE durum IN ('bekliyor','calisiyor')
      AND (is_id = ? OR dongu_id IN (SELECT dongu_id FROM kosular WHERE is_id = ? AND dongu_id IS NOT NULL))`)
      .all(isId, isId);
    const durdurulan = [];
    for (const r of satirlar) {
      try { this.kosuDurdur(r.id, neden); durdurulan.push(r.id); } catch { /* bu arada bitmis olabilir */ }
    }
    return durdurulan;
  }

  /** Yeni kosu baslatmayi durdurur; calisanlar kendi bitisini tamamlar. */
  durdur() {
    this.durduruldu = true;
  }

  devam() {
    this.durduruldu = false;
    this.pompala();
  }

  /** Calisan tum kosular bitene kadar bekler (test ve duzgun kapanis icin). */
  async bekle() {
    while (this.calisan.size) {
      await Promise.all([...this.calisan.values()]);
    }
  }

  durum() {
    return {
      esZamanli: this.esZamanli,
      calisan: this.calisan.size,
      bekleyen: bekleyenKosular(this.db, { limit: 500 }).length,
      durduruldu: this.durduruldu,
    };
  }
}
