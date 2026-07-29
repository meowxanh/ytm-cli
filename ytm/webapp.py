from __future__ import annotations

import threading
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file

from . import youtube
from .models import Track
from .player import CACHE_DIR
from .store import Store

app = Flask(
    __name__,
    template_folder=str(Path(__file__).parent / "templates"),
    static_folder=str(Path(__file__).parent / "static"),
)
store = Store()

# video_id -> {"status": "ready"|"loading"|"error", "path": str|None, "error": str|None}
_audio_jobs: dict[str, dict] = {}
_audio_lock = threading.Lock()


def track_json(t: Track) -> dict:
    d = t.to_dict()
    d["duration_str"] = t.duration_str
    if not d.get("thumbnail") and t.id:
        d["thumbnail"] = f"https://i.ytimg.com/vi/{t.id}/hqdefault.jpg"
    return d


def parse_track(data: dict) -> Track | None:
    if not data:
        return None
    tid = data.get("id") or ""
    if not tid and data.get("url"):
        tid = youtube.extract_video_id(data["url"]) or ""
    if not tid:
        return None
    return Track.from_dict(
        {
            "id": tid,
            "title": data.get("title") or "Unknown",
            "uploader": data.get("uploader") or "",
            "duration": data.get("duration"),
            "url": data.get("url") or f"https://www.youtube.com/watch?v={tid}",
            "webpage_url": data.get("webpage_url") or "",
            "thumbnail": data.get("thumbnail") or "",
        }
    )


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/health")
def health():
    return jsonify({"ok": True})


@app.get("/api/search")
def api_search():
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"error": "missing q"}), 400
    limit = min(int(request.args.get("limit") or 12), 20)
    try:
        tracks = youtube.search(q, limit=limit)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    store.session["last_query"] = q
    store.save()
    return jsonify({"query": q, "tracks": [track_json(t) for t in tracks]})


@app.get("/api/state")
def api_state():
    store._load()
    return jsonify(
        {
            "history": [track_json(t) for t in store.history[:50]],
            "likes": [track_json(t) for t in store.likes],
            "dislikes": [track_json(t) for t in store.dislikes],
            "favorites": [track_json(t) for t in store.favorites],
            "playlists": {
                name: {"name": name, "tracks": [track_json(t) for t in pl.tracks]}
                for name, pl in store.playlists.items()
            },
            "session": {
                "queue": [track_json(t) for t in store.session.get("queue") or []],
                "index": int(store.session.get("index") or 0),
                "shuffle": bool(store.session.get("shuffle")),
                "volume": float(store.session.get("volume") or 0.7),
                "last_query": store.session.get("last_query") or "",
            },
        }
    )


@app.post("/api/session")
def api_session():
    data = request.get_json(force=True, silent=True) or {}
    queue_raw = data.get("queue") or []
    queue: list[Track] = []
    for item in queue_raw:
        t = parse_track(item)
        if t:
            queue.append(t)
    index = int(data.get("index") or 0)
    if queue:
        index = max(0, min(index, len(queue) - 1))
    else:
        index = 0
    store.save_session(
        queue=queue,
        index=index,
        shuffle=bool(data.get("shuffle")),
        volume=float(data.get("volume", 0.7)),
        last_query=str(data.get("last_query") or store.session.get("last_query") or ""),
    )
    return jsonify({"ok": True})


@app.post("/api/history")
def api_history():
    data = request.get_json(force=True, silent=True) or {}
    t = parse_track(data.get("track") or data)
    if not t:
        return jsonify({"error": "invalid track"}), 400
    store.add_history(t)
    store.save()
    return jsonify({"ok": True})


@app.post("/api/favorite")
def api_favorite():
    data = request.get_json(force=True, silent=True) or {}
    t = parse_track(data.get("track") or data)
    if not t:
        return jsonify({"error": "invalid track"}), 400
    now = store.toggle_favorite(t)
    store.save()
    return jsonify({"ok": True, "favorited": now})


@app.post("/api/like")
def api_like():
    data = request.get_json(force=True, silent=True) or {}
    t = parse_track(data.get("track") or data)
    if not t:
        return jsonify({"error": "invalid track"}), 400
    store.like(t)
    store.save()
    return jsonify({"ok": True})


@app.post("/api/dislike")
def api_dislike():
    data = request.get_json(force=True, silent=True) or {}
    t = parse_track(data.get("track") or data)
    if not t:
        return jsonify({"error": "invalid track"}), 400
    store.dislike(t)
    store.save()
    return jsonify({"ok": True})


@app.get("/api/playlists")
def api_playlists():
    store._load()
    return jsonify(
        {
            name: {"name": name, "tracks": [track_json(t) for t in pl.tracks]}
            for name, pl in store.playlists.items()
        }
    )


@app.post("/api/playlists")
def api_playlist_create():
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "missing name"}), 400
    store.ensure_playlist(name)
    store.save()
    return jsonify({"ok": True, "name": name})


@app.post("/api/playlists/<name>/add")
def api_playlist_add(name: str):
    data = request.get_json(force=True, silent=True) or {}
    t = parse_track(data.get("track") or data)
    if not t:
        return jsonify({"error": "invalid track"}), 400
    store.playlist_add(name, t)
    store.save()
    return jsonify({"ok": True})


@app.delete("/api/playlists/<name>")
def api_playlist_delete(name: str):
    ok = store.playlist_delete(name)
    if ok:
        store.save()
    return jsonify({"ok": ok})


@app.get("/api/lyrics")
def api_lyrics():
    vid = (request.args.get("id") or "").strip()
    title = (request.args.get("title") or "").strip()
    uploader = (request.args.get("uploader") or "").strip()
    if not vid and not title:
        return jsonify({"error": "missing id or title"}), 400
    track = Track(
        id=vid or "unknown",
        title=title or "Unknown",
        uploader=uploader,
    )
    try:
        text = youtube.fetch_lyrics(track)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    if not text:
        return jsonify({"lyrics": None})
    return jsonify({"lyrics": text})


def _cached_mp3(video_id: str) -> Path | None:
    p = CACHE_DIR / f"{video_id}.mp3"
    if p.exists() and p.stat().st_size > 0:
        return p
    return None


def _prepare_audio(video_id: str, title: str = "", uploader: str = "") -> None:
    """Background worker: download + convert to mp3."""
    try:
        existing = _cached_mp3(video_id)
        if existing:
            with _audio_lock:
                _audio_jobs[video_id] = {
                    "status": "ready",
                    "path": str(existing),
                    "error": None,
                }
            return
        track = Track(id=video_id, title=title or video_id, uploader=uploader or "")
        path = youtube.download_audio(track, CACHE_DIR)
        with _audio_lock:
            _audio_jobs[video_id] = {
                "status": "ready",
                "path": str(path),
                "error": None,
            }
    except Exception as e:
        with _audio_lock:
            _audio_jobs[video_id] = {
                "status": "error",
                "path": None,
                "error": str(e),
            }


@app.post("/api/audio/<video_id>/prepare")
def api_audio_prepare(video_id: str):
    """Start preparing mp3 (or return ready if cached)."""
    video_id = (video_id or "").strip()
    if len(video_id) < 6:
        return jsonify({"error": "invalid id"}), 400

    cached = _cached_mp3(video_id)
    if cached:
        with _audio_lock:
            _audio_jobs[video_id] = {
                "status": "ready",
                "path": str(cached),
                "error": None,
            }
        return jsonify({"status": "ready", "url": f"/api/audio/{video_id}"})

    data = request.get_json(force=True, silent=True) or {}
    title = data.get("title") or ""
    uploader = data.get("uploader") or ""

    with _audio_lock:
        job = _audio_jobs.get(video_id)
        if job and job["status"] == "loading":
            return jsonify({"status": "loading"})
        if job and job["status"] == "ready" and job.get("path"):
            return jsonify({"status": "ready", "url": f"/api/audio/{video_id}"})
        _audio_jobs[video_id] = {"status": "loading", "path": None, "error": None}

    t = threading.Thread(
        target=_prepare_audio,
        args=(video_id, title, uploader),
        daemon=True,
    )
    t.start()
    return jsonify({"status": "loading"})


@app.get("/api/audio/<video_id>/status")
def api_audio_status(video_id: str):
    cached = _cached_mp3(video_id)
    if cached:
        return jsonify({"status": "ready", "url": f"/api/audio/{video_id}"})
    with _audio_lock:
        job = _audio_jobs.get(video_id) or {"status": "idle"}
    if job.get("status") == "ready":
        return jsonify({"status": "ready", "url": f"/api/audio/{video_id}"})
    if job.get("status") == "error":
        return jsonify({"status": "error", "error": job.get("error") or "failed"})
    if job.get("status") == "loading":
        return jsonify({"status": "loading"})
    return jsonify({"status": "idle"})


@app.get("/api/audio/<video_id>")
def api_audio_file(video_id: str):
    """Serve cached mp3 for HTML5 <audio>."""
    path = _cached_mp3(video_id)
    if not path:
        with _audio_lock:
            job = _audio_jobs.get(video_id)
        if job and job.get("path") and Path(job["path"]).exists():
            path = Path(job["path"])
    if not path or not path.exists():
        return jsonify({"error": "audio not ready — call /prepare first"}), 404
    return send_file(
        path,
        mimetype="audio/mpeg",
        conditional=True,
        download_name=f"{video_id}.mp3",
    )


def main() -> None:
    print("YTM Web → http://127.0.0.1:5050")
    print("Playback: local audio cache (yt-dlp), not YouTube embed")
    app.run(host="127.0.0.1", port=5050, debug=False, threaded=True)


if __name__ == "__main__":
    main()
