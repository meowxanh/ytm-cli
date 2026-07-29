from __future__ import annotations

import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable

from .models import Track
from . import youtube

CACHE_DIR = Path.home() / ".ytm" / "cache"


class Player:
    """
    Playback engine.
    Prefers mpv if available; otherwise downloads audio and plays via pygame.
    """

    def __init__(self, volume: float = 0.7) -> None:
        self.volume = max(0.0, min(1.0, volume))
        self._track: Track | None = None
        self._mpv: subprocess.Popen | None = None
        self._backend: str | None = None  # "mpv" | "pygame"
        self._pygame_ready = False
        self._on_end: Callable[[], None] | None = None
        self._watch_thread: threading.Thread | None = None
        self._stop_watch = threading.Event()
        self._paused = False
        self._lock = threading.Lock()

    @property
    def current(self) -> Track | None:
        return self._track

    @property
    def is_playing(self) -> bool:
        if self._backend == "mpv":
            return self._mpv is not None and self._mpv.poll() is None and not self._paused
        if self._backend == "pygame":
            try:
                import pygame

                return bool(pygame.mixer.get_init() and pygame.mixer.music.get_busy() and not self._paused)
            except Exception:
                return False
        return False

    @property
    def is_paused(self) -> bool:
        return self._paused

    def set_on_end(self, cb: Callable[[], None] | None) -> None:
        self._on_end = cb

    def play(self, track: Track) -> None:
        with self._lock:
            self.stop_internal()
            self._track = track
            self._paused = False
            if shutil.which("mpv"):
                self._play_mpv(track)
            else:
                self._play_pygame(track)

    def _play_mpv(self, track: Track) -> None:
        url = track.url or f"https://www.youtube.com/watch?v={track.id}"
        # mpv can play YouTube URLs if yt-dlp is on PATH; pass ytdl
        cmd = [
            "mpv",
            "--no-video",
            "--force-window=no",
            f"--volume={int(self.volume * 100)}",
            "--ytdl=yes",
            "--term-playing-msg=",
            "--msg-level=all=error",
            url,
        ]
        self._mpv = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self._backend = "mpv"
        self._start_watch()

    def _ensure_pygame(self) -> None:
        if self._pygame_ready:
            return
        import pygame

        pygame.mixer.init(frequency=44100, size=-16, channels=2, buffer=4096)
        self._pygame_ready = True

    def _play_pygame(self, track: Track) -> None:
        path = self._cached_path(track)
        if path is None or not path.exists():
            path = youtube.download_audio(track, CACHE_DIR)
        self._ensure_pygame()
        import pygame

        pygame.mixer.music.load(str(path))
        pygame.mixer.music.set_volume(self.volume)
        pygame.mixer.music.play()
        self._backend = "pygame"
        self._start_watch()

    def _cached_path(self, track: Track) -> Path | None:
        for ext in ("mp3", "m4a", "webm", "opus", "ogg", "wav", "mp4"):
            p = CACHE_DIR / f"{track.id}.{ext}"
            if p.exists() and p.stat().st_size > 0:
                return p
        matches = list(CACHE_DIR.glob(f"{track.id}.*")) if CACHE_DIR.exists() else []
        return matches[0] if matches else None

    def _start_watch(self) -> None:
        self._stop_watch.set()
        if self._watch_thread and self._watch_thread.is_alive():
            self._watch_thread.join(timeout=0.5)
        self._stop_watch = threading.Event()
        t = threading.Thread(target=self._watch_loop, daemon=True)
        self._watch_thread = t
        t.start()

    def _watch_loop(self) -> None:
        # Wait until playback actually starts
        time.sleep(0.4)
        while not self._stop_watch.is_set():
            ended = False
            if self._backend == "mpv":
                if self._mpv is None or self._mpv.poll() is not None:
                    ended = not self._paused
            elif self._backend == "pygame":
                try:
                    import pygame

                    if pygame.mixer.get_init() and not pygame.mixer.music.get_busy() and not self._paused:
                        ended = True
                except Exception:
                    ended = True
            else:
                break
            if ended:
                cb = self._on_end
                self._backend = None
                if cb:
                    try:
                        cb()
                    except Exception:
                        pass
                break
            time.sleep(0.35)

    def pause(self) -> None:
        if self._backend == "mpv" and self._mpv and self._mpv.poll() is None:
            # mpv without IPC: stop is the only reliable control; use pause via --input if needed
            # Without IPC we can't pause cleanly — restart path uses pygame when possible
            pass
        if self._backend == "pygame":
            import pygame

            if pygame.mixer.get_init():
                pygame.mixer.music.pause()
                self._paused = True
        # For mpv without IPC, fall through: mark paused by killing isn't ideal
        # Prefer documenting: pause works with pygame backend
        if self._backend == "mpv":
            # Attempt: not supported without IPC — leave as no-op message from app
            pass

    def resume(self) -> None:
        if self._backend == "pygame" and self._paused:
            import pygame

            if pygame.mixer.get_init():
                pygame.mixer.music.unpause()
                self._paused = False

    def stop(self) -> None:
        with self._lock:
            self.stop_internal()

    def stop_internal(self) -> None:
        self._stop_watch.set()
        if self._mpv is not None:
            try:
                self._mpv.terminate()
                self._mpv.wait(timeout=2)
            except Exception:
                try:
                    self._mpv.kill()
                except Exception:
                    pass
            self._mpv = None
        if self._backend == "pygame" or self._pygame_ready:
            try:
                import pygame

                if pygame.mixer.get_init():
                    pygame.mixer.music.stop()
            except Exception:
                pass
        self._backend = None
        self._paused = False

    def set_volume(self, vol: float) -> None:
        self.volume = max(0.0, min(1.0, vol))
        if self._backend == "pygame":
            try:
                import pygame

                if pygame.mixer.get_init():
                    pygame.mixer.music.set_volume(self.volume)
            except Exception:
                pass

    def status_line(self) -> str:
        if not self._track:
            return "Stopped"
        state = "Paused" if self._paused else ("Playing" if self.is_playing else "Idle")
        backend = self._backend or "?"
        return f"{state} [{backend}] {self._track.display()}"
