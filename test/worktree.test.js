import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { depoMu, dalAdi, kirliMi, worktreeAc, worktreeKapat, dalOzeti, artiklariTemizle, worktreeKoku } from '../src/worktree.js';

function g(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function depo() {
  const kok = mkdtempSync(join(tmpdir(), 'suru-wt-'));
  const proje = join(kok, 'proje');
  execFileSync('git', ['init', '-q', '-b', 'main', proje], { windowsHide: true });
  g(proje, ['config', 'user.email', 't@t']);
  g(proje, ['config', 'user.name', 't']);
  writeFileSync(join(proje, 'a.txt'), 'ilk\n');
  g(proje, ['add', '.']);
  g(proje, ['commit', '-qm', 'ilk']);
  return { kok, proje, wtKok: join(kok, 'wt'),
    temizle: () => { try { rmSync(kok, { recursive: true, force: true }); } catch { /* sonra */ } } };
}

test('dal adi is adindan turer ve guvenli karakterlere indirgenir', () => {
  assert.equal(dalAdi({ ad: 'Gece Raporu' }, 'abcdef1234'), 'suru/gece-raporu-abcdef12');
  assert.equal(dalAdi({ ad: 'a/b:c *?' }, 'zzzzzzzz'), 'suru/a-b-c-zzzzzzzz');
  assert.match(dalAdi({}, '12345678'), /^suru\/is-12345678$/);
});

test('git deposu olmayan klasorde izolasyon acikca reddedilir', () => {
  const kok = mkdtempSync(join(tmpdir(), 'suru-wt-yok-'));
  assert.equal(depoMu(kok), false);
  assert.throws(() => worktreeAc({ ad: 'x', cwd: kok }, 'k1', { kok: join(kok, 'wt') }), /git deposu gerekiyor/);
  try { rmSync(kok, { recursive: true, force: true }); } catch { /* sonra */ }
});

test('worktree ayri klasorde acilir, ana calisma kopyasi etkilenmez', () => {
  const o = depo();
  const w = worktreeAc({ ad: 'is', cwd: o.proje }, 'kosu1234', { kok: o.wtKok });
  assert.ok(existsSync(w.yol), 'worktree klasoru olusmali');
  assert.notEqual(w.yol, o.proje);
  assert.equal(w.dal, 'suru/is-kosu1234');

  // Worktree'de yazmak ana kopyayi degistirmez.
  writeFileSync(join(w.yol, 'a.txt'), 'ajan degistirdi\n');
  writeFileSync(join(w.yol, 'yeni.txt'), 'yeni\n');
  assert.equal(readFileSync(join(o.proje, 'a.txt'), 'utf8'), 'ilk\n', 'ana kopya dokunulmamis');
  assert.equal(existsSync(join(o.proje, 'yeni.txt')), false);
  assert.equal(kirliMi(o.proje), false, 'ana kopya temiz kalmali');

  o.temizle();
});

test('kapatinca degisiklikler dala commit edilir, klasor silinir, ana dal oynamaz', () => {
  const o = depo();
  const anaOnce = g(o.proje, ['rev-parse', 'HEAD']);
  const w = worktreeAc({ ad: 'is', cwd: o.proje }, 'kosu1234', { kok: o.wtKok });
  writeFileSync(join(w.yol, 'yeni.txt'), 'ajanin isi\n');

  const r = worktreeKapat({ ad: 'is', cwd: o.proje }, w, { kosuId: 'kosu1234' });
  assert.equal(r.degisen, 1);
  assert.ok(r.commit, 'degisiklik commit edilmeli');
  assert.equal(r.bosSonuc, false);
  assert.equal(existsSync(w.yol), false, 'klasor silinmeli');

  // Ana dal oynamadi, ama is dalda duruyor.
  assert.equal(g(o.proje, ['rev-parse', 'HEAD']), anaOnce, 'senin dalin oynamamali');
  assert.equal(existsSync(join(o.proje, 'yeni.txt')), false, 'senin calisma kopyanda yok');
  const dalDosyalari = g(o.proje, ['ls-tree', '--name-only', w.dal]);
  assert.match(dalDosyalari, /yeni\.txt/, 'is dalda duruyor');

  const ozet = dalOzeti(o.proje, w.dal, w.taban);
  assert.match(ozet.log, /suru: is/);
  assert.match(ozet.dosyalar, /yeni\.txt/);
  o.temizle();
});

test('hicbir sey degismediyse commit atilmaz ve bosSonuc bildirilir', () => {
  const o = depo();
  const w = worktreeAc({ ad: 'is', cwd: o.proje }, 'kosu9', { kok: o.wtKok });
  const r = worktreeKapat({ ad: 'is', cwd: o.proje }, w, { kosuId: 'kosu9' });
  assert.equal(r.degisen, 0);
  assert.equal(r.commit, null);
  assert.equal(r.bosSonuc, true);
  o.temizle();
});

test('iki kosu ayni anda: iki ayri worktree, birbirini ezmez', () => {
  const o = depo();
  const a = worktreeAc({ ad: 'is', cwd: o.proje }, 'aaaaaaaa', { kok: o.wtKok });
  const b = worktreeAc({ ad: 'is', cwd: o.proje }, 'bbbbbbbb', { kok: o.wtKok });
  assert.notEqual(a.yol, b.yol);
  assert.notEqual(a.dal, b.dal);

  writeFileSync(join(a.yol, 'a.txt'), 'A yazdi\n');
  writeFileSync(join(b.yol, 'a.txt'), 'B yazdi\n');
  // Ayni dosyaya yazdilar ama birbirlerini gormuyorlar.
  assert.equal(readFileSync(join(a.yol, 'a.txt'), 'utf8'), 'A yazdi\n');
  assert.equal(readFileSync(join(b.yol, 'a.txt'), 'utf8'), 'B yazdi\n');

  const ra = worktreeKapat({ ad: 'is', cwd: o.proje }, a, { kosuId: 'aaaaaaaa' });
  const rb = worktreeKapat({ ad: 'is', cwd: o.proje }, b, { kosuId: 'bbbbbbbb' });
  // Her iki is de kendi dalinda korunmus: kayip guncelleme yok.
  assert.match(g(o.proje, ['show', ra.dal + ':a.txt']), /A yazdi/);
  assert.match(g(o.proje, ['show', rb.dal + ':a.txt']), /B yazdi/);
  o.temizle();
});

test('kaydedilmemis degisiklikler bildirilir (ajan onlari gormeyecek)', () => {
  const o = depo();
  writeFileSync(join(o.proje, 'a.txt'), 'henuz commit edilmedi\n');
  assert.equal(kirliMi(o.proje), true);
  const w = worktreeAc({ ad: 'is', cwd: o.proje }, 'kosu7', { kok: o.wtKok });
  assert.equal(w.kirliydi, true, 'cagiran uyarabilsin diye bildirilir');
  // Worktree HEAD'den acildigi icin ajan eski icerigi gorur.
  // Satir sonu git'in autocrlf ayarina gore degisir; onemli olan ESKI icerigi gormesi.
  assert.match(readFileSync(join(w.yol, 'a.txt'), 'utf8'), /^ilk\s*$/);
  o.temizle();
});

test('geride kalmis worktree kaydi temizlenir, duran worktree korunur', () => {
  const o = depo();
  const kalan = worktreeAc({ ad: 'is', cwd: o.proje }, 'coken12', { kok: o.wtKok });
  const duran = worktreeAc({ ad: 'is', cwd: o.proje }, 'duran34', { kok: o.wtKok });
  // Kosu cokmus gibi: klasor gitti ama git kaydi duruyor.
  rmSync(kalan.yol, { recursive: true, force: true });
  const n = artiklariTemizle(o.proje, { kok: o.wtKok });
  assert.equal(n, 1, 'sadece kaybolan kayit temizlenir');
  assert.ok(existsSync(duran.yol), 'duran worktree korunmali');
  o.temizle();
});

test('worktree koku ~/.claude ALTINDA OLMAMALI (ajan orada dosya duzenleyemiyor)', () => {
  // Regresyon (canli olcum): kok ~/.claude/suru/worktree iken ayni gorev, ayni
  // profil, ayni model ile izin reddedildi ve dosya yazilmadi; temp altinda
  // sorunsuz yazildi. Izole kosu sessizce bos dal uretiyordu.
  const kok = worktreeKoku();
  const claudeDizini = join(homedir(), '.claude');
  assert.ok(!kok.toLowerCase().startsWith(claudeDizini.toLowerCase()),
    'worktree koku ~/.claude disinda olmali, su an: ' + kok);
});
