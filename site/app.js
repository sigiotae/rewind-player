/* Rewind — 탐색 · 검색 · 내 플리 · 공유 플리 */
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
    byId: new Map(),
    region: store.get("region", "global") === "kr" ? "kr" : "global",   // 외국 / 한국
    selected: {
      global: new Set(store.get("genres", [])),   // 외국: 장르
      kr: new Set(store.get("eras", [])),         // 한국: 연도대
    },
    seen: new Set(store.get("seen", [])),       // 좋아요/별로를 누른 곡 id
    skipped: new Set(),                          // 이번 방문에서 넘긴 곡
    playlist: store.get("playlist", []),         // [{id, artist, title, year}]
    owned: store.get("owned", {}),               // 내가 올린 공유 플리 {id: ownerToken}
    likedShared: new Set(store.get("likedShared", [])),
    current: null,
    detail: null,                                // 지금 열린 상세 플리
    view: "explore",
    preview: store.get("preview", false) === true, // 1분 미리듣기
  };

  // 미리듣기: 곡 길이의 30% 지점(최소 30초)부터 60초. 짧은 곡은 처음부터.
  const PREVIEW_SEC = 60;
  function previewRange(d) {
    if (!(d > 0)) return null;
    if (d <= PREVIEW_SEC + 30) return { start: 0, end: d };
    const start = Math.floor(Math.min(Math.max(30, d * 0.3), d - PREVIEW_SEC));
    return { start, end: start + PREVIEW_SEC };
  }

  const $ = (id) => document.getElementById(id);
  const fmtViews = (n) => n >= 1e9 ? (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B"
    : n >= 1e6 ? Math.round(n / 1e6) + "M" : String(n);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const thumb = (id) => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`;
  const inMine = (id) => state.playlist.some((p) => p.id === id);

  const ICON = {
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    heart: '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-9.2-8.6C1.2 8.2 3 4.5 6.6 4.5c2.1 0 3.6 1.2 5.4 3.2 1.8-2 3.3-3.2 5.4-3.2 3.6 0 5.4 3.7 3.8 6.9C19 15.6 12 20 12 20z"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M19 20 9 12l10-8z"/><path d="M5 19V5"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M5 4l10 8-10 8z"/><path d="M19 5v14"/></svg>',
  };

  // ---------- 토스트 ----------
  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
  }

  // ---------- YouTube 플레이어 ----------
  // 플레이어는 처음 쓸 때 만든다. 여러 개가 동시에 소리 나지 않게 하나만 재생.
  let ytApiReady = !!(window.YT && window.YT.Player);
  const waiting = [];
  window.onYouTubeIframeAPIReady = () => { ytApiReady = true; waiting.splice(0).forEach((f) => f()); };
  const players = [];

  function pauseOthers(except) {
    players.forEach((p) => { if (p !== except) p.pause(); });
  }

  class YtSlot {
    constructor(elId, { onEnd, onError, onPreviewEnd } = {}) {
      this.elId = elId;
      this.onEnd = onEnd || (() => {});
      this.onError = onError || (() => {});
      this.onPreviewEnd = onPreviewEnd || this.onEnd;
      this.yt = null;
      this.ready = false;
      this.pending = null;
      this.needSeek = false;   // 미리듣기 시작 위치로 아직 안 옮김
      this.previewEnd = null;  // 미리듣기가 끝나는 시각(초)
      this.timer = null;
      players.push(this);
    }
    // 재생이 시작되면 미리듣기 구간으로 옮기고, 끝 시각을 지켜본다
    startPreview() {
      if (!this.needSeek) return;
      this.needSeek = false;
      if (!state.preview) return;
      const r = previewRange(this.yt.getDuration());
      if (!r) return;
      if (r.start > 0 && this.yt.getCurrentTime() < r.start - 2) this.yt.seekTo(r.start, true);
      this.previewEnd = r.end;
      clearInterval(this.timer);
      this.timer = setInterval(() => this.checkPreview(), 500);
    }
    checkPreview() {
      if (this.previewEnd === null || !state.preview) return this.stopPreview();
      let t = 0;
      try { t = this.yt.getCurrentTime(); } catch (e) { return; }
      if (t >= this.previewEnd - 0.3) { this.stopPreview(); this.onPreviewEnd(); }
    }
    stopPreview() { clearInterval(this.timer); this.timer = null; this.previewEnd = null; }
    create() {
      if (this.yt) return;
      const go = () => {
        this.yt = new YT.Player(this.elId, {
          width: "100%", height: "100%",
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
          events: {
            onReady: () => { this.ready = true; if (this.pending) this.load(...this.pending); },
            onStateChange: (e) => {
              if (e.data === YT.PlayerState.PLAYING) { pauseOthers(this); this.startPreview(); }
              if (e.data === YT.PlayerState.ENDED) { this.stopPreview(); this.onEnd(); }
            },
            onError: () => this.onError(),
          },
        });
      };
      ytApiReady ? go() : waiting.push(go);
    }
    load(id, autoplay) {
      this.create();
      if (!this.ready) { this.pending = [id, autoplay]; return; }
      this.pending = null;
      this.stopPreview();
      this.needSeek = true;
      if (autoplay) { pauseOthers(this); this.yt.loadVideoById(id); } else this.yt.cueVideoById(id);
    }
    pause() {
      try { if (this.ready) this.yt.pauseVideo(); } catch (e) { /* 무시 */ }
    }
  }

  // 목록을 차례로 재생하는 미니 플레이어 (검색 · 내 플리 · 상세에서 사용)
  class QueuePlayer {
    constructor(name, onChange) {
      this.box = document.querySelector(`[data-player="${name}"]`);
      this.box.innerHTML = `
        <div class="video"><div id="yt-${name}"></div></div>
        <div class="mini-bar">
          <div class="meta-text"><h2></h2><p></p></div>
          <button class="preview-toggle" data-act="preview" type="button" aria-pressed="false" aria-label="1분 미리듣기">1분</button>
          <button class="icon-btn" data-act="prev" type="button" aria-label="이전 곡">${ICON.prev}</button>
          <button class="icon-btn" data-act="next" type="button" aria-label="다음 곡">${ICON.next}</button>
        </div>`;
      this.slot = new YtSlot(`yt-${name}`, { onEnd: () => this.step(1), onError: () => this.step(1) });
      this.queue = [];
      this.index = -1;
      this.onChange = onChange || (() => {});
      this.box.querySelector('[data-act="prev"]').addEventListener("click", () => this.step(-1));
      this.box.querySelector('[data-act="next"]').addEventListener("click", () => this.step(1));
      this.box.querySelector('[data-act="preview"]').addEventListener("click", () => setPreview(!state.preview));
    }
    play(songs, start = 0, shuffle = false) {
      let q = songs.slice();
      if (shuffle) {
        for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; }
        start = 0;
      }
      if (!q.length) return;
      this.queue = q;
      this.at(start);
    }
    step(d) { if (this.queue.length) this.at(this.index + d); }
    at(i) {
      const n = this.queue.length;
      this.index = ((i % n) + n) % n;
      const s = this.queue[this.index];
      this.box.classList.remove("hidden");
      this.box.querySelector("h2").textContent = s.title;
      this.box.querySelector("p").textContent = s.artist;
      this.slot.load(s.id, true);
      this.onChange(s.id);
    }
    get currentId() { return this.index >= 0 && this.queue[this.index] ? this.queue[this.index].id : null; }
    stop() { this.slot.pause(); this.box.classList.add("hidden"); this.queue = []; this.index = -1; }
  }

  const explorePlayer = new YtSlot("yt-explore", {
    onError: () => { if (state.current) state.skipped.add(state.current.id); nextSong(); },
    // 탐색은 평가를 받아야 하므로 1분 뒤 멈추고 기다린다
    onPreviewEnd: () => { explorePlayer.pause(); toast("1분 미리듣기 끝 · 좋아요나 별로를 눌러주세요"); },
  });

  // 미리듣기 켜기/끄기. 듣던 중에 끄면 그 곡은 끝까지 이어서 재생된다.
  function setPreview(on) {
    state.preview = on;
    store.set("preview", on);
    document.querySelectorAll(".preview-toggle").forEach((b) => {
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on);
    });
    if (!on) players.forEach((p) => p.stopPreview());
    toast(on ? "1분 미리듣기 켬 · 하이라이트 1분만 들어요" : "미리듣기 끔 · 끝까지 들어요");
  }
  document.querySelectorAll(".preview-toggle").forEach((b) => {
    b.classList.toggle("on", state.preview);
    b.setAttribute("aria-pressed", state.preview);
  });
  $("btn-preview").addEventListener("click", () => setPreview(!state.preview));
  const searchPlayer = new QueuePlayer("search", () => markPlaying("search-list", searchPlayer));
  const minePlayer = new QueuePlayer("mine", () => markPlaying("pl-list", minePlayer));
  const detailPlayer = new QueuePlayer("detail", () => markPlaying("detail-list", detailPlayer));

  function markPlaying(listId, player) {
    const id = player.currentId;
    document.querySelectorAll(`#${listId} .row.song`).forEach((r) => r.classList.toggle("playing", r.dataset.id === id));
  }

  // ---------- 곡 행(공통) ----------
  function songRow(s, { remove = false, index } = {}) {
    const added = inMine(s.id);
    const action = remove
      ? `<button class="row-btn" type="button" data-del="${index}" aria-label="삭제">${ICON.x}</button>`
      : `<button class="row-btn add${added ? " done" : ""}" type="button" data-add="${esc(s.id)}" aria-label="${added ? "내 플리에 담김" : "내 플리에 담기"}">${added ? ICON.check : ICON.plus}</button>`;
    return `
      <div class="row song" data-id="${esc(s.id)}" data-i="${index ?? ""}" role="button" tabindex="0">
        <div class="thumb" style="background-image:url('${thumb(s.id)}')"></div>
        <div class="row-text">
          <div class="row-title">${esc(s.title)}</div>
          <div class="row-sub">${s.region === "kr" ? '<span class="kr-tag">한국</span>' : ""}${esc(s.artist)}${s.year ? " · " + s.year : ""}</div>
        </div>
        ${action}
      </div>`;
  }

  function addToMine(s, quiet) {
    if (inMine(s.id)) return false;
    state.playlist.push({ id: s.id, artist: s.artist, title: s.title, year: s.year });
    store.set("playlist", state.playlist);
    renderPlaylist();
    if (!quiet) toast("내 플리에 담았어요");
    return true;
  }

  // 목록 클릭: ＋ 버튼이면 담기, 아니면 그 곡부터 재생
  function bindSongList(listId, getSongs, player) {
    const list = $(listId);
    list.addEventListener("click", (e) => {
      const add = e.target.closest("[data-add]");
      if (add) {
        const s = getSongs().find((x) => x.id === add.dataset.add);
        if (s && addToMine(s)) {
          add.classList.add("done");
          add.innerHTML = ICON.check;
          add.setAttribute("aria-label", "내 플리에 담김");
        }
        return;
      }
      if (e.target.closest("[data-del]")) return;
      const row = e.target.closest(".row.song");
      if (!row) return;
      const songs = getSongs();
      player.play(songs, Math.max(0, songs.findIndex((x) => x.id === row.dataset.id)));
    });
    list.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.classList.contains("song")) e.target.click();
    });
  }

  // ---------- 외국 / 한국, 장르 / 연도대 ----------
  // 외국은 장르로, 한국은 연간 차트 연도대로 고른다.
  const sel = () => state.selected[state.region];
  const saveSel = () => store.set(state.region === "kr" ? "eras" : "genres", [...sel()]);
  const regionSongs = () => state.data.songs.filter((s) => (s.region || "global") === state.region);

  function chipsFor() {
    if (state.region === "kr") {
      return (state.data.eras || []).map((e) => ({ id: e.id, label: e.label, match: (s) => s.year >= e.from && s.year <= e.to }));
    }
    return state.data.genres.map((g) => ({ id: g.id, label: g.label, match: (s) => s.genres.includes(g.id) }));
  }

  function chipMatch(s) {
    return chipsFor().some((c) => sel().has(c.id) && c.match(s));
  }

  function renderChips() {
    const wrap = $("genres");
    wrap.innerHTML = "";
    const songs = regionSongs();
    const kr = state.region === "kr";
    $("chip-label").textContent = kr ? "연도" : "장르";
    $("chip-footer").textContent = kr
      ? "멜론·가온 연간 차트에 올랐던 해 기준이에요. 여러 개 고를 수 있어요."
      : "전 세계 인기 재생목록 기준이에요. 여러 개 고를 수 있어요.";
    let shown = 0;
    chipsFor().forEach((c) => {
      const n = songs.filter(c.match).length;
      if (!n) return;
      shown++;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.setAttribute("aria-pressed", sel().has(c.id));
      b.innerHTML = `${ICON.check}${esc(c.label)} <span class="count">${n}</span>`;
      b.addEventListener("click", () => {
        sel().has(c.id) ? sel().delete(c.id) : sel().add(c.id);
        b.setAttribute("aria-pressed", sel().has(c.id));
        saveSel();
        updateToggleAll();
        if (!state.current || !chipMatch(state.current)) nextSong();
        else updateRemaining();
      });
      wrap.appendChild(b);
    });
    if (!shown) wrap.innerHTML = `<p class="chips-empty">${kr ? "한국 차트 곡을 모으는 중이에요. 하루 이틀 뒤에 다시 와주세요." : "곡 목록을 불러오는 중이에요."}</p>`;
    updateToggleAll();
  }

  function visibleChips() {
    const songs = regionSongs();
    return chipsFor().filter((c) => songs.some(c.match)).map((c) => c.id);
  }

  function updateToggleAll() {
    const all = visibleChips();
    $("toggle-all").classList.toggle("hidden", !all.length);
    $("toggle-all").textContent = all.length && all.every((g) => sel().has(g)) ? "전체 해제" : "전체 선택";
  }

  $("toggle-all").addEventListener("click", () => {
    const all = visibleChips();
    const allOn = all.every((g) => sel().has(g));
    state.selected[state.region] = new Set(allOn ? [] : all);
    saveSel();
    renderChips();
    nextSong();
  });

  function setRegion(r) {
    state.region = r;
    store.set("region", r);
    document.querySelectorAll(".region-seg").forEach((b) => {
      b.classList.toggle("active", b.dataset.region === r);
      b.setAttribute("aria-selected", b.dataset.region === r);
    });
    state.current = null;
    state.skipped.clear();
    renderChips();
    nextSong();
  }
  document.querySelectorAll(".region-seg").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.region !== state.region) setRegion(b.dataset.region);
  }));

  // ---------- 탐색 ----------
  function candidates() {
    return regionSongs().filter((s) => chipMatch(s) && !state.seen.has(s.id) && !state.skipped.has(s.id));
  }

  function nextSong() {
    const pool = candidates().filter((s) => !state.current || s.id !== state.current.id);
    const what = state.region === "kr" ? "연도" : "장르";
    if (!sel().size) return showEmpty(`${what}를 골라주세요`, `고른 ${what}에서 한 곡씩 틀어드려요.`, false);
    if (!pool.length) {
      if (state.skipped.size) { state.skipped.clear(); const again = candidates(); if (again.length) return show(pick(again)); }
      return showEmpty(`이 ${what}는 다 들었어요`, `다른 ${what}를 고르거나 평가 기록을 초기화해 보세요.`, true);
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
    $("np-info").textContent = song.region === "kr"
      ? `${song.year} 연간차트`
      : `${song.year} · ${fmtViews(song.views)}회`;
    explorePlayer.load(song.id, false);
    updateRemaining();
  }

  function showEmpty(title, sub, showReset) {
    state.current = null;
    explorePlayer.pause();
    $("explore-now").classList.add("hidden");
    $("explore-empty").classList.remove("hidden");
    $("empty-title").textContent = title;
    $("empty-sub").textContent = sub;
    $("reset-seen-inline").classList.toggle("hidden", !showReset);
  }

  function updateRemaining() {
    $("remaining").textContent = `고른 ${state.region === "kr" ? "연도" : "장르"}에 남은 곡 ${candidates().length}곡`;
  }

  function rate(liked) {
    const s = state.current;
    if (!s) return;
    state.seen.add(s.id);
    store.set("seen", [...state.seen]);
    if (liked) addToMine(s);
    nextSong();
  }

  $("btn-like").addEventListener("click", () => rate(true));
  $("btn-dislike").addEventListener("click", () => rate(false));
  $("btn-skip").addEventListener("click", () => {
    if (state.current) state.skipped.add(state.current.id);
    nextSong();
  });

  // ---------- 검색 ----------
  const fold = (s) => String(s).toLowerCase().normalize("NFKC").replace(/[\s'’".,!?()\[\]\-_&]+/g, "");
  let searchIndex = [];
  let searchResults = [];

  function buildSearchIndex() {
    searchIndex = state.data.songs.map((s) => ({ s, key: fold(s.artist) + "|" + fold(s.title) + "|" + fold(s.aka || "") }));
  }

  function runSearch() {
    const q = $("search-input").value.trim();
    $("search-clear").classList.toggle("hidden", !q);
    const words = q.split(/\s+/).map(fold).filter(Boolean);
    if (!words.length) {
      searchResults = [];
      $("search-list").innerHTML = "";
      $("search-list").classList.add("hidden");
      $("search-count").textContent = "";
      $("search-empty").classList.remove("hidden");
      $("search-empty-title").textContent = "듣고 싶은 노래를 찾아보세요";
      $("search-empty-sub").textContent = `${state.data.songs.length.toLocaleString()}곡 중에서 찾아요. 곡을 누르면 바로 재생되고, ＋를 누르면 내 플리에 담겨요.`;
      return;
    }
    const hits = searchIndex.filter((x) => words.every((w) => x.key.includes(w))).map((x) => x.s);
    searchResults = hits.slice(0, 80);
    $("search-count").textContent = hits.length ? `${hits.length.toLocaleString()}곡` : "";
    $("search-list").classList.toggle("hidden", !hits.length);
    $("search-empty").classList.toggle("hidden", !!hits.length);
    if (!hits.length) {
      $("search-empty-title").textContent = "찾는 곡이 없어요";
      $("search-empty-sub").textContent = "다른 이름이나 영어 표기로 찾아보세요.";
    }
    $("search-list").innerHTML = searchResults.map((s) => songRow(s)).join("");
    markPlaying("search-list", searchPlayer);
  }

  let searchTimer;
  $("search-input").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 120); });
  $("search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
  $("search-clear").addEventListener("click", () => { $("search-input").value = ""; runSearch(); $("search-input").focus(); });
  bindSongList("search-list", () => searchResults, searchPlayer);

  // ---------- 내 플리 ----------
  function renderPlaylist() {
    const list = $("pl-list");
    const n = state.playlist.length;
    $("pl-count").textContent = n ? `${n}곡` : "";
    $("tab-badge").textContent = n;
    $("tab-badge").classList.toggle("hidden", !n);
    $("pl-empty").classList.toggle("hidden", !!n);
    list.classList.toggle("hidden", !n);
    ["btn-play-all", "btn-shuffle", "btn-export", "btn-share-link", "btn-publish"].forEach((id) => { $(id).disabled = !n; });
    list.innerHTML = state.playlist.map((s, i) => songRow(s, { remove: true, index: i })).join("");
    markPlaying("pl-list", minePlayer);
  }

  $("pl-list").addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (!del) return;
    state.playlist.splice(+del.dataset.del, 1);
    store.set("playlist", state.playlist);
    renderPlaylist();
    if (state.view === "search") runSearch();
    toast("삭제했어요");
  });
  bindSongList("pl-list", () => state.playlist, minePlayer);

  $("btn-play-all").addEventListener("click", () => minePlayer.play(state.playlist));
  $("btn-shuffle").addEventListener("click", () => minePlayer.play(state.playlist, 0, true));

  // YouTube 임시 재생목록으로 열기 (최대 50곡)
  $("btn-export").addEventListener("click", () => {
    const ids = state.playlist.slice(0, 50).map((s) => s.id).join(",");
    if (ids) window.open("https://www.youtube.com/watch_videos?video_ids=" + ids, "_blank", "noopener");
  });

  // 링크 공유: 곡 id를 주소 뒤(#)에 담는다. 서버 없이 동작.
  const MAX_LINK_SONGS = 100;
  function shareLink(ids, title) {
    let url = location.origin + location.pathname + "#pl=" + ids.slice(0, MAX_LINK_SONGS).join(".");
    if (title) url += "&t=" + encodeURIComponent(title);
    return url;
  }

  async function shareUrl(url, title) {
    if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
      try { await navigator.share({ title: title || "Rewind 플레이리스트", url }); return; } catch (e) { if (e.name === "AbortError") return; }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast("링크를 복사했어요");
    } catch (e) {
      window.prompt("이 링크를 복사하세요", url);
    }
  }

  $("btn-share-link").addEventListener("click", () => {
    if (!state.playlist.length) return;
    shareUrl(shareLink(state.playlist.map((s) => s.id), ""), "내 플레이리스트");
    if (state.playlist.length > MAX_LINK_SONGS) toast(`링크에는 앞의 ${MAX_LINK_SONGS}곡만 담겨요`);
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

  // ---------- 공유 플리: 서버 통신 ----------
  async function api(path, opts = {}) {
    const res = await fetch("/api" + path, {
      ...opts,
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
    });
    let body = {};
    try { body = await res.json(); } catch (e) { /* 빈 응답 */ }
    if (!res.ok) throw new Error(body.error || "잠시 후 다시 시도해 주세요.");
    return body;
  }

  // ---------- 공유 플리: 올리기 ----------
  function openPublish() {
    if (!state.playlist.length) return;
    $("publish-name").value = "";
    $("publish-author").value = store.get("nickname", "");
    $("publish-info").textContent = `내 플리의 ${Math.min(state.playlist.length, 100)}곡이 올라가요. 올린 뒤에도 내 플리는 그대로예요.`;
    $("publish-sheet").classList.remove("hidden");
    setTimeout(() => $("publish-name").focus(), 50);
  }
  function closePublish() { $("publish-sheet").classList.add("hidden"); }

  $("btn-publish").addEventListener("click", openPublish);
  $("publish-cancel").addEventListener("click", closePublish);
  $("publish-sheet").addEventListener("click", (e) => { if (e.target.id === "publish-sheet") closePublish(); });
  $("publish-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("publish-name").value.trim();
    const author = $("publish-author").value.trim();
    if (!title) { $("publish-name").focus(); return; }
    store.set("nickname", author);
    const btn = $("publish-submit");
    btn.disabled = true;
    try {
      const res = await api("/playlists", {
        method: "POST",
        body: JSON.stringify({ title, author, songs: state.playlist.slice(0, 100).map((s) => s.id) }),
      });
      state.owned[res.id] = res.ownerToken;
      store.set("owned", state.owned);
      closePublish();
      toast("공유 플리에 올렸어요");
      communityLoaded = false;
      location.hash = "c=" + res.id;
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- 공유 플리: 목록 ----------
  let communitySort = "new";
  let communityItems = [];
  let communityLoaded = false;

  function cardHtml(p) {
    const ids = p.preview.length >= 4 ? p.preview.slice(0, 4) : p.preview.slice(0, 1);
    const tiles = ids.map((id) => `<i style="background-image:url('${thumb(id)}')"></i>`).join("");
    return `
      <button class="pl-card" type="button" data-cid="${esc(p.id)}">
        <div class="mosaic${ids.length === 1 ? " single" : ""}">${tiles}</div>
        <div class="pl-card-text">
          <div class="row-title">${esc(p.title)}</div>
          <div class="row-sub">${esc(p.author)} · ${p.count}곡</div>
          <div class="row-sub likes">${ICON.heart}${p.likes}</div>
        </div>
      </button>`;
  }

  async function loadCommunity(more) {
    const list = $("community-list");
    if (!more) { communityItems = []; list.innerHTML = '<div class="loading">불러오는 중…</div>'; }
    const before = more && communitySort === "new" && communityItems.length ? communityItems[communityItems.length - 1].created : 0;
    try {
      const res = await api(`/playlists?sort=${communitySort}&limit=30${before ? "&before=" + before : ""}`);
      communityItems = communityItems.concat(res.items);
      communityLoaded = true;
      list.innerHTML = communityItems.map(cardHtml).join("");
      $("community-empty").classList.toggle("hidden", !!communityItems.length);
      $("community-empty-title").textContent = "아직 올라온 플리가 없어요";
      $("community-empty-sub").textContent = "내 플리 탭에서 첫 번째로 올려보세요.";
      $("community-more").classList.toggle("hidden", communitySort !== "new" || res.items.length < 30);
    } catch (err) {
      list.innerHTML = "";
      $("community-empty").classList.remove("hidden");
      $("community-empty-title").textContent = "공유 플리를 불러오지 못했어요";
      $("community-empty-sub").textContent = err.message;
      $("community-more").classList.add("hidden");
    }
  }

  document.querySelectorAll("#view-community .seg").forEach((b) => b.addEventListener("click", () => {
    communitySort = b.dataset.sort;
    document.querySelectorAll("#view-community .seg").forEach((x) => {
      x.classList.toggle("active", x === b);
      x.setAttribute("aria-selected", x === b);
    });
    loadCommunity(false);
  }));
  $("community-more").addEventListener("click", () => loadCommunity(true));
  $("community-list").addEventListener("click", (e) => {
    const c = e.target.closest("[data-cid]");
    if (c) location.hash = "c=" + c.dataset.cid;
  });

  // ---------- 플리 상세 (공유 플리 · 링크로 받은 플리) ----------
  function songsFromIds(ids) {
    const songs = ids.map((id) => state.byId.get(id)).filter(Boolean);
    return { songs, missing: ids.length - songs.length };
  }

  function openDetail(d) {
    // d: {kind: "community"|"link", id?, title, author?, likes?, songs:[song], missing}
    state.detail = d;
    detailPlayer.stop();
    $("t-detail").textContent = d.title;
    $("detail-author").textContent = d.author ? `${d.author}님이 만든 플리` : "";
    $("detail-meta").textContent = `${d.songs.length}곡`;
    $("detail-back-label").textContent = d.kind === "community" ? "공유 플리" : "돌아가기";
    $("detail-list").innerHTML = d.songs.map((s) => songRow(s)).join("");
    $("detail-missing").textContent = d.missing ? `지금 목록에 없는 ${d.missing}곡은 빠졌어요.` : "";
    const isCommunity = d.kind === "community";
    $("detail-like").classList.toggle("hidden", !isCommunity);
    $("detail-delete").classList.toggle("hidden", !(isCommunity && state.owned[d.id]));
    updateLikeButton();
    ["detail-play", "detail-shuffle", "detail-save"].forEach((id) => { $(id).disabled = !d.songs.length; });
    showView("detail");
  }

  function updateLikeButton() {
    const d = state.detail;
    if (!d || d.kind !== "community") return;
    const liked = state.likedShared.has(d.id);
    $("detail-like").classList.toggle("liked", liked);
    $("detail-like-label").innerHTML = `${ICON.heart}${liked ? "좋아요 누름" : "좋아요"}`;
    $("detail-like-count").textContent = d.likes;
  }

  bindSongList("detail-list", () => (state.detail ? state.detail.songs : []), detailPlayer);
  $("detail-play").addEventListener("click", () => state.detail && detailPlayer.play(state.detail.songs));
  $("detail-shuffle").addEventListener("click", () => state.detail && detailPlayer.play(state.detail.songs, 0, true));

  $("detail-save").addEventListener("click", () => {
    if (!state.detail) return;
    const n = state.detail.songs.filter((s) => addToMine(s, true)).length;
    toast(n ? `내 플리에 ${n}곡을 담았어요` : "이미 모두 담겨 있어요");
    $("detail-list").innerHTML = state.detail.songs.map((s) => songRow(s)).join("");
    markPlaying("detail-list", detailPlayer);
  });

  $("detail-share").addEventListener("click", () => {
    const d = state.detail;
    if (!d) return;
    const url = d.kind === "community"
      ? location.origin + location.pathname + "#c=" + d.id
      : shareLink(d.songs.map((s) => s.id), d.title);
    shareUrl(url, d.title);
  });

  $("detail-like").addEventListener("click", async () => {
    const d = state.detail;
    if (!d || d.kind !== "community" || state.likedShared.has(d.id)) return;
    try {
      const res = await api(`/playlists/${d.id}/like`, { method: "POST" });
      d.likes = res.likes;
      state.likedShared.add(d.id);
      store.set("likedShared", [...state.likedShared]);
      updateLikeButton();
      communityLoaded = false;
    } catch (err) { toast(err.message); }
  });

  $("detail-delete").addEventListener("click", async () => {
    const d = state.detail;
    if (!d || !state.owned[d.id]) return;
    if (!confirm("이 공유 플리를 지울까요? 다른 사람들도 더 이상 볼 수 없어요.")) return;
    try {
      await api(`/playlists/${d.id}`, { method: "DELETE", headers: { "x-owner-token": state.owned[d.id] } });
      delete state.owned[d.id];
      store.set("owned", state.owned);
      toast("지웠어요");
      communityLoaded = false;
      location.hash = "";
      showView("community");
    } catch (err) { toast(err.message); }
  });

  $("detail-back").addEventListener("click", () => {
    const back = state.detail && state.detail.kind === "community" ? "community" : "explore";
    history.replaceState(null, "", location.pathname);
    showView(back);
  });

  // ---------- 화면 전환 ----------
  function showView(view) {
    state.view = view;
    const tabView = view === "detail" ? (state.detail && state.detail.kind === "community" ? "community" : null) : view;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === tabView));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + view));
    players.forEach((p) => p.pause());
    window.scrollTo({ top: 0 });
    if (view === "community" && !communityLoaded) loadCommunity(false);
    if (view === "search") runSearch();
    if (view === "playlist") renderPlaylist();
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      if (location.hash) history.replaceState(null, "", location.pathname);
      showView(tab.dataset.view);
    });
  });

  // 주소의 # 부분으로 상세 열기:  #pl=id.id.id&t=제목  또는  #c=공유플리id
  async function route() {
    const h = location.hash.replace(/^#/, "");
    if (!h) return;
    const params = new URLSearchParams(h);
    if (params.get("pl")) {
      const ids = params.get("pl").split(".").filter((x) => /^[A-Za-z0-9_-]{11}$/.test(x)).slice(0, MAX_LINK_SONGS);
      const { songs, missing } = songsFromIds(ids);
      openDetail({ kind: "link", title: params.get("t") || "공유받은 플레이리스트", songs, missing });
    } else if (params.get("c")) {
      const id = params.get("c");
      try {
        const p = await api("/playlists/" + encodeURIComponent(id));
        const { songs, missing } = songsFromIds(p.songs);
        openDetail({ kind: "community", id: p.id, title: p.title, author: p.author, likes: p.likes, songs, missing });
      } catch (err) {
        toast(err.message);
        history.replaceState(null, "", location.pathname);
        showView("community");
      }
    }
  }
  window.addEventListener("hashchange", route);

  // ---------- 시작 ----------
  fetch("songs.json", { cache: "no-cache" })
    .then((r) => r.json())
    .then((data) => {
      state.data = data;
      state.byId = new Map(data.songs.map((s) => [s.id, s]));
      data.songs.forEach((s) => { s.region = s.region || "global"; s.genres = s.genres || []; });
      const gids = new Set(data.genres.map((g) => g.id));
      const eids = new Set((data.eras || []).map((e) => e.id));
      state.selected.global = new Set([...state.selected.global].filter((g) => gids.has(g)));
      state.selected.kr = new Set([...state.selected.kr].filter((g) => eids.has(g)));
      $("updated").textContent = data.updated && data.updated !== "sample" ? `업데이트 ${data.updated}` : "";
      buildSearchIndex();
      setRegion(state.region);
      renderPlaylist();
      route();
    })
    .catch(() => showEmpty("곡 목록을 불러오지 못했어요", "잠시 후 새로고침해 주세요.", false));
})();
