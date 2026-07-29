from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .models import Playlist, Track

DATA_DIR = Path.home() / ".ytm"
STATE_FILE = DATA_DIR / "state.json"
HISTORY_LIMIT = 200


class Store:
    """Local JSON store: history, likes, dislikes, favorites, playlists, session."""

    def __init__(self, path: Path = STATE_FILE) -> None:
        self.path = path
        self.history: list[Track] = []
        self.likes: list[Track] = []
        self.dislikes: list[Track] = []
        self.favorites: list[Track] = []
        self.playlists: dict[str, Playlist] = {}
        self.session: dict[str, Any] = {
            "queue": [],
            "index": 0,
            "shuffle": False,
            "volume": 0.7,
            "last_query": "",
        }
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return
        self.history = [Track.from_dict(t) for t in raw.get("history", [])]
        self.likes = [Track.from_dict(t) for t in raw.get("likes", [])]
        self.dislikes = [Track.from_dict(t) for t in raw.get("dislikes", [])]
        self.favorites = [Track.from_dict(t) for t in raw.get("favorites", [])]
        self.playlists = {
            name: Playlist.from_dict(p) for name, p in raw.get("playlists", {}).items()
        }
        sess = raw.get("session") or {}
        self.session = {
            "queue": [Track.from_dict(t) for t in sess.get("queue", [])],
            "index": int(sess.get("index", 0) or 0),
            "shuffle": bool(sess.get("shuffle", False)),
            "volume": float(sess.get("volume", 0.7)),
            "last_query": sess.get("last_query", "") or "",
        }

    def save(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        payload = {
            "history": [t.to_dict() for t in self.history[:HISTORY_LIMIT]],
            "likes": [t.to_dict() for t in self.likes],
            "dislikes": [t.to_dict() for t in self.dislikes],
            "favorites": [t.to_dict() for t in self.favorites],
            "playlists": {n: p.to_dict() for n, p in self.playlists.items()},
            "session": {
                "queue": [t.to_dict() for t in self.session.get("queue", [])],
                "index": self.session.get("index", 0),
                "shuffle": self.session.get("shuffle", False),
                "volume": self.session.get("volume", 0.7),
                "last_query": self.session.get("last_query", ""),
            },
        }
        self.path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    # --- helpers ---

    @staticmethod
    def _upsert(lst: list[Track], track: Track) -> list[Track]:
        out = [t for t in lst if t.id != track.id]
        out.insert(0, track)
        return out

    @staticmethod
    def _remove(lst: list[Track], track_id: str) -> list[Track]:
        return [t for t in lst if t.id != track_id]

    def add_history(self, track: Track) -> None:
        self.history = self._upsert(self.history, track)[:HISTORY_LIMIT]

    def like(self, track: Track) -> None:
        self.dislikes = self._remove(self.dislikes, track.id)
        self.likes = self._upsert(self.likes, track)

    def dislike(self, track: Track) -> None:
        self.likes = self._remove(self.likes, track.id)
        self.dislikes = self._upsert(self.dislikes, track)

    def toggle_favorite(self, track: Track) -> bool:
        """Return True if now favorited."""
        if any(t.id == track.id for t in self.favorites):
            self.favorites = self._remove(self.favorites, track.id)
            return False
        self.favorites = self._upsert(self.favorites, track)
        return True

    def is_favorite(self, track_id: str) -> bool:
        return any(t.id == track_id for t in self.favorites)

    def ensure_playlist(self, name: str) -> Playlist:
        if name not in self.playlists:
            self.playlists[name] = Playlist(name=name)
        return self.playlists[name]

    def playlist_add(self, name: str, track: Track) -> None:
        pl = self.ensure_playlist(name)
        if not any(t.id == track.id for t in pl.tracks):
            pl.tracks.append(track)

    def playlist_remove(self, name: str, track_id: str) -> bool:
        pl = self.playlists.get(name)
        if not pl:
            return False
        before = len(pl.tracks)
        pl.tracks = [t for t in pl.tracks if t.id != track_id]
        return len(pl.tracks) < before

    def playlist_delete(self, name: str) -> bool:
        return self.playlists.pop(name, None) is not None

    def save_session(
        self,
        queue: list[Track],
        index: int,
        shuffle: bool,
        volume: float,
        last_query: str = "",
    ) -> None:
        self.session = {
            "queue": list(queue),
            "index": index,
            "shuffle": shuffle,
            "volume": volume,
            "last_query": last_query,
        }
        self.save()
