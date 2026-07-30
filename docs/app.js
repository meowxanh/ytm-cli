/* YTM Static — stream online (HTML5 audio first for iOS background), no PC, no file download */
(() => {
  const STORAGE_KEY = "ytm_static_v1";

  const INVIDIOUS = [
    "https://inv.nadeko.net",
    "https://invidious.nerdvpn.de",
    "https://yewtu.be",
    "https://invidious.flokinet.to",
    "https://vid.puffyan.us",
    "https://invidious.privacyredirect.com",
    "https://iv.ggtyler.dev",
  ];
  const PIPED = [
    "https://pipedapi.kavin.rocks",
    "https://api.piped.private.coffee",
    "https://pipedapi.reallyaweso.me",
    "https://pipedapi.leptons.xyz",
    "https://pipedapi.adminforge.de",
    "https://pipedapi.nosebs.ru",
    "https://pipedapi.r4fo.com",
    "https://pipedapi.syncpundit.io",
  ];
  const COBALT = [
    "https://api.cobalt.tools/",
    "https://cobalt-api.kwiatekmiki.com/",
  ];

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
    yt: null,
    ytReady: false,
    pendingId: null,
    mode: "none", // "audio" | "embed"
    loadToken: 0,
  };

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
    if (t.thumbnail) return t.thumbnail;
    return t.id ? `https://i.ytimg.com/vi/${t.id}/hqdefault.jpg` : "";
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
          likes: state.likes,
          dislikes: state.dislikes,
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
      state.likes = d.likes || [];
      state.dislikes = d.dislikes || [];
      state.playlists = d.playlists || {};
    } catch (_) {}
  }

  function extractId(text) {
    text = (text || "").trim();
    const m = text.match(
      /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|music\.youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/
    );
    if (m) return m[1];
    if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text;
    return null;
  }

  function normalizeTrack(raw) {
    if (!raw) return null;
    const id = raw.id || raw.videoId || extractId(raw.url || raw.videoId || "") || "";
    if (!id || id.length < 6) return null;
    let thumbnail = raw.thumbnail || "";
    if (!thumbnail && Array.isArray(raw.videoThumbnails) && raw.videoThumbnails.length) {
      thumbnail = raw.videoThumbnails[raw.videoThumbnails.length - 1].url || "";
    }
    if (!thumbnail && Array.isArray(raw.thumbnails) && raw.thumbnails.length) {
      const last = raw.thumbnails[raw.thumbnails.length - 1];
      thumbnail = last.url || last.src || "";
    }
    return {
      id: String(id).slice(0, 11),
      title: raw.title || "Unknown",
      uploader: raw.uploader || raw.author || raw.channelName || raw.channel || "",
      duration: raw.duration ?? raw.lengthSeconds ?? null,
      duration_str: raw.duration_str || (raw.lengthSeconds != null ? fmt(raw.lengthSeconds) : raw.duration != null ? fmt(raw.duration) : "--:--"),
      thumbnail: thumbnail || `https://i.ytimg.com/vi/${String(id).slice(0, 11)}/hqdefault.jpg`,
      url: `https://www.youtube.com/watch?v=${String(id).slice(0, 11)}`,
    };
  }

  async function fetchJson(url, timeout = 10000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  async function searchInvidious(q) {
    for (const base of INVIDIOUS) {
      try {
        const data = await fetchJson(
          `${base}/api/v1/search?q=${encodeURIComponent(q)}&type=video`,
          9000
        );
        if (!Array.isArray(data)) continue;
        const tracks = data.map(normalizeTrack).filter(Boolean).slice(0, 15);
        if (tracks.length) return tracks;
      } catch (_) {}
    }
    return null;
  }

  async function searchPiped(q) {
    for (const base of PIPED) {
      try {
        const data = await fetchJson(
          `${base}/search?q=${encodeURIComponent(q)}&filter=videos`,
          9000
        );
        const items = data.items || data || [];
        if (!Array.isArray(items)) continue;
        const tracks = items
          .map((it) =>
            normalizeTrack({
              id: (it.url || "").replace("/watch?v=", "").replace("/watch/", "") || it.id,
              title: it.title,
              uploader: it.uploaderName || it.uploader,
              duration: it.duration,
              thumbnail: it.thumbnail,
            })
          )
          .filter(Boolean)
          .slice(0, 15);
        if (tracks.length) return tracks;
      } catch (_) {}
    }
    return null;
  }

  async function searchTracks(q) {
    const id = extractId(q);
    if (id) {
      return [
        normalizeTrack({
          id,
          title: "YouTube video",
          uploader: "",
          thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        }),
      ];
    }
    let tracks = await searchInvidious(q);
    if (!tracks) tracks = await searchPiped(q);
    if (!tracks || !tracks.length) throw new Error("Search lỗi — thử lại sau (mạng / API public)");
    return tracks;
  }

  async function fetchLyrics(track) {
    try {
      const q = `${track.uploader || ""} ${track.title || ""}`.trim();
      const res = await fetch(
        `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`,
        { headers: { "User-Agent": "ytm-static/1.0" } }
      );
      if (!res.ok) return null;
      const results = await res.json();
      if (!results?.length) return null;
      const plain = results[0].plainLyrics || results[0].syncedLyrics;
      if (!plain) return null;
      return plain.replace(/\[\d+:\d+(?:\.\d+)?\]/g, "").trim();
    } catch (_) {
      return null;
    }
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
    if (name === "search") setTimeout(() => $("#search-input")?.focus(), 150);
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
    return `
      <div class="track-row ${active ? "active" : ""}" data-id="${t.id}" data-idx="${i}">
        <img class="art" src="${thumb(t)}" alt="" loading="lazy" />
        <div class="meta">
          <div class="t-title">${escapeHtml(t.title)}</div>
          <div class="t-sub">${escapeHtml(t.uploader || "YouTube")} · ${t.duration_str || fmt(t.duration)}</div>
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
        if (track) {
          if (row.dataset.idx != null && list === state.queue) playAtIndex(Number(row.dataset.idx));
          else playTrack(track, { enqueueIfMissing: true });
        }
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
      : `<div class="empty-state">Search hoặc chọn chủ đề.</div>`;
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
      if (!state.playlists[name].tracks.some((x) => x.id === t.id)) {
        state.playlists[name].tracks.push(t);
      }
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
    const artist = t?.uploader || (t ? "YouTube" : "Chạm để mở");
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

    try {
      if (state.mode === "embed" && state.yt && state.ytReady) state.yt.setVolume(state.volume);
      const a = audio();
      if (a) a.volume = state.volume / 100;
    } catch (_) {}
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

  function setEmbedVisible(show) {
    const wrap = $(".np-art-wrap");
    const host = $("#yt-host");
    if (wrap) wrap.classList.toggle("mode-embed", !!show);
    if (host) host.classList.toggle("show", !!show);
  }

  function stopAll() {
    const a = audio();
    if (a) {
      try {
        a.pause();
        a.removeAttribute("src");
        a.load();
      } catch (_) {}
    }
    try {
      state.yt?.stopVideo?.();
    } catch (_) {}
  }

  function updateMediaSession(track) {
    if (!("mediaSession" in navigator) || !track) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || "YTM",
        artist: track.uploader || "YouTube",
        album: "YTM",
        artwork: [
          { src: thumb(track), sizes: "512x512", type: "image/jpeg" },
        ],
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
        if (state.mode === "audio") {
          const a = audio();
          if (a) a.currentTime = d.seekTime;
        } else if (state.yt) {
          state.yt.seekTo(d.seekTime, true);
        }
      });
    } catch (_) {}
  }

  async function resolveAudioUrl(videoId) {
    // 1) Cobalt API
    for (const base of COBALT) {
      try {
        const res = await fetch(base, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: `https://www.youtube.com/watch?v=${videoId}`,
            downloadMode: "audio",
            audioFormat: "best",
          }),
        });
        if (!res.ok) continue;
        const data = await res.json();
        const u = data.url || data.tunnel || data.audio;
        if (u && typeof u === "string" && u.startsWith("http")) return u;
      } catch (_) {}
    }

    // 2) Piped streams
    for (const base of PIPED) {
      try {
        const data = await fetchJson(`${base}/streams/${videoId}`, 10000);
        const list = (data.audioStreams || []).slice();
        list.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        // Prefer m4a/mp4 for iOS
        const prefer =
          list.find((s) => /mp4|m4a|aac/i.test(s.mimeType || s.format || "")) || list[0];
        if (prefer?.url) return prefer.url;
      } catch (_) {}
    }

    // 3) Invidious adaptive audio
    for (const base of INVIDIOUS) {
      try {
        const data = await fetchJson(`${base}/api/v1/videos/${videoId}`, 10000);
        const formats = data.adaptiveFormats || [];
        const aud = formats
          .filter((f) => String(f.type || f.mimeType || "").includes("audio"))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        const prefer =
          aud.find((f) => /mp4|m4a|aac/i.test(String(f.type || ""))) || aud[0];
        if (prefer?.url) return prefer.url;
      } catch (_) {}
    }
    return null;
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

  async function playTrackOnline(track) {
    const token = ++state.loadToken;
    stopAll();
    state.isPlaying = false;
    state.mode = "none";
    setEmbedVisible(false);
    setStatus("Đang lấy stream audio…");
    setLoading(true, "Chuẩn bị nghe online…");
    renderNow();

    let streamUrl = null;
    try {
      streamUrl = await resolveAudioUrl(track.id);
    } catch (_) {}

    if (token !== state.loadToken) return;

    if (streamUrl) {
      try {
        await playHtml5(streamUrl, track, token);
        setLoading(false);
        return;
      } catch (e) {
        console.warn("html5 audio failed", e);
      }
    }

    // Fallback embed (background thường không được trên iOS)
    setLoading(false);
    setStatus("Embed (thoát app có thể tắt)");
    toast("Stream audio lỗi — fallback Embed (nền kém hơn)");
    playEmbed(track.id);
  }

  function playHtml5(url, track, token) {
    return new Promise((resolve, reject) => {
      const a = audio();
      if (!a) return reject(new Error("no audio el"));
      state.mode = "audio";
      setEmbedVisible(false);
      a.volume = state.volume / 100;
      let settled = false;
      const ok = () => {
        if (settled || token !== state.loadToken) return;
        settled = true;
        state.isPlaying = true;
        setStatus("Audio · nghe nền OK hơn");
        updateMediaSession(track);
        renderNow();
        resolve();
      };
      const fail = (e) => {
        if (settled) return;
        settled = true;
        reject(e || new Error("audio error"));
      };
      a.onerror = () => fail(new Error("audio error"));
      a.src = url;
      a.load();
      a.play().then(ok).catch(fail);
      // iOS sometimes fires playing without play() promise resolving cleanly
      a.addEventListener("playing", ok, { once: true });
      setTimeout(() => {
        if (!settled && !a.paused && a.currentTime >= 0) ok();
      }, 2000);
    });
  }

  function playEmbed(videoId) {
    state.mode = "embed";
    setEmbedVisible(true);
    if (!state.ytReady || !state.yt) {
      state.pendingId = videoId;
      setStatus("Đang khởi tạo player…");
      return;
    }
    try {
      state.yt.loadVideoById(videoId);
      state.yt.setVolume(state.volume);
      state.yt.unMute?.();
      state.yt.playVideo();
      state.isPlaying = true;
      setStatus("Embed · thoát app dễ tắt");
      updateMediaSession(currentTrack());
      renderNow();
    } catch (e) {
      toast("Không phát được video");
      setStatus("Lỗi phát");
    }
  }

  function togglePlay() {
    if (!currentTrack()) {
      if (state.queue.length) playAtIndex(Math.max(0, state.index));
      return;
    }
    if (state.mode === "audio") {
      const a = audio();
      if (!a?.src) {
        playTrackOnline(currentTrack());
        return;
      }
      if (a.paused) a.play().catch(() => playTrackOnline(currentTrack()));
      else a.pause();
      return;
    }
    if (state.mode === "embed") {
      if (!state.yt || !state.ytReady) {
        playEmbed(currentTrack().id);
        return;
      }
      const st = state.yt.getPlayerState();
      if (st === YT.PlayerState.PLAYING) state.yt.pauseVideo();
      else state.yt.playVideo();
      return;
    }
    playTrackOnline(currentTrack());
  }

  function nextTrack() {
    if (!state.queue.length) return;
    if (state.shuffle) {
      if (!state.shuffleOrder.length) rebuildShuffle();
      const pos = state.shuffleOrder.indexOf(state.index);
      if (pos < 0 || pos >= state.shuffleOrder.length - 1) return toast("Hết queue");
      playAtIndex(state.shuffleOrder[pos + 1]);
    } else {
      if (state.index >= state.queue.length - 1) {
        state.isPlaying = false;
        renderNow();
        return toast("Hết queue");
      }
      playAtIndex(state.index + 1);
    }
    save();
  }

  function prevTrack() {
    if (!state.queue.length) return;
    try {
      if (state.mode === "audio") {
        const a = audio();
        if (a && a.currentTime > 3) {
          a.currentTime = 0;
          return;
        }
      } else if (state.yt && state.yt.getCurrentTime() > 3) {
        state.yt.seekTo(0, true);
        return;
      }
    } catch (_) {}
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

  async function showLyrics() {
    const t = currentTrack();
    if (!t) return toast("Chưa có bài đang phát");
    setView("library");
    closeNowPlaying();
    $("#lyrics-meta").textContent = t.title;
    $("#lyrics-body").textContent = "Đang tải lyrics…";
    const text = await fetchLyrics(t);
    $("#lyrics-body").textContent = text || "Không tìm thấy lyrics.";
  }

  async function doSearch(q, { fromGenre = false } = {}) {
    q = (q || "").trim();
    if (!q) return;
    $("#search-input").value = q;
    setView(fromGenre ? "home" : "search");
    if ($("#list-title")) $("#list-title").textContent = fromGenre ? "Chủ đề" : "Kết quả";
    if ($("#list-sub")) $("#list-sub").textContent = `“${q}”`;
    setLoading(true, "Đang tìm…");
    $$(".genre-card").forEach((b) => b.classList.toggle("active", b.dataset.q === q));
    try {
      state.results = await searchTracks(q);
      if ($("#list-sub")) $("#list-sub").textContent = `${state.results.length} bài · “${q}”`;
      renderResults();
      if (!state.results.length) toast("Không tìm thấy");
    } catch (err) {
      toast(err.message || "Search lỗi");
    } finally {
      setLoading(false);
    }
  }

  function tickProgress() {
    let cur = 0;
    let dur = 0;
    try {
      if (state.mode === "audio") {
        const a = audio();
        if (!a) return;
        cur = a.currentTime || 0;
        dur = a.duration || 0;
      } else if (state.mode === "embed" && state.yt && state.ytReady) {
        cur = state.yt.getCurrentTime() || 0;
        dur = state.yt.getDuration() || 0;
      } else return;
    } catch (_) {
      return;
    }
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
    try {
      if ("mediaSession" in navigator && navigator.mediaSession.setPositionState) {
        navigator.mediaSession.setPositionState({
          duration: dur,
          position: Math.min(cur, dur),
          playbackRate: 1,
        });
      }
    } catch (_) {}
  }

  // HTML5 audio events (background-friendly on iOS)
  (() => {
    const a = audio();
    if (!a) return;
    a.addEventListener("ended", () => nextTrack());
    a.addEventListener("play", () => {
      state.isPlaying = true;
      updateMediaSession(currentTrack());
      renderNow();
    });
    a.addEventListener("pause", () => {
      if (state.mode === "audio") {
        state.isPlaying = false;
        updateMediaSession(currentTrack());
        renderNow();
      }
    });
    a.addEventListener("timeupdate", tickProgress);
    a.addEventListener("error", () => {
      if (state.mode !== "audio") return;
      const t = currentTrack();
      if (t) {
        toast("Stream lỗi — thử Embed");
        playEmbed(t.id);
      }
    });
  })();

  // Keep audio alive when app backgrounds (helps some iOS builds)
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return;
    if (state.mode === "audio" && state.isPlaying) {
      const a = audio();
      a?.play?.().catch(() => {});
    }
  });

  // YouTube IFrame fallback
  window.onYouTubeIframeAPIReady = function () {
    state.yt = new YT.Player("yt-host", {
      height: "100%",
      width: "100%",
      playerVars: {
        autoplay: 0,
        controls: 1,
        rel: 0,
        playsinline: 1,
        modestbranding: 1,
        fs: 1,
        origin: location.origin,
      },
      events: {
        onReady: (e) => {
          state.ytReady = true;
          e.target.setVolume(state.volume);
          if (state.pendingId) {
            playEmbed(state.pendingId);
            state.pendingId = null;
          }
          setInterval(() => {
            if (state.mode === "embed") tickProgress();
          }, 400);
        },
        onStateChange: (e) => {
          if (state.mode !== "embed") return;
          if (e.data === YT.PlayerState.ENDED) nextTrack();
          if (e.data === YT.PlayerState.PLAYING) {
            state.isPlaying = true;
            updateMediaSession(currentTrack());
            renderNow();
          }
          if (e.data === YT.PlayerState.PAUSED) {
            state.isPlaying = false;
            updateMediaSession(currentTrack());
            renderNow();
          }
        },
        onError: () => {
          toast("Không phát được — next");
          setTimeout(() => nextTrack(), 600);
        },
      },
    });
  };

  bindMediaSessionHandlers();

  // UI wiring
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
    $(sel)?.addEventListener("click", () => {
      const t = currentTrack();
      if (!t) return;
      state.likes = [t, ...state.likes.filter((x) => x.id !== t.id)];
      save();
      toast("👍 Liked");
    });
  });
  ["#btn-dislike", "#btn-np-dislike"].forEach((sel) => {
    $(sel)?.addEventListener("click", () => {
      const t = currentTrack();
      if (!t) return;
      state.dislikes = [t, ...state.dislikes.filter((x) => x.id !== t.id)];
      save();
      toast("👎 Next");
      nextTrack();
    });
  });

  $("#btn-lyrics")?.addEventListener("click", showLyrics);
  $("#btn-np-lyrics")?.addEventListener("click", showLyrics);
  $("#btn-lyrics-lib")?.addEventListener("click", showLyrics);
  $("#btn-np-queue")?.addEventListener("click", () => {
    closeNowPlaying();
    setView("queue");
  });

  $("#seek")?.addEventListener("input", () => {
    if (!state.duration) return;
    const t = (Number($("#seek").value) / 1000) * state.duration;
    if (state.mode === "audio") {
      const a = audio();
      if (a) a.currentTime = t;
    } else if (state.yt) state.yt.seekTo(t, true);
  });
  $(".d-seek")?.addEventListener("input", () => {
    if (!state.duration) return;
    const t = (Number($(".d-seek").value) / 1000) * state.duration;
    if (state.mode === "audio") {
      const a = audio();
      if (a) a.currentTime = t;
    } else if (state.yt) state.yt.seekTo(t, true);
  });

  function onVol(el) {
    state.volume = Number(el.value);
    try {
      state.yt?.setVolume(state.volume);
    } catch (_) {}
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

  $("#btn-bg-help")?.addEventListener("click", () => {
    $("#bg-sheet")?.classList.remove("hidden");
  });
  $("#btn-bg-close")?.addEventListener("click", () => {
    $("#bg-sheet")?.classList.add("hidden");
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
  $("#btn-settings")?.addEventListener("click", () => $("#settings-sheet")?.classList.remove("hidden"));
  $("#btn-settings-close")?.addEventListener("click", () => $("#settings-sheet")?.classList.add("hidden"));

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
    const sw = new URL("./sw.js", location.href);
    navigator.serviceWorker.register(sw.href).catch(() => {});
  }

  try {
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const standalone =
      window.navigator.standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches;
    if (isIos && !standalone && !localStorage.getItem("ytm_ios_tip2")) {
      localStorage.setItem("ytm_ios_tip2", "1");
      setTimeout(openIosHelp, 800);
    }
  } catch (_) {}

  function greeting() {
    const h = new Date().getHours();
    if (h < 12) return "Chào buổi sáng";
    if (h < 18) return "Chào buổi chiều";
    return "Chào buổi tối";
  }

  load();
  ["#volume", "#volume-mobile"].forEach((sel) => {
    const el = $(sel);
    if (el) el.value = state.volume;
  });
  if ($("#greeting")) $("#greeting").textContent = greeting();
  if (state.queue.length && state.index < 0) state.index = 0;
  if (state.shuffle) rebuildShuffle();
  renderAll();
  if (!state.results.length) doSearch("lofi hip hop", { fromGenre: true });
})();
