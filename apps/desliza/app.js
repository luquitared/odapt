/* Desliza: a vertical feed of famous Hispanic moments, one Spanish line each. */
(() => {
  "use strict";

  // ---------- constants ----------
  const LEVELS = ["A1", "A2", "B1", "B2", "C1"];
  const CATS = {
    tv: "TV", film: "Cine", music: "Música", sports: "Deportes",
    history: "Historia", viral: "Viral", culture: "Cultura",
  };
  const BATCH = 8;            // clips appended at a time
  const SEEN_AFTER_MS = 3000; // a clip counts as watched after this long on screen
  const XP_WATCH = 5, XP_RIGHT = 10, XP_COMBO = 5, XP_SAVE = 1;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const track = (type, props) => { try { window.deslizaEvents && window.deslizaEvents.track(type, props); } catch (_) {} };

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const flag = (cc) => /^[A-Z]{2}$/i.test(cc || "") ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "";
  const thumb = (id) => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
  const ytLink = (c) => `https://www.youtube.com/watch?v=${encodeURIComponent(c.youtube_id)}&t=${Math.floor(c.start || 0)}s`;
  const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return today(d); };
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };

  const ICON = {
    heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5s-7.2-4.4-9.2-8.9C1.4 8.3 3.4 4.8 6.8 4.8c2.1 0 3.4 1.1 5.2 3.2 1.8-2.1 3.1-3.2 5.2-3.2 3.4 0 5.4 3.5 4 6.8-2 4.5-9.2 8.9-9.2 8.9z"/></svg>',
    soundOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h4l5-4v14l-5-4H3zM16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
    soundOn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h4l5-4v14l-5-4H3z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4l13 8-13 8z"/></svg>',
  };

  // ---------- storage (localStorage behind try/catch) ----------
  const KEY = "desliza:v1";
  const store = (() => {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (_) { s = {}; }
    s.xp = +s.xp || 0;
    s.streak = +s.streak || 0;
    s.lastDay = s.lastDay || "";
    s.saved = s.saved && typeof s.saved === "object" ? s.saved : {};
    s.watched = Array.isArray(s.watched) ? s.watched : [];
    s.levels = Array.isArray(s.levels) ? s.levels : [];
    s.cats = Array.isArray(s.cats) ? s.cats : [];
    s.best = +s.best || 0;
    return s;
  })();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (_) {} };

  // ---------- state ----------
  let clips = [];
  let items = [];          // {type, el, clip?, player?, ...}
  let queue = [];
  let active = -1;
  let sinceQuiz = 0, quizGap = 4;
  let round = 0, roundLeft = 0;
  let combo = 0, quizNo = 0;
  let unmuted = false;
  let userPaused = false;
  const sessionSeen = [];  // clip ids seen this session, in order
  const asked = new Set(); // clip ids quizzed this session
  let seenTimer = 0, loopTimer = 0;

  const feed = $("#feed");

  // ---------- data ----------
  async function loadClips() {
    for (const url of ["data/clips.json", "data/sample.json"]) {
      try {
        const r = await fetch(url, { cache: "no-cache" });
        if (!r.ok) continue;
        const j = await r.json();
        const list = (Array.isArray(j) ? j : j.clips || []).filter((c) => c && c.youtube_id && c.line && c.line.es);
        if (list.length) return list;
      } catch (_) { /* try the next */ }
    }
    return [];
  }

  // Shuffle, then reorder so neighbours differ in category and country where possible.
  function mix(pool, prev) {
    const left = shuffle(pool), out = [];
    let last = prev || null;
    while (left.length) {
      let k = left.findIndex((c) => !last || (c.category !== last.category && c.country !== last.country));
      if (k < 0) k = left.findIndex((c) => !last || c.category !== last.category);
      if (k < 0) k = left.findIndex((c) => !last || c.id !== last.id);
      if (k < 0) k = 0;
      last = left.splice(k, 1)[0];
      out.push(last);
    }
    return out;
  }

  const pool = () => clips.filter((c) =>
    (!store.levels.length || store.levels.includes(c.level)) &&
    (!store.cats.length || store.cats.includes(c.category)));

  // ---------- HUD ----------
  function renderHud(bump) {
    const alive = store.lastDay === today() || store.lastDay === yesterday();
    $("#streakN").textContent = alive ? store.streak : 0;
    $("#xpN").textContent = store.xp;
    const n = Object.keys(store.saved).length;
    const b = $("#vocabN");
    b.hidden = !n; b.textContent = n;
    $("#vocabBtn").setAttribute("aria-label", `Mi vocabulario, ${n} saved`);
    $("#filterDot").hidden = !(store.levels.length || store.cats.length);
    if (bump && !reducedMotion) {
      const el = $("#" + bump);
      el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
    }
  }
  function addXp(n) { store.xp += n; save(); renderHud("xp"); }
  function touchStreak() {
    const t = today();
    if (store.lastDay === t) return;
    store.streak = store.lastDay === yesterday() ? store.streak + 1 : 1;
    store.lastDay = t;
    save(); renderHud("streak");
    if (store.streak > 1) toast(`🔥 ${store.streak} days in a row`);
  }

  let toastT = 0;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 1800);
  }

  // ---------- feed building ----------
  function rebuild() {
    destroyAll();
    feed.innerHTML = "";
    items = []; queue = []; active = -1; sinceQuiz = 0; quizGap = 4; round = 0; roundLeft = 0;
    const p = pool();
    if (!p.length) { addEmpty(); return; }
    appendMore();
    feed.scrollTop = 0;
    requestAnimationFrame(() => setActive(0));
  }

  function appendMore() {
    const p = pool();
    if (!p.length) return;
    for (let n = 0; n < BATCH; n++) {
      if (!queue.length) {
        if (round > 0) addItem({ type: "end" });
        round++;
        const lastClip = [...items].reverse().find((i) => i.type === "clip");
        queue = mix(p, lastClip && lastClip.clip);
        roundLeft = queue.length;
      }
      const clip = queue.shift(); roundLeft--;
      addItem({ type: "clip", clip });
      sinceQuiz++;
      if (sinceQuiz >= quizGap && clips.some((c) => c.quiz)) {
        addItem({ type: "quiz", filled: false });
        sinceQuiz = 0; quizGap = quizGap === 4 ? 5 : 4;
      }
    }
  }

  function addItem(it) {
    it.index = items.length;
    it.el = it.type === "clip" ? clipCard(it.clip) : it.type === "quiz" ? quizShell() : endCard();
    it.el.dataset.i = it.index;
    items.push(it);
    feed.appendChild(it.el);
  }

  function addEmpty() {
    const el = document.createElement("article");
    el.className = "card endcard";
    el.innerHTML = `<div class="col"><h2>Nada por aquí</h2><p>No clips match these filters. Widen the level or pick more categories.</p>
      <button type="button" class="cta" data-act="filters">Change filters</button></div>`;
    feed.appendChild(el);
  }

  function lineSize(es) {
    const n = es.length;
    return n <= 18 ? 42 : n <= 30 ? 36 : n <= 46 ? 30 : n <= 70 ? 25 : n <= 100 ? 21 : 18;
  }

  function clipCard(c) {
    const el = document.createElement("article");
    el.className = "card clip";
    el.tabIndex = -1;
    el.setAttribute("aria-label", c.title || c.line.es);
    const phrases = c.phrases || [];
    const lineKey = keyOf(c.line.es);
    el.innerHTML = `
      <div class="bg" style="background-image:url('${thumb(c.youtube_id)}')"></div>
      <div class="col">
        <div class="screen idle">
          <span class="poster"><img src="${thumb(c.youtube_id)}" alt="" loading="lazy" decoding="async"></span>
          <div class="slot"><div></div></div>
          <span class="loading" aria-hidden="true"></span>
          <span class="paused-mark" aria-hidden="true">${ICON.play}</span>
          <button type="button" class="tap" data-act="tap" aria-label="Turn sound on">
            <span class="sound"><span class="off">${ICON.soundOff}</span><span class="on">${ICON.soundOn}</span><span class="label">Tap for sound</span></span>
          </button>
        </div>
        <div class="words">
          <div class="meta">
            <span class="tag cat cat-${esc(c.category)}">${esc(CATS[c.category] || c.category || "")}</span>
            <span class="tag"><span class="flag" aria-hidden="true">${flag(c.country)}</span>${esc(c.country || "")}${c.year ? " · " + esc(c.year) : ""}</span>
            ${c.level ? `<span class="tag lvl" title="CEFR level">${esc(c.level)}</span>` : ""}
          </div>
          <h2 class="title">${esc(c.title || "")}</h2>
          <p class="hook" data-act="hook">${esc(c.hook || "")}</p>
          <button type="button" class="line" data-act="line" aria-expanded="false" style="--fs:${lineSize(c.line.es)}">
            <span class="es" lang="es">${esc(c.line.es)}</span>
            <span class="en"><span>${esc(c.line.en || "")}</span></span>
            <span class="hint">Tap for English</span>
          </button>
          <div class="actions">
            <button type="button" class="btn grow" data-act="phrases">Frases <span class="count">${phrases.length + 1}</span></button>
            <button type="button" class="heart" data-act="saveline" aria-pressed="${!!store.saved[lineKey]}" aria-label="Save this line to Mi vocabulario">${ICON.heart}</button>
          </div>
        </div>
      </div>`;
    return el;
  }

  function quizShell() {
    const el = document.createElement("article");
    el.className = "card quiz";
    el.tabIndex = -1;
    el.setAttribute("aria-label", "Quiz");
    el.innerHTML = `<div class="col"><div class="loteria"><p class="lot-name">La pregunta</p></div></div>`;
    return el;
  }

  function endCard() {
    const el = document.createElement("article");
    el.className = "card endcard";
    el.tabIndex = -1;
    const n = pool().length;
    el.innerHTML = `<div class="col">
      <h2>¡Otra vuelta!</h2>
      <p>You've scrolled all ${n} moment${n === 1 ? "" : "s"} in this mix. Keep going for another round in a new order, or change what you see.</p>
      <div class="actions"><button type="button" class="btn" data-act="vocab">${ICON.heart} Mi vocabulario</button>
      <button type="button" class="btn ghost" data-act="filters">Filters</button></div></div>`;
    return el;
  }

  function fillQuiz(it) {
    if (it.filled) return;
    // A clip seen this session and not yet asked, newest first; else any clip before this card.
    const before = items.slice(0, it.index).filter((i) => i.type === "clip" && i.clip.quiz).map((i) => i.clip);
    const seen = sessionSeen.map((id) => before.find((c) => c.id === id)).filter(Boolean);
    const fresh = (list) => list.filter((c) => !asked.has(c.id));
    const pickFrom = fresh(seen).length ? fresh(seen) : fresh(before).length ? fresh(before) : before;
    const c = pickFrom.length ? pickFrom[(Math.random() * Math.min(3, pickFrom.length)) | 0] : null;
    if (!c) return;
    asked.add(c.id);
    it.filled = true; it.clip = c; it.answered = false;
    quizNo++;
    const q = c.quiz;
    const opts = (q.options || []).map((o, k) =>
      `<button type="button" class="opt" data-act="answer" data-k="${k}"><span class="k" aria-hidden="true">${"ABCD"[k]}</span><span>${esc(o)}</span></button>`).join("");
    it.el.setAttribute("aria-label", `Quiz: ${q.q}`);
    it.el.innerHTML = `<div class="col"><div class="loteria">
      <div class="lot-top"><span>Nº ${quizNo}</span><span class="combo" data-combo>${combo > 1 ? "Combo ×" + combo : ""}</span></div>
      <div class="lot-pic" style="background-image:url('${thumb(c.youtube_id)}')"><span>${esc(c.title || c.line.es)}</span></div>
      <p class="lot-name">La pregunta</p>
      <p class="q">${esc(q.q)}</p>
      <div class="opts" role="group" aria-label="Answers">${opts}</div>
      <p class="verdict" aria-live="polite"></p>
    </div><p class="next-hint" hidden>Sigue deslizando ↓</p></div>`;
  }

  function answer(it, k) {
    if (!it || it.type !== "quiz" || it.answered || !it.clip) return;
    it.answered = true;
    const q = it.clip.quiz, right = k === q.answer;
    const btns = it.el.querySelectorAll(".opt");
    btns.forEach((b, i) => {
      b.disabled = true;
      if (i === q.answer) b.classList.add("right");
      else if (i === k) b.classList.add("wrong");
      else b.classList.add("dim");
    });
    const v = $(".verdict", it.el);
    if (right) {
      combo++;
      store.best = Math.max(store.best, combo);
      const gain = XP_RIGHT + XP_COMBO * Math.min(combo - 1, 6);
      addXp(gain);
      const word = combo >= 5 ? "¡Imparable!" : combo >= 3 ? "¡Ándale!" : combo === 2 ? "¡Otra vez!" : "¡Eso!";
      v.innerHTML = `<span class="big">${word}</span>+${gain} XP${combo > 1 ? ` · combo ×${combo}` : ""}`;
      sfx.right(combo);
    } else {
      combo = 0;
      v.innerHTML = `<span class="big">Casi</span>It's “${esc(q.options[q.answer])}”.`;
      sfx.wrong();
    }
    $("[data-combo]", it.el).textContent = combo > 1 ? "Combo ×" + combo : "";
    $(".next-hint", it.el).hidden = false;
    save();
    track("quiz_answer", { clip: it.clip.id, right, combo });
  }

  // ---------- players ----------
  let ytReady = null;
  function loadYT() {
    if (ytReady) return ytReady;
    ytReady = new Promise((resolve) => {
      if (window.YT && window.YT.Player) return resolve(window.YT);
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prev && prev(); resolve(window.YT); };
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.async = true;
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
    return ytReady;
  }

  async function ensurePlayer(it) {
    if (it.type !== "clip" || it.player || it.creating || it.failed) return;
    it.creating = true;
    const YT = await loadYT();
    it.creating = false;
    if (!YT || !it.wanted) return;
    const c = it.clip, screen = $(".screen", it.el), slot = $(".slot", it.el);
    slot.innerHTML = "<div></div>";
    screen.classList.remove("idle");
    const vars = {
      start: Math.floor(c.start || 0), end: Math.ceil(c.end || 0) || undefined,
      autoplay: 0, mute: 1, controls: 0, playsinline: 1, rel: 0, modestbranding: 1,
      iv_load_policy: 3, disablekb: 1, fs: 0, cc_load_policy: 0,
    };
    if (/^https?:/.test(location.protocol)) vars.origin = location.origin;
    it.player = new YT.Player(slot.firstChild, {
      videoId: c.youtube_id,
      width: "100%", height: "100%",
      playerVars: vars,
      events: {
        onReady: () => {
          it.ready = true;
          const f = it.player.getIframe && it.player.getIframe();
          if (f) { f.setAttribute("title", c.title || "Video"); f.tabIndex = -1; }
          applyMute(it);
          if (it.index === active && !userPaused) play(it);
        },
        onStateChange: (e) => {
          const S = YT.PlayerState;
          if (e.data === S.PLAYING) { screen.classList.add("playing"); screen.classList.remove("paused"); }
          if (e.data === S.ENDED && it.index === active) { it.player.seekTo(c.start || 0, true); it.player.playVideo(); }
        },
        onError: (e) => { it.failed = true; screen.dataset.err = e && e.data; showFailed(it); },
      },
    });
  }

  function showFailed(it) {
    const screen = $(".screen", it.el);
    screen.classList.remove("playing"); screen.classList.add("idle");
    try { it.player && it.player.destroy(); } catch (_) {}
    it.player = null;
    $(".tap", it.el).outerHTML = `<a class="tap" href="${ytLink(it.clip)}" target="_blank" rel="noopener"><span class="sound">${ICON.play} Watch on YouTube</span></a>`;
  }

  function play(it) {
    if (!it || !it.player || !it.ready || !$("#intro").hidden) return;
    const c = it.clip, p = it.player;
    try {
      const t = p.getCurrentTime ? p.getCurrentTime() : 0;
      if (t < (c.start || 0) - 1 || (c.end && t >= c.end)) p.seekTo(c.start || 0, true);
      applyMute(it);
      p.playVideo();
    } catch (_) {}
    // If sound-on autoplay is blocked, fall back to muted.
    clearTimeout(it.blockT);
    if (unmuted) it.blockT = setTimeout(() => {
      try {
        const st = p.getPlayerState();
        if (it.index === active && !userPaused && st !== 1 && st !== 3) { setMuted(true, true); p.playVideo(); }
      } catch (_) {}
    }, 2500);
  }
  function pause(it) { try { it && it.player && it.ready && it.player.pauseVideo(); } catch (_) {} }
  function applyMute(it) {
    try { if (unmuted) { it.player.unMute(); it.player.setVolume(100); } else it.player.mute(); } catch (_) {}
  }
  function destroy(it) {
    if (!it.player && !it.creating) return;
    try { it.player && it.player.destroy(); } catch (_) {}
    it.player = null; it.ready = false; it.wanted = false;
    const screen = $(".screen", it.el);
    if (screen) { screen.classList.remove("playing", "paused"); screen.classList.add("idle"); $(".slot", it.el).innerHTML = "<div></div>"; }
  }
  function destroyAll() { items.forEach(destroy); }

  function setMuted(m, quiet) {
    unmuted = !m;
    document.body.classList.toggle("unmuted", unmuted);
    document.querySelectorAll(".clip .tap").forEach((b) => b.setAttribute("aria-label", unmuted ? "Pause or play" : "Turn sound on"));
    items.forEach((it) => it.player && it.ready && applyMute(it));
    if (!quiet) toast(unmuted ? "Sound on" : "Sound off");
    if (unmuted) track("unmute");
  }

  function togglePause() {
    const it = items[active];
    if (!it || it.type !== "clip" || !it.player) return;
    const screen = $(".screen", it.el);
    userPaused = !userPaused;
    if (userPaused) { pause(it); screen.classList.add("paused"); }
    else { screen.classList.remove("paused"); play(it); }
  }

  // ---------- active card ----------
  function setActive(i) {
    if (i === active || !items[i]) return;
    const prev = items[active];
    if (prev) { pause(prev); clearTimeout(prev.blockT); }
    active = i; userPaused = false;
    const it = items[i];
    document.body.dataset.card = it.type;

    // live players: this card and the next clip only
    const nextClip = items.slice(i + 1).find((x) => x.type === "clip");
    items.forEach((x) => {
      if (x.type !== "clip") return;
      const keep = x === it || x === nextClip;
      if (!keep) destroy(x);
    });
    [it, nextClip].forEach((x) => { if (x && x.type === "clip") { x.wanted = true; ensurePlayer(x); } });
    if (it.type === "clip") {
      $(".screen", it.el).classList.remove("paused");
      play(it);
    }

    // quiz cards are written when they come close, from what has been seen
    items.slice(i, i + 2).forEach((x) => x.type === "quiz" && fillQuiz(x));

    clearTimeout(seenTimer);
    if (it.type === "clip") seenTimer = setTimeout(() => markSeen(it.clip), SEEN_AFTER_MS);

    clearInterval(loopTimer);
    if (it.type === "clip") loopTimer = setInterval(() => loopCheck(it), 300);

    if (i >= items.length - 4) appendMore();
  }

  function loopCheck(it) {
    if (!it.player || !it.ready || userPaused) return;
    try {
      const c = it.clip, t = it.player.getCurrentTime();
      if (c.end && t >= c.end - 0.2) it.player.seekTo(c.start || 0, true);
    } catch (_) {}
  }

  function markSeen(c) {
    if (!sessionSeen.includes(c.id)) sessionSeen.push(c.id);
    touchStreak();
    if (!store.watched.includes(c.id)) {
      store.watched.push(c.id);
      addXp(XP_WATCH);
    }
    save();
    track("clip_view", { clip: c.id });
    if (sessionSeen.length === 10) track("scroll_deep", { clips: 10 });
  }

  // Cards are all one screen tall, so the visible one is the nearest multiple of the height.
  let scrollRaf = 0;
  function onScroll() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      const h = feed.clientHeight || 1;
      setActive(Math.round(feed.scrollTop / h));
    });
  }
  feed.addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll);

  function go(d) {
    const i = Math.max(0, Math.min(items.length - 1, active + d));
    const el = items[i] && items[i].el;
    if (!el) return;
    feed.scrollTo({ top: el.offsetTop, behavior: reducedMotion ? "auto" : "smooth" });
    el.focus({ preventScroll: true });
  }

  // ---------- saved phrases ----------
  function keyOf(es) { return String(es).toLowerCase().replace(/[¡!¿?.,]/g, "").trim(); }
  function toggleSave(p, clip, btn) {
    const k = keyOf(p.es);
    if (store.saved[k]) { delete store.saved[k]; toast("Removed from Mi vocabulario"); }
    else {
      store.saved[k] = { es: p.es, en: p.en || "", note: p.note || "", clip: clip ? clip.id : "", from: clip ? clip.title : "", t: Date.now() };
      addXp(XP_SAVE);
      toast("Saved to Mi vocabulario");
      track("phrase_saved", { clip: clip && clip.id });
    }
    save(); renderHud();
    syncHearts(k);
    if (btn && !reducedMotion) { btn.classList.remove("pop"); void btn.offsetWidth; btn.classList.add("pop"); }
  }
  function syncHearts(k) {
    document.querySelectorAll(`[data-key]`).forEach((b) => { if (b.dataset.key === k) b.setAttribute("aria-pressed", !!store.saved[k]); });
    items.forEach((it) => {
      if (it.type === "clip" && keyOf(it.clip.line.es) === k) $(".heart", it.el).setAttribute("aria-pressed", !!store.saved[k]);
    });
  }

  // ---------- sheets ----------
  let sheetReturn = null;
  function openSheet(title, html, onClick) {
    sheetReturn = document.activeElement;
    $("#sheetTitle").textContent = title;
    $("#sheetBody").innerHTML = html;
    $("#sheetBody").onclick = onClick || null;
    $("#scrim").hidden = false; $("#sheet").hidden = false;
    $("#sheetClose").focus();
  }
  function closeSheet() {
    if ($("#sheet").hidden) return;
    $("#scrim").hidden = true; $("#sheet").hidden = true;
    if (sheetReturn && sheetReturn.focus) sheetReturn.focus({ preventScroll: true });
  }

  const phraseRow = (p, extra = "") => {
    const k = keyOf(p.es);
    return `<div class="phrase"><div class="txt"><div class="es" lang="es">${esc(p.es)}</div>
      ${p.en ? `<div class="en">${esc(p.en)}</div>` : ""}${p.note ? `<div class="note">${esc(p.note)}</div>` : ""}${extra}</div>
      <button type="button" class="heart" data-key="${esc(k)}" aria-pressed="${!!store.saved[k]}" aria-label="Save “${esc(p.es)}”">${ICON.heart}</button></div>`;
  };

  function openPhrases(c) {
    const list = [{ es: c.line.es, en: c.line.en, note: "The line" }, ...(c.phrases || [])];
    const html = `<p class="sheet-sub">${esc(c.title || "")}</p>${list.map((p) => phraseRow(p)).join("")}
      <div class="sheet-links"><a class="btn ghost" href="${ytLink(c)}" target="_blank" rel="noopener">${ICON.play.replace('aria-hidden="true"', 'aria-hidden="true" width="16" height="16" fill="currentColor"')} YouTube${c.channel ? " · " + esc(c.channel) : ""}</a>
      ${c.source ? `<a class="btn ghost" href="${esc(c.source)}" target="_blank" rel="noopener">Source</a>` : ""}</div>`;
    openSheet("Frases", html, (e) => {
      const b = e.target.closest(".heart");
      if (!b) return;
      const p = list.find((x) => keyOf(x.es) === b.dataset.key);
      if (p) toggleSave(p, c, b);
    });
    track("phrases_open", { clip: c.id });
  }

  function openVocab() {
    const rows = Object.values(store.saved).sort((a, b) => b.t - a.t);
    const html = rows.length
      ? `<p class="sheet-sub">${rows.length} saved · ${store.xp} XP${store.best > 1 ? ` · best combo ×${store.best}` : ""}</p>` +
        rows.map((p) => phraseRow(p, p.from ? `<div class="from">from ${esc(p.from)}</div>` : "")).join("")
      : `<p class="empty"><b>Nothing saved yet.</b> Open a clip's Frases and tap the heart on a phrase to keep it here.</p>`;
    openSheet("Mi vocabulario", html, (e) => {
      const b = e.target.closest(".heart");
      if (!b) return;
      const p = store.saved[b.dataset.key];
      if (p) toggleSave(p, null, b);
    });
  }

  function openFilters() {
    const lv = new Set(store.levels), ct = new Set(store.cats);
    const present = Object.keys(CATS).filter((k) => clips.some((c) => c.category === k));
    const count = () => clips.filter((c) => (!lv.size || lv.has(c.level)) && (!ct.size || ct.has(c.category))).length;
    const chips = (vals, set, kind, label) => vals.map((v) =>
      `<button type="button" class="chip" data-kind="${kind}" data-v="${v}" aria-pressed="${set.has(v)}">${esc(label(v))}</button>`).join("");
    const html = `
      <div class="filter-group"><h3>Level</h3><div class="chips">${chips(LEVELS, lv, "lv", (v) => v)}</div></div>
      <div class="filter-group"><h3>Category</h3><div class="chips">${chips(present, ct, "ct", (v) => CATS[v])}</div></div>
      <p class="sheet-sub">None picked means all of them.</p>
      <div class="filter-foot"><button type="button" class="btn ghost" data-act="reset">Clear</button>
        <button type="button" class="btn" data-act="apply"><span>Show <b data-n>${count()}</b> clips</span></button></div>
      <div class="sheet-links"><button type="button" class="btn ghost" data-act="about">About Desliza</button></div>`;
    openSheet("Filters", html, (e) => {
      const chip = e.target.closest(".chip");
      if (chip) {
        const set = chip.dataset.kind === "lv" ? lv : ct, v = chip.dataset.v;
        set.has(v) ? set.delete(v) : set.add(v);
        chip.setAttribute("aria-pressed", set.has(v));
        $("[data-n]").textContent = count();
        return;
      }
      const act = e.target.closest("[data-act]");
      if (!act) return;
      if (act.dataset.act === "reset") {
        lv.clear(); ct.clear();
        $("#sheetBody").querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
        $("[data-n]").textContent = count();
      } else if (act.dataset.act === "apply") {
        store.levels = [...lv]; store.cats = [...ct]; save(); renderHud();
        closeSheet(); rebuild();
        track("filter", { levels: store.levels.join(","), cats: store.cats.join(",") });
      } else if (act.dataset.act === "about") {
        closeSheet(); openIntro();
      }
    });
  }

  // ---------- intro ----------
  function openIntro() {
    const intro = $("#intro");
    const lines = shuffle(clips).slice(0, 10).map((c) => `<span lang="es">${esc(c.line.es)}</span>`).join("");
    $("#marquee").innerHTML = lines + lines;
    const cur = store.levels.join(",");
    let matched = false;
    intro.querySelectorAll("#introLevels .chip").forEach((b) => {
      const on = b.dataset.levels === cur; matched = matched || on;
      b.classList.toggle("on", on); b.setAttribute("aria-pressed", on);
    });
    if (!matched) intro.querySelectorAll("#introLevels .chip").forEach((b) => b.setAttribute("aria-pressed", "false"));
    intro.hidden = false;
    items.forEach(pause);
    $("#startBtn").focus();
  }
  function closeIntro() {
    const intro = $("#intro");
    const sel = intro.querySelector("#introLevels .chip[aria-pressed='true']");
    const levels = sel ? sel.dataset.levels.split(",").filter(Boolean) : store.levels;
    const changed = levels.join(",") !== store.levels.join(",");
    store.levels = levels; store.introDone = true; save(); renderHud();
    intro.hidden = true;
    sfx.init();
    setMuted(false, true); // the tap on "Empezar" lets the feed start with sound
    if (changed || !items.length) rebuild();
    else { const it = items[active]; if (it && it.type === "clip") play(it); }
    const it = items[Math.max(active, 0)];
    if (it) it.el.focus({ preventScroll: true });
    track("start", { levels: store.levels.join(",") });
  }

  // ---------- sound effects ----------
  const sfx = (() => {
    let ctx = null;
    const init = () => { try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === "suspended") ctx.resume(); } catch (_) {} };
    const tone = (f, t0, dur, type = "triangle", vol = 0.18) => {
      if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + t0;
      o.type = type; o.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + dur + 0.02);
    };
    return {
      init,
      right(c) { init(); const up = Math.pow(2, Math.min(c - 1, 7) / 12); [523, 659, 784, 1047].forEach((f, k) => tone(f * up, k * 0.07, 0.22)); },
      wrong() { init(); tone(196, 0, 0.18, "square", 0.08); tone(147, 0.12, 0.28, "square", 0.08); },
    };
  })();

  // ---------- events ----------
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.closest("#sheet")) return;
    const card = el.closest(".card");
    const it = card && items[+card.dataset.i];
    switch (el.dataset.act) {
      case "tap":
        sfx.init();
        if (!unmuted) { setMuted(false); if (userPaused) togglePause(); else play(it); }
        else if (it && it.index === active) togglePause();
        break;
      case "line": {
        const open = el.getAttribute("aria-expanded") !== "true";
        el.setAttribute("aria-expanded", open);
        if (open) track("line_reveal", { clip: it && it.clip.id });
        break;
      }
      case "hook": el.classList.toggle("open"); break;
      case "phrases": it && openPhrases(it.clip); break;
      case "saveline": it && toggleSave({ es: it.clip.line.es, en: it.clip.line.en, note: "" }, it.clip, el); break;
      case "answer": sfx.init(); answer(it, +el.dataset.k); break;
      case "vocab": openVocab(); break;
      case "filters": openFilters(); break;
    }
  });
  $("#vocabBtn").addEventListener("click", openVocab);
  $("#filterBtn").addEventListener("click", openFilters);
  $("#introBtn").addEventListener("click", openIntro);
  $("#sheetClose").addEventListener("click", closeSheet);
  $("#scrim").addEventListener("click", closeSheet);
  $("#startBtn").addEventListener("click", closeIntro);
  $("#introLevels").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    $("#introLevels").querySelectorAll(".chip").forEach((x) => { const on = x === b; x.classList.toggle("on", on); x.setAttribute("aria-pressed", on); });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (!$("#sheet").hidden) closeSheet(); else if (!$("#intro").hidden && store.introDone) closeIntro(); return; }
    if (!$("#sheet").hidden || !$("#intro").hidden) {
      if (!$("#sheet").hidden && e.key === "Tab") trapFocus(e, $("#sheet"));
      if (!$("#intro").hidden && e.key === "Tab") trapFocus(e, $("#intro"));
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const onControl = e.target.closest && e.target.closest("button, a, input, select, textarea");
    const it = items[active];
    switch (e.key) {
      case "ArrowDown": case "PageDown": case "j": e.preventDefault(); go(1); break;
      case "ArrowUp": case "PageUp": case "k": e.preventDefault(); go(-1); break;
      case " ":
        if (onControl) return;
        e.preventDefault(); togglePause(); break;
      case "m": case "M": sfx.init(); setMuted(unmuted); break;
      case "1": case "2": case "3": case "4": case "a": case "b": case "c": case "d":
        if (it && it.type === "quiz") { sfx.init(); answer(it, "1234".includes(e.key) ? +e.key - 1 : "abcd".indexOf(e.key)); }
        break;
    }
  });
  function trapFocus(e, root) {
    const f = [...root.querySelectorAll("button, a[href], [tabindex]:not([tabindex='-1'])")].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  document.addEventListener("visibilitychange", () => {
    const it = items[active];
    if (document.hidden) pause(it); else if (!userPaused && $("#intro").hidden) play(it);
  });

  // ---------- boot ----------
  (async () => {
    renderHud();
    clips = await loadClips();
    if (!clips.length) {
      feed.innerHTML = `<article class="card endcard"><div class="col"><h2>Sin clips</h2><p>The feed couldn't load. Check your connection and reload.</p></div></article>`;
      return;
    }
    track("view", { clips: clips.length });
    loadYT();
    rebuild();
    if (!store.introDone) openIntro();
  })();
})();
