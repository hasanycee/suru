// Kosucu: bir isi headless Claude Code surecinde calistirir ve olan her seyi
// olay akisina yazar.
//
// Neden PTY degil: PTY'nin ciktisi ekran boyasidir (ANSI), makine okuyamaz.
// --output-format stream-json satir satir YAPILANDIRILMIS olay verir; hangi arac
// cagrildi, kac para gitti, hangi izin reddedildi - hepsi okunabilir. Otomasyon
// ancak bunun uzerine kurulur.
//
// Akistan gelen kayit sekilleri (kurulu CLI 2.1.220 ile dogrulandi):
//   {"type":"system","subtype":"init", session_id, cwd, tools, model, permissionMode}
//   {"type":"assistant","message":{content:[...], usage:{...}}, parent_tool_use_id}
//   {"type":"user","message":{content:[{type:"tool_result",...}]}}
//   {"type":"result", subtype, is_error, total_cost_usd, num_turns,
//                     permission_denials:[], terminal_reason, result}

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { OLAY, yaz as olayYaz, yazToplu } from './events.js';
import { kosuGuncelle, KOSU_DURUMU } from './isler.js';
import { cliArgumanlari, devamArgumanlari, profilAl, ayarDosyasiYaz, ayarYuklendiMi, mcpSizdiMi, stdinMesaji } from './yetki.js';
import { calistir as dogrulamaCalistir, ozetle as dogrulamaOzet } from './dogrulama.js';
import { hafizaIstemi, kosudanOgren, okumaDizini } from './hafiza.js';
import { agaciOldur, ayrikGrup } from './surec.js';
import { anlikGoruntu, degisenler } from './golge.js';
import { izinKurallari, desenNormal } from './gizlilik.js';
import { gorevKapsamCelismesi } from './dongu.js';
import { kosuDefteri, defterYaz } from './veriakisi.js';
import { kanitZinciri } from './kanit.js';
import { olc as baglamOlc } from './baglam.js';
import { costOf } from './pricing.js';
import { worktreeAc, worktreeKapat, dalOzeti } from './worktree.js';
import { aracOzeti } from './anlati.js';
import { mcpPlani, mcpTalimati } from './mcp.js';

const NL = String.fromCharCode(10);

/**
 * Calistirilacak gercek programi bulur.
 *
 * Windows'ta `claude` bir .cmd sarmalayicisi; onu spawn etmek kabuk gerektirir,
 * kabuk da argumanlari KACIRMADAN birlestirir - gorev metnindeki tirnak veya
 * ozel karakter komutu bozar. Sarmalayicinin cagirdigi claude.exe'yi dogrudan
 * bulup kabugu tamamen devre disi birakiyoruz.
 * SURU_CLAUDE ile elle de gosterilebilir.
 */
export function komutCoz(komut = 'claude') {
  if (process.env.SURU_CLAUDE) return { komut: process.env.SURU_CLAUDE, shell: false };
  if (komut !== 'claude' || process.platform !== 'win32') return { komut, shell: false };

  const alt = join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  for (const kok of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
    if (!kok) continue;
    const aday = join(kok, 'npm', alt);
    if (existsSync(aday)) return { komut: aday, shell: false };
  }
  // Bulunamadi: kabuga dusuyoruz. Ayarlar dosyadan gectigi icin JSON bozulmaz,
  // ama gorev metnindeki ozel karakter riski surer.
  return { komut, shell: true };
}

/** NDJSON akisini satir satir cozer; yarim satiri tamponda bekletir. */
export class SatirCozucu {
  constructor() { this.tampon = ''; }
  /** Gelen parcayi ekler, tamamlanan kayitlari dondurur. */
  ekle(parca) {
    this.tampon += parca;
    const satirlar = this.tampon.split(NL);
    this.tampon = satirlar.pop() ?? '';   // son parca yarim olabilir
    const out = [];
    for (const l of satirlar) {
      const t = l.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* JSON olmayan gurultu (uyari vs) */ }
    }
    return out;
  }
  /** Akis kapandiginda tamponda kalmis tam kayit varsa onu da al. */
  bitir() {
    const t = this.tampon.trim();
    this.tampon = '';
    if (!t) return [];
    try { return [JSON.parse(t)]; } catch { return []; }
  }
}

/**
 * Bir akis kaydini Suru olaylarina cevirir ve sayaclari guncellenir.
 * Saf fonksiyon: db yok, surec yok - bu yuzden test edilebilir.
 */
export function kayitEsle(kayit, baglam) {
  const { kosuId, isId, sessionId, project } = baglam;
  const temel = { sessionId, project, at: Date.now() };
  const olaylar = [];
  const sayac = {};

  if (kayit.type === 'system' && kayit.subtype === 'init') {
    olaylar.push({ ...temel, kind: OLAY.IS, data: {
      asama: 'basladi', kosuId, isId,
      model: kayit.model, mod: kayit.permissionMode,
      aracSayisi: Array.isArray(kayit.tools) ? kayit.tools.length : null,
    } });
    return { olaylar, sayac };
  }

  if (kayit.type === 'assistant') {
    const m = kayit.message || {};
    const apiHatasi = !!(kayit.is_api_error_message || kayit.error);
    for (const b of m.content || []) {
      if (b?.type === 'tool_use') {
        sayac.aracSayisi = (sayac.aracSayisi || 0) + 1;
        olaylar.push({ ...temel, kind: OLAY.ARAC, data: {
          kosuId, arac: b.name,
          // "Ne yapiyor": hangi dosya / hangi komut. Komuta merkezinin canli sutunu bunu basar.
          ozet: aracOzeti(b.name, b.input),
          // Alt-ajan cagrisi mi: parent_tool_use_id doluysa evet.
          altAjan: !!kayit.parent_tool_use_id,
        } });
      } else if (b?.type === 'text' && !apiHatasi && !kayit.parent_tool_use_id && String(b.text ?? '').trim()) {
        // Ajanin is sirasinda soyledigi, kirpilmis. Yerel olay akisinda kalir; bildirim
        // kanallarina GITMEZ (bildirim.js yalniz durum/karar olaylarini isler).
        olaylar.push({ ...temel, kind: OLAY.SOZ, data: { kosuId, metin: String(b.text).trim().slice(0, 400) } });
      }
    }
    // API hatasi akista assistant mesaji kiliginda geliyor; sessizce gecmesin.
    if (kayit.is_api_error_message || kayit.error) {
      olaylar.push({ ...temel, kind: OLAY.HATA, data: {
        kosuId, nerede: 'api', kod: kayit.error ?? null,
        mesaj: (m.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join(' ').slice(0, 300),
      } });
    }
    return { olaylar, sayac };
  }

  if (kayit.type === 'user') {
    for (const b of kayit.message?.content || []) {
      if (b?.type === 'tool_result' && b.is_error) {
        sayac.hataliArac = (sayac.hataliArac || 0) + 1;
      }
    }
    return { olaylar, sayac };
  }

  if (kayit.type === 'result') {
    const redler = Array.isArray(kayit.permission_denials) ? kayit.permission_denials : [];
    sayac.usd = kayit.total_cost_usd ?? 0;
    sayac.turSayisi = kayit.num_turns ?? 0;
    sayac.redSayisi = redler.length;
    sayac.terminalNeden = kayit.terminal_neden ?? kayit.terminal_reason ?? null;
    sayac.hataliMi = !!kayit.is_error;
    sayac.sonuc = typeof kayit.result === 'string' ? kayit.result : null;

    // Reddedilen izinler eskalasyonun ham maddesi: ajan bir sinira dayandi.
    for (const r of redler) {
      olaylar.push({ ...temel, kind: OLAY.IZIN, data: {
        kosuId, arac: r.tool_name ?? r.toolName ?? null, reddedildi: true,
      } });
    }
    olaylar.push({ ...temel, kind: OLAY.IS, data: {
      asama: 'bitti', kosuId, isId,
      hataliMi: sayac.hataliMi, usd: sayac.usd, turSayisi: sayac.turSayisi,
      redSayisi: redler.length, terminalNeden: sayac.terminalNeden,
    } });
    return { olaylar, sayac };
  }

  return { olaylar, sayac };
}

/**
 * Kosu sonucundan durum cikarir. Eskalasyon karari profile bagli:
 *   yok        - hicbir sey sorulmaz
 *   hata       - sadece basarisizlikta
 *   sinir      - izin reddi de karar dogurur
 *   her-karar  - kosu basarili da olsa insan onayina duser (plan modu)
 */
export function sonucDurumu({ hataliMi, redSayisi = 0, eskalasyon }) {
  if (eskalasyon === 'her-karar') return KOSU_DURUMU.KARAR_BEKLIYOR;
  if (hataliMi) {
    return eskalasyon === 'yok' ? KOSU_DURUMU.HATA : KOSU_DURUMU.KARAR_BEKLIYOR;
  }
  if (redSayisi > 0 && (eskalasyon === 'sinir')) return KOSU_DURUMU.KARAR_BEKLIYOR;
  return KOSU_DURUMU.BITTI;
}

/**
 * Isi calistirir. Cozulen sonuc: { durum, usd, turSayisi, ... }
 *
 * spawnFn ve komut disaridan verilebiliyor: testler gercek claude'u
 * cagirmadan (ve para harcamadan) tum yolu dogruluyor.
 */
/**
 * Yapiciya kapsam talimati. Onlem; denetimdeki kapsam kontrolu yine calisir.
 * Saha: kapsam sadece denetciye soyleniyordu, yapici bilmeden kapsam disina tasiyordu.
 */
export function kapsamTalimati(is) {
  if (!Array.isArray(is?.kapsam) || !is.kapsam.length) return null;
  const s = [
    'Bu isin kapsami (degistirebilecegin ya da olusturabilecegin yollar): ' + is.kapsam.join(', ') + '.',
    'Bu yollar disinda dosya degistirme, olusturma ya da silme (yardimci betik ve rapor dosyasi dahil).',
    'Gorev kapsam disi bir degisiklik gerektiriyorsa o degisikligi YAPMA; raporunda hangi dosyanin neden gerektigini acikca yaz.',
    'Kapsam disi degisiklikler otomatik denetimde bulgu olur.',
  ];
  const celisen = gorevKapsamCelismesi(is.gorev, is.kapsam);
  if (celisen.length) {
    s.push('Gorev metni kapsam disindaki su dosyalari aniyor: ' + celisen.join(', ') + '. Bu dosyalara YAZMA IZNI KAPALI'
      + ' (okuyabilirsin). Degisiklik gerekiyorsa yapmaya calisma; raporunda tam olarak hangi degisikligin gerektigini yaz.');
  }
  return s.join(NL);
}

/**
 * Gorev kapsam disi dosya aniyorsa o dosyaya yazma izni kurali: Edit/Write deny. Okuma acik.
 * Saha (kampanya 5): "kapsam disini degistirme" istem talimati yapiciya ULASTI ama gorev
 * metni dosyayi acikca istedigi icin uygulanmadi. Izin kurali istem degil, Claude Code uygular.
 * Sadece gorevde ADI GECEN kapsam disi dosyalar: izin kurallari beyaz liste olamaz (deny, allow'u ezer).
 */
export function kapsamYazmaYasagi(is) {
  const celisen = gorevKapsamCelismesi(is?.gorev, is?.kapsam);
  const kurallar = [];
  for (const y of celisen) {
    const g = desenNormal(y);
    if (g) kurallar.push('Edit(./' + g + ')', 'Write(./' + g + ')');
  }
  return { celisen, kurallar };
}

/**
 * Akista gorulen modeller arasindan kosuyu en cok temsil edeni: en fazla cikti
 * token ureten. Yedek modele dusen kosuda iki model gorunur; agirlik dogru
 * olani secer. Hic usage gelmediyse null (bilinmiyor - varsayim yazmayiz).
 */
export function enCokKullanilanModel(kullanim) {
  const agirlik = new Map();
  for (const { model, usage } of kullanim?.values?.() ?? []) {
    if (!model) continue;
    agirlik.set(model, (agirlik.get(model) ?? 0) + (usage?.output_tokens || 0) + 1);
  }
  let en = null, enAgirlik = -1;
  for (const [m, a] of agirlik) if (a > enAgirlik) { en = m; enAgirlik = a; }
  return en;
}

/** Raporun sonunda tek satirlik oneri: Suru bunu is olarak ONERIR, otomatik acmaz (bkz. oneri.js). */
export const ONERI_TALIMATI = 'Raporunun EN SONUNA, gercekten degerli bir sonraki adim varsa tek satir yaz: "Sonraki adim: <ne yapilmali>". Yoksa bu satiri yazma.';

/** Ajana "baglam doluyor" talimati: ozet yazip dursun; Suru ozetle yeni oturum acar. */
export const BAGLAM_TALIMATI = 'BAGLAMIN DOLMAK UZERE. Simdi dur: yeni dosya okuma, yeni degisiklik yapma. Su ana kadar yaptiklarini, '
  + 'degistirdigin dosyalari ve KALAN isleri kisa ve somut bir ozet olarak yaz (en fazla 30 satir), sonra bitir. '
  + 'Bu ozetle yeni bir oturum acilacak ve kalan isler oradan surdurulecek.';

export function kosuBaslat(db, { is, kosu, komut = 'claude', spawnFn = spawn, env = process.env, zamanAsimiMs = 60 * 60_000, devamCevabi = null,
  kontrol = null, golgeAyari = null, hafizaAyari = { etkin: true, enFazlaKayit: 12 },
  gizlilikOku = null, projelerDizini = undefined, worktreeAyari = null, canliTalimat = false, mcpAyari = null,
  baglamAyari = null, oneriAyari = null }) {
  // Proje gizliligi: gizli yollar Read/Edit/Write yasagi olur, web yasagi araclari
  // kaldirir. Kurallar proje DISINDA durur: ajan kendi yasagini degistiremez.
  const gizlilik = gizlilikOku ? gizlilikOku(is.cwd) : null;
  const tabanProfil = profilAl(is.profil);
  const profil = gizlilik?.webYasak && tabanProfil.araclar
    ? { ...tabanProfil, araclar: tabanProfil.araclar.filter((a) => a !== 'WebFetch' && a !== 'WebSearch') }
    : tabanProfil;
  const kapsamYasagi = kapsamYazmaYasagi(is);
  const ekYasak = [
    ...(gizlilik ? izinKurallari(gizlilik.desenler, { webYasak: gizlilik.webYasak }) : []),
    ...kapsamYasagi.kurallar,
  ];
  // MCP: is basina secilen sunucular (mcp.js). Secim yoksa plan = strict (hicbir sunucu).
  // Tanim bulunamazsa kosu BASLAMAZ: sessizce MCP'siz kosmak kullanicinin secimini yutmak olurdu.
  let mcp;
  try { mcp = mcpPlani(is, mcpAyari, { cwd: is.cwd }); }
  catch (e) {
    const mesaj = 'MCP kurulamadi: ' + (e?.message ?? e);
    kosuGuncelle(db, kosu.id, { durum: KOSU_DURUMU.HATA, bitti: Date.now(), hata: mesaj });
    olayYaz(db, { kind: OLAY.HATA, sessionId: kosu.sessionId, project: is.ad, data: { kosuId: kosu.id, nerede: 'mcp', mesaj } });
    return Promise.resolve({ usd: 0, turSayisi: 0, aracSayisi: 0, redSayisi: 0, durum: KOSU_DURUMU.HATA, cikisKodu: -1, hata: mesaj });
  }
  const ayarYolu = ayarDosyasiYaz(profil, { ekYasak: [...ekYasak, ...mcp.yasak], ekIzin: mcp.izin });
  // devamCevabi doluysa bu bir eskalasyon cevabi: gorevi bastan anlatmak yerine
  // ayni oturumu surduruyoruz (--resume), ajan baglami koruyor.
  const args = devamCevabi
    ? devamArgumanlari({ cevap: devamCevabi, profil, sessionId: kosu.sessionId,
        model: is.model, butceUsd: is.butceUsd, ayarYolu, yedekModel: is.yedekModel, stdinIstem: canliTalimat, mcpArgs: mcp.args })
    : cliArgumanlari({ gorev: is.gorev, profil, sessionId: kosu.sessionId,
        model: is.model, butceUsd: is.butceUsd, ayarYolu, yedekModel: is.yedekModel, stdinIstem: canliTalimat, mcpArgs: mcp.args,
        // Hafiza sadece YENI kosuya verilir; devam kosusu baglami zaten tasiyor.
        // Kademeli okuma: istemde kisa DIZIN, ayrinti dosyalari --add-dir ile.
        // Denetim dongusunde onceki denetcinin bulgulari (ekTalimat) hafiza dizininin ardina eklenir.
        ekSistemIstemi: [
          hafizaAyari?.etkin ? hafizaIstemi(db, is, { kok: hafizaAyari.kok ?? null }) : null,
          kosu.ekTalimat ?? null,
          kapsamTalimati(is),
          mcpTalimati(mcp),
          oneriAyari?.etkin && !String(is.ad).startsWith('_') ? ONERI_TALIMATI : null,
        ].filter(Boolean).join(NL + NL) || null,
        ekDizinler: hafizaAyari?.etkin
          ? [okumaDizini(is, { kok: hafizaAyari.kok ?? null })].filter(Boolean) : [] });

  // Modele giden istem boyutu (defter icin): gorev/cevap + ek sistem istemi.
  // Istem metni stdin'den de gidebilir (canliTalimat); boyut argumandan degil metnin kendisinden olculur.
  const ilkIstem = String(devamCevabi ?? is.gorev);
  const ekIstemYeri = args.indexOf('--append-system-prompt');
  const istemBoyutu = ilkIstem.length + (ekIstemYeri >= 0 ? String(args[ekIstemYeri + 1] ?? '').length : 0);

  const baglam = { kosuId: kosu.id, isId: is.id, sessionId: kosu.sessionId, project: is.ad };
  const toplam = { usd: 0, turSayisi: 0, aracSayisi: 0, redSayisi: 0, hataliArac: 0,
    terminalNeden: null, hataliMi: false, sonuc: null };

  kosuGuncelle(db, kosu.id, { durum: KOSU_DURUMU.CALISIYOR });
  olayYaz(db, { kind: OLAY.IS, sessionId: kosu.sessionId, project: is.ad,
    data: { asama: 'kuyruktan-alindi', kosuId: kosu.id, isId: is.id, profil: is.profil } });

  // Worktree izolasyonu: ajan senin calisma kopyanda degil kendi klasorunde
  // kosar (bkz. worktree.js). Acilamazsa kosu BASLAMAZ - sessizce gercek
  // klasorde kosmak izolasyon sozunu bozardi.
  let worktree = null;
  let calismaDizini = is.cwd;
  if (is.izolasyon === 'worktree') {
    try {
      worktree = worktreeAc(is, kosu.id, worktreeAyari?.kok ? { kok: worktreeAyari.kok } : undefined);
      calismaDizini = worktree.yol;
      olayYaz(db, { kind: OLAY.IS, sessionId: kosu.sessionId, project: is.ad,
        data: { asama: 'worktree-acildi', kosuId: kosu.id, dal: worktree.dal, yol: worktree.yol } });
      if (worktree.kirliydi) {
        // Sessiz kalmasin: ajan senin kaydedilmemis degisikliklerini GORMEYECEK.
        olayYaz(db, { kind: OLAY.HATA, sessionId: kosu.sessionId, project: is.ad,
          data: { kosuId: kosu.id, nerede: 'worktree',
            mesaj: 'projede kaydedilmemis degisiklikler var; izole kosu bunlari GORMEZ (worktree HEAD uzerinden acilir)' } });
      }
    } catch (e) {
      const mesaj = 'worktree acilamadi: ' + (e?.message ?? e);
      kosuGuncelle(db, kosu.id, { durum: KOSU_DURUMU.HATA, bitti: Date.now(), hata: mesaj });
      olayYaz(db, { kind: OLAY.HATA, sessionId: kosu.sessionId, project: is.ad,
        data: { kosuId: kosu.id, nerede: 'worktree', mesaj } });
      return { ...toplam, durum: KOSU_DURUMU.HATA, cikisKodu: -1, hata: mesaj };
    }
  }

  // Golge checkpoint: ajan dokunmadan once projenin hali. Alinamazsa kosu yine
  // kosar (bu kosu icin geri alma olmaz) ama akisa hata yazilir - sessiz degil.
  const golgeKok = golgeAyari?.kok ?? undefined;
  const golgeHatasi = (e) => olayYaz(db, { kind: OLAY.HATA, sessionId: kosu.sessionId, project: is.ad,
    data: { kosuId: kosu.id, nerede: 'golge', mesaj: String(e?.message ?? e).slice(0, 300) } });
  let golgeOnce = null;
  if (golgeAyari?.etkin) {
    try { golgeOnce = anlikGoruntu(calismaDizini, kosu.id + '-once', { kok: golgeKok, ekHaric: gizlilik?.yollar }); }
    catch (e) { golgeHatasi(e); }
  }

  const { komut: program, shell } = komutCoz(komut);
  // Claude'un kendi otomatik hafizasi ajan kosularinda varsayilan olarak KAPALI.
  // Acik kalirsa iki zarar: (1) ajan dogrulanmamis "ogrendiklerini" MEMORY.md'ye
  // kendi yazar ve bu, her sonraki kosuya otomatik yuklenir - "hafizaya ajan
  // degil Suru yazar" kuralini tamamen atlatir. (2) Hafiza klasoru git deposundan
  // turetildigi icin kendi deposu olmayan bir proje (ornek: LiveDub) UST deponun
  // hafizasini yukler - kullanicinin kendi notlari ajanin baglamina karisir.
  const cocukEnv = hafizaAyari?.claudeOtomatikHafiza
    ? env
    : { ...env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };

  const cocuk = spawnFn(program, args, {
    cwd: calismaDizini,
    env: cocukEnv,
    // canliTalimat: istem ve ara talimatlar stdin'den stream-json olarak gider (bkz. yetki.istemArgumani).
    // Degilse stdin kapali: gozetimsiz kosu girdi beklemesin.
    stdio: [canliTalimat ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    shell,
    // POSIX'te kendi surec grubu: durdurunca bash/pytest torunlari da gider.
    detached: ayrikGrup(),
    windowsHide: true,
  });

  // Durdurma kolu: kuyruk (dolayisiyla sunucu) bunu cagirir. Sadece claude.exe
  // degil butun agac olur - yoksa ajanin baslattigi test sureci sahipsiz kalir.
  let durdurmaNedeni = null;
  if (kontrol) {
    kontrol.durdur = (neden = 'kullanici') => {
      if (durdurmaNedeni) return false;
      durdurmaNedeni = String(neden);
      olayYaz(db, { kind: OLAY.IS, sessionId: kosu.sessionId, project: is.ad,
        data: { asama: 'durduruluyor', kosuId: kosu.id, neden: durdurmaNedeni } });
      agaciOldur(cocuk);
      return true;
    };
  }

  // Ara talimat: kosu SURERKEN ajana yeni kullanici mesaji. Ayni kosunun icinde islenir
  // (olculdu: tek result). result geldikten sonra kol kapanir; o noktadan sonra gelen talimat
  // devam kosusu olarak acilmali (kuyruk.talimat bunu yapar).
  let stdinAcik = false;
  const stdinKapat = () => {
    if (!stdinAcik) return;
    stdinAcik = false;
    if (kontrol) kontrol.talimat = null;
    try { cocuk.stdin.end(); } catch { /* zaten kapali */ }
  };
  if (canliTalimat && cocuk.stdin) {
    stdinAcik = true;
    // Surec erken olurse yazma EPIPE verir; kosu sonucu zaten close olayindan okunur.
    cocuk.stdin.on('error', () => { stdinAcik = false; });
    try { cocuk.stdin.write(stdinMesaji(ilkIstem)); } catch { stdinAcik = false; }
    if (kontrol) {
      kontrol.talimat = (metin) => {
        const m = String(metin ?? '').trim();
        if (!m) throw new Error('talimat bos olamaz');
        if (!stdinAcik) return false;
        cocuk.stdin.write(stdinMesaji(m));
        olayYaz(db, { kind: OLAY.IS, sessionId: kosu.sessionId, project: is.ad,
          data: { asama: 'talimat', kosuId: kosu.id, metin: m.slice(0, 400), canli: true } });
        return true;
      };
    }
  }

  const cozucu = new SatirCozucu();
  let stderr = '';
  let ayarYuklenmedi = false;
  let mcpSizdi = null;
  // Sonuc kaydi gelmeden biten kosu (durdurma, zaman asimi, cokme) maliyet bildirmez.
  // Sinavda durdurulan kosu $0 gorundu; kota ve karne harcamayi hic gormuyordu.
  // Tahmin: assistant mesajlarinin usage'i. Ayni mesaj akista birden cok kez
  // gelebilir; mesaj kimligine gore SON usage sayilir.
  const kullanim = new Map();
  let sonucGeldi = false;
  let sonucSayisi = 0;
  const baglamEsigi = Number(baglamAyari?.esikToken) > 0 ? Number(baglamAyari.esikToken) : 0;
  let baglamEsigiGecildi = false;

  const isle = (kayitlar) => {
    const yazilacak = [];
    for (const kayit of kayitlar) {
      // Kanarya: ayar dosyasi sessizce yok sayildiysa yasaklar devre disi. init
      // kaydi ilk arac cagrisindan once gelir; kosuyu orada keseriz.
      if (!ayarYuklenmedi && kayit.type === 'system' && kayit.subtype === 'init'
          && ayarYuklendiMi(profil, kayit.tools) === false) {
        ayarYuklenmedi = true;
        yazilacak.push({ kind: OLAY.HATA, sessionId: kosu.sessionId, project: is.ad, at: Date.now(),
          data: { kosuId: kosu.id, nerede: 'yetki',
            mesaj: 'ayar dosyasi yuklenmedi, yasaklar devre disi - kosu durduruldu' } });
        agaciOldur(cocuk);
      }
      // MCP kanaryasi: --strict-mcp-config'e ragmen SECILMEMIS bir sunucunun mcp__ araci gorunuyorsa
      // ajan kullanicinin MCP sunucularina (Unity Editor, claude.ai baglayicilari) ulasabilir - kos(a)maz.
      // Is basina secilen sunucunun araclari (mcp.onekler) beklenen sizinti degildir.
      if (!mcpSizdi && kayit.type === 'system' && kayit.subtype === 'init' && mcpSizdiMi(kayit.tools, mcp.onekler).length) {
        mcpSizdi = mcpSizdiMi(kayit.tools, mcp.onekler);
        yazilacak.push({ kind: OLAY.HATA, sessionId: kosu.sessionId, project: is.ad, at: Date.now(),
          data: { kosuId: kosu.id, nerede: 'yetki',
            mesaj: 'MCP araclari ajana sizdi (' + mcpSizdi.length + ': ' + mcpSizdi.slice(0, 3).join(', ') + '...) - kosu durduruldu' } });
        agaciOldur(cocuk);
      }
      if (kayit.type === 'result') sonucGeldi = true;
      if (kayit.type === 'assistant' && kayit.message?.usage) {
        const mid = kayit.message.id ?? ('#' + kullanim.size);
        // Canli token sayaci: mesaj ilk goruldugunde bir maliyet tiki. Ayni mesaj akista
        // blok basina tekrar gelir; tekrar sayilmaz. Kesin tutar kosu sonunda result'tan gelir,
        // bu sayac "yaklasik ve canli" - sutunda oyle etiketlenir.
        if (!kullanim.has(mid)) {
          const u = kayit.message.usage;
          const girdi = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          yazilacak.push({ kind: OLAY.MALIYET, sessionId: kosu.sessionId, project: is.ad, at: Date.now(),
            data: { kosuId: kosu.id, girdi, cikti: u.output_tokens || 0, usd: costOf(kayit.message.model, u).usd } });
          // Otomatik baglam yonetimi: bir mesajin girdisi esigi asinca ajana bir kez "ozet yaz ve dur" denir.
          // Yalniz canli talimat kanali acikken (stdin) mumkun; devam kosusunda ve ic islerde yapilmaz.
          if (!baglamEsigiGecildi && baglamEsigi > 0 && girdi >= baglamEsigi && stdinAcik && !devamCevabi && !String(is.ad).startsWith('_')) {
            baglamEsigiGecildi = true;
            try { cocuk.stdin.write(stdinMesaji(BAGLAM_TALIMATI)); } catch { /* stdin kapanmis olabilir */ }
            yazilacak.push({ kind: OLAY.IS, sessionId: kosu.sessionId, project: is.ad, at: Date.now(),
              data: { asama: 'baglam-esigi', kosuId: kosu.id, isId: is.id, girdi, esik: baglamEsigi } });
          }
        }
        kullanim.set(mid, { model: kayit.message.model, usage: kayit.message.usage });
      }
      const ikinciSonuc = kayit.type === 'result' && sonucSayisi > 0;
      if (kayit.type === 'result') {
        sonucSayisi++;
        // stream-json girdide surec stdin kapanana kadar yasar: is bitti, kapat.
        stdinKapat();
      }
      const { olaylar, sayac } = kayitEsle(kayit, baglam);
      yazilacak.push(...olaylar);
      for (const [k, v] of Object.entries(sayac)) {
        // Yaris: talimat tam result'tan once yazildiysa CLI onu yeni tur olarak isleyip IKINCI bir
        // result verebilir. Sonuc sayaclari surec-toplamidir; toplanirsa maliyet iki kez sayilir.
        if (ikinciSonuc && typeof v === 'number') toplam[k] = Math.max(typeof toplam[k] === 'number' ? toplam[k] : 0, v);
        else if (typeof v === 'number') toplam[k] = (typeof toplam[k] === 'number' ? toplam[k] : 0) + v;
        else toplam[k] = v;
      }
    }
    if (yazilacak.length) {
      try { yazToplu(db, yazilacak); } catch { /* akis yazilamadi, kosu devam etsin */ }
    }
  };

  cocuk.stdout.setEncoding('utf8');
  cocuk.stdout.on('data', (d) => isle(cozucu.ekle(d)));
  cocuk.stderr.setEncoding('utf8');
  cocuk.stderr.on('data', (d) => { stderr += d; if (stderr.length > 8192) stderr = stderr.slice(-8192); });

  return new Promise((cozumle) => {
    let bitti = false;
    const sure = setTimeout(() => {
      if (bitti) return;
      toplam.terminalNeden = 'zaman-asimi';
      agaciOldur(cocuk);
    }, zamanAsimiMs);

    const kapat = async (cikisKodu, hataMesaji) => {
      if (bitti) return;
      bitti = true;
      clearTimeout(sure);
      stdinKapat();
      isle(cozucu.bitir());
      if (!sonucGeldi && kullanim.size) {
        let tahmin = 0;
        for (const { model, usage } of kullanim.values()) tahmin += costOf(model, usage).usd;
        toplam.usd = tahmin;
        toplam.usdTahmini = true;
      }

      // Surec sifirdan farkli dondiyse veya result gelmediyse basarisiz sayilir.
      const hataliMi = toplam.hataliMi || cikisKodu !== 0 || !!hataMesaji;
      let durum = sonucDurumu({ hataliMi, redSayisi: toplam.redSayisi, eskalasyon: profil.eskalasyon });
      let hata = hataMesaji ?? (hataliMi ? (stderr.trim().slice(-500) || toplam.sonuc || 'kosu basarisiz') : null);

      // Insan durdurdu: bu ne hata ne karar. Durum BITTI olmadigi icin dogrulama da kosmaz.
      if (ayarYuklenmedi) {
        // Profilden bagimsiz HATA: bu bir guvenlik arizasi, "devam edeyim mi" karari degil.
        durum = KOSU_DURUMU.HATA;
        hata = 'GUVENLIK: yetki ayar dosyasi Claude Code tarafindan yuklenmedi (gecersiz sayilmis olabilir); '
          + 'yasaklar devre disi kalacagi icin kosu baslar baslamaz durduruldu.';
        toplam.terminalNeden = 'ayar-yuklenmedi';
      } else if (mcpSizdi) {
        durum = KOSU_DURUMU.HATA;
        hata = 'GUVENLIK: --strict-mcp-config verildigi halde ' + mcpSizdi.length + ' secilmemis MCP araci ajana yuklendi ('
          + mcpSizdi.slice(0, 5).join(', ') + '); kosu baslar baslamaz durduruldu.';
        toplam.terminalNeden = 'mcp-sizdi';
      } else if (durdurmaNedeni) {
        durum = KOSU_DURUMU.IPTAL;
        hata = 'durduruldu: ' + durdurmaNedeni;
        toplam.terminalNeden = 'durduruldu';
      }

      // "Bitti" ajanin iddiasi. Is tanimina bagli bir dogrulama komutu varsa
      // ve kosu basarili gorunuyorsa, iddiayi bagimsiz olarak sinariz.
      // Sonra goruntusu dogrulamadan ONCE: test komutunun biraktigi onbellekler
      // ajanin degisikligi sayilmasin.
      let golgeSonra = null, degisenSayisi = null;
      if (golgeOnce) {
        try {
          golgeSonra = anlikGoruntu(calismaDizini, kosu.id + '-sonra', { kok: golgeKok, ekHaric: gizlilik?.yollar });
          degisenSayisi = degisenler(calismaDizini, golgeOnce, golgeSonra, { kok: golgeKok }).length;
        } catch (e) { golgeHatasi(e); }
      }

      let dg = null;
      if (durum === KOSU_DURUMU.BITTI && is.dogrulama) {
        olayYaz(db, { kind: OLAY.IS, sessionId: kosu.sessionId, project: is.ad,
          data: { asama: 'dogrulaniyor', kosuId: kosu.id, komut: is.dogrulama } });
        dg = await dogrulamaCalistir(is.dogrulama, calismaDizini, { env });
        olayYaz(db, { kind: OLAY.IS, sessionId: kosu.sessionId, project: is.ad,
          data: { asama: 'dogrulandi', kosuId: kosu.id, gecti: dg.gecti,
            kod: dg.kod, sureMs: dg.sureMs, zamanAsimi: dg.zamanAsimi } });

        if (!dg.gecti) {
          // Dogrulama gecmediyse is BITMIS SAYILMAZ. Gozlemci profilinde soracak
          // kimse yok, o yuzden dogrudan hata.
          durum = profil.eskalasyon === 'yok' ? KOSU_DURUMU.HATA : KOSU_DURUMU.KARAR_BEKLIYOR;
          hata = dogrulamaOzet(dg, is.dogrulama) + (dg.cikti ? NL + NL + dg.cikti : '');
        }
      }

      // Kosunun GERCEKTEN kostugu model: akistan gozlenir, isin ayarindan
      // okunmaz. Yedek modele dusuldugu kosuda yedegi yazar; boylece "ayni is
      // hangi modelde daha iyi" sorusu sonradan olculebilir (bkz. karne.js).
      const gozlenenModel = enCokKullanilanModel(kullanim);

      kosuGuncelle(db, kosu.id, {
        durum, bitti: Date.now(), cikisKodu, model: gozlenenModel,
        usd: toplam.usd, turSayisi: toplam.turSayisi, aracSayisi: toplam.aracSayisi,
        redSayisi: toplam.redSayisi, terminalNeden: toplam.terminalNeden,
        sonuc: toplam.sonuc, hata,
        dogrulamaKod: dg ? dg.kod : null,
        // Gecse de saklanir: denetci gercek test sayisini buradan okur.
        dogrulamaCikti: dg ? dg.cikti.slice(-4000) : null,
        golgeOnce, golgeSonra, degisenDosya: degisenSayisi,
      });

      // Veri akisi defteri: bu kosuda modele ne gitti, disari ne cikti. Gizli yol yine
      // de modele gittiyse (uygulama katmani sizdirdiysa) ihlal olarak isaretlenir.
      let ihlaller = [];
      try {
        const zincir = kanitZinciri(kosu.sessionId, projelerDizini ? { projelerDizini } : {});
        let baglamDosyalari = [];
        if (!devamCevabi) {
          try { baglamDosyalari = baglamOlc(calismaDizini, { otomatikHafiza: !!hafizaAyari?.claudeOtomatikHafiza }).dosyalar; }
          catch { /* olculemedi */ }
        }
        const satirlar = kosuDefteri({ kosu, is, zincir, baglamDosyalari, istemBoyutu, gizlilik });
        defterYaz(db, satirlar);
        ihlaller = satirlar.filter((s) => s.ihlal);
        if (ihlaller.length) {
          olayYaz(db, { kind: OLAY.HATA, sessionId: kosu.sessionId, project: is.ad,
            data: { kosuId: kosu.id, nerede: 'gizlilik',
              mesaj: ihlaller.length + ' gizli yol modele gitti: ' + ihlaller.slice(0, 3).map((s) => s.ayrinti).join(', ') } });
        }
      } catch { /* defter yazilamadi, kosu sonucu gecerli */ }

      // Kosudan ogren: Suru yazar, ajan degil. Hafiza hatasi kosuyu dusurmesin.
      if (hafizaAyari?.etkin) {
        try { kosudanOgren(db, kosu.id, { kok: hafizaAyari.kok ?? null }); }
        catch { /* hafiza yazilamadi, kosu sonucu gecerli */ }
      }

      // Worktree'yi kapat: degisiklikler KENDI DALINA commit edilir, klasor
      // silinir. Senin dalina ve calisma kopyana dokunulmaz - birlestirme senin
      // kararin. Kapanis hatasi kosu sonucunu dusurmesin.
      let worktreeSonuc = null;
      if (worktree) {
        try {
          worktreeSonuc = worktreeKapat(is, worktree, { kosuId: kosu.id });
          kosuGuncelle(db, kosu.id, { worktreeDal: worktreeSonuc.dal });
          olayYaz(db, { kind: OLAY.IS, sessionId: kosu.sessionId, project: is.ad,
            data: { asama: 'worktree-kapandi', kosuId: kosu.id, dal: worktreeSonuc.dal,
              commit: worktreeSonuc.commit, degisen: worktreeSonuc.degisen } });
        } catch (e) {
          olayYaz(db, { kind: OLAY.HATA, sessionId: kosu.sessionId, project: is.ad,
            data: { kosuId: kosu.id, nerede: 'worktree', mesaj: 'kapatilamadi: ' + (e?.message ?? e) } });
        }
      }

      cozumle({ ...toplam, durum, cikisKodu, hata, dogrulama: dg, gizlilikIhlali: ihlaller.length,
        golge: golgeOnce ? { once: golgeOnce, sonra: golgeSonra, degisen: degisenSayisi } : null,
        worktree: worktreeSonuc, baglamEsigiGecildi });
    };

    // kapat artik async (dogrulama bekliyor); hatasini yutmayalim.
    const guvenliKapat = (kod, hata) => {
      kapat(kod, hata).catch((e) => {
        try {
          kosuGuncelle(db, kosu.id, { durum: KOSU_DURUMU.HATA, bitti: Date.now(),
            hata: 'kapanis hatasi: ' + (e?.message ?? e) });
        } catch { /* kayit da yazilamadi */ }
        cozumle({ ...toplam, durum: KOSU_DURUMU.HATA, cikisKodu: kod, hata: String(e?.message ?? e) });
      });
    };
    cocuk.on('error', (e) => guvenliKapat(-1, 'surec baslatilamadi: ' + e.message));
    cocuk.on('close', (kod) => guvenliKapat(kod ?? -1, null));
  });
}
