// Bildirim kanallari. Ortak sozlesme: async gonder({ baslik, govde, onem }).
//
// Varsayilan kanal KASITLI olarak yerel: oturum basliklarin ve proje adlarin
// varsayilan ayarla hicbir yere gitmez. ntfy/webhook acikca secilir.

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { veriDizini, VERI_DIZINI } from './paths.js';

const NL = String.fromCharCode(10);
export const BILDIRIM_GUNLUGU = join(VERI_DIZINI, 'bildirimler.jsonl');

/** Yerel gunluk: hicbir sey makineden cikmaz. Varsayilan ve test kanali. */
export function gunlukKanali() {
  return {
    ad: 'gunluk',
    async gonder(p) {
      veriDizini();
      appendFileSync(BILDIRIM_GUNLUGU, JSON.stringify({
        t: Date.now(), onem: p.onem, baslik: p.baslik, govde: p.govde,
        oturum: p.sessionId ?? null, durum: p.durum ?? 'ozet',
      }) + NL, 'utf8');
    },
  };
}

/**
 * ntfy: telefonda tek uygulama, hesap gerekmiyor, kendi sunucun da olabilir.
 * DIKKAT: ntfy.sh'te konu adi bilen herkes okuyabilir - konuyu tahmin
 * edilemez tut ve icerik ayarini 'az' birak.
 */
export function ntfyKanali({ sunucu = 'https://ntfy.sh', konu }) {
  if (!konu) throw new Error('ntfy konusu tanimli degil: ayarlar.json > bildirim.ntfy.konu');
  // JSON yayinlama kullaniyoruz, baslik degil: HTTP basliklari latin-1 olmak
  // zorunda, ajan simgeleri ve Turkce karakterler baslikta gonderilemiyor.
  const adres = sunucu.replace(/\/+$/, '');
  return {
    ad: 'ntfy',
    async gonder(p) {
      const govde = {
        topic: konu,
        title: p.baslik,
        message: p.govde,
        // Acil olan telefonu sessiz moddan uyandirsin, normal olan uyandirmasin.
        priority: p.onem === 'acil' ? 4 : 3,
        tags: [p.onem === 'acil' ? 'rotating_light' : 'bell'],
      };
      const c = await fetch(adres, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(govde),
      });
      if (!c.ok) throw new Error('ntfy ' + c.status + ' ' + (await c.text()).slice(0, 120));
    },
  };
}

/** Genel webhook: Discord/Slack/kendi ucun. Ham JSON gonderir. */
export function webhookKanali({ url }) {
  if (!url) throw new Error('webhook adresi tanimli degil: ayarlar.json > bildirim.webhook.url');
  return {
    ad: 'webhook',
    async gonder(p) {
      const c = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(p),
      });
      if (!c.ok) throw new Error('webhook ' + c.status);
    },
  };
}

/**
 * Ana kanal ne olursa olsun KARAR bildirimlerini Telegram'a da (dugmeli) yollar.
 * Sebep: ntfy'de karar gorulur ama cevaplanamaz; Telegram eslesmisse tek dokunusla
 * cevaplanabilsin. Telegram hatasi ana kanalin gonderimini dusurmez.
 */
export function kararlarTelegramaDa(ana, telegram) {
  if (!telegram || ana === telegram) return ana;
  return {
    ad: ana.ad,
    async gonder(p) {
      // Kanallar BAGIMSIZ denenir. Saha: ntfy 'fetch failed' verdi, Telegram ondan sonra
      // cagrildigi icin karar karti telefona hic dusmedi - bir kanalin arizasi digerini susturdu.
      let anaHata = null, tgGitti = false;
      try { await ana.gonder(p); } catch (e) { anaHata = e; }
      if (p.kararId && telegram.eslesmis()) {
        try { await telegram.gonder(p); tgGitti = true; } catch { /* asagida degerlendirilir */ }
      }
      // Karar bir kanaldan ulastiysa teslim edilmistir; hicbiri gitmediyse hata yukari cikar.
      if (anaHata && !tgGitti) throw anaHata;
    },
  };
}

/**
 * Ayarlara gore kanal kurar. Yapilandirma eksikse patlamak yerine yerel
 * gunluge duser: bildirim ayari bozuk diye panel acilmasin.
 */
export function kanalKur(ayarlar, { telegram = null } = {}) {
  const a = ayarlar.bildirim;
  try {
    if (a.kanal === 'ntfy') return ntfyKanali(a.ntfy);
    if (a.kanal === 'webhook') return webhookKanali(a.webhook);
    // Telegram kanali disaridan kurulmus nesne (telegram.js): komut dinleyicisiyle ayni bot.
    if (a.kanal === 'telegram') {
      if (!telegram) throw new Error('telegram kurulu degil: ayarlar.json > telegram.token');
      return telegram;
    }
  } catch (e) {
    console.error('bildirim kanali kurulamadi (' + a.kanal + '): ' + e.message);
    console.error('yerel gunluge dusuluyor: ' + BILDIRIM_GUNLUGU);
  }
  return gunlukKanali();
}
