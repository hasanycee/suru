import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Sema gocleri. Dizinin uzunlugu semanin surumudur (PRAGMA user_version).
 * KURAL: aradan adim silme, var olan adimi degistirme. Sadece sona ekle.
 * Aksi halde eski veritabanlari sessizce yanlis semaya dusr.
 */
const GOCLER = [
  // 1 - ilk sema (oturum ozetleri). IF NOT EXISTS: surum takibi oncesi
  // olusmus veritabanlari da sorunsuz bu adimi gecsin.
  (db) => db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id   TEXT PRIMARY KEY,
      project      TEXT NOT NULL,
      project_path TEXT,
      title        TEXT,
      git_branch   TEXT,
      version      TEXT,
      started_at   INTEGER,
      ended_at     INTEGER,
      human_turns  INTEGER,
      assistant_msgs INTEGER,
      sidechain_msgs INTEGER,
      tool_calls   INTEGER,
      error_results INTEGER,
      active_ms    INTEGER,
      usd          REAL,
      unknown_cost INTEGER,
      first_prompt TEXT,
      file         TEXT,
      mtime_ms     INTEGER,
      size         INTEGER
    );
    CREATE TABLE IF NOT EXISTS session_models (
      session_id TEXT, model TEXT, msgs INTEGER,
      in_tok INTEGER, out_tok INTEGER, cache_w INTEGER, cache_r INTEGER, usd REAL,
      PRIMARY KEY (session_id, model)
    );
    CREATE TABLE IF NOT EXISTS session_tools (
      session_id TEXT, tool TEXT, calls INTEGER,
      PRIMARY KEY (session_id, tool)
    );
    CREATE INDEX IF NOT EXISTS ix_sessions_project ON sessions(project);
    CREATE INDEX IF NOT EXISTS ix_sessions_ended   ON sessions(ended_at);
  `),

  // 2 - olay akisi. Ekle-only: sistemin gecmisi burada. Anlik durum tablosu
  // degil, akis tutuyoruz cunku fotograftan film yapilamiyor (canli harita,
  // karne ve replay hepsi bu tabloyu okuyacak).
  (db) => db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      at         INTEGER NOT NULL,
      kind       TEXT    NOT NULL,
      session_id TEXT,
      agent      TEXT,
      project    TEXT,
      data       TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_events_at      ON events(at);
    CREATE INDEX IF NOT EXISTS ix_events_session ON events(session_id, seq);
    CREATE INDEX IF NOT EXISTS ix_events_kind    ON events(kind, seq);
  `),

  // 3 - kucuk kalici deger deposu: tuketici imlecleri (bildirim nerede kaldi),
  // sayaclar, tek satirlik durumlar. Her biri icin ayri tablo acmaya degmez.
  (db) => db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      anahtar TEXT PRIMARY KEY,
      deger   TEXT,
      at      INTEGER
    );
  `),

  // 4 - otomasyon: is tanimlari ve kosu gecmisi (Faz 2).
  // session_id onceden atanir: kosuyu Claude Code'un kendi kaydina baglar,
  // boylece otomasyon duzlemi ile gozlem duzlemi ayni oturumdan konusur.
  (db) => db.exec(`
    CREATE TABLE IF NOT EXISTS isler (
      id           TEXT PRIMARY KEY,
      ad           TEXT NOT NULL,
      gorev        TEXT NOT NULL,
      cwd          TEXT NOT NULL,
      profil       TEXT NOT NULL,
      model        TEXT,
      butce_usd    REAL,
      oncelik      INTEGER NOT NULL DEFAULT 5,
      etkin        INTEGER NOT NULL DEFAULT 1,
      olusturuldu  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kosular (
      id             TEXT PRIMARY KEY,
      is_id          TEXT NOT NULL,
      session_id     TEXT,
      durum          TEXT NOT NULL,
      basladi        INTEGER,
      bitti          INTEGER,
      cikis_kodu     INTEGER,
      usd            REAL DEFAULT 0,
      tur_sayisi     INTEGER DEFAULT 0,
      arac_sayisi    INTEGER DEFAULT 0,
      red_sayisi     INTEGER DEFAULT 0,
      terminal_neden TEXT,
      sonuc          TEXT,
      hata           TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_kosular_is    ON kosular(is_id, basladi);
    CREATE INDEX IF NOT EXISTS ix_kosular_durum ON kosular(durum);
    CREATE INDEX IF NOT EXISTS ix_kosular_oturum ON kosular(session_id);
  `),

  // 5 - eskalasyon: ajanin kendi cozemedigi ve sana getirdigi kararlar.
  // Cevaplandiginda ajan ayni oturumdan devam eder (--resume), bu yuzden
  // session_id burada da tutuluyor.
  (db) => db.exec(`
    CREATE TABLE IF NOT EXISTS kararlar (
      id           TEXT PRIMARY KEY,
      kosu_id      TEXT NOT NULL UNIQUE,
      is_id        TEXT NOT NULL,
      session_id   TEXT,
      tur          TEXT NOT NULL,
      soru         TEXT,
      ayrinti      TEXT,
      olusturuldu  INTEGER NOT NULL,
      durum        TEXT NOT NULL,
      cevap        TEXT,
      cevaplandi   INTEGER,
      devam_kosu_id TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_kararlar_durum ON kararlar(durum, olusturuldu);
  `),

  // 6 - devam kosulari. Bir karar cevaplandiginda acilan kosu SIRADAN bir kosu
  // degil: ayni oturumu --resume ile surduruyor. Bu bilgi kayitta durmazsa
  // kuyruk onu bastan baslatmaya calisir ve CLI "session already in use" der.
  (db) => db.exec(`ALTER TABLE kosular ADD COLUMN devam_cevabi TEXT`),

  // 7 - dogrulama. "Bitti" ajanin IDDIASIDIR, kanit degil. Is tanimina bir
  // dogrulama komutu bagliyoruz (npm test, tsc --noEmit gibi); kosu bitince o
  // calisir ve gecmezse is bitmis sayilmaz.
  (db) => db.exec(`
    ALTER TABLE isler ADD COLUMN dogrulama TEXT;
    ALTER TABLE kosular ADD COLUMN dogrulama_kod INTEGER;
    ALTER TABLE kosular ADD COLUMN dogrulama_cikti TEXT;
  `),

  // 8 - yedek model. Birincil model asiri yuklu ya da erisilemezse CLI'in
  // kendi --fallback-model mekanizmasi devreye girer; kosu durmaz.
  (db) => db.exec(`ALTER TABLE isler ADD COLUMN yedek_model TEXT`),

  // 9 - suru hafizasi. Ajan degil Suru yazar; her kaydin turu (olgu/yorum/yarim)
  // ve kaynagi (arac/ajan/insan) var. Bkz. hafiza.js.
  (db) => db.exec(`
    CREATE TABLE IF NOT EXISTS hafiza (
      id          TEXT PRIMARY KEY,
      proje       TEXT NOT NULL,
      tur         TEXT NOT NULL,
      icerik      TEXT NOT NULL,
      kaynak      TEXT NOT NULL,
      dogrulandi  INTEGER NOT NULL DEFAULT 0,
      uyari       TEXT,
      is_id       TEXT,
      kosu_id     TEXT,
      olusturuldu INTEGER NOT NULL,
      kapandi     INTEGER
    );
    CREATE INDEX IF NOT EXISTS ix_hafiza_proje ON hafiza(proje, tur, olusturuldu);
    CREATE INDEX IF NOT EXISTS ix_hafiza_kosu  ON hafiza(kosu_id);
  `),

  // 10 - bayatlama. Olgu, kaydedildigi andaki projenin parmak iziyle saklanir;
  // proje degisince "eski olabilir" diye isaretlenir. Bkz. parmakizi.js.
  (db) => db.exec(`ALTER TABLE hafiza ADD COLUMN parmak_izi TEXT`),

  // 11 - golge checkpoint. Her kosunun once/sonra goruntusu (ayri git dizininde
  // commit kimligi), kac dosya degisti, geri alindiysa ne zaman. Bkz. golge.js.
  (db) => db.exec(`
    ALTER TABLE kosular ADD COLUMN golge_once TEXT;
    ALTER TABLE kosular ADD COLUMN golge_sonra TEXT;
    ALTER TABLE kosular ADD COLUMN degisen_dosya INTEGER;
    ALTER TABLE kosular ADD COLUMN geri_alindi INTEGER;
  `),

  // 12 - yapici/denetci dongusu. Is: en fazla tur, denetci modeli, dongu butcesi.
  // Kosu: dongu kimligi, tur, rol, yeni yapiciya giden bulgular (ek_talimat),
  // denetcinin inceledigi kosu (hedef_kosu) ve cozulmus hukum (denetim). Bkz. dongu.js.
  (db) => db.exec(`
    ALTER TABLE isler ADD COLUMN dongu_tur INTEGER;
    ALTER TABLE isler ADD COLUMN denetci_model TEXT;
    ALTER TABLE isler ADD COLUMN dongu_butce_usd REAL;
    ALTER TABLE kosular ADD COLUMN dongu_id TEXT;
    ALTER TABLE kosular ADD COLUMN tur INTEGER;
    ALTER TABLE kosular ADD COLUMN rol TEXT;
    ALTER TABLE kosular ADD COLUMN ek_talimat TEXT;
    ALTER TABLE kosular ADD COLUMN hedef_kosu TEXT;
    ALTER TABLE kosular ADD COLUMN denetim TEXT;
    CREATE INDEX IF NOT EXISTS ix_kosular_dongu ON kosular(dongu_id);
  `),

  // 13 - veri akisi defteri. Kosu basina modele giden (istem, baglam, dosya, arama,
  // komut) ve makineden cikan (web, bildirim) veri; gizli desene takilan satirda
  // ihlal = desen. Bkz. veriakisi.js, gizlilik.js.
  (db) => db.exec(`
    CREATE TABLE IF NOT EXISTS veri_akisi (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      zaman   INTEGER NOT NULL,
      kosu_id TEXT,
      proje   TEXT,
      tur     TEXT NOT NULL,
      hedef   TEXT,
      ayrinti TEXT,
      boyut   INTEGER,
      ihlal   TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_veri_akisi_proje ON veri_akisi(proje, zaman);
    CREATE INDEX IF NOT EXISTS ix_veri_akisi_kosu ON veri_akisi(kosu_id);
  `),

  // 14 - is kapsami: yapicinin degistirebilecegi yollar (JSON dizi, gitignore benzeri
  // desenler). Denetim dongusu kapsam disi degisikligi deterministik bulgu yapar.
  (db) => db.exec(`ALTER TABLE isler ADD COLUMN kapsam TEXT`),

  // 15 - zamanlama: isin cron ifadesi (yerel saat) ve son tetik ani. Kacirilan tetikler
  // birikmesin diye son_tetik tetik aninda simdiye cekilir. Bkz. zamanlama.js.
  (db) => db.exec(`
    ALTER TABLE isler ADD COLUMN zamanlama TEXT;
    ALTER TABLE isler ADD COLUMN son_tetik INTEGER;
  `),

  // 16 - kosunun GERCEKTEN kostugu model. isler.model isin SIMDIKI ayari; is
  // sonradan baska modele alinirsa gecmis kosular yanlis modele yazilir ve
  // "ayni is hangi modelde daha iyi" sorusu olculemez. Bu sutun akistan
  // gozlenen modeli tutar (yedek modele dusulduyse yedegi yazar).
  (db) => db.exec(`ALTER TABLE kosular ADD COLUMN model TEXT`),

  // 17 - git tetikleyici: isin izledigi git referansi ve en son gorulen commit.
  // Referans 'HEAD' ise yerel commit, 'origin/main' gibi uzak-izleme refi ise
  // PUSH tetikler - push yerel refs/remotes/... refini de gunceller, bu yuzden
  // tetik aga hic cikmadan calisir (bkz. gittetik.js).
  (db) => db.exec(`
    ALTER TABLE isler ADD COLUMN git_tetik TEXT;
    ALTER TABLE isler ADD COLUMN son_commit TEXT;
  `),

  // 18 - worktree izolasyonu: is bazinda 'worktree' ise ajan kendi git
  // worktree'sinde kosar, sonuc kendi dalinda teslim edilir. Bkz. worktree.js.
  (db) => db.exec(`
    ALTER TABLE isler ADD COLUMN izolasyon TEXT;
    ALTER TABLE kosular ADD COLUMN worktree_dal TEXT;
  `),

  // 19 - hafiza disiplini: 'konu' ayni seyi soyleyen kayitlarin anahtari. Ayni proje+tur+konu
  // icin yeni kayit eskisini EZER (bkz. hafiza.js kayitEkle). Olculdu: ayni isin dogrulama
  // sonucu her kosuda yeniden yaziliyor, brifin 8 olgu yuvasini tekrarlar dolduruyordu.
  // Eski kayitlar metinden geriye dogru anahtarlanir; kopyalari ilk budama temizler.
  (db) => db.exec(`
    ALTER TABLE hafiza ADD COLUMN konu TEXT;
    UPDATE hafiza SET konu = 'dogrulama:' || is_id
      WHERE tur = 'olgu' AND kaynak = 'arac' AND is_id IS NOT NULL AND icerik LIKE '%" dogrulamasi (%';
    UPDATE hafiza SET konu = 'hata:' || is_id
      WHERE tur = 'olgu' AND kaynak = 'arac' AND is_id IS NOT NULL AND icerik LIKE '%" hatayla bitti:%';
    CREATE INDEX IF NOT EXISTS ix_hafiza_konu ON hafiza(proje, tur, konu);
  `),

  // 20 - is basina MCP secimi. mcp: JSON dizi (sunucu adlari, ornek ["unity-mcp"]); bos = hic MCP yok
  // (--strict-mcp-config, mevcut davranis). mcp_mod: 'okur' (yalniz okuyan araclar izinli) | 'tam'.
  // Bkz. mcp.js. Kullanici karari: varsayilan salt-okur, tam yetki is basina elle.
  (db) => db.exec(`
    ALTER TABLE isler ADD COLUMN mcp TEXT;
    ALTER TABLE isler ADD COLUMN mcp_mod TEXT;
  `),
];

export const SEMA_SURUMU = GOCLER.length;

function surumOku(db) {
  const r = db.prepare('PRAGMA user_version').get();
  return Number(Object.values(r ?? {})[0] ?? 0);
}

/** Eksik gocleri sirayla uygular. Her adim kendi islemi icinde: yarim kalmaz. */
export function goc(db) {
  const bas = surumOku(db);
  for (let i = bas; i < GOCLER.length; i++) {
    db.exec('BEGIN');
    try {
      GOCLER[i](db);
      db.exec('PRAGMA user_version = ' + (i + 1));
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* zaten kapandi */ }
      throw new Error('sema gocu ' + (i + 1) + ' basarisiz: ' + e.message);
    }
  }
  return GOCLER.length;
}

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  // Yazan tek surec olmayabilir (sunucu + indexer ayni anda). Kilit beklemesi
  // hemen hata vermek yerine kisa sure denesin.
  db.exec('PRAGMA busy_timeout = 4000');
  goc(db);
  return db;
}

/** Dosya degismediyse yeniden parse etmeye gerek yok. */
export function isFresh(db, sessionId, mtimeMs, size) {
  const row = db.prepare('SELECT mtime_ms, size FROM sessions WHERE session_id = ?').get(sessionId);
  return !!row && row.mtime_ms === Math.floor(mtimeMs) && row.size === size;
}

export function saveSession(db, s, mtimeMs, size) {
  db.prepare(`
    INSERT INTO sessions (session_id, project, project_path, title, git_branch, version,
      started_at, ended_at, human_turns, assistant_msgs, sidechain_msgs, tool_calls,
      error_results, active_ms, usd, unknown_cost, first_prompt, file, mtime_ms, size)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET
      project=excluded.project, project_path=excluded.project_path, title=excluded.title,
      git_branch=excluded.git_branch, version=excluded.version, started_at=excluded.started_at,
      ended_at=excluded.ended_at, human_turns=excluded.human_turns,
      assistant_msgs=excluded.assistant_msgs, sidechain_msgs=excluded.sidechain_msgs,
      tool_calls=excluded.tool_calls, error_results=excluded.error_results,
      active_ms=excluded.active_ms, usd=excluded.usd,
      unknown_cost=excluded.unknown_cost, first_prompt=excluded.first_prompt,
      file=excluded.file, mtime_ms=excluded.mtime_ms, size=excluded.size
  `).run(s.sessionId, s.project, s.projectPath, s.title, s.gitBranch, s.version,
    s.startedAt, s.endedAt, s.humanTurns, s.assistantMsgs, s.sidechainMsgs, s.toolCalls,
    s.errorResults, s.activeMs, s.usd, s.unknownCost ? 1 : 0, s.firstPrompt, s.file,
    Math.floor(mtimeMs), size);

  db.prepare('DELETE FROM session_models WHERE session_id = ?').run(s.sessionId);
  const im = db.prepare('INSERT INTO session_models VALUES (?,?,?,?,?,?,?,?)');
  for (const [model, e] of s.models) im.run(s.sessionId, model, e.msgs, e.in, e.out, e.cacheW, e.cacheR, e.usd);

  db.prepare('DELETE FROM session_tools WHERE session_id = ?').run(s.sessionId);
  const it = db.prepare('INSERT INTO session_tools VALUES (?,?,?)');
  for (const [tool, n] of s.tools) it.run(s.sessionId, tool, n);
}


// --- Kucuk deger deposu ---

export function kvOku(db, anahtar, varsayilan = null) {
  const r = db.prepare('SELECT deger FROM kv WHERE anahtar = ?').get(anahtar);
  if (!r) return varsayilan;
  try { return JSON.parse(r.deger); } catch { return varsayilan; }
}

export function kvYaz(db, anahtar, deger) {
  db.prepare(`INSERT INTO kv (anahtar, deger, at) VALUES (?,?,?)
              ON CONFLICT(anahtar) DO UPDATE SET deger=excluded.deger, at=excluded.at`)
    .run(anahtar, JSON.stringify(deger), Date.now());
  return deger;
}
