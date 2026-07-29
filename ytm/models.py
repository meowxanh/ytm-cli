from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class Track:
    id: str
    title: str
    uploader: str = ""
    duration: int | None = None  # seconds
    url: str = ""  # watch URL
    webpage_url: str = ""
    thumbnail: str = ""

    def __post_init__(self) -> None:
        if not self.url and self.id:
            self.url = f"https://www.youtube.com/watch?v={self.id}"
        if not self.webpage_url:
            self.webpage_url = self.url

    @property
    def duration_str(self) -> str:
        if self.duration is None:
            return "--:--"
        m, s = divmod(int(self.duration), 60)
        h, m = divmod(m, 60)
        if h:
            return f"{h}:{m:02d}:{s:02d}"
        return f"{m}:{s:02d}"

    def display(self) -> str:
        who = f" — {self.uploader}" if self.uploader else ""
        return f"{self.title}{who} [{self.duration_str}]"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Track:
        known = {f.name for f in cls.__dataclass_fields__.values()}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class Playlist:
    name: str
    tracks: list[Track] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "tracks": [t.to_dict() for t in self.tracks]}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Playlist:
        return cls(
            name=data["name"],
            tracks=[Track.from_dict(t) for t in data.get("tracks", [])],
        )
