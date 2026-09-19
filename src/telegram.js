// Telegram: telefondan Suru'ye KOMUT vermek ve karar kartlarini dugmeyle cevaplamak.
//
// Neden Telegram (ntfy degil): ntfy tek yonlu bildirim icin iyi, ama komut icin
// herkese acik bir konuya yazmak gerekiyor - yetki yok. Telegram'da bot yalniz
// ESLESMIS sohbeti dinler; kimlik dogrulama, dugmeler ve mesaj gecmisi bedava.
// Neden long-polling (webhook degil): makinede port acmak, Tailscale/ters vekil
// kurmak gerekmez; sunucu disari dogru sorar, iceri hicbir sey acilmaz.
//
// Eslestirme: bot yabanci sohbetlere CEVAP VERMEZ (varligini bile belli etmez).
// Panelde/konsolda gorunen tek kullanimlik kodu bota yazan sohbet eslesir; kod
// sonra yenilenir. Eslesmis sohbet kv'de durur (telegram.sohbet).
//
// Bot token'i ayarlar.json'da (telegram.token) - Suru'nun icinde hicbir yerde
// yazili degil; token yoksa bu modul hic kurulmaz.

import { randomInt } from 'node:crypto';
import { kvOku, kvYaz } from './db.js';
import { kararGetir, kararKarti } from './eskalasyon.js';
import { kisa, kararDugmeleri } from './komut.js';

const NL = String.fromCharCode(10);
const SOHBET = 'telegram.sohbet';
const KOD = 'telegram.eslestirme';
const OFSET = 'telegram.ofset';
// Telegram tek mesajda 4096 karakter alir; uzun ciktilar bolunur.
const PARCA = 3900;

export function yeniKod() {
  return String(randomInt(100000, 999999));
}

/** Uzun metni Telegram sinirina gore satir sonlarindan boler. */
export function parcala(metin, sinir = PARCA) {
  const m = String(metin ?? '');
  if (m.length <= sinir) return [m];
  const out = [];
  let kalan = m;
  while (kalan.length > sinir) {
    let kes = kalan.lastIndexOf(NL, sinir);
    if (kes < sinir / 2) kes = sinir;
    out.push(kalan.slice(0, kes));
    kalan = kalan.slice(kes).replace(/^\n/, '');
  }
  if (kalan) out.push(kalan);
  return out;
}

export class Telegram {
  /**
   * komut : (metin, { kanal }) => { metin, dugmeler? } - komut.js'in komutCalistir'i (kanal bagimsiz;
   *         kanal='telegram' ile sunucu, geri alinamayan komutlarda onay dugmesi istetebilir)
   * fetchFn: testler sahte API verir; disariya hicbir sey gitmez
   */
  constructor(db, { token, komut, api = 'https://api.telegram.org', fetchFn = globalThis.fetch,
    bekleSn = 25, log = () => {} }) {
    if (!token) throw new Error('telegram token tanimli degil: ayarlar.json > telegram.token');
    this.db = db;
    this.ad = 'telegram';
    this.komut = komut;
    this.taban = api.replace(/\/+$/, '') + '/bot' + token + '/';
    this.fetchFn = fetchFn;
    this.bekleSn = bekleSn;
    this.log = log;
    this.calisiyor = false;
    this.hata = null;
    if (!kvOku(db, KOD, null)) kvYaz(db, KOD, yeniKod());
  }

  sohbet() { return kvOku(this.db, SOHBET, null); }
  eslestirmeKodu() { return kvOku(this.db, KOD, null); }
  eslesmis() { return this.sohbet() != null; }
  /** Eslesmeyi bozar: telefon kaybolursa panelden kesilir. */
  ayir() { kvYaz(this.db, SOHBET, null); kvYaz(this.db, KOD, yeniKod()); }

  async api(yontem, govde) {
    const c = await this.fetchFn(this.taban + yontem, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(govde ?? {}),
    });
    const j = await c.json().catch(() => ({}));
    if (!c.ok || j.ok === false) throw new Error('telegram ' + yontem + ' ' + c.status + ' ' + (j.description ?? ''));
    return j.result;
  }

  async mesajYaz(sohbet, metin, { dugmeler = null } = {}) {
    const parcalar = parcala(metin);
    for (let i = 0; i < parcalar.length; i++) {
      const govde = { chat_id: sohbet, text: parcalar[i], disable_web_page_preview: true };
      // Dugmeler son parcaya: metin bolunse de dugme cevabin altinda dursun.
      if (dugmeler && i === parcalar.length - 1) {
        govde.reply_markup = { inline_keyboard: dugmeler.map((d) => [{ text: d.etiket.slice(0, 60), callback_data: d.veri.slice(0, 64) }]) };
      }
      await this.api('sendMessage', govde);
    }
  }

  /**
   * Bildirim kanali sozlesmesi: gonder({ baslik, govde, onem, kararId? }).
   * Karar bildirimi dugmeyle gider: telefondan tek dokunusla cevaplanir.
   */
  async gonder(p) {
    const sohbet = this.sohbet();
    if (sohbet == null) throw new Error('telegram eslesmemis: bota eslestirme kodunu yaz');
    let dugmeler = null;
    if (p.kararId) {
      const karar = kararGetir(this.db, p.kararId);
      if (karar) dugmeler = kararDugmeleri(kararKarti(this.db, karar));
    }
    const metin = [p.baslik, p.govde].filter(Boolean).join(NL)
      + (p.kararId ? NL + '[' + kisa(p.kararId) + '] serbest cevap: /cevap ' + kisa(p.kararId) + ' <metin>' : '');
    await this.mesajYaz(sohbet, metin, { dugmeler });
  }

  /** Tek bir guncellemeyi isler. Yabanci sohbet: sessiz (eslestirme kodu haric). */
  async guncellemeyiIsle(g) {
    const m = g.message ?? g.edited_message ?? null;
    const cb = g.callback_query ?? null;
    const sohbetId = m?.chat?.id ?? cb?.message?.chat?.id ?? null;
    if (sohbetId == null) return { yok: true };
    const esli = this.sohbet();

    if (esli == null || String(esli) !== String(sohbetId)) {
      // Eslesmemis: sadece dogru kod eslestirir. Baska her sey yok sayilir.
      const metin = String(m?.text ?? '').trim();
      if (m && metin && metin === this.eslestirmeKodu()) {
        kvYaz(this.db, SOHBET, sohbetId);
        kvYaz(this.db, KOD, yeniKod());
        this.log('telegram: sohbet eslesti (' + sohbetId + ')');
        await this.mesajYaz(sohbetId, 'Sürü ile eslestin. /yardim ile komutlari gor.');
        return { eslesti: true };
      }
      if (cb) { try { await this.api('answerCallbackQuery', { callback_query_id: cb.id }); } catch { /* onemsiz */ } }
      return { yabanci: true };
    }

    if (cb) {
      const veri = String(cb.data ?? '');
      try { await this.api('answerCallbackQuery', { callback_query_id: cb.id }); } catch { /* onemsiz */ }
      // Onay dugmesi: 'o:<komut>' -> komut '!' ekiyle (onayli) calisir; 'o:vazgec' hicbir sey yapmaz.
      if (veri.startsWith('o:')) {
        const komut = veri.slice(2);
        if (komut === 'vazgec') { await this.mesajYaz(sohbetId, 'vazgecildi'); return { komut: 'vazgec' }; }
        const r = await this.komut(komut + ' !', { kanal: 'telegram' });
        await this.mesajYaz(sohbetId, r.metin);
        return { komut: komut.split(/\s+/)[0], sonuc: r, onayli: true };
      }
      // Karar dugmesi: 'k:<kararOnek>:<n>' -> /cevap
      const [tur, onek, n] = veri.split(':');
      if (tur !== 'k' || !onek || !n) return { yok: true };
      const r = await this.komut('/cevap ' + onek + ' ' + n, { kanal: 'telegram' });
      await this.mesajYaz(sohbetId, r.metin);
      return { komut: '/cevap', sonuc: r };
    }

    const metin = String(m?.text ?? '').trim();
    if (!metin) return { yok: true };
    const r = await this.komut(metin, { kanal: 'telegram' });
    if (Array.isArray(r.dugmeler) && r.dugmeler.length) {
      // Her karar ayri mesaj: dugmeler kendi kartinin altinda dursun. Tek dugme kumesi (onay) tek mesaj.
      const parcalar = r.dugmeler.length === 1 ? [r.metin] : r.metin.split(NL + NL);
      for (let i = 0; i < r.dugmeler.length; i++) {
        await this.mesajYaz(sohbetId, parcalar[i] ?? '', { dugmeler: r.dugmeler[i].secenekler });
      }
    } else {
      await this.mesajYaz(sohbetId, r.metin);
    }
    return { komut: metin.split(/\s+/)[0], sonuc: r };
  }

  /** Bir getUpdates turu: bekler, gelenleri isler, ofseti ilerletir. */
  async tur() {
    const ofset = Number(kvOku(this.db, OFSET, 0)) || 0;
    const liste = await this.api('getUpdates', { offset: ofset, timeout: this.bekleSn,
      allowed_updates: ['message', 'callback_query'] });
    let son = ofset;
    const sonuclar = [];
    for (const g of liste ?? []) {
      son = Math.max(son, Number(g.update_id) + 1);
      // Ofset ONCE yazilir: islem patlasa da ayni guncelleme sonsuza kadar tekrar islenmez.
      kvYaz(this.db, OFSET, son);
      try { sonuclar.push(await this.guncellemeyiIsle(g)); }
      catch (e) { this.log('telegram: guncelleme islenemedi: ' + (e?.message ?? e)); sonuclar.push({ hata: String(e?.message ?? e) }); }
    }
    return sonuclar;
  }

  /** Surekli dinleme. Ag hatasi dinlemeyi oldurmez: bekleyip yeniden dener. */
  baslat() {
    if (this.calisiyor) return;
    this.calisiyor = true;
    const dongu = async () => {
      let gecikme = 0;
      while (this.calisiyor) {
        try { await this.tur(); this.hata = null; gecikme = 0; }
        catch (e) {
          this.hata = String(e?.message ?? e);
          this.log('telegram: ' + this.hata);
          gecikme = Math.min(60_000, gecikme ? gecikme * 2 : 2_000);
        }
        if (gecikme) await new Promise((r) => setTimeout(r, gecikme));
      }
    };
    this.dongu = dongu();
  }

  durdur() { this.calisiyor = false; }

  durum() {
    return { etkin: true, eslesti: this.eslesmis(), kod: this.eslesmis() ? null : this.eslestirmeKodu(),
      dinliyor: this.calisiyor, hata: this.hata };
  }
}
