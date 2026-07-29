/* YTM Web Player — HTML5 audio via local yt-dlp cache (no YouTube embed) */
(() => {
  const state = {
    results: [],
    queue: [],
    index: -1,
    shuffle: false,
    shuffleOrder: [],
    volume: 70,
    favorites: [],
    history: [],
    likes: [],
    dislikes: [],
    playlists: {},
    activePlaylist: null,
    isPlaying: false,
    duration: 0,
    loadingId: null,
    loadToken: 0,
  };

  const audio = new Audio();
  audio.preload = "auto";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add("hidden"), 2800);
  }

  function setStatus(text, loading = false) {
    const el = $("#play-status");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("loading", !!loading);
  }

  function thumb(t) {
    return t.thumbnail || (t.id ? `https://i.ytimg.com/vi/${t.id}/hqdefault.jpg` : "");
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    const h = Math.floor(m / 60);
    if (h) return `${h}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function isFav(id) {
    return state.favorites.some((t) => t.id === id);
  }

  function currentTrack() {
    if (state.index < 0 || state.index >= state.queue.length) return null;
    return state.queue[state.index];
  }

  function rebuildShuffle() {
    const n = state.queue.length;
    const order = [...Array(n).keys()];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    if (state.index >= 0 && order.includes(state.index)) {
      order.splice(order.indexOf(state.index), 1);
      order.unshift(state.index);
    }
    state.shuffleOrder = order;
  }

  async function persistSession() {
    try {
      await api("/api/session", {
        method: "POST",
        body: JSON.stringify({
          queue: state.queue,
          index: Math.max(0, state.index),
          shuffle: state.shuffle,
          volume: state.volume / 100,
        }),
      });
    } catch (_) {}
  }

  async function loadState() {
    const data = await api("/api/state");
    state.history = data.history || [];
    state.likes = data.likes || [];
    state.dislikes = data.dislikes || [];
    state.favorites = data.favorites || [];
    state.playlists = data.playlists || {};
    const sess = data.session || {};
    state.queue = sess.queue || [];
    state.index = typeof sess.index === "number" ? sess.index : -1;
    state.shuffle = !!sess.shuffle;
    state.volume = Math.round((sess.volume ?? 0.7) * 100);
    $("#volume").value = state.volume;
    audio.volume = state.volume / 100;
    $("#btn-shuffle").textContent = state.shuffle ? "Shuffle on" : "Shuffle off";
    $("#btn-shuffle").classList.toggle("on", state.shuffle);
    if (sess.last_query) {
      $("#search-input").placeholder = `Gần đây: ${sess.last_query}`;
    }
    if (state.queue.length && state.index < 0) state.index = 0;
    if (state.shuffle) rebuildShuffle();
    renderAll();
  }

  function setView(name) {
    $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function cardHTML(t) {
    const img = thumb(t);
    return `
      <article class="card" data-id="${t.id}">
        <div class="card-thumb" style="background-image:url('${img}')" data-act="play"></div>
        <div class="card-body">
          <div class="card-title">${escapeHtml(t.title)}</div>
          <div class="card-sub">${escapeHtml(t.uploader || "YouTube")} · ${t.duration_str || fmt(t.duration)}</div>
          <div class="card-actions">
            <button type="button" data-act="play">Phát</button>
            <button type="button" data-act="queue">+ Queue</button>
            <button type="button" data-act="fav">${isFav(t.id) ? "♥" : "♡"}</button>
          </div>
        </div>
      </article>`;
  }

  function rowHTML(t, i, { active = false } = {}) {
    return `
      <div class="track-row ${active ? "active" : ""}" data-id="${t.id}" data-idx="${i}">
        <div class="idx">${i + 1}</div>
        <img src="${thumb(t)}" alt="" loading="lazy" />
        <div>
          <div class="t-title">${escapeHtml(t.title)}</div>
          <div class="t-sub">${escapeHtml(t.uploader || "YouTube")}</div>
        </div>
        <div class="dur">${t.duration_str || fmt(t.duration)}</div>
        <div class="ops">
          <button type="button" data-act="play" title="Play">▶</button>
          <button type="button" data-act="queue" title="Add">＋</button>
          <button type="button" data-act="fav" title="Fav">${isFav(t.id) ? "♥" : "♡"}</button>
        </div>
      </div>`;
  }

  function bindTrackActions(root, listGetter) {
    root.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const row = btn.closest("[data-id]");
        const id = row?.dataset.id;
        const list = typeof listGetter === "function" ? listGetter() : listGetter;
        const track = list.find((t) => t.id === id);
        if (!track) return;
        const act = btn.dataset.act;
        if (act === "play") playTrack(track, { enqueueIfMissing: true });
        if (act === "queue") addToQueue(track);
        if (act === "fav") toggleFav(track);
      });
    });
  }

  function renderResults() {
    const grid = $("#track-grid");
    if (!state.results.length) {
      grid.innerHTML = `<div class="empty-state">Search bài hát hoặc dán link YouTube ở ô trên.</div>`;
      return;
    }
    grid.innerHTML = state.results.map((t) => cardHTML(t)).join("");
    bindTrackActions(grid, () => state.results);
  }

  function renderQueue() {
    $("#queue-meta").textContent = `${state.queue.length} bài · index ${state.index + 1 || 0}`;
    const list = $("#queue-list");
    if (!state.queue.length) {
      list.innerHTML = `<div class="empty-state">Queue trống — search rồi bấm + Queue.</div>`;
      return;
    }
    list.innerHTML = state.queue
      .map((t, i) => rowHTML(t, i, { active: i === state.index }))
      .join("");
    bindTrackActions(list, () => state.queue);
    list.querySelectorAll(".track-row").forEach((row) => {
      row.querySelector('[data-act="play"]')?.addEventListener("click", () => {
        playAtIndex(Number(row.dataset.idx));
      });
    });
  }

  function renderFavs() {
    const list = $("#fav-list");
    if (!state.favorites.length) {
      list.innerHTML = `<div class="empty-state">Chưa có favorite.</div>`;
      return;
    }
    list.innerHTML = state.favorites.map((t, i) => rowHTML(t, i)).join("");
    bindTrackActions(list, () => state.favorites);
  }

  function renderHistory() {
    const list = $("#history-list");
    if (!state.history.length) {
      list.innerHTML = `<div class="empty-state">Chưa có lịch sử.</div>`;
      return;
    }
    list.innerHTML = state.history.map((t, i) => rowHTML(t, i)).join("");
    bindTrackActions(list, () => state.history);
  }

  function renderPlaylists() {
    const panel = $("#playlist-panel");
    const names = Object.keys(state.playlists);
    if (!names.length) {
      panel.innerHTML = `<div class="empty-state" style="grid-column:1/-1">Chưa có playlist. Tạo ở ô trên.</div>`;
      return;
    }
    if (!state.activePlaylist || !state.playlists[state.activePlaylist]) {
      state.activePlaylist = names[0];
    }
    const pl = state.playlists[state.activePlaylist];
    panel.innerHTML = `
      <div class="pl-list">
        ${names
          .map(
            (n) =>
              `<button class="pl-item ${n === state.activePlaylist ? "active" : ""}" data-pl="${escapeHtml(n)}">${escapeHtml(n)} <span class="muted">(${state.playlists[n].tracks.length})</span></button>`
          )
          .join("")}
      </div>
      <div class="pl-detail">
        <div class="row" style="margin-bottom:12px">
          <div>
            <strong>${escapeHtml(state.activePlaylist)}</strong>
            <div class="muted">${pl.tracks.length} bài</div>
          </div>
          <div class="actions row gap">
            <button type="button" id="pl-play-all">Phát tất cả</button>
            <button type="button" id="pl-add-current" class="chip">+ bài đang phát</button>
            <button type="button" id="pl-delete" class="chip danger">Xóa playlist</button>
          </div>
        </div>
        <div id="pl-tracks" class="track-list">
          ${
            pl.tracks.length
              ? pl.tracks.map((t, i) => rowHTML(t, i)).join("")
              : `<div class="empty-state">Playlist trống</div>`
          }
        </div>
      </div>`;

    panel.querySelectorAll("[data-pl]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.activePlaylist = btn.dataset.pl;
        renderPlaylists();
      });
    });
    const tracksRoot = panel.querySelector("#pl-tracks");
    if (tracksRoot) bindTrackActions(tracksRoot, () => pl.tracks);

    $("#pl-play-all")?.addEventListener("click", () => {
      if (!pl.tracks.length) return;
      state.queue = [...pl.tracks];
      state.index = 0;
      if (state.shuffle) rebuildShuffle();
      playAtIndex(0);
      persistSession();
      renderQueue();
      toast(`Phát playlist ${state.activePlaylist}`);
    });
    $("#pl-add-current")?.addEventListener("click", async () => {
      const t = currentTrack();
      if (!t) return toast("Chưa có bài đang phát");
      await api(`/api/playlists/${encodeURIComponent(state.activePlaylist)}/add`, {
        method: "POST",
        body: JSON.stringify({ track: t }),
      });
      await loadState();
      renderPlaylists();
      toast("Đã thêm vào playlist");
    });
    $("#pl-delete")?.addEventListener("click", async () => {
      if (!confirm(`Xóa playlist "${state.activePlaylist}"?`)) return;
      await api(`/api/playlists/${encodeURIComponent(state.activePlaylist)}`, {
        method: "DELETE",
      });
      state.activePlaylist = null;
      await loadState();
      toast("Đã xóa playlist");
    });
  }

  function renderNow() {
    const t = currentTrack();
    const title = $("#now-title");
    const artist = $("#now-artist");
    const th = $("#now-thumb");
    if (!t) {
      title.textContent = "Chưa phát";
      artist.textContent = "—";
      th.classList.add("empty");
      th.style.backgroundImage = "";
      $("#btn-fav").textContent = "♡";
      $("#btn-fav").classList.remove("on");
      $("#btn-play").textContent = "▶";
      return;
    }
    title.textContent = t.title;
    artist.textContent = t.uploader || "YouTube";
    th.classList.remove("empty");
    th.style.backgroundImage = `url('${thumb(t)}')`;
    const fav = isFav(t.id);
    $("#btn-fav").textContent = fav ? "♥" : "♡";
    $("#btn-fav").classList.toggle("on", fav);
    $("#btn-play").textContent = state.isPlaying ? "⏸" : "▶";
  }

  function renderAll() {
    renderResults();
    renderQueue();
    renderFavs();
    renderHistory();
    renderPlaylists();
    renderNow();
  }

  function addToQueue(track) {
    if (state.queue.some((t) => t.id === track.id)) {
      toast("Đã có trong queue");
      return;
    }
    state.queue.push(track);
    if (state.shuffle) rebuildShuffle();
    if (state.index < 0) state.index = 0;
    renderQueue();
    persistSession();
    toast(`+ queue: ${track.title}`);
  }

  async function toggleFav(track) {
    const res = await api("/api/favorite", {
      method: "POST",
      body: JSON.stringify({ track }),
    });
    if (res.favorited) {
      if (!state.favorites.some((t) => t.id === track.id)) state.favorites.unshift(track);
    } else {
      state.favorites = state.favorites.filter((t) => t.id !== track.id);
    }
    renderAll();
    toast(res.favorited ? "♥ Favorite" : "♡ Bỏ favorite");
  }

  function playTrack(track, { enqueueIfMissing = false } = {}) {
    let idx = state.queue.findIndex((t) => t.id === track.id);
    if (idx < 0 && enqueueIfMissing) {
      state.queue.push(track);
      idx = state.queue.length - 1;
      if (state.shuffle) rebuildShuffle();
    }
    if (idx < 0) {
      state.queue = [track];
      idx = 0;
    }
    state.index = idx;
    playAtIndex(idx);
    persistSession();
  }

  function playAtIndex(i) {
    if (i < 0 || i >= state.queue.length) return;
    state.index = i;
    const track = state.queue[i];
    renderNow();
    renderQueue();
    loadAudio(track);
    api("/api/history", { method: "POST", body: JSON.stringify({ track }) }).catch(() => {});
    state.history = [track, ...state.history.filter((t) => t.id !== track.id)].slice(0, 50);
  }

  async function waitReady(videoId, token) {
    const started = Date.now();
    while (Date.now() - started < 180000) {
      if (token !== state.loadToken) return null;
      const st = await api(`/api/audio/${encodeURIComponent(videoId)}/status`);
      if (st.status === "ready") return st.url;
      if (st.status === "error") throw new Error(st.error || "Tải audio lỗi");
      await new Promise((r) => setTimeout(r, 800));
    }
    throw new Error("Timeout tải audio");
  }

  async function loadAudio(track) {
    const token = ++state.loadToken;
    state.loadingId = track.id;
    state.isPlaying = false;
    audio.pause();
    audio.removeAttribute("src");
    renderNow();
    setStatus("Đang tải audio (lần đầu có thể 10–40s)…", true);
    toast("Đang chuẩn bị audio…");

    try {
      await api(`/api/audio/${encodeURIComponent(track.id)}/prepare`, {
        method: "POST",
        body: JSON.stringify({ title: track.title, uploader: track.uploader }),
      });
      const url = await waitReady(track.id, token);
      if (!url || token !== state.loadToken) return;

      audio.src = url + `?t=${Date.now()}`;
      audio.volume = state.volume / 100;
      await audio.play();
      state.isPlaying = true;
      state.loadingId = null;
      setStatus("Đang phát (audio local)", false);
      renderNow();
    } catch (err) {
      if (token !== state.loadToken) return;
      state.loadingId = null;
      state.isPlaying = false;
      setStatus("Lỗi phát", false);
      toast(err.message || "Không phát được");
      renderNow();
    }
  }

  function nextTrack() {
    if (!state.queue.length) return;
    if (state.shuffle) {
      if (!state.shuffleOrder.length) rebuildShuffle();
      const pos = state.shuffleOrder.indexOf(state.index);
      if (pos < 0 || pos >= state.shuffleOrder.length - 1) {
        toast("Hết queue");
        return;
      }
      playAtIndex(state.shuffleOrder[pos + 1]);
    } else {
      if (state.index >= state.queue.length - 1) {
        toast("Hết queue");
        state.isPlaying = false;
        renderNow();
        return;
      }
      playAtIndex(state.index + 1);
    }
    persistSession();
  }

  function prevTrack() {
    if (!state.queue.length) return;
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    if (state.shuffle && state.shuffleOrder.length) {
      const pos = state.shuffleOrder.indexOf(state.index);
      if (pos <= 0) return toast("Đầu queue");
      playAtIndex(state.shuffleOrder[pos - 1]);
    } else {
      if (state.index <= 0) return toast("Đầu queue");
      playAtIndex(state.index - 1);
    }
    persistSession();
  }

  // audio events
  audio.addEventListener("timeupdate", () => {
    const cur = audio.currentTime || 0;
    const dur = audio.duration || 0;
    if (Number.isFinite(dur) && dur > 0) {
      state.duration = dur;
      $("#time-cur").textContent = fmt(cur);
      $("#time-dur").textContent = fmt(dur);
      $("#seek").value = Math.floor((cur / dur) * 1000);
    }
  });
  audio.addEventListener("ended", () => nextTrack());
  audio.addEventListener("play", () => {
    state.isPlaying = true;
    renderNow();
  });
  audio.addEventListener("pause", () => {
    if (!audio.ended) {
      state.isPlaying = false;
      renderNow();
    }
  });
  audio.addEventListener("error", () => {
    if (state.loadingId) return;
    toast("Lỗi audio element");
    setStatus("Lỗi audio", false);
  });

  // UI events
  $$(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });

  $("#search-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("#search-input").value.trim();
    if (!q) return;
    $("#list-title").textContent = "Kết quả";
    $("#list-sub").textContent = `Đang tìm “${q}”…`;
    setView("home");
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
      state.results = data.tracks || [];
      $("#list-sub").textContent = `${state.results.length} kết quả cho “${q}”`;
      renderResults();
      if (!state.results.length) toast("Không tìm thấy");
    } catch (err) {
      $("#list-sub").textContent = "Lỗi search";
      toast(err.message || "Search lỗi");
    }
  });

  $("#btn-play").addEventListener("click", () => {
    const t = currentTrack();
    if (!t) {
      if (state.queue.length) playAtIndex(Math.max(0, state.index));
      return;
    }
    if (!audio.src || state.loadingId === t.id) {
      loadAudio(t);
      return;
    }
    if (audio.paused) {
      audio.play().catch(() => loadAudio(t));
    } else {
      audio.pause();
    }
  });
  $("#btn-next").addEventListener("click", nextTrack);
  $("#btn-prev").addEventListener("click", prevTrack);

  $("#btn-shuffle").addEventListener("click", () => {
    state.shuffle = !state.shuffle;
    $("#btn-shuffle").textContent = state.shuffle ? "Shuffle on" : "Shuffle off";
    $("#btn-shuffle").classList.toggle("on", state.shuffle);
    if (state.shuffle) rebuildShuffle();
    else state.shuffleOrder = [];
    persistSession();
  });

  $("#btn-clear-queue").addEventListener("click", () => {
    state.queue = [];
    state.index = -1;
    state.shuffleOrder = [];
    state.loadToken++;
    audio.pause();
    audio.removeAttribute("src");
    state.isPlaying = false;
    setStatus("");
    renderAll();
    persistSession();
    toast("Đã xóa queue");
  });

  $("#btn-fav").addEventListener("click", () => {
    const t = currentTrack();
    if (t) toggleFav(t);
  });

  $("#btn-like").addEventListener("click", async () => {
    const t = currentTrack();
    if (!t) return;
    await api("/api/like", { method: "POST", body: JSON.stringify({ track: t }) });
    toast("👍 Liked");
  });

  $("#btn-dislike").addEventListener("click", async () => {
    const t = currentTrack();
    if (!t) return;
    await api("/api/dislike", { method: "POST", body: JSON.stringify({ track: t }) });
    toast("👎 Disliked — next");
    nextTrack();
  });

  $("#btn-lyrics").addEventListener("click", async () => {
    const t = currentTrack();
    if (!t) return toast("Chưa có bài đang phát");
    setView("lyrics");
    $("#lyrics-meta").textContent = t.title;
    $("#lyrics-body").textContent = "Đang tải lyrics…";
    try {
      const data = await api(
        `/api/lyrics?id=${encodeURIComponent(t.id)}&title=${encodeURIComponent(t.title)}&uploader=${encodeURIComponent(t.uploader || "")}`
      );
      $("#lyrics-body").textContent = data.lyrics || "Không tìm thấy lyrics.";
    } catch (err) {
      $("#lyrics-body").textContent = err.message || "Lỗi lyrics";
    }
  });

  $("#seek").addEventListener("input", () => {
    if (!state.duration) return;
    audio.currentTime = (Number($("#seek").value) / 1000) * state.duration;
  });

  $("#volume").addEventListener("input", () => {
    state.volume = Number($("#volume").value);
    audio.volume = state.volume / 100;
    persistSession();
  });

  $("#pl-create").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#pl-name").value.trim();
    if (!name) return;
    await api("/api/playlists", { method: "POST", body: JSON.stringify({ name }) });
    $("#pl-name").value = "";
    state.activePlaylist = name;
    await loadState();
    setView("playlists");
    toast(`Tạo playlist ${name}`);
  });

  loadState().catch((e) => toast(e.message || "Không load state"));
})();
