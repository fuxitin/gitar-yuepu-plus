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
let autoScrollCarryPx = 0; // accumulate sub-pixel deltas so low speeds still move
/** @type {"slow" | "normal" | "fast" | null} */
let activeScrollPreset = "normal";

// Practice / plans
const LS_PLANS = "practicePlans_v1";
/** @type {{ id: string, name: string, items: string[], createdAt: number, updatedAt: number }[]} */
let plans = [];
/** @type {{ id: string, name: string, items: string[] } | null} */
let planDraft = null;

const EXERCISES = [
  { id: "chromatic", name: "爬格子", desc: "手指独立性练习", level: "初级", minutes: 10, xp: 50 },
  { id: "chords_basic", name: "基础和弦", desc: "练习 A、C、D、E、G 和弦", level: "初级", minutes: 15, xp: 75 },
  { id: "pentatonic", name: "五声音阶", desc: "小调五声音阶第一把位", level: "中级", minutes: 12, xp: 100 },
  { id: "alt_picking", name: "交替拨弦", desc: "速度和精准度训练", level: "中级", minutes: 8, xp: 80 },
  { id: "chord_changes", name: "和弦转换", desc: "流畅切换和弦", level: "初级", minutes: 10, xp: 60 },
  { id: "string_skipping", name: "跨弦练习", desc: "高级拨弦技巧", level: "高级", minutes: 15, xp: 150 },
  { id: "major_scale", name: "大调音阶", desc: "C 大调音阶一把位", level: "中级", minutes: 12, xp: 110 },
  { id: "rhythm_16", name: "节奏分解", desc: "16 分音符节奏训练", level: "中级", minutes: 10, xp: 90 },
];

// Tuner state
const LS_TUNER_MODE = "tunerMode_v1"; // "preset" | "custom"
const LS_TUNER_PRESET = "tunerPreset_v1";
const LS_TUNER_CUSTOM = "tunerCustom_v1";

const TUNER_PRESETS = [
  // Notes order is always: [6th .. 1st]
  { id: "std", name: "标准调弦", sub: "E-A-D-G-B-E（最常用）", notes: ["E2", "A2", "D3", "G3", "B3", "E4"] },
  { id: "halfdown", name: "降半音", sub: "Eb-Ab-Db-Gb-Bb-Eb", notes: ["Eb2", "Ab2", "Db3", "Gb3", "Bb3", "Eb4"] },
  { id: "dropd", name: "Drop D", sub: "第6弦降到D", notes: ["D2", "A2", "D3", "G3", "B3", "E4"] },
  { id: "dropc", name: "Drop C", sub: "重金属常用", notes: ["C2", "G2", "C3", "F3", "A3", "D4"] },
  { id: "dadgad", name: "DADGAD", sub: "民谣开放调弦", notes: ["D2", "A2", "D3", "G3", "A3", "D4"] },
  { id: "openg", name: "Open G", sub: "开放G和弦", notes: ["D2", "G2", "D3", "G3", "B3", "D4"] },
];

const NOTE_INDEX = (() => {
  // C2..B4 inclusive
  const out = [];
  const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  for (let midi = 36; midi <= 71; midi++) {
    const name = names[(midi + 1200) % 12];
    const octave = Math.floor(midi / 12) - 1;
    out.push({ midi, note: `${name}${octave}` });
  }
  // Add flats as aliases in parsing only; display uses sharps except preset strings where we keep Eb etc.
  return out;
})();

function noteToMidi(note) {
  const s = String(note || "").trim();
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(s);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const acc = m[2] || "";
  const oct = Number(m[3]);
  const base = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 }[letter];
  if (base == null) return null;
  const alter = acc === "#" ? 1 : acc === "b" ? -1 : 0;
  const pc = (base + alter + 12) % 12;
  const midi = (oct + 1) * 12 + pc;
  return midi;
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function fmtHz(hz) {
  return `${hz.toFixed(2)} Hz`;
}

function getTunerMode() {
  const m = localStorage.getItem(LS_TUNER_MODE);
  return m === "custom" ? "custom" : "preset";
}

function setTunerMode(mode) {
  localStorage.setItem(LS_TUNER_MODE, mode);
}

function getTunerPresetId() {
  return localStorage.getItem(LS_TUNER_PRESET) || "std";
}

function setTunerPresetId(id) {
  localStorage.setItem(LS_TUNER_PRESET, id);
}

function getTunerCustomNotes() {
  try {
    const raw = localStorage.getItem(LS_TUNER_CUSTOM);
    const arr = raw ? JSON.parse(raw) : null;
    if (Array.isArray(arr) && arr.length === 6 && arr.every((x) => typeof x === "string")) return arr;
  } catch {}
  return ["E2", "A2", "D3", "G3", "B3", "E4"];
}

function setTunerCustomNotes(notes) {
  localStorage.setItem(LS_TUNER_CUSTOM, JSON.stringify(notes));
}

function getActiveTuning() {
  const mode = getTunerMode();
  if (mode === "custom") {
    return { mode, id: "custom", name: "自定义调弦", sub: "每根弦独立设置", notes: getTunerCustomNotes() };
  }
  const id = getTunerPresetId();
  const p = TUNER_PRESETS.find((x) => x.id === id) || TUNER_PRESETS[0];
  return { mode, ...p };
}

let toneCtx = null;
let toneStopTimer = 0;
let tonePlayingBtn = null;

function stopTone() {
  if (toneStopTimer) window.clearTimeout(toneStopTimer);
  toneStopTimer = 0;
  if (tonePlayingBtn) tonePlayingBtn.classList.remove("is-playing");
  tonePlayingBtn = null;
  if (toneCtx) {
    try { toneCtx.close(); } catch {}
  }
  toneCtx = null;
}

async function playTone(freq, btnEl) {
  stopTone();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  toneCtx = new Ctx();
  if (toneCtx.state === "suspended") {
    try { await toneCtx.resume(); } catch {}
  }
  const osc = toneCtx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = freq;
  const gain = toneCtx.createGain();
  gain.gain.value = 0;
  osc.connect(gain);
  gain.connect(toneCtx.destination);
  const now = toneCtx.currentTime;
  gain.gain.setValueAtTime(0.0, now);
  gain.gain.linearRampToValueAtTime(0.18, now + 0.03);
  gain.gain.linearRampToValueAtTime(0.0, now + 2.0);
  osc.start(now);
  osc.stop(now + 2.05);
  tonePlayingBtn = btnEl || null;
  if (tonePlayingBtn) tonePlayingBtn.classList.add("is-playing");
  toneStopTimer = window.setTimeout(() => stopTone(), 2100);
}

// Tuner mic (separate from exercise mic)
let tunerMicStream = null;
let tunerMicCtx = null;
let tunerMicAnalyser = null;
let tunerMicBuf = null;
let tunerMicRaf = 0;
let tunerRecentFreq = [];
let tunerNoSignalFrames = 0;
let tunerHoldString = 0; // 6..1
let tunerHoldStartTs = 0;
/** @type {Set<number>} */
let tunerOkStrings = new Set();
let tunerActiveKey = "";
const TUNER_MATCH_CENTS = 25; // +/- cents
const TUNER_MATCH_HOLD_MS = 1000;

function rmsOf(frame) {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
  return Math.sqrt(s / frame.length);
}

function tuningKeyFrom(active) {
  return `${active.mode}:${active.id}:${(active.notes || []).join("|")}`;
}

function resetTunerMatchState() {
  tunerHoldString = 0;
  tunerHoldStartTs = 0;
  tunerOkStrings = new Set();
  updateTunerRowsOkUi();
}

function updateTunerRowsOkUi(activeString = 0) {
  if (!els.tunerStringList) return;
  const rows = Array.from(els.tunerStringList.querySelectorAll(".tunerStringRow"));
  for (const row of rows) {
    const s = Number(row.getAttribute("data-string") || "0");
    row.classList.toggle("is-ok", tunerOkStrings.has(s));
    row.classList.toggle("is-active", s === activeString && !tunerOkStrings.has(s));
    const badge = row.querySelector(".tunerOkBadge");
    if (badge) badge.toggleAttribute("hidden", !tunerOkStrings.has(s));
  }
}

function closestTuningStringMatch(freq, active) {
  // active.notes is [6th..1st]
  let best = null;
  for (let idx = 0; idx < 6; idx++) {
    const stringNum = 6 - idx;
    const n = active.notes[idx];
    const midi = noteToMidi(n);
    if (midi == null) continue;
    const targetHz = midiToFreq(midi);
    const cents = 1200 * Math.log2(freq / targetHz);
    const abs = Math.abs(cents);
    if (!best || abs < best.abs) best = { stringNum, cents, abs };
  }
  if (!best || best.abs > TUNER_MATCH_CENTS) return null;
  return best;
}

// Autocorrelation fallback (based on the user's demo), tuned for guitar range.
function detectPitchACF(frame, sampleRate) {
  const N = Math.min(2048, frame.length);
  const buf = frame.length === N ? frame : frame.subarray(0, N);
  const rms = rmsOf(buf);
  if (rms < 0.0045) return null;

  const MIN_FREQ = 55; // include C2 (65.4Hz) and below
  const MAX_FREQ = 1000;
  const minLag = Math.max(2, Math.floor(sampleRate / MAX_FREQ));
  const maxLag = Math.min(N - 3, Math.floor(sampleRate / MIN_FREQ));
  if (maxLag <= minLag + 2) return null;

  let energy = 0;
  for (let i = 0; i < N; i++) energy += buf[i] * buf[i];
  if (energy <= 1e-9) return null;

  let bestLag = -1;
  let best = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < N - lag; i++) sum += buf[i] * buf[i + lag];
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  if (bestLag < 0) return null;

  // Parabolic interpolation around the best lag
  const corrAt = (lag) => {
    let sum = 0;
    for (let i = 0; i < N - lag; i++) sum += buf[i] * buf[i + lag];
    return sum;
  };
  const c0 = corrAt(Math.max(minLag, bestLag - 1));
  const c1 = corrAt(bestLag);
  const c2 = corrAt(Math.min(maxLag, bestLag + 1));
  const a = (c0 + c2 - 2 * c1) / 2;
  const b = (c2 - c0) / 2;
  const shift = a ? -b / (2 * a) : 0;
  const lag = bestLag + shift;

  const freq = sampleRate / lag;
  if (!Number.isFinite(freq) || freq < MIN_FREQ || freq > 1500) return null;

  const confidence = Math.max(0, Math.min(1, best / energy));
  return { freq, confidence };
}

function freqToNoteAndCents(freq) {
  const midi = 69 + 12 * Math.log2(freq / 440);
  const nearest = Math.round(midi);
  const exact = midiToFreq(nearest);
  const cents = 1200 * Math.log2(freq / exact);
  const name = NOTE_NAMES[(nearest + 1200) % 12];
  const oct = Math.floor(nearest / 12) - 1;
  return { note: `${name}${oct}`, hz: freq, cents, midi: nearest };
}

async function startTunerMic() {
  if (tunerMicRaf) return;
  try {
    tunerMicStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    showDialog(
      "无法开启麦克风",
      `<div class="muted">请允许麦克风权限，并确保用 <code>http://127.0.0.1</code> / <code>http://localhost</code> 打开页面（不要用局域网 IP）。</div>`
    );
    throw e;
  }

  tunerMicCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = tunerMicCtx.createMediaStreamSource(tunerMicStream);
  const hp = tunerMicCtx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 35;
  const lp = tunerMicCtx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 1500;
  tunerMicAnalyser = tunerMicCtx.createAnalyser();
  tunerMicAnalyser.fftSize = 2048;
  src.connect(hp);
  hp.connect(lp);
  lp.connect(tunerMicAnalyser);
  tunerMicBuf = new Float32Array(tunerMicAnalyser.fftSize);
  tunerRecentFreq = [];
  tunerNoSignalFrames = 0;
  tunerHoldString = 0;
  tunerHoldStartTs = 0;

  const loop = () => {
    if (!tunerMicAnalyser || !tunerMicBuf || !tunerMicCtx) return;
    tunerMicAnalyser.getFloatTimeDomainData(tunerMicBuf);

    // Silence gate: when quiet, avoid jitter and eventually reset the readout.
    if (rmsOf(tunerMicBuf) < 0.0035) {
      tunerNoSignalFrames++;
      if (tunerNoSignalFrames > 12) {
        tunerRecentFreq = [];
        if (els.tunerMicNote) els.tunerMicNote.textContent = "--";
        if (els.tunerMicHz) els.tunerMicHz.textContent = "-- Hz";
        if (els.tunerMicCents) els.tunerMicCents.textContent = "-- cents";
        if (els.tunerPointer) els.tunerPointer.style.left = "50%";
        updateTunerRowsOkUi(0);
      }
      tunerMicRaf = requestAnimationFrame(loop);
      return;
    }
    tunerNoSignalFrames = 0;

    /** @type {{freq:number, confidence:number} | null} */
    let best = detectPitchYIN(tunerMicBuf, tunerMicCtx.sampleRate);
    if (!best || best.confidence < 0.62) {
      const acf = detectPitchACF(tunerMicBuf, tunerMicCtx.sampleRate);
      if (acf && (!best || acf.confidence > best.confidence)) best = acf;
    }

    if (best && best.confidence > 0.22) {
      tunerRecentFreq.push(best.freq);
      if (tunerRecentFreq.length > 7) tunerRecentFreq.shift();
      const sorted = tunerRecentFreq.slice().sort((a, b) => a - b);
      const stable = sorted[Math.floor(sorted.length / 2)];
      const info = freqToNoteAndCents(stable);
      if (els.tunerMicNote) els.tunerMicNote.textContent = info.note;
      if (els.tunerMicHz) els.tunerMicHz.textContent = fmtHz(info.hz);
      if (els.tunerMicCents) els.tunerMicCents.textContent = `${info.cents >= 0 ? "+" : ""}${info.cents.toFixed(0)} cents`;
      if (els.tunerPointer) {
        const cents = clamp(info.cents, -50, 50);
        const pos = 50 + (cents / 50) * 50;
        els.tunerPointer.style.left = `${pos}%`;
      }

      // Match against the 6 string targets: if within tolerance for 1s => mark that string as OK.
      const active = getActiveTuning();
      const key = tuningKeyFrom(active);
      if (key !== tunerActiveKey) {
        tunerActiveKey = key;
        resetTunerMatchState();
      }
      const m = closestTuningStringMatch(stable, active);
      const now = performance.now();
      if (!m) {
        tunerHoldString = 0;
        tunerHoldStartTs = 0;
        updateTunerRowsOkUi(0);
      } else if (tunerOkStrings.has(m.stringNum)) {
        // Already OK, keep it green but don't require holding.
        updateTunerRowsOkUi(0);
      } else {
        if (tunerHoldString !== m.stringNum) {
          tunerHoldString = m.stringNum;
          tunerHoldStartTs = now;
        } else if (tunerHoldStartTs && (now - tunerHoldStartTs) >= TUNER_MATCH_HOLD_MS) {
          tunerOkStrings.add(m.stringNum);
          tunerHoldString = 0;
          tunerHoldStartTs = 0;
        }
        updateTunerRowsOkUi(m.stringNum);
      }
    }
    tunerMicRaf = requestAnimationFrame(loop);
  };
  tunerMicRaf = requestAnimationFrame(loop);
}

function stopTunerMic() {
  if (tunerMicRaf) cancelAnimationFrame(tunerMicRaf);
  tunerMicRaf = 0;
  if (tunerMicStream) {
    for (const t of tunerMicStream.getTracks()) t.stop();
  }
  tunerMicStream = null;
  if (tunerMicCtx) {
    try { tunerMicCtx.close(); } catch {}
  }
  tunerMicCtx = null;
  tunerMicAnalyser = null;
  tunerMicBuf = null;
  tunerRecentFreq = [];
  if (els.tunerMicNote) els.tunerMicNote.textContent = "--";
  if (els.tunerMicHz) els.tunerMicHz.textContent = "-- Hz";
  if (els.tunerMicCents) els.tunerMicCents.textContent = "-- cents";
  if (els.tunerPointer) els.tunerPointer.style.left = "50%";
  updateTunerRowsOkUi(0);
}

function renderTuner() {
  const active = getActiveTuning();
  const key = tuningKeyFrom(active);
  if (key !== tunerActiveKey) {
    tunerActiveKey = key;
    resetTunerMatchState();
  }
  if (els.tunerCurrentName) els.tunerCurrentName.textContent = active.name;
  if (els.tunerCurrentSub) els.tunerCurrentSub.textContent = active.sub;

  if (els.btnTunerMode) els.btnTunerMode.textContent = active.mode === "custom" ? "预设模式" : "自定义模式";
  if (els.btnTunerPreset) {
    els.btnTunerPreset.textContent = active.mode === "custom" ? "自定义模式" : "预设模式";
    els.btnTunerPreset.classList.toggle("pill--accent", active.mode !== "custom");
  }

  if (els.tunerPresets) {
    els.tunerPresets.hidden = active.mode === "custom";
    els.tunerPresets.innerHTML = "";
    for (const p of TUNER_PRESETS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tunerPreset" + (active.mode === "preset" && p.id === active.id ? " is-active" : "");
      b.innerHTML = `<div class="tunerPreset__title"></div><div class="tunerPreset__sub"></div>`;
      b.querySelector(".tunerPreset__title").textContent = p.name;
      b.querySelector(".tunerPreset__sub").textContent = p.sub;
      b.addEventListener("click", () => {
        setTunerMode("preset");
        setTunerPresetId(p.id);
        renderTuner();
      });
      els.tunerPresets.appendChild(b);
    }
  }

  if (els.tunerStringList) {
    els.tunerStringList.innerHTML = "";
    const notes = active.notes;
    for (let i = 0; i < 6; i++) {
      const stringNum = 6 - i;
      const row = document.createElement("div");
      row.className = "tunerStringRow";
      row.setAttribute("data-string", String(stringNum));
      row.innerHTML = `<div class="tunerStringRow__label"></div><div class="tunerNotePill"></div>`;
      row.querySelector(".tunerStringRow__label").textContent = `第${stringNum}弦`;

      const pill = /** @type {HTMLElement} */ (row.querySelector(".tunerNotePill"));
      // notes are stored as [6th..1st]
      const noteIdx = 6 - stringNum; // 0..5
      const n = notes[noteIdx] || "E2";
      const midi = noteToMidi(n);
      const hz = midi == null ? 0 : midiToFreq(midi);

      if (active.mode === "custom") {
        const sel = document.createElement("select");
        sel.className = "tunerSelect";
        for (const it of NOTE_INDEX) {
          const opt = document.createElement("option");
          opt.value = it.note;
          opt.textContent = it.note;
          if (it.note === n) opt.selected = true;
          sel.appendChild(opt);
        }
        sel.addEventListener("change", () => {
          const curr = getTunerCustomNotes();
          curr[noteIdx] = sel.value;
          setTunerCustomNotes(curr);
          renderTuner();
        });
        const left = document.createElement("div");
        left.style.display = "flex";
        left.style.flexDirection = "column";
        left.style.gap = "2px";
        const hzEl = document.createElement("div");
        hzEl.className = "tunerNotePill__hz";
        hzEl.textContent = fmtHz(hz);
        left.appendChild(sel);
        left.appendChild(hzEl);
        pill.appendChild(left);
      } else {
        const noteEl = document.createElement("div");
        noteEl.className = "tunerNotePill__note";
        noteEl.textContent = n;
        const right = document.createElement("div");
        right.className = "tunerNotePill__right";
        const hzEl = document.createElement("div");
        hzEl.className = "tunerNotePill__hz";
        hzEl.textContent = fmtHz(hz);
        const ok = document.createElement("div");
        ok.className = "tunerOkBadge";
        ok.textContent = "已就绪";
        ok.hidden = !tunerOkStrings.has(stringNum);
        right.appendChild(hzEl);
        right.appendChild(ok);
        pill.appendChild(noteEl);
        pill.appendChild(right);
      }

      const btn = document.createElement("button");
      btn.className = "toneBtn";
      btn.type = "button";
      btn.textContent = "播放";
      btn.addEventListener("click", async () => {
        try {
          await playTone(hz, btn);
        } catch {
          stopTone();
        }
      });
      row.appendChild(btn);

      els.tunerStringList.appendChild(row);
    }
    updateTunerRowsOkUi(0);
  }
}

// Exercise (training detail) state
/** @type {{ id: string, key: string, bpm: number } | null} */
let activeExercise = null;

// Mic / pitch detection state (exercise page)
/** @type {MediaStream | null} */
let micStream = null;
/** @type {AudioContext | null} */
let micCtx = null;
/** @type {AnalyserNode | null} */
let micAnalyser = null;
/** @type {Float32Array | null} */
let micBuf = null;
let micRaf = 0;
let lastHitTs = 0;
/** @type {number[]} */
let recentMidis = []; // legacy, kept for compatibility
/** @type {number[]} */
let recentFreqs = [];
let exHoldMidi = 0;
let exHoldStartTs = 0;
const EX_MATCH_CENTS = 35; // +/- cents
const EX_MATCH_HOLD_MS = 240;

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function noteNameFromMidi(midi) {
  const name = NOTE_NAMES[(midi + 1200) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return { name, octave };
}

function freqToMidi(freq) {
  return Math.round(69 + 12 * Math.log2(freq / 440));
}

function detectPitchYIN(frame, sampleRate) {
  // Monophonic pitch detection; better stability than naive autocorrelation for guitar single notes.
  const SIZE = frame.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += frame[i] * frame[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.006) return null;

  const maxTau = Math.floor(sampleRate / 55); // include low guitar notes (C2=65Hz)
  const minTau = Math.floor(sampleRate / 1400); // ~1400Hz
  const tauMax = Math.min(maxTau, Math.floor(SIZE / 2));
  if (tauMax <= minTau + 2) return null;

  const d = new Float32Array(tauMax + 1);
  const cmnd = new Float32Array(tauMax + 1);

  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i < tauMax; i++) {
      const x = frame[i] - frame[i + tau];
      sum += x * x;
    }
    d[tau] = sum;
  }

  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau];
    cmnd[tau] = d[tau] * tau / (running || 1);
  }

  const threshold = 0.12;
  let tau = -1;
  for (let t = minTau; t < tauMax; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 < tauMax && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau === -1) return null;

  // Parabolic interpolation
  const x0 = Math.max(1, tau - 1);
  const x2 = Math.min(tauMax - 1, tau + 1);
  const s0 = cmnd[x0], s1 = cmnd[tau], s2 = cmnd[x2];
  const a = (s0 + s2 - 2 * s1) / 2;
  const b = (s2 - s0) / 2;
  const shift = a ? -b / (2 * a) : 0;
  const betterTau = tau + shift;
  const freq = sampleRate / betterTau;
  if (!Number.isFinite(freq) || freq < 55 || freq > 1400) return null;
  return { freq, confidence: 1 - cmnd[tau] };
}

function keyToFretOnLowE(key) {
  // Natural keys only for now (per design)
  const map = { E: 0, F: 1, G: 3, A: 5, B: 7, C: 8, D: 10 };
  return map[key] ?? 0;
}

function majorScalePitchClasses(key) {
  // relative to root: 0,2,4,5,7,9,11
  const rootPc = NOTE_NAMES.indexOf(key);
  const pcs = [0, 2, 4, 5, 7, 9, 11].map((d) => (rootPc + d + 12) % 12);
  return new Set(pcs);
}

function solfegeForPc(rootPc, pc) {
  const steps = [0, 2, 4, 5, 7, 9, 11];
  const names = ["do", "re", "mi", "fa", "sol", "la", "ti"];
  const diff = (pc - rootPc + 12) % 12;
  const idx = steps.indexOf(diff);
  return idx >= 0 ? names[idx] : null;
}

function recommendedFretRangeForKey(key) {
  const rootPc = NOTE_NAMES.indexOf(key);
  /** @type {number[]} */
  const roots = [];
  for (const s of [6, 5, 4, 3, 2, 1]) {
    const open = getOpenStringMidi(s);
    for (let fret = 0; fret <= 12; fret++) {
      const pc = (open + fret + 1200) % 12;
      if (pc === rootPc) roots.push(fret);
    }
  }
  const min = roots.length ? Math.min(...roots) : 0;
  const start = clamp(min - 1, 0, 12);
  const end = clamp(start + 5, 5, 15);
  return { start, end };
}

function getOpenStringMidi(stringNum) {
  // 6..1 -> E2 A2 D3 G3 B3 E4
  const map = { 6: 40, 5: 45, 4: 50, 3: 55, 2: 59, 1: 64 };
  return map[stringNum] ?? 40;
}

function renderExercisePage(exId) {
  const ex = EXERCISES.find((x) => x.id === exId);
  if (!ex) return;
  const savedBpm = clamp(Number(localStorage.getItem("exMetroBpm") || "80"), 40, 240);
  const savedBeats = clamp(Number(localStorage.getItem("exMetroBeats") || "4"), 1, 12);
  const savedAccent = (localStorage.getItem("exMetroAccent") || "1") === "1";

  activeExercise = { id: exId, key: "B", bpm: savedBpm };
  exMetro.setTempo(savedBpm);
  exMetro.setBeatsPerBar(savedBeats);
  exMetro.setAccent(savedAccent);
  if (els.exerciseTitle) els.exerciseTitle.textContent = ex.name;
  if (els.exerciseSub) els.exerciseSub.textContent = ex.desc;
  if (els.exerciseXp) els.exerciseXp.textContent = `+${ex.xp}`;

  if (els.exerciseBpmText) els.exerciseBpmText.textContent = String(activeExercise.bpm);
  if (els.exMetroBpm) els.exMetroBpm.value = String(activeExercise.bpm);
  if (els.exMetroBpmText) els.exMetroBpmText.textContent = String(activeExercise.bpm);
  if (els.exMetroBeats) els.exMetroBeats.value = String(savedBeats);
  if (els.exMetroAccent) els.exMetroAccent.checked = savedAccent;

  // Per-exercise sections
  if (els.exerciseKeyCard) els.exerciseKeyCard.hidden = exId === "chromatic";
  if (els.exerciseKeys) els.exerciseKeys.hidden = exId === "chromatic";
  if (els.exerciseBullets) {
    const bullets =
      exId === "chromatic"
        ? [
            "从第 1 品开始，按 1-2-3-4 指法依次弹奏（也可从第 5 品开始更舒服）",
            "每根弦上行后再下行，注意换弦时保持节奏均匀",
            "尽量做到每个音发声清晰、力度一致",
          ]
        : [
            "找到当前调的 do（根音）位置，记住指板分布",
            "上行和下行都要练习，尽量按节拍弹奏",
            "保持节奏均匀，音要干净",
          ];
    els.exerciseBullets.innerHTML = bullets.map((t) => `<li>${t}</li>`).join("");
  }

  if (exId !== "chromatic") renderExerciseKeys();
  renderFretboard();
  updateMicStatus(false);
  setExMetronomeUiOpen(true);
  setExMetronomeRunningUi(exMetro.isRunning);
}

function renderExerciseKeys() {
  if (!els.exerciseKeys || !activeExercise) return;
  const keys = ["C", "D", "E", "F", "G", "A", "B"];
  els.exerciseKeys.innerHTML = "";
  for (const k of keys) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "exKeyBtn" + (k === activeExercise.key ? " is-active" : "");
    btn.textContent = `${k}调`;
    btn.addEventListener("click", () => {
      if (!activeExercise) return;
      activeExercise.key = k;
      renderExerciseKeys();
      renderFretboard();
    });
    els.exerciseKeys.appendChild(btn);
  }
}

function renderFretboard() {
  if (!els.fretboard || !activeExercise) return;
  if (activeExercise.id === "chromatic") return renderFretboardChromatic();
  return renderFretboardMajorScale();
}

function createFretboardBase(range) {
  // Lying guitar: rows are strings (1..6), columns are frets (1..15).
  const fb = document.createElement("div");
  fb.className = "fbH";

  // Continuous fret wires overlay (not broken per-cell).
  const fretsOverlay = document.createElement("div");
  fretsOverlay.className = "fbH__frets";
  for (let fret = 1; fret <= 15; fret++) {
    const w = document.createElement("div");
    w.className = "fbH__fretWire";
    w.style.gridColumn = String(fret + 1);
    fretsOverlay.appendChild(w);
  }
  fb.appendChild(fretsOverlay);

  const header = document.createElement("div");
  header.className = "fbH__hdr";
  const corner = document.createElement("div");
  corner.className = "fbH__corner";
  corner.textContent = "";
  header.appendChild(corner);
  for (let fret = 1; fret <= 15; fret++) {
    const h = document.createElement("div");
    h.className = "fbH__fretNum" + (fret >= range.start && fret <= range.end ? " is-inRange" : "");
    h.textContent = String(fret);
    header.appendChild(h);
  }
  fb.appendChild(header);

  return fb;
}

function renderFretboardMajorScale() {
  if (!els.fretboard || !activeExercise) return;
  const key = activeExercise.key;
  const rootPc = NOTE_NAMES.indexOf(key);
  const scalePcs = majorScalePitchClasses(key);
  const range = recommendedFretRangeForKey(key);
  els.fretboard.innerHTML = "";

  const fb = createFretboardBase(range);

  for (const s of [1, 2, 3, 4, 5, 6]) {
    const row = document.createElement("div");
    row.className = "fbH__row";
    const sl = document.createElement("div");
    sl.className = "fbH__sLabel";
    sl.textContent = String(s);
    row.appendChild(sl);

    for (let fret = 1; fret <= 15; fret++) {
      const cell = document.createElement("div");
      cell.className = "fbH__cell" + (fret >= range.start && fret <= range.end ? " is-inRange" : "");

      const midi = getOpenStringMidi(s) + fret;
      const pc = (midi + 1200) % 12;
      const sol = solfegeForPc(rootPc, pc);
      const isScale = scalePcs.has(pc);

      if (isScale && sol) {
        const tag = document.createElement("div");
        tag.className = "fbH__tag";
        tag.textContent = sol;
        cell.appendChild(tag);
      }

      const dot = document.createElement("div");
      dot.className = "fbH__dot";
      dot.dataset.string = String(s);
      dot.dataset.fret = String(fret);
      dot.dataset.midi = String(midi);
      if (isScale) dot.classList.add("is-note");
      if (isScale && pc === rootPc) dot.classList.add("is-root");
      cell.appendChild(dot);
      row.appendChild(cell);
    }
    fb.appendChild(row);
  }

  els.fretboard.appendChild(fb);
  if (els.fretWrap) {
    const approxCellW = 42;
    els.fretWrap.scrollLeft = Math.max(0, (range.start - 1) * approxCellW);
  }
}

function renderFretboardChromatic() {
  if (!els.fretboard || !activeExercise) return;
  // Default: show 1-2-3-4 finger pattern on frets 1..4 across all strings.
  const range = { start: 1, end: 4 };
  els.fretboard.innerHTML = "";

  const fb = createFretboardBase(range);

  for (const s of [1, 2, 3, 4, 5, 6]) {
    const row = document.createElement("div");
    row.className = "fbH__row";
    const sl = document.createElement("div");
    sl.className = "fbH__sLabel";
    sl.textContent = String(s);
    row.appendChild(sl);

    for (let fret = 1; fret <= 15; fret++) {
      const cell = document.createElement("div");
      cell.className = "fbH__cell" + (fret >= range.start && fret <= range.end ? " is-inRange" : "");

      const dot = document.createElement("div");
      dot.className = "fbH__dot";
      const midi = getOpenStringMidi(s) + fret;
      dot.dataset.string = String(s);
      dot.dataset.fret = String(fret);
      dot.dataset.midi = String(midi);

      if (fret >= 1 && fret <= 4) {
        dot.classList.add("is-note");
        const tag = document.createElement("div");
        tag.className = "fbH__tag fbH__tag--finger";
        tag.textContent = String(fret); // finger 1..4
        cell.appendChild(tag);
      }

      cell.appendChild(dot);
      row.appendChild(cell);
    }
    fb.appendChild(row);
  }

  els.fretboard.appendChild(fb);
  if (els.fretWrap) els.fretWrap.scrollLeft = 0;
}

function flashDotsForMidi(midi) {
  if (!els.fretboard) return false;
  const all = Array.from(els.fretboard.querySelectorAll(".fbH__dot.is-note"));
  /** @type {HTMLElement[]} */
  let targets = all.filter((d) => Number(d.getAttribute("data-midi") || "0") === midi);
  if (targets.length === 0) targets = all.filter((d) => (Number(d.getAttribute("data-midi") || "0") % 12) === (midi % 12));
  for (const d of targets) {
    d.classList.add("is-hit");
    window.setTimeout(() => d.classList.remove("is-hit"), 160);
  }
  return targets.length > 0;
}

function updateMicStatus(on) {
  if (els.micStatus) els.micStatus.textContent = on ? "麦克风：监听中" : "麦克风：未开启";
  if (els.btnMicToggle) els.btnMicToggle.classList.toggle("navPill--accent", !!on);
}

async function startMic() {
  if (micRaf) return;
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  micCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = micCtx.createMediaStreamSource(micStream);
  // Light filtering helps reduce low-frequency rumble and high-frequency hiss.
  const hp = micCtx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 35;
  const lp = micCtx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 1500;
  micAnalyser = micCtx.createAnalyser();
  micAnalyser.fftSize = 2048;
  src.connect(hp);
  hp.connect(lp);
  lp.connect(micAnalyser);
  micBuf = new Float32Array(micAnalyser.fftSize);
  updateMicStatus(true);
  recentMidis = [];
  recentFreqs = [];
  exHoldMidi = 0;
  exHoldStartTs = 0;

  const loop = () => {
    if (!micAnalyser || !micBuf || !micCtx) return;
    micAnalyser.getFloatTimeDomainData(micBuf);

    /** @type {{freq:number, confidence:number} | null} */
    let best = detectPitchYIN(micBuf, micCtx.sampleRate);
    if (!best || best.confidence < 0.62) {
      const acf = detectPitchACF(micBuf, micCtx.sampleRate);
      if (acf && (!best || acf.confidence > best.confidence)) best = acf;
    }

    if (best && activeExercise && best.confidence > 0.22) {
      recentFreqs.push(best.freq);
      if (recentFreqs.length > 7) recentFreqs.shift();
      const sortedF = recentFreqs.slice().sort((a, b) => a - b);
      const stableFreq = sortedF[Math.floor(sortedF.length / 2)];
      const info = freqToNoteAndCents(stableFreq);
      if (Math.abs(info.cents) > EX_MATCH_CENTS) {
        exHoldMidi = 0;
        exHoldStartTs = 0;
        micRaf = requestAnimationFrame(loop);
        return;
      }

      const now = performance.now();
      if (exHoldMidi !== info.midi) {
        exHoldMidi = info.midi;
        exHoldStartTs = now;
      }
      const heldOk = exHoldStartTs && (now - exHoldStartTs) >= EX_MATCH_HOLD_MS;

      if (heldOk && now - lastHitTs > 120) {
        if (activeExercise.id === "chromatic") {
          if (flashDotsForMidi(info.midi)) lastHitTs = now;
        } else {
          const pcs = majorScalePitchClasses(activeExercise.key);
          const pc = (info.midi + 1200) % 12;
          if (pcs.has(pc)) {
            lastHitTs = now;
            flashDotsForMidi(info.midi);
          }
        }
      }
    } else {
      exHoldMidi = 0;
      exHoldStartTs = 0;
    }
    micRaf = requestAnimationFrame(loop);
  };
  micRaf = requestAnimationFrame(loop);
}

function stopMic() {
  if (micRaf) cancelAnimationFrame(micRaf);
  micRaf = 0;
  if (micStream) {
    for (const t of micStream.getTracks()) t.stop();
  }
  micStream = null;
  if (micCtx) {
    try { micCtx.close(); } catch {}
  }
  micCtx = null;
  micAnalyser = null;
  micBuf = null;
  recentMidis = [];
  recentFreqs = [];
  exHoldMidi = 0;
  exHoldStartTs = 0;
  updateMicStatus(false);
}

function levelBadgeClass(level) {
  if (level === "初级") return "badge badge--easy";
  if (level === "中级") return "badge badge--mid";
  return "badge badge--hard";
}

function loadPlans() {
  try {
    const raw = localStorage.getItem(LS_PLANS) || "[]";
    const arr = JSON.parse(raw);
    plans = Array.isArray(arr) ? arr : [];
  } catch {
    plans = [];
  }
}

function savePlans() {
  localStorage.setItem(LS_PLANS, JSON.stringify(plans));
}

function planTotals(items) {
  let minutes = 0;
  let xp = 0;
  for (const id of items || []) {
    const ex = EXERCISES.find((x) => x.id === id);
    if (!ex) continue;
    minutes += ex.minutes || 0;
    xp += ex.xp || 0;
  }
  return { minutes, xp, count: (items || []).length };
}

function renderPractice() {
  renderQuickPlans();
  renderExercises();
}

function renderQuickPlans() {
  if (!els.quickPlanList) return;
  els.quickPlanList.innerHTML = "";

  const builtIn = [
    { id: "builtin_warmup", title: "15 分钟热身", sub: "3 个练习 · 15 分钟 · +180 XP" },
    { id: "builtin_basic", title: "新手基础", sub: "4 个练习 · 25 分钟 · +250 XP" },
    { id: "builtin_speed", title: "速度训练", sub: "5 个练习 · 30 分钟 · +400 XP" },
  ];

  for (const p of builtIn) {
    const card = document.createElement("div");
    card.className = "listCard";
    card.innerHTML = `<div class="listCard__meta"><div class="listCard__title"></div><div class="listCard__sub"></div></div>`;
    card.querySelector(".listCard__title").textContent = p.title;
    card.querySelector(".listCard__sub").textContent = p.sub;
    const btn = document.createElement("button");
    btn.className = "playBtn";
    btn.type = "button";
    btn.textContent = "▶";
    btn.addEventListener("click", () => {
      showDialog("开始训练", "该训练为占位示例，后续会接入计时/节拍器/跟练。", { showClose: true });
    });
    card.appendChild(btn);
    els.quickPlanList.appendChild(card);
  }

  for (const pl of plans.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
    const totals = planTotals(pl.items || []);
    const card = document.createElement("div");
    card.className = "listCard";
    card.innerHTML = `<div class="listCard__meta"><div class="listCard__title"></div><div class="listCard__sub"></div></div>`;
    card.querySelector(".listCard__title").textContent = pl.name || "自定义训练";
    card.querySelector(".listCard__sub").textContent = `${totals.count} 个练习 · ${totals.minutes} 分钟 · +${totals.xp} XP`;
    const btn = document.createElement("button");
    btn.className = "playBtn";
    btn.type = "button";
    btn.textContent = "▶";
    btn.addEventListener("click", () => {
      showDialog("开始训练", `“${pl.name}” 已保存（当前为占位开始）。`, { showClose: true });
    });
    card.appendChild(btn);
    els.quickPlanList.appendChild(card);
  }
}

function renderExercises() {
  if (!els.exerciseList) return;
  els.exerciseList.innerHTML = "";

  for (const ex of EXERCISES) {
    const row = document.createElement("div");
    row.className = "exerciseRow";
    row.innerHTML = `
      <div class="exerciseRow__icon">▶</div>
      <div class="exerciseRow__main">
        <div class="exerciseRow__title"></div>
        <div class="exerciseRow__desc"></div>
        <div class="exerciseRow__meta">
          <span class="${levelBadgeClass(ex.level)}">${ex.level}</span>
          <span>🕒 ${ex.minutes} 分钟</span>
          <span>⚡ +${ex.xp} XP</span>
        </div>
      </div>
    `;
    row.querySelector(".exerciseRow__title").textContent = ex.name;
    row.querySelector(".exerciseRow__desc").textContent = ex.desc;
    const start = document.createElement("button");
    start.className = "startBtn";
    start.type = "button";
    start.textContent = "开始";
    start.addEventListener("click", () => {
      if (ex.id === "pentatonic" || ex.id === "chromatic") {
        setPage("exercise");
        renderExercisePage(ex.id);
        return;
      }
      showDialog("开始练习", `${ex.name}<br/>${ex.desc}<br/><br/>该练习将作为基础训练项供自定义训练计划搭配（后续可接计时/节拍器/音高识别）。`, { showClose: true });
    });
    row.appendChild(start);
    els.exerciseList.appendChild(row);
  }
}

function openPlanBuilder() {
  planDraft = { id: id(), name: "我的自定义训练", items: [] };
  if (els.planNameInput) els.planNameInput.value = planDraft.name;
  if (els.planSearch) els.planSearch.value = "";
  setPage("plan");
  renderPlanBuilder();
}

function renderPlanBuilder() {
  if (!planDraft) return;
  const totals = planTotals(planDraft.items);
  if (els.planSummaryText) els.planSummaryText.textContent = `${totals.count} 个练习 · 总计 ${totals.minutes} 分钟`;

  const has = totals.count > 0;
  if (els.planSelectedEmpty) els.planSelectedEmpty.hidden = has;
  if (els.planSelectedList) els.planSelectedList.hidden = !has;

  if (els.planSelectedList) {
    els.planSelectedList.innerHTML = "";
    for (const exId of planDraft.items) {
      const ex = EXERCISES.find((x) => x.id === exId);
      if (!ex) continue;
      const row = document.createElement("div");
      row.className = "addRow";
      row.innerHTML = `<div><div class="addRow__title"></div><div class="addRow__sub"></div><div class="addRow__meta"></div></div>`;
      row.querySelector(".addRow__title").textContent = ex.name;
      row.querySelector(".addRow__sub").textContent = ex.desc;
      row.querySelector(".addRow__meta").textContent = `🕒 ${ex.minutes} 分钟`;
      const btn = document.createElement("button");
      btn.className = "addBtn";
      btn.type = "button";
      btn.textContent = "－";
      btn.addEventListener("click", () => {
        planDraft.items = planDraft.items.filter((x) => x !== exId);
        renderPlanBuilder();
      });
      row.appendChild(btn);
      els.planSelectedList.appendChild(row);
    }
  }

  const q = (els.planSearch && els.planSearch.value || "").trim().toLowerCase();
  const list = EXERCISES.filter((ex) => {
    if (!q) return true;
    return (ex.name + " " + ex.desc).toLowerCase().includes(q);
  });

  if (els.planAddList) {
    els.planAddList.innerHTML = "";
    for (const ex of list) {
      const row = document.createElement("div");
      row.className = "addRow";
      row.innerHTML = `<div><div class="addRow__title"></div><div class="addRow__sub"></div><div class="addRow__meta"></div></div>`;
      row.querySelector(".addRow__title").textContent = ex.name;
      row.querySelector(".addRow__sub").textContent = ex.desc;
      row.querySelector(".addRow__meta").textContent = `🕒 ${ex.minutes} 分钟`;
      const btn = document.createElement("button");
      btn.className = "addBtn";
      btn.type = "button";
      btn.textContent = "＋";
      btn.disabled = planDraft.items.includes(ex.id);
      btn.addEventListener("click", () => {
        if (!planDraft) return;
        if (!planDraft.items.includes(ex.id)) planDraft.items.push(ex.id);
        renderPlanBuilder();
      });
      row.appendChild(btn);
      els.planAddList.appendChild(row);
    }
  }
}

const $ = (id) => document.getElementById(id);

function on(el, type, handler, options) {
  if (!el) return;
  el.addEventListener(type, handler, options);
}

function getDetailScrollEl() {
  // Prefer the dedicated detail scroller. If layout changes and it stops scrolling,
  // fall back to the real scrolling element (some browsers/layouts scroll the document).
  /** @type {HTMLElement[]} */
  const candidates = [];
  if (els.scoreDetailScroll) candidates.push(/** @type {HTMLElement} */ (els.scoreDetailScroll));
  if (els.sheet) candidates.push(/** @type {HTMLElement} */ (els.sheet));
  if (document.scrollingElement) candidates.push(/** @type {HTMLElement} */ (document.scrollingElement));
  candidates.push(document.documentElement);
  candidates.push(document.body);

  for (const el of candidates) {
    if (!el) continue;
    if (el.scrollHeight - el.clientHeight > 2) return el;
  }
  return /** @type {HTMLElement} */ (candidates.find(Boolean) || document.documentElement);
}

const els = {
  // Pages / tabs
  pageHome: $("pageHome"),
  pageScores: $("pageScores"),
  pageScoreDetail: $("pageScoreDetail"),
  pagePractice: $("pagePractice"),
  pagePlan: $("pagePlan"),
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
  scrollPresetSlow: $("scrollPresetSlow"),
  scrollPresetNormal: $("scrollPresetNormal"),
  scrollPresetFast: $("scrollPresetFast"),
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

  // Practice
  btnPracticeCustomize: $("btnPracticeCustomize"),
  quickPlanList: $("quickPlanList"),
  exerciseList: $("exerciseList"),

  // Plan builder
  btnPlanBack: $("btnPlanBack"),
  btnPlanSave: $("btnPlanSave"),
  planNameInput: /** @type {HTMLInputElement} */ ($("planNameInput")),
  planSummaryText: $("planSummaryText"),
  planSelectedEmpty: $("planSelectedEmpty"),
  planSelectedList: $("planSelectedList"),
  planSearch: /** @type {HTMLInputElement} */ ($("planSearch")),
  planAddList: $("planAddList"),

  // Exercise
  btnExerciseBack: $("btnExerciseBack"),
  exerciseTitle: $("exerciseTitle"),
  exerciseSub: $("exerciseSub"),
  exerciseXp: $("exerciseXp"),
  exerciseStep: $("exerciseStep"),
  exercisePct: $("exercisePct"),
  exerciseBar: $("exerciseBar"),
  exerciseBpmText: $("exerciseBpmText"),
  exerciseKeys: $("exerciseKeys"),
  exerciseKeyCard: $("exerciseKeyCard"),
  exerciseBullets: $("exerciseBullets"),
  fretWrap: $("fretWrap"),
  fretboard: $("fretboard"),
  micStatus: $("micStatus"),
  btnMicToggle: $("btnMicToggle"),
  exBtnMetronome: $("exBtnMetronome"),
  exMetronomeControls: $("exMetronomeControls"),
  exMetroBpm: /** @type {HTMLInputElement} */ ($("exMetroBpm")),
  exMetroBpmText: $("exMetroBpmText"),
  exMetroBeats: /** @type {HTMLSelectElement} */ ($("exMetroBeats")),
  exMetroAccent: /** @type {HTMLInputElement} */ ($("exMetroAccent")),
  exMetroPulse: $("exMetroPulse"),
  exBtnMetroToggle: $("exBtnMetroToggle"),
  exBtnMetroTap: $("exBtnMetroTap"),
  exBtnMetroStop: $("exBtnMetroStop"),

  // Tuner
  pageTuner: $("pageTuner"),
  btnOpenTuner: $("btnOpenTuner"),
  btnTunerBack: $("btnTunerBack"),
  btnTunerMode: $("btnTunerMode"),
  btnTunerPreset: $("btnTunerPreset"),
  tunerPresets: $("tunerPresets"),
  tunerCurrentName: $("tunerCurrentName"),
  tunerCurrentSub: $("tunerCurrentSub"),
  tunerStringList: $("tunerStringList"),
  btnTunerMic: $("btnTunerMic"),
  tunerMicNote: $("tunerMicNote"),
  tunerMicHz: $("tunerMicHz"),
  tunerMicCents: $("tunerMicCents"),
  tunerPointer: $("tunerPointer"),
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
  const prev = currentPage;
  currentPage = page;
  const pages = ["home", "scores", "score", "practice", "plan", "exercise", "me", "tuner"];
  for (const p of pages) {
    const el = document.querySelector(`[data-page="${p}"]`);
    if (!el) continue;
    el.classList.toggle("is-active", p === page);
  }

  for (const btn of els.tabButtons) {
    const t = btn.getAttribute("data-tab");
    const tabActive =
      (page === "score" && t === "scores") ||
      (page === "plan" && t === "practice") ||
      (page === "exercise" && t === "practice") ||
      (page === "tuner" && t === "me") ||
      t === page;
    btn.classList.toggle("is-active", tabActive);
  }

  // Tab bar always visible (reader is inside Scores tab now).

  // Lightweight render hooks for non-tab subpages.
  if (page === "practice") renderPractice();
  if (page === "plan") renderPlanBuilder();
  if (page === "tuner") renderTuner();

  // Leaving exercise: stop mic & metronome to avoid background audio.
  if (prev === "exercise" && page !== "exercise") {
    stopMic();
    stopExerciseMetronome();
  }

  if (prev === "tuner" && page !== "tuner") {
    stopTone();
    stopTunerMic();
  }
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
  if (els.btnAutoScroll) {
    els.btnAutoScroll.textContent = on ? "自动滚动中" : "自动滚动";
    els.btnAutoScroll.setAttribute("aria-pressed", on ? "true" : "false");
  }
  if (els.scrollControls) els.scrollControls.hidden = !on;
  if (!on) {
    cancelAnimationFrame(autoScrollRaf);
    autoScrollRaf = 0;
    autoScrollLastTs = 0;
    autoScrollCarryPx = 0;
  } else {
    autoScrollLastTs = 0;
    autoScrollCarryPx = 0;
    autoScrollRaf = requestAnimationFrame(autoScrollTick);
  }
}

function timeSigFromUi() {
  const beats = Number((els.metroBeats && els.metroBeats.value) || "4");
  const denom = beats <= 5 ? 4 : 8; // UI only provides numerator; infer denominator from common patterns.
  return { beats, denom };
}

function effectiveBeatsPerBar(ts) {
  if (ts.denom !== 8) return ts.beats;
  // Compound meters (6/8, 9/8, 12/8) are typically felt in dotted quarters: 2, 3, 4.
  if (ts.beats >= 6 && ts.beats % 3 === 0) return ts.beats / 3;
  // Irregular /8: feel it in 2s/3s, but we keep it simple and map roughly to quarter-note pulses.
  return Math.max(2, Math.round(ts.beats / 2));
}

function scrollBaseSpeed() {
  const bpm = Number((els.metroBpm && els.metroBpm.value) || "100");
  const ts = timeSigFromUi();
  const eff = effectiveBeatsPerBar(ts);
  // Tuned so that 4/4 @ 100 BPM ~= 2.5 (current default). Higher BPM feels faster.
  const k = 1.5;
  const base = (bpm / 60) * (eff / 4) * k;
  return clamp(base, 0.5, 10);
}

function setScrollSpeed(v) {
  if (!els.scrollSpeed || !els.scrollSpeedText) return;
  const n = clamp(Number(v || 0), 0, 12);
  els.scrollSpeed.value = String(n);
  els.scrollSpeedText.textContent = n.toFixed(2).replace(/\.00$/, "");
}

function setActiveScrollPreset(key) {
  activeScrollPreset = key;
  const activeBtn =
    key === "slow" ? els.scrollPresetSlow : key === "fast" ? els.scrollPresetFast : key === "normal" ? els.scrollPresetNormal : null;
  const btns = [els.scrollPresetSlow, els.scrollPresetNormal, els.scrollPresetFast];
  for (const b of btns) {
    if (!b) continue;
    b.classList.toggle("is-active", !!activeBtn && b === activeBtn);
  }
}

function applyScrollPreset(key) {
  const base = scrollBaseSpeed();
  const mult = key === "slow" ? 0.8 : key === "fast" ? 1.25 : 1.0;
  const speed = clamp(base * mult, 0, 12);
  setActiveScrollPreset(key);
  setScrollSpeed(speed);
}

function updateScrollPresetsUi() {
  const base = scrollBaseSpeed();
  const presets = [
    { key: "slow", btn: els.scrollPresetSlow, mult: 0.8, label: "慢" },
    { key: "normal", btn: els.scrollPresetNormal, mult: 1.0, label: "标准" },
    { key: "fast", btn: els.scrollPresetFast, mult: 1.25, label: "快" },
  ];
  for (const p of presets) {
    if (!p.btn) continue;
    const v = clamp(base * p.mult, 0, 12);
    p.btn.textContent = `${p.label} ${v.toFixed(1)}`.replace(/\.0$/, "");
  }
  if (activeScrollPreset) applyScrollPreset(activeScrollPreset);
}

function autoScrollTick(ts) {
  if (!autoScrollOn) return;
  if (!autoScrollLastTs) autoScrollLastTs = ts;
  const dt = (ts - autoScrollLastTs) / 1000;
  autoScrollLastTs = ts;

  const speed = Number((els.scrollSpeed && els.scrollSpeed.value) || "0");
  const fontPx = Number(
    getComputedStyle(document.documentElement).getPropertyValue("--sheetFontSize").replace("px", "")
  );
  const pxPerSec = speed * (fontPx * 0.8);
  const delta = pxPerSec * dt;

  const scroller = getDetailScrollEl();
  const maxScroll = scroller.scrollHeight - scroller.clientHeight;
  const prev = scroller.scrollTop;
  const move = delta + autoScrollCarryPx;
  const next = clamp(prev + move, 0, Math.max(0, maxScroll));
  scroller.scrollTop = next;
  const applied = scroller.scrollTop - prev;
  // Some browsers effectively quantize scrollTop to integer pixels; carry the remainder forward.
  autoScrollCarryPx = move - applied;
  if (Math.abs(autoScrollCarryPx) > 1000) autoScrollCarryPx = 0;

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

// Exercise page metronome (same style as Scores page, but isolated IDs)
const exMetro = new Metronome();

function setExMetronomeUiOpen(on) {
  if (!els.exMetronomeControls || !els.exBtnMetronome) return;
  els.exMetronomeControls.hidden = !on;
  els.exBtnMetronome.textContent = on ? "收起节拍器" : "节拍器";
}

function stopExerciseMetronome() {
  if (!exMetro.isRunning) return;
  exMetro.stop();
  setExMetronomeRunningUi(false);
}

function setExMetronomeRunningUi(running) {
  if (els.exBtnMetroToggle) els.exBtnMetroToggle.textContent = running ? "运行中" : "开始";
}

function pulseExTick(isAccent) {
  if (!els.exMetroPulse) return;
  els.exMetroPulse.classList.remove("is-on", "is-accent");
  void els.exMetroPulse.offsetWidth;
  els.exMetroPulse.classList.add(isAccent ? "is-accent" : "is-on");
  window.setTimeout(() => els.exMetroPulse.classList.remove("is-on", "is-accent"), 80);
}

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
  navigator.serviceWorker.register("./sw.js?v=28").catch(() => {});
}

function wireUi() {
  // Tabs
  for (const btn of els.tabButtons) {
    btn.addEventListener("click", () => setPage(/** @type any */ (btn.getAttribute("data-tab"))));
  }

  on(els.btnGoPractice, "click", () => setPage("practice"));
  on(els.btnGoScores, "click", () => setPage("scores"));
  on(els.btnOpenTuner, "click", () => setPage("tuner"));
  on(els.btnTunerBack, "click", () => setPage("me"));
  on(els.btnTunerMode, "click", () => {
    const mode = getTunerMode() === "custom" ? "preset" : "custom";
    setTunerMode(mode);
    renderTuner();
  });
  on(els.btnTunerPreset, "click", () => {
    const mode = getTunerMode() === "custom" ? "preset" : "custom";
    setTunerMode(mode);
    renderTuner();
  });
  on(els.btnTunerMic, "click", async () => {
    if (!els.btnTunerMic) return;
    try {
      if (tunerMicRaf) {
        stopTunerMic();
        els.btnTunerMic.textContent = "开始监听";
      } else {
        await startTunerMic();
        els.btnTunerMic.textContent = "停止监听";
      }
    } catch (err) {
      stopTunerMic();
      els.btnTunerMic.textContent = "开始监听";
      showDialog("无法开启麦克风", `请检查浏览器麦克风权限。<br/><br/>错误：${String(err && err.message ? err.message : err)}`, { showClose: true });
    }
  });

  // Practice / plan builder
  on(els.btnPracticeCustomize, "click", () => openPlanBuilder());
  on(els.btnPlanBack, "click", () => setPage("practice"));
  on(els.planSearch, "input", () => renderPlanBuilder());
  on(els.btnPlanSave, "click", () => {
    if (!planDraft) return;
    const name = String((els.planNameInput && els.planNameInput.value) || "").trim().replace(/\s+/g, " ").slice(0, 40);
    if (!name) {
      showDialog("提示", "请填写训练计划名称。", { showClose: true });
      return;
    }
    if (planDraft.items.length === 0) {
      showDialog("提示", "请至少添加 1 个练习。", { showClose: true });
      return;
    }
    const now = Date.now();
    const saved = { id: planDraft.id, name, items: planDraft.items.slice(0), createdAt: now, updatedAt: now };
    plans.unshift(saved);
    // Keep a small list for now
    plans = plans.slice(0, 20);
    savePlans();
    planDraft = null;
    setPage("practice");
    renderPractice();
  });
  on(els.planNameInput, "input", () => {
    if (!planDraft || !els.planNameInput) return;
    planDraft.name = els.planNameInput.value;
  });

  // Exercise page
  on(els.btnExerciseBack, "click", () => {
    stopMic();
    stopExerciseMetronome();
    setPage("practice");
  });
  exMetro.onTick = (_beatIndex, isAccent) => pulseExTick(isAccent);
  on(els.exBtnMetronome, "click", () => setExMetronomeUiOpen(!!(els.exMetronomeControls && els.exMetronomeControls.hidden)));
  on(els.exMetroBpm, "input", () => {
    if (!activeExercise || !els.exMetroBpm || !els.exMetroBpmText) return;
    const bpm = clamp(Number(els.exMetroBpm.value) || 80, 40, 240);
    activeExercise.bpm = bpm;
    els.exMetroBpmText.textContent = String(bpm);
    if (els.exerciseBpmText) els.exerciseBpmText.textContent = String(bpm);
    exMetro.setTempo(bpm);
    localStorage.setItem("exMetroBpm", String(bpm));
  });
  on(els.exMetroBeats, "change", () => {
    if (!els.exMetroBeats) return;
    exMetro.setBeatsPerBar(Number(els.exMetroBeats.value));
    localStorage.setItem("exMetroBeats", String(els.exMetroBeats.value));
  });
  on(els.exMetroAccent, "change", () => {
    if (!els.exMetroAccent) return;
    exMetro.setAccent(!!els.exMetroAccent.checked);
    localStorage.setItem("exMetroAccent", els.exMetroAccent.checked ? "1" : "0");
  });
  on(els.exBtnMetroToggle, "click", async () => {
    if (!exMetro.isRunning) {
      try {
        await exMetro.start();
        setExMetronomeRunningUi(true);
      } catch {}
    }
  });
  on(els.exBtnMetroStop, "click", () => stopExerciseMetronome());
  on(els.exBtnMetroTap, "click", async () => {
    const t = performance.now();
    tapTimes.push(t);
    tapTimes = tapTimes.filter((x) => t - x <= 2500);
    if (tapTimes.length >= 2) {
      const diffs = [];
      for (let i = 1; i < tapTimes.length; i++) diffs.push(tapTimes[i] - tapTimes[i - 1]);
      diffs.sort((a, b) => a - b);
      const mid = diffs[Math.floor(diffs.length / 2)];
      const bpm = clamp(Math.round(60000 / mid), 40, 240);
      if (els.exMetroBpm) els.exMetroBpm.value = String(bpm);
      if (els.exMetroBpmText) els.exMetroBpmText.textContent = String(bpm);
      if (els.exerciseBpmText) els.exerciseBpmText.textContent = String(bpm);
      if (activeExercise) activeExercise.bpm = bpm;
      exMetro.setTempo(bpm);
      localStorage.setItem("exMetroBpm", String(bpm));
    } else {
      // prime audio context
      try { await exMetro._ensureContext(); } catch {}
    }
  });
  on(els.btnMicToggle, "click", async () => {
    try {
      if (micRaf) stopMic();
      else await startMic();
    } catch (err) {
      stopMic();
      showDialog("无法开启麦克风", `请检查浏览器麦克风权限。<br/><br/>错误：${String(err && err.message ? err.message : err)}`, { showClose: true });
    }
  });

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

  on(els.btnAutoScroll, "click", () => {
    setAutoScroll(!autoScrollOn);
    updateScrollPresetsUi();
  });

  on(els.scrollPresetSlow, "click", () => applyScrollPreset("slow"));
  on(els.scrollPresetNormal, "click", () => applyScrollPreset("normal"));
  on(els.scrollPresetFast, "click", () => applyScrollPreset("fast"));

  on(els.scrollSpeed, "input", () => {
    if (!els.scrollSpeed || !els.scrollSpeedText) return;
    els.scrollSpeedText.textContent = Number(els.scrollSpeed.value).toFixed(2).replace(/\.00$/, "");
    // User manually adjusted: stop following presets.
    if (activeScrollPreset) setActiveScrollPreset(null);
  });
  on(els.btnScrollStop, "click", () => setAutoScroll(false));
  on(els.btnScrollTop, "click", () => (getDetailScrollEl().scrollTop = 0));
  on(els.btnScrollBottom, "click", () => (getDetailScrollEl().scrollTop = getDetailScrollEl().scrollHeight));

  // Metronome
  metro.onTick = (_beatIndex, isAccent) => pulseTick(isAccent);
  on(els.btnMetronome, "click", () => setMetronomeUiOpen(!!(els.metronomeControls && els.metronomeControls.hidden)));

  on(els.metroBpm, "input", () => {
    if (!els.metroBpm || !els.metroBpmText) return;
    els.metroBpmText.textContent = els.metroBpm.value;
    metro.setTempo(Number(els.metroBpm.value));
    if (els.metroFloatText) els.metroFloatText.textContent = `节拍器 ${els.metroBpm.value}`;
    localStorage.setItem("metroBpm", String(els.metroBpm.value));
    updateScrollPresetsUi();
  });

  on(els.metroBeats, "change", () => {
    if (!els.metroBeats) return;
    metro.setBeatsPerBar(Number(els.metroBeats.value));
    localStorage.setItem("metroBeats", String(els.metroBeats.value));
    updateScrollPresetsUi();
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
      if (!els.metroBpm || !els.metroBpmText) return;
      els.metroBpm.value = String(clamped);
      els.metroBpmText.textContent = String(clamped);
      metro.setTempo(clamped);
      if (els.metroFloatText) els.metroFloatText.textContent = `节拍器 ${clamped}`;
      localStorage.setItem("metroBpm", String(clamped));
      updateScrollPresetsUi();
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
  updateScrollPresetsUi();

  loadPlans();
  renderPractice();

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
