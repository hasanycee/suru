// Kullanici ayarlari: ~/.claude/suru/ayarlar.json
// Dosya yoksa varsayilanlarla olusturulur, eksik alanlar varsayilandan tamamlanir -
// boylece yeni surumde eklenen ayar eski dosyayi bozmaz.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { veriDizini, VERI_DIZINI } from './paths.js';

export const AYAR_YOLU = join(VERI_DIZINI, 'ayarlar.json');

export const VARSAYILAN = {
  // Kota: Anthropic'in gercek sayacini okuyamiyoruz, bu yuzden tavanlar SENIN
  // koydugun sinirlar. Rakamlar "API liste fiyati degerinde is" demek - fatura
  // degil, kota tuketiminin vekili (bkz. kota.js).
  kota: {
    etkin: true,
    // Bu sayilar yer tutucu. Gercek deger makineden makineye degisir -
    // 'npm run kota' gecmisinden olculmus tavan onerir.
    besSaatlikUsd: 600,  // 5 saatlik pencerede bu degeri asma
    haftalikUsd: 3000,   // haftalik pencerede bu degeri asma
    tabanSinir: 3,       // pencereler rahatken es zamanli ajan sayisi
    enAzSinir: 1,        // en dar durumda bile bu kadar ajan kossun
  },

  // Suru hafizasi: onceki kosulardan kalanlar sonraki kosuya brif olarak verilir.
  hafiza: {
    etkin: true,
    // Claude Code'un kendi otomatik hafizasi (MEMORY.md). Ajan kosularinda KAPALI:
    // ajanin kendi yazdigi dogrulanmamis notlar sonraki kosulara sizmasin.
    claudeOtomatikHafiza: false,
    // Otomatik damitma: projede kapanmamis ham rapor sayisi esigi gecince ucuz
    // bir salt-okur ajan onlari kisa bir proje ozetine cevirir.
    damitma: {
      etkin: true,
      esik: 5,
      model: 'haiku',
      butceUsd: 0.25,
    },
  },

  // Golge checkpoint: her kosudan once/sonra projenin goruntusu, kullanicinin
  // deposuna dokunmadan. Geri alma bunun uzerinde calisir.
  golge: {
    etkin: true,
    gun: 14,          // bundan eski goruntuler budanir
    enFazla: 400,     // proje basina en fazla goruntu (kosu basina 2)
  },

  // Worktree izolasyonu (is bazinda acilir; buradaki ayar ortak kok).
  // Worktree'ler kullanicinin deposunun DISINDA durur. Bkz. worktree.js.
  worktree: {
    kok: null,        // null = ~/.claude/suru/worktree
  },

  // Telegram komut kanali: token doluysa bot dinlemeye baslar (bkz. telegram.js).
  // Bildirimleri de Telegram'dan almak icin bildirim.kanal = 'telegram'.
  telegram: {
    token: null,
    api: 'https://api.telegram.org',
    // Is bitince tek satir mesaj (varsayilan kapali: gurultu). Denetci dongusunde her tur degil,
    // yalniz isin SON bitisi gider (bkz. bitti-bildirimi.js).
    bittiBildir: false,
    // /sil ve /durdur Telegram'dan gelince ikinci onay dugmesi ister (yanlis silme geri alinamaz).
    onayIste: true,
  },

  // Otomatik baglam yonetimi (bkz. kosucu.js 'baglam-esigi'). esikToken: bir mesajin girdi token'i bu
  // degeri asinca koşucu ajana "ozet yaz ve dur" der; kosu bitince Suru ozetle YENI oturum acar.
  // 0 = kapali. Olcum yapilmadan acilmaz: once arac/olcum/token-egrisi.mjs ile uzun kosularin egrisine bak.
  baglam: {
    esikToken: 0,
    devamEt: true,     // esik sonrasi ozetten yeni oturum acilsin mi
  },

  // Kosu sonunda ajanin "Sonraki adim:" onerisi is olarak ONERILIR (otomatik acilmaz), Telegram'da Ac/Gec.
  // Kota beynine bagli: pencere kisitliyken onerilmez.
  oneri: { etkin: true },

  // Is basina MCP sunucusu verme (bkz. mcp.js). Varsayilan: hicbir kosuya MCP yok.
  // okur: sunucu adina gore SALT-OKUR sayilan arac adlari. Headless kosuda izin listesinde
  // olmayan MCP araci zaten reddedilir (olculdu); bu liste "okur" modunda neyin acildigini soyler.
  mcp: {
    okur: {
      'unity-mcp': ['GetConsoleLogs', 'ReadConsole', 'GetProjectData', 'GetSceneHierarchy', 'GetGameObject',
        'GetComponent', 'SceneView_Capture', 'SceneView_CaptureScreenshot', 'Camera_Capture', 'GetSelection',
        'GetEditorState', 'GetActiveScene', 'GetScenes', 'GetAssets', 'FindAssets', 'ReadFile', 'GetLogs'],
      'UnityMCP': ['read_console', 'find_gameobjects', 'find_in_file', 'manage_editor', 'validate_script'],
    },
    // Hangi modda olursa olsun asla acilmayacak araclar (editor icinde keyfi kod calistiranlar).
    yasak: {
      'unity-mcp': ['Unity_RunCommand', 'RunCommand', 'ExecuteCode', 'ExecuteMenuItem'],
      'UnityMCP': ['execute_code', 'execute_menu_item', 'batch_execute'],
    },
  },

  bildirim: {
    // 'gunluk' varsayilan ve KASITLI: hicbir sey makineden cikmaz.
    // ntfy/webhook/telegram acikca secilmeden disariya veri gitmez.
    kanal: 'gunluk',

    ntfy:    { sunucu: 'https://ntfy.sh', konu: null },
    webhook: { url: null },

    // 'az': sadece durum + proje + ajan adi gider.
    // 'tam': ajanin son mesajindan bir parca da eklenir (disari kanalda dikkat).
    icerik: 'az',

    // Ayni oturum + ayni durum icin bu sure dolmadan ikinci bildirim gitmez.
    sogumaDk: 10,

    // Bu pencerede bundan cok bildirim birikirse tek ozet gonderilir.
    topluPencereSn: 60,
    topluEsigi: 3,

    // Yerel saate gore sessiz saatler. acilGecer: acil olanlar yine de gider.
    sessizSaatler: { etkin: true, baslangic: 1, bitis: 8, acilGecer: true },

    // Hangi duruma nasil davranilir: 'acil' | 'normal' | 'yok'
    durumlar: {
      'onay-bekliyor': 'acil',
      'limit-doldu':   'acil',
      'takildi':       'acil',
      'seni-bekliyor': 'normal',
      'calisiyor':     'yok',
      'bosta':         'yok',
    },
  },
};

/** Duz nesneleri derin birlestirir; dizi ve ilkel degerler ustteki kazanir. */
function birlestir(temel, ust) {
  if (ust === undefined || ust === null) return temel;
  if (Array.isArray(temel) || Array.isArray(ust)) return ust;
  if (typeof temel !== 'object' || typeof ust !== 'object') return ust;
  const c = { ...temel };
  for (const k of Object.keys(ust)) c[k] = birlestir(temel[k], ust[k]);
  return c;
}

export function ayarlariOku() {
  let ham;
  try { ham = readFileSync(AYAR_YOLU, 'utf8'); } catch { return yapilandirmayiKur(); }
  try { return birlestir(VARSAYILAN, JSON.parse(ham)); } catch {
    // Bozuk dosya yuzunden panel acilmasin diye varsayilana duser.
    return structuredClone(VARSAYILAN);
  }
}

export function ayarlariYaz(ayarlar) {
  veriDizini();
  writeFileSync(AYAR_YOLU, JSON.stringify(ayarlar, null, 2) + String.fromCharCode(10), 'utf8');
  return ayarlar;
}

/** Ilk calistirmada ayar dosyasini yazar ki kullanici neyi degistirebilecegini gorsun. */
export function yapilandirmayiKur() {
  const a = structuredClone(VARSAYILAN);
  try { ayarlariYaz(a); } catch { /* yazilamadiysa bellekteki varsayilanla devam */ }
  return a;
}
