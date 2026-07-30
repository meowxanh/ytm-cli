"""
YTM stream API — chỉ resolve URL audio (yt-dlp), không tải file về đĩa.
Chạy: .venv\\Scripts\\python.exe stream_server.py
Web (GitHub Pages) gọi API này để phát HTML5 audio.
"""
from __future__ import annotations

import re
from functools import lru_cache
from typing import Any

from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})

YID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def _ydl_opts(**extra: Any) -> dict[str, Any]:
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "extract_flat": False,
        # nhanh hơn một chút
        "socket_timeout": 20,
    }
    opts.update(extra)
    return opts


@app.get("/api/health")
def health():
    return jsonify({"ok": True, "service": "ytm-stream"})


@app.get("/api/stream")
def api_stream():
    """Return direct audio URL for a YouTube video id."""
    vid = (request.args.get("id") or "").strip()
    if not YID.match(vid):
        return jsonify({"error": "invalid id"}), 400

    url = f"https://www.youtube.com/watch?v={vid}"
    try:
        import yt_dlp

        opts = _ydl_opts(
            format="bestaudio[ext=m4a]/bestaudio[acodec*=mp4a]/bestaudio/best",
        )
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    if not info:
        return jsonify({"error": "no info"}), 502

    # Prefer direct url on chosen format
    stream = info.get("url")
    ext = info.get("ext") or "m4a"
    # Sometimes only formats list
    if not stream:
        formats = info.get("formats") or []
        audio_fmts = [
            f
            for f in formats
            if f.get("url")
            and (f.get("vcodec") in (None, "none") or f.get("acodec") not in (None, "none"))
        ]
        # prefer m4a/mp4 for iOS Safari
        audio_fmts.sort(
            key=lambda f: (
                0 if "mp4" in str(f.get("ext", "")) or "m4a" in str(f.get("ext", "")) else 1,
                -(f.get("abr") or f.get("tbr") or 0),
            )
        )
        if audio_fmts:
            stream = audio_fmts[0]["url"]
            ext = audio_fmts[0].get("ext") or ext

    if not stream:
        return jsonify({"error": "no stream url"}), 502

    return jsonify(
        {
            "id": vid,
            "url": stream,
            "ext": ext,
            "title": info.get("title") or "",
            "uploader": info.get("uploader") or info.get("channel") or "",
            "duration": info.get("duration"),
            "thumbnail": (info.get("thumbnail") or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"),
        }
    )


@app.get("/api/search")
def api_search():
    """Search YouTube via yt-dlp (reliable when public APIs are down)."""
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"error": "missing q"}), 400
    limit = min(int(request.args.get("limit") or 12), 20)

    # direct video id / url
    m = re.search(
        r"(?:youtu\.be/|youtube\.com/(?:watch\?v=|embed/|shorts/)|music\.youtube\.com/watch\?v=)"
        r"([A-Za-z0-9_-]{11})",
        q,
    )
    if m or YID.match(q):
        vid = m.group(1) if m else q
        return jsonify(
            {
                "tracks": [
                    {
                        "id": vid,
                        "title": "YouTube video",
                        "uploader": "",
                        "duration": None,
                        "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                    }
                ]
            }
        )

    try:
        import yt_dlp

        opts = _ydl_opts(extract_flat=True, default_search="ytsearch")
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"ytsearch{limit}:{q}", download=False)
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    entries = (info or {}).get("entries") or []
    tracks = []
    for e in entries:
        if not e:
            continue
        vid = e.get("id")
        if not vid:
            continue
        tracks.append(
            {
                "id": str(vid)[:11],
                "title": e.get("title") or "Unknown",
                "uploader": e.get("uploader") or e.get("channel") or "",
                "duration": e.get("duration"),
                "thumbnail": e.get("thumbnail")
                or f"https://i.ytimg.com/vi/{str(vid)[:11]}/hqdefault.jpg",
            }
        )
    return jsonify({"query": q, "tracks": tracks})


def main() -> None:
    import os

    port = int(os.environ.get("PORT", "8765"))
    print("=" * 50)
    print(f"YTM Stream API  →  0.0.0.0:{port}")
    print("  health:  /api/health")
    print("  stream:  /api/stream?id=VIDEO_ID")
    print("  search:  /api/search?q=lofi")
    print("Web: https://meowxanh.github.io/ytm-cli/?api=<URL-này>")
    print("=" * 50)
    # local dev; production uses gunicorn (Dockerfile)
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
