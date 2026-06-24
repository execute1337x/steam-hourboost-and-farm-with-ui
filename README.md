# Steam Farmer Panel

Steam hesaplarında saat ve kart farmı için basit web paneli. Tarayıcıdan hesap ekleyip başlatıp durduruyorsun.

Node 18+ lazım.

## Kurulum

```bash
git clone https://github.com/USERNAME/steam-farmer-panel.git
cd steam-farmer-panel
npm install
```

Windows'ta `npm` çalışmazsa:

```bash
npm.cmd install
```

veya direkt:

```bash
node server.js
```

## İlk çalıştırma

```bash
npm start
```

`npm` yoksa `start.bat` veya `node server.js`.

Panel: http://localhost:3000/login

İlk açılışta panel şifresi `data/auth.json` dosyasından okunur. Yoksa otomatik oluşur:

```bash
cp data/auth.example.json data/auth.json
```

Varsayılan: `admin` / `changeme` — `auth.example.json` içindeki şifreyi değiştir.

Hesap listesi için (isteğe bağlı):

```bash
cp data/accounts.example.json data/accounts.json
```

## Kullanım

1. Panele gir
2. **Accounts** → Steam kullanıcı adı, şifre, oyun App ID'leri (ör. `730, 440`)
3. Mobil Steam Guard varsa `shared_secret` alanına maFile'daki değeri yaz
4. **Kaydet**
5. **Dashboard** → **Başlat**

**Konsol** sekmesinde `node server.js` çıktısını canlı görürsün.

E-posta Guard kodu gerekiyorsa Dashboard'daki kutuya kodu yaz.

## Uzaktan erişim (VPS)

Sunucu `0.0.0.0:3000` dinler. Firewall'da 3000 portunu aç.

```
http://sunucu-ip:3000/login
```

## Ortam değişkenleri

| Değişken | Açıklama |
|----------|----------|
| `PORT` | Port (varsayılan 3000) |
| `AUTH_USERNAME` / `AUTH_PASSWORD` | Panel girişi |
| `AUTH_RESET=1` | Panel şifresini sıfırla |
| `STEAM_DEBUG=1` | Steam debug logları (`npm run debug`) |

## Önemli

- `data/accounts.json` içinde Steam şifreleri düz metin — repoya atma
- Panel şifresi ≠ Steam şifresi
- Çok fazla yanlış giriş denemesi Steam rate limit verir (~30 dk)
- Mobil Guard açıksa `shared_secret` olmadan giriş genelde olmaz

## Lisans

MIT
