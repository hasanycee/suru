// Denetimli profilde canli ara talimat: izin davranisi stdin modunda degisiyor mu?
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const jeton = readFileSync(join(homedir(), '.claude', 'suru', 'token'), 'utf8').trim();
const K = 'http://localhost:7777';
const ilk = await fetch(K + '/?t=' + jeton, { redirect: 'manual' });
const h = { cookie: (ilk.headers.get('set-cookie') || '').split(';')[0], 'content-type': 'application/json', origin: K };
const post = async (yol, g) => (await fetch(K + yol, { method: 'POST', headers: h, body: JSON.stringify(g) })).json();
const veri = async () => (await fetch(K + '/komuta/veri', { headers: h })).json();
const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
const cwd = join(process.env.LOCALAPPDATA, 'suru', 'deneme', 'ogrenme');
const e = await post('/is/ekle', { ad: 'denetimli-talimat-olcumu', cwd, profil: 'denetimli', model: 'haiku', butceUsd: 0.4,
  gorev: 'Once Assets altindaki 4 C# dosyasini tek tek oku. Sonra proje kokunde SURU_DENEME.txt olustur, icine "bir" yaz. En son `git status --short` calistirip ciktisini ozetle.' });
console.log('is', e.is?.id, e.hata ?? '');
const s = await post('/is/siraya', { id: e.is.id });
const bul = async () => (await veri()).kosular.find((k) => k.id === s.kosuId);
for (let i = 0; i < 60; i++) { const k = await bul(); if (k && k.satirlar.some((x) => x.asama === 'basladi')) break; await bekle(500); }
await bekle(2000);
console.log('TALIMAT ->', JSON.stringify(await post('/is/talimat', { id: e.is.id, metin: 'Ek istek: SURU_DENEME.txt dosyasina ikinci satir olarak IKI yaz.' })));
let k;
for (let i = 0; i < 240; i++) { k = await bul(); if (k && !k.canli && k.durum !== 'calisiyor' && k.durum !== 'bekliyor') break; await bekle(1000); }
console.log('DURUM', k.durum, 'USD', k.usd);
for (const x of k.satirlar.slice(-12)) console.log(' ', x.ton, '|', x.metin.slice(0, 170));
const v = await veri();
console.log('KARARLAR', JSON.stringify((v.kararlar || []).map((c) => ({ tur: c.tur, soru: String(c.soru).slice(0, 200) }))));
try { console.log('DOSYA:', JSON.stringify(readFileSync(join(cwd, 'SURU_DENEME.txt'), 'utf8'))); } catch { console.log('DOSYA yok'); }
