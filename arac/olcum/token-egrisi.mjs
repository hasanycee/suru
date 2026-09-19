// Uzun kosularda girdi token EGRISI: her mesajin girdi token'i (onbellek dahil) sirayla.
// Otomatik baglam esigi (ayarlar.json > baglam.esikToken) bu egriye bakilmadan secilmez.
// Kullanim: node arac/olcum/token-egrisi.mjs [en-fazla-kosu]   (varsayilan 10, en uzun kosular)
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '../../src/paths.js';

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const n = Number(process.argv[2] ?? 10) || 10;
const kosular = db.prepare(`SELECT json_extract(data,'$.kosuId') k, COUNT(*) mesaj, MAX(json_extract(data,'$.girdi')) tepe,
    SUM(json_extract(data,'$.girdi')) toplam FROM events WHERE kind = 'maliyet' GROUP BY k ORDER BY mesaj DESC LIMIT ?`).all(n);
if (!kosular.length) { console.log('maliyet tiki yok'); process.exit(0); }
console.log('kosu     mesaj  tepe girdi   toplam girdi   egri (k token, mesaj sirasiyla)');
for (const k of kosular) {
  const egri = db.prepare(`SELECT json_extract(data,'$.girdi') g FROM events WHERE kind='maliyet' AND json_extract(data,'$.kosuId') = ? ORDER BY seq`).all(k.k)
    .map((r) => Math.round(Number(r.g) / 1000));
  const is = db.prepare('SELECT i.ad FROM kosular x JOIN isler i ON i.id = x.is_id WHERE x.id = ?').get(k.k);
  console.log(String(k.k).slice(0, 8) + ' ' + String(k.mesaj).padStart(5) + '  ' + String(k.tepe).padStart(10) + '   ' + String(k.toplam).padStart(12)
    + '   ' + egri.join(' ') + (is ? '   (' + is.ad + ')' : ''));
}
console.log('\nYorum: tepe girdi 150k\'yi hic asmiyorsa esik gereksiz; asiyorsa esigi tepe degerin biraz altina koy ve 3 uzun kosuda dene.');
