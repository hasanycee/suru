// Referans cozum: cakisma senaryosunun iki ozelligi birlikte.
const kitaplar = [];
const normal = (s) => String(s).trim().toLocaleLowerCase('tr');

function kitapEkle({ id, baslik, yazar, yil }) {
  if (!id || !baslik || !yazar) throw new Error('id, baslik ve yazar zorunlu');
  if (kitaplar.some((k) => k.id === id)) throw new Error('bu id zaten var: ' + id);
  if (yil !== undefined && (!Number.isInteger(yil) || yil < 1450 || yil > new Date().getFullYear())) {
    throw new RangeError('yil 1450 ile bu yil arasinda tamsayi olmali');
  }
  const k = { id, baslik, yazar };
  if (yil !== undefined) k.yil = yil;
  kitaplar.push(k);
  return k;
}

function yazaraGore(yazar) {
  const aranan = normal(yazar);
  return kitaplar.filter((k) => normal(k.yazar) === aranan);
}

function temizle() {
  kitaplar.length = 0;
}

module.exports = { kitapEkle, yazaraGore, temizle };
