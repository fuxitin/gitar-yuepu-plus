// Tablet-first guitar tab app (4 tabs + reader). Local import + offline library via IndexedDB.

const DB_NAME = "guitar_tab_viewer";
const DB_VERSION = 3;
const STORE_LEGACY = "scores"; // v2 legacy: one file == one score
const STORE_SONGS = "songs"; // v3: one song == container
const STORE_PAGES = "pages"; // v3: pages belong to a song

/** @type {IDBDatabase | null} */
let db = null;

/** @type {{ id: string, name: string, artist?: string, addedAt: number, updatedAt: number, openedAt?: number, fav?: boolean, playCount?: number, pageCount?: number }[]} */
let library = [];
let activeSongId = null;

/** @type {"all" | "fav" | "recent"} */
let currentFilter = "all";

/** @type {"home" | "scores" | "practice" | "me" | "reader"} */
let currentPage = "home";

// Auto-scroll state
let autoScrollOn = false;
let autoScrollRaf = 0;
let autoScrollLastTs = 0;

const $ = (id) => document.getElementById(id);

function on(el, type, handler, options) {
  if (!el) return;
  el.addEventListener(type, handler, options);
}

function getDetailScrollEl() {
  // Detail page uses the page scroll container (single scroll). Fallback to sheet.
  return /** @type {HTMLElement} */ (els.scoreDetailScroll || els.sheet || document.documentElement);
}

const els = {
  // Pages / tabs
  pageHome: $("pageHome"),
  pageScores: $("pageScores"),
  pageScoreDetail: $("pageScoreDetail"),
  pagePractice: $("pagePractice"),
  pageMe: $("pageMe"),
  tabButtons: Array.from(document.querySelectorAll(".tab")),

  btnGoPractice: $("btnGoPractice"),
  btnGoScores: $("btnGoScores"),

  // Scores page
  scoresHead: $("scoresHead"),
  btnNewSong: $("btnNewSong"),
  searchInput: /** @type {HTMLInputElement} */ ($("searchInput")),
  btnFilterAll: $("btnFilterAll"),
  btnFilterFav: $("btnFilterFav"),
  btnFilterRecent: $("btnFilterRecent"),
  btnImportHelp: $("btnImportHelp"),
  btnClearAll: $("btnClearAll"),
  featuredList: $("featuredList"),
  featuredEmpty: $("featuredEmpty"),
  libraryList: $("libraryList"),
  libraryEmpty: $("libraryEmpty"),
  btnBackToLibrary: $("btnBackToLibrary"),
  detailTitle: $("detailTitle"),
  detailSub: $("detailSub"),
  btnImportPages: $("btnImportPages"),
  importPagesFiles: /** @type {HTMLInputElement} */ ($("importPagesFiles")),
  btnDeleteSong: $("btnDeleteSong"),
  scoreDetailScroll: $("scoreDetailScroll"),
  pagesList: $("pagesList"),
  pagesEmpty: $("pagesEmpty"),

  // Reader controls (merged into Scores Detail)
  sheet: $("sheet"),
  sheetText: $("sheetText"),
  sheetBinary: $("sheetBinary"),

  btnAutoScroll: $("btnAutoScroll"),
  scrollControls: $("scrollControls"),
  scrollSpeed: /** @type {HTMLInputElement} */ ($("scrollSpeed")),
  scrollSpeedText: $("scrollSpeedText"),
  btnScrollStop: $("btnScrollStop"),
  btnScrollTop: $("btnScrollTop"),
  btnScrollBottom: $("btnScrollBottom"),

  btnMetronome: $("btnMetronome"),
  metronomeControls: $("metronomeControls"),
  metroBpm: /** @type {HTMLInputElement} */ ($("metroBpm")),
  metroBpmText: $("metroBpmText"),
  metroBeats: /** @type {HTMLSelectElement} */ ($("metroBeats")),
  metroAccent: /** @type {HTMLInputElement} */ ($("metroAccent")),
  metroPulse: $("metroPulse"),
  btnMetroToggle: $("btnMetroToggle"),
  btnMetroTap: $("btnMetroTap"),
  btnMetroStop: $("btnMetroStop"),
  metroFloat: $("metroFloat"),
  metroFloatBtn: $("metroFloatBtn"),
  metroFloatText: $("metroFloatText"),

  // Dialog
  dialog: /** @type {HTMLDialogElement} */ ($("dialog")),
  dialogTitle: $("dialogTitle"),
  dialogBody: $("dialogBody"),
  dialogClose: $("dialogClose"),
};

function showDialog(title, bodyHtml, opts = {}) {
  els.dialogTitle.textContent = title;
  els.dialogBody.innerHTML = bodyHtml;
  els.dialogClose.hidden = opts.showClose === false;
  if (!els.dialog.open) els.dialog.showModal();
}

function closeDialog() {
  if (els.dialog.open) els.dialog.close();
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const _db = req.result;
      if (!_db.objectStoreNames.contains(STORE_SONGS)) {
        const songs = _db.createObjectStore(STORE_SONGS, { keyPath: "id" });
        try { songs.createIndex("addedAt", "addedAt", { unique: false }); } catch {}
        try { songs.createIndex("name", "name", { unique: false }); } catch {}
        try { songs.createIndex("openedAt", "openedAt", { unique: false }); } catch {}
        try { songs.createIndex("fav", "fav", { unique: false }); } catch {}
      }

      if (!_db.objectStoreNames.contains(STORE_PAGES)) {
        const pages = _db.createObjectStore(STORE_PAGES, { keyPath: "id" });
        try { pages.createIndex("songId", "songId", { unique: false }); } catch {}
        try { pages.createIndex("order", "order", { unique: false }); } catch {}
        try { pages.createIndex("addedAt", "addedAt", { unique: false }); } catch {}
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(storeName, mode = "readonly") {
  if (!db) throw new Error("DB not ready");
  return db.transaction(storeName, mode).objectStore(storeName);
}

function id() {
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

async function putSong(song) {
  await new Promise((resolve, reject) => {
    const req = tx(STORE_SONGS, "readwrite").put(song);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function putPage(page) {
  await new Promise((resolve, reject) => {
    const req = tx(STORE_PAGES, "readwrite").put(page);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function getSong(songId) {
  return await new Promise((resolve, reject) => {
    const req = tx(STORE_SONGS, "readonly").get(songId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function getSongPages(songId) {
  const pages = await new Promise((resolve, reject) => {
    const req = tx(STORE_PAGES, "readonly").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  return pages
    .filter((p) => p.songId === songId)
    .sort((a, b) => (a.order || 0) - (b.order || 0) || (a.addedAt || 0) - (b.addedAt || 0));
}

let detailSongId = null;

function showScoresLibrary() {
  detailSongId = null;
  setPage("scores");
}

async function showSongDetail(songId, opts = { updateRecents: true }) {
  const song = await getSong(songId);
  if (!song) return;
  detailSongId = songId;
  setPage("score");

  const pages = await getSongPages(songId);
  const pageCount = pages.length;

  els.detailTitle.textContent = song.name || "曲谱";
  const artistText = song.artist ? `${song.artist} · ` : "";
  els.detailSub.textContent = `${artistText}本地 · ${pageCount} 页`;

  els.pagesList.innerHTML = "";
  if (els.pagesEmpty) els.pagesEmpty.hidden = pageCount !== 0;
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const row = document.createElement("div");
    row.className = "pageRow";
    row.setAttribute("role", "listitem");
    row.innerHTML = `<div class="pageRow__num"></div><div class="pageRow__meta"><div class="pageRow__title"></div><div class="pageRow__sub"></div></div>`;
    row.querySelector(".pageRow__num").textContent = String(i + 1);
    row.querySelector(".pageRow__title").textContent = p.name || `第 ${i + 1} 页`;
    row.querySelector(".pageRow__sub").textContent = `${prettyPageType(p.type, p.name)} · ${fmtBytes(p.size || 0)}`;
    els.pagesList.appendChild(row);
  }

  // Entering a song is the reader: render immediately.
  await renderSongToSheet(songId, { updateRecents: opts.updateRecents !== false });
}

async function getAllSongsMeta() {
  const all = await new Promise((resolve, reject) => {
    const req = tx(STORE_SONGS, "readonly").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });

  return all
    .map((s) => ({
      id: s.id,
      name: s.name,
      artist: s.artist || "",
      addedAt: s.addedAt,
      updatedAt: s.updatedAt,
      openedAt: s.openedAt || 0,
      fav: !!s.fav,
      playCount: s.playCount || 0,
      pageCount: s.pageCount || 0,
    }))
    .sort((a, b) => (b.openedAt || b.updatedAt) - (a.openedAt || a.updatedAt));
}

async function deleteSong(songId) {
  // delete pages
  const pages = await getSongPages(songId);
  await Promise.all(
    pages.map((p) =>
      new Promise((resolve, reject) => {
        const req = tx(STORE_PAGES, "readwrite").delete(p.id);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      })
    )
  );

  await new Promise((resolve, reject) => {
    const req = tx(STORE_SONGS, "readwrite").delete(songId);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function confirmDeleteSong(songId, name) {
  showDialog(
    "删除曲谱？",
    `将删除“${String(name || "未命名")}”及其所有页面（只影响本设备本浏览器）。<br/><br/><button id="confirmDelete" class="chip chip--danger" type="button" style="height:40px">确认删除</button>`,
    { showClose: true }
  );

  setTimeout(() => {
    const btn = document.getElementById("confirmDelete");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      await deleteSong(songId);
      if (detailSongId === songId) {
        showScoresLibrary();
        detailSongId = null;
        renderSheetEmpty();
      }
      await refreshLibrary();
      closeDialog();
    });
  }, 0);
}

async function clearAll() {
  await new Promise((resolve, reject) => {
    const req1 = tx(STORE_SONGS, "readwrite").clear();
    req1.onsuccess = () => resolve(true);
    req1.onerror = () => reject(req1.error);
  });

  await new Promise((resolve, reject) => {
    const req2 = tx(STORE_PAGES, "readwrite").clear();
    req2.onsuccess = () => resolve(true);
    req2.onerror = () => reject(req2.error);
  });
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function setSheetFontSize(px) {
  const v = clamp(Number(px) || 20, 14, 34);
  document.documentElement.style.setProperty("--sheetFontSize", `${v}px`);
  localStorage.setItem("sheetFontSize", String(v));
}

function normalizeTextForDisplay(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function isProbablyText(type, name) {
  if (type && type.startsWith("text/")) return true;
  const ext = (String(name || "").split(".").pop() || "").toLowerCase();
  return ["txt", "tab", "pro", "chopro", "md"].includes(ext);
}

function prettyPageType(type, name) {
  if (isProbablyText(type, name)) return "文本";
  if (type === "application/pdf") return "PDF";
  if (type && type.startsWith("image/")) return "图片";
  return "文件";
}

function fmtBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  const kb = b / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

function setFilter(f) {
  currentFilter = f;
  els.btnFilterAll.classList.toggle("is-active", f === "all");
  els.btnFilterFav.classList.toggle("is-active", f === "fav");
  els.btnFilterRecent.classList.toggle("is-active", f === "recent");
  renderScores();
}

function getFilteredLibrary() {
  const q = (els.searchInput.value || "").trim().toLowerCase();
  let items = library.slice();

  if (currentFilter === "fav") items = items.filter((x) => x.fav);
  else if (currentFilter === "recent") items = items.filter((x) => (x.openedAt || 0) > 0).sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));

  if (q) {
    items = items.filter((x) => {
      const name = String(x.name || "").toLowerCase();
      const artist = String(x.artist || "").toLowerCase();
      return name.includes(q) || artist.includes(q);
    });
  }
  return items;
}

function renderFeatured(items) {
  // Use most played / recently opened as "hot"
  const hot = items
    .slice()
    .sort((a, b) => (b.playCount || 0) - (a.playCount || 0) || (b.openedAt || 0) - (a.openedAt || 0))
    .slice(0, 6);

  els.featuredList.innerHTML = "";
  els.featuredEmpty.hidden = hot.length !== 0;

  for (const it of hot) {
    const card = document.createElement("div");
    card.className = "hCard";
    card.tabIndex = 0;
    card.innerHTML = `<div class="hCard__title"></div><div class="hCard__sub"></div>`;
    card.querySelector(".hCard__title").textContent = it.name;
    card.querySelector(".hCard__title").title = it.name;
    const pagesText = it.pageCount ? `${it.pageCount} 页` : "未导入";
    card.querySelector(".hCard__sub").textContent = `${pagesText} · 本地`;
    card.addEventListener("click", () => showSongDetail(it.id));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") showSongDetail(it.id);
    });
    els.featuredList.appendChild(card);
  }
}

function renderLibraryList(items) {
  els.libraryList.innerHTML = "";
  els.libraryEmpty.hidden = library.length !== 0;

  for (const it of items) {
    const row = document.createElement("div");
    row.className = "songRow";
    row.setAttribute("role", "listitem");
    row.tabIndex = 0;

    const icon = document.createElement("div");
    icon.className = "songIcon";
    icon.textContent = "🎸";

    const meta = document.createElement("div");
    meta.className = "songMeta";
    meta.innerHTML = `<div class="songTitle"></div><div class="songSub"></div>`;
    meta.querySelector(".songTitle").textContent = it.name;
    const pagesText = it.pageCount ? `${it.pageCount} 页` : "未导入";
    const artistText = it.artist ? `${it.artist} · ` : "";
    meta.querySelector(".songSub").textContent = `${artistText}${pagesText} · 本地`;

    const right = document.createElement("div");
    right.className = "songBadges";

    const badge = document.createElement("div");
    badge.className = "badge";
    badge.textContent = "本地";

    const del = document.createElement("button");
    del.className = "deleteBtn";
    del.type = "button";
    del.textContent = "🗑";
    del.setAttribute("aria-label", "删除曲谱");
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      await confirmDeleteSong(it.id, it.name);
    });

    const star = document.createElement("button");
    star.className = "starBtn" + (it.fav ? " is-on" : "");
    star.type = "button";
    star.textContent = it.fav ? "★" : "☆";
    star.setAttribute("aria-label", it.fav ? "取消收藏" : "收藏");
    star.addEventListener("click", async (e) => {
      e.stopPropagation();
      await toggleFav(it.id);
    });

    right.appendChild(badge);
    right.appendChild(del);
    right.appendChild(star);

    row.appendChild(icon);
    row.appendChild(meta);
    row.appendChild(right);

    row.addEventListener("click", () => showSongDetail(it.id));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") showSongDetail(it.id);
    });

    els.libraryList.appendChild(row);
  }
}

function renderScores() {
  const items = getFilteredLibrary();
  renderFeatured(library);
  renderLibraryList(items);
}

function setPage(page) {
  currentPage = page;
  const pages = ["home", "scores", "score", "practice", "me"];
  for (const p of pages) {
    const el = document.querySelector(`[data-page="${p}"]`);
    if (!el) continue;
    el.classList.toggle("is-active", p === page);
  }

  for (const btn of els.tabButtons) {
    const t = btn.getAttribute("data-tab");
    const tabActive = (page === "score" && t === "scores") || t === page;
    btn.classList.toggle("is-active", tabActive);
  }

  // Tab bar always visible (reader is inside Scores tab now).
}

async function refreshLibrary() {
  library = await getAllSongsMeta();
  renderScores();
}

function setReaderTitle(name, metaText) {
  els.detailTitle.textContent = name || "曲谱";
  els.detailSub.textContent = metaText || "本地 · 0 页";
}

function renderSheetEmpty() {
  els.sheetText.hidden = true;
  els.sheetBinary.hidden = true;
  els.sheetBinary.innerHTML = "";
  setReaderTitle("曲谱", "本地 · 0 页");
}

function renderText(name, text, metaText) {
  els.sheetBinary.hidden = true;
  els.sheetBinary.innerHTML = "";
  els.sheetText.hidden = false;
  els.sheetText.textContent = normalizeTextForDisplay(text);
  getDetailScrollEl().scrollTop = 0;
  setReaderTitle(name, metaText);
}

function renderBinary(name, type, blob, metaText) {
  els.sheetText.hidden = true;
  els.sheetText.textContent = "";
  els.sheetBinary.hidden = false;
  els.sheetBinary.innerHTML = "";

  const url = URL.createObjectURL(blob);
  if (type === "application/pdf") {
    const embed = document.createElement("embed");
    embed.type = "application/pdf";
    embed.src = url;
    els.sheetBinary.appendChild(embed);
  } else if (type && type.startsWith("image/")) {
    const img = document.createElement("img");
    img.alt = name;
    img.src = url;
    els.sheetBinary.appendChild(img);
  } else {
    const iframe = document.createElement("iframe");
    iframe.src = url;
    iframe.setAttribute("title", name);
    els.sheetBinary.appendChild(iframe);
  }

  getDetailScrollEl().scrollTop = 0;
  setReaderTitle(name, metaText);
}

async function renderSongToSheet(songId, { updateRecents } = { updateRecents: false }) {
  const song = await getSong(songId);
  if (!song) return;
  activeSongId = songId;
  localStorage.setItem("activeSongId", songId);

  const pages = await getSongPages(songId);
  if (!pages.length) {
    // Keep the reading area clean; show the "no pages" hint in the Pages section only.
    els.sheetText.hidden = true;
    els.sheetBinary.hidden = true;
    els.sheetBinary.innerHTML = "";
    const artistText = song.artist ? `${song.artist} · ` : "";
    setReaderTitle(song.name, `${artistText}本地 · 0 页`);
    return;
  }

  // Render all pages sequentially in one scroll (best for guitar sheets: 2-3 images + auto scroll).
  els.sheetText.hidden = true;
  els.sheetBinary.hidden = false;
  els.sheetBinary.innerHTML = "";

  for (const p of pages) {
    if (isProbablyText(p.type, p.name)) {
      const pre = document.createElement("pre");
      pre.className = "sheet__text";
      pre.textContent = normalizeTextForDisplay(p.text || "");
      pre.style.marginBottom = "12px";
      els.sheetBinary.appendChild(pre);
      continue;
    }

    const blob = p.blob;
    if (!blob) continue;
    const url = URL.createObjectURL(blob);

    const wrap = document.createElement("div");
    wrap.className = "sheet__binary";
    wrap.style.marginBottom = "12px";

    if (p.type === "application/pdf") {
      const embed = document.createElement("embed");
      embed.type = "application/pdf";
      embed.src = url;
      wrap.appendChild(embed);
    } else if (p.type && p.type.startsWith("image/")) {
      const img = document.createElement("img");
      img.alt = p.name || song.name;
      img.src = url;
      wrap.appendChild(img);
    } else {
      const iframe = document.createElement("iframe");
      iframe.src = url;
      iframe.setAttribute("title", p.name || song.name);
      wrap.appendChild(iframe);
    }

    els.sheetBinary.appendChild(wrap);
  }

  getDetailScrollEl().scrollTop = 0;
  {
    const artistText = song.artist ? `${song.artist} · ` : "";
    setReaderTitle(song.name, `${artistText}本地 · ${pages.length} 页`);
  }

  if (updateRecents) {
    const now = Date.now();
    song.updatedAt = now;
    song.openedAt = now;
    song.playCount = (song.playCount || 0) + 1;
    await putSong(song);
    await refreshLibrary();
  }
}

// Prev/next removed from UI for cleanliness; keep navigation via list.

async function toggleFav(scoreId) {
  const song = await getSong(scoreId);
  if (!song) return;
  song.fav = !song.fav;
  song.updatedAt = Date.now();
  await putSong(song);
  await refreshLibrary();
}

async function createSong(name, artist) {
  const now = Date.now();
  const songId = id();
  await putSong({
    id: songId,
    name,
    artist: (artist || "").trim(),
    addedAt: now,
    updatedAt: now,
    openedAt: 0,
    fav: false,
    playCount: 0,
    pageCount: 0,
  });
  return songId;
}

async function addPagesToSong(songId, fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return 0;

  const song = await getSong(songId);
  if (!song) return 0;

  const existing = await getSongPages(songId);
  const baseOrder = existing.length;
  const now = Date.now();

  let added = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const pageId = id();
    const page = {
      id: pageId,
      songId,
      order: baseOrder + i,
      name: file.name || `第 ${baseOrder + i + 1} 页`,
      type: file.type || "",
      size: file.size || 0,
      addedAt: now,
      text: null,
      blob: null,
    };

    if (isProbablyText(file.type, file.name)) {
      page.text = await file.text();
    } else {
      // Store as Blob for IndexedDB structured clone.
      page.blob = new Blob([await file.arrayBuffer()], { type: file.type || "application/octet-stream" });
    }

    await putPage(page);
    added++;
  }

  song.updatedAt = Date.now();
  song.pageCount = (song.pageCount || 0) + added;
  await putSong(song);

  await refreshLibrary();
  return added;
}

function setAutoScroll(on) {
  autoScrollOn = on;
  els.btnAutoScroll.textContent = on ? "自动滚动中" : "自动滚动";
  els.scrollControls.hidden = !on;
  if (!on) {
    cancelAnimationFrame(autoScrollRaf);
    autoScrollRaf = 0;
    autoScrollLastTs = 0;
  } else {
    autoScrollLastTs = 0;
    autoScrollRaf = requestAnimationFrame(autoScrollTick);
  }
}

function autoScrollTick(ts) {
  if (!autoScrollOn) return;
  if (!autoScrollLastTs) autoScrollLastTs = ts;
  const dt = (ts - autoScrollLastTs) / 1000;
  autoScrollLastTs = ts;

  const speed = Number(els.scrollSpeed.value || "0");
  const fontPx = Number(
    getComputedStyle(document.documentElement).getPropertyValue("--sheetFontSize").replace("px", "")
  );
  const pxPerSec = speed * (fontPx * 0.8);
  const delta = pxPerSec * dt;

  const scroller = getDetailScrollEl();
  const maxScroll = scroller.scrollHeight - scroller.clientHeight;
  scroller.scrollTop = clamp(scroller.scrollTop + delta, 0, Math.max(0, maxScroll));

  if (scroller.scrollTop >= maxScroll - 1) {
    setAutoScroll(false);
    return;
  }

  autoScrollRaf = requestAnimationFrame(autoScrollTick);
}

class Metronome {
  constructor() {
    /** @type {AudioContext | null} */
    this.ctx = null;
    this.isRunning = false;
    this.tempo = 100;
    this.beatsPerBar = 4;
    this.accent = true;

    this.currentBeat = 0;
    this.nextNoteTime = 0;

    this.lookaheadMs = 25;
    this.scheduleAheadTime = 0.12;
    this.timer = 0;

    this.onTick = null; // (beatIndex, isAccent) => void
  }

  async _ensureContext() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    if (this.ctx.state === "suspended") {
      try { await this.ctx.resume(); } catch {}
    }
  }

  setTempo(bpm) { this.tempo = clamp(Number(bpm) || 100, 30, 300); }
  setBeatsPerBar(n) { this.beatsPerBar = clamp(Number(n) || 4, 1, 12); this.currentBeat = 0; }
  setAccent(on) { this.accent = !!on; }
  _secondsPerBeat() { return 60.0 / this.tempo; }

  _scheduleClick(time, isAccent) {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const baseFreq = isAccent ? 1760 : 1320;
    osc.frequency.setValueAtTime(baseFreq, time);
    osc.type = "square";
    const peak = isAccent ? 0.22 : 0.16;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(peak, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + (isAccent ? 0.06 : 0.05));
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(time);
    osc.stop(time + 0.08);
  }

  _scheduler() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    while (this.nextNoteTime < now + this.scheduleAheadTime) {
      const isAccent = this.accent && this.currentBeat === 0;
      this._scheduleClick(this.nextNoteTime, isAccent);
      if (typeof this.onTick === "function") {
        const beatIndex = this.currentBeat;
        setTimeout(() => this.onTick(beatIndex, isAccent), Math.max(0, (this.nextNoteTime - now) * 1000));
      }
      this.nextNoteTime += this._secondsPerBeat();
      this.currentBeat = (this.currentBeat + 1) % this.beatsPerBar;
    }
  }

  async start() {
    await this._ensureContext();
    if (!this.ctx || this.isRunning) return;
    this.isRunning = true;
    this.currentBeat = 0;
    this.nextNoteTime = this.ctx.currentTime + 0.05;
    this.timer = window.setInterval(() => this._scheduler(), this.lookaheadMs);
  }

  stop() {
    this.isRunning = false;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
    this.currentBeat = 0;
  }
}

const metro = new Metronome();
let tapTimes = [];

function setMetronomeUiOpen(on) {
  if (!els.metronomeControls || !els.btnMetronome) return;
  els.metronomeControls.hidden = !on;
  els.btnMetronome.textContent = on ? "收起节拍器" : "节拍器";
}

function setMetronomeRunningUi(running) {
  if (!els.btnMetroToggle || !els.metroFloat || !els.metroFloatText || !els.metroBpm) return;
  els.btnMetroToggle.textContent = running ? "运行中" : "开始";
  els.metroFloat.hidden = !running;
  els.metroFloatText.textContent = `节拍器 ${els.metroBpm.value}`;
}

function pulseTick(isAccent) {
  if (!els.metroPulse) return;
  els.metroPulse.classList.remove("is-on", "is-accent");
  void els.metroPulse.offsetWidth;
  els.metroPulse.classList.add(isAccent ? "is-accent" : "is-on");
  window.setTimeout(() => els.metroPulse.classList.remove("is-on", "is-accent"), 80);
}

function installServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./sw.js?v=13").catch(() => {});
}

function wireUi() {
  // Tabs
  for (const btn of els.tabButtons) {
    btn.addEventListener("click", () => setPage(/** @type any */ (btn.getAttribute("data-tab"))));
  }

  on(els.btnGoPractice, "click", () => setPage("practice"));
  on(els.btnGoScores, "click", () => setPage("scores"));

  // Scores page
  on(els.searchInput, "input", renderScores);

  on(els.btnFilterAll, "click", () => setFilter("all"));
  on(els.btnFilterFav, "click", () => setFilter("fav"));
  on(els.btnFilterRecent, "click", () => setFilter("recent"));

  on(els.btnNewSong, "click", () => {
    showDialog(
      "新建曲谱",
      [
        "<div style=\"color: rgba(31,26,22,0.70); font-size: 13px; margin-bottom: 10px;\">创建曲谱后，可在曲谱详情页导入 2-3 张图片或 PDF 作为页面。</div>",
        "<input id=\"newSongName\" placeholder=\"输入曲谱名称\" style=\"width:100%; height:44px; border-radius:16px; border:1px solid rgba(31,26,22,0.10); padding:0 12px; font-size:14px; font-weight:900; outline:none; background:rgba(255,255,255,0.86);\" />",
        "<div style=\"height:10px\"></div>",
        "<input id=\"newSongArtist\" placeholder=\"输入演唱者（可选）\" style=\"width:100%; height:44px; border-radius:16px; border:1px solid rgba(31,26,22,0.10); padding:0 12px; font-size:14px; font-weight:900; outline:none; background:rgba(255,255,255,0.86);\" />",
        "<div style=\"display:flex; gap:10px; justify-content:flex-end; margin-top:12px;\">",
        "  <button id=\"newSongCancel\" class=\"chip\" type=\"button\" style=\"height:40px\">取消</button>",
        "  <button id=\"newSongCreate\" class=\"chip is-active\" type=\"button\" style=\"height:40px\">创建</button>",
        "</div>",
      ].join("")
    , { showClose: false });

    setTimeout(() => {
      const input = /** @type {HTMLInputElement | null} */ (document.getElementById("newSongName"));
      const artist = /** @type {HTMLInputElement | null} */ (document.getElementById("newSongArtist"));
      const createBtn = document.getElementById("newSongCreate");
      const cancel = document.getElementById("newSongCancel");
      if (!input || !artist || !createBtn || !cancel) return;

      input.value = "";
      input.focus();
      artist.value = "";

      const createOnly = async () => {
        const name = (input.value || "").trim().replace(/\s+/g, " ").slice(0, 80);
        const artistName = (artist.value || "").trim().replace(/\s+/g, " ").slice(0, 80);
        if (!name) return;
        const songId = await createSong(name, artistName);
        closeDialog();
        setPage("scores");
        await showSongDetail(songId);
      };

      createBtn.addEventListener("click", () => { createOnly(); });
      cancel.addEventListener("click", closeDialog);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") createOnly();
      });
    }, 0);
  });

  // Scores detail controls
  on(els.btnBackToLibrary, "click", () => showScoresLibrary());
  on(els.btnImportPages, "click", () => els.importPagesFiles && els.importPagesFiles.click());
  on(els.btnDeleteSong, "click", async () => {
    if (!detailSongId) return;
    const song = await getSong(detailSongId);
    await confirmDeleteSong(detailSongId, song ? song.name : "");
  });

  on(els.importPagesFiles, "change", async () => {
    const input = els.importPagesFiles;
    if (!input) return;
    const picked = Array.from(input.files || []);
    input.value = "";
    if (!detailSongId) return;
    if (picked.length === 0) return;
    try {
      const added = await addPagesToSong(detailSongId, picked);
      if (!added) {
        showDialog("未导入任何文件", "没有检测到可导入的文件。", { showClose: true });
        return;
      }
      await showSongDetail(detailSongId, { updateRecents: false });
      await renderSongToSheet(detailSongId, { updateRecents: false });
    } catch (err) {
      showDialog("导入失败", `导入页面时出错：${String(err && err.message ? err.message : err)}`, { showClose: true });
    }
  });

  on(els.btnClearAll, "click", async () => {
    showDialog(
      "确认清空曲库？",
      "这会删除已导入的所有曲谱（只影响本设备本浏览器）。<br/><br/>如果确认，请点击下方按钮再次确认。<br/><br/><button id=\"confirmClear\" class=\"chip chip--danger\" type=\"button\" style=\"height:40px\">确认清空</button>"
    );
    setTimeout(() => {
      const btn = document.getElementById("confirmClear");
      if (!btn) return;
      btn.addEventListener("click", async () => {
        await clearAll();
        activeSongId = null;
        localStorage.removeItem("activeSongId");
        renderSheetEmpty();
        await refreshLibrary();
        closeDialog();
      });
    }, 0);
  });

  on(els.btnImportHelp, "click", () => {
    showDialog(
      "支持格式",
      [
        "1. 文本类：`.txt` / `.tab` / `.pro` / `.chopro` / `.md`（最适合六线谱对齐）",
        "2. 二进制：PDF（`.pdf`）/ 图片（`jpg/png/webp` 等）",
        "<br/>提示：如果你的吉他谱是 Guitar Pro（`.gp5/.gpx/.gp`），我们也可以加解析或转换流程，需要你给样例文件。",
      ].join("<br/>")
    , { showClose: true });
  });

  on(els.btnAutoScroll, "click", () => setAutoScroll(!autoScrollOn));
  on(els.scrollSpeed, "input", () => {
    if (!els.scrollSpeed || !els.scrollSpeedText) return;
    els.scrollSpeedText.textContent = Number(els.scrollSpeed.value).toFixed(2).replace(/\.00$/, "");
  });
  on(els.btnScrollStop, "click", () => setAutoScroll(false));
  on(els.btnScrollTop, "click", () => (getDetailScrollEl().scrollTop = 0));
  on(els.btnScrollBottom, "click", () => (getDetailScrollEl().scrollTop = getDetailScrollEl().scrollHeight));

  // Metronome
  metro.onTick = (_beatIndex, isAccent) => pulseTick(isAccent);
  on(els.btnMetronome, "click", () => setMetronomeUiOpen(!!(els.metronomeControls && els.metronomeControls.hidden)));

  on(els.metroBpm, "input", () => {
    if (!els.metroBpm || !els.metroBpmText || !els.metroFloatText) return;
    els.metroBpmText.textContent = els.metroBpm.value;
    metro.setTempo(Number(els.metroBpm.value));
    els.metroFloatText.textContent = `节拍器 ${els.metroBpm.value}`;
    localStorage.setItem("metroBpm", String(els.metroBpm.value));
  });

  on(els.metroBeats, "change", () => {
    if (!els.metroBeats) return;
    metro.setBeatsPerBar(Number(els.metroBeats.value));
    localStorage.setItem("metroBeats", String(els.metroBeats.value));
  });

  on(els.metroAccent, "change", () => {
    if (!els.metroAccent) return;
    metro.setAccent(!!els.metroAccent.checked);
    localStorage.setItem("metroAccent", els.metroAccent.checked ? "1" : "0");
  });

  on(els.btnMetroToggle, "click", async () => {
    if (!metro.isRunning) {
      await metro.start();
      setMetronomeRunningUi(true);
    }
  });

  on(els.btnMetroStop, "click", () => {
    metro.stop();
    setMetronomeRunningUi(false);
  });

  on(els.metroFloatBtn, "click", () => {
    metro.stop();
    setMetronomeRunningUi(false);
  });

  on(els.btnMetroTap, "click", async () => {
    const t = performance.now();
    tapTimes.push(t);
    tapTimes = tapTimes.filter((x) => t - x <= 2500);
    if (tapTimes.length >= 2) {
      const diffs = [];
      for (let i = 1; i < tapTimes.length; i++) diffs.push(tapTimes[i] - tapTimes[i - 1]);
      diffs.sort((a, b) => a - b);
      const mid = diffs[Math.floor(diffs.length / 2)];
      const bpm = Math.round(60000 / mid);
      const clamped = clamp(bpm, 40, 240);
      if (!els.metroBpm || !els.metroBpmText || !els.metroFloatText) return;
      els.metroBpm.value = String(clamped);
      els.metroBpmText.textContent = String(clamped);
      metro.setTempo(clamped);
      els.metroFloatText.textContent = `节拍器 ${clamped}`;
      localStorage.setItem("metroBpm", String(clamped));
    } else {
      await metro._ensureContext();
    }
  });

  // Dialog close
  on(els.dialogClose, "click", closeDialog);
  on(els.dialog, "click", (e) => {
    if (!els.dialog) return;
    const rect = els.dialog.getBoundingClientRect();
    const inDialog =
      rect.top <= e.clientY && e.clientY <= rect.bottom && rect.left <= e.clientX && e.clientX <= rect.right;
    if (!inDialog) closeDialog();
  });

  // Keyboard convenience (desktop)
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (els.dialog.open) closeDialog();
      if (currentPage === "reader") setPage("scores");
      if (autoScrollOn) setAutoScroll(false);
      if (metro.isRunning) {
        metro.stop();
        setMetronomeRunningUi(false);
      }
    }
  });
}

async function boot() {
  db = await openDb();
  wireUi();

  // Restore font size
  const savedFont = Number(localStorage.getItem("sheetFontSize") || "20");
  setSheetFontSize(savedFont || 20);

  // Restore metronome prefs
  if (els.metroBpm && els.metroBpmText && els.metroBeats && els.metroAccent) {
    const savedBpm = Number(localStorage.getItem("metroBpm") || "100");
    const savedBeats = Number(localStorage.getItem("metroBeats") || "4");
    const savedAccent = (localStorage.getItem("metroAccent") || "1") === "1";
    els.metroBpm.value = String(clamp(savedBpm, 40, 240));
    els.metroBpmText.textContent = els.metroBpm.value;
    els.metroBeats.value = String(clamp(savedBeats, 1, 12));
    els.metroAccent.checked = savedAccent;
    metro.setTempo(Number(els.metroBpm.value));
    metro.setBeatsPerBar(Number(els.metroBeats.value));
    metro.setAccent(!!els.metroAccent.checked);
    // Default open (user asked); still not auto-start to avoid surprise audio.
    setMetronomeUiOpen(true);
    setMetronomeRunningUi(false);
  }

  activeSongId = localStorage.getItem("activeSongId");

  // One-time migration: legacy STORE_LEGACY -> songs/pages (if songs store is empty).
  if (db.objectStoreNames.contains(STORE_LEGACY)) {
    try {
      const existingSongs = await getAllSongsMeta();
      if (existingSongs.length === 0) {
        const legacy = await new Promise((resolve, reject) => {
          const req = tx(STORE_LEGACY, "readonly").getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });

        for (const s of /** @type {any[]} */ (legacy)) {
          const songId = s.id || id();
          const now = Date.now();
          await putSong({
            id: songId,
            name: s.name || "未命名",
            addedAt: s.addedAt || now,
            updatedAt: s.updatedAt || now,
            openedAt: s.openedAt || 0,
            fav: !!s.fav,
            playCount: s.playCount || 0,
            pageCount: 1,
          });
          await putPage({
            id: `${songId}-p1`,
            songId,
            order: 0,
            name: s.name || "第 1 页",
            type: s.type || "",
            size: s.size || 0,
            addedAt: s.addedAt || now,
            text: s.text || null,
            blob: s.blob || null,
          });
        }
      }
    } catch {
      // Non-fatal; user can re-import.
    }
  }

  await refreshLibrary();
  renderSheetEmpty();
  setFilter("all");
  showScoresLibrary();

  if (activeSongId) {
    try {
      const song = await getSong(activeSongId);
      if (song) setReaderTitle(song.name, `${song.pageCount || 0} 页 · 本地`);
    } catch {
      activeSongId = null;
      localStorage.removeItem("activeSongId");
    }
  }

  setPage("home");
  installServiceWorker();
}

boot().catch((err) => {
  showDialog("启动失败", `初始化失败：${String(err && err.message ? err.message : err)}`);
  renderSheetEmpty();
});
