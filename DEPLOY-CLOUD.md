# Deploy Stream API lên cloud (không cần bật PC)

API public YouTube (Piped/Invidious) hiện **gần như chết**.  
App web cần 1 **Stream API** (yt-dlp) chạy 24/7 trên cloud free.

## Cách 1 — Render free (recommend, ~3 phút)

1. Vào: https://dashboard.render.com/select-repo?type=blueprint  
2. Đăng nhập GitHub → chọn repo **`meowxanh/ytm-cli`**  
3. Render đọc `render.yaml` → tạo service **`ytm-stream`** (Docker, free)  
4. Đợi build xong (~5–10 phút lần đầu)  
5. Copy URL dạng: `https://ytm-stream-xxxx.onrender.com`  
6. Mở app:  
   **https://meowxanh.github.io/ytm-cli/?api=https://ytm-stream-xxxx.onrender.com**  
   hoặc ⚙ Cài đặt → dán URL → **Lưu API**

### Lưu ý free tier Render
- Sleep sau ~15 phút không dùng → request đầu tiên có thể **chậm 30–60s** (wake up)  
- Không cần PC  

## Cách 2 — Fly.io / Railway

Dùng `Dockerfile` trong repo:

```bash
# Fly
fly launch
fly deploy

# Railway: New Project → Deploy from GitHub → chọn repo
```

## Kiểm tra API

```
GET https://YOUR-URL/api/health
→ {"ok":true,"service":"ytm-stream"}

GET https://YOUR-URL/api/search?q=lofi
GET https://YOUR-URL/api/stream?id=VIDEO_ID
```

## Local (tuỳ chọn khi dev)

```powershell
.\run-stream.ps1
# api=http://127.0.0.1:8765
```
