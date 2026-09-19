import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const jeton = readFileSync(join(homedir(), '.claude', 'suru', 'token'), 'utf8').trim();
const K = 'http://localhost:7777';
const ilk = await fetch(K + '/?t=' + jeton, { redirect: 'manual' });
const h = { cookie: (ilk.headers.get('set-cookie') || '').split(';')[0], 'content-type': 'application/json', origin: K };
const komut = async (metin) => (await (await fetch(K + '/komut', { method: 'POST', headers: h, body: JSON.stringify({ metin }) })).json()).metin;
const veri = async () => (await fetch(K + '/komuta/veri', { headers: h })).json();
const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
const c = await komut('/talimat 98aafb Az once ozetledigin dosyalardan ILK ucunun sadece adlarini yaz, baska hicbir sey okuma.');
console.log(c);
const kod = [.../\[([0-9a-f]{6})\]/g.exec(c) ?? []][1];
await bekle(3000);
let k;
for (let i = 0; i < 180; i++) {
  const v = await veri();
  k = v.kosular.find((x) => x.devam && x.is.ad.startsWith('Assets altindaki C# betiklerinden 10'));
  if (k && !k.canli && k.durum !== 'calisiyor' && k.durum !== 'bekliyor') break;
  await bekle(1000);
}
console.log('DURUM', k?.durum, 'USD', k?.usd, 'arac', k?.aracSayisi, 'kod', kod);
for (const s of (k?.satirlar ?? []).slice(-6)) console.log(' ', s.ton, '|', s.metin.slice(0, 200));
