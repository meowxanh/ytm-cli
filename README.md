# YTM — YouTube Music CLI

Trình phát nhạc YouTube trong terminal: search, queue, library, favorites, playlists, lyrics, like/dislike, resume session.

## Yêu cầu

- Python 3.11+
- (Tuỳ chọn) [mpv](https://mpv.io/) — phát stream trực tiếp, không cần cache

Không có mpv: app tải audio → convert mp3 (ffmpeg bundled qua `imageio-ffmpeg`) → phát bằng **pygame**. Cache tại `%USERPROFILE%\.ytm\cache`.

## Cài đặt

```powershell
cd C:\Users\Duy\ytm-cli
python3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Chạy

### Web UI (HTML) — recommend

```powershell
cd C:\Users\Duy\ytm-cli
.\run-web.ps1
```

Mở trình duyệt: **http://127.0.0.1:5050**

Giao diện dark music player: search, queue, favorites, history, playlist, lyrics.  
Phát nhạc bằng **audio local** (yt-dlp tải + cache mp3) — tránh lỗi *Video unavailable* của YouTube embed.  
Lần phát đầu mỗi bài có thể mất 10–40s; lần sau phát ngay từ cache.  
Data dùng chung CLI: `%USERPROFILE%\.ytm\state.json`.

### CLI (terminal)

```powershell
cd C:\Users\Duy\ytm-cli
.\run.ps1
```

Hoặc:

```powershell
.\.venv\Scripts\python.exe -m ytm
```

## Lệnh chính

| Lệnh | Mô tả |
|------|--------|
| `search lo-fi chill` | Tìm 10 bài |
| `play 1` | Phát bài #1 trong kết quả |
| `play <url>` | Phát link YouTube |
| `add 2` | Thêm #2 vào queue |
| `queue` / `next` / `prev` | Xem queue, next, prev |
| `shuffle on` | Bật shuffle |
| `fav` / `favs` | Favorite bài hiện tại / list |
| `like` / `dislike` | Like / dislike (+ skip) |
| `pl create gym` | Tạo playlist |
| `pl add gym` | Thêm bài đang phát vào playlist |
| `pl play gym` | Phát playlist |
| `lyrics` | Lời bài (caption YT / LRCLIB) |
| `resume-session` | Khôi phục queue lần trước |
| `help` | Trợ giúp |
| `quit` | Thoát (tự save) |

## Dữ liệu local

Tất cả lưu tại `%USERPROFILE%\.ytm\`:

- `state.json` — history, likes, favorites, playlists, session
- `cache\` — file audio đã tải (backend pygame)

## Ghi chú

- Chỉ dùng cho mục đích cá nhân / nghe nhạc. Tôn trọng ToS YouTube.
- Lần phát đầu mỗi bài (pygame) có thể mất vài chục giây để tải audio.
- `pause` / `resume` chỉ chắc chắn khi dùng backend pygame.
