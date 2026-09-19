# Sürü — Yapılacaklar

Son güncelleme: 2026-09-18 (ikinci tur). Durum: testler 399/399 (394 iken tam paket 5 kez üst üste), şema 20, commit atılmadı
(kullanıcı kuralı). Yeni gelen bu dosyayı DEVIR.md ve README.md ("Yapılacaklar listesi uygulandı") ile birlikte okur.
Her madde şu kalıpta: **ne**, **neden**, **nasıl**, **nasıl doğrulanır**, **maliyet/risk**, **kullanıcıdan gereken**.

---

## 0. Değişmez kurallar (her maddede geçerli)

- Türkçe konuş, samimi ("kanka"). Kullanıcı kod okumaz; sonucu sade anlat.
- Commit atma. Asıl projelere onaysız dokunma; deneme yeri `%LOCALAPPDATA%\suru\deneme\ogrenme` (kopya).
- Varsayma, ölç ve canlı dene. Her özellik: birim test → sahte claude (`test/sahte/claude-taklit.mjs`) →
  kopya projede gerçek koşu → README'ye ölçüm satırı.
- Disk çok dolu: GB yazacak iş öncesi sor. Kota tavanı kullanıcının kararı, sormadan değiştirme.
- Sırlar: Telegram token'ı `~/.claude/suru/ayarlar.json > telegram.token`; koda/sohbete/ekrana yazılmaz.
- Sunucuyu koşu çalışırken yeniden başlatma (koşuyu öldürür). Önce `/durum` ile "0 calisiyor" gör.
  `komuta.html`, `panel.html`, `ofis.html` açılışta belleğe alınır; sayfa değişikliği için yeniden başlat gerekir.
  Sunucuyu tarayıcı aracıyla başlatmak için kök klasörde `.claude/launch.json` var (`suru-panel`).
- Araç tuzakları: uzun yamaları şablon dizgiyle, `node -e` ile ya da bash heredoc ile yazma (regex ters
  eğik çizgisi, `$'`, Türkçe kesme işareti, uzun metin kırılıyor) → Edit/Write aracı ya da Python betiği.
  Tam `npm test` asılırsa `--test-timeout` ile asılan testi bul.

---

## 1. Açık kullanıcı kararları (bekliyor)

### 1.1 Unity MCP canlı denemesi
- **Ne:** İş başına MCP KURULDU (salt-okur varsayılan, tam yetki iş başına; README). Canlı denenmedi.
- **Nasıl:** Unity Editor'de ogrenme KOPYASI açıkken panelden iş: profil gözlemci, `MCP: unity-mcp`, mod okur,
  görev "konsol loglarını oku ve özetle". İlk koşuda `init.tools` listesine bak (kanıt ucu ya da komuta satırları):
  katalogdaki adlar (`ayarlar.json > mcp.okur["unity-mcp"]`) tahmindir; gerçek adlarla düzelt.
- **Doğrulama:** koşu `mcp-sizdi` ile KESİLMEMELİ; ajan en az bir `mcp__unity-mcp__` aracını başarıyla çağırmalı;
  yazan bir araç denerse izin reddi almalı. Maliyet ~$0.10.
- **Kullanıcıdan gereken:** Unity'yi kopya projeyle açması.

### 1.2 Kota tavanı — YAPILDI
- Kullanıcı kararıyla 5 saatlik tavan 650 → **300** (2026-09-18). Haftalık 4450 aynı kaldı.

### 1.3 Kalan eski iş
- `livedub-gender-ayarlanabilir` [28d350] asıl LiveDub klasörüne bağlı, silinmedi. Telegram'dan `/sil 28d350`
  artık onay düğmesiyle soruyor.

### 1.4 Ses, konuşma ve mikrofon geri bildirimi
- Sesler (`komuta.html > SESLER`), okunan cümleler (`konusMetni`), ajan başına hız/perde ve ASCII→Türkçe sözlük
  (`TR_SOZLUK`) kulakla dinlenmedi. Mikrofon (🎤) niyetleri ve Türkçe tanıma isabeti ölçülmedi: 20 cümlelik liste
  ile dene, isabet oranını README'ye yaz.

### 1.5 Telegram bitti bildirimi ve öneriler
- `telegram.bittiBildir` kapalı doğdu; kullanıcı isterse `true`. Sonraki adım önerileri (`oneri.etkin`) açık:
  gürültü yaparsa kapat ya da yalnız belirli profillerde üret.

---

## 2. Ölçülmemiş / eksik doğrulamalar

### 2.1 Otomatik bağlam eşiği
- Kod hazır (`baglam.esikToken`, kapalı). `node arac/olcum/token-egrisi.mjs` mevcut koşularda tepe girdi 64k
  gösteriyor. Gerçekten uzun bir iş (30+ tur) koşturup eğriyi kaydet; tepe 150k'ya yaklaşıyorsa eşiği tepenin biraz
  altına koy, 3 koşuda "özet → yeni oturum" zincirinin iş kalitesini düşürüp düşürmediğini denetçi döngüsüyle ölç.

### 2.2 Masaya sığmayanlar 5+ eş zamanlı işte
- 5 koşu (2 çip) ile denendi: çip tıklaması masaya oturtup sabitledi; ofis tıklaması masaya odakladı. Gerçek 5+ eş
  zamanlı (eş zamanlılık 3 iken 2 kuyrukta) senaryosu izlenmedi; masa sırası karışırsa `masalariSec` sabit kuralına bak.

### 2.3 Telegram tarafı canlı
- Onay düğmeleri, `/akis`, `/ozet`, `/rapor`, öneri Aç/Geç mesajı gerçek telefonda görülmedi (testler sahte API ile).
  Telefondan `/sil 28d350` yazıp "Vazgeç"e basmak yeter.

### 2.4 Panel şablonlu iş formu
- Uçlar test edildi (`/is/ekle` + `sablon`), formdan gerçek gönderim tarayıcıda yapılmadı.

---

## 3. Sıradaki geliştirmeler (öncelik sırasıyla)

### 3.1 Model yönlendirme kararı
- `/rapor` tablosu hazır ama veri az (ogrenme: haiku 2/2 $0.09, sonnet 2/2 $0.12). Aynı işi haiku ve sonnet'te
  5'er kez koştur, `isModelOnerisi` gerçek öneri üretsin; sonra formda "önerilen model" rozeti.

### 3.2 Denetçi çeşitliliği (fark-only denetçi)
- Denetçiye sadece diff + test çıktısı ver, kod okuma verme → daha ucuz, daha tarafsız. `dongu.js > denetimGorevi`
  içinde paket zaten var; "kod okuma yok" = gözlemci profilde `--tools` daraltması. Ölç: 10 işte yakalama oranı
  (SpectatorCamera'daki iki bilinen kusur iyi malzeme).

### 3.3 Web Push (PWA)
- Şu an PWA kurulabilir ve sayfa açıkken bildirim veriyor; sunucu itmeli push yok. Gerekirse `node:crypto` ile VAPID
  (ES256) + aes128gcm; bağımlılıksız yapılabilir ama ~150 satır ve dış erişim (Tailscale) ister. Telegram varken düşük öncelik.

### 3.4 Çoklu makine
- İhtiyaç yok; sunucu adı ön eki ve ayrı `telegram.sohbet` anahtarı gerekecek.

---

## 4. Bilinen kirler ve küçük işler

- `The_ice_is_watching` remote URL'sinde GitHub token'ı var; kullanıcı "önemli değil" dedi, dokunma.
- ntfy konu adı sohbette geçti; kullanıcı uyarıldı. İsterse `ayarlar.json`'da değiştirir.
- `komuta.html` içindeki değişkenler IIFE içinde (global değil); tarayıcıdan test ederken düğmeler ve `postMessage` ile git.
- Canlı talimat `result`'a çok yakın gidince CLI ikinci init+result üretiyor: akışta "oturum açıldı" iki kez görünür,
  maliyet tek sayılır. İstenirse ikinci `basladi` olayı bastırılabilir.
- Deneme koşuları (`ogrenme-izin-reddi-talimat`, `Klasordeki README…`, `Assets klasorundeki…`, `kod-incelemesi`)
  iş listesinde duruyor; `/sil` ile temizlenebilir. Damıtma bir kez tetiklendi (5 rapor eşiği).
