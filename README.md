# iddaa 13 Kuralı – Canlı Basketbol Barem Uyarısı

iddaa.com'da canlı basketbol maçlarının "Toplam Sayı Alt/Üst" baremini takip eden Tampermonkey script'i.
Canlı en üst/en alt barem, maç öncesi en üst/en alt baremden **FARK** kadar (varsayılan 15) saparsa Telegram'a uyarı gönderir
ve "Ters" stratejiyle sanal bahis kaydı tutar.

## Kurulum

1. Chrome'a **Tampermonkey** uzantısını kurun, uzantı ayrıntılarından **"Kullanıcı scriptlerine izin ver"** seçeneğini açın.
2. Şu adresi açın, Tampermonkey kurulum ekranı gelir, **Yükle**'ye basın:
   https://raw.githubusercontent.com/barisakpunar/iddaa-13-kurali/main/iddaa-13-kurali.user.js
3. iddaa.com'u açın. Sağ altta turuncu panel çıkar.
4. Paneldeki **Telegram** düğmesinden kendi bot token'ınızı ve chat ID'nizi girin, **Test mesajı** ile deneyin.
   (Token bu tarayıcıda saklanır, kodda veya bu depoda yer almaz.)

## Otomatik güncelleme

Script bu depodan güncellenir. Kodda değişiklik yapıldığında `@version` numarası artırılır;
Tampermonkey bunu fark edip script'i kendiliğinden günceller. Kayıtlı veriler ve Telegram ayarları korunur.

## Uzaktan yönetim (kontrol.json)

Script, bu depodaki `kontrol.json` dosyasını birkaç dakikada bir **okur** (hiçbir veri göndermez):

| Alan | Anlamı |
|---|---|
| `aktif` | `false` yapılırsa uyarılar ve sanal bahis durur; `true` yapılınca devam eder |
| `fark` | Sayı yazılırsa eşik bu olur ve paneldeki kutu kilitlenir; `null` ise herkes kendi eşiğini kullanır |
| `tutar` | Sanal bahis tutarı (TL); `null` ise 1000 |
| `mesaj` | Değiştirildiğinde bir kez Telegram'a "Yönetici notu" olarak gider |

Panelde "Uzaktan yönetim: aktif / DURDURULDU" satırı her zaman görünür.
