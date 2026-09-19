// Otomatik damitma: biriken ham ajan raporlarini kisa bir proje ozetine cevirir.
//
// Neden: her kosu bir rapor birakir. Raporlar birikir ama derse donusmez; dizin
// sadece son birkacini gosterir, geri kalani kaybolur. Damitma, kisa sureli
// hafizadan (tek tek raporlar) uzun sureliye (proje haritasi + dersler) gecistir.
//
// Kurallar:
//   - Ucuz ve salt-okur: gozlemci profili, haiku, butce tavani, dusuk oncelik.
//     Normal kuyruktan ve kota beyninden gecer; kacak yol yok.
//   - Damitici raporlardaki SAYILARI TASIYAMAZ. Sayi yalnizca dogrulanmis
//     olgulardan alinir. Ilk saha denemesinde uydurulan tam olarak sayilardi.
//   - Tek raporda gecen iddia "(tek kaynak)", celisen iddia "(celiski)".
//   - Sonuc 'yorum' DEGIL 'ozet' turune yazilir (bkz. hafiza.js). Yorum olsaydi
//     bir sonraki damitmayi tetikler, sonsuz dongu dogardi.

import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { isEkle, KOSU_DURUMU } from './isler.js';
import {
  kayitlar, yorumDosyasi, projeAnahtari, DAMITMA_ONEK, damitmaIsiMi, HAFIZA_TURU,
} from './hafiza.js';

const NL = String.fromCharCode(10);

/** Projenin damitma isi (varsa). Proje basina tek is, tekrar kullanilir. */
export function damitmaIsiBul(db, cwd) {
  const anahtar = projeAnahtari(cwd);
  const satirlar = db.prepare('SELECT * FROM isler WHERE ad LIKE ?').all(DAMITMA_ONEK + '%');
  for (const r of satirlar) {
    if (projeAnahtari(r.cwd) === anahtar) {
      return { id: r.id, ad: r.ad, cwd: r.cwd, profil: r.profil, model: r.model, gorev: r.gorev };
    }
  }
  return null;
}

/** Bu proje icin calisan ya da sirada bekleyen damitma var mi? */
function damitmaSurerMi(db, cwd) {
  const is = damitmaIsiBul(db, cwd);
  if (!is) return false;
  const n = db.prepare("SELECT COUNT(*) n FROM kosular WHERE is_id = ? AND durum IN ('bekliyor','calisiyor')")
    .get(is.id);
  return Number(n?.n ?? 0) > 0;
}

/**
 * Damitma gerekiyor mu? Kapanmamis ham rapor sayisi esigi gecti ve
 * halihazirda surmekte olan bir damitma yoksa.
 */
export function damitmaGerekiyorMu(db, cwd, { esik = 5 } = {}) {
  const acik = kayitlar(db, { cwd, tur: HAFIZA_TURU.YORUM, sadeceAcik: true, limit: 1000 });
  if (acik.length < esik) return false;
  return !damitmaSurerMi(db, cwd);
}

/** Damiticiya verilecek gorev metni. Raporlarin yolu ve dogrulanmis olgular. */
export function damitmaGorevi(raporYollari, olgular) {
  const s = [
    'Gorev: Asagidaki DOGRULANMAMIS ajan raporlarini oku ve bu proje icin KISA bir ozet cikar.',
    'Hicbir dosyayi degistirme.',
    '',
    'Kurallar:',
    '- En fazla 40 satir. Iki bolum: "Proje haritasi" (moduller, ne yapar) ve',
    '  "Dersler ve dikkat edilecekler".',
    '- Birden fazla raporda gecen iddiayi yaz. Tek raporda gecen iddianin sonuna "(tek kaynak)" ekle.',
    '- Raporlar birbiriyle celisiyorsa ikisini de yaz ve sonuna "(celiski)" ekle.',
    '- SAYI YAZMA. Sayi yalnizca asagidaki dogrulanmis olgulardan alinabilir.',
    '  Raporlardaki sayilari tasima: onceki bir ajan test sayilarini uydurdu.',
    '- Emin olmadigin seyi uydurma. Gerekirse ilgili kaynak dosyayi kendin oku.',
    '',
  ];
  s.push('Dogrulanmis olgular:');
  if (olgular.length) for (const o of olgular) s.push('- ' + o.icerik.replace(/\s+/g, ' ').slice(0, 240));
  else s.push('- (yok)');
  s.push('');
  s.push('Okunacak raporlar:');
  for (const y of raporYollari) s.push('- ' + y);
  return s.join(NL);
}

/**
 * Projenin damitma isini hazirlar: yoksa olusturur, varsa gorevini tazeler.
 * Doner: is kaydi. Kuyruga almak cagirana ait.
 */
export function damitmaIsiHazirla(db, cwd, { model = 'haiku', butceUsd = 0.25, kok = null } = {}) {
  const acik = kayitlar(db, { cwd, tur: HAFIZA_TURU.YORUM, sadeceAcik: true, limit: 1000 });
  const sec = kok ? { kok } : undefined;
  const yollar = acik
    .filter((y) => y.kosuId)
    .map((y) => yorumDosyasi(cwd, y.kosuId, sec))
    .filter((y) => existsSync(y));
  const olgular = kayitlar(db, { cwd, tur: HAFIZA_TURU.OLGU, limit: 20 });
  const gorev = damitmaGorevi(yollar, olgular);

  let is = damitmaIsiBul(db, cwd);
  if (!is) {
    is = isEkle(db, {
      ad: DAMITMA_ONEK + (basename(projeAnahtari(cwd)) || 'proje'),
      gorev, cwd, profil: 'gozlemci', model, butceUsd,
      // Dusuk oncelik: kullanicinin gercek isleri once.
      oncelik: 8,
      ic: true,
    });
  } else {
    db.prepare('UPDATE isler SET gorev = ?, model = ?, butce_usd = ?, etkin = 1 WHERE id = ?')
      .run(gorev, model, butceUsd, is.id);
    is = { ...is, gorev, model };
  }
  return is;
}

export { damitmaIsiMi, KOSU_DURUMU };
