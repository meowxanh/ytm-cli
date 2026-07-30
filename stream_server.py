"""
YTM Stream API — SoundCloud only (no YouTube, no yt-dlp).
Resolve client_id + search + progressive MP3 URL.
"""
from __future__ import annotations

import re
import time
from typing import Any
from urllib.parse import quote, urlencode

import requests
from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})

SESSION = requests.Session()
SESSION.headers.update(
    {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Origin": "https://soundcloud.com",
        "Referer": "https://soundcloud.com/",
    }
)

_client_id: str | None = None
_client_exp: float = 0


def get_client_id() -> str:
    global _client_id, _client_exp
    now = time.time()
    if _client_id and now < _client_exp:
        return _client_id

    html = SESSION.get("https://soundcloud.com", timeout=20).text
    scripts = re.findall(
        r"src=\"(https://a-v2\.sndcdn\.com/assets/[^\"]+\.js)\"", html
    )
    for src in scripts:
        try:
            js = SESSION.get(src, timeout=20).text
        except Exception:
            continue
        m = re.search(r"client_id\s*[=:]\s*\"([a-zA-Z0-9]{32})\"", js)
        if not m:
            m = re.search(r"client_id:\"([a-zA-Z0-9]{32})\"", js)
        if m:
            _client_id = m.group(1)
            _client_exp = now + 6 * 3600
            return _client_id

    raise RuntimeError("cannot extract SoundCloud client_id")


def sc_get(path: str, params: dict[str, Any] | None = None) -> Any:
    cid = get_client_id()
    params = dict(params or {})
    params["client_id"] = cid
    url = path if path.startswith("http") else f"https://api-v2.soundcloud.com{path}"
    r = SESSION.get(url, params=params, timeout=25)
    r.raise_for_status()
    return r.json()


def track_json(t: dict[str, Any]) -> dict[str, Any]:
    user = t.get("user") or {}
    art = (
        t.get("artwork_url")
        or user.get("avatar_url")
        or ""
    )
    if art:
        art = art.replace("-large", "-t500x500").replace("-badge", "-t500x500")
    return {
        "id": str(t.get("id")),
        "title": t.get("title") or "Unknown",
        "uploader": user.get("username") or user.get("full_name") or "",
        "duration": int((t.get("duration") or 0) / 1000) or None,
        "thumbnail": art,
        "permalink_url": t.get("permalink_url") or "",
        "source": "soundcloud",
    }


def resolve_progressive(track: dict[str, Any]) -> str | None:
    """Return progressive MP3 URL (HTML5-friendly)."""
    media = (track.get("media") or {}).get("transcodings") or []
    # Prefer progressive mp3
    ordered = sorted(
        media,
        key=lambda tr: (
            0 if (tr.get("format") or {}).get("protocol") == "progressive" else 1,
            0 if "mpeg" in str((tr.get("format") or {}).get("mime_type", "")) else 1,
        ),
    )
    cid = get_client_id()
    for tr in ordered:
        u = tr.get("url")
        if not u:
            continue
        try:
            data = SESSION.get(u, params={"client_id": cid}, timeout=25).json()
            stream = data.get("url")
            if stream and stream.startswith("http"):
                # progressive preferred; hls also returned sometimes
                if (tr.get("format") or {}).get("protocol") == "progressive":
                    return stream
                # keep first hls as fallback if no progressive
                if not any(
                    (x.get("format") or {}).get("protocol") == "progressive"
                    for x in media
                ):
                    return stream
        except Exception:
            continue
    # second pass: any resolved url
    for tr in ordered:
        u = tr.get("url")
        if not u:
            continue
        try:
            data = SESSION.get(u, params={"client_id": cid}, timeout=25).json()
            stream = data.get("url")
            if stream and stream.startswith("http"):
                return stream
        except Exception:
            continue
    return None


@app.get("/api/health")
def health():
    try:
        cid = get_client_id()
        return jsonify({"ok": True, "service": "ytm-soundcloud", "client": True, "cid_len": len(cid)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/api/search")
def api_search():
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"error": "missing q"}), 400
    limit = min(int(request.args.get("limit") or 15), 30)

    # SoundCloud URL resolve
    if "soundcloud.com/" in q:
        try:
            data = sc_get("https://api-v2.soundcloud.com/resolve", {"url": q})
            if data.get("kind") == "track":
                return jsonify({"query": q, "tracks": [track_json(data)]})
            if data.get("kind") == "playlist":
                tracks = [track_json(t) for t in (data.get("tracks") or []) if t]
                return jsonify({"query": q, "tracks": tracks[:limit]})
        except Exception as e:
            return jsonify({"error": str(e)}), 502

    try:
        data = sc_get(
            "/search/tracks",
            {"q": q, "limit": limit, "app_locale": "en"},
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    coll = data.get("collection") or []
    tracks = [track_json(t) for t in coll if t.get("streamable", True)]
    return jsonify({"query": q, "tracks": tracks})


@app.get("/api/stream")
def api_stream():
    tid = (request.args.get("id") or "").strip()
    if not tid.isdigit():
        return jsonify({"error": "invalid soundcloud track id"}), 400

    try:
        track = sc_get(f"/tracks/{tid}")
    except Exception as e:
        return jsonify({"error": f"track: {e}"}), 502

    if track.get("policy") not in (None, "ALLOW", "SNIP"):
        # SNIP = preview only, still try
        pass

    try:
        url = resolve_progressive(track)
    except Exception as e:
        return jsonify({"error": f"resolve: {e}"}), 502

    if not url:
        return jsonify({"error": "no progressive stream (geo/block?)"}), 502

    meta = track_json(track)
    return jsonify(
        {
            "id": tid,
            "url": url,
            "ext": "mp3",
            "title": meta["title"],
            "uploader": meta["uploader"],
            "duration": meta["duration"],
            "thumbnail": meta["thumbnail"],
            "source": "soundcloud",
        }
    )


@app.get("/api/charts")
def api_charts():
    """SoundCloud trending / charts for home feed."""
    kind = (request.args.get("kind") or "trending").strip()
    genre = (request.args.get("genre") or "all-music").strip()
    try:
        # popular: /charts?kind=trending&genre=soundcloud:genres:all-music
        genre_param = genre if genre.startswith("soundcloud:") else f"soundcloud:genres:{genre}"
        data = sc_get(
            "/charts",
            {
                "kind": kind,
                "genre": genre_param,
                "limit": 20,
                "linked_partitioning": 1,
            },
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    coll = data.get("collection") or []
    tracks = []
    for item in coll:
        t = item.get("track") or item
        if t and t.get("id"):
            tracks.append(track_json(t))
    return jsonify({"tracks": tracks})


def main() -> None:
    import os

    port = int(os.environ.get("PORT", "8765"))
    print("=" * 50)
    print(f"YTM SoundCloud API → 0.0.0.0:{port}")
    print("  /api/health  /api/search  /api/stream  /api/charts")
    print("=" * 50)
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
