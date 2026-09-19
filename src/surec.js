// Surec agaci yonetimi: bir kosuyu durdurmak claude.exe'yi oldurmekle bitmez.
//
// Ajan Bash ile pytest, npm, sunucu... baslatir. Sadece ana sureci oldurursek bu
// torunlar sahipsiz kalir, dosya kilitler, port tutar, kota harcamaya devam eden
// alt-ajan bile olabilir. Bu yuzden her zaman AGAC oldurulur.
//
//   Windows : taskkill /T /F  (ebeveyn->cocuk iliskisini izler)
//   POSIX   : surec detached baslatilir, kendi grubunun lideri olur; kill(-pgid)
//             tum gruba gider. Once SIGTERM, beklemeden sonra SIGKILL.
//
// Bilinen sinir (Windows): ana surec ZATEN olmusse taskkill agaci izleyemez;
// oksuz kalmis torunlar bulunamaz. Durdurma ana surec yasarken yapildigi icin
// normal akista bu durum olusmaz.

import { spawn } from 'node:child_process';

/** Cocuk ayri surec grubu olarak mi baslatilmali? (Windows'ta gerek yok, zararli.) */
export function ayrikGrup(platform = process.platform) {
  return platform !== 'win32';
}

/**
 * Surecin tum agacini oldurur. Donus: Promise<boolean> (oldurme komutu calisti mi).
 * Zaten bitmis surece dokunmaz.
 */
export function agaciOldur(cocuk, { platform = process.platform, spawnFn = spawn, beklemeMs = 3000 } = {}) {
  if (!cocuk || cocuk.pid == null) return Promise.resolve(false);
  if (cocuk.exitCode != null || cocuk.signalCode != null) return Promise.resolve(false);

  if (platform === 'win32') {
    return new Promise((coz) => {
      const yedek = () => { try { cocuk.kill(); } catch { /* zaten olmus */ } };
      let t;
      try {
        t = spawnFn('taskkill', ['/pid', String(cocuk.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch { yedek(); return coz(false); }
      t.on('error', () => { yedek(); coz(false); });
      t.on('close', (kod) => coz(kod === 0));
    });
  }

  try { process.kill(-cocuk.pid, 'SIGTERM'); }
  catch { try { cocuk.kill('SIGTERM'); } catch { /* zaten olmus */ } }
  // SIGTERM'i yok sayan torun kalmasin.
  const zor = setTimeout(() => {
    try { process.kill(-cocuk.pid, 'SIGKILL'); } catch { /* grup bitmis */ }
  }, beklemeMs);
  zor.unref?.();
  return Promise.resolve(true);
}
