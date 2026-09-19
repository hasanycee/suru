// Referans cozum: kabul testinin DOGRU yazildigini kanitlar (sinav testleri kullanir).
function aylikRapor(oduncler, yil, ay) {
  if (!Number.isInteger(yil)) throw new TypeError('yil tamsayi olmali');
  if (!Number.isInteger(ay) || ay < 1 || ay > 12) throw new TypeError('ay 1-12 arasi tamsayi olmali');
  const onek = String(yil).padStart(4, '0') + '-' + String(ay).padStart(2, '0') + '-';
  const aySonu = onek + String(new Date(Date.UTC(yil, ay, 0)).getUTCDate()).padStart(2, '0');
  const secili = oduncler.filter((o) => typeof o.alis === 'string' && o.alis.startsWith(onek));
  const sayac = new Map();
  let iade = 0, geciken = 0;
  for (const o of secili) {
    if (o.iade) {
      iade++;
      if (o.iade > o.son) geciken++;
    } else if (o.son <= aySonu) {
      geciken++;
    }
    sayac.set(o.kitapId, (sayac.get(o.kitapId) || 0) + 1);
  }
  let enCokOkunan = null, enCok = 0;
  const sirali = [...sayac].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [id, n] of sirali) if (n > enCok) { enCok = n; enCokOkunan = id; }
  return { toplam: secili.length, iade, geciken, enCokOkunan };
}

module.exports = { aylikRapor };
