from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import requests
import yt_dlp

from .models import Track

YOUTUBE_ID_RE = re.compile(
    r"(?:youtu\.be/|youtube\.com/(?:watch\?v=|embed/|shorts/|live/)|music\.youtube\.com/watch\?v=)"
    r"([A-Za-z0-9_-]{11})"
)
BARE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def extract_video_id(text: str) -> str | None:
    text = text.strip()
    m = YOUTUBE_ID_RE.search(text)
    if m:
        return m.group(1)
    if BARE_ID_RE.match(text):
        return text
    return None


def _track_from_entry(entry: dict[str, Any]) -> Track | None:
    if not entry:
        return None
    vid = entry.get("id") or entry.get("url")
    if not vid:
        return None
    # flat playlist entries sometimes put id in url
    if isinstance(vid, str) and len(vid) > 11 and "http" in vid:
        extracted = extract_video_id(vid)
        vid = extracted or vid
    title = entry.get("title") or entry.get("fulltitle") or "Unknown"
    uploader = (
        entry.get("uploader")
        or entry.get("channel")
        or entry.get("creator")
        or ""
    )
    duration = entry.get("duration")
    if duration is not None:
        try:
            duration = int(duration)
        except (TypeError, ValueError):
            duration = None
    thumb = ""
    thumbs = entry.get("thumbnails") or []
    if thumbs:
        thumb = thumbs[-1].get("url", "") or ""
    elif entry.get("thumbnail"):
        thumb = entry["thumbnail"]
    return Track(
        id=str(vid)[:11] if len(str(vid)) >= 11 else str(vid),
        title=title,
        uploader=uploader,
        duration=duration,
        thumbnail=thumb,
    )


def search(query: str, limit: int = 10) -> list[Track]:
    """Search YouTube; returns tracks (no download)."""
    vid = extract_video_id(query)
    if vid:
        t = get_info(vid)
        return [t] if t else []

    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
        "skip_download": True,
        "default_search": "ytsearch",
        "noplaylist": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
    entries = (info or {}).get("entries") or []
    tracks: list[Track] = []
    for e in entries:
        t = _track_from_entry(e if isinstance(e, dict) else {})
        if t:
            tracks.append(t)
    return tracks


def get_info(video_id_or_url: str) -> Track | None:
    url = video_id_or_url
    vid = extract_video_id(video_id_or_url)
    if vid:
        url = f"https://www.youtube.com/watch?v={vid}"
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception:
        return None
    if not info:
        return None
    return _track_from_entry(info)


def _ffmpeg_exe() -> str | None:
    """System ffmpeg, or bundled binary from imageio-ffmpeg."""
    import shutil

    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def _to_mp3(src: Path, dest_mp3: Path) -> Path:
    """Convert any audio file to mp3 via ffmpeg (no ffprobe required)."""
    import subprocess

    ff = _ffmpeg_exe()
    if not ff:
        raise RuntimeError("ffmpeg not found — install ffmpeg or imageio-ffmpeg")
    dest_mp3.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ff,
        "-y",
        "-i",
        str(src),
        "-vn",
        "-acodec",
        "libmp3lame",
        "-q:a",
        "4",
        str(dest_mp3),
    ]
    proc = subprocess.run(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    if proc.returncode != 0 or not dest_mp3.exists():
        err = (proc.stderr or "")[-400:]
        raise RuntimeError(f"ffmpeg convert failed: {err}")
    return dest_mp3


def download_audio(track: Track, dest_dir: str | Path) -> Path:
    """Download best audio into dest_dir as mp3 (pygame-friendly)."""
    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)

    mp3 = dest / f"{track.id}.mp3"
    if mp3.exists() and mp3.stat().st_size > 0:
        return mp3

    outtmpl = str(dest / f"{track.id}.%(ext)s")
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "format": "bestaudio/best",
        "outtmpl": outtmpl,
    }

    url = track.url or f"https://www.youtube.com/watch?v={track.id}"
    # Clear previous raw downloads for this id
    for stale in dest.glob(f"{track.id}.*"):
        try:
            stale.unlink()
        except OSError:
            pass

    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])

    raw = None
    for ext in ("m4a", "webm", "opus", "ogg", "mp3", "wav", "mp4"):
        p = dest / f"{track.id}.{ext}"
        if p.exists() and p.stat().st_size > 0:
            raw = p
            break
    if raw is None:
        matches = [p for p in dest.glob(f"{track.id}.*") if p.stat().st_size > 0]
        if not matches:
            raise FileNotFoundError(f"Download finished but file not found for {track.id}")
        raw = matches[0]

    if raw.suffix.lower() == ".mp3":
        return raw

    converted = _to_mp3(raw, mp3)
    try:
        raw.unlink()
    except OSError:
        pass
    return converted


def fetch_lyrics(track: Track) -> str | None:
    """Best-effort lyrics: YouTube auto-captions, then LRCLIB."""
    text = _lyrics_from_captions(track)
    if text:
        return text
    return _lyrics_from_lrclib(track)


def _lyrics_from_captions(track: Track) -> str | None:
    url = track.url or f"https://www.youtube.com/watch?v={track.id}"
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "writesubtitles": False,
        "writeautomaticsub": False,
        "listsubtitles": False,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception:
        return None
    if not info:
        return None

    subs = info.get("subtitles") or {}
    autos = info.get("automatic_captions") or {}
    # Prefer manual vi/en, then auto vi/en
    for bag in (subs, autos):
        for lang in ("vi", "en", "en-US", "en-GB"):
            tracks = bag.get(lang)
            if not tracks:
                continue
            # pick json3 or vtt or srv
            url_sub = None
            for t in tracks:
                if t.get("ext") in ("json3", "srv3", "vtt", "ttml", "srv1"):
                    url_sub = t.get("url")
                    if url_sub:
                        break
            if not url_sub and tracks:
                url_sub = tracks[0].get("url")
            if url_sub:
                body = _download_text(url_sub)
                if body:
                    parsed = _parse_caption_body(body)
                    if parsed:
                        return parsed
    return None


def _download_text(url: str) -> str | None:
    try:
        r = requests.get(url, timeout=15)
        r.raise_for_status()
        return r.text
    except Exception:
        return None


def _parse_caption_body(body: str) -> str | None:
    body = body.strip()
    if not body:
        return None
    # json3 (YouTube)
    if body.startswith("{") or body.startswith("["):
        try:
            import json

            data = json.loads(body)
            events = data.get("events") or []
            lines: list[str] = []
            for ev in events:
                segs = ev.get("segs") or []
                piece = "".join(s.get("utf8", "") for s in segs).strip()
                if piece and piece != "\n":
                    lines.append(piece.replace("\n", " ").strip())
            text = "\n".join(lines).strip()
            return text or None
        except Exception:
            pass
    # crude VTT / SRT strip
    lines = []
    for line in body.splitlines():
        line = line.strip()
        if not line or line.startswith("WEBVTT") or "-->" in line:
            continue
        if line.isdigit():
            continue
        if line.startswith("NOTE"):
            continue
        lines.append(line)
    text = "\n".join(lines).strip()
    return text or None


def _lyrics_from_lrclib(track: Track) -> str | None:
    # Clean title a bit
    title = re.sub(r"\s*[\(\[\{].*?[\)\]\}]\s*", " ", track.title)
    title = re.sub(r"\s+", " ", title).strip()
    artist = track.uploader or ""
    # strip common channel suffixes
    artist = re.sub(r"\s*[-–|].*$", "", artist).strip()
    artist = re.sub(r"\s*(Official|VEVO|Topic)$", "", artist, flags=re.I).strip()

    try:
        r = requests.get(
            "https://lrclib.net/api/search",
            params={"q": f"{artist} {title}".strip()},
            timeout=12,
            headers={"User-Agent": "ytm-cli/1.0"},
        )
        r.raise_for_status()
        results = r.json()
    except Exception:
        return None
    if not results:
        return None
    best = results[0]
    plain = best.get("plainLyrics") or best.get("syncedLyrics")
    if not plain:
        return None
    # strip LRC timestamps if synced
    cleaned = re.sub(r"\[\d+:\d+(?:\.\d+)?\]", "", plain)
    cleaned = "\n".join(line.strip() for line in cleaned.splitlines() if line.strip())
    return cleaned or None
