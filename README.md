# YTM — App nghe nhạc (không cần PC server)

App nghe nhạc YouTube chạy **100% trên trình duyệt / iPhone**.  
Không bật máy Windows. Host free trên **GitHub Pages**.

## Dùng ngay (sau khi bật Pages)

**https://meowxanh.github.io/ytm-cli/**

### Cài như app trên iPhone

1. Mở link trên bằng **Safari**
2. **Chia sẻ** → **Thêm vào Màn hình chính**
3. Dùng icon **YTM** như app

## Cách hoạt động

| | |
|--|--|
| Giao diện | HTML/CSS/JS (static) |
| Search | API public (Invidious / Piped) |
| Phát nhạc | YouTube IFrame (trên điện thoại) |
| Queue / fav / playlist | `localStorage` trên máy |
| Server PC | **Không cần** |

> Một số video chặn embed → app tự next. Không tải file audio về máy.

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
