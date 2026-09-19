// Anlati: ham olaylari INSAN DILINDE tek satira cevirir. Komuta merkezi bunu gosterir.
//
// Neden sunucuda: cumle kurallari saf fonksiyon - node:test ile sinanir. Sayfa aptal kalir
// (gelen metni basar); ayni cumleler ileride Telegram ozetinde de kullanilabilir.
//
// Her cumle: { metin, ton, ses }
//   ton: 'bilgi' | 'iyi' | 'kotu' | 'soru' | 'arac' | 'soz'   (renk/simge secimi)
//   ses: 'karar' | 'bitti' | 'hata' | null                     (sayfa bunu calar)

import { basename } from 'node:path';
import { OLAY } from './events.js';

const kirp = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};
const dosya = (y) => (y ? basename(String(y).replace(/\\/g, '/')) : '?');
const para = (u) => String.fromCharCode(36) + Number(u ?? 0).toFixed(2);

/**
 * Arac cagrisinin tek satirlik ozeti: "ne yapiyor" sorusunun cevabi.
 * Girdi modelden gelir, sekli garanti degil - her alan opsiyonel okunur.
 */
export function aracOzeti(arac, girdi) {
  const g = girdi && typeof girdi === 'object' ? girdi : {};
  switch (arac) {
    case 'Read':  return 'okuyor: ' + dosya(g.file_path) + (g.offset ? ' (satir ' + g.offset + '…)' : '');
    case 'Edit':  return 'duzenliyor: ' + dosya(g.file_path);
    case 'Write': return 'yaziyor: ' + dosya(g.file_path);
    case 'NotebookEdit': return 'defter duzenliyor: ' + dosya(g.notebook_path);
    case 'Grep':  return 'ariyor: "' + kirp(g.pattern, 40) + '"' + (g.glob ? ' (' + g.glob + ')' : '');
    case 'Glob':  return 'dosya ariyor: ' + kirp(g.pattern, 50);
    case 'Bash':
    case 'PowerShell': return 'komut: ' + kirp(g.description || g.command, 70);
    case 'WebFetch':  return 'web: ' + kirp(g.url, 60);
    case 'WebSearch': return 'web aramasi: ' + kirp(g.query, 50);
    case 'Task':
    case 'Agent': return 'alt ajan: ' + kirp(g.description || g.prompt, 50);
    case 'TodoWrite': return 'yapilacaklar listesini guncelliyor';
    case 'ExitPlanMode': return 'plani sunuyor';
    default: return String(arac ?? 'arac');
  }
}

const IS_CUMLE = {
  'siraya-alindi':    () => ({ metin: 'kuyruga girdi', ton: 'bilgi' }),
  'kuyruktan-alindi': (d) => ({ metin: 'ise basliyor' + (d.profil ? ' (' + d.profil + ')' : ''), ton: 'bilgi' }),
  'basladi':          (d) => ({ metin: 'oturum acildi' + (d.model ? ' · ' + String(d.model).replace(/^claude-/, '') : ''), ton: 'bilgi' }),
  'worktree-acildi':  (d) => ({ metin: 'izole dalda calisiyor: ' + (d.dal ?? '?'), ton: 'bilgi' }),
  'worktree-kapandi': (d) => ({ metin: 'is kendi dalina teslim edildi: ' + (d.dal ?? '?') + (d.degisen != null ? ' (' + d.degisen + ' dosya)' : ''), ton: 'iyi' }),
  'dogrulaniyor':     (d) => ({ metin: 'dogrulama kosuyor: ' + kirp(d.komut, 50), ton: 'bilgi' }),
  'dogrulandi':       (d) => (d.gecti
    ? { metin: 'dogrulama gecti', ton: 'iyi' }
    : { metin: 'dogrulama KALDI' + (d.zamanAsimi ? ' (zaman asimi)' : ' (cikis ' + d.kod + ')'), ton: 'kotu', ses: 'hata' }),
  'bitti':            (d) => (d.hataliMi
    ? { metin: 'kosu hatayla bitti' + (d.terminalNeden ? ' (' + d.terminalNeden + ')' : '') + ' · ' + para(d.usd), ton: 'kotu', ses: 'hata' }
    : { metin: 'kosu bitti · ' + para(d.usd) + ' · ' + (d.turSayisi ?? '?') + ' tur', ton: 'iyi', ses: 'bitti' }),
  'talimat':          (d) => ({ metin: 'SEN' + (d.canli ? ' (canli)' : ' (devam kosusu)') + ': ' + kirp(d.metin, 200), ton: 'insan' }),
  'baglam-esigi':     (d) => ({ metin: 'baglam esigi asildi (' + Math.round((d.girdi || 0) / 1000) + 'k token): ajana ozet yazip durmasi soylendi', ton: 'bilgi' }),
  'baglam-devam':     (d) => ({ metin: 'ozetten yeni oturum acildi (baglam sifirlandi)' + (d.parca ? ' · parca ' + d.parca : ''), ton: 'bilgi' }),
  'oneri':            (d) => ({ metin: 'ajan sonraki adim onerdi: ' + kirp(d.metin, 120), ton: 'bilgi' }),
  'durduruluyor':     (d) => ({ metin: 'durduruluyor (' + (d.neden ?? '?') + ')', ton: 'kotu' }),
  'durduruldu':       () => ({ metin: 'durduruldu', ton: 'kotu' }),
  'geri-alindi':      (d) => ({ metin: 'degisiklikler geri alindi (' + (d.geriAlinan ?? '?') + ' dosya)', ton: 'bilgi' }),
  'sinir-degisti':    (d) => ({ metin: 'es zamanlilik ' + d.onceki + ' → ' + d.yeni + ' (kota beyni)', ton: 'bilgi' }),
  'denetim-siraya':   (d) => ({ metin: 'denetci inceliyor' + (d.tur ? ' (tur ' + d.tur + ')' : ''), ton: 'bilgi' }),
  'dongu-gecti':      () => ({ metin: 'denetimden gecti', ton: 'iyi', ses: 'bitti' }),
  'gecti':            () => ({ metin: 'denetimden gecti', ton: 'iyi', ses: 'bitti' }),
  'dongu-yeni-tur':   (d) => ({ metin: 'denetci sorun buldu, yapici yeni tura giriyor' + (d.tur ? ' (tur ' + d.tur + ')' : ''), ton: 'kotu' }),
  'yeni-tur':         (d) => ({ metin: 'yeni tur' + (d.tur ? ' ' + d.tur : ''), ton: 'bilgi' }),
  'dongu-dogrulama-yeni-tur': () => ({ metin: 'dogrulama kaldi, yapici duzeltmeye donuyor', ton: 'kotu' }),
  'dogrulama-yeni-tur': () => ({ metin: 'dogrulama kaldi, yapici duzeltmeye donuyor', ton: 'kotu' }),
  'dongu-tikandi':    (d) => ({ metin: 'denetim dongusu tikandi' + (d.neden ? ': ' + kirp(d.neden, 60) : ''), ton: 'kotu', ses: 'hata' }),
  'tikandi':          (d) => ({ metin: 'dongu tikandi' + (d.neden ? ': ' + kirp(d.neden, 60) : ''), ton: 'kotu', ses: 'hata' }),
  'dogrulama-insana': () => ({ metin: 'dogrulama tekrar kaldi, karar sana geliyor', ton: 'soru' }),
  'zamanlandi':       () => ({ metin: 'zamanlayici tetikledi', ton: 'bilgi' }),
  'git-tetiklendi':   (d) => ({ metin: 'git degisikligi tetikledi' + (d.ref ? ' (' + d.ref + ')' : ''), ton: 'bilgi' }),
};

const KARAR_CUMLE = {
  // Eski olaylarda soru yok: bos iki nokta ust uste yerine karar turu yazilir.
  'acildi':     (d) => ({ metin: 'KARAR BEKLIYOR' + (d.soru ? ': ' + kirp(d.soru, 90) : (d.tur ? ' (' + d.tur + ')' : '')), ton: 'soru', ses: 'karar' }),
  'cevaplandi': (d) => ({ metin: 'cevaplandi: ' + kirp(d.cevap, 70), ton: 'iyi' }),
  'kabul':      () => ({ metin: 'insan kabul etti, is bitmis sayildi', ton: 'iyi' }),
  'iptal':      () => ({ metin: 'karar iptal edildi', ton: 'bilgi' }),
  'profil-degisti':      (d) => ({ metin: 'profil ' + d.onceki + ' → ' + d.yeni + ' (' + (d.neden ?? '') + ')', ton: 'bilgi' }),
  'kapsam-genisletildi': (d) => ({ metin: 'kapsam genisletildi: ' + kirp((d.eklenen ?? []).join(', '), 60), ton: 'bilgi' }),
};

/**
 * Olayin cumlesi. null = gosterilmez (gurultu: atlanan tetikler, taban kayitlari, bildirim
 * kayitlari, maliyet tiklari - maliyet sutunun sayacina gider, satira degil).
 */
export function olayCumlesi(o) {
  const d = o?.data ?? {};
  switch (o?.kind) {
    case OLAY.IS: {
      const f = IS_CUMLE[d.asama];
      return f ? { ses: null, ...f(d) } : null;
    }
    case OLAY.KARAR: {
      const f = KARAR_CUMLE[d.asama];
      return f ? { ses: null, ...f(d) } : null;
    }
    case OLAY.ARAC:
      // Oturum indexer'inin yazdigi arac olaylarinda ozet yok; onlar sadece ad tasir.
      return { metin: (d.altAjan ? '↳ ' : '') + (d.ozet || String(d.arac ?? 'arac')), ton: 'arac', ses: null };
    case OLAY.SOZ:
      return d.metin ? { metin: kirp(d.metin, 220), ton: 'soz', ses: null } : null;
    case OLAY.HATA:
      return { metin: 'hata' + (d.nerede ? ' (' + d.nerede + ')' : '') + ': ' + kirp(d.mesaj, 120), ton: 'kotu', ses: 'hata' };
    case OLAY.IZIN:
      return d.reddedildi ? { metin: 'izin reddedildi: ' + (d.arac ?? '?'), ton: 'kotu', ses: null } : null;
    default:
      return null;
  }
}

/** Olayi sayfaya gidecek kucuk pakete cevirir (cumle yoksa null). */
export function anlat(o) {
  const c = olayCumlesi(o);
  if (!c) return null;
  return { seq: o.seq, at: o.at, tur: o.kind, oturum: o.sessionId, proje: o.project,
    kosu: o.data?.kosuId ?? null, asama: o.data?.asama ?? null, ...c };
}
