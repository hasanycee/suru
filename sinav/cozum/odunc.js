// Referans cozum: gecikme hesabindaki bir-gun-kayma hatasi duzeltilmis.
const GUN = 24 * 60 * 60 * 1000;

function tarih(t) {
  if (typeof t !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new TypeError('tarih YYYY-MM-DD olmali: ' + t);
  return Date.parse(t + 'T00:00:00Z');
}

function gecikmeGunu(son, iade) {
  const fark = (tarih(iade) - tarih(son)) / GUN;
  return fark > 0 ? fark : 0;
}

function ceza(son, iade, gunlukUcret = 2) {
  return gecikmeGunu(son, iade) * gunlukUcret;
}

module.exports = { tarih, gecikmeGunu, ceza };
