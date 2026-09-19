import { readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb, isFresh, saveSession } from './db.js';
import { parseSession, mergeSub } from './parser.js';
import { PROJECTS_DIR, DB_PATH, veriDizini } from './paths.js';

export { PROJECTS_DIR, DB_PATH };

export function listTranscripts(root = PROJECTS_DIR) {
  const out = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(join(root, d.name), { withFileTypes: true })) {
      if (f.isFile() && f.name.endsWith('.jsonl')) {
        const id = basename(f.name, '.jsonl');
        // Alt-ajan kayitlari <proje>/<oturumId>/subagents/ altinda duruyor.
        let subs = [];
        try {
          const sd = join(root, d.name, id, 'subagents');
          subs = readdirSync(sd).filter((n) => n.endsWith('.jsonl')).map((n) => join(sd, n));
        } catch { /* alt-ajan yok */ }
        out.push({ project: d.name, file: join(root, d.name, f.name), subs });
      }
    }
  }
  return out;
}

export async function runIndex({ force = false, quiet = false } = {}) {
  veriDizini();
  const db = openDb(DB_PATH);
  const files = listTranscripts();
  let parsed = 0, skipped = 0, failed = 0;

  for (const { project, file, subs } of files) {
    let st;
    try { st = statSync(file); } catch { failed++; continue; }
    // Alt-ajan dosyalari da tazelik hesabina girsin.
    let mtime = st.mtimeMs, size = st.size;
    for (const sf of subs) {
      try { const ss = statSync(sf); mtime = Math.max(mtime, ss.mtimeMs); size += ss.size; } catch {}
    }
    const id = basename(file, '.jsonl');
    if (!force && isFresh(db, id, mtime, size)) { skipped++; continue; }
    try {
      const s = await parseSession(file, project);
      for (const sf of subs) mergeSub(s, await parseSession(sf, project));
      saveSession(db, s, mtime, size);
      parsed++;
    } catch (e) {
      failed++;
      if (!quiet) console.error('  ! okunamadi:', file, e.message);
    }
  }
  if (!quiet) console.log(`indekslendi: ${parsed} yeni/degismis, ${skipped} atlandi, ${failed} hatali (toplam ${files.length})`);
  return { db, parsed, skipped, failed, total: files.length };
}

// argv[1] yoksa (node -e / REPL) dogrudan calistirilmis sayilmaz.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const force = process.argv.includes('--force');
  runIndex({ force }).then(({ db }) => db.close());
}
