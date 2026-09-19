// Kota durumu ve olculmus tavan onerisi. Kullanim: npm run kota
import { openDb } from './db.js';
import { DB_PATH } from './paths.js';
import { ayarlariOku, ayarlariYaz, AYAR_YOLU } from './config.js';
import { degerlendir, tavanOner } from './kota.js';

const usd = (n) => '$' + Number(n ?? 0).toFixed(2);
const yuzde = (n) => '%' + Math.round((n ?? 0) * 100);
const baslik = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));

const db = openDb(DB_PATH);
const ayarlar = ayarlariOku();
const d = degerlendir(db, ayarlar);

baslik('SU ANKI DURUM');
for (const [ad, p] of [['5 saatlik', d.besSaat], ['haftalik', d.haftalik]]) {
  console.log(ad.padEnd(10) + usd(p.usd).padStart(10) + ' / ' + usd(p.tavan ?? 0).padStart(9)
    + '  ' + yuzde(p.oran).padStart(5) + '   ' + p.kosu + ' kosu, ' + p.oturum + ' oturum');
}
console.log('limit    : ' + (d.limit.doldu ? 'DOLU ' + (d.limit.sifirlanma ?? '') : 'yok'));
console.log('sinir    : es zamanli ' + d.sinir + '  (' + d.gerekce + ')');

const o = tavanOner(db);
if (!o) {
  baslik('ONERI');
  console.log('Olcecek kadar gecmis yok.');
} else {
  baslik('GECMISTEN OLCULMUS ONERI');
  console.log('Kaynak: ' + o.olcum.oturumSayisi + ' oturum');
  console.log('  5 saatlik  medyan ' + usd(o.olcum.besSaatMedyan) + '   tepe ' + usd(o.olcum.besSaatTepe));
  console.log('  haftalik   tepe   ' + usd(o.olcum.haftalikTepe));
  console.log('');
  console.log('Onerilen tavanlar (gecmisin %90 dilimi):');
  console.log('  besSaatlikUsd : ' + o.besSaatlikUsd + '   (su an ' + (ayarlar.kota.besSaatlikUsd ?? '-') + ')');
  console.log('  haftalikUsd   : ' + o.haftalikUsd + '   (su an ' + (ayarlar.kota.haftalikUsd ?? '-') + ')');
  console.log('');
  console.log('Tavan, ajanlarin GERI CEKILMESI gereken nokta - sana yer kalsin diye.');
  console.log('Tepe degeri tavan yapmak anlamsiz olurdu: hicbir zaman devreye girmezdi.');

  if (process.argv.includes('--uygula')) {
    ayarlar.kota.besSaatlikUsd = o.besSaatlikUsd;
    ayarlar.kota.haftalikUsd = o.haftalikUsd;
    ayarlariYaz(ayarlar);
    console.log('\nUygulandi -> ' + AYAR_YOLU);
  } else {
    console.log('\nUygulamak icin: npm run kota -- --uygula');
  }
}
db.close();
