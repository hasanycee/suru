import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  olc, importlariBul, yorumlariSil, kosulluKuralMi, projeKlasorAdi, tahminiToken, SINIR,
} from '../src/baglam.js';

const TIK = String.fromCharCode(96);
const CIT = TIK + TIK + TIK;
const NL = String.fromCharCode(10);

/** Gercek dosya sistemindeki atalar ve ev klasoru olcume karismasin. */
function sahne() {
  const kok = mkdtempSync(join(tmpdir(), 'suru-baglam-'));
  const ev = join(kok, 'ev');
  const proje = join(kok, 'ust', 'proje');
  mkdirSync(ev, { recursive: true });
  mkdirSync(proje, { recursive: true });
  const secenek = (ek = {}) => ({ ev, durak: kok, gitKokFn: () => null, ...ek });
  return { kok, ev, proje, secenek, temizle: () => { try { rmSync(kok, { recursive: true, force: true }); } catch { /* sonra */ } } };
}

const yaz = (yol, metin) => { mkdirSync(join(yol, '..'), { recursive: true }); writeFileSync(yol, metin, 'utf8'); };

// --- Ayristirma ---

test('import yollari bulunur, e-posta ve kod icindekiler import sayilmaz', () => {
  const metin = [
    'Genel bakis icin @README.md dosyasina bak.',
    'iletisim: ben@ornek.com',
    'Satir ici ' + TIK + '@degil.md' + TIK + ' ornek.',
    CIT,
    '@kodblogu.md',
    CIT,
    '@docs/git.md, ve @~/.claude/kisisel.md.',
  ].join(NL);
  assert.deepEqual(importlariBul(metin), ['README.md', 'docs/git.md', '~/.claude/kisisel.md']);
});

test('HTML yorumlari silinir ama kod blogundakiler korunur', () => {
  const metin = 'a <!-- bakimci notu --> b' + NL + CIT + NL + '<!-- kodda kalir -->' + NL + CIT;
  const t = yorumlariSil(metin);
  assert.ok(!t.includes('bakimci notu'));
  assert.ok(t.includes('kodda kalir'));
});

test('paths on-bilgisi olan kural kosullu sayilir', () => {
  assert.equal(kosulluKuralMi('---' + NL + 'paths:' + NL + '  - "src/**"' + NL + '---' + NL + 'kural'), true);
  assert.equal(kosulluKuralMi('# kural' + NL + 'paths: bu metin, on-bilgi degil'), false);
  assert.equal(kosulluKuralMi('---' + NL + 'baslik: x' + NL + '---' + NL + 'kural'), false);
});

test('proje klasor adi Claude Code adlandirmasina uyar', () => {
  // Gozlenen: "C:\Users\hasan\Desktop\AI projects" -> "C--Users-hasan-Desktop-AI-projects"
  const ad = projeKlasorAdi(join('C:', 'Users', 'hasan', 'Desktop', 'AI projects'));
  if (process.platform === 'win32') assert.equal(ad, 'C--Users-hasan-Desktop-AI-projects');
  assert.match(ad, /^[a-zA-Z0-9-]+$/);
});

// --- Olcum ---

test('talimat dosyasi yoksa yuk sifir', () => {
  const s = sahne();
  const r = olc(s.proje, s.secenek());
  assert.equal(r.toplam.token, 0);
  assert.deepEqual(r.dosyalar, []);
  s.temizle();
});

test('ust klasordeki CLAUDE.md da sayilir, sira kokten asagi', () => {
  const s = sahne();
  yaz(join(s.kok, 'ust', 'CLAUDE.md'), 'ust kurallar');
  yaz(join(s.proje, 'CLAUDE.md'), 'proje kurallari');
  yaz(join(s.proje, 'CLAUDE.local.md'), 'kisisel');
  const r = olc(s.proje, s.secenek());
  const yollar = r.dosyalar.map((d) => d.yol);
  assert.equal(yollar.length, 3);
  assert.ok(yollar[0].includes(join('ust', 'CLAUDE.md')), 'ust klasor once');
  assert.ok(r.toplam.token > 0);
  s.temizle();
});

test('importlar acilir, dongu sonsuza girmez', () => {
  const s = sahne();
  yaz(join(s.proje, 'CLAUDE.md'), 'bak @a.md');
  yaz(join(s.proje, 'a.md'), 'A icerik @b.md');
  yaz(join(s.proje, 'b.md'), 'B icerik @a.md');   // dongu
  const r = olc(s.proje, s.secenek());
  const turler = r.dosyalar.map((d) => d.tur);
  assert.deepEqual(turler, ['claude-md', 'import', 'import'], 'a ve b bir kez sayilir');
  s.temizle();
});

test('import zinciri en fazla 4 atlama', () => {
  const s = sahne();
  yaz(join(s.proje, 'CLAUDE.md'), '@i1.md');
  for (let i = 1; i <= 6; i++) yaz(join(s.proje, 'i' + i + '.md'), 'seviye ' + i + ' @i' + (i + 1) + '.md');
  const r = olc(s.proje, s.secenek());
  const importlar = r.dosyalar.filter((d) => d.tur === 'import');
  assert.equal(importlar.length, SINIR.importAtlama);
  assert.equal(Math.max(...importlar.map((d) => d.atlama)), SINIR.importAtlama);
  s.temizle();
});

test('kosullu kural yuke eklenmez, ayri listelenir', () => {
  const s = sahne();
  yaz(join(s.proje, '.claude', 'rules', 'genel.md'), 'her zaman gecerli');
  yaz(join(s.proje, '.claude', 'rules', 'api', 'api.md'),
    '---' + NL + 'paths:' + NL + '  - "src/api/**"' + NL + '---' + NL + 'sadece api');
  const r = olc(s.proje, s.secenek());
  assert.equal(r.dosyalar.filter((d) => d.tur === 'kural').length, 1);
  assert.equal(r.kosullu.length, 1);
  assert.ok(r.kosullu[0].yol.endsWith('api.md'));
  s.temizle();
});

test('HTML yorumlari token hesabina girmez', () => {
  const s = sahne();
  yaz(join(s.proje, 'CLAUDE.md'), 'kisa<!-- ' + 'x'.repeat(5000) + ' -->');
  const r = olc(s.proje, s.secenek());
  assert.ok(r.toplam.token < 20, 'bakimci notlari context harcamaz: ' + r.toplam.token);
  s.temizle();
});

test('200 satiri asan CLAUDE.md uyari uretir', () => {
  const s = sahne();
  yaz(join(s.proje, 'CLAUDE.md'), Array.from({ length: 250 }, (_, i) => 'kural ' + i).join(NL));
  const r = olc(s.proje, s.secenek());
  assert.ok(r.uyarilar.some((u) => /250 satir/.test(u)));
  s.temizle();
});

test('otomatik hafiza kapaliyken sayilmaz, acikken sayilir ve baska koku uyarilir', () => {
  const s = sahne();
  const projeler = join(s.kok, 'projeler');
  const ustDepo = join(s.kok, 'ust');
  yaz(join(projeler, projeKlasorAdi(ustDepo), 'memory', 'MEMORY.md'), '- [not](n.md) - kullanicinin notu');

  assert.equal(olc(s.proje, s.secenek({ projelerDizini: projeler })).hafiza, null, 'varsayilan: kapali');

  const r = olc(s.proje, s.secenek({ projelerDizini: projeler, otomatikHafiza: true, gitKokFn: () => ustDepo }));
  assert.ok(r.dosyalar.some((d) => d.tur === 'otomatik-hafiza'));
  assert.ok(r.uyarilar.some((u) => /BASKA bir kokten/.test(u)),
    'kendi deposu olmayan proje ust deponun hafizasini yuklerse uyarilmali');
  s.temizle();
});

test('otomatik hafiza ilk 200 satirla sinirlanir', () => {
  const s = sahne();
  const projeler = join(s.kok, 'projeler');
  yaz(join(projeler, projeKlasorAdi(s.proje), 'memory', 'MEMORY.md'),
    Array.from({ length: 500 }, (_, i) => '- not ' + i).join(NL));
  const r = olc(s.proje, s.secenek({ projelerDizini: projeler, otomatikHafiza: true, gitKokFn: () => s.proje }));
  const h = r.dosyalar.find((d) => d.tur === 'otomatik-hafiza');
  assert.equal(h.satir, SINIR.hafizaSatir);
  s.temizle();
});

test('token tahmini karakterle orantili', () => {
  assert.equal(tahminiToken(''), 0);
  assert.equal(tahminiToken('x'.repeat(35)), 10);
});
