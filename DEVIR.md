# Sürü — Devir notu (yeni Claude Code ajanı için)

Bu dosyayı baştan sona oku, sonra `README.md`'nin ilgili bölümlerine bak. README uzun
(~1400 satır) ama her kararın *neden*'i ve ölçüm sonuçları orada. Bu not onun haritası.

## 1. Proje nedir

**Sürü**: Hasan'ın kişisel, yarı-özerk **Claude Code ajan yönetim platformu**.
Klasör: `C:\Users\hasan\Desktop\AI projects\Suru\`

- Amaç: Max 20x planıyla tüm projelerini (oyun, SaaS, yazılım — **çok büyük projeler dahil**)
  ajanlara yaptırmak. Ajanlar kendi kararını verir; kullanıcıya sadece kritik/mimari kararlar gelir.
- Masaüstü öncelikli; telefon izleme için (ntfy bildirimleri).
- **Motor sadece Claude Code CLI** (headless `claude -p --output-format stream-json --verbose`).
  Başka LLM sağlayıcısı YOK — bu kesin kısıt.

## 2. Kullanıcı ile çalışma kuralları (önemli)

- Türkçe, samimi konuş ("kanka"). Kullanıcı kodu okumaz; sonuçları sade anlat.
- Döngü: **düzelt → test et → kontrol et (canlı dene) → değerlendir.** "Testler geçti" yetmez;
  gerçek koşuyla/tarayıcıyla doğrula.
- **Commit atma** ("commit işlerini boşver"). Git sadece ölçüm/izolasyon için kullanılıyor.
- İlke: "Sistemi kuran ajan kendi yaptığını test etmez, test eden düzenlemez" (yapıcı/denetçi ayrımı).
- Her ajan sıfır bağlamla başlar ama hafıza iyi olmalı; token kullanımı minimum.
- **Varsayma, ölç.** Bu projede birçok "bariz" varsayım ölçümle çürüdü (aşağıda). Bir sayıyı
  savunmadan önce ölçüm aletinin sağlam olduğunu göster.
- Kullanıcının asıl projelerine dokunma. Deneyler kopyada ya da scratchpad'de yapılır.
  **KorkuOyunu kopyası SİLİNDİ** (disk yeri kalmadı) — artık orada deneme yapılmaz. Deneme için yeni bir
  proje kullanıcıyla birlikte seçilecek; seçilene kadar sor, kendin bir projeyi kopyalayıp GB'larca yazma.
- Hafıza notu: `C:\Users\hasan\.claude\projects\C--Users-hasan-Desktop-AI-projects\memory\suru-projesi.md`
  (proje bulguları burada birikmiş; oku).

## 3. Teknoloji

- Node.js 24 ESM, **sıfır zorunlu bağımlılık**: `node:sqlite` (WAL), `node:http`, `node:test`,
  `node:child_process`, SSE. Frontend vanilla HTML/CSS/JS (ES5 tarzı), canvas. Opsiyonel: node-pty.
- Veritabanı `~/.claude/suru/suru.db`, şema göçleri `PRAGMA user_version` — **şu an 18**.
- Kaynak dosyalar CRLF satır sonu kullanıyor olabilir; yamalarda buna dikkat et.
- Komutlar: `npm run panel` (sunucu, port 7777), `npm test` (**336 test geçiyor** — `node --test test/`
  Windows'ta glob tuzağına düşer, `npm test` kullan), `npm run sinav` (9 senaryolu canlı sınav),
  `npm run kota`.
- Panel: `http://localhost:7777/?t=<jeton>`, ofis: `/ofis`. Jeton: `~/.claude/suru/token`.
- Sunucu `panel.html`/`ofis.html`'i açılışta belleğe alır → HTML değişince **sunucuyu yeniden başlat**.

## 4. Mimari (src/)

**Çekirdek akış:** iş (`isler`) → kuyruk (`kuyruk.js`, eş zamanlılık + kota) → koşucu (`kosucu.js`,
claude alt süreci) → olaylar/kararlar → panel/ofis/bildirim.

| Dosya | Görev |
|---|---|
| `server.js` | HTTP + SSE, tüm uçlar, periyodik tikler (zamanlama 30 sn, git tetik 30 sn), `/durum` oturum yükü (`kucult`) |
| `db.js` | şema göçleri (18) |
| `isler.js` | iş ve koşu kayıtları (`isEkle`, `kosuAc`, `kosuGuncelle`, alan eşlemeleri `ALAN`) |
| `kuyruk.js` | kuyruk, eş zamanlılık, `siraya(isId, ek)`, durdurma |
| `kosucu.js` | `kosuBaslat`: yetki ayar dosyası, hafıza brifi, gölge, worktree, akış ayrıştırma, maliyet tahmini, doğrulama, defter, gözlenen model (`enCokKullanilanModel`) |
| `yetki.js` | profiller: gozlemci (dontAsk+restricted), serbest (acceptEdits), denetimli, danisan (plan) |
| `eskalasyon.js` | karar kartları (izin, denetim, doğrulama, kapsam genişlet) |
| `dongu.js` | yapıcı/denetçi döngüsü, deterministik hüküm, `denetimGorevi` (denetçi paketi), kapsam çelişkisi |
| `kanit.js` | transkriptten kanıt zinciri, sır taraması |
| `golge.js` | gölge checkpoint (ayrı git dizini, projeye dokunmaz), geri alma, `URETILMIS` desenleri, ilk görüntü disk kontrolü |
| `worktree.js` | worktree izolasyonu (sonuç kendi dalında, otomatik merge yok) |
| `gittetik.js` | git tetikleyici (`origin/main` = push, `HEAD` = commit; ağa çıkmaz) |
| `zamanlama.js` | cron tetikleyici |
| `hafiza.js`, `damitma.js` | Sürü hafızası (brif = dosya yolları + görev konusu), otomatik damıtma |
| `gizlilik.js`, `veriakisi.js` | gizli yollar → izin yasakları, veri akışı defteri |
| `karne.js` | karne, `isModelOnerisi` (iş başına model karşılaştırması) |
| `kota.js`, `kota-cli.js` | kota beyni (5 saatlik/haftalık USD tavanı → eş zamanlılık) |
| `bildirim.js`, `kanallar.js` | bildirim kararı + kanallar (günlük / ntfy / webhook) |
| `sinav.js` + `sinav/` | sonucu bilinen 9 senaryo, gizli kabul testleri |
| `paths.js` | tüm yollar. `AJAN_DIZINI` = `%LOCALAPPDATA%\suru` (ajanın içinde çalıştığı klasörler) |
| `panel.html` | panel (Oturumlar/Kararlar/İşler/Ofis/Maliyet + "Seni bekleyenler" şeridi) |
| `ofis.html` | piksel ofis: odalar = projeler, ajan yürüyor; hareket = durum geçişi |

## 5. Ölçülmüş gerçekler (bunları yeniden keşfetme)

- `acceptEdits` dosya komutlarına izin verir ama `python`/`git` çalıştırmaz. Read yasağı Bash okumasına,
  Edit/Write yasağı `echo >>`'ye de uygulanır. Bash desen yasakları atlatılabilir → "kaza önleyici, güvenlik değil".
  Bozuk ayar dosyası tüm yasakları sessizce kaldırır → kanarya kontrolü var.
- **Ajan `~/.claude` altındaki klasörde dosya düzenleyemez** (Claude Code kendi klasörünü koruyor).
  Ajanın çalışacağı her klasör `AJAN_DIZINI` altında olmalı.
- Başarılı `git push` yerel `refs/remotes/origin/<dal>`'ı da günceller → push tetiği ağsız çalışır.
- **Hafıza token tasarrufu sağlamıyor** (3 ölçüm seti, fark gürültü içinde). Süreklilik özelliği olarak savun.
- Denetçi paketi küçük projede sorun değil (ortanca 4.5 KB). Haiku denetçi sınavı 9/9 geçiyor, 2.6 kat ucuz;
  varsayılan sonnet (kanıt ince).
- Otomatik model seçimi için veri yoktu; koşuya model artık yazılıyor (`kosular.model`, göç 16).
- Sürü'nün koşturduğu her iş bir Claude Code oturumu açar ve `/durum` listesine düşer; `u` alanı = iş kimliği
  (111 oturumun 75'i Sürü koşusuydu). Ofis bunları ikinci kez saymıyor.
- Sınav temizliği kararları önekle filtreleyip komşu senaryoyu iptal ediyordu (düzeltildi). Sınavda `ozellik`
  senaryosu haiku varyansıyla ara sıra kalır; tek başına tekrar koşunca geçer.
- **Büyük proje (KorkuOyunu kopyası, 14 GB, commit 16 764 dosya — kopya artık silindi, sayılar geçerli):** gölge ilk görüntü 392 sn / 11.1 GB disk,
  sonrakiler 0.5 sn; keşif 243k token / $0.12 (küçük projeyle aynı mertebe, ölçeklenmiyor); denetçi farkı
  14 commit'in 11'inde kırpılıyordu (ortanca ~694 KB, commit başına ~4 200 dosya).
  **Düzeltildi:** üretilmiş dosyalar farktan çıktı; worktree `core.longPaths` + kısa ad + LFS atlama ile
  21 sn'de açılıyor; gölge ilk görüntüden önce disk kontrolü (5 GB alt sınır).
- C: diski dar (~17 GB boş). Büyük projede ilk gölge disk kontrolüne takılabilir — beklenen davranış.

## 6. Güncel durum

- 336 test geçiyor. Sınav son tam koşu 8/9 (kalan `ozellik`, varyans; tek başına geçti).
- ntfy telefona bağlı ve uçtan uca doğrulandı (konu `ayarlar.json > bildirim.ntfy.konu`, içerik `az`).
- Panel ve ofis yeni tasarımla çalışıyor ama **canlı ajanlarla** (yürüme, yöneticiye gitme, kuyruk bankı,
  şerit) hiç izlenmedi — o sırada kota beyni eş zamanlılığı 0'a çekmişti.

## 6b. 2026-09-17 devri (ikinci ajan)

- **Deneme projesi seçildi: `Documents\GitHub\ogrenme`** (Unity, 902 izlenen dosya, 37 commit, gitignore+LFS).
  Kopyası `%LOCALAPPDATA%\suru\deneme\ogrenme` (git clone, LFS atlandı, 4.9 MB). Asıl klasöre dokunulmadı.
- **Kullanıcının yeni yönü:** motor kalıyor, üstü yeniden yapılıyor — komuta merkezi (canlı ajan sütunları,
  ses, komut satırı), telefondan talimat, otomatik bağlam yönetimi, disiplinli hafıza. Kullanıcı "baştan ele
  alabilirsin" dedi; karar: motor (gölge/yetki/denetçi/kanıt/kuyruk) korunur, yüz yeniden yazılır.
- **Fork ölçüldü, kazandırmıyor** (README "Bağlam: temel oturum + fork"). Maliyet özelliği olarak kurulmadı.
- **Telegram komut kanalı YAZILDI ve CANLI DOĞRULANDI** (`src/komut.js`, `src/telegram.js`, panel komut
  çubuğu, 352 test). Bot eşleşmiş durumda; karar kartları ntfy'ye ek olarak Telegram'a düğmeli gidiyor
  (`kararlarTelegramaDa`). Canlı denemede 4 hata bulundu/düzeltildi (README "Telegram canlı doğrulama"):
  bütçe kartı, plan profilinde kart türü, `planUygula` (danisan→denetimli), kanalların bağımsız denenmesi.
- ogrenme kopyasında `SpectatorCamera.cs` +14 satır değişik duruyor (deneme işi, commit yok). Bilinen iki
  kusuru var (erken return → tek kişide yazı görünmez; OnGUI'de her kare GUIStyle) — denetçi döngüsü
  denemesi için iyi malzeme.
- Ölçüm koşuları (`ogrenme · m0-m1-temel` oturumları) panelde oturum olarak görünüyor — normal.

- **Komuta merkezi YAZILDI ve canlı izlendi** (`/komuta`, `src/komuta.html`, `komuta.js`, `anlati.js`; 361 test).
  Yapıcı/denetçi döngüsü ogrenme kopyasında gerçek işle koştu (haiku yapıcı + sonnet denetçi, "geçti", $0.20)
  — DEVIR eski 1. ve 2. maddeler (uçtan uca gerçek iş + canlı izleme) böylece yapıldı; ofisin kendisi
  (yürüme/bank) hâlâ ayrıca izlenmedi. Ses efektleri yazıldı ama **kulakla dinlenmedi** (kullanıcı denesin).

## 7. Sıradaki işler (önerilen sıra)

0. ~~MCP bağlayıcı sızıntısı~~ **KAPATILDI** (60 MCP aracı sızıyordu, unity-mcp dahil; `--strict-mcp-config`
   + kanarya; README "MCP sızıntısı"). Unity işlerine bilerek MCP vermek için iş başına `mcp` alanı henüz yok.
   ~~4. adım hafıza disiplini~~ **YAPILDI** (konu ile ezme, başarı eski hatayı siler, budama; 212→96 kayıt;
   README "Hafıza disiplini"; şema **19**, **371 test**). Kalan kir: sınavın geçici klasörlerde bıraktığı
   İŞ kayıtları ve klasörler — `sinav.js` bitince kendi işlerini/klasörlerini silmeli.
   Eski plan notu: 4. adım **hafıza disiplini** (aynı konuda yeni olgu eskisini ezer, parmak izi değişince
   şüpheli→sil, proje başına üst sınır). Sonra komuta merkezine: sesli okuma (Web Speech), koşan ajana
   ara talimat, proje başına "temel oturum → fork komutu".
1. **Uçtan uca gerçek iş ogrenme kopyasında.** Küçük, zararsız, gerçek
   bir kod görevi: worktree + denetim döngüsü (donguTur ≥ 1) + doğrulama. Yeni denetçi farkının gerçek bir
   değişiklikte işe yarayıp yaramadığını gör. Doğrulama komutu için Unity testleri makinede koşmaz — C#
   derleme/`dotnet` yok; doğrulama olarak `git diff --stat` / dosya varlığı gibi deterministik kontrol seç.
2. **Ofisi canlı izle.** 1. madde koşarken `/ofis`'i açık tut; yürüme/yönetici/bank/baloncuk davranışlarını
   gerçek veride doğrula, hataları düzelt.
3. **Model yönlendirmesine veri.** 1–2 işi haiku ve sonnet'te birkaç kez koş; `isModelOnerisi` gerçek öneri üretsin.
4. Küçükler:
   - Kota tavanı: `npm run kota` 650 yerine 300 öneriyor → **kullanıcının kararı**, sormadan değiştirme.
   - Telefondan panel erişimi (Tailscale) kurulu değil.
   - Ofis sunucu kapalıyken 4 sn'de bir istek atıyor → geri çekilme (backoff) ekle.
   - Worktree LFS işaretçi dosyalarıyla açılıyor: Unity varlıklarına dokunan işlerde yetmez, belgele/çöz.
   - `.gitignore`'u olmayan projede gölge her şeyi alıyor; büyük ikili varlıklar için hariç tutma düşünülebilir.

## 8. Tuzaklar

- Heredoc/`node -e` içinde Türkçe kesme işareti (`worktree'sinde`) kırılıyor → uzun yamalarda dosyaya betik
  yaz (Write) ve çalıştır, ya da Edit aracı kullan. Bu hata paneli bir kez komple boşalttı
  (`test/panel.test.js` artık panel ve ofis JS'ini ayrıştırıyor).
- Windows: süreç öldürme `taskkill /T /F`; git yolları ileri eğik çizgi döner; `\\.\nul` açılamaz.
- Sunucuyu durdurmak için port üzerinden PID bul (`Get-NetTCPConnection -LocalPort 7777`), tüm node'ları öldürme.
- Canlı ajan koşuları gerçek kullanım harcar ve kota beynini etkiler; ölçümlerde bütçe sınırı koy.

## 9. Son durum eki (2026-09-18)

- Ara talimat kuruldu ve canlı doğrulandı (README "Temizlik + ara talimat"). Fork düğmesi ve sesli okuma **bitti**.
- Test tuzağı: sahte koşuculu kuyruk testinde `kuyruk.bekle()` öncesi TÜM kollar bitirilmeli; geç başlayan
  koşu testi sonsuza dek asar (tam `npm test` sessizce zaman aşımına uğrar). `--test-timeout` ile teşhis et.

## 10. İkinci tur (2026-09-18, üçüncü ajan) — YAPILACAKLAR.md uygulandı

README "Yapılacaklar listesi uygulandı" bölümü tam liste. Kısaca: iş başına MCP (okur/tam, `mcp.js`, şema 20),
Telegram `/akis /ozet /notlar /unut /rapor /sablonlar /oneriler`, onaylı `/sil` `/durdur`, isteğe bağlı bitti bildirimi,
komuta: sığmayanlar şeridi + sabitleme, geri al düğmesi, mikrofon, PWA, ajan başına TTS; ofis geri çekilme + masa tıklaması;
iş şablonları, sonraki adım önerisi (Aç/Geç), maliyet tahmini, otomatik bağlam yönetimi (kapalı, eşik ölçülmedi).
Testler 399 (394 iken tam paket 5 kez geçti). Canlı: izin reddi + canlı talimat + İZİN kartı, Dallan (localhost ve LAN), geri al.

Kota tavanı kullanıcı kararıyla 300 yapıldı. Kullanıcıya açık kalanlar: `livedub-gender-ayarlanabilir` silinsin mi, sesler nasıl,
Unity MCP canlı denemesi (Unity'de ogrenme KOPYASI açıkken gözlemci profil + `mcp: unity-mcp` işi; ilk koşuda
`init.tools`'a bakıp `ayarlar.json > mcp.okur` kataloğunu düzelt), mikrofon isabeti (20 cümle), bağlam eşiği (uzun koşu görülünce).
Yeni tuzak: canlı talimat `result`'a çok yakın gidince CLI ikinci init+result üretiyor; maliyet `max` ile tek sayılıyor.
