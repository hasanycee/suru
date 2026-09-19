// Dogrulama: "bitti" ajanin IDDIASIDIR, kanit degil.
//
// Bir ajan isini bitirdigini soyleyebilir; testler kirikken de soyleyebilir.
// Bu yuzden is tanimina bir dogrulama komutu baglaniyor (npm test, tsc --noEmit,
// pytest...). Kosu bitince o calisir; gecmezse is BITMIS SAYILMAZ, karara duser.
//
// Bilincli tercih: dogrulamayi ajana yaptirmiyoruz. Kendi isini kendi
// onaylamasi, onaylamamasiyla ayni sey - bagimsiz bir surec calistiriyoruz.

import { spawn } from 'node:child_process';

const NL = String.fromCharCode(10);

/** Cikti tamponu: dogrulama ciktisi bazen cok uzun, sadece isimize yarayan kismi tutariz. */
const EN_FAZLA_CIKTI = 8 * 1024;

/**
 * Dogrulama komutunu calistirir.
 * Doner: { gecti, kod, cikti, sureMs, zamanAsimi }
 *
 * Komut kabuktan gecer: is tanimindaki dogrulama "npm test" gibi bir kabuk
 * ifadesi. Bu bilincli - komutu sen yaziyorsun, ajan degil.
 */
export function calistir(komut, cwd, { zamanAsimiMs = 10 * 60_000, spawnFn = spawn, env = process.env } = {}) {
  return new Promise((coz) => {
    if (!komut || !String(komut).trim()) {
      return coz({ gecti: true, kod: 0, cikti: '', sureMs: 0, zamanAsimi: false, calisti: false });
    }
    const t0 = Date.now();
    let cikti = '';
    let bitti = false;
    let zamanAsimi = false;

    const ekle = (p) => {
      cikti += p;
      // Bastaki degil SONDAKI cikti onemli: hata mesaji genelde sonda.
      if (cikti.length > EN_FAZLA_CIKTI) cikti = cikti.slice(-EN_FAZLA_CIKTI);
    };

    let cocuk;
    try {
      cocuk = spawnFn(String(komut), {
        cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return coz({ gecti: false, kod: -1, cikti: 'dogrulama baslatilamadi: ' + e.message,
        sureMs: 0, zamanAsimi: false, calisti: true });
    }

    const sure = setTimeout(() => {
      if (bitti) return;
      zamanAsimi = true;
      try { cocuk.kill(); } catch { /* zaten olmus */ }
    }, zamanAsimiMs);

    cocuk.stdout?.setEncoding('utf8');
    cocuk.stdout?.on('data', ekle);
    cocuk.stderr?.setEncoding('utf8');
    cocuk.stderr?.on('data', ekle);

    const kapat = (kod, hata) => {
      if (bitti) return;
      bitti = true;
      clearTimeout(sure);
      if (hata) ekle(NL + hata);
      coz({
        gecti: !zamanAsimi && kod === 0 && !hata,
        kod: kod ?? -1,
        cikti: cikti.trim(),
        sureMs: Date.now() - t0,
        zamanAsimi,
        calisti: true,
      });
    };

    cocuk.on('error', (e) => kapat(-1, 'dogrulama hatasi: ' + e.message));
    cocuk.on('close', (kod) => kapat(kod));
  });
}

/** Insan okunur ozet: karar kartinda ve raporda gorunur. */
export function ozetle(sonuc, komut) {
  if (!sonuc?.calisti) return null;
  if (sonuc.zamanAsimi) return 'Dogrulama zaman asimina ugradi: ' + komut;
  if (sonuc.gecti) return 'Dogrulama gecti: ' + komut;
  return 'Dogrulama BASARISIZ (cikis kodu ' + sonuc.kod + '): ' + komut;
}
