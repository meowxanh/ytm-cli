# YTM — App nghe nhạc

## App độc lập (iPhone) — thoát app vẫn nghe

Thư mục [`ytm-mobile/`](ytm-mobile/) — app native **cài vào máy**, không Expo Go, không bật PC khi nghe.

```powershell
cd C:\Users\Duy\ytm-cli\ytm-mobile
npx.cmd eas-cli login
npx.cmd eas-cli init
npx.cmd eas-cli build --platform ios --profile preview
```

**Cần Apple Developer ($99/năm)** để cài app iOS độc lập.  
Hướng dẫn đủ: [`ytm-mobile/README.md`](ytm-mobile/README.md)

| | Web | **App độc lập** |
|--|-----|-----------------|
| Thoát app vẫn nghe | Không | **Có** |
| Cần bật PC khi nghe | Không | **Không** |
| Cần Apple Developer | Không | **Có ($99/năm)** |

---

## Web · SoundCloud

Đã **bỏ YouTube** → nghe **SoundCloud** (stream MP3 progressive).

```powershell
cd C:\Users\Duy\ytm-cli
.\run-stream.ps1
```

Mở: **https://meowxanh.github.io/ytm-cli/**  
(App tự gọi `http://127.0.0.1:8765`)

Cloud free (không bật PC): xem `DEPLOY-CLOUD.md` (Render).

## Bật GitHub Pages (1 lần)

1. Repo: https://github.com/meowxanh/ytm-cli  
2. **Settings → Pages**  
3. Source: **Deploy from a branch**  
4. Branch: `main` · Folder: `/docs`  
5. Save → đợi 1–2 phút → mở `https://meowxanh.github.io/ytm-cli/`

## Dev local (tuỳ chọn, không bắt buộc)

Chỉ để xem UI trên PC:

```powershell
cd C:\Users\Duy\ytm-cli\docs
python3.12 -m http.server 8080
```

Mở http://127.0.0.1:8080

## Thư mục

```
docs/          ← app static (GitHub Pages)
  index.html
  app.css
  app.js
  manifest.webmanifest
  icons/
ytm/           ← bản Python cũ (CLI/local server) — không bắt buộc
```

## Ghi chú

- Dùng cá nhân. Tôn trọng ToS YouTube.  
- Search phụ thuộc instance public (đôi khi chậm / fail → thử lại).  
- Muốn offline / tải file audio: bản Python local (`ytm/`) vẫn còn trong repo.
