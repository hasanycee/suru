// Gece raporu ve karneler. Kullanim: npm run gece [saat]
import { openDb } from './db.js';
import { DB_PATH } from './paths.js';
import { ayarlariOku } from './config.js';
import { ozet, metinRapor, geceAraligi } from './gece-raporu.js';
import { tumKarneler, modelOnerisi } from './karne.js';

const usd = (n) => '$' + Number(n ?? 0).toFixed(2);
// Hukumlu kosu yoksa oran yok: %0 yazmak "basarisiz" demek olurdu.
const oran = (x) => (x == null ? '-' : '%' + Math.round(x * 100)).padStart(4);
const NL = String.fromCharCode(10);
const db = openDb(DB_PATH);
const ayarlar = ayarlariOku();

// Arguman saat verirse o kadar geriye bak, yoksa gece araligi.
const saat = Number(process.argv[2]);
const aralik = Number.isFinite(saat) && saat > 0
  ? { baslangic: Date.now() - saat * 3600_000, bitis: Date.now() }
  : geceAraligi();

console.log(metinRapor(ozet(db, ayarlar, aralik)));

const karneler = tumKarneler(db, { enAzKosu: 1 });
if (karneler.length) {
  console.log(NL + 'KARNELER' + NL + '-'.repeat(46));
  for (const k of karneler) {
    const ad = k.ajan.simge + ' ' + k.ajan.ad;
    console.log(ad.padEnd(14) + (k.is?.ad ?? '(silinmis)').padEnd(18)
      + 'sv' + k.seviye + '  ' + k.kosu + ' kosu  ' + oran(k.basariOrani)
      + ' basari  ort ' + usd(k.ortalamaUsd)
      + (k.kararaDusen ? '  (' + k.kararaDusen + ' karar bekliyor)' : ''));
    if (k.rozetler.length) {
      console.log('              ' + k.rozetler.map((r) => r.ad).join(', ')
        + '  (' + k.rozetler[0].not + ')');
    }
  }
}

const m = modelOnerisi(db, { enAzKosu: 3 });
console.log(NL + 'MODEL' + NL + '-'.repeat(46));
if (m.gruplar.length) {
  for (const g of m.gruplar) {
    console.log(String(g.model).padEnd(14) + g.kosu + ' kosu  ' + oran(g.basariOrani)
      + ' basari  ort ' + usd(g.ortalamaUsd));
  }
  console.log('');
}
console.log(m.oneri ? ('ONERI: ' + m.oneri + ' - ' + m.neden) : ('oneri yok: ' + m.neden));
db.close();
