// Olay akisi: sistemin gecmisi. Ekle-only, silme yok (sadece yaslanma kirpmasi).
//
// Neden akis, neden anlik durum degil: canli harita, ajan karnesi ve replay
// "ne oldu" sorusunu soruyor, "su an ne var" sorusunu degil. Bir tabloyu
// UPDATE ederek gecmisi tutamazsin - fotograftan film yapilamaz.
//
// Tuketiciler seq uzerinden ilerler: sinceSeq ile kaldigi yerden okur, boylece
// SSE/animasyon kacirmadan ve tekrar etmeden beslenir.

export const OLAY = {
  DURUM:   'durum',    // oturumun durumu degisti (calisiyor -> seni-bekliyor ...)
  ARAC:    'arac',     // arac cagrisi
  MALIYET: 'maliyet',  // token/para tuketimi
  HATA:    'hata',
  IZIN:    'izin',     // izin istemi (hook'tan)
  IS:      'is',       // is yasam dongusu   (Faz 2)
  KARAR:   'karar',    // eskalasyon: insana sorulan  (Faz 2)
  NOT:     'not',      // ajanin kendi agzindan gunluk (Faz 2)
  SOZ:     'soz',      // ajanin is sirasinda soyledigi (kirpilmis) - komuta merkezi canli sutunu
};

const EKLE = `INSERT INTO events (at, kind, session_id, agent, project, data)
              VALUES (?,?,?,?,?,?)`;

/** Tek olay yazar, atanan seq'i dondurur. */
export function yaz(db, { at = Date.now(), kind, sessionId = null, agent = null, project = null, data = null }) {
  if (!kind) throw new Error('olay kind alani zorunlu');
  const r = db.prepare(EKLE).run(at, kind, sessionId, agent, project, data == null ? null : JSON.stringify(data));
  return Number(r.lastInsertRowid);
}

/** Cok olay tek islemde: tarama basina onlarca olay dogabiliyor. */
export function yazToplu(db, olaylar) {
  if (!olaylar.length) return 0;
  const st = db.prepare(EKLE);
  db.exec('BEGIN');
  try {
    for (const o of olaylar) {
      st.run(o.at ?? Date.now(), o.kind, o.sessionId ?? null, o.agent ?? null,
        o.project ?? null, o.data == null ? null : JSON.stringify(o.data));
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* kapandi */ }
    throw e;
  }
  return olaylar.length;
}

export function sonSeq(db) {
  const r = db.prepare('SELECT MAX(seq) s FROM events').get();
  return Number(r?.s ?? 0);
}

function coz(r) {
  let data = null;
  if (r.data != null) { try { data = JSON.parse(r.data); } catch { data = r.data; } }
  return { seq: Number(r.seq), at: r.at, kind: r.kind, sessionId: r.session_id,
    agent: r.agent, project: r.project, data };
}

/**
 * Akistan okur. sinceSeq: bu seq'ten SONRASI (tuketicinin imleci).
 * Kasitli olarak seq sirali - zaman sirali degil: es zamanli yazimlarda
 * zaman damgalari geri gidebilir ama seq asla gitmez.
 */
export function oku(db, { sinceSeq = 0, kind = null, sessionId = null, limit = 500 } = {}) {
  const kosul = ['seq > ?'];
  const arg = [sinceSeq];
  if (kind) { kosul.push('kind = ?'); arg.push(kind); }
  if (sessionId) { kosul.push('session_id = ?'); arg.push(sessionId); }
  arg.push(limit);
  return db.prepare(
    `SELECT * FROM events WHERE ${kosul.join(' AND ')} ORDER BY seq LIMIT ?`
  ).all(...arg).map(coz);
}

/** Zaman araligi: replay ve zaman seridi icin. */
export function aralik(db, { baslangic, bitis = Date.now(), kind = null, limit = 20000 } = {}) {
  const kosul = ['at >= ?', 'at <= ?'];
  const arg = [baslangic, bitis];
  if (kind) { kosul.push('kind = ?'); arg.push(kind); }
  arg.push(limit);
  return db.prepare(
    `SELECT * FROM events WHERE ${kosul.join(' AND ')} ORDER BY seq LIMIT ?`
  ).all(...arg).map(coz);
}

/** Her oturumun en son durum olayi. Yeniden baslatmada tekrar olay uretmemek icin. */
export function sonDurumlar(db) {
  const rows = db.prepare(`
    SELECT e.* FROM events e
    JOIN (SELECT session_id, MAX(seq) m FROM events
          WHERE kind = ? AND session_id IS NOT NULL GROUP BY session_id) x
      ON x.session_id = e.session_id AND x.m = e.seq
  `).all(OLAY.DURUM);
  const h = new Map();
  for (const r of rows) { const o = coz(r); h.set(o.sessionId, o); }
  return h;
}

/**
 * Durum degisimlerini olaya cevirir. Ayni durum tekrar gelirse yazmaz -
 * aksi halde 15 saniyelik tarama akisi sonsuz tekrarla dolar.
 * Faz 1'deki bildirim motoru bu siniftan beslenecek.
 */
export class GecisTakipcisi {
  constructor(db) {
    this.db = db;
    this.son = sonDurumlar(db);
  }

  /** Degistiyse olayi biriktirir. Uretilen olaylari dondurur (bos olabilir). */
  tara(anlik) {
    const yeni = [];
    const goruldu = new Set();
    for (const s of anlik) {
      goruldu.add(s.sessionId);
      const onceki = this.son.get(s.sessionId);
      if (onceki && onceki.data?.durum === s.durum) continue;
      const olay = {
        at: s.at ?? Date.now(),
        kind: OLAY.DURUM,
        sessionId: s.sessionId,
        project: s.project ?? null,
        agent: s.agent ?? null,
        data: {
          durum: s.durum,
          onceki: onceki?.data?.durum ?? null,
          arac: s.arac ?? null,
          model: s.model ?? null,
          dal: s.dal ?? null,
          kesin: !!s.kesin,
          // Son mesaj parcasi yerel akista dursun: bildirime gonderilip
          // gonderilmemesi ayrı bir karar (bildirim.icerik).
          metin: s.sonMetin ? String(s.sonMetin).slice(0, 120) : null,
        },
      };
      yeni.push(olay);
      this.son.set(s.sessionId, { ...olay, seq: null });
    }
    if (yeni.length) yazToplu(this.db, yeni);
    return yeni;
  }
}

/**
 * Yaslanma kirpmasi. Akis ekle-only ama sinirsiz degil: bu makinede aylarca
 * calisacak, tabloyu buyutup her sorguyu yavaslatmasin.
 */
export function kirp(db, { saklaGun = 60, enFazla = 500000 } = {}) {
  const esik = Date.now() - saklaGun * 86400_000;
  const a = db.prepare('DELETE FROM events WHERE at < ?').run(esik);
  let b = { changes: 0 };
  const n = Number(db.prepare('SELECT COUNT(*) c FROM events').get()?.c ?? 0);
  if (n > enFazla) {
    // OFFSET, atilacak SON satiri gostermeli: n-enFazla adet atilacaksa
    // esik (n-enFazla)'inci satirdir, yani OFFSET n-enFazla-1.
    b = db.prepare('DELETE FROM events WHERE seq <= (SELECT seq FROM events ORDER BY seq LIMIT 1 OFFSET ?)')
      .run(n - enFazla - 1);
  }
  return Number(a.changes ?? 0) + Number(b.changes ?? 0);
}
