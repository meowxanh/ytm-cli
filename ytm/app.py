from __future__ import annotations

import random
import shlex
import sys
from typing import Callable

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from . import __version__, youtube
from .models import Track
from .player import Player
from .store import Store

console = Console()


HELP = """
[bold cyan]YTM[/] — YouTube Music CLI  v{version}

[bold]Phát / hàng đợi[/]
  search <query>       Tìm bài (hiện list đánh số)
  play <n|url|query>   Phát # từ kết quả, URL, hoặc search+play
  add <n|url>          Thêm vào queue
  queue                Xem queue
  clear                Xóa queue
  next / prev          Bài sau / trước
  pause / resume       Tạm dừng / tiếp (pygame backend)
  stop                 Dừng
  shuffle on|off       Bật/tắt shuffle
  vol <0-100>          Âm lượng

[bold]Thư viện[/]
  now                  Bài đang phát
  history              Lịch sử
  fav                  Toggle favorite bài hiện tại
  favs                 Danh sách favorites
  like / dislike       Like / dislike bài hiện tại
  likes / dislikes     Xem danh sách
  pl list              List playlist
  pl create <name>     Tạo playlist
  pl add <name> [n]    Thêm bài (hiện tại hoặc # search)
  pl play <name>       Phát playlist
  pl del <name>        Xóa playlist
  pl show <name>       Xem playlist

[bold]Khác[/]
  lyrics               Lời bài (caption / LRCLIB)
  resume-session       Khôi phục queue lần trước
  save                 Lưu state
  help                 Trợ giúp
  quit / exit          Thoát
""".format(version=__version__)


class App:
    def __init__(self) -> None:
        self.store = Store()
        vol = float(self.store.session.get("volume", 0.7))
        self.player = Player(volume=vol)
        self.player.set_on_end(self._on_track_end)
        self.results: list[Track] = []
        self.queue: list[Track] = list(self.store.session.get("queue") or [])
        self.index: int = int(self.store.session.get("index") or 0)
        self.shuffle: bool = bool(self.store.session.get("shuffle"))
        self._shuffle_order: list[int] = []
        self.last_query: str = self.store.session.get("last_query") or ""
        self._auto_advance = True

        self.commands: dict[str, Callable[[list[str]], None]] = {
            "help": lambda a: console.print(HELP),
            "h": lambda a: console.print(HELP),
            "?": lambda a: console.print(HELP),
            "search": self.cmd_search,
            "s": self.cmd_search,
            "play": self.cmd_play,
            "p": self.cmd_play,
            "add": self.cmd_add,
            "queue": self.cmd_queue,
            "q": self.cmd_queue,
            "clear": self.cmd_clear,
            "next": self.cmd_next,
            "n": self.cmd_next,
            "prev": self.cmd_prev,
            "pause": self.cmd_pause,
            "resume": self.cmd_resume,
            "stop": self.cmd_stop,
            "shuffle": self.cmd_shuffle,
            "vol": self.cmd_vol,
            "volume": self.cmd_vol,
            "now": self.cmd_now,
            "history": self.cmd_history,
            "fav": self.cmd_fav,
            "favs": self.cmd_favs,
            "like": self.cmd_like,
            "dislike": self.cmd_dislike,
            "likes": self.cmd_likes,
            "dislikes": self.cmd_dislikes,
            "pl": self.cmd_pl,
            "playlist": self.cmd_pl,
            "lyrics": self.cmd_lyrics,
            "ly": self.cmd_lyrics,
            "resume-session": self.cmd_resume_session,
            "save": self.cmd_save,
            "quit": self.cmd_quit,
            "exit": self.cmd_quit,
        }

    # ---------- UI helpers ----------

    def _print_tracks(self, tracks: list[Track], title: str) -> None:
        if not tracks:
            console.print(f"[dim]{title}: trống[/]")
            return
        table = Table(title=title, show_lines=False, expand=False)
        table.add_column("#", style="cyan", width=4)
        table.add_column("Title", style="bold")
        table.add_column("Artist", style="green")
        table.add_column("Dur", justify="right")
        for i, t in enumerate(tracks, 1):
            table.add_row(str(i), t.title, t.uploader or "—", t.duration_str)
        console.print(table)

    def _resolve_track(self, args: list[str]) -> Track | None:
        if not args:
            return self.player.current
        token = " ".join(args).strip()
        if token.isdigit():
            n = int(token)
            if 1 <= n <= len(self.results):
                return self.results[n - 1]
            console.print(f"[red]Không có kết quả #{n}. Gõ search trước.[/]")
            return None
        vid = youtube.extract_video_id(token)
        if vid or token.startswith("http"):
            console.print("[dim]Đang lấy info…[/]")
            t = youtube.get_info(token)
            if not t:
                console.print("[red]Không lấy được video.[/]")
            return t
        # treat as search → first result
        console.print(f"[dim]Search & pick #1: {token}[/]")
        tracks = youtube.search(token, limit=5)
        self.results = tracks
        self.last_query = token
        if not tracks:
            console.print("[red]Không tìm thấy.[/]")
            return None
        self._print_tracks(tracks, f"Search: {token}")
        return tracks[0]

    def _persist(self) -> None:
        self.store.save_session(
            queue=self.queue,
            index=self.index,
            shuffle=self.shuffle,
            volume=self.player.volume,
            last_query=self.last_query,
        )

    def _play_track(self, track: Track, *, from_queue: bool = False) -> None:
        console.print(Panel(f"[bold]▶ {track.display()}[/]", border_style="magenta"))
        console.print("[dim]Đang chuẩn bị audio (lần đầu có thể hơi lâu)…[/]")
        try:
            self.player.play(track)
        except Exception as e:
            console.print(f"[red]Lỗi phát:[/] {e}")
            return
        self.store.add_history(track)
        self._persist()
        console.print(f"[green]Playing[/] [{self.player._backend}] {track.title}")

    def _on_track_end(self) -> None:
        if not self._auto_advance:
            return
        # Called from player watch thread — keep it light
        try:
            if not self.queue:
                return
            if self.shuffle and self._shuffle_order:
                # advance shuffle pointer stored as index into order
                try:
                    pos = self._shuffle_order.index(self.index)
                except ValueError:
                    pos = -1
                if pos + 1 < len(self._shuffle_order):
                    self.index = self._shuffle_order[pos + 1]
                    self._play_track(self.queue[self.index], from_queue=True)
                return
            if self.index + 1 < len(self.queue):
                self.index += 1
                self._play_track(self.queue[self.index], from_queue=True)
        except Exception:
            pass

    def _rebuild_shuffle(self) -> None:
        if not self.queue:
            self._shuffle_order = []
            return
        order = list(range(len(self.queue)))
        random.shuffle(order)
        # keep current index first if valid
        if 0 <= self.index < len(self.queue) and self.index in order:
            order.remove(self.index)
            order.insert(0, self.index)
        self._shuffle_order = order

    # ---------- commands ----------

    def cmd_search(self, args: list[str]) -> None:
        if not args:
            console.print("[yellow]Dùng: search <query>[/]")
            return
        query = " ".join(args)
        console.print(f"[dim]Đang search: {query}…[/]")
        try:
            tracks = youtube.search(query, limit=10)
        except Exception as e:
            console.print(f"[red]Search lỗi:[/] {e}")
            return
        self.results = tracks
        self.last_query = query
        self._print_tracks(tracks, f"Search: {query}")
        if tracks:
            console.print("[dim]play <n>  |  add <n>[/]")

    def cmd_play(self, args: list[str]) -> None:
        track = self._resolve_track(args)
        if not track:
            if not args and self.queue:
                # play current queue index
                if 0 <= self.index < len(self.queue):
                    self._play_track(self.queue[self.index], from_queue=True)
                else:
                    self.index = 0
                    self._play_track(self.queue[0], from_queue=True)
            elif not args:
                console.print("[yellow]Dùng: play <n|url|query>[/]")
            return
        # If playing a search result / url, set as single-item or insert into queue
        if track not in self.queue and not any(t.id == track.id for t in self.queue):
            # replace queue if empty, else insert after current
            if not self.queue:
                self.queue = [track]
                self.index = 0
            else:
                insert_at = min(self.index + 1, len(self.queue))
                self.queue.insert(insert_at, track)
                self.index = insert_at
        else:
            for i, t in enumerate(self.queue):
                if t.id == track.id:
                    self.index = i
                    break
        if self.shuffle:
            self._rebuild_shuffle()
        self._play_track(track, from_queue=True)

    def cmd_add(self, args: list[str]) -> None:
        track = self._resolve_track(args)
        if not track:
            console.print("[yellow]Dùng: add <n|url>[/]")
            return
        if any(t.id == track.id for t in self.queue):
            console.print("[dim]Đã có trong queue.[/]")
            return
        self.queue.append(track)
        if self.shuffle:
            self._rebuild_shuffle()
        console.print(f"[green]+queue[/] {track.display()}  (#{len(self.queue)})")
        self._persist()

    def cmd_queue(self, args: list[str]) -> None:
        if not self.queue:
            console.print("[dim]Queue trống.[/]")
            return
        table = Table(title=f"Queue  (shuffle={'on' if self.shuffle else 'off'})")
        table.add_column("#", width=4)
        table.add_column("")
        table.add_column("Title")
        table.add_column("Artist")
        for i, t in enumerate(self.queue):
            mark = "▶" if i == self.index else ""
            style = "bold magenta" if i == self.index else ""
            table.add_row(str(i + 1), mark, Text(t.title, style=style), t.uploader or "—")
        console.print(table)

    def cmd_clear(self, args: list[str]) -> None:
        self.queue = []
        self.index = 0
        self._shuffle_order = []
        self.player.stop()
        self._persist()
        console.print("[dim]Đã xóa queue.[/]")

    def cmd_next(self, args: list[str]) -> None:
        if not self.queue:
            console.print("[dim]Queue trống.[/]")
            return
        if self.shuffle:
            if not self._shuffle_order:
                self._rebuild_shuffle()
            try:
                pos = self._shuffle_order.index(self.index)
            except ValueError:
                pos = -1
            if pos + 1 >= len(self._shuffle_order):
                console.print("[dim]Hết queue.[/]")
                return
            self.index = self._shuffle_order[pos + 1]
        else:
            if self.index + 1 >= len(self.queue):
                console.print("[dim]Hết queue.[/]")
                return
            self.index += 1
        self._play_track(self.queue[self.index], from_queue=True)

    def cmd_prev(self, args: list[str]) -> None:
        if not self.queue:
            console.print("[dim]Queue trống.[/]")
            return
        if self.shuffle and self._shuffle_order:
            try:
                pos = self._shuffle_order.index(self.index)
            except ValueError:
                pos = 0
            if pos <= 0:
                console.print("[dim]Đầu queue.[/]")
                return
            self.index = self._shuffle_order[pos - 1]
        else:
            if self.index <= 0:
                console.print("[dim]Đầu queue.[/]")
                return
            self.index -= 1
        self._play_track(self.queue[self.index], from_queue=True)

    def cmd_pause(self, args: list[str]) -> None:
        if self.player._backend == "mpv":
            console.print("[yellow]Pause chỉ hỗ trợ backend pygame (không có mpv IPC). Dùng stop/play.[/]")
            return
        self.player.pause()
        console.print("[dim]Paused[/]")

    def cmd_resume(self, args: list[str]) -> None:
        if self.player._backend == "mpv":
            console.print("[yellow]Resume chỉ hỗ trợ backend pygame.[/]")
            return
        self.player.resume()
        console.print("[dim]Resumed[/]")

    def cmd_stop(self, args: list[str]) -> None:
        self._auto_advance = False
        self.player.stop()
        self._auto_advance = True
        console.print("[dim]Stopped[/]")

    def cmd_shuffle(self, args: list[str]) -> None:
        if not args:
            console.print(f"shuffle = {'on' if self.shuffle else 'off'}")
            return
        val = args[0].lower()
        if val in ("on", "1", "true", "yes"):
            self.shuffle = True
            self._rebuild_shuffle()
            console.print("[green]shuffle on[/]")
        elif val in ("off", "0", "false", "no"):
            self.shuffle = False
            self._shuffle_order = []
            console.print("[dim]shuffle off[/]")
        else:
            console.print("[yellow]Dùng: shuffle on|off[/]")
        self._persist()

    def cmd_vol(self, args: list[str]) -> None:
        if not args:
            console.print(f"volume = {int(self.player.volume * 100)}%")
            return
        try:
            v = int(args[0])
        except ValueError:
            console.print("[yellow]Dùng: vol <0-100>[/]")
            return
        self.player.set_volume(v / 100.0)
        self._persist()
        console.print(f"volume = {v}%")

    def cmd_now(self, args: list[str]) -> None:
        console.print(self.player.status_line())
        if self.player.current and self.store.is_favorite(self.player.current.id):
            console.print("[magenta]♥ favorite[/]")

    def cmd_history(self, args: list[str]) -> None:
        self._print_tracks(self.store.history[:30], "History (gần đây)")

    def cmd_fav(self, args: list[str]) -> None:
        track = self._resolve_track(args) if args else self.player.current
        if not track:
            console.print("[yellow]Không có bài để fav.[/]")
            return
        now = self.store.toggle_favorite(track)
        self.store.save()
        console.print(f"[magenta]{'♥ added' if now else '♡ removed'}[/] {track.title}")

    def cmd_favs(self, args: list[str]) -> None:
        self.results = list(self.store.favorites)
        self._print_tracks(self.results, "Favorites")
        if self.results:
            console.print("[dim]play <n> để phát từ list này[/]")

    def cmd_like(self, args: list[str]) -> None:
        track = self.player.current
        if not track:
            console.print("[yellow]Không có bài đang phát.[/]")
            return
        self.store.like(track)
        self.store.save()
        console.print(f"[green]👍[/] {track.title}")

    def cmd_dislike(self, args: list[str]) -> None:
        track = self.player.current
        if not track:
            console.print("[yellow]Không có bài đang phát.[/]")
            return
        self.store.dislike(track)
        self.store.save()
        console.print(f"[red]👎[/] {track.title}")
        # skip to next
        self.cmd_next([])

    def cmd_likes(self, args: list[str]) -> None:
        self.results = list(self.store.likes)
        self._print_tracks(self.results, "Likes")

    def cmd_dislikes(self, args: list[str]) -> None:
        self.results = list(self.store.dislikes)
        self._print_tracks(self.results, "Dislikes")

    def cmd_pl(self, args: list[str]) -> None:
        if not args:
            console.print("[yellow]pl list|create|add|play|del|show …[/]")
            return
        sub = args[0].lower()
        rest = args[1:]
        if sub == "list":
            if not self.store.playlists:
                console.print("[dim]Chưa có playlist.[/]")
                return
            for name, pl in self.store.playlists.items():
                console.print(f"  [cyan]{name}[/]  ({len(pl.tracks)} tracks)")
            return
        if sub == "create":
            if not rest:
                console.print("[yellow]pl create <name>[/]")
                return
            name = " ".join(rest)
            self.store.ensure_playlist(name)
            self.store.save()
            console.print(f"[green]Created[/] playlist [cyan]{name}[/]")
            return
        if sub == "add":
            if not rest:
                console.print("[yellow]pl add <name> [n][/]")
                return
            # last token digit? → track from results; else all rest is name, use current
            if rest[-1].isdigit() and len(rest) >= 2:
                name = " ".join(rest[:-1])
                track = self._resolve_track([rest[-1]])
            else:
                name = " ".join(rest)
                track = self.player.current
            if not track:
                console.print("[yellow]Không có bài để add.[/]")
                return
            self.store.playlist_add(name, track)
            self.store.save()
            console.print(f"[green]+[/] {track.title} → [cyan]{name}[/]")
            return
        if sub == "play":
            if not rest:
                console.print("[yellow]pl play <name>[/]")
                return
            name = " ".join(rest)
            pl = self.store.playlists.get(name)
            if not pl or not pl.tracks:
                console.print(f"[red]Playlist trống / không tồn tại: {name}[/]")
                return
            self.queue = list(pl.tracks)
            self.index = 0
            if self.shuffle:
                self._rebuild_shuffle()
                self.index = self._shuffle_order[0] if self._shuffle_order else 0
            self._play_track(self.queue[self.index], from_queue=True)
            return
        if sub in ("del", "delete", "rm"):
            if not rest:
                console.print("[yellow]pl del <name>[/]")
                return
            name = " ".join(rest)
            if self.store.playlist_delete(name):
                self.store.save()
                console.print(f"[dim]Deleted[/] {name}")
            else:
                console.print(f"[red]Không thấy playlist {name}[/]")
            return
        if sub == "show":
            if not rest:
                console.print("[yellow]pl show <name>[/]")
                return
            name = " ".join(rest)
            pl = self.store.playlists.get(name)
            if not pl:
                console.print(f"[red]Không thấy playlist {name}[/]")
                return
            self.results = list(pl.tracks)
            self._print_tracks(self.results, f"Playlist: {name}")
            return
        console.print("[yellow]pl list|create|add|play|del|show[/]")

    def cmd_lyrics(self, args: list[str]) -> None:
        track = self.player.current
        if not track:
            console.print("[yellow]Không có bài đang phát.[/]")
            return
        console.print(f"[dim]Đang tìm lyrics: {track.title}…[/]")
        text = youtube.fetch_lyrics(track)
        if not text:
            console.print("[red]Không tìm thấy lyrics.[/]")
            return
        console.print(Panel(text, title=track.title, border_style="blue"))

    def cmd_resume_session(self, args: list[str]) -> None:
        q = list(self.store.session.get("queue") or [])
        if not q:
            console.print("[dim]Không có session cũ.[/]")
            return
        self.queue = q
        self.index = int(self.store.session.get("index") or 0)
        self.shuffle = bool(self.store.session.get("shuffle"))
        if self.index >= len(self.queue):
            self.index = 0
        if self.shuffle:
            self._rebuild_shuffle()
        console.print(f"[green]Restored[/] {len(self.queue)} tracks, index={self.index + 1}")
        self._play_track(self.queue[self.index], from_queue=True)

    def cmd_save(self, args: list[str]) -> None:
        self._persist()
        console.print(f"[dim]Saved → {self.store.path}[/]")

    def cmd_quit(self, args: list[str]) -> None:
        self._auto_advance = False
        self._persist()
        self.player.stop()
        console.print("[cyan]Bye![/]")
        raise SystemExit(0)

    # ---------- REPL ----------

    def run(self) -> None:
        console.print(
            Panel.fit(
                f"[bold magenta]YTM[/] v{__version__}  —  YouTube Music CLI\n"
                f"[dim]Gõ help · data: {self.store.path}[/]",
                border_style="magenta",
            )
        )
        if self.queue:
            console.print(
                f"[dim]Session: {len(self.queue)} trong queue — "
                f"gõ [bold]resume-session[/] để phát tiếp[/]"
            )

        while True:
            try:
                line = console.input("[bold magenta]ytm>[/] ").strip()
            except (EOFError, KeyboardInterrupt):
                console.print()
                self.cmd_quit([])
                return
            if not line:
                continue
            try:
                parts = shlex.split(line)
            except ValueError as e:
                console.print(f"[red]Parse lỗi:[/] {e}")
                continue
            cmd, *args = parts
            handler = self.commands.get(cmd.lower())
            if not handler:
                console.print(f"[red]Lệnh lạ:[/] {cmd}  — gõ help")
                continue
            try:
                handler(args)
            except SystemExit:
                raise
            except Exception as e:
                console.print(f"[red]Lỗi:[/] {e}")


def main() -> None:
    App().run()


if __name__ == "__main__":
    main()
