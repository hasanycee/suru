// Canli ara talimat denemesi: is ac, oturum acilinca /talimat gonder, bitince sonucu yaz.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const jeton = readFileSync(join(homedir(), '.claude', 'suru', 'token'), 'utf8').trim();
const K = 'http://localhost:7777';
const ilk = await fetch(K + '/?t=' + jeton, { redirect: 'manual' });
const cerez = (ilk.headers.get('set-cookie') || '').split(';')[0];
const h = { cookie: cerez, 'content-type': 'application/json', origin: K };
const komut = async (metin) => (await (await fetch(K + '/komut', { method: 'POST', headers: h, body: JSON.stringify({ metin }) })).json()).metin;
const veri = async () => (await fetch(K + '/komuta/veri', { headers: h })).json();
const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

const c = await komut('/yeni ogrenme | Assets altindaki C# betiklerinden 10 tanesini TEK TEK (her seferinde bir Read) oku ve her biri icin bir cumlelik ozet yaz. Hicbir dosyayi degistirme.');
console.log(c);
const kod = /\[([0-9a-f]{6})\]/.exec(c)[1];
const bul = async () => (await veri()).kosular.find((k) => k.id.startsWith(kod));
for (let i = 0; i < 60; i++) { const k = await bul(); if (k && k.satirlar.some((s) => s.asama === 'basladi')) break; await bekle(500); }
await bekle(2500);
console.log('TALIMAT ->', await komut('/talimat ' + kod + ' Ek istek: ozetin en sonuna ayri bir satirda MUZ-42 yaz.'));
for (let i = 0; i < 240; i++) { const k = await bul(); if (k && !k.canli && k.durum !== 'calisiyor' && k.durum !== 'bekliyor') break; await bekle(1000); }
const k = await bul();
console.log('DURUM', k.durum, 'USD', k.usd, 'tur', k.turSayisi);
for (const s of k.satirlar.slice(-8)) console.log(' ', s.ton, '|', s.metin.slice(0, 160));
