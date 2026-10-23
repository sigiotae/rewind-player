/* Rewind — 장르 복수 선택 → 한 곡씩 재생 → 좋아요/별로 → 플레이리스트 */
(function () {
  "use strict";

  // ---------- 저장소 (브라우저마다 따로 저장) ----------
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem("rewind." + key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem("rewind." + key, JSON.stringify(value)); } catch (e) { /* 저장 불가 환경 */ }
    },
  };

  const state = {
    data: { genres: [], songs: [] },
    selected: new Set(store.get("genres", [])),
    seen: new Set(store.get("seen", [])),      // 좋아요/별로를 누른 곡 id
    skipped: new Set(),                         // 이번 방문에서 넘긴 곡
    playlist: store.get("playlist", []),        // [{id, artist, title, year}]
    current: null,
    plIndex: -1,
    plOrder: [],
  };

  const $ = (id) => document.getElementById(id);
  const fmtViews = (n) => n >= 1e9 ? (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B"
    : n >= 1e6 ? Math.round(n / 1e6) + "M" : String(n);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- YouTube 플레이어 ----------
  let ytReady = false;
  let explorePlayer = null;
  let playlistPlayer = null;
  const pending = { explore: null, playlist: null };

  function makePlayer(elId, onEnd, onReady, onError) {
    return new YT.Player(elId, {
      width: "100%", height: "100%",
      playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady,
        onStateChange: (e) => { if (e.data === YT.PlayerState.ENDED) onEnd(); },
        onError,
      },
    });
  }

  function initPlayers() {
    if (ytReady) return;
    ytReady = true;
    explorePlayer = makePlayer("yt-explore",
      () => {},                               // 끝나도 자동으로 넘기지 않음: 평가를 기다림
      () => { explorePlayer._ready = true; if (pending.explore) loadExplore(pending.explore); },
      () => { // 임베드 불가 등 → 조용히 다음 곡
        if (state.current) state.skipped.add(state.current.id);
        nextSong();
      });
    playlistPlayer = makePlayer("yt-playlist",
      () => playPlaylistAt(state.plIndex + 1),
      () => { playlistPlayer._ready = true; if (pending.playlist) loadPlaylist(pending.playlist); },
      () => playPlaylistAt(state.plIndex + 1));
  }
  window.onYouTubeIframeAPIReady = initPlayers;
  if (window.YT && window.YT.Player) initPlayers();

  function loadExplore(id) {
    if (!explorePlayer || !explorePlayer._ready) { pending.explore = id; return; }
    pending.explore = null;
    explorePlayer.cueVideoById(id);
  }
  function loadPlaylist(id) {
    if (!playlistPlayer || !playlistPlayer._ready) { pending.playlist = id; return; }
    pending.playlist = null;
    playlistPlayer.loadVideoById(id);
  }
  function pauseAll() {
    try { explorePlayer && explorePlayer._ready && explorePlayer.pauseVideo(); } catch (e) {}
    try { playlistPlayer && playlistPlayer._ready && playlistPlayer.pauseVideo(); } catch (e) {}
  }

  // ---------- 장르 ----------
  function genreCount(gid) {
    return state.data.songs.filter((s) => s.genres.includes(gid)).length;
  }

  function renderGenres() {
    const wrap = $("genres");
    wrap.innerHTML = "";
    state.data.genres.forEach((g) => {
      const n = genreCount(g.id);
      if (!n) return;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.setAttribute("aria-pressed", state.selected.has(g.id));
      b.innerHTML = `<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>${esc(g.label)} <span class="count">${n}</span>`;
      b.addEventListener("click", () => {
        state.selected.has(g.id) ? state.selected.delete(g.id) : state.selected.add(g.id);
        b.setAttribute("aria-pressed", state.selected.has(g.id));
        store.set("genres", [...state.selected]);
        updateToggleAll();
        // 지금 곡이 선택 장르에서 빠졌으면 다음 곡
        if (!state.current || !state.current.genres.some((x) => state.selected.has(x))) nextSong();
        else updateRemaining();
      });
      wrap.appendChild(b);
    });
    updateToggleAll();
  }

  function visibleGenres() {
    return state.data.genres.filter((g) => genreCount(g.id) > 0).map((g) => g.id);
  }

  function updateToggleAll() {
    const all = visibleGenres();
    $("toggle-all").textContent = all.length && all.every((g) => state.selected.has(g)) ? "전체 해제" : "전체 선택";
  }

  $("toggle-all").addEventListener("click", () => {
    const all = visibleGenres();
    const allOn = all.every((g) => state.selected.has(g));
    state.selected = new Set(allOn ? [] : all);
    store.set("genres", [...state.selected]);
    renderGenres();
    nextSong();
  });

  // ---------- 탐색 ----------
  function candidates() {
    return state.data.songs.filter((s) =>
      s.genres.some((g) => state.selected.has(g)) &&
      !state.seen.has(s.id) && !state.skipped.has(s.id));
  }

  function nextSong() {
    const pool = candidates().filter((s) => !state.current || s.id !== state.current.id);
    if (!state.selected.size) return showEmpty("장르를 골라주세요", "고른 장르에서 한 곡씩 틀어드려요.", false);
    if (!pool.length) {
      // 넘기기만 한 곡이 있으면 다시 돌림
      if (state.skipped.size) { state.skipped.clear(); const again = candidates(); if (again.length) return show(pick(again)); }
      return showEmpty("이 장르는 다 들었어요", "다른 장르를 고르거나 평가 기록을 초기화해 보세요.", true);
    }
    show(pick(pool));
  }

  // 조회수가 높을수록 조금 더 자주 나오게 (가중 랜덤)
  function pick(pool) {
    const w = pool.map((s) => Math.log10(Math.max(s.views, 10)));
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < pool.length; i++) { r -= w[i]; if (r <= 0) return pool[i]; }
    return pool[pool.length - 1];
  }

  function show(song) {
    state.current = song;
    $("explore-empty").classList.add("hidden");
    $("explore-now").classList.remove("hidden");
    $("np-title").textContent = song.title;
    $("np-artist").textContent = song.artist;
    $("np-info").textContent = `${song.year} · ${fmtViews(song.views)}회`;
    loadExplore(song.id);
    updateRemaining();
  }

  function showEmpty(title, sub, showReset) {
    state.current = null;
    pauseAll();
    $("explore-now").classList.add("hidden");
    $("explore-empty").classList.remove("hidden");
    $("empty-title").textContent = title;
    $("empty-sub").textContent = sub;
    $("reset-seen-inline").classList.toggle("hidden", !showReset);
  }

  function updateRemaining() {
    const n = candidates().length;
    $("remaining").textContent = `선택한 장르에 남은 곡 ${n}곡`;
  }

  function rate(liked) {
    const s = state.current;
    if (!s) return;
    state.seen.add(s.id);
    store.set("seen", [...state.seen]);
    if (liked && !state.playlist.some((p) => p.id === s.id)) {
      state.playlist.push({ id: s.id, artist: s.artist, title: s.title, year: s.year });
      store.set("playlist", state.playlist);
      renderPlaylist();
      toast("플레이리스트에 추가했어요");
    }
    nextSong();
  }

  $("btn-like").addEventListener("click", () => rate(true));
  $("btn-dislike").addEventListener("click", () => rate(false));
  $("btn-skip").addEventListener("click", () => {
    if (state.current) state.skipped.add(state.current.id);
    nextSong();
  });

  // ---------- 플레이리스트 ----------
  function renderPlaylist() {
    const list = $("pl-list");
    const n = state.playlist.length;
    $("pl-count").textContent = n ? `${n}곡` : "";
    $("tab-badge").textContent = n;
    $("tab-badge").classList.toggle("hidden", !n);
    $("pl-empty").classList.toggle("hidden", !!n);
    list.classList.toggle("hidden", !n);
    ["btn-play-all", "btn-shuffle", "btn-export"].forEach((id) => { $(id).disabled = !n; });

    const playingId = state.plIndex >= 0 ? state.plOrder[state.plIndex] : null;
    list.innerHTML = state.playlist.map((s, i) => `
      <div class="row song${s.id === playingId ? " playing" : ""}" data-i="${i}" role="button" tabindex="0">
        <div class="thumb" style="background-image:url('https://i.ytimg.com/vi/${encodeURIComponent(s.id)}/mqdefault.jpg')"></div>
        <div class="row-text">
          <div class="row-title">${esc(s.title)}</div>
          <div class="row-sub">${esc(s.artist)} · ${s.year}</div>
        </div>
        <button class="del" type="button" data-del="${i}" aria-label="삭제">
          <svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>`).join("");
  }

  $("pl-list").addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (del) {
      const i = +del.dataset.del;
      const [removed] = state.playlist.splice(i, 1);
      store.set("playlist", state.playlist);
      state.plOrder = state.plOrder.filter((id) => id !== removed.id);
      renderPlaylist();
      toast("삭제했어요");
      return;
    }
    const row = e.target.closest(".row.song");
    if (row) startPlaylist(false, state.playlist[+row.dataset.i].id);
  });
  $("pl-list").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.classList.contains("song")) e.target.click();
  });

  function startPlaylist(shuffle, firstId) {
    if (!state.playlist.length) return;
    let ids = state.playlist.map((s) => s.id);
    if (shuffle) {
      for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    }
    state.plOrder = ids;
    pauseAll();
    playPlaylistAt(firstId ? ids.indexOf(firstId) : 0);
  }

  function playPlaylistAt(i) {
    if (!state.plOrder.length) return;
    if (i >= state.plOrder.length) i = 0;
    if (i < 0) i = state.plOrder.length - 1;
    state.plIndex = i;
    const s = state.playlist.find((p) => p.id === state.plOrder[i]);
    if (!s) return;
    $("pl-now").classList.remove("hidden");
    $("pl-np-title").textContent = s.title;
    $("pl-np-artist").textContent = s.artist;
    loadPlaylist(s.id);
    renderPlaylist();
  }

  $("btn-play-all").addEventListener("click", () => startPlaylist(false));
  $("btn-shuffle").addEventListener("click", () => startPlaylist(true));
  $("btn-pl-next").addEventListener("click", () => playPlaylistAt(state.plIndex + 1));
  $("btn-pl-prev").addEventListener("click", () => playPlaylistAt(state.plIndex - 1));

  // YouTube 임시 재생목록으로 열기 (최대 50곡)
  $("btn-export").addEventListener("click", () => {
    const ids = state.playlist.slice(0, 50).map((s) => s.id).join(",");
    if (ids) window.open("https://www.youtube.com/watch_videos?video_ids=" + ids, "_blank", "noopener");
  });

  function resetSeen() {
    if (!confirm("평가 기록을 초기화할까요? 플레이리스트는 지워지지 않아요.")) return;
    state.seen.clear();
    state.skipped.clear();
    store.set("seen", []);
    toast("평가 기록을 초기화했어요");
    nextSong();
  }
  $("btn-reset").addEventListener("click", resetSeen);
  $("reset-seen-inline").addEventListener("click", resetSeen);

  // ---------- 탭 ----------
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const view = tab.dataset.view;
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + view));
      pauseAll();
      window.scrollTo({ top: 0 });
    });
  });

  // ---------- 토스트 ----------
  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 1600);
  }

  // ---------- 시작 ----------
  fetch("songs.json", { cache: "no-cache" })
    .then((r) => r.json())
    .then((data) => {
      state.data = data;
      // 없어진 장르 선택은 정리
      const ids = new Set(data.genres.map((g) => g.id));
      state.selected = new Set([...state.selected].filter((g) => ids.has(g)));
      $("updated").textContent = data.updated && data.updated !== "sample" ? `업데이트 ${data.updated}` : "";
      renderGenres();
      renderPlaylist();
      nextSong();
    })
    .catch(() => showEmpty("곡 목록을 불러오지 못했어요", "잠시 후 새로고침해 주세요.", false));
})();
