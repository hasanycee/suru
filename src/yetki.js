// Yetki profilleri: bir ajanin ne yapabilecegi ve sana ne zaman gelecegi.
//
// Bu dosya Suru'nun en onemli sozlesmesi. Ozerklik sonradan eklenen bir ozellik
// degil; her kosu bir profille dogar ve profil o kosunun sinirlarini belirler.
//
// Sinirlar iki yerde birden uygulanir:
//   1. --tools       : arac kumesini daraltir (yok olan arac cagrilamaz)
//   2. --settings    : permissions.allow/deny kurallari (Bash desenleri dahil)
// Ikisi de Claude Code'un kendi mekanizmasi - Suru kendi basina bir kum havuzu
// kurmuyor, kurdugunu iddia etmiyor.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { VERI_DIZINI, veriDizini } from './paths.js';

const NL = String.fromCharCode(10);

// Ayar dosyasinin gercekten yuklendigini dogrulayan KANARYA. -p modunda gecersiz
// ayar dosyasi SESSIZCE yok sayilir ve butun yasaklar kalkar (yetki-canli ile
// olculdu: tek bozuk alan -> Write yasagi gitti, dosya yazildi). Butun bir araci
// yasaklamak onu init kaydindaki arac listesinden cikarir; kanarya listede
// gorunuyorsa ayarlar yuklenmemistir ve kosu hemen kesilir (kosucu.js).
export const KANARYA = 'RemoteTrigger';

// Disari veri tasiyan ya da kosudan sonra da yasayan is kuran araclar. Sürü ajan
// kosusunun bunlarla isi yok: Artifact yayinlar, PushNotification/SendMessage/
// RemoteTrigger disari konusur, Cron/ScheduleWakeup sonradan calisacak is kurar.
const DISA_ACILAN = ['Artifact', 'PushNotification', 'SendMessage', 'RemoteTrigger',
  'CronCreate', 'CronDelete', 'ScheduleWakeup', 'DesignSync'];

// Her profilde gecerli olan yasaklar. Sirlar ve geri donusu olmayan islemler.
//
// DIKKAT - bu listeler GUVENLIK DEGIL, KAZA ONLEYICIDIR. Bash(...) desenleri komut
// metnini eslestirir; `git -C . commit`, `sh -c "..."` gibi yazimlarla atlatilabilir.
// Prompt injection (ajanin okudugu dosyaya gizlenmis talimat) karsisinda guvenilir
// sinir yalnizca aracin HIC OLMAMASIDIR: bkz. kisitli profiller (--restricted).
// Hangi desenin gercekte tuttugu `npm run yetki-canli` ile olculur.
const ORTAK_YASAK = [
  'Read(./.env)',
  'Read(./.env.*)',
  'Read(./**/.env)',
  'Write(./.env)',
  'Write(./.env.*)',
  'Bash(rm -rf *)',
  'Bash(git push --force *)',
  'Bash(git push -f *)',
  ...DISA_ACILAN,
];

// Salt-okuma araclari: her profil bunlari kullanabilir.
const OKUMA_ARACLARI = ['Read', 'Grep', 'Glob', 'TodoWrite'];
const YAZMA_ARACLARI = ['Write', 'Edit', 'NotebookEdit'];

export const PROFILLER = {
  gozlemci: {
    ad: 'gozlemci',
    aciklama: 'Sadece okur ve rapor yazar. Hicbir sey degistirmez.',
    // dontAsk: izin gerektiren isi sormaz, reddeder. Gozetimsiz kosu icin dogru
    // olan bu - soramayacagi bir seyi beklemesin.
    mod: 'dontAsk',
    araclar: [...OKUMA_ARACLARI, 'WebSearch', 'WebFetch'],
    yasak: [...YAZMA_ARACLARI, 'Bash', 'Task'],
    // --restricted: kod calistiran araclar hic yuklenmez, dosya araclari calisma
    // dizinlerine hapsolur, proje/kullanici ayar dosyalari yok sayilir. Desen degil
    // arac yoklugu - prompt injection'a karsi gercek sinir.
    kisitli: true,
    // Hicbir sey degistirmedigi icin sana getirecek karari da yok.
    eskalasyon: 'yok',
  },

  serbest: {
    ad: 'serbest',
    aciklama: 'Kendi klasorunde yazar, test kosar, commit atar. Sadece hatada sorar.',
    mod: 'acceptEdits',
    araclar: null, // tum yerlesik araclar
    yasak: [
      // Commit serbest ama uzaga itmek degil: geri alinamayan sinir burada.
      'Bash(git push *)',
      'Bash(git push)',
      'Bash(npm publish *)',
      'Bash(gh pr merge *)',
      'Bash(git reset --hard *)',
    ],
    eskalasyon: 'hata',
  },

  denetimli: {
    ad: 'denetimli',
    aciklama: 'Yazar ama itmez, silmez, gecmisi degistirmez. Sinira dayaninca sorar.',
    mod: 'acceptEdits',
    araclar: null,
    yasak: [
      'Bash(git push *)',
      'Bash(git push)',
      'Bash(git commit *)',   // commit bile karara tabi
      'Bash(git reset *)',
      'Bash(git rebase *)',
      'Bash(git checkout *)',
      'Bash(npm publish *)',
      'Bash(gh pr merge *)',
      'Bash(gh release *)',
      'Bash(docker *)',
      'Bash(rm *)',
    ],
    eskalasyon: 'sinir',
  },

  danisan: {
    ad: 'danisan',
    aciklama: 'Once plan uretir, uygulamaz. Her mimari karar sana gelir.',
    // plan modu tam bu ise yarar: arastirir, plan yazar, degistirmez.
    mod: 'plan',
    araclar: [...OKUMA_ARACLARI, 'WebSearch', 'WebFetch'],
    yasak: [...YAZMA_ARACLARI],
    kisitli: true,
    eskalasyon: 'her-karar',
  },
};

export const PROFIL_ADLARI = Object.keys(PROFILLER);

export function profilAl(ad) {
  const p = PROFILLER[ad];
  if (!p) {
    throw new Error('bilinmeyen yetki profili: ' + ad + ' (gecerli: ' + PROFIL_ADLARI.join(', ') + ')');
  }
  return p;
}

/**
 * Profilin Claude Code ayar nesnesi. --settings ile satir ici JSON olarak gecer.
 * defaultMode'u burada DEGIL --permission-mode ile veriyoruz: proje/yerel ayar
 * dosyalarindan bazi modlar gecerli olmuyor, bayrak her zaman gecerli.
 */
/**
 * init kaydindaki arac listesinden ayarlarin yuklenip yuklenmedigi.
 * true/false; olculemiyorsa null (arac listesi --tools ile zaten daraltilmis
 * ya da liste gelmemis - o profillerde kanarya zaten listede olamaz).
 */
/**
 * Ajan kosulari MCP'siz baslar. Olculdu (2026-09-17): bayraksiz kosuda kullanicinin MCP
 * sunuculari ajana da yukleniyor - 93 aracin 60'i mcp__ (unity-mcp: connected + claude.ai
 * Claude Docs). Yani ajan acik duran Unity Editor'u surebilir ya da claude.ai baglayicisiyla
 * disari yazabilirdi; --restricted bile claude.ai baglayicisini kapatmiyor (11 aracin 8'i mcp__).
 * --strict-mcp-config ile 0. Bir ise bilerek MCP vermek gerekirse --mcp-config ile ACIKCA verilir.
 */
export const MCP_KAPALI = ['--strict-mcp-config'];

/** init.tools'ta mcp__ araci var mi: bayrak bir gun islemezse kosucu kosuyu keser (kanarya mantigi). */
export function mcpSizdiMi(araclar, izinliOnekler = []) {
  if (!Array.isArray(araclar)) return [];
  return araclar.filter((t) => String(t).startsWith('mcp__') && !izinliOnekler.some((o) => String(t).startsWith(o)));
}

export function ayarYuklendiMi(profil, araclar) {
  const p = typeof profil === 'string' ? profilAl(profil) : profil;
  if (p.araclar || !Array.isArray(araclar)) return null;
  return !araclar.includes(KANARYA);
}

export function ayarNesnesi(profil, { ekYasak = [], ekIzin = [] } = {}) {
  const permissions = {
    // ekYasak: proje gizlilik kurallari (gizlilik.js). Profil yasaklarinin ustune eklenir.
    deny: [...ORTAK_YASAK, ...profil.yasak, ...ekYasak],
  };
  // ekIzin: is basina acilan MCP araclari (mcp.js). Headless kosuda izin listesinde olmayan MCP
  // araci sorulamaz ve reddedilir; bu liste "okur" modunda neyin acildigini belirler.
  if (ekIzin.length) permissions.allow = [...ekIzin];
  return { permissions };
}

/**
 * Profil ayarlarini diske yazar ve yolunu dondurur.
 *
 * Neden satir ici JSON degil dosya: Windows'ta komut kabuktan gecmek zorunda
 * kalirsa argumanlar KACIRILMADAN birlestiriliyor ve JSON'daki tirnaklar
 * parcalaniyor ("Invalid JSON provided to --settings"). Dosya yolunda tirnak
 * yok. Ayrica Windows'un ~8191 karakterlik komut satiri sinirina da yaklasmiyoruz.
 * Yan fayda: profilin ne yasakladigini gozunle gorebiliyorsun.
 */
export function ayarDosyasiYaz(profil, { ekYasak = [], ekIzin = [] } = {}) {
  const p = typeof profil === 'string' ? profilAl(profil) : profil;
  veriDizini();
  const dizin = join(VERI_DIZINI, 'profiller');
  mkdirSync(dizin, { recursive: true });
  // Proje kurali varsa dosya adi icerikten turer: ayni anda kosan farkli projeler
  // birbirinin ayar dosyasini ezmez.
  const ekler = [...ekYasak, ...ekIzin.map((i) => 'allow:' + i)];
  const ek = ekler.length ? '-' + createHash('sha1').update(ekler.join(NL)).digest('hex').slice(0, 10) : '';
  const yol = join(dizin, p.ad + ek + '.json');
  const icerik = JSON.stringify(ayarNesnesi(p, { ekYasak, ekIzin }), null, 2) + NL;
  // Degismediyse dokunma: her kosuda gereksiz disk yazmasi olmasin.
  let mevcut = null;
  try { mevcut = readFileSync(yol, 'utf8'); } catch { /* ilk kez */ }
  if (mevcut !== icerik) writeFileSync(yol, icerik, 'utf8');
  return yol;
}

/**
 * Bir kosu icin claude komut satiri argumanlari.
 *
 * sessionId onceden atanir - bu kasitli: kosu ile Claude Code'un kendi kaydi
 * (~/.claude/projects/**.jsonl) arasindaki bagi kurar. Boylece otomasyon
 * duzlemi ile gozlem duzlemi ayni oturumdan konusur.
 */
/**
 * Istem nasil verilir. stdinIstem: metin komut satirinda degil, stdin'den stream-json olarak gider.
 * Olculdu (CLI 2.1.267): bu modda kosu SURERKEN stdin'e yazilan ikinci kullanici mesaji ayni kosunun
 * icinde islenir (tek result) - "ara talimat" bunun ustune kurulu. Surec stdin kapanana kadar yasar;
 * kosucu result'i gorunce stdin'i kapatir.
 */
export function istemArgumani(metin, stdinIstem) {
  return stdinIstem ? ['-p', '--input-format', 'stream-json'] : ['-p', String(metin)];
}

/** stdin'e yazilacak tek satirlik kullanici mesaji (stream-json girdi bicimi). */
export function stdinMesaji(metin) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: String(metin) }] } })
    + String.fromCharCode(10);
}

export function cliArgumanlari({
  gorev,
  profil,
  sessionId,
  model = null,
  butceUsd = null,
  ekDizinler = [],
  ekSistemIstemi = null,
  ayarYolu = null,
  yedekModel = null,
  stdinIstem = false,
  mcpArgs = null,
}) {
  if (!gorev || !String(gorev).trim()) throw new Error('gorev bos olamaz');
  if (!sessionId) throw new Error('sessionId zorunlu: kosu kaydiyla eslesmesi gerekiyor');
  const p = typeof profil === 'string' ? profilAl(profil) : profil;

  const args = [
    ...istemArgumani(gorev, stdinIstem),
    '--output-format', 'stream-json',
    '--verbose',
    '--session-id', sessionId,
    '--permission-mode', p.mod,
    '--settings', ayarYolu ?? JSON.stringify(ayarNesnesi(p)),
  ];

  // MCP: varsayilan kapali; is basina secilmisse mcp.js'in argumanlari (--mcp-config + strict).
  args.push(...(mcpArgs ?? MCP_KAPALI));
  // null = tum yerlesik araclar. Daraltma varsa acikca ver.
  if (p.kisitli) args.push('--restricted');
  if (p.araclar) args.push('--tools', p.araclar.join(','));
  if (model) args.push('--model', model);
  // Kota beyni (Faz 3) bunu kullanacak; simdiden gecirilebiliyor.
  if (butceUsd != null) args.push('--max-budget-usd', String(butceUsd));
  // Birincil model asiri yukluyse CLI yedege gecer (sadece -p modunda gecerli).
  if (yedekModel) args.push('--fallback-model', yedekModel);
  for (const d of ekDizinler) args.push('--add-dir', d);
  if (ekSistemIstemi) args.push('--append-system-prompt', ekSistemIstemi);

  return args;
}

/**
 * Karar cevaplandiktan sonra ajani KALDIGI YERDEN surduren argumanlar.
 *
 * --resume ile ayni oturum devam eder: ajan neyi neden yaptigini hatirlar,
 * gorevi bastan anlatmak gerekmez. Bu yuzden --session-id verilmez; oturum
 * kimligini --resume zaten belirliyor.
 */
export function devamArgumanlari({ cevap, profil, sessionId, model = null, butceUsd = null, ayarYolu = null,
  yedekModel = null, stdinIstem = false, mcpArgs = null }) {
  if (!cevap || !String(cevap).trim()) throw new Error('cevap bos olamaz');
  if (!sessionId) throw new Error('devam icin sessionId zorunlu');
  const p = typeof profil === 'string' ? profilAl(profil) : profil;

  const args = [
    ...istemArgumani(cevap, stdinIstem),
    '--resume', sessionId,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', p.mod,
    '--settings', ayarYolu ?? JSON.stringify(ayarNesnesi(p)),
  ];
  args.push(...(mcpArgs ?? MCP_KAPALI));
  if (p.kisitli) args.push('--restricted');
  if (p.araclar) args.push('--tools', p.araclar.join(','));
  if (model) args.push('--model', model);
  if (butceUsd != null) args.push('--max-budget-usd', String(butceUsd));
  // Birincil model asiri yukluyse CLI yedege gecer (sadece -p modunda gecerli).
  if (yedekModel) args.push('--fallback-model', yedekModel);
  return args;
}

/** Insan okunur ozet: panelde profil secerken gosterilecek. */
export function profilOzeti() {
  return PROFIL_ADLARI.map((ad) => {
    const p = PROFILLER[ad];
    return {
      ad,
      aciklama: p.aciklama,
      mod: p.mod,
      aracSayisi: p.araclar ? p.araclar.length : null,
      yasakSayisi: ORTAK_YASAK.length + p.yasak.length,
      eskalasyon: p.eskalasyon,
      kisitli: !!p.kisitli,
    };
  });
}

export { ORTAK_YASAK };
export const YARDIM = PROFIL_ADLARI
  .map((a) => '  ' + a.padEnd(11) + PROFILLER[a].aciklama)
  .join(NL);
