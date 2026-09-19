// Yapici/denetci dongusu: kuran kendi isini denetlemez, denetleyen duzeltmez.
//
//   yapici kosar -> (dogrulama) -> DENETCI kosar -> gecti: bitti
//                                              -> kaldi: YENI yapici, bulgularla
//
// Kurallar:
//   - Her ajan SIFIR baglamla baslar. Surekliligi sohbet gecmisi degil, Suru'nun
//     verdigi paket saglar: gorev, dogrulanmamis rapor, bagimsiz kanitlar, bulgular.
//   - Denetci gozlemci profiliyle kosar (--restricted): yazma araci YOK. Olculdu:
//     arac yoklugu prompt injection'a karsi tutan tek sinir.
//   - Denetci rapora degil KANITA bakar: dogrulama komutu, golge farki (Bash
//     degisiklikleri dahil), kanit zinciri. "Test calistirdim" deyip hic komut
//     calistirmayan yapici burada yakalanir.
//   - Hukum deterministik: model "gecti" dese de yuksek/orta bulgu varsa KALDI.
//   - Korkuluklar: tur siniri, butce, ilerleme yok (ayni dosyalarda sorun suruyor).
//     Biri devreye girince dongu durur, yapici kosu TEK bir denetim kararina duser.

import { OLAY, yaz as olayYaz } from './events.js';
import { isEkle, isGetir, kosuGetir, kosuGuncelle, KOSU_DURUMU } from './isler.js';
import { damitmaIsiMi } from './hafiza.js';
import { kanitZinciri, kanitMetni } from './kanit.js';
import { degisenler, farkMetni, degisiklikOzeti } from './golge.js';
import { desenNormal, desenRegex } from './gizlilik.js';

const NL = String.fromCharCode(10);
const TIK = String.fromCharCode(96);

export const DENETCI_ONEK = '_denetci:';
export const ROL = { YAPICI: 'yapici', DENETCI: 'denetci' };
export const denetciIsiMi = (is) => !!is?.ad && String(is.ad).startsWith(DENETCI_ONEK);

/**
 * Isin kapsamina (yazilabilecek yollar) uymayan degisiklikler. Kapsam yoksa kontrol yok.
 * Gecersiz desen yok sayilir: tum degisiklikler kapsam disi gorunur (gurultulu ama guvenli yon).
 */
export function kapsamDisi(is, degisiklik = []) {
  if (!Array.isArray(is?.kapsam) || !is.kapsam.length) return [];
  const re = is.kapsam.map(desenNormal).filter(Boolean).map((g) => desenRegex(g));
  const ters = String.fromCharCode(92);
  return degisiklik
    .filter((d) => !re.some((r) => r.test(String(d.yol).split(ters).join('/'))))
    .map((d) => d.yol);
}

// Gorev metninde gecen dosya adlari (uzantili). Surum numarasi, anahtar adi gibi seyler eslesmez.
const DOSYA_ADI = /(?:^|[\s`'"(])((?:[\w.-]+\/)*[\w-]+\.(?:py|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|md|toml|cfg|ini|html|css|txt|sql|sh))(?=$|[\s`'",.;:)])/gi;

/**
 * Gorev metni kapsam disinda bir dosyayi aniyor mu? Is eklenirken UYARI icindir, engellemez.
 * Saha: gorev config.yaml duzenlemeyi istiyor, kapsam izin vermiyordu; celiski ancak iki tur
 * ve ~$0.49 sonra karar kartinda ortaya cikti.
 * Yolsuz ad (gender.py) kapsamdaki bir yolun son parcasiysa (src/livedub/gender.py) uyari yok.
 */
export function gorevKapsamCelismesi(gorev, kapsam) {
  if (!Array.isArray(kapsam) || !kapsam.length) return [];
  const sonParcalar = new Set(kapsam.map((k) => String(k).replace(/\/+$/, '').split('/').pop().toLowerCase()));
  const adlar = [...new Set([...String(gorev ?? '').matchAll(DOSYA_ADI)].map((m) => m[1]))]
    .filter((a) => a.includes('/') || !sonParcalar.has(a.toLowerCase()));
  return kapsamDisi({ kapsam }, adlar.map((yol) => ({ yol })));
}

/** Dongunun ILK yapicisindan bu yapicinin sonuna kadar degisenler (golge). */
function varsayilanDonguDegisikligi(db, yapici, is, { golgeKok } = {}) {
  const ilk = kosuGetir(db, yapici.donguId ?? yapici.id);
  const once = ilk?.golgeOnce ?? yapici.golgeOnce;
  if (!once || !yapici.golgeSonra) return null;
  try { return degisenler(is.cwd, once, yapici.golgeSonra, { kok: golgeKok }); } catch { return null; }
}

/**
 * Dogrulama ciktisindan calisan test sayisi (unittest, node:test, pytest, jest).
 * Saha: ajan raporunda "36 test" dedi, dosyada 23 vardi. Denetciye gercek sayi verilir.
 */
export function testSayisiCoz(cikti) {
  const t = String(cikti ?? '');
  const kaliplar = [/Ran (\d+) tests?/g, /(?:ℹ|#) tests (\d+)/g, /(\d+) passed/g, /Tests:\s+(?:\d+ failed, )?(\d+) passed/g];
  for (const k of kaliplar) {
    // Zincirli komutta (a && b) birden cok ozet satiri olur: hepsi toplanir.
    // Saha: LiveDub dogrulamasi iki unittest calistirdi, ilk satir alininca 43 yerine 23 raporlandi.
    const sayilar = [...t.matchAll(k)].map((m) => Number(m[1]));
    if (sayilar.length) return sayilar.reduce((a, b) => a + b, 0);
  }
  return null;
}

/** Dogrulama ciktisindan kalan test adlari (unittest FAIL/ERROR, pytest FAILED, node ✖). */
export function kalanTestler(cikti) {
  const t = String(cikti ?? '');
  const s = new Set();
  for (const m of t.matchAll(/^(?:FAIL|ERROR): (\S+)/gm)) s.add(m[1]);
  // pytest: "FAILED tests/x.py::test_y". Yalnizca bu bicim - unittest ozeti "FAILED (errors=1)" test adi degil.
  for (const m of t.matchAll(/^FAILED (\S+\.py::\S+)/gm)) s.add(m[1]);
  for (const m of t.matchAll(/^\s*✖ (.+?)(?: \([\d.]+m?s\))?\s*$/gm)) {
    if (!/^failing tests:?$/.test(m[1].trim())) s.add(m[1].trim());
  }
  return [...s];
}

const CIDDIYET = ['yuksek', 'orta', 'dusuk'];
const VARSAYILAN_DENETCI_MODELI = 'sonnet';
const DENETCI_BUTCE_USD = 0.5;

function ciddiyetNormal(c) {
  const t = String(c ?? '').toLowerCase().replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ı/g, 'i').trim();
  if (t.startsWith('yuk') || t === 'high' || t === 'critical') return 'yuksek';
  if (t.startsWith('dus') || t === 'low') return 'dusuk';
  return 'orta';
}

/**
 * Denetci ciktisindaki SON hukum JSON'unu cozer. Bulunamazsa null.
 * Karar modelin yazdigindan degil bulgulardan turetilir.
 */
export function hukumCoz(metin) {
  const t = String(metin ?? '');
  let bas = -1;
  for (const m of t.matchAll(/\{\s*"karar"\s*:/g)) bas = m.index;
  if (bas < 0) return null;

  // Dengeli parantezle JSON'un sonunu bul; dizgi icindeki parantezler sayilmaz.
  let derinlik = 0, dizgi = false, kacis = false, bitis = -1;
  for (let i = bas; i < t.length; i++) {
    const c = t[i];
    if (dizgi) {
      if (kacis) kacis = false;
      else if (c === '\\') kacis = true;
      else if (c === '"') dizgi = false;
      continue;
    }
    if (c === '"') dizgi = true;
    else if (c === '{') derinlik++;
    else if (c === '}') { derinlik--; if (derinlik === 0) { bitis = i; break; } }
  }
  if (bitis < 0) return null;

  let j;
  try { j = JSON.parse(t.slice(bas, bitis + 1)); } catch { return null; }
  const bulgular = (Array.isArray(j.bulgular) ? j.bulgular : [])
    .filter((b) => b && typeof b === 'object')
    .map((b) => ({
      ciddiyet: ciddiyetNormal(b.ciddiyet),
      dosya: String(b.dosya ?? '').trim() || null,
      sorun: String(b.sorun ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
      oneri: String(b.oneri ?? '').replace(/\s+/g, ' ').trim().slice(0, 500) || null,
    }))
    .filter((b) => b.sorun)
    .slice(0, 20);
  // Saha: denetci JSON'a "kaldı" (Turkce ı) yazdi; normalize edilmezse model karari kayboluyordu.
  const kararMetni = String(j.karar ?? '').toLowerCase().replace(/ı/g, 'i').replace(/ç/g, 'c').trim();
  const modelKarari = ['gecti', 'kaldi'].includes(kararMetni) ? kararMetni : null;
  const karar = bulgular.some((b) => b.ciddiyet !== 'dusuk') ? 'kaldi' : 'gecti';
  return { karar, modelKarari, bulgular };
}

const dosyaAnahtari = (d) => String(d ?? '').replace(/\\/g, '/').toLowerCase().split('/').pop();

/**
 * Ilerleme yok: bu turun ciddi bulgularinin dosyalari onceki turda da ciddi
 * bulgu tasiyordu. Model ifadeleri turdan tura degistigi icin metin degil DOSYA
 * karsilastirilir; yanlis durdurma, sonsuz donguden ucuzdur (insan karar verir).
 */
export function ilerlemeYok(onceki = [], simdi = []) {
  const ciddi = (l) => new Set(l.filter((b) => b.ciddiyet !== 'dusuk').map((b) => dosyaAnahtari(b.dosya)));
  const s = ciddi(simdi), o = ciddi(onceki);
  if (!s.size || !o.size) return false;
  for (const d of s) if (!o.has(d)) return false;
  return true;
}

function bulguSatiri(b) {
  return '- [' + b.ciddiyet + '] ' + (b.dosya ? b.dosya + ': ' : '') + b.sorun + (b.oneri ? ' -> ' + b.oneri : '');
}

/** Denetciye giden paket. Rapor iddiadir; kanitlar Suru'nun olcumudur. */
export function denetimGorevi({ is, yapiciKosu, kanit = null, golge = null, oncekiBulgular = [], tur = 1, enFazlaTur = 1 }) {
  const s = [
    'Rolun: DENETCI. Baska bir ajanin yaptigi isi denetliyorsun (tur ' + tur + '/' + enFazlaTur + ').',
    'Hicbir dosyayi degistiremezsin; okur ve hukum verirsin. Duzeltmeyi baska bir ajan yapacak.',
    '',
    '## Yapicinin gorevi',
    String(is.gorev),
    '',
    '## Yapicinin raporu (DOGRULANMAMIS iddia - kanitla karsilastir)',
    String(yapiciKosu.sonuc ?? '(rapor yok)').slice(0, 1500),
    '',
    '## Bagimsiz kanitlar (Suru olctu, ajan degil)',
  ];
  if (is.dogrulama) {
    s.push('- Dogrulama komutu `' + is.dogrulama + '`: '
      + (yapiciKosu.dogrulamaKod == null ? 'kosmadi' : yapiciKosu.dogrulamaKod === 0 ? 'GECTI' : 'GECMEDI (kod ' + yapiciKosu.dogrulamaKod + ')'));
    const n = testSayisiCoz(yapiciKosu.dogrulamaCikti);
    if (n != null) s.push('- Dogrulama ciktisina gore calisan test sayisi: ' + n + ' (raporda farkli bir sayi varsa rapor yanlistir).');
  } else {
    s.push('- Dogrulama komutu tanimli degil: calistirma/test iddialari otomatik olculmedi.');
  }
  if (Array.isArray(is.kapsam) && is.kapsam.length) {
    s.push('- Gorev kapsami (yapicinin degistirebilecegi yollar): ' + is.kapsam.join(', ')
      + '. Kapsam disi degisiklikleri Suru ayrica bulgu yapar.');
  }
  if (kanit) {
    if (kanit.sayac.komut === 0) s.push('- Yapici HIC KOMUT CALISTIRMADI: rapordaki calistirma/test/sayi iddialari olculmemistir.');
    s.push('- Yapicinin adimlari:');
    s.push(kanitMetni(kanit, { enFazla: 25 }));
  } else {
    s.push('- Kanit zinciri yok (transkript bulunamadi).');
  }
  if (golge) {
    s.push('');
    s.push('## Dosya degisiklikleri (golge goruntusu; Bash ile yapilanlar dahil)');
    if (!golge.degisiklik.length) s.push('- Hicbir dosya degismedi.');
    // Kod dosyalari once ve tek tek; aracin urettigi dosyalar (.meta, kilit dosyasi...)
    // uzantiya gore tek satir. Aksi halde 4 000 .meta satiri 60 sinirini doldurup
    // asil kod degisikligini listeden itiyordu.
    const oz = degisiklikOzeti(golge.degisiklik);
    for (const d of oz.kod.slice(0, 60)) s.push('- ' + d.durum + ' ' + d.yol);
    if (oz.kod.length > 60) s.push('- ... ' + (oz.kod.length - 60) + ' kod dosyasi daha');
    if (oz.uretilmisToplam) {
      s.push('- Ayrica ' + oz.uretilmisToplam + ' uretilmis dosya (farka dahil degil): '
        + oz.uretilmis.slice(0, 8).map((u) => u.ek + ': ' + u.n).join(', '));
    }
    if (golge.fark) {
      s.push('');
      s.push(TIK + TIK + TIK + 'diff');
      s.push(golge.fark);
      s.push(TIK + TIK + TIK);
    }
  }
  if (oncekiBulgular.length) {
    s.push('');
    s.push('## Onceki denetimin bulgulari (duzeltilmis olmali)');
    for (const b of oncekiBulgular) s.push(bulguSatiri(b));
  }
  s.push('');
  s.push('## Kurallar');
  s.push('- Gorev tam ve dogru yapildi mi? Rapordaki iddialar kanitla uyusuyor mu?');
  s.push('- Degisen dosyalari Read ile kendin incele; sadece farka guvenme.');
  s.push('- Sadece GERCEK sorun yaz (hata, eksik, yanlis iddia, guvenlik). Stil tercihi yazma.');
  s.push('- Emin olmadigin bulguyu "dusuk" isaretle. "yuksek" ya da "orta" bulgu isi geri cevirir.');
  s.push('');
  s.push('Cevabinin EN SONUNA tek satir JSON yaz, sonrasina hicbir sey ekleme:');
  s.push('{"karar":"gecti|kaldi","bulgular":[{"ciddiyet":"yuksek|orta|dusuk","dosya":"yol","sorun":"...","oneri":"..."}]}');
  return s.join(NL);
}

/** Yeni yapiciya giden ek sistem istemi. */
export function yapiciTalimati(bulgular, tur, enFazlaTur) {
  return [
    'Bu is bir denetim dongusunun ' + tur + '/' + enFazlaTur + '. turu. Onceki calismayi bagimsiz bir denetci inceledi',
    've asagidaki sorunlari buldu. Once bunlari duzelt:',
    ...bulgular.map(bulguSatiri),
    '',
    'Denetci raporuna degil KANITA bakar (calistirilan komutlar, dosya farki, dogrulama komutu).',
    'Iddia ettigin her seyi (test calistirma dahil) gercekten yap; yapmadigin seyi yazma.',
  ].join(NL);
}

/** Yapici isin denetci ic isi: yoksa olusturur, varsa gorevini tazeler. */
export function denetciIsiHazirla(db, yapiciIs, gorev) {
  const ad = DENETCI_ONEK + yapiciIs.id;
  const model = yapiciIs.denetciModel ?? VARSAYILAN_DENETCI_MODELI;
  const r = db.prepare('SELECT id FROM isler WHERE ad = ?').get(ad);
  if (!r) {
    return isEkle(db, { ad, gorev, cwd: yapiciIs.cwd, profil: 'gozlemci', model,
      butceUsd: DENETCI_BUTCE_USD, oncelik: yapiciIs.oncelik ?? 5, ic: true });
  }
  db.prepare('UPDATE isler SET gorev = ?, model = ?, cwd = ?, profil = ?, etkin = 1 WHERE id = ?')
    .run(gorev, model, yapiciIs.cwd, 'gozlemci', r.id);
  return isGetir(db, r.id);
}

export function donguMaliyeti(db, donguId) {
  return Number(db.prepare('SELECT COALESCE(SUM(usd), 0) t FROM kosular WHERE dongu_id = ?').get(donguId)?.t ?? 0);
}

function oncekiHukum(db, donguId, haricId) {
  const r = db.prepare(`SELECT denetim FROM kosular WHERE dongu_id = ? AND rol = ? AND id != ?
    AND denetim IS NOT NULL ORDER BY basladi DESC LIMIT 1`).get(donguId, ROL.DENETCI, haricId);
  try { return r ? JSON.parse(r.denetim) : null; } catch { return null; }
}

function olay(db, kosu, is, data) {
  olayYaz(db, { kind: OLAY.IS, sessionId: kosu.sessionId, project: is?.ad ?? null, data });
}

/** Donguyu durdurur: yapici kosu tek bir denetim kararina duser. */
function tikandi(db, yapiciKosu, yapiciIs, { neden, bulgular = [], tur }) {
  const metin = [
    'Denetim dongusu durdu: ' + neden + '. Tur ' + tur + '/' + (yapiciIs.donguTur ?? '?') + '.',
    bulgular.length ? 'Acik bulgular:' : 'Bulgu listesi yok.',
    ...bulgular.map(bulguSatiri),
  ].join(NL);
  kosuGuncelle(db, yapiciKosu.id, { durum: KOSU_DURUMU.KARAR_BEKLIYOR, terminalNeden: 'denetim-tikandi', hata: metin });
  olay(db, yapiciKosu, yapiciIs, { asama: 'dongu-tikandi', kosuId: yapiciKosu.id, donguId: yapiciKosu.donguId, neden, tur });
  return { asama: 'tikandi', neden, tur };
}

function varsayilanKanit(kosu) {
  try { return kanitZinciri(kosu.sessionId); } catch { return null; }
}

function varsayilanGolge(kosu, is, { golgeKok } = {}) {
  if (!kosu.golgeOnce || !kosu.golgeSonra) return null;
  try {
    return {
      degisiklik: degisenler(is.cwd, kosu.golgeOnce, kosu.golgeSonra, { kok: golgeKok }),
      fark: farkMetni(is.cwd, kosu.golgeOnce, kosu.golgeSonra, { kok: golgeKok, enFazla: 8000, uretilmisHaric: true }),
    };
  } catch { return null; }
}

/**
 * Bir kosu bitince donguyu ilerletir. Kuyrugun 'bitti' olayina baglanir.
 * bag.siraya(isId, ek) kuyruga alir; bag.kanit/bag.golge testte degistirilebilir.
 * Donus: ne oldugunu anlatan nesne ya da (dongu disi kosu icin) null.
 */
export function donguIlerlet(db, bag, { kosuId, isId }, secenekler = {}) {
  const kosu = kosuGetir(db, kosuId);
  const is = isGetir(db, isId);
  if (!kosu || !is) return null;
  if (kosu.rol === ROL.DENETCI) return denetimBitti(db, bag, kosu, secenekler);

  if (!(is.donguTur > 0) || denetciIsiMi(is) || damitmaIsiMi(is)) return null;
  // Karar ya da hata: normal eskalasyon yolu. Insan cevaplayinca devam kosusu
  // dongu kimligini tasir ve bitince denetim yeniden bakar.
  // Dogrulama komutu kaldi: insana gitmeden once dongu yeni tur dener. Saha: yapici
  // testi kendisi kosturamiyor (python/git onaysiz calismaz) ve dogrulama ciktisini
  // gormuyordu; tek satirlik hata icin is insana dusuyordu.
  if (kosu.durum === KOSU_DURUMU.KARAR_BEKLIYOR && kosu.dogrulamaKod != null && kosu.dogrulamaKod !== 0) {
    if (db.prepare('SELECT id FROM kosular WHERE hedef_kosu = ?').get(kosu.id)) return null;
    if (db.prepare('SELECT id FROM kararlar WHERE kosu_id = ?').get(kosu.id)) return null;
    return dogrulamaKaldi(db, bag, kosu, is);
  }
  if (kosu.durum !== KOSU_DURUMU.BITTI) return null;
  const zatenVar = db.prepare('SELECT id FROM kosular WHERE hedef_kosu = ?').get(kosu.id);
  if (zatenVar) return null;

  const donguId = kosu.donguId ?? kosu.id;
  const tur = kosu.tur ?? 1;
  if (!kosu.donguId || kosu.rol !== ROL.YAPICI) kosuGuncelle(db, kosu.id, { donguId, tur, rol: ROL.YAPICI });
  const yapici = kosuGetir(db, kosu.id);

  if (is.donguButceUsd && donguMaliyeti(db, donguId) >= is.donguButceUsd) {
    return tikandi(db, yapici, is, { neden: 'dongu butcesi doldu', tur });
  }

  const onceki = oncekiHukum(db, donguId, '');
  const gorev = denetimGorevi({
    is, yapiciKosu: yapici, tur, enFazlaTur: is.donguTur,
    kanit: (bag.kanit ?? varsayilanKanit)(yapici),
    golge: (bag.golge ?? varsayilanGolge)(yapici, is, secenekler),
    oncekiBulgular: onceki?.bulgular ?? [],
  });
  const denetciIs = denetciIsiHazirla(db, is, gorev);
  const dk = bag.siraya(denetciIs.id, { donguId, tur, rol: ROL.DENETCI, hedefKosu: yapici.id });
  olay(db, yapici, is, { asama: 'denetim-siraya', kosuId: yapici.id, denetciKosuId: dk.id, donguId, tur });
  return { asama: 'denetim-siraya', tur, denetciKosuId: dk.id };
}

/**
 * Dogrulamasi kalan yapici kosu icin yeni tur. Korkuluklar: tur siniri, ayni testler
 * kalmaya devam ediyor (ilerleme yok), butce. Biri devreye girerse kosu karar-bekliyor
 * kalir ve normal DOGRULAMA karari acilir (insan cevabina cikti eklenir).
 */
function dogrulamaKaldi(db, bag, kosu, is) {
  const donguId = kosu.donguId ?? kosu.id;
  const tur = kosu.tur ?? 1;
  if (!kosu.donguId || kosu.rol !== ROL.YAPICI) kosuGuncelle(db, kosu.id, { donguId, tur, rol: ROL.YAPICI });
  const kalan = kalanTestler(kosu.dogrulamaCikti);

  if (tur >= (is.donguTur ?? 1)) return { asama: 'dogrulama-insana', neden: 'tur siniri', tur, kalan };
  const onceki = db.prepare(`SELECT dogrulama_cikti FROM kosular WHERE dongu_id = ? AND rol = ? AND id != ?
    AND dogrulama_kod IS NOT NULL AND dogrulama_kod != 0 ORDER BY basladi DESC LIMIT 1`).get(donguId, ROL.YAPICI, kosu.id);
  if (onceki) {
    const o = kalanTestler(onceki.dogrulama_cikti);
    if (kalan.length && o.length && kalan.every((x) => o.includes(x))) {
      return { asama: 'dogrulama-insana', neden: 'ilerleme yok (ayni testler kaliyor)', tur, kalan };
    }
  }
  if (is.donguButceUsd && donguMaliyeti(db, donguId) >= is.donguButceUsd) {
    return { asama: 'dogrulama-insana', neden: 'dongu butcesi doldu', tur, kalan };
  }

  // Bu kosunun yerine yeni tur gelir: karar acilmasin, kosu basarisiz sayilsin.
  kosuGuncelle(db, kosu.id, { durum: KOSU_DURUMU.HATA, terminalNeden: 'dogrulama-kaldi-dongu' });
  const talimat = [
    'Bu is bir dongunun ' + (tur + 1) + '/' + is.donguTur + '. turu. Onceki calisma dogrulama komutundan GECMEDI:',
    TIK + is.dogrulama + TIK + (kalan.length ? ' - kalan testler: ' + kalan.slice(0, 10).join(', ') : ''),
    'Dogrulama ciktisinin sonu:',
    TIK + TIK + TIK,
    String(kosu.dogrulamaCikti ?? '').slice(-2500),
    TIK + TIK + TIK,
    'Onceki calismanin dosyalari projede duruyor; bastan yazma, kalan sorunu bul ve duzelt.',
    'Testleri kendin calistiramayabilirsin; kodu okuyarak nedenini bul. Duzelttigini iddia ettigin her seyi gerekcelendir.',
  ].join(NL);
  const yeni = bag.siraya(is.id, { donguId, tur: tur + 1, rol: ROL.YAPICI, hedefKosu: kosu.id, ekTalimat: talimat });
  olay(db, kosu, is, { asama: 'dongu-dogrulama-yeni-tur', kosuId: yeni.id, donguId, tur: tur + 1, kalan: kalan.length });
  return { asama: 'dogrulama-yeni-tur', tur: tur + 1, yapiciKosuId: yeni.id, kalan };
}

function denetimBitti(db, bag, denetciKosu, secenekler) {
  const yapici = kosuGetir(db, denetciKosu.hedefKosu);
  const yapiciIs = yapici ? isGetir(db, yapici.isId) : null;
  if (!yapici || !yapiciIs) return { asama: 'yetim-denetim' };
  const tur = denetciKosu.tur ?? yapici.tur ?? 1;
  const donguId = denetciKosu.donguId;

  if (denetciKosu.durum !== KOSU_DURUMU.BITTI) {
    return tikandi(db, yapici, yapiciIs, { neden: 'denetci kosusu basarisiz: ' + String(denetciKosu.hata ?? denetciKosu.durum).slice(0, 200), tur });
  }
  const h = hukumCoz(denetciKosu.sonuc);
  if (!h) return tikandi(db, yapici, yapiciIs, { neden: 'denetci gecerli hukum yazmadi', tur });
  // Kapsam denetimi deterministik: gorev disinda degisen dosya, denetci ne derse desin bulgudur.
  // Saha: LiveDub yapicisi testleri calistiramayinca projeye run_tests.py, verify_tests.py,
  // check_imports.py ve bir rapor dosyasi birakti; denetci farkta gordu ama bulgu yazmadi.
  const degisiklik = (bag.donguDegisikligi
    ? bag.donguDegisikligi(yapici, yapiciIs)
    : varsayilanDonguDegisikligi(db, yapici, yapiciIs, secenekler)) ?? [];
  for (const yol of kapsamDisi(yapiciIs, degisiklik)) {
    h.bulgular.push({ ciddiyet: 'orta', dosya: yol, kaynak: 'suru',
      sorun: 'gorev kapsami disinda degisti ya da olusturuldu (Suru kapsam denetimi)',
      oneri: 'gorev icin gerekli degilse sil ya da geri al' });
  }
  if (h.bulgular.some((b) => b.ciddiyet !== 'dusuk')) h.karar = 'kaldi';
  kosuGuncelle(db, denetciKosu.id, { denetim: JSON.stringify(h) });

  if (h.karar === 'gecti') {
    olay(db, yapici, yapiciIs, { asama: 'dongu-gecti', kosuId: yapici.id, donguId, tur,
      bulgu: h.bulgular.length, modelKarari: h.modelKarari });
    return { asama: 'gecti', tur, bulgular: h.bulgular };
  }

  // Yapisal engel: ciddi bulgu, gorevin istedigi ama yazma izni kapali (kapsam disi) bir
  // dosyadaysa yeni yapici hicbir sey yapamaz. Saha (kampanya 6): 2. tur bosuna kosup ~$0.18
  // harcadi. Dogrudan insana: kapsami genislet ya da gorevi daralt.
  const celisen = gorevKapsamCelismesi(yapiciIs.gorev, yapiciIs.kapsam);
  if (celisen.length) {
    const ad = (y) => String(y ?? '').split(String.fromCharCode(92)).join('/').toLowerCase().split('/').pop();
    const celisenAdlar = new Set(celisen.map(ad));
    const engelli = h.bulgular.filter((b) => b.ciddiyet !== 'dusuk' && b.dosya && celisenAdlar.has(ad(b.dosya)));
    if (engelli.length) {
      return tikandi(db, yapici, yapiciIs, { tur, bulgular: h.bulgular,
        neden: 'kapsam celiskisi: gorev yazmasi yasak dosyayi gerektiriyor (' + [...new Set(engelli.map((b) => b.dosya))].join(', ')
          + ') - kapsami genislet ya da gorevi daralt' });
    }
  }

  const onceki = oncekiHukum(db, donguId, denetciKosu.id);
  if (tur >= (yapiciIs.donguTur ?? 1)) return tikandi(db, yapici, yapiciIs, { neden: 'tur siniri', bulgular: h.bulgular, tur });
  if (onceki && ilerlemeYok(onceki.bulgular, h.bulgular)) {
    return tikandi(db, yapici, yapiciIs, { neden: 'ilerleme yok (ayni dosyalarda sorun suruyor)', bulgular: h.bulgular, tur });
  }
  if (yapiciIs.donguButceUsd && donguMaliyeti(db, donguId) >= yapiciIs.donguButceUsd) {
    return tikandi(db, yapici, yapiciIs, { neden: 'dongu butcesi doldu', bulgular: h.bulgular, tur });
  }

  const yeni = bag.siraya(yapiciIs.id, { donguId, tur: tur + 1, rol: ROL.YAPICI,
    ekTalimat: yapiciTalimati(h.bulgular, tur + 1, yapiciIs.donguTur) });
  olay(db, yapici, yapiciIs, { asama: 'dongu-yeni-tur', kosuId: yeni.id, donguId, tur: tur + 1, bulgu: h.bulgular.length });
  return { asama: 'yeni-tur', tur: tur + 1, yapiciKosuId: yeni.id, bulgular: h.bulgular };
}

/** Isin son dongusu: turlar ve hukumler (panel icin). */
export function donguDurumu(db, isId) {
  const son = db.prepare(`SELECT dongu_id FROM kosular WHERE is_id = ? AND dongu_id IS NOT NULL
    ORDER BY basladi DESC LIMIT 1`).get(isId);
  if (!son) return { donguId: null, turlar: [], toplamUsd: 0, sonHukum: null };
  const satirlar = db.prepare('SELECT id FROM kosular WHERE dongu_id = ? ORDER BY basladi, rowid').all(son.dongu_id)
    .map((r) => kosuGetir(db, r.id));
  const turlar = satirlar.map((k) => {
    let hukum = null;
    try { hukum = k.denetim ? JSON.parse(k.denetim) : null; } catch { /* bozuk */ }
    return { kosuId: k.id, rol: k.rol, tur: k.tur, durum: k.durum, usd: k.usd ?? 0,
      terminalNeden: k.terminalNeden, degisenDosya: k.degisenDosya, hukum };
  });
  const hukumlu = turlar.filter((t) => t.hukum);
  return {
    donguId: son.dongu_id,
    turlar,
    toplamUsd: turlar.reduce((a, t) => a + (t.usd || 0), 0),
    sonHukum: hukumlu.length ? hukumlu[hukumlu.length - 1].hukum : null,
  };
}
