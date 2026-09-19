// Butun kalici veri yollari tek yerde. Baska hicbir dosya homedir()/join ile
// kendi yolunu kurmasin - Kule -> Suru gecisi gibi tasimalar burada halledilir.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync, renameSync } from 'node:fs';

export const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
export const VERI_DIZINI  = join(homedir(), '.claude', 'suru');
const ESKI_DIZIN          = join(homedir(), '.claude', 'kule');

// Ajanin ICINDE calistigi klasorler ~/.claude ALTINDA OLAMAZ: Claude Code kendi
// yapilandirma klasorunu koruyor ve oradaki dosya duzenlemelerini reddediyor.
// Olculdu (ayni gorev, ayni profil, ayni model): ~/.claude altinda izin reddi ve
// dosya yazilmadi; temp altinda sorunsuz yazildi. Bu yuzden worktree koku isletim
// sisteminin uygulama-veri klasorunde durur, VERI_DIZINI'nin altinda degil.
export const AJAN_DIZINI = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'suru')
  : join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'suru');

export const DB_PATH      = join(VERI_DIZINI, 'suru.db');
export const JETON_YOLU   = join(VERI_DIZINI, 'token');
export const OLAY_DOSYASI = join(VERI_DIZINI, 'events.jsonl');
export const KADRO_YOLU   = join(VERI_DIZINI, 'kadro.json');

let hazirlandi = false;

/** Veri dizinini olusturur ve gerekiyorsa eski Kule verisini bir kereye mahsus tasir. */
export function veriDizini() {
  if (!hazirlandi) {
    hazirlandi = true;
    eskidenTasi();
  }
  mkdirSync(VERI_DIZINI, { recursive: true });
  return VERI_DIZINI;
}

function eskidenTasi() {
  // Onemli olan token / events.jsonl / kadro.json: bunlar ozgun veri.
  // Veritabani turetilmis onbellek - tasinamazsa indexer bastan uretir, dert degil.
  try {
    if (!existsSync(ESKI_DIZIN) || existsSync(VERI_DIZINI)) return;
    renameSync(ESKI_DIZIN, VERI_DIZINI);
  } catch { return; }

  const eskiDb = join(VERI_DIZINI, 'kule.db');
  // WAL ve SHM db ile birlikte tasinmali; yalniz db tasinirsa WAL'daki
  // yazilmamis sayfalar kaybolur.
  for (const ek of ['', '-wal', '-shm']) {
    try {
      if (existsSync(eskiDb + ek) && !existsSync(DB_PATH + ek)) renameSync(eskiDb + ek, DB_PATH + ek);
    } catch { /* olmadiysa indexer yeniden uretir */ }
  }
}
