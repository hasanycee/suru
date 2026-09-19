import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { OLAY, oku as olayOku } from '../src/events.js';
import { isEkle, isGetir, kosuAc, kosuGuncelle, KOSU_DURUMU } from '../src/isler.js';
import { gitTetikNormal, refOku, araligiOzetle, tetikTalimati, tetikle } from '../src/gittetik.js';

function ortam() {
  const dizin = mkdtempSync(join(tmpdir(), 'suru-gittetik-'));
  const db = openDb(join(dizin, 'k.db'));
  const acilan = [];
  const kuyruk = { siraya: (id, ek = {}) => { const k = kosuAc(db, id, ek); acilan.push(k); return k; } };
  return { db, dizin, kuyruk, acilan, temizle: () => {
    db.close();
    try { rmSync(dizin, { recursive: true, force: true }); } catch { /* sonra */ }
  } };
}

// --- Ifade dogrulama ---

test('gecerli referanslar kabul, tehlikeli olanlar reddedilir', () => {
  assert.equal(gitTetikNormal('  HEAD '), 'HEAD');
  assert.equal(gitTetikNormal('origin/main'), 'origin/main');
  assert.equal(gitTetikNormal('@{u}'), '@{u}');
  assert.equal(gitTetikNormal(''), null);
  assert.equal(gitTetikNormal(null), null);
  for (const kotu of ['a b', 'a;b', '../x', 'a..b', '$(x)', 'a|b']) {
    assert.throws(() => gitTetikNormal(kotu), undefined, kotu);
  }
});

// --- Tetikleme kurallari (sahte okuyucu ile) ---

test('ilk gorus TETIKLEMEZ, sadece taban commit kaydedilir', () => {
  const o = ortam();
  const is = isEkle(o.db, { ad: 'g', gorev: 'x', cwd: o.dizin, profil: 'gozlemci', gitTetik: 'origin/main' });
  const r = tetikle(o.db, o.kuyruk, { oku: () => 'aaaa111', ozetle: () => null });
  assert.deepEqual(r, []);
  assert.equal(o.acilan.length, 0, 'kosu acilmamali');
  assert.equal(isGetir(o.db, is.id).sonCommit, 'aaaa111');
  assert.equal(olayOku(o.db, { kind: OLAY.IS }).filter((e) => e.data.asama === 'git-taban').length, 1);
  o.temizle();
});

test('commit degisince kosu acilir, degismezse acilmaz', () => {
  const o = ortam();
  const is = isEkle(o.db, { ad: 'g', gorev: 'x', cwd: o.dizin, profil: 'gozlemci', gitTetik: 'origin/main' });
  let commit = 'aaaa111';
  const oku = () => commit;
  tetikle(o.db, o.kuyruk, { oku, ozetle: () => null });          // taban
  assert.deepEqual(tetikle(o.db, o.kuyruk, { oku, ozetle: () => null }), [], 'degismedi');
  commit = 'bbbb222';
  const r = tetikle(o.db, o.kuyruk, { oku, ozetle: () => null });
  assert.equal(r.length, 1);
  assert.equal(r[0].commit, 'bbbb222');
  assert.equal(o.acilan.length, 1);
  assert.equal(isGetir(o.db, is.id).sonCommit, 'bbbb222');
  // Ayni commit ikinci kez tetiklemez.
  assert.deepEqual(tetikle(o.db, o.kuyruk, { oku, ozetle: () => null }), []);
  o.temizle();
});

test('is calisiyorken tetik ATLANIR ama commit yine de kaydedilir (birikme yok)', () => {
  const o = ortam();
  const is = isEkle(o.db, { ad: 'g', gorev: 'x', cwd: o.dizin, profil: 'gozlemci', gitTetik: 'HEAD' });
  let commit = 'aaaa111';
  const oku = () => commit;
  tetikle(o.db, o.kuyruk, { oku, ozetle: () => null });
  const k = kosuAc(o.db, is.id);
  kosuGuncelle(o.db, k.id, { durum: KOSU_DURUMU.CALISIYOR });
  commit = 'bbbb222';
  const r = tetikle(o.db, o.kuyruk, { oku, ozetle: () => null });
  assert.equal(r[0].atlandi, true);
  assert.equal(isGetir(o.db, is.id).sonCommit, 'bbbb222', 'atlanan tetik de commiti ilerletir');
  assert.equal(olayOku(o.db, { kind: OLAY.IS }).filter((e) => e.data.asama === 'git-atlandi').length, 1);
  o.temizle();
});

test('referans cozulemezse kosu acilmaz, hata olayi yazilir', () => {
  const o = ortam();
  isEkle(o.db, { ad: 'g', gorev: 'x', cwd: o.dizin, profil: 'gozlemci', gitTetik: 'origin/yok' });
  assert.deepEqual(tetikle(o.db, o.kuyruk, { oku: () => null }), []);
  assert.equal(o.acilan.length, 0);
  assert.equal(olayOku(o.db, { kind: OLAY.HATA }).filter((e) => e.data.nerede === 'git-tetik').length, 1);
  o.temizle();
});

test('etkin olmayan is tetiklenmez', () => {
  const o = ortam();
  const is = isEkle(o.db, { ad: 'g', gorev: 'x', cwd: o.dizin, profil: 'gozlemci', gitTetik: 'HEAD' });
  o.db.prepare('UPDATE isler SET etkin = 0 WHERE id = ?').run(is.id);
  assert.deepEqual(tetikle(o.db, o.kuyruk, { oku: () => 'aaaa111' }), []);
  o.temizle();
});

test('tetikleyen commitler ajana ek talimat olarak verilir', () => {
  const o = ortam();
  isEkle(o.db, { ad: 'g', gorev: 'x', cwd: o.dizin, profil: 'gozlemci', gitTetik: 'origin/main' });
  let commit = 'aaaa111';
  const oku = () => commit;
  const ozetle = () => ({ aralik: 'aaaa111..bbbb222', log: 'bbbb222 ozellik eklendi', dosyalar: 'M\tsrc/a.js' });
  tetikle(o.db, o.kuyruk, { oku, ozetle });
  commit = 'bbbb222';
  tetikle(o.db, o.kuyruk, { oku, ozetle });
  const ek = o.acilan[0].ekTalimat;
  assert.match(ek, /aaaa111\.\.bbbb222/);
  assert.match(ek, /ozellik eklendi/);
  assert.match(ek, /src\/a\.js/);
  o.temizle();
});

// --- Gercek git deposu ---

function gitKos(cwd, args) {
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
}

test('GERCEK depo: push uzak-izleme refini oynatir, salt commit oynatmaz', () => {
  const o = ortam();
  const uzak = join(o.dizin, 'uzak.git');
  const yerel = join(o.dizin, 'yerel');
  execFileSync('git', ['init', '-q', '--bare', uzak], { windowsHide: true });
  execFileSync('git', ['init', '-q', '-b', 'main', yerel], { windowsHide: true });
  gitKos(yerel, ['config', 'user.email', 't@t']);
  gitKos(yerel, ['config', 'user.name', 't']);
  writeFileSync(join(yerel, 'a.txt'), 'a\n');
  gitKos(yerel, ['add', '.']);
  gitKos(yerel, ['commit', '-qm', 'ilk']);
  gitKos(yerel, ['remote', 'add', 'origin', uzak]);
  gitKos(yerel, ['push', '-q', '-u', 'origin', 'main']);

  const pushSonrasi = refOku(yerel, 'origin/main');
  assert.ok(pushSonrasi, 'uzak-izleme refi cozulmeli');
  assert.equal(pushSonrasi, refOku(yerel, 'HEAD'));

  // Sadece commit: HEAD oynar, origin/main OYNAMAZ. Tetigin dayandigi davranis.
  writeFileSync(join(yerel, 'b.txt'), 'b\n');
  gitKos(yerel, ['add', '.']);
  gitKos(yerel, ['commit', '-qm', 'ikinci']);
  assert.notEqual(refOku(yerel, 'HEAD'), pushSonrasi, 'HEAD ilerledi');
  assert.equal(refOku(yerel, 'origin/main'), pushSonrasi, 'push edilmeden uzak ref ayni kalmali');

  gitKos(yerel, ['push', '-q']);
  assert.equal(refOku(yerel, 'origin/main'), refOku(yerel, 'HEAD'), 'push uzak refi oynatir');

  const ozet = araligiOzetle(yerel, pushSonrasi, refOku(yerel, 'HEAD'));
  assert.match(ozet.log, /ikinci/);
  assert.match(ozet.dosyalar, /b\.txt/);
  assert.match(tetikTalimati(ozet, 'origin/main'), /origin\/main/);

  assert.equal(refOku(yerel, 'origin/yok-boyle-dal'), null, 'olmayan ref null');
  assert.equal(refOku(o.dizin, 'HEAD'), null, 'depo olmayan klasor null');
  o.temizle();
});
