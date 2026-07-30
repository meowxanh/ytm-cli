/* YTM — SoundCloud player (HTML5 audio, no YouTube) */
(() => {
  const STORAGE_KEY = "ytm_sc_v1";
  const STREAM_CACHE_KEY = "ytm_sc_stream_v1";
  const API_KEY = "ytm_stream_api";
  const CLIENT_KEY = "ytm_sc_client";
  const STREAM_TTL_MS = 20 * 60 * 1000;

  const state = {
    results: [],
    queue: [],
    index: -1,
    shuffle: false,
    shuffleOrder: [],
    volume: 70,
    favorites: [],
    history: [],
    playlists: {},
    activePlaylist: null,
    isPlaying: false,
    duration: 0,
    mode: "none",
    loadToken: 0,
    suppressAudioEvents: false,
    streamApi: "",
    streamApiOk: false,
    clientId: "",
  };

  const streamMem = new Map();
  const searchMem = new Map();

  const audio = () => document.getElementById("audio-el");
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  function toast(msg) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add("hidden"), 2800);
  }

  function setStatus(text) {
    const a = $("#play-status");
    const b = $("#np-status");
    if (a) a.textContent = text || "";
    if (b) b.textContent = text || "";
  }

  function thumb(t) {
    if (!t) return "";
    let u = t.thumbnail || "";
    if (u) return u.replace("-large", "-t500x500").replace("-badge", "-t500x500");
    return "";
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    const h = Math.floor(m / 60);
    if (h) return `${h}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function isFav(id) {
    return state.favorites.some((t) => t.id === id);
  }

  function currentTrack() {
    if (state.index < 0 || state.index >= state.queue.length) return null;
    return state.queue[state.index];
  }

  function save() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          queue: state.queue,
          index: state.index,
          shuffle: state.shuffle,
          volume: state.volume,
          favorites: state.favorites,
          history: state.history.slice(0, 100),
          playlists: state.playlists,
        })
      );
    } catch (_) {}
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      state.queue = d.queue || [];
      state.index = typeof d.index === "number" ? d.index : -1;
      state.shuffle = !!d.shuffle;
      state.volume = d.volume ?? 70;
      state.favorites = d.favorites || [];
      state.history = d.history || [];
      state.playlists = d.playlists || {};
    } catch (_) {}
  }

  function loadStreamCacheDisk() {
    try {
      const raw = localStorage.getItem(STREAM_CACHE_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      const now = Date.now();
      Object.entries(obj).forEach(([id, v]) => {
        if (v?.url && v.exp > now) streamMem.set(id, v);
      });
    } catch (_) {}
  }

  function saveStreamCacheDisk() {
    try {
      const now = Date.now();
      const obj = {};
      streamMem.forEach((v, id) => {
        if (v.exp > now) obj[id] = v;
      });
      localStorage.setItem(STREAM_CACHE_KEY, JSON.stringify(obj));
    } catch (_) {}
  }

  function getCachedStream(id) {
    const hit = streamMem.get(id);
    if (hit && hit.exp > Date.now() && hit.url) return hit.url;
    if (hit) streamMem.delete(id);
    return null;
  }

  function setCachedStream(id, url) {
    if (!id || !url) return;
    streamMem.set(id, { url, exp: Date.now() + STREAM_TTL_MS });
    saveStreamCacheDisk();
  }

  function setStreamApi(url) {
    state.streamApi = (url || "").trim().replace(/\/$/, "");
    try {
      if (state.streamApi) localStorage.setItem(API_KEY, state.streamApi);
      else localStorage.removeItem(API_KEY);
    } catch (_) {}
    const input = $("#stream-api-input");
    if (input) input.value = state.streamApi;
  }

  function getStreamApiBases() {
    const bases = [];
    if (state.streamApi) bases.push(state.streamApi.replace(/\/$/, ""));
    bases.push("http://127.0.0.1:8765");
    bases.push("http://localhost:8765");
    return [...new Set(bases.filter(Boolean))];
  }

  function showApiBanner(show) {
    const el = $("#api-banner");
    if (el) el.hidden = !show;
  }

  async function fetchJson(url, timeout = 15000, opts = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal, ...opts });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  function raceOk(promises) {
    return new Promise((resolve, reject) => {
      if (!promises.length) return reject(new Error("empty"));
      let left = promises.length;
      let done = false;
      promises.forEach((p) => {
        Promise.resolve(p)
          .then((v) => {
            if (done) return;
            if (v == null || v === false || (Array.isArray(v) && !v.length)) {
              left -= 1;
              if (left === 0) reject(new Error("all failed"));
              return;
            }
            done = true;
            resolve(v);
          })
          .catch(() => {
            left -= 1;
            if (!done && left === 0) reject(new Error("all failed"));
          });
      });
    });
  }

  // ——— SoundCloud client_id (browser may fail CORS; API server preferred) ———
  async function ensureClientId() {
    if (state.clientId) return state.clientId;
    try {
      const saved = localStorage.getItem(CLIENT_KEY);
      if (saved && saved.length === 32) {
        state.clientId = saved;
        return saved;
      }
    } catch (_) {}

    // Try via our stream API health doesn't return cid; fetch from SC homepage scripts via API search warmup
    // Direct browser extract often blocked — skip if API available
    return state.clientId;
  }

  async function scApiSearch(q) {
    const tasks = getStreamApiBases().map((base) =>
      fetchJson(`${base}/api/search?q=${encodeURIComponent(q)}&limit=15`, 20000).then((data) => {
        const tracks = (data.tracks || []).map(normalize).filter(Boolean);
        if (!tracks.length) throw new Error("empty");
        state.streamApiOk = true;
        state.streamApi = base;
        return tracks;
      })
    );
    return raceOk(tasks);
  }

  async function scApiStream(id) {
    const tasks = getStreamApiBases().map((base) =>
      fetchJson(`${base}/api/stream?id=${encodeURIComponent(id)}`, 25000).then((data) => {
        if (!data?.url) throw new Error("no url");
        state.streamApiOk = true;
        state.streamApi = base;
        return data.url;
      })
    );
    return raceOk(tasks);
  }

  async function scApiCharts() {
    const tasks = getStreamApiBases().map((base) =>
      fetchJson(`${base}/api/charts?kind=trending&genre=all-music`, 20000).then((data) => {
        const tracks = (data.tracks || []).map(normalize).filter(Boolean);
        if (!tracks.length) throw new Error("empty");
        state.streamApiOk = true;
        return tracks;
      })
    );
    return raceOk(tasks);
  }

  function normalize(t) {
    if (!t || !t.id) return null;
    return {
      id: String(t.id),
      title: t.title || "Unknown",
      uploader: t.uploader || "",
      duration: t.duration ?? null,
      duration_str: t.duration != null ? fmt(t.duration) : "--:--",
      thumbnail: t.thumbnail || "",
      permalink_url: t.permalink_url || "",
      source: "soundcloud",
    };
  }

  async function searchTracks(q) {
    q = (q || "").trim();
    if (!q) return [];
    const key = q.toLowerCase();
    const hit = searchMem.get(key);
    if (hit && hit.exp > Date.now()) return hit.tracks;

    try {
      const tracks = await scApiSearch(q);
      searchMem.set(key, { tracks, exp: Date.now() + 5 * 60 * 1000 });
      return tracks;
    } catch (_) {
      throw new Error("Search lỗi — bật Stream API (SoundCloud) · run-stream.ps1 hoặc Render");
    }
  }

  async function resolveAudioUrl(id) {
    const cached = getCachedStream(id);
    if (cached) return cached;
    try {
      const url = await scApiStream(id);
      setCachedStream(id, url);
      return url;
    } catch (_) {
      throw new Error("Không lấy được stream SoundCloud — kiểm tra Stream API");
    }
  }

  async function probeStreamApi() {
    for (const base of getStreamApiBases()) {
      try {
        const data = await fetchJson(`${base}/api/health`, 3000);
        if (data?.ok) {
          state.streamApiOk = true;
          state.streamApi = base;
          return base;
        }
      } catch (_) {}
    }
    state.streamApiOk = false;
    return null;
  }

  // ——— UI helpers (same structure as before) ———
  function toastMsg(msg) {
    toast(msg);
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

  function setLoading(on, text) {
    const el = $("#loading-overlay");
    if (!el) return;
    el.classList.toggle("hidden", !on);
    if (text) $("#loading-text").textContent = text;
  }

  function setView(name) {
    $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    $$(".tabbar .tab").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
    if (name === "search") setTimeout(() => $("#search-input")?.focus(), 120);
  }

  function openNowPlaying() {
    const sheet = $("#np-sheet");
    if (!sheet) return;
    sheet.hidden = false;
    document.body.style.overflow = "hidden";
    renderNow();
  }

  function closeNowPlaying() {
    const sheet = $("#np-sheet");
    if (!sheet) return;
    sheet.hidden = true;
    document.body.style.overflow = "";
  }

  function openIosHelp() {
    const sheet = $("#ios-sheet");
    if (!sheet) return;
    sheet.classList.remove("hidden");
    const urlEl = $("#ios-url");
    if (urlEl) urlEl.textContent = location.href.split("#")[0];
  }

  function rowHTML(t, i, { active = false } = {}) {
    const art = thumb(t) || "";
    return `
      <div class="track-row ${active ? "active" : ""}" data-id="${t.id}" data-idx="${i}">
        <div class="art" style="${art ? `background-image:url('${art}')` : ""};background-size:cover;background-position:center"></div>
        <div class="meta">
          <div class="t-title">${escapeHtml(t.title)}</div>
          <div class="t-sub">${escapeHtml(t.uploader || "SoundCloud")} · ${t.duration_str || fmt(t.duration)}</div>
        </div>
        <div class="row-actions">
          <button type="button" data-act="queue">＋</button>
          <button type="button" data-act="fav">${isFav(t.id) ? "♥" : "♡"}</button>
          <button type="button" data-act="play">▶</button>
        </div>
      </div>`;
  }

  function bindList(root, listGetter) {
    if (!root) return;
    root.querySelectorAll(".track-row").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("[data-act]")) return;
        const list = typeof listGetter === "function" ? listGetter() : listGetter;
        const track = list.find((t) => t.id === row.dataset.id);
        if (!track) return;
        if (row.dataset.idx != null && list === state.queue) playAtIndex(Number(row.dataset.idx));
        else playTrack(track, { enqueueIfMissing: true });
      });
    });
    root.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const row = btn.closest("[data-id]");
        const list = typeof listGetter === "function" ? listGetter() : listGetter;
        const track = list.find((t) => t.id === row?.dataset.id);
        if (!track) return;
        if (btn.dataset.act === "play") playTrack(track, { enqueueIfMissing: true });
        if (btn.dataset.act === "queue") addToQueue(track);
        if (btn.dataset.act === "fav") toggleFav(track);
      });
    });
  }

  function renderResults() {
    const html = state.results.length
      ? state.results.map((t, i) => rowHTML(t, i)).join("")
      : `<div class="empty-state">Search SoundCloud hoặc chọn mood.</div>`;
    ["#track-grid", "#search-results"].forEach((sel) => {
      const el = $(sel);
      if (!el) return;
      el.innerHTML = html;
      bindList(el, () => state.results);
    });
  }

  function renderQueue() {
    const meta = $("#queue-meta");
    if (meta) meta.textContent = `${state.queue.length} bài · #${state.index + 1 || 0}`;
    const list = $("#queue-list");
    if (!list) return;
    if (!state.queue.length) {
      list.innerHTML = `<div class="empty-state">Queue trống</div>`;
      return;
    }
    list.innerHTML = state.queue.map((t, i) => rowHTML(t, i, { active: i === state.index })).join("");
    bindList(list, () => state.queue);
  }

  function renderFavs() {
    const list = $("#fav-list");
    if (!list) return;
    list.innerHTML = state.favorites.length
      ? state.favorites.map((t, i) => rowHTML(t, i)).join("")
      : `<div class="empty-state">Chưa có yêu thích</div>`;
    bindList(list, () => state.favorites);
  }

  function renderHistory() {
    const list = $("#history-list");
    if (!list) return;
    list.innerHTML = state.history.length
      ? state.history.map((t, i) => rowHTML(t, i)).join("")
      : `<div class="empty-state">Chưa có lịch sử</div>`;
    bindList(list, () => state.history);
  }

  function renderPlaylists() {
    const panel = $("#playlist-panel");
    if (!panel) return;
    const names = Object.keys(state.playlists);
    if (!names.length) {
      panel.innerHTML = `<div class="empty-state">Tạo playlist ở ô trên</div>`;
      return;
    }
    if (!state.activePlaylist || !state.playlists[state.activePlaylist]) state.activePlaylist = names[0];
    const pl = state.playlists[state.activePlaylist] || { tracks: [] };
    panel.innerHTML = `
      <div class="pl-list">
        ${names
          .map(
            (n) =>
              `<button class="pl-item ${n === state.activePlaylist ? "active" : ""}" data-pl="${escapeHtml(n)}">${escapeHtml(n)} · ${(state.playlists[n].tracks || []).length}</button>`
          )
          .join("")}
      </div>
      <div class="pl-detail">
        <strong>${escapeHtml(state.activePlaylist)}</strong>
        <div class="actions">
          <button type="button" id="pl-play-all">Phát tất cả</button>
          <button type="button" id="pl-add-current">+ đang phát</button>
          <button type="button" id="pl-delete">Xóa</button>
        </div>
        <div id="pl-tracks" class="track-list ios-list">
          ${(pl.tracks || []).length ? pl.tracks.map((t, i) => rowHTML(t, i)).join("") : `<div class="empty-state">Trống</div>`}
        </div>
      </div>`;
    panel.querySelectorAll("[data-pl]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.activePlaylist = btn.dataset.pl;
        renderPlaylists();
      });
    });
    bindList(panel.querySelector("#pl-tracks"), () => pl.tracks || []);
    $("#pl-play-all")?.addEventListener("click", () => {
      if (!pl.tracks?.length) return;
      state.queue = [...pl.tracks];
      state.index = 0;
      if (state.shuffle) rebuildShuffle();
      playAtIndex(0);
      save();
    });
    $("#pl-add-current")?.addEventListener("click", () => {
      const t = currentTrack();
      if (!t) return toast("Chưa có bài");
      const name = state.activePlaylist;
      if (!state.playlists[name]) state.playlists[name] = { name, tracks: [] };
      if (!state.playlists[name].tracks.some((x) => x.id === t.id)) state.playlists[name].tracks.push(t);
      save();
      renderPlaylists();
      toast("Đã thêm");
    });
    $("#pl-delete")?.addEventListener("click", () => {
      if (!confirm(`Xóa “${state.activePlaylist}”?`)) return;
      delete state.playlists[state.activePlaylist];
      state.activePlaylist = null;
      save();
      renderPlaylists();
    });
  }

  function setArt(el, url) {
    if (!el) return;
    if (url) {
      el.style.backgroundImage = `url('${url}')`;
      el.classList.remove("empty");
    } else {
      el.style.backgroundImage = "";
      el.classList.add("empty");
    }
  }

  function renderNow() {
    const t = currentTrack();
    const mini = $("#mini-player");
    if (mini) mini.hidden = false;
    const title = t?.title || "Chưa phát";
    const artist = t?.uploader || (t ? "SoundCloud" : "Chạm để mở");
    const art = thumb(t);
    const playLabel = state.isPlaying ? "⏸" : "▶";
    const favOn = t ? isFav(t.id) : false;
    const setTxt = (sel, v) => {
      const el = $(sel);
      if (el) el.textContent = v;
    };
    setTxt("#now-title", title);
    setTxt("#now-artist", artist);
    setTxt("#np-title", title);
    setTxt("#np-artist", artist);
    setTxt(".d-title", title);
    setTxt(".d-artist", artist);
    setArt($("#now-thumb"), art);
    setArt($("#np-art"), art);
    setArt($(".d-thumb"), art);
    setArt($("#np-bg"), art);
    setTxt("#btn-play", playLabel);
    setTxt("#btn-np-play", playLabel);
    setTxt(".d-play", playLabel);
    ["#btn-fav", "#btn-np-fav"].forEach((sel) => {
      const el = $(sel);
      if (!el) return;
      el.textContent = favOn ? "♥" : "♡";
      el.classList.toggle("on", favOn);
    });
    const sh = $("#btn-shuffle");
    if (sh) {
      sh.textContent = state.shuffle ? "Shuffle on" : "Shuffle";
      sh.classList.toggle("on", state.shuffle);
    }
    $("#btn-np-shuffle")?.classList.toggle("on", state.shuffle);
    const resume = $("#btn-resume-session");
    if (resume) {
      if (state.queue.length) {
        resume.hidden = false;
        const rt = $("#resume-title");
        const cur = state.queue[Math.max(0, state.index)] || state.queue[0];
        if (rt) rt.textContent = cur?.title || `${state.queue.length} bài`;
      } else resume.hidden = true;
    }
    const a = audio();
    if (a) a.volume = state.volume / 100;
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
    if (state.queue.some((t) => t.id === track.id)) return toast("Đã có trong queue");
    state.queue.push(track);
    if (state.shuffle) rebuildShuffle();
    if (state.index < 0) state.index = 0;
    save();
    renderQueue();
    renderNow();
    prefetchStream(track.id);
    toast("＋ Queue");
  }

  function toggleFav(track) {
    if (isFav(track.id)) {
      state.favorites = state.favorites.filter((t) => t.id !== track.id);
      toast("♡ Bỏ thích");
    } else {
      state.favorites.unshift(track);
      toast("♥ Đã thích");
    }
    save();
    renderAll();
  }

  function playTrack(track, { enqueueIfMissing = false } = {}) {
    let idx = state.queue.findIndex((t) => t.id === track.id);
    if (idx < 0 && enqueueIfMissing && state.results?.length) {
      const start = state.results.findIndex((t) => t.id === track.id);
      if (start >= 0) {
        const existing = new Set(state.queue.map((t) => t.id));
        for (const t of state.results.slice(start)) {
          if (!existing.has(t.id)) {
            state.queue.push(t);
            existing.add(t.id);
          }
        }
        idx = state.queue.findIndex((t) => t.id === track.id);
        if (state.shuffle) rebuildShuffle();
      }
    }
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
    save();
  }

  function stopAll() {
    const a = audio();
    if (!a) return;
    state.suppressAudioEvents = true;
    try {
      a.pause();
      a.removeAttribute("src");
      a.src = "";
    } catch (_) {}
    clearTimeout(stopAll._t);
    stopAll._t = setTimeout(() => {
      state.suppressAudioEvents = false;
    }, 400);
  }

  function updateMediaSession(track) {
    if (!("mediaSession" in navigator) || !track) return;
    try {
      const art = thumb(track);
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || "YTM",
        artist: track.uploader || "SoundCloud",
        album: "SoundCloud",
        artwork: art ? [{ src: art, sizes: "500x500", type: "image/jpeg" }] : [],
      });
      navigator.mediaSession.playbackState = state.isPlaying ? "playing" : "paused";
    } catch (_) {}
  }

  function bindMediaSessionHandlers() {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler("play", () => togglePlay());
      navigator.mediaSession.setActionHandler("pause", () => togglePlay());
      navigator.mediaSession.setActionHandler("previoustrack", () => prevTrack());
      navigator.mediaSession.setActionHandler("nexttrack", () => nextTrack());
      navigator.mediaSession.setActionHandler("seekto", (d) => {
        if (d.seekTime == null) return;
        const a = audio();
        if (a) a.currentTime = d.seekTime;
      });
    } catch (_) {}
  }

  function prefetchStream(id) {
    if (!id || getCachedStream(id)) return;
    resolveAudioUrl(id).catch(() => {});
  }

  function prefetchNext() {
    if (!state.queue.length) return;
    let nextIdx = state.index + 1;
    if (state.shuffle && state.shuffleOrder.length) {
      const pos = state.shuffleOrder.indexOf(state.index);
      if (pos >= 0 && pos + 1 < state.shuffleOrder.length) nextIdx = state.shuffleOrder[pos + 1];
      else return;
    }
    if (nextIdx >= 0 && nextIdx < state.queue.length) prefetchStream(state.queue[nextIdx].id);
  }

  function hasNextTrack() {
    if (!state.queue.length) return false;
    if (state.shuffle) {
      if (!state.shuffleOrder.length) rebuildShuffle();
      const pos = state.shuffleOrder.indexOf(state.index);
      return pos >= 0 && pos < state.shuffleOrder.length - 1;
    }
    return state.index < state.queue.length - 1;
  }

  function playAtIndex(i) {
    if (i < 0 || i >= state.queue.length) return;
    state.index = i;
    const track = state.queue[i];
    state.history = [track, ...state.history.filter((x) => x.id !== track.id)].slice(0, 100);
    save();
    renderNow();
    renderQueue();
    playTrackOnline(track);
  }

  async function playTrackOnline(track, { retry = true } = {}) {
    const token = ++state.loadToken;
    stopAll();
    state.isPlaying = false;
    state.mode = "none";
    setStatus("Đang lấy stream SoundCloud…");
    const hadCache = !!getCachedStream(track.id);
    if (!hadCache) setLoading(true, "SoundCloud stream…");
    renderNow();

    try {
      const streamUrl = await resolveAudioUrl(track.id);
      if (token !== state.loadToken) return;
      await playHtml5(streamUrl, track, token);
      setLoading(false);
      prefetchNext();
    } catch (e) {
      if (token !== state.loadToken) return;
      if (retry) {
        streamMem.delete(track.id);
        saveStreamCacheDisk();
        try {
          const streamUrl = await resolveAudioUrl(track.id);
          if (token !== state.loadToken) return;
          await playHtml5(streamUrl, track, token);
          setLoading(false);
          prefetchNext();
          return;
        } catch (_) {}
      }
      setLoading(false);
      state.isPlaying = false;
      setStatus("Không lấy được stream");
      renderNow();
      if (hasNextTrack()) {
        toast("Bài này lỗi — sang bài tiếp");
        setTimeout(() => {
          if (token === state.loadToken) nextTrack({ fromError: true });
        }, 500);
      } else {
        toast(e.message || "Không phát được");
        showApiBanner(!state.streamApiOk);
      }
    }
  }

  function playHtml5(url, track, token) {
    return new Promise((resolve, reject) => {
      const a = audio();
      if (!a) return reject(new Error("no audio"));
      state.mode = "audio";
      state.suppressAudioEvents = true;
      a.volume = state.volume / 100;
      let settled = false;
      const ok = () => {
        if (settled || token !== state.loadToken) return;
        settled = true;
        state.suppressAudioEvents = false;
        state.isPlaying = true;
        setStatus("▶ SoundCloud");
        updateMediaSession(track);
        renderNow();
        resolve();
      };
      const fail = (err) => {
        if (settled || token !== state.loadToken) return;
        settled = true;
        state.suppressAudioEvents = false;
        streamMem.delete(track.id);
        saveStreamCacheDisk();
        reject(err || new Error("audio error"));
      };
      a.onerror = () => fail(new Error("audio error"));
      try {
        a.src = url;
        try {
          a.load();
        } catch (_) {}
      } catch (e) {
        return fail(e);
      }
      setTimeout(() => {
        if (token !== state.loadToken) return;
        state.suppressAudioEvents = false;
        const p = a.play();
        if (p && p.then) p.then(ok).catch(fail);
      }, 50);
      a.addEventListener("playing", ok, { once: true });
      setTimeout(() => {
        if (!settled && token === state.loadToken && !a.paused) ok();
        else if (!settled && token === state.loadToken) fail(new Error("timeout play"));
      }, 12000);
    });
  }

  function togglePlay() {
    if (!currentTrack()) {
      if (state.queue.length) playAtIndex(Math.max(0, state.index));
      return;
    }
    const a = audio();
    if (!a?.src || state.mode !== "audio") {
      playTrackOnline(currentTrack());
      return;
    }
    if (a.paused) a.play().catch(() => playTrackOnline(currentTrack()));
    else a.pause();
  }

  function nextTrack({ fromError = false } = {}) {
    if (state.suppressAudioEvents && !fromError) return;
    if (!state.queue.length) {
      if (!fromError) toast("Queue trống — search rồi bấm phát");
      return;
    }
    if (state.shuffle) {
      if (!state.shuffleOrder.length) rebuildShuffle();
      const pos = state.shuffleOrder.indexOf(state.index);
      if (pos < 0 || pos >= state.shuffleOrder.length - 1) {
        state.isPlaying = false;
        stopAll();
        setStatus("Đã hết hàng đợi");
        renderNow();
        if (!fromError) toast("Đã hết hàng đợi");
        return;
      }
      playAtIndex(state.shuffleOrder[pos + 1]);
    } else {
      if (state.index >= state.queue.length - 1) {
        state.isPlaying = false;
        stopAll();
        setStatus("Đã hết hàng đợi");
        renderNow();
        if (!fromError) toast("Đã hết hàng đợi");
        return;
      }
      playAtIndex(state.index + 1);
    }
    save();
  }

  function prevTrack() {
    if (!state.queue.length) return;
    const a = audio();
    if (a && a.currentTime > 3) {
      a.currentTime = 0;
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
    save();
  }

  function toggleShuffle() {
    state.shuffle = !state.shuffle;
    if (state.shuffle) rebuildShuffle();
    else state.shuffleOrder = [];
    save();
    renderNow();
    toast(state.shuffle ? "Shuffle on" : "Shuffle off");
  }

  async function doSearch(q, { fromGenre = false } = {}) {
    q = (q || "").trim();
    if (!q) return;
    $("#search-input").value = q;
    setView(fromGenre ? "home" : "search");
    if ($("#list-title")) $("#list-title").textContent = fromGenre ? "Mood" : "Kết quả";
    if ($("#list-sub")) $("#list-sub").textContent = `SoundCloud · “${q}”`;
    const cached = searchMem.get(q.toLowerCase());
    if (!(cached && cached.exp > Date.now())) setLoading(true, "Search SoundCloud…");
    $$(".genre-card").forEach((b) => b.classList.toggle("active", b.dataset.q === q));
    try {
      state.results = await searchTracks(q);
      if ($("#list-sub")) $("#list-sub").textContent = `${state.results.length} bài · SoundCloud`;
      renderResults();
      if (state.results[0]) prefetchStream(state.results[0].id);
      if (!state.results.length) toast("Không tìm thấy");
    } catch (err) {
      toast(err.message || "Search lỗi");
      showApiBanner(!state.streamApiOk);
    } finally {
      setLoading(false);
    }
  }

  async function loadCharts() {
    try {
      setLoading(true, "SoundCloud charts…");
      state.results = await scApiCharts();
      if ($("#list-title")) $("#list-title").textContent = "Trending";
      if ($("#list-sub")) $("#list-sub").textContent = "SoundCloud charts";
      renderResults();
    } catch (_) {
      // fallback search
      await doSearch("lofi chill", { fromGenre: true });
    } finally {
      setLoading(false);
    }
  }

  function tickProgress() {
    const a = audio();
    if (!a || state.mode !== "audio") return;
    const cur = a.currentTime || 0;
    const dur = a.duration || 0;
    if (!(dur > 0) || !Number.isFinite(dur)) return;
    state.duration = dur;
    const v = Math.floor((cur / dur) * 1000);
    if ($("#time-cur")) $("#time-cur").textContent = fmt(cur);
    if ($("#time-dur")) $("#time-dur").textContent = fmt(dur);
    if ($("#seek")) $("#seek").value = v;
    if ($(".d-cur")) $(".d-cur").textContent = fmt(cur);
    if ($(".d-dur")) $(".d-dur").textContent = fmt(dur);
    if ($(".d-seek")) $(".d-seek").value = v;
    const mp = $("#mini-progress");
    if (mp) mp.style.width = `${Math.min(100, (cur / dur) * 100)}%`;
  }

  (() => {
    const a = audio();
    if (!a) return;
    a.addEventListener("ended", () => {
      if (state.suppressAudioEvents) return;
      if (state.mode !== "audio") return;
      if ((a.duration || 0) > 0 && a.currentTime < (a.duration || 0) * 0.85) return;
      nextTrack();
    });
    a.addEventListener("play", () => {
      if (state.suppressAudioEvents) return;
      state.isPlaying = true;
      updateMediaSession(currentTrack());
      renderNow();
    });
    a.addEventListener("pause", () => {
      if (state.suppressAudioEvents) return;
      if (!a.src) return;
      state.isPlaying = false;
      updateMediaSession(currentTrack());
      renderNow();
    });
    a.addEventListener("timeupdate", tickProgress);
    a.addEventListener("error", () => {
      if (state.suppressAudioEvents) return;
      if (state.mode !== "audio") return;
      if (!a.currentSrc && !a.src) return;
      const t = currentTrack();
      if (!t) return;
      streamMem.delete(t.id);
      saveStreamCacheDisk();
      if (hasNextTrack()) {
        toast("Stream hỏng — next");
        setTimeout(() => nextTrack({ fromError: true }), 400);
      } else {
        toast("Không phát được bài này");
        state.isPlaying = false;
        setStatus("Lỗi stream");
        renderNow();
      }
    });
  })();

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return;
    if (state.mode === "audio" && state.isPlaying) audio()?.play?.().catch(() => {});
  });

  bindMediaSessionHandlers();

  // UI
  $$(".nav-btn, .tabbar .tab, [data-view].lib-tile, #btn-open-search").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.view) setView(btn.dataset.view);
    });
  });
  $$(".genre-card").forEach((btn) => {
    btn.addEventListener("click", () => doSearch(btn.dataset.q, { fromGenre: true }));
  });
  $("#search-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    doSearch($("#search-input").value);
  });

  $("#btn-expand-player")?.addEventListener("click", openNowPlaying);
  $("#btn-collapse-player")?.addEventListener("click", closeNowPlaying);
  $("#btn-play")?.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePlay();
  });
  $("#btn-next")?.addEventListener("click", (e) => {
    e.stopPropagation();
    nextTrack();
  });
  $("#btn-np-play")?.addEventListener("click", togglePlay);
  $("#btn-np-next")?.addEventListener("click", nextTrack);
  $("#btn-np-prev")?.addEventListener("click", prevTrack);
  $("#btn-prev")?.addEventListener("click", prevTrack);
  $(".d-play")?.addEventListener("click", togglePlay);
  $(".d-next")?.addEventListener("click", nextTrack);
  $("#btn-shuffle")?.addEventListener("click", toggleShuffle);
  $("#btn-np-shuffle")?.addEventListener("click", toggleShuffle);

  ["#btn-fav", "#btn-np-fav"].forEach((sel) => {
    $(sel)?.addEventListener("click", () => {
      const t = currentTrack();
      if (t) toggleFav(t);
    });
  });
  ["#btn-like", "#btn-np-like"].forEach((sel) => {
    $(sel)?.addEventListener("click", () => toast("♥ SoundCloud"));
  });
  ["#btn-dislike", "#btn-np-dislike"].forEach((sel) => {
    $(sel)?.addEventListener("click", () => nextTrack());
  });

  $("#btn-lyrics")?.addEventListener("click", () => toast("SoundCloud không có lyrics API"));
  $("#btn-np-lyrics")?.addEventListener("click", () => toast("SoundCloud không có lyrics API"));
  $("#btn-lyrics-lib")?.addEventListener("click", () => {
    setView("library");
    $("#lyrics-body").textContent = "SoundCloud không cung cấp lyrics.";
  });
  $("#btn-np-queue")?.addEventListener("click", () => {
    closeNowPlaying();
    setView("queue");
  });

  $("#seek")?.addEventListener("input", () => {
    if (!state.duration) return;
    const a = audio();
    if (a) a.currentTime = (Number($("#seek").value) / 1000) * state.duration;
  });
  $(".d-seek")?.addEventListener("input", () => {
    if (!state.duration) return;
    const a = audio();
    if (a) a.currentTime = (Number($(".d-seek").value) / 1000) * state.duration;
  });

  function onVol(el) {
    state.volume = Number(el.value);
    const a = audio();
    if (a) a.volume = state.volume / 100;
    ["#volume", "#volume-mobile"].forEach((sel) => {
      const o = $(sel);
      if (o && o !== el) o.value = state.volume;
    });
    save();
  }
  $("#volume")?.addEventListener("input", (e) => onVol(e.target));
  $("#volume-mobile")?.addEventListener("input", (e) => onVol(e.target));

  $("#btn-clear-queue")?.addEventListener("click", () => {
    state.queue = [];
    state.index = -1;
    state.shuffleOrder = [];
    stopAll();
    state.isPlaying = false;
    state.mode = "none";
    save();
    renderAll();
    toast("Đã xóa queue");
  });

  $("#btn-resume-session")?.addEventListener("click", () => {
    if (!state.queue.length) return toast("Chưa có session");
    playAtIndex(Math.max(0, Math.min(state.index, state.queue.length - 1)));
    openNowPlaying();
  });

  $("#btn-ios-help")?.addEventListener("click", openIosHelp);
  $("#btn-ios-help-2")?.addEventListener("click", () => {
    $("#settings-sheet")?.classList.add("hidden");
    openIosHelp();
  });
  $("#btn-ios-close")?.addEventListener("click", () => $("#ios-sheet")?.classList.add("hidden"));
  $("#btn-settings")?.addEventListener("click", () => {
    const input = $("#stream-api-input");
    if (input) input.value = state.streamApi || "";
    $("#settings-sheet")?.classList.remove("hidden");
  });
  $("#btn-settings-close")?.addEventListener("click", () => $("#settings-sheet")?.classList.add("hidden"));
  $("#btn-bg-help")?.addEventListener("click", () => $("#bg-sheet")?.classList.remove("hidden"));
  $("#btn-bg-close")?.addEventListener("click", () => $("#bg-sheet")?.classList.add("hidden"));
  $("#btn-open-api-settings")?.addEventListener("click", () => {
    showApiBanner(false);
    $("#btn-settings")?.click();
  });
  $("#btn-save-api")?.addEventListener("click", async () => {
    setStreamApi($("#stream-api-input")?.value || "");
    setLoading(true, "Kiểm tra API…");
    const ok = await probeStreamApi();
    setLoading(false);
    if (ok) {
      showApiBanner(false);
      toast("SoundCloud API OK");
      setStatus(`API: ${ok}`);
      $("#settings-sheet")?.classList.add("hidden");
      loadCharts();
    } else toast("API không OK — kiểm tra URL");
  });

  $("#pl-create")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#pl-name").value.trim();
    if (!name) return;
    if (!state.playlists[name]) state.playlists[name] = { name, tracks: [] };
    state.activePlaylist = name;
    $("#pl-name").value = "";
    save();
    renderPlaylists();
    setView("playlists");
    toast(`Tạo ${name}`);
  });

  (() => {
    const sheet = $("#np-sheet");
    if (!sheet) return;
    let startY = 0;
    sheet.addEventListener("touchstart", (e) => {
      startY = e.touches[0].clientY;
    }, { passive: true });
    sheet.addEventListener("touchend", (e) => {
      if (e.changedTouches[0].clientY - startY > 80) closeNowPlaying();
    }, { passive: true });
  })();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register(new URL("./sw.js", location.href).href).catch(() => {});
  }

  function greeting() {
    const h = new Date().getHours();
    if (h < 12) return "Chào buổi sáng";
    if (h < 18) return "Chào buổi chiều";
    return "Chào buổi tối";
  }

  (() => {
    const params = new URLSearchParams(location.search);
    const fromQuery = params.get("api");
    if (fromQuery) setStreamApi(fromQuery);
    else {
      try {
        setStreamApi(localStorage.getItem(API_KEY) || "");
      } catch (_) {
        setStreamApi("");
      }
    }
  })();

  loadStreamCacheDisk();
  load();
  ["#volume", "#volume-mobile"].forEach((sel) => {
    const el = $(sel);
    if (el) el.value = state.volume;
  });
  if ($("#greeting")) $("#greeting").textContent = greeting();
  if (state.queue.length && state.index < 0) state.index = 0;
  if (state.shuffle) rebuildShuffle();
  renderAll();

  probeStreamApi().then((base) => {
    if (!base) {
      setStatus("Cần Stream API SoundCloud");
      showApiBanner(true);
    } else {
      showApiBanner(false);
      setStatus(`SoundCloud API · ${base}`);
      loadCharts();
    }
  });
})();
