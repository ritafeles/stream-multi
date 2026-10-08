// ===== Constants & State =====
// YouTube Data API v3 のキーはブラウザ(localStorage)に保存され、画面右上の⚙から入力します。
// 設定すると各枠に同時視聴者数が表示されます。未設定なら視聴者数機能は無効。
const YT_API_KEY_STORAGE = 'ymv_yt_api_key';
let ytApiKey = '';
try { ytApiKey = localStorage.getItem(YT_API_KEY_STORAGE) || ''; } catch (e) {}
const VIEWER_POLL_MS = 60000;   // 視聴者数の更新間隔（ミリ秒）
const PLAYBACK_WATCH_MS = 5000;
const PLAYBACK_STALL_MS = 15000;
const MAX_RECOVERY_DELAY_MS = 30000;
const ENDED_RECOVERY_DELAYS = [5000, 10000, 20000, 40000, 80000, 120000];
const MAX_SLOTS = 16;
const STORAGE_KEY = 'ymv_state_v3';
// v2: slot.volume は「枠の音量 0〜100」、実際の音量 = 枠の音量 × マスター音量 / 100
const VOLUME_MODEL = 2;
const DEFAULT_SLOT_VOLUME = 100;
const TOOLBAR_HIDDEN_STORAGE = 'ymv_toolbar_hidden';
// ポップアウト子ウィンドウ（?popout=1）ではメインの保存状態を上書きしない
const IS_POPOUT = new URLSearchParams(location.search).has('popout');
const state = {
  slots: [],           // fixed-length per layout; each slot is a frame
  layout: '4',
  focusedId: null,
  soloMode: false,
  masterVolume: 20,
  ytApiReady: false,
  twitchApiReady: false,
  pendingPlayers: [],
  fallbackMode: false,
};

// ===== Twitch parents (must include this page's hostname) =====
function getTwitchParents() {
  const set = new Set();
  if (location.hostname) set.add(location.hostname);
  set.add('localhost');
  set.add('127.0.0.1');
  return Array.from(set).filter(Boolean);
}
const TWITCH_PARENTS = getTwitchParents();

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const main = $('main');
const countLabel = $('countLabel');
const toast = $('toast');

function setToolbarHidden(hidden, persist = true) {
  const app = $('app');
  if (!app) return;
  app.classList.toggle('toolbar-hidden', hidden);
  $('hideToolbarBtn').setAttribute('aria-expanded', String(!hidden));
  $('showToolbarBtn').setAttribute('aria-expanded', String(!hidden));
  if (persist) {
    try { localStorage.setItem(TOOLBAR_HIDDEN_STORAGE, hidden ? '1' : '0'); } catch (e) {}
  }
}

function loadToolbarVisibility() {
  let hidden = false;
  try { hidden = localStorage.getItem(TOOLBAR_HIDDEN_STORAGE) === '1'; } catch (e) {}
  setToolbarHidden(hidden, false);
}

function apiErrorMessage(payload) {
  if (!payload || !payload.error) return null;
  if (typeof payload.error === 'string') return payload.error;
  return payload.error.message || '配信情報を取得できませんでした';
}

// ===== Embed environment =====
const IS_FILE_PROTOCOL = location.protocol === 'file:';
const HAS_VALID_ORIGIN = location.protocol === 'http:' || location.protocol === 'https:';
const IS_LOCAL_HOST = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

// サーバーの /api/* を呼ぶ。エラー時はサーバーが返した日本語メッセージを優先して投げる
async function fetchApi(path) {
  if (IS_FILE_PROTOCOL) {
    throw new Error('この機能は index.html を直接開いた状態では使えません。start.bat（または python server.py）で起動してください。');
  }
  let res;
  try {
    res = await fetch(path, { cache: 'no-store' });
  } catch (e) {
    throw new Error(IS_LOCAL_HOST
      ? `サーバーに接続できません（${location.origin}）。start.bat（または python server.py）が起動しているか確認してください。`
      : 'サーバーに接続できません。時間をおいて再度お試しください。');
  }
  let json = null;
  try { json = await res.json(); } catch (e) {}
  const apiError = apiErrorMessage(json);
  if (apiError) throw new Error(apiError);
  if (!res.ok || !json) throw new Error(`サーバーエラーが発生しました (HTTP ${res.status})`);
  return json;
}

// YouTube IFrame API
window.onYouTubeIframeAPIReady = () => {
  state.ytApiReady = !!(window.YT && window.YT.Player);
  flushPending();
};
(function loadYTApi() {
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  tag.onerror = () => console.warn('Failed to load YouTube IFrame API');
  document.head.appendChild(tag);
})();

// Twitch Embed API
(function loadTwitchApi() {
  const tag = document.createElement('script');
  tag.src = 'https://player.twitch.tv/js/embed/v1.js';
  tag.async = true;
  tag.onload = () => { state.twitchApiReady = true; flushPending(); };
  tag.onerror = () => console.warn('Failed to load Twitch Embed API');
  document.head.appendChild(tag);
})();

function flushPending() {
  const remaining = [];
  for (const fn of state.pendingPlayers) {
    if (fn() === false) remaining.push(fn);
  }
  state.pendingPlayers = remaining;
}

// Fallback after 6s if neither API has loaded
setTimeout(() => {
  if (!state.ytApiReady && !state.twitchApiReady && !state.fallbackMode) {
    enterFallbackMode('プレーヤーAPIが応答しません。簡易モードで動作します（一括操作は使えません）。');
  }
}, 6000);

function enterFallbackMode(msg) {
  if (state.fallbackMode) return;
  state.fallbackMode = true;
  showToast(msg, 'warn');
  ['playAllBtn','pauseAllBtn','syncBtn','muteAllBtn','unmuteAllBtn','soloBtn']
    .forEach(id => { const b = $(id); if (b) b.disabled = true; });
  renderGrid();
}

// ===== Layouts =====
const LAYOUTS = [
  { id: '1', cells: 1 }, { id: '2h', cells: 2 }, { id: '2v', cells: 2 },
  { id: '3', cells: 3 }, { id: '4', cells: 4 }, { id: '5', cells: 5 },
  { id: '6', cells: 6 }, { id: '8', cells: 8 }, { id: '9', cells: 9 },
  { id: '12', cells: 12 }, { id: '16', cells: 16 },
];
function layoutCells(id) { const l = LAYOUTS.find(x => x.id === id); return l ? l.cells : 4; }
function autoLayoutFor(n) {
  if (n <= 1) return '1'; if (n === 2) return '2h'; if (n === 3) return '3';
  if (n === 4) return '4'; if (n === 5) return '5'; if (n === 6) return '6';
  if (n <= 8) return '8'; if (n <= 9) return '9'; if (n <= 12) return '12'; return '16';
}

function makeCell() { const d = document.createElement('div'); d.className = 'cell'; return d; }
function renderLayoutTiles() {
  const el = $('layoutTiles');
  el.innerHTML = '';
  for (const l of LAYOUTS) {
    const t = document.createElement('button');
    t.className = 'layout-tile' + (state.layout === l.id ? ' active' : '');
    t.title = `${l.cells}枠`;
    t.dataset.id = l.id;
    if (l.id === '1') {
      t.style.gridTemplateColumns = '1fr'; t.appendChild(makeCell());
    } else if (l.id === '2h') {
      t.style.gridTemplateColumns = '1fr 1fr'; t.appendChild(makeCell()); t.appendChild(makeCell());
    } else if (l.id === '2v') {
      t.style.gridTemplateRows = '1fr 1fr'; t.appendChild(makeCell()); t.appendChild(makeCell());
    } else if (l.id === '3') {
      t.style.gridTemplateColumns = '2fr 1fr'; t.style.gridTemplateRows = '1fr 1fr';
      const big = makeCell(); big.style.gridRow = 'span 2'; t.appendChild(big);
      t.appendChild(makeCell()); t.appendChild(makeCell());
    } else if (l.id === '4') {
      t.style.gridTemplateColumns = '1fr 1fr'; t.style.gridTemplateRows = '1fr 1fr';
      for (let i = 0; i < 4; i++) t.appendChild(makeCell());
    } else if (l.id === '5') {
      t.style.gridTemplateColumns = '1fr 1fr 1fr'; t.style.gridTemplateRows = '2fr 1fr';
      const big = makeCell(); big.style.gridColumn = 'span 2'; t.appendChild(big);
      for (let i = 0; i < 4; i++) t.appendChild(makeCell());
    } else if (l.id === '6') {
      t.style.gridTemplateColumns = '1fr 1fr 1fr'; t.style.gridTemplateRows = '1fr 1fr';
      for (let i = 0; i < 6; i++) t.appendChild(makeCell());
    } else if (l.id === '8') {
      t.style.gridTemplateColumns = '1fr 1fr 1fr 1fr'; t.style.gridTemplateRows = '1fr 1fr';
      for (let i = 0; i < 8; i++) t.appendChild(makeCell());
    } else if (l.id === '9') {
      t.style.gridTemplateColumns = '1fr 1fr 1fr'; t.style.gridTemplateRows = '1fr 1fr 1fr';
      for (let i = 0; i < 9; i++) t.appendChild(makeCell());
    } else if (l.id === '12') {
      t.style.gridTemplateColumns = '1fr 1fr 1fr 1fr'; t.style.gridTemplateRows = '1fr 1fr 1fr';
      for (let i = 0; i < 12; i++) t.appendChild(makeCell());
    } else if (l.id === '16') {
      t.style.gridTemplateColumns = '1fr 1fr 1fr 1fr'; t.style.gridTemplateRows = '1fr 1fr 1fr 1fr';
      for (let i = 0; i < 16; i++) t.appendChild(makeCell());
    }
    t.addEventListener('click', () => setLayout(l.id));
    el.appendChild(t);
  }
}

// URL / ID の解析は assets/parse.js（parseEntry / parseInput / isValidStoredEntry）

// ===== Slot model =====
function uuid() { return Math.random().toString(36).slice(2, 10); }
function makeSlot() {
  return {
    id: uuid(),
    mode: 'video',            // 'video' | 'chat'
    type: null, kind: null, value: null, title: null,
    ready: false, muted: true, volume: DEFAULT_SLOT_VOLUME,
    player: null, audioPoll: null,
    chatSourceId: null,       // for mode 'chat': id of the source slot
    reconnectTimer: null, reconnectAttempts: 0,
    endedRecoveryAttempts: 0, resumeAt: null,
    playbackWatch: null, desiredPlaying: true, offline: false,
    recoveryStage: 0, lastProgressAt: 0, lastMediaTime: null,
    nextRecoveryAllowedAt: 0, isLive: false,
    ytAttachPending: false,
    audioSentAt: 0,           // アプリからプレーヤーへ音量を送った時刻（読み戻しの猶予判定用）
    ffTimer: null,            // 早送り(2倍速で追いつき)用ポーリング
  };
}
function isFilled(s) { return s.mode === 'video' && !!s.value; }
function chattable(s) {
  return isFilled(s) && (
    (s.type === 'youtube' && s.kind === 'video' && HAS_VALID_ORIGIN) ||
    (s.type === 'twitch' && s.kind === 'channel')
  );
}
function availableChatSources(exceptId) {
  return state.slots.filter(s => s.id !== exceptId && chattable(s));
}
// ポップアウト窓: メインウィンドウが保存した状態(localStorage)から配信を読み取り、
// チャット元として選べるようにする（同一オリジンなので直接読める）
function externalChatSources() {
  if (!IS_POPOUT) return [];
  let data = null;
  try { data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { return []; }
  if (!data || !Array.isArray(data.slots)) return [];
  const local = new Set(state.slots.filter(isFilled).map(s => `${s.type}:${s.kind}:${s.value}`));
  const seen = new Set();
  const out = [];
  for (const o of data.slots) {
    if (!o || o.mode !== 'video' || !o.value) continue;
    const ok = (o.type === 'youtube' && o.kind === 'video') || (o.type === 'twitch' && o.kind === 'channel');
    if (!ok) continue;
    const key = `${o.type}:${o.kind}:${o.value}`;
    if (seen.has(key) || local.has(key)) continue;
    seen.add(key);
    out.push({ id: 'ext:' + key, type: o.type, kind: o.kind, value: o.value, title: o.title || o.value });
  }
  return out;
}
function parseExtSourceId(id) {
  if (typeof id !== 'string' || !id.startsWith('ext:')) return null;
  const parts = id.slice(4).split(':');
  if (parts.length < 3) return null;
  return { type: parts[0], kind: parts[1], value: parts.slice(2).join(':') };
}
function slotSig(s) {
  if (s.mode === 'chat') return `chat:${s.chatSourceId || ''}`;
  if (isFilled(s)) return `video:${s.type}:${s.kind}:${s.value}`;
  return 'empty';
}
function defaultTitleFor(entry) {
  if (entry.type === 'twitch') {
    if (entry.kind === 'channel') return `Twitch: ${entry.value}`;
    if (entry.kind === 'vod') return `Twitch VOD: ${entry.value}`;
    if (entry.kind === 'clip') return `Twitch Clip: ${entry.value}`;
  }
  return entry.value;
}
function destroySlotPlayer(s) {
  if (!s) return;
  stopAudioPolling(s);
  clearInterval(s.playbackWatch); s.playbackWatch = null;
  clearInterval(s.ffTimer); s.ffTimer = null;
  clearTimeout(s.reconnectTimer); s.reconnectTimer = null; s.reconnectAttempts = 0;
  if (s.player && s.player.destroy) { try { s.player.destroy(); } catch (e) {} }
  s.player = null; s.ready = false;
  s.ytAttachPending = false;
}
function resetSlot(s) {
  destroySlotPlayer(s);
  s.mode = 'video'; s.type = null; s.kind = null; s.value = null; s.title = null;
  s.chatSourceId = null; s.muted = true;
  s.desiredPlaying = true; s.offline = false;
  s.endedRecoveryAttempts = 0; s.resumeAt = null;
}

// ===== Slot mutations =====
function isUsed(s) { return isFilled(s) || s.mode === 'chat'; }
function setLayout(id) {
  if (!LAYOUTS.some(l => l.id === id)) return;
  const need = layoutCells(id);
  if (need < state.slots.length) {
    // 使用中の枠が後ろにあれば前に詰めて、空き枠から先に削除する
    let slots = state.slots;
    if (slots.slice(need).some(isUsed)) slots = [...slots.filter(isUsed), ...slots.filter(s => !isUsed(s))];
    const removing = slots.slice(need);
    const lost = removing.filter(isUsed).length;
    if (lost > 0 && !confirm(`このレイアウトでは ${lost} 個の枠が削除されます。続けますか？`)) return;
    removing.forEach(destroySlotPlayer);
    state.slots = slots.slice(0, need);
  } else {
    while (state.slots.length < need) state.slots.push(makeSlot());
  }
  state.layout = id;
  renderLayoutTiles();
  renderGrid();
  save();
}

function applyEntryToSlot(s, e) {
  destroySlotPlayer(s);
  s.mode = 'video';
  s.type = e.type; s.kind = e.kind; s.value = e.value;
  s.title = e.title || defaultTitleFor(e);
  s.ready = false; s.muted = true; s.chatSourceId = null;
  s.desiredPlaying = true; s.offline = false; s.isLive = false;
  s.endedRecoveryAttempts = 0; s.resumeAt = null; s.viewers = undefined;
  if (typeof s.volume !== 'number') s.volume = DEFAULT_SLOT_VOLUME;
}
const INVALID_INPUT_MSG = '有効な URL / ID が見つかりません（YouTube の動画・チャンネル / Twitch のチャンネル・VOD・クリップに対応）';
// YouTube チャンネル指定（@handle / UC…）を、いま配信中の動画に置き換える
async function resolveEntries(entries) {
  const out = [];
  for (const e of entries) {
    if (e.type !== 'youtube' || e.kind !== 'live') { out.push(e); continue; }
    try {
      const json = await fetchApi(`/api/youtube-live?channel=${encodeURIComponent(e.value)}`);
      out.push({ type: 'youtube', kind: 'video', value: json.videoId, title: json.title || null });
    } catch (err) {
      showToast(`${e.value}: ${err.message}`, 'error');
    }
  }
  return out;
}
// meta.title: 配信一覧などで分かっているタイトル（1件目に適用）
async function fillSlot(id, raw, meta = {}) {
  const parsed = parseInput(raw);
  if (!parsed.length) { showToast(INVALID_INPUT_MSG, 'error'); return false; }
  const entries = await resolveEntries(parsed);
  const s = state.slots.find(x => x.id === id);
  if (!entries.length || !s) return false;
  if (meta.title && !entries[0].title) entries[0].title = meta.title;
  applyEntryToSlot(s, entries[0]);
  // extra pasted lines spill into remaining empty slots
  for (let i = 1; i < entries.length; i++) {
    const slot = state.slots.find(x => x.id !== id && !isFilled(x) && x.mode === 'video');
    if (!slot) break;
    applyEntryToSlot(slot, entries[i]);
  }
  renderGrid(); save(); fetchTitles(); fetchViewerCounts();
  return true;
}
async function fillFirstEmpty(raw) {
  const parsed = parseInput(raw);
  if (!parsed.length) { showToast(INVALID_INPUT_MSG, 'error'); return; }
  const entries = await resolveEntries(parsed);
  let placed = 0;
  for (const e of entries) {
    const slot = state.slots.find(s => !isFilled(s) && s.mode === 'video');
    if (!slot) { showToast('空き枠がありません', 'warn'); break; }
    applyEntryToSlot(slot, e);
    placed++;
  }
  if (placed) { renderGrid(); save(); fetchTitles(); fetchViewerCounts(); showToast(`${placed}件を空き枠に追加しました`, 'ok'); }
}
function reloadSlot(id) {
  const s = state.slots.find(x => x.id === id);
  if (!s || !isFilled(s)) return;
  s.endedRecoveryAttempts = 0;
  s.resumeAt = null;
  const el = document.querySelector(`.frame[data-id="${id}"]`);
  if (!el) return;
  destroySlotPlayer(s);
  const host = el.querySelector('.player-host');
  if (host) host.innerHTML = `<div id="player-${s.id}"></div>`;
  scheduleMount(s, el);
}
function emptySlot(id) {
  const s = state.slots.find(x => x.id === id);
  if (!s) return;
  const before = isFilled(s) ? { type: s.type, kind: s.kind, value: s.value, title: s.title } : null;
  const chatWatchers = state.slots.filter(o => o.mode === 'chat' && o.chatSourceId === id).map(o => o.id);
  resetSlot(s);
  state.slots.forEach(o => { if (o.mode === 'chat' && o.chatSourceId === id) o.chatSourceId = null; });
  if (state.focusedId === id) state.focusedId = null;
  renderGrid(); save();
  if (before) {
    showToast(`「${before.title || before.value}」を閉じました`, '', {
      label: '元に戻す',
      run: () => {
        const slot = state.slots.find(x => x.id === id);
        if (!slot || isUsed(slot)) { showToast('枠がすでに使われているため元に戻せません', 'warn'); return; }
        applyEntryToSlot(slot, before);
        state.slots.forEach(o => { if (chatWatchers.includes(o.id) && o.mode === 'chat' && !o.chatSourceId) o.chatSourceId = id; });
        renderGrid(); save(); fetchViewerCounts();
      },
    });
  }
}
function setSlotChat(id) {
  const s = state.slots.find(x => x.id === id);
  if (!s) return;
  destroySlotPlayer(s);
  s.mode = 'chat'; s.type = null; s.kind = null; s.value = null; s.title = null;
  const src = availableChatSources(id)[0] || externalChatSources()[0];
  s.chatSourceId = src ? src.id : null;
  renderGrid(); save();
  if (!src) showToast(IS_POPOUT
    ? 'メインウィンドウに配信を追加すると、その配信のチャットを選べます'
    : '他の枠に配信を追加すると、その配信のチャットを選べます', 'warn');
}
function setChatSource(id, sourceId) {
  const s = state.slots.find(x => x.id === id);
  if (!s) return;
  s.chatSourceId = sourceId || null;
  renderGrid(); save();
}
function swapSlots(aId, bId) {
  const a = state.slots.findIndex(s => s.id === aId);
  const b = state.slots.findIndex(s => s.id === bId);
  if (a < 0 || b < 0 || a === b) return;
  [state.slots[a], state.slots[b]] = [state.slots[b], state.slots[a]];
  renderGrid(); save();
}
function moveSlot(fromId, toId, after) {
  const from = state.slots.findIndex(s => s.id === fromId);
  if (from < 0) return;
  const [item] = state.slots.splice(from, 1);
  let to = state.slots.findIndex(s => s.id === toId);
  if (to < 0) { state.slots.splice(from, 0, item); return; }
  if (after) to += 1;
  state.slots.splice(to, 0, item);
  renderGrid(); save();
}
function focusSlot(id) {
  state.focusedId = state.focusedId === id ? null : id;
  if (state.soloMode) applySoloState();
  document.querySelectorAll('.frame.video').forEach(el => {
    el.classList.toggle('focused', el.dataset.id === state.focusedId);
  });
}

// ===== Title fetch (YouTube oEmbed only) =====
async function fetchTitles() {
  for (const s of state.slots) {
    if (!isFilled(s) || s.type !== 'youtube' || s.kind !== 'video') continue;
    if (s.title && s.title !== s.value) continue;
    try {
      const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${s.value}&format=json`);
      if (!r.ok) continue;
      const data = await r.json();
      if (data && data.title) {
        s.title = data.title;
        const titleEl = document.querySelector(`.frame[data-id="${s.id}"] .title-text`);
        if (titleEl) titleEl.textContent = data.title;
      }
    } catch (e) {}
  }
  refreshChatSelects();
  save();
}

// ===== Live viewer count (YouTube Data API v3) =====
let viewerTimer = null;

function applyLivePill(el, s) {
  if (!el) return;
  const cnt = el.querySelector('.live-count');
  if (s && typeof s.viewers === 'number') {
    if (cnt) cnt.textContent = s.viewers.toLocaleString('ja-JP');
    el.classList.add('has-live');
  } else {
    el.classList.remove('has-live');
  }
}
function updateLivePill(s) {
  const el = document.querySelector(`.frame[data-id="${s.id}"]`);
  applyLivePill(el, s);
}

// YouTube Data API（キー設定時）→ ぶいみるの配信一覧（キー不要・Twitch も対応）の順に視聴者数を探す
let viewerKeyErrorShown = false;
let viewerFetching = false;
async function fetchYouTubeApiViewers(ids, counts) {
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${chunk.join(',')}&key=${encodeURIComponent(ytApiKey)}`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) {
      if ((r.status === 400 || r.status === 403) && !viewerKeyErrorShown) {
        viewerKeyErrorShown = true;   // 毎回出すとうるさいので1回だけ
        showToast('視聴者数の取得に失敗（⚙ で API キーを確認してください）', 'error');
      }
      return;
    }
    const data = await r.json();
    (data.items || []).forEach(it => {
      const cv = it.liveStreamingDetails && it.liveStreamingDetails.concurrentViewers;
      const n = cv != null ? parseInt(cv, 10) : NaN;
      if (!isNaN(n)) counts.set(entryKey({ type: 'youtube', kind: 'video', value: it.id }), n);
    });
  }
}
async function fetchListedViewers(counts) {
  const json = await fetchApi('/api/vmiru-streams');
  (json.streams || []).forEach(stream => {
    const e = parseEntry(stream.url);
    if (!e || typeof stream.viewers !== 'number') return;
    const key = entryKey(e);
    if (!counts.has(key)) counts.set(key, stream.viewers);
  });
}
async function fetchViewerCounts() {
  if (document.hidden || viewerFetching) return;
  const vids = state.slots.filter(s => isFilled(s) && (s.type === 'youtube' || s.kind === 'channel'));
  if (!vids.length) return;
  viewerFetching = true;
  const counts = new Map();
  try {
    if (ytApiKey) {
      const ids = [...new Set(vids.filter(s => s.type === 'youtube').map(s => s.value))];
      try { await fetchYouTubeApiViewers(ids, counts); } catch (e) {}
    }
    if (HAS_VALID_ORIGIN && vids.some(s => !counts.has(entryKey(s)))) {
      try { await fetchListedViewers(counts); } catch (e) {}
    }
  } finally {
    viewerFetching = false;
  }
  vids.forEach(s => {
    const v = counts.get(entryKey(s));
    s.viewers = typeof v === 'number' ? v : undefined;
    updateLivePill(s);
  });
}
function startViewerPolling() {
  clearInterval(viewerTimer);
  state.slots.forEach(s => { s.viewers = undefined; updateLivePill(s); });
  fetchViewerCounts();
  viewerTimer = setInterval(fetchViewerCounts, VIEWER_POLL_MS);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchViewerCounts(); });

// ===== Helpers =====
function externalUrlFor(s) {
  if (s.type === 'youtube') return `https://www.youtube.com/watch?v=${s.value}`;
  if (s.type === 'twitch') {
    if (s.kind === 'vod') return `https://www.twitch.tv/videos/${s.value}`;
    if (s.kind === 'clip') return `https://clips.twitch.tv/${s.value}`;
    return `https://www.twitch.tv/${s.value}`;
  }
  return '#';
}
function badgeText(s) {
  if (s.type === 'youtube') return 'YT';
  if (s.type === 'twitch') return s.kind === 'vod' ? 'TW VOD' : s.kind === 'clip' ? 'TW CLIP' : 'TW';
  return '';
}
function chatSrcFor(s) {
  if (s.type === 'youtube') {
    return `https://www.youtube.com/live_chat?v=${encodeURIComponent(s.value)}&embed_domain=${encodeURIComponent(location.hostname)}&dark_theme=1`;
  }
  if (s.type === 'twitch') {
    const parents = TWITCH_PARENTS.map(p => `parent=${encodeURIComponent(p)}`).join('&');
    return `https://www.twitch.tv/embed/${encodeURIComponent(s.value)}/chat?darkpopout&${parents}`;
  }
  return '';
}

// ===== Rendering =====
function renderGrid() {
  // prune dangling chat references（ext: はメインウィンドウ由来なのでそのまま維持）
  state.slots.forEach(s => {
    if (s.mode === 'chat' && s.chatSourceId && !s.chatSourceId.startsWith('ext:')) {
      const src = state.slots.find(x => x.id === s.chatSourceId);
      if (!src || !chattable(src)) s.chatSourceId = null;
    }
  });

  main.className = `layout-${state.layout}`;

  const existingMap = new Map();
  Array.from(main.children).forEach(c => { if (c.dataset.id) existingMap.set(c.dataset.id, c); });

  const reusedIds = new Set();
  const newEls = state.slots.map((s, i) => {
    const old = existingMap.get(s.id);
    let el;
    if (old && old.dataset.sig === slotSig(s)) {
      el = old;
      reusedIds.add(s.id);
      updateFrameMeta(el, s, i);
    } else {
      el = createFrameEl(s, i);
    }
    el.classList.toggle('focused', state.focusedId === s.id && isFilled(s));
    return el;
  });

  // Remove stale elements first (changed sig or no longer in slots)
  existingMap.forEach((el, id) => { if (!reusedIds.has(id)) el.remove(); });

  // Reorder/insert using insertBefore so existing video iframes are never
  // detached from the document (detach → re-attach causes iframe reload)
  newEls.forEach((el, i) => {
    const ref = main.children[i];
    if (ref !== el) main.insertBefore(el, ref || null);
  });

  refreshChatSelects();
  const filled = state.slots.filter(isFilled).length;
  countLabel.textContent = `${filled} / ${state.slots.length} 枠`;
}

function createFrameEl(s, i) {
  if (s.mode === 'chat') return buildChatFrame(s);
  if (isFilled(s)) return buildVideoFrame(s);
  return buildEmptyFrame(s, i);
}

function updateFrameMeta(el, s, i) {
  if (s.mode === 'video' && isFilled(s)) {
    const t = el.querySelector('.title-text');
    if (t) t.textContent = s.title || s.value;
  } else if (s.mode === 'video') {
    const n = el.querySelector('.slot-index');
    if (n) n.textContent = `枠 ${i + 1}`;
  }
}

function buildEmptyFrame(s, i) {
  const el = document.createElement('div');
  el.className = 'frame empty';
  el.dataset.id = s.id;
  el.dataset.sig = 'empty';
  el.innerHTML = `
    <div class="empty-inner">
      <div class="slot-index">枠 ${i + 1}</div>
      <form class="slot-form">
        <input class="slot-url" type="text" placeholder="YouTube / Twitch の URL・ID・@チャンネル" aria-label="枠 ${i + 1} に表示する URL" autocomplete="off" spellcheck="false">
        <button type="submit">表示</button>
      </form>
      <button class="slot-chat-toggle" type="button">💬 この枠にチャットを表示</button>
      <button class="nijisanji-btn" type="button">🔴 にじさんじ配信を追加</button>
      <button class="ikioi-btn" type="button">🔥 勢いランキングから追加</button>
      <button class="vmiru-btn" type="button">📺 ぶいみるから追加</button>
      <button class="slot-popout-btn" type="button">⧉ この枠を別ウィンドウで開く</button>
    </div>`;
  const form = el.querySelector('.slot-form');
  const input = el.querySelector('.slot-url');
  form.addEventListener('submit', e => {
    e.preventDefault();
    const val = input.value.trim();
    if (val) fillSlot(s.id, val);
  });
  el.querySelector('.slot-chat-toggle').addEventListener('click', () => setSlotChat(s.id));
  el.querySelector('.nijisanji-btn').addEventListener('click', () => openNijisanjiPanel(s.id));
  el.querySelector('.ikioi-btn').addEventListener('click', () => openIkioiPanel(s.id));
  el.querySelector('.vmiru-btn').addEventListener('click', () => openVmiruPanel(s.id));
  el.querySelector('.slot-popout-btn').addEventListener('click', () => popoutFrame(s.id));
  attachDropTarget(el, s.id, 'swap');
  return el;
}

// 枠のドラッグ＆ドロップ: 配信中の枠へは挿入、空き枠・チャット枠へは入れ替え。
// 空き枠に URL をドロップした場合はその枠に表示する。
function attachDropTarget(el, id, mode) {
  el.addEventListener('dragover', e => {
    if (e.dataTransfer.types.includes('text/plain') || e.dataTransfer.types.includes('text/uri-list')) {
      e.preventDefault(); el.classList.add('drop-target');
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', e => {
    el.classList.remove('drop-target');
    const data = e.dataTransfer.getData('text/plain');
    if (data && data.startsWith('slot:')) {
      e.preventDefault(); e.stopPropagation();
      const fromId = data.slice(5);
      if (fromId === id) return;
      if (mode === 'swap') { swapSlots(fromId, id); return; }
      const r = el.getBoundingClientRect();
      moveSlot(fromId, id, (e.clientX - r.left) > r.width / 2);
      return;
    }
    const slot = state.slots.find(x => x.id === id);
    const text = e.dataTransfer.getData('text/uri-list') || data;
    if (text && slot && !isUsed(slot)) {
      e.preventDefault(); e.stopPropagation();
      fillSlot(id, text);
    }
  });
}

function buildVideoFrame(s) {
  const el = document.createElement('div');
  el.className = `frame video platform-${s.type}`;
  el.dataset.id = s.id;
  el.dataset.sig = slotSig(s);
  el.innerHTML = `
    <div class="drag-handle" draggable="true" title="ドラッグで並び替え"></div>
    <div class="live-pill" title="同時視聴者数 / 時刻"><span class="live-viewers"><span class="live-dot"></span><span class="live-count"></span></span><span class="live-clock"></span></div>
    <div class="player-host"><div id="player-${s.id}"></div></div>
    <div class="header">
      <span class="badge"></span>
      <span class="title-text"></span>
      <button class="head-btn extlink" title="元のページで開く" aria-label="元のページで開く">↗</button>
      <button class="head-btn popout" title="別ウィンドウにポップアウト" aria-label="別ウィンドウにポップアウト">⧉</button>
      <button class="head-btn reload" title="再読み込み" aria-label="再読み込み">↺</button>
      <button class="head-btn remove" title="この枠を空にする (Del)" aria-label="この枠を空にする">×</button>
    </div>
    <div class="footer">
      <button class="pill mute-pill" title="ミュート切替" aria-label="ミュート切替">🔇</button>
      <input type="range" class="vol-mini" min="0" max="100" value="${s.volume}" title="この枠の音量" aria-label="この枠の音量">
      <span style="flex:1"></span>
      <button class="pill restart-pill" title="先頭から" aria-label="先頭から再生">⏮</button>
      <button class="pill ff-pill" title="2倍速でライブ最新に追いつく" aria-label="2倍速でライブ最新に追いつく">⏩</button>
      <button class="pill play-pill" title="再生/停止" aria-label="再生/停止">▶</button>
    </div>`;
  el.querySelector('.badge').textContent = badgeText(s);
  el.querySelector('.title-text').textContent = s.title || s.value;
  updateLivePills(el, s);
  el.querySelector('.live-clock').textContent = nowTimeStr();
  applyLivePill(el, s);

  el.querySelector('.remove').addEventListener('click', e => { e.stopPropagation(); emptySlot(s.id); });
  el.querySelector('.extlink').addEventListener('click', e => { e.stopPropagation(); window.open(externalUrlFor(s), '_blank', 'noopener'); });
  el.querySelector('.popout').addEventListener('click', e => { e.stopPropagation(); popoutFrame(s.id); });
  el.querySelector('.reload').addEventListener('click', e => { e.stopPropagation(); reloadSlot(s.id); });
  el.querySelector('.mute-pill').addEventListener('click', e => { e.stopPropagation(); toggleMute(s.id); });
  el.querySelector('.play-pill').addEventListener('click', e => { e.stopPropagation(); togglePlay(s.id); });
  el.querySelector('.restart-pill').addEventListener('click', e => { e.stopPropagation(); seek(s.id, 0); playOne(s.id); });
  el.querySelector('.ff-pill').addEventListener('click', e => { e.stopPropagation(); toggleFastForward(s.id); });
  el.querySelector('.vol-mini').addEventListener('input', e => { e.stopPropagation(); setVolume(s.id, parseInt(e.target.value, 10)); });
  el.addEventListener('click', () => focusSlot(s.id));

  const handle = el.querySelector('.drag-handle');
  handle.addEventListener('dragstart', e => {
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'slot:' + s.id);
  });
  handle.addEventListener('dragend', () => el.classList.remove('dragging'));
  attachDropTarget(el, s.id, 'insert');

  el.addEventListener('wheel', e => {
    if (e.target.closest('.player-host')) return;
    e.preventDefault();
    const slot = state.slots.find(x => x.id === s.id);
    if (!slot) return;
    const newVol = Math.max(0, Math.min(100, slot.volume + (e.deltaY < 0 ? 1 : -1)));
    setVolume(s.id, newVol);
    const slider = el.querySelector('.vol-mini');
    if (slider) slider.value = newVol;
  }, { passive: false });

  scheduleMount(s, el);
  return el;
}

// ⏮ は先頭に戻れるものだけ、⏩ は YouTube ライブだけに表示
function updateLivePills(el, s) {
  if (!el) return;
  el.querySelector('.restart-pill').style.display = Adapter.canSeek(s) ? '' : 'none';
  el.querySelector('.ff-pill').style.display = (s.type === 'youtube' && s.isLive) ? '' : 'none';
}

function buildChatFrame(s) {
  const el = document.createElement('div');
  el.className = 'frame chat-frame';
  el.dataset.id = s.id;
  el.dataset.sig = slotSig(s);
  el.innerHTML = `
    <div class="chat-head">
      <span class="chat-badge">💬 CHAT</span>
      <select class="chat-source" title="チャットを表示する配信を選択" aria-label="チャットを表示する配信"></select>
      <button class="head-btn remove" title="この枠を空にする" aria-label="この枠を空にする">×</button>
    </div>
    <div class="chat-body"></div>`;
  const sel = el.querySelector('.chat-source');
  populateChatSelect(sel, s);
  sel.addEventListener('change', () => setChatSource(s.id, sel.value));
  el.querySelector('.remove').addEventListener('click', () => emptySlot(s.id));
  attachDropTarget(el, s.id, 'swap');

  const body = el.querySelector('.chat-body');
  const ext = parseExtSourceId(s.chatSourceId);
  const src = (!ext && s.chatSourceId) ? state.slots.find(x => x.id === s.chatSourceId) : null;
  const chatTarget = ext || ((src && chattable(src)) ? src : null);
  if (chatTarget) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-clip-wrap';
    const iframe = document.createElement('iframe');
    iframe.src = chatSrcFor(chatTarget);
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    wrap.appendChild(iframe);
    body.appendChild(wrap);
  } else {
    const m = document.createElement('div');
    m.className = 'chat-empty';
    m.textContent = (availableChatSources(s.id).length || externalChatSources().length)
      ? '上のメニューから、チャットを表示する配信を選んでください'
      : (IS_POPOUT
        ? 'メインウィンドウに YouTube ライブ / Twitch チャンネルを追加すると、ここにそのチャットを表示できます'
        : '他の枠に YouTube ライブ / Twitch チャンネルを追加すると、ここにそのチャットを表示できます');
    body.appendChild(m);
  }
  return el;
}

function populateChatSelect(sel, s) {
  const sources = availableChatSources(s.id);
  const externals = externalChatSources();
  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = (sources.length || externals.length) ? '配信を選択…' : '（他の枠に配信がありません）';
  sel.appendChild(ph);
  sources.forEach(src => {
    const o = document.createElement('option');
    o.value = src.id;
    o.textContent = src.title || src.value;
    sel.appendChild(o);
  });
  externals.forEach(src => {
    const o = document.createElement('option');
    o.value = src.id;
    o.textContent = '[メイン] ' + (src.title || src.value);
    sel.appendChild(o);
  });
  const valid = s.chatSourceId &&
    (sources.some(x => x.id === s.chatSourceId) || externals.some(x => x.id === s.chatSourceId));
  sel.value = valid ? s.chatSourceId : '';
}
function refreshChatSelects() {
  state.slots.forEach(s => {
    if (s.mode !== 'chat') return;
    const sel = main.querySelector(`.frame[data-id="${s.id}"] .chat-source`);
    if (sel) populateChatSelect(sel, s);
  });
}

// ===== Frame pop-out =====
// 枠そのものをアプリの1枠レイアウトとして別ウィンドウで開く（空枠でも可）。
// ブロックされた場合、配信中の枠はアプリ内フローティングパネルにフォールバック。
function openPopoutWindow(data, name) {
  let hash = '';
  try { hash = encodeState(data); } catch (e) {}
  const url = location.pathname + '?popout=1#' + hash;
  let win = null;
  try { win = window.open(url, name, 'width=980,height=620,resizable=yes'); } catch (e) {}
  if (win) { try { win.focus(); } catch (e) {} return; }
  // window.open がブロックされた場合: 実リンクのクリックはブロックされないため
  // アンカー経由で新しいタブとして開く（タブをドラッグすれば別ウィンドウにできる）
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast('ポップアップがブロックされたため新しいタブで開きました（タブをドラッグすると別ウィンドウにできます）', 'warn');
}
function popoutFrame(id) {
  const s = state.slots.find(x => x.id === id);
  if (!s || s.mode !== 'video') return;
  openPopoutWindow({
    slots: [{
      mode: 'video',
      type: s.type, kind: s.kind, value: s.value, title: s.title,
      muted: s.muted, volume: s.volume, chatIndex: null,
    }],
    layout: '1',
    masterVolume: state.masterVolume,
    volumeModel: VOLUME_MODEL,
  }, 'slotpop_' + s.id);
}
// ツールバーから: 新しい空枠を別ウィンドウで開く
function popoutNewFrame() {
  openPopoutWindow({
    slots: [{ mode: 'video', type: null, kind: null, value: null, title: null, muted: true, volume: DEFAULT_SLOT_VOLUME, chatIndex: null }],
    layout: '1',
    masterVolume: state.masterVolume,
    volumeModel: VOLUME_MODEL,
  }, 'slotpop_new_' + uuid());
}

// ===== Player mounting =====
function scheduleMount(s, el) {
  if (state.fallbackMode) { mountFallbackIframe(s, el); return; }
  const tryMount = () => {
    if (!isFilled(s)) return true;
    if (s.type === 'youtube') {
      mountYouTubePlayer(s, el);
      return true;
    }
    if (s.type === 'twitch') {
      if (s.kind === 'clip') { mountFallbackIframe(s, el); return true; }
      if (state.twitchApiReady && window.Twitch && window.Twitch.Player) {
        setTimeout(() => { if (el.isConnected && isFilled(s)) mountTwitchPlayer(s, el); }, 0);
        return true;
      }
      return false;
    }
    return true;
  };
  if (!tryMount()) {
    state.pendingPlayers.push(tryMount);
    setTimeout(() => {
      if (!el.isConnected || !isFilled(s)) return;
      const host = el.querySelector('.player-host');
      if (host && host.querySelector('iframe')) return;
      console.warn('[player] API player did not create an iframe; using fallback', s.type, s.value);
      mountFallbackIframe(s, el);
    }, 6000);
  }
}

function resetPlaybackProgress(s, mediaTime = null) {
  const recovered = s.recoveryStage > 0;
  s.lastProgressAt = Date.now();
  s.lastMediaTime = mediaTime;
  s.recoveryStage = 0;
  s.reconnectAttempts = 0;
  s.nextRecoveryAllowedAt = 0;
  if (s.endedRecoveryAttempts > 0 && Number.isFinite(mediaTime) &&
      (!Number.isFinite(s.resumeAt) || mediaTime > s.resumeAt + 5)) {
    console.info('[recovery] ended stream resumed', s.type, s.value);
    s.endedRecoveryAttempts = 0;
    s.resumeAt = null;
  }
  if (recovered) console.info('[recovery] playback resumed', s.type, s.value);
}

function scheduleYouTubeEndedRecovery(s, player) {
  if (!s || !isFilled(s) || !s.desiredPlaying) return;
  const attempt = s.endedRecoveryAttempts || 0;
  if (attempt >= ENDED_RECOVERY_DELAYS.length) {
    s.desiredPlaying = false;
    showToast('配信の再開を確認できませんでした。↺で再読み込みできます', 'warn');
    return;
  }

  let current = null;
  try { current = player.getCurrentTime(); } catch (e) {}
  if (Number.isFinite(current) && current > 1) s.resumeAt = Math.max(0, current - 1);

  const delay = ENDED_RECOVERY_DELAYS[attempt];
  s.endedRecoveryAttempts = attempt + 1;
  clearTimeout(s.reconnectTimer);
  console.warn('[recovery] YouTube ended; scheduling live-stream recheck', {
    value: s.value, attempt: s.endedRecoveryAttempts, delay,
  });
  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = null;
    if (!isFilled(s) || !s.desiredPlaying) return;
    recreatePlayer(s, 'YouTube ended; checking whether the live stream resumed');
  }, delay);
}

function recreatePlayer(s, reason) {
  if (!s || !isFilled(s)) return;
  const el = document.querySelector(`.frame[data-id="${s.id}"]`);
  if (!el) return;
  const attempts = s.reconnectAttempts + 1;
  const delay = Math.min(3000 * (1 << Math.min(attempts - 1, 4)), MAX_RECOVERY_DELAY_MS);
  console.warn('[recovery] recreating player', { platform: s.type, value: s.value, reason, attempt: attempts, delay });
  showToast(`${s.type === 'youtube' ? 'YouTube' : 'Twitch'} の再生を復旧しています`, 'warn');
  destroySlotPlayer(s);
  s.desiredPlaying = true;
  s.reconnectAttempts = attempts;
  s.recoveryStage = 0;
  s.lastProgressAt = Date.now();
  s.lastMediaTime = null;
  s.nextRecoveryAllowedAt = Date.now() + delay;
  const host = el.querySelector('.player-host');
  if (host) host.innerHTML = `<div id="player-${s.id}"></div>`;
  scheduleMount(s, el);
}

function playbackLooksStalled(s) {
  if (!s.player || !s.ready || !s.desiredPlaying || s.offline) return false;
  if (s.type === 'youtube') {
    try {
      const stateCode = s.player.getPlayerState();
      if (stateCode === YT.PlayerState.PAUSED || stateCode === YT.PlayerState.CUED) return false;
      const t = s.player.getCurrentTime();
      if (Number.isFinite(t) && (s.lastMediaTime == null || t > s.lastMediaTime + 0.25)) {
        resetPlaybackProgress(s, t);
        return false;
      }
    } catch (e) { return false; }
  } else if (s.type === 'twitch') {
    try {
      if (s.player.isPaused()) return false;
      const stats = s.player.getPlaybackStats ? s.player.getPlaybackStats() : null;
      if (stats && (Number(stats.bufferSize) > 0.1 || Number(stats.playbackRate) > 0)) {
        resetPlaybackProgress(s);
        return false;
      }
    } catch (e) { return false; }
  }
  return Date.now() - s.lastProgressAt >= PLAYBACK_STALL_MS;
}

function startPlaybackWatch(s) {
  clearInterval(s.playbackWatch);
  s.lastProgressAt = Date.now();
  s.playbackWatch = setInterval(() => {
    if (Date.now() < s.nextRecoveryAllowedAt || !playbackLooksStalled(s)) return;
    if (s.recoveryStage === 0) {
      s.recoveryStage = 1;
      s.lastProgressAt = Date.now();
      console.warn('[recovery] stalled; requesting play', s.type, s.value);
      Adapter.play(s, true);
    } else {
      recreatePlayer(s, 'playback stalled after play request');
    }
  }, PLAYBACK_WATCH_MS);
}

function ytErrorMessage(code) {
  switch (code) {
    case 2:   return '無効な動画IDです';
    case 5:   return 'HTML5プレーヤーで再生できません';
    case 100: return '動画が見つかりません（削除/非公開）';
    case 101:
    case 150: return 'この動画は埋め込みが許可されていません';
    default:  return `読み込みエラー (code ${code})`;
  }
}

function mountYouTubePlayer(s, el) {
  const host = el.querySelector(`#player-${s.id}`);
  if (!host) return;
  const playerVars = { autoplay: 1, mute: 1, playsinline: 1, rel: 0, modestbranding: 1, enablejsapi: 1 };
  if (HAS_VALID_ORIGIN) playerVars.origin = location.origin;
  if (Number.isFinite(s.resumeAt) && s.resumeAt > 0) playerVars.start = Math.floor(s.resumeAt);
  const params = new URLSearchParams(playerVars);
  host.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.id = `yt-frame-${s.id}`;
  iframe.src = `https://www.youtube.com/embed/${encodeURIComponent(s.value)}?${params}`;
  iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen';
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  iframe.allowFullscreen = true;
  host.appendChild(iframe);
  if (!(window.YT && window.YT.Player)) {
    if (!s.ytAttachPending) {
      s.ytAttachPending = true;
      state.pendingPlayers.push(() => {
        if (!isFilled(s) || !el.isConnected) { s.ytAttachPending = false; return true; }
        if (!(window.YT && window.YT.Player)) return false;
        s.ytAttachPending = false;
        mountYouTubePlayer(s, el);
        return true;
      });
    }
    return;
  }
  try {
    s.player = new YT.Player(iframe, {
      events: {
        onReady: (e) => {
          s.ready = true;
          s.offline = false;
          try { const data = e.target.getVideoData(); s.isLive = !!(data && data.isLive); } catch (err) {}
          updateLivePills(document.querySelector(`.frame[data-id="${s.id}"]`), s);
          markAudioSent(s);
          try { if (s.muted) e.target.mute(); else e.target.unMute(); e.target.setVolume(effectiveVolume(s)); } catch (err) {}
          updateMutePill(s.id);
          startAudioPolling(s);
          startPlaybackWatch(s);
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.PLAYING) {
            s.desiredPlaying = true;
            updatePlayPill(s.id, true);
            clearTimeout(s.reconnectTimer); s.reconnectTimer = null;
            let t = null;
            try { t = e.target.getCurrentTime(); } catch (err) {}
            resetPlaybackProgress(s, t);
          } else if (e.data === YT.PlayerState.PAUSED) {
            s.desiredPlaying = false;
            updatePlayPill(s.id, false);
          } else if (e.data === YT.PlayerState.ENDED) {
            updatePlayPill(s.id, false);
            scheduleYouTubeEndedRecovery(s, e.target);
          } else if (e.data === YT.PlayerState.BUFFERING || e.data === YT.PlayerState.UNSTARTED) {
            if (s.desiredPlaying && !s.lastProgressAt) s.lastProgressAt = Date.now();
          }
        },
        onError: (e) => {
          console.warn('YT error', e.data, s.value);
          if (e.data === 101 || e.data === 150) {
            showEmbedBlocked(s.id);
          } else {
            showVideoError(s.id, ytErrorMessage(e.data));
          }
        },
      },
    });
  } catch (err) {
    console.error('Failed to create YT.Player, falling back to iframe', err);
    mountFallbackIframe(s, el);
  }
}

function mountTwitchPlayer(s, el) {
  const host = el.querySelector(`#player-${s.id}`);
  if (!host || !window.Twitch || !window.Twitch.Player) return;
  const options = {
    width: '100%', height: '100%', parent: TWITCH_PARENTS,
    autoplay: true, muted: s.muted,
  };
  if (s.kind === 'vod') options.video = s.value.startsWith('v') ? s.value : `v${s.value}`;
  else options.channel = s.value;
  try {
    s.player = new Twitch.Player(host.id, options);
    s.player.addEventListener(Twitch.Player.READY, () => {
      s.ready = true;
      s.offline = false;
      syncTwitchAudio(s);
      startAudioPolling(s);
      startPlaybackWatch(s);
    });
    s.player.addEventListener(Twitch.Player.PLAYING, () => {
      s.desiredPlaying = true;
      updatePlayPill(s.id, true);
      resetPlaybackProgress(s);
    });
    s.player.addEventListener(Twitch.Player.PAUSE, () => {
      s.desiredPlaying = false;
      updatePlayPill(s.id, false);
    });
    s.player.addEventListener(Twitch.Player.ENDED, () => {
      updatePlayPill(s.id, false);
      if (s.kind === 'vod') s.desiredPlaying = false;
      else if (s.desiredPlaying) s.lastProgressAt = Date.now() - PLAYBACK_STALL_MS;
    });
    s.player.addEventListener(Twitch.Player.ONLINE, () => {
      s.offline = false;
      if (s.desiredPlaying) { s.lastProgressAt = Date.now(); Adapter.play(s, true); }
    });
    s.player.addEventListener(Twitch.Player.OFFLINE, () => {
      s.offline = true;
      updatePlayPill(s.id, false);
      console.info('[recovery] Twitch channel is offline', s.value);
    });
    s.player.addEventListener(Twitch.Player.PLAYBACK_BLOCKED, () => {
      s.desiredPlaying = false;
      console.warn('[recovery] Twitch autoplay was blocked', s.value);
    });
  } catch (err) {
    console.error('Failed to create Twitch.Player, falling back to iframe', err);
    mountFallbackIframe(s, el);
  }
}

function mountFallbackIframe(s, el) {
  const host = el.querySelector('.player-host');
  if (!host) return;
  let src = '';
  if (s.type === 'youtube') {
    src = `https://www.youtube.com/embed/${encodeURIComponent(s.value)}?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1`;
  } else if (s.type === 'twitch') {
    const parents = TWITCH_PARENTS.map(p => `parent=${encodeURIComponent(p)}`).join('&');
    const muted = s.muted ? 'true' : 'false';
    if (s.kind === 'vod') src = `https://player.twitch.tv/?video=${encodeURIComponent(s.value)}&${parents}&muted=${muted}&autoplay=true`;
    else if (s.kind === 'clip') src = `https://clips.twitch.tv/embed?clip=${encodeURIComponent(s.value)}&autoplay=true&muted=${muted}&${parents}`;
    else src = `https://player.twitch.tv/?channel=${encodeURIComponent(s.value)}&${parents}&muted=${muted}&autoplay=true`;
  }
  host.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.src = src;
  iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen';
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  iframe.allowFullscreen = true;
  host.appendChild(iframe);
  s.ready = false; s.player = null;
}

function showEmbedBlocked(id) {
  const el = document.querySelector(`.frame[data-id="${id}"]`);
  if (!el) return;
  const s = state.slots.find(x => x.id === id);
  const url = s ? externalUrlFor(s) : '#';
  const thumb = s ? `https://img.youtube.com/vi/${encodeURIComponent(s.value)}/maxresdefault.jpg` : '';
  const host = el.querySelector('.player-host');
  if (host) {
    host.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.cssText = `position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
      justify-content:center;text-align:center;gap:12px;padding:20px;
      background:linear-gradient(rgba(0,0,0,0.55),rgba(0,0,0,0.75)) center/cover no-repeat;`;
    if (thumb) wrap.style.backgroundImage = `linear-gradient(rgba(0,0,0,0.55),rgba(0,0,0,0.75)), url(${JSON.stringify(thumb)})`;
    wrap.innerHTML = `
      <div style="font-size:13px;color:#eee;font-weight:500;text-shadow:0 1px 4px #000;">
        この動画はサイトへの埋め込みが制限されています
      </div>
      <a target="_blank" rel="noopener"
         style="display:inline-flex;align-items:center;gap:8px;padding:10px 20px;
                background:#ff0033;color:#fff;border-radius:6px;font-weight:700;
                font-size:14px;text-decoration:none;">
        ▶ YouTube で視聴する
      </a>`;
    wrap.querySelector('a').href = url;
    host.appendChild(wrap);
  }
  const titleEl = el.querySelector('.title-text');
  if (titleEl) titleEl.textContent = '[埋め込み制限]';
}

function showVideoError(id, msg) {
  const el = document.querySelector(`.frame[data-id="${id}"]`);
  if (!el) return;
  const s = state.slots.find(x => x.id === id);
  const label = s ? defaultTitleFor(s) : '';
  const url = s ? externalUrlFor(s) : '#';
  const host = el.querySelector('.player-host');
  if (host) {
    host.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#1a1a20;color:var(--text-dim);padding:20px;text-align:center;gap:10px;';
    wrap.innerHTML = `
      <div style="font-size:32px;">⚠️</div>
      <div style="font-size:13px;color:var(--text);"></div>
      <div style="font-size:11px;color:var(--text-muted);"></div>`;
    wrap.children[1].textContent = msg;
    wrap.children[2].textContent = label;
    const btn = document.createElement('button');
    btn.style.cssText = 'margin-top:8px;padding:6px 14px;background:var(--accent);color:#fff;border:0;border-radius:5px;cursor:pointer;font-size:12px;';
    btn.textContent = '元のページで開く';
    btn.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
    wrap.appendChild(btn);
    host.appendChild(wrap);
  }
  const titleEl = el.querySelector('.title-text');
  if (titleEl) titleEl.textContent = `[エラー] ${msg}`;
}

// ===== Volume =====
// 実際の音量 = 枠の音量 × マスター音量 / 100（0〜100）。枠ごとのバランスはマスターを動かしても保たれる
function slotVolume(s) { return Math.max(0, Math.min(100, Number.isFinite(s.volume) ? s.volume : DEFAULT_SLOT_VOLUME)); }
function effectiveVolumeExact(s) { return slotVolume(s) * state.masterVolume / 100; }
function effectiveVolume(s) {
  const v = effectiveVolumeExact(s);
  return v > 0 ? Math.max(1, Math.round(v)) : 0;   // YouTube は整数のみ。0 より大きければ最低 1
}

// ===== Player audio sync =====
// アプリ → プレーヤーに音量を送った直後は、プレーヤーから読み取れる値がまだ古いことがある
// （YouTube は postMessage 経由で非同期に反映される）。その間は読み取りをスキップする。
const AUDIO_SYNC_GRACE_MS = 1500;
function markAudioSent(s) { s.audioSentAt = Date.now(); }

function syncTwitchAudio(s, retry = true) {
  if (!s?.player || s.type !== 'twitch') return;
  const volume = effectiveVolumeExact(s);
  markAudioSent(s);
  try { s.player.setVolume(volume / 100); s.player.setMuted(s.muted || volume === 0); } catch (e) {}
  if (retry) { setTimeout(() => syncTwitchAudio(s, false), 150); setTimeout(() => syncTwitchAudio(s, false), 500); }
}
function readPlayerAudio(s) {
  if (s.type === 'youtube') return { muted: !!s.player.isMuted(), volume: Number(s.player.getVolume()), sent: effectiveVolume(s) };
  if (s.type === 'twitch') return { muted: !!s.player.getMuted(), volume: Number(s.player.getVolume()) * 100, sent: effectiveVolumeExact(s) };
  return null;
}
// プレーヤー上（YouTube / Twitch の音量バー・ミュートボタン）で直接操作された音量を枠の状態に反映し、
// リロード後も同じ音量で再生されるように保存する
function pollPlayerAudio(s) {
  if (!s?.player || !s.ready || Date.now() - (s.audioSentAt || 0) < AUDIO_SYNC_GRACE_MS) return;
  let audio;
  try { audio = readPlayerAudio(s); } catch (e) { return; }
  if (!audio || !Number.isFinite(audio.volume)) return;
  const playerVolume = Math.max(0, Math.min(100, audio.volume));
  let changed = false;
  // 音量 0 による自動ミュートは枠のミュート状態として扱わない
  if (audio.sent > 0 && audio.muted !== s.muted) { s.muted = audio.muted; updateMutePill(s.id); changed = true; }
  const slider = document.querySelector(`.frame[data-id="${s.id}"] .vol-mini`);
  if (state.masterVolume > 0 && document.activeElement !== slider && Math.abs(playerVolume - audio.sent) > 0.5) {
    const wanted = Math.round(playerVolume * 100 / state.masterVolume);
    s.volume = Math.min(100, wanted);
    if (slider) slider.value = s.volume;
    changed = true;
    if (wanted > 100) {
      // 枠の音量は最大 100（= マスター音量）。プレーヤー側も上限に合わせる
      Adapter.applyVolume(s);
      showToast('この枠の音量は最大です。もっと大きくするにはマスター音量を上げてください', 'warn');
    }
  }
  if (changed) save();
}
function startAudioPolling(s) {
  if (!s || s.audioPoll) return;
  s.audioPoll = setInterval(() => pollPlayerAudio(s), 700);
}
function stopAudioPolling(s) {
  if (!s?.audioPoll) return;
  clearInterval(s.audioPoll); s.audioPoll = null;
}

// ===== Player adapter =====
const Adapter = {
  play(s)  { s.desiredPlaying = true; if (!s.player || s.offline) return; try { if (s.type === 'youtube') s.player.playVideo(); else if (s.type === 'twitch') s.player.play(); } catch (e) {} },
  pause(s) { s.desiredPlaying = false; s.recoveryStage = 0; if (!s.player) return; try { if (s.type === 'youtube') s.player.pauseVideo(); else if (s.type === 'twitch') s.player.pause(); } catch (e) {} },
  mute(s)  { if (!s.player) return; markAudioSent(s); try { if (s.type === 'youtube') s.player.mute(); else if (s.type === 'twitch') syncTwitchAudio(s); } catch (e) {} },
  unmute(s){ if (!s.player) return; markAudioSent(s); try { if (s.type === 'youtube') s.player.unMute(); else if (s.type === 'twitch') syncTwitchAudio(s); } catch (e) {} },
  applyVolume(s) { if (!s.player) return; markAudioSent(s); try { if (s.type === 'youtube') s.player.setVolume(effectiveVolume(s)); else if (s.type === 'twitch') syncTwitchAudio(s); } catch (e) {} },
  seek(s, sec) { if (!s.player) return; try { if (s.type === 'youtube') s.player.seekTo(sec, true); else if (s.type === 'twitch') s.player.seek(sec); } catch (e) {} },
  setRate(s, rate) { if (!s.player) return; try { if (s.type === 'youtube' && s.player.setPlaybackRate) s.player.setPlaybackRate(rate); } catch (e) {} },
  getDuration(s) { if (!s.player) return null; try { if (s.player.getDuration) return s.player.getDuration(); } catch (e) {} return null; },
  getCurrentTime(s) {
    if (!s.player) return null;
    try {
      if (s.type === 'youtube' && s.player.getCurrentTime) return s.player.getCurrentTime();
      if (s.type === 'twitch' && s.player.getCurrentTime) return s.player.getCurrentTime();
    } catch (e) {}
    return null;
  },
  isPlaying(s) {
    if (!s.player) return false;
    try {
      if (s.type === 'youtube' && s.player.getPlayerState) return s.player.getPlayerState() === YT.PlayerState.PLAYING;
      if (s.type === 'twitch' && s.player.isPaused) return !s.player.isPaused();
    } catch (e) {}
    return false;
  },
  canSeek(s) {
    if (s.type === 'youtube') return s.kind === 'video' && !s.isLive;   // ライブで先頭に戻すと DVR の最初まで戻ってしまう
    if (s.type === 'twitch') return s.kind === 'vod' || s.kind === 'clip';
    return false;
  },
};

// ===== Per-frame controls =====
function updateMutePill(id) {
  const s = state.slots.find(x => x.id === id);
  const el = document.querySelector(`.frame[data-id="${id}"] .mute-pill`);
  if (!el || !s) return;
  el.textContent = s.muted ? '🔇' : '🔊';
  el.classList.toggle('muted-pill', s.muted);
}
function updatePlayPill(id, playing) {
  const el = document.querySelector(`.frame[data-id="${id}"] .play-pill`);
  if (el) el.textContent = playing ? '⏸' : '▶';
}
function toggleMute(id) {
  const s = state.slots.find(x => x.id === id);
  if (!s) return;
  s.muted = !s.muted;
  if (!s.muted && s.volume === 0) {
    s.volume = DEFAULT_SLOT_VOLUME;
    const slider = document.querySelector(`.frame[data-id="${s.id}"] .vol-mini`);
    if (slider) slider.value = s.volume;
  }
  s.muted ? Adapter.mute(s) : Adapter.unmute(s);
  if (!s.muted) Adapter.applyVolume(s);
  updateMutePill(id); save();
}
function setVolume(id, val) {
  const s = state.slots.find(x => x.id === id);
  if (!s) return;
  s.volume = val;
  if (val > 0 && s.muted) { s.muted = false; Adapter.unmute(s); updateMutePill(id); }
  else if (val === 0 && !s.muted) { s.muted = true; Adapter.mute(s); updateMutePill(id); }
  Adapter.applyVolume(s); save();
}
function seek(id, sec)    { const s = state.slots.find(x => x.id === id); if (s) Adapter.seek(s, sec); }
function playOne(id) {
  const s = state.slots.find(x => x.id === id);
  if (!s) return;
  s.endedRecoveryAttempts = 0;
  Adapter.play(s);
}
function togglePlay(id) {
  const s = state.slots.find(x => x.id === id);
  if (!s) return;
  if (Adapter.isPlaying(s)) Adapter.pause(s);
  else { s.endedRecoveryAttempts = 0; Adapter.play(s); }
}

// ===== Fast-forward (2x catch-up to live edge) =====
const FF_LIVE_THRESHOLD = 4;  // 残りこの秒数以内になったらライブ最新とみなす
function updateFfPill(id, active) {
  const el = document.querySelector(`.frame[data-id="${id}"] .ff-pill`);
  if (el) el.classList.toggle('active', active);
}
function stopFastForward(s) {
  if (!s) return;
  clearInterval(s.ffTimer); s.ffTimer = null;
  Adapter.setRate(s, 1);
  updateFfPill(s.id, false);
}
function toggleFastForward(id) {
  const s = state.slots.find(x => x.id === id);
  if (!s || !s.player) return;
  if (s.ffTimer) { stopFastForward(s); return; }   // トグルで解除
  Adapter.setRate(s, 2);
  Adapter.play(s);
  updateFfPill(id, true);
  s.ffTimer = setInterval(() => {
    const cur = Adapter.getCurrentTime(s);
    const dur = Adapter.getDuration(s);
    if (cur == null || dur == null || dur <= 0) return;
    if (dur - cur <= FF_LIVE_THRESHOLD) {
      stopFastForward(s);
      showToast('ライブ最新に追いつきました', 'ok');
    }
  }, 1000);
}

// ===== Bulk controls (operate on filled video slots) =====
function filledVideos() { return state.slots.filter(isFilled); }
function playAll()  { filledVideos().forEach(s => Adapter.play(s)); }
function pauseAll() { filledVideos().forEach(s => Adapter.pause(s)); }
function isAnyPlaying() { return filledVideos().some(s => Adapter.isPlaying(s)); }
function muteAll()   { filledVideos().forEach(s => { s.muted = true;  Adapter.mute(s);   updateMutePill(s.id); }); save(); }
function unmuteAll() { filledVideos().forEach(s => { s.muted = false; Adapter.unmute(s); updateMutePill(s.id); }); save(); }
function restartAll() { filledVideos().forEach(s => { if (Adapter.canSeek(s)) Adapter.seek(s, 0); Adapter.play(s); }); }
function syncSeek() {
  const list = filledVideos();
  const target = list.find(s => s.id === state.focusedId) || list.find(s => Adapter.canSeek(s));
  if (!target || !Adapter.canSeek(target)) { showToast('シーク同期できる動画がありません（ライブ配信は同期不可）', 'warn'); return; }
  const t = Adapter.getCurrentTime(target);
  if (t == null) { showToast('再生位置を取得できません', 'warn'); return; }
  list.forEach(s => { if (s.id !== target.id && Adapter.canSeek(s)) Adapter.seek(s, t); });
  showToast(`${t.toFixed(1)}秒に同期しました`, 'ok');
}
function applySoloState() {
  if (!state.soloMode) return;
  filledVideos().forEach(s => {
    const shouldHear = state.focusedId === s.id;
    s.muted = !shouldHear;
    shouldHear ? Adapter.unmute(s) : Adapter.mute(s);
    updateMutePill(s.id);
  });
  save();
}
function toggleSolo() {
  state.soloMode = !state.soloMode;
  $('soloBtn').classList.toggle('active', state.soloMode);
  if (state.soloMode) {
    const list = filledVideos();
    if (!state.focusedId && list[0]) state.focusedId = list[0].id;
    document.querySelectorAll('.frame.video').forEach(el => el.classList.toggle('focused', el.dataset.id === state.focusedId));
    applySoloState();
    showToast('ソロモード ON: フォーカスした枠のみ音が出ます', 'ok');
  } else {
    showToast('ソロモード OFF', 'ok');
  }
}
function setMasterVolume(val) {
  state.masterVolume = val;
  $('masterVolLabel').textContent = val;
  filledVideos().forEach(s => Adapter.applyVolume(s));
  save();
}

// ===== Persistence =====
function snapshot() {
  return {
    slots: state.slots.map(s => ({
      mode: s.mode,
      type: s.type, kind: s.kind, value: s.value, title: s.title,
      muted: s.muted, volume: s.volume,
      chatIndex: (s.mode === 'chat' && s.chatSourceId) ? state.slots.findIndex(x => x.id === s.chatSourceId) : null,
    })),
    layout: state.layout,
    masterVolume: state.masterVolume,
    volumeModel: VOLUME_MODEL,
    soloMode: state.soloMode,
  };
}
function encodeState(data) { return btoa(encodeURIComponent(JSON.stringify(data))); }
function decodeState(str) { return JSON.parse(decodeURIComponent(atob(str))); }
function save() { if (IS_POPOUT) return; try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot())); } catch (e) {} }

const SHARE_PREFIX = 's=';
// 戻り値: 共有 URL から読み込んだら true（呼び出し側で保存する）
function load() {
  const hash = location.hash.replace(/^#/, '');
  if (IS_POPOUT && hash) {
    try { hydrate(decodeState(hash)); return false; } catch (e) {}
  }
  if (!IS_POPOUT && hash.startsWith(SHARE_PREFIX)) {
    let shared = null;
    try { shared = decodeState(hash.slice(SHARE_PREFIX.length)); } catch (e) {}
    history.replaceState(null, '', location.pathname + location.search);
    if (!shared) {
      showToast('共有 URL を読み込めませんでした', 'error');
    } else if (confirm('共有されたレイアウトを読み込みますか？\n（いまの保存内容は上書きされます）')) {
      hydrate(shared);
      return true;
    }
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) { hydrate(JSON.parse(raw)); return false; }
    // migrate older formats
    const old = localStorage.getItem('ymv_state_v2') || localStorage.getItem('ymv_state_v1');
    if (old) {
      const data = JSON.parse(old);
      if (data && Array.isArray(data.videos) && data.videos[0] && data.videos[0].videoId) {
        data.videos = data.videos.map(v => ({ type: 'youtube', kind: 'video', value: v.videoId, title: v.title, muted: v.muted, volume: v.volume }));
      }
      hydrate(data);
    }
  } catch (e) {}
  return false;
}
function clampVolume(v, fallback) {
  return (typeof v === 'number' && Number.isFinite(v)) ? Math.max(0, Math.min(100, Math.round(v))) : fallback;
}
// 外部（保存データ・共有 URL）由来の値は検証してから使う
function hydrate(data) {
  if (!data || typeof data !== 'object') return;
  const master = clampVolume(data.masterVolume, state.masterVolume);
  // 旧形式では枠の音量にマスター音量そのものが入っていたので、倍率方式に変換する
  const legacyVolume = data.volumeModel !== VOLUME_MODEL;
  const toSlotVolume = v => {
    const vol = clampVolume(v, DEFAULT_SLOT_VOLUME);
    if (!legacyVolume || typeof v !== 'number') return vol;
    return master > 0 ? Math.min(100, Math.round(vol * 100 / master)) : DEFAULT_SLOT_VOLUME;
  };
  const fillFrom = (s, o) => {
    if (!isValidStoredEntry(o)) return;
    s.type = o.type; s.kind = o.kind; s.value = o.value;
    s.title = typeof o.title === 'string' && o.title ? o.title : defaultTitleFor(o);
  };
  if (Array.isArray(data.slots)) {
    state.layout = LAYOUTS.some(l => l.id === data.layout) ? data.layout : '4';
    state.slots = data.slots.slice(0, MAX_SLOTS).map(o => {
      const s = makeSlot();
      if (!o || typeof o !== 'object') return s;
      s.mode = o.mode === 'chat' ? 'chat' : 'video';
      if (s.mode === 'video') fillFrom(s, o);
      s.muted = o.muted !== false;
      s.volume = toSlotVolume(o.volume);
      s._ci = Number.isInteger(o.chatIndex) ? o.chatIndex : null;
      return s;
    });
    state.slots.forEach(s => {
      if (s._ci != null && state.slots[s._ci]) s.chatSourceId = state.slots[s._ci].id;
      delete s._ci;
    });
  } else if (Array.isArray(data.videos)) {
    const lay = LAYOUTS.some(l => l.id === data.layout) ? data.layout : autoLayoutFor(data.videos.length);
    state.layout = lay;
    const need = layoutCells(lay);
    state.slots = [];
    for (let i = 0; i < need; i++) {
      const s = makeSlot();
      const v = data.videos[i];
      if (v && typeof v === 'object') {
        const type = v.type || 'youtube';
        fillFrom(s, { type, kind: v.kind || (type === 'youtube' ? 'video' : 'channel'), value: v.value || v.videoId, title: v.title });
        s.muted = v.muted !== false;
        s.volume = toSlotVolume(v.volume);
      }
      state.slots.push(s);
    }
  }
  // normalize count to layout
  const need = layoutCells(state.layout);
  while (state.slots.length < need) state.slots.push(makeSlot());
  if (state.slots.length > need) state.slots = state.slots.slice(0, need);

  state.masterVolume = master;
  $('masterVol').value = master;
  $('masterVolLabel').textContent = master;
  if (data.soloMode) { state.soloMode = true; $('soloBtn').classList.add('active'); }
}

// ===== Share =====
async function shareLayout() {
  if (!state.slots.some(isUsed)) { showToast('共有する配信がありません', 'warn'); return; }
  const url = `${location.origin}${location.pathname}#${SHARE_PREFIX}${encodeState(snapshot())}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast('共有 URL をコピーしました', 'ok');
  } catch (e) {
    prompt('この URL を共有してください', url);
  }
}

// ===== Toast =====
let toastTimer = null;
// action: { label, run } を渡すとボタン付きで表示（例: 元に戻す）
function showToast(msg, type = '', action = null) {
  toast.className = '';
  if (type) toast.classList.add(type);
  toast.textContent = msg;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { toast.classList.remove('show'); action.run(); });
    toast.appendChild(btn);
    toast.classList.add('has-action');
  }
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), action ? 6000 : 2400);
}

// ===== Events =====
$('playAllBtn').addEventListener('click', playAll);
$('pauseAllBtn').addEventListener('click', pauseAll);
$('syncBtn').addEventListener('click', syncSeek);
$('shareBtn').addEventListener('click', shareLayout);
$('muteAllBtn').addEventListener('click', muteAll);
$('unmuteAllBtn').addEventListener('click', unmuteAll);
$('soloBtn').addEventListener('click', toggleSolo);
$('masterVol').addEventListener('input', e => setMasterVolume(parseInt(e.target.value, 10)));
$('masterVol').addEventListener('wheel', e => {
  e.preventDefault();
  const delta = e.deltaY < 0 ? 1 : -1;
  setMasterVolume(Math.max(0, Math.min(100, state.masterVolume + delta)));
  $('masterVol').value = state.masterVolume;
}, { passive: false });

$('clearBtn').addEventListener('click', () => {
  const used = state.slots.filter(isUsed).length;
  if (used === 0) return;
  if (confirm('すべての枠を空にしますか？（レイアウトは保持されます）')) {
    state.slots.forEach(resetSlot);
    state.focusedId = null;
    renderGrid(); save();
  }
});


$('fullscreenBtn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
});
$('hideToolbarBtn').addEventListener('click', () => setToolbarHidden(true));
$('showToolbarBtn').addEventListener('click', () => setToolbarHidden(false));
$('popoutNewBtn').addEventListener('click', popoutNewFrame);
// 他ウィンドウ(メイン)の保存状態が変わったらチャット選択肢を更新
window.addEventListener('storage', e => {
  if (e.key === STORAGE_KEY) refreshChatSelects();
});

function nowTimeStr() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
(function startClock() {
  function tick() {
    const t = nowTimeStr();
    document.querySelectorAll('.live-clock').forEach(el => { el.textContent = t; });
  }
  tick();
  setInterval(tick, 1000);
})();

// ===== Dialogs (settings / stream panels) =====
// 開いたときのフォーカス位置を覚えておき、閉じたら戻す
function openOverlay(overlay, focusEl) {
  overlay._lastFocus = document.activeElement;
  overlay.classList.remove('hidden');
  if (focusEl) focusEl.focus();
}
function closeOverlay(overlay) {
  if (overlay.classList.contains('hidden')) return;
  overlay.classList.add('hidden');
  const last = overlay._lastFocus;
  overlay._lastFocus = null;
  if (last && last.isConnected && typeof last.focus === 'function') last.focus();
}
const overlayClosers = new Map();   // overlay element -> close function
function closeTopOverlay() {
  for (const [overlay, close] of overlayClosers) {
    if (!overlay.classList.contains('hidden')) { close(); return true; }
  }
  return false;
}
function anyOverlayOpen() {
  return [...overlayClosers.keys()].some(o => !o.classList.contains('hidden'));
}

// ===== Settings (API key) =====
function openSettings() {
  const input = $('settingsKeyInput');
  input.value = ytApiKey;
  input.type = 'password';
  $('settingsStatus').textContent = ytApiKey ? '✅ キー設定済み（YouTube API で視聴者数を取得）' : '未設定（ぶいみる掲載の配信のみ視聴者数を表示）';
  openOverlay($('settingsOverlay'), input);
}
function closeSettings() { closeOverlay($('settingsOverlay')); }
overlayClosers.set($('settingsOverlay'), closeSettings);
function saveSettings() {
  const val = $('settingsKeyInput').value.trim();
  ytApiKey = val;
  viewerKeyErrorShown = false;
  try {
    if (val) localStorage.setItem(YT_API_KEY_STORAGE, val);
    else localStorage.removeItem(YT_API_KEY_STORAGE);
  } catch (e) {}
  $('settingsBtn').classList.toggle('active', !!val);
  closeSettings();
  showToast(val ? 'API キーを保存しました' : 'API キーを削除しました', 'ok');
  startViewerPolling();
}
$('settingsBtn').addEventListener('click', openSettings);
$('settingsCancelBtn').addEventListener('click', closeSettings);
$('settingsSaveBtn').addEventListener('click', saveSettings);
$('settingsKeyReveal').addEventListener('click', () => {
  const input = $('settingsKeyInput');
  input.type = input.type === 'password' ? 'text' : 'password';
});
$('settingsKeyInput').addEventListener('keydown', e => { if (e.key === 'Enter') saveSettings(); });
$('settingsOverlay').addEventListener('click', e => { if (e.target === $('settingsOverlay')) closeSettings(); });

$('helpBtn').addEventListener('click', () => {
  alert([
    '【YouTube + Twitch 同時視聴ビューワー】',
    '',
    '■ 基本の流れ',
    '1) ツールバーでレイアウトを選ぶと、その数だけ枠が表示されます',
    '2) 各枠に URL / ID を入力 →「表示」で配信を再生',
    '   ・YouTube: 動画 URL / 動画 ID / @チャンネル（配信中のライブを表示）',
    '   ・Twitch : チャンネル / VOD / クリップの URL、twitch:チャンネル名',
    '3) 枠を「💬 チャットを表示」にすると、他の枠の配信のチャットを表示',
    '4) 配信一覧（にじさんじ / 勢いランキング / ぶいみる）からも追加できます',
    '   続けて選ぶと、次の空き枠に追加されます',
    '',
    '■ 便利な機能',
    '・⇄ 同期   : フォーカス中（なければ先頭）の動画の再生位置に他の動画を合わせる',
    '・🔗 共有  : いまのレイアウトを URL でコピー',
    '・音量     : 枠ごとの音量 × マスター音量で再生されます',
    '・枠の左上をドラッグして並び替え、URL を空き枠にドロップして追加',
    '',
    '■ ショートカット',
    '・Space : すべて再生 / 一時停止',
    '・M     : 全ミュート / 解除',
    '・R     : すべて先頭から（ライブ配信は除く）',
    '・F     : 全画面',
    '・S     : ソロモード',
    '・H     : ヘッダー表示 / 非表示',
    '・1〜6, 8, 9 : レイアウト変更',
    '・Del   : フォーカス中の枠を空にする（直後なら元に戻せます）',
    '・Esc   : 開いているパネルを閉じる',
  ].join('\n'));
});

// keyboard shortcuts
const NUM_LAYOUT = { '1': '1', '2': '2h', '3': '3', '4': '4', '5': '5', '6': '6', '8': '8', '9': '9' };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (closeTopOverlay()) e.preventDefault();
    return;
  }
  if (anyOverlayOpen()) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      isAnyPlaying() ? pauseAll() : playAll();
      break;
    case 'm': case 'M':
      e.preventDefault();
      filledVideos().every(s => s.muted) ? unmuteAll() : muteAll();
      break;
    case 'r': case 'R': e.preventDefault(); restartAll(); break;
    case 'f': case 'F': e.preventDefault(); $('fullscreenBtn').click(); break;
    case 's': case 'S': e.preventDefault(); toggleSolo(); break;
    case 'h': case 'H':
      e.preventDefault();
      setToolbarHidden(!$('app').classList.contains('toolbar-hidden'));
      break;
    case 'Delete':
      if (state.focusedId) { e.preventDefault(); emptySlot(state.focusedId); }
      break;
    default:
      if (NUM_LAYOUT[e.key]) setLayout(NUM_LAYOUT[e.key]);
  }
});

// Drop URLs onto the page → fill empty slots
document.addEventListener('dragover', e => { e.preventDefault(); });
document.addEventListener('drop', e => {
  const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (!text || text.startsWith('slot:')) return;  // internal slot drags handled per-frame
  e.preventDefault();
  fillFirstEmpty(text);
});

// ===== Stream list panels (にじさんじ / 勢いランキング / ぶいみる) =====
// 各パネルは配信を共通形式 { url, title, channel, avatar, thumb, fallbackThumb, site, viewers, agencyLabel }
// に変換してカード表示する。カードを選ぶと対象の枠に追加し、空き枠が残っていれば次の空き枠を対象に開いたままにする。
function elem(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}
function panelMessage(className, ...lines) {
  const box = elem('div', className);
  lines.forEach((line, i) => { if (i) box.appendChild(document.createElement('br')); box.appendChild(document.createTextNode(line)); });
  return box;
}

function buildStreamCard(info, panel) {
  const card = elem('div', 'nijisanji-card');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', [info.channel, info.title].filter(Boolean).join(' — '));

  const thumb = elem('img', 'nijisanji-thumb');
  thumb.loading = 'lazy'; thumb.alt = '';
  thumb.addEventListener('error', () => {
    if (info.fallbackThumb && thumb.src !== info.fallbackThumb) thumb.src = info.fallbackThumb;
    else thumb.style.visibility = 'hidden';
  });
  thumb.src = info.thumb || '';
  card.appendChild(thumb);

  const body = elem('div', 'nijisanji-info');
  const row = elem('div', 'nijisanji-channel-row');
  if (info.avatar) {
    const avatar = elem('img', 'nijisanji-avatar');
    avatar.alt = '';
    avatar.addEventListener('error', () => { avatar.style.display = 'none'; });
    avatar.src = info.avatar;
    row.appendChild(avatar);
  }
  row.appendChild(elem('span', 'nijisanji-channel-name', info.channel || ''));
  const site = info.site === 'twitch' ? 'twitch' : 'youtube';
  row.appendChild(elem('span', `ikioi-site-badge ${site}`, site === 'twitch' ? 'Twitch' : 'YouTube'));
  if (info.agencyLabel) row.appendChild(elem('span', 'nijisanji-section-count', info.agencyLabel));
  body.appendChild(row);
  body.appendChild(elem('div', 'nijisanji-stream-title', info.title || ''));
  if (typeof info.viewers === 'number') {
    const viewers = elem('div', 'ikioi-viewers');
    viewers.appendChild(elem('span', 'live-dot'));
    viewers.appendChild(document.createTextNode(`${info.viewers.toLocaleString('ja-JP')} 人視聴中`));
    body.appendChild(viewers);
  }
  card.appendChild(body);

  const pick = () => pickStream(panel, info, card);
  card.addEventListener('click', pick);
  card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  return card;
}

async function pickStream(panel, info, card) {
  if (!info.url) { showToast('この配信のURLが取得できませんでした', 'error'); return; }
  const targetId = panel.targetId;
  if (!targetId) return;
  if (!await fillSlot(targetId, info.url, { title: info.title })) return;
  card.classList.add('added');
  if (panel.targetId !== targetId) return;   // 追加中にパネルが閉じられた
  const index = state.slots.findIndex(s => s.id === targetId);
  const next = state.slots.find(s => !isUsed(s));
  if (next) {
    panel.targetId = next.id;
    showToast(`枠 ${index + 1} に追加しました。続けて選ぶと次の空き枠に追加されます`, 'ok');
  } else {
    panel.close();
  }
}

function createStreamPanel(key, { normalize, onOpen }) {
  const overlay = $(key + 'Overlay');
  const body = $(key + 'Body');
  const closeBtn = $(key + 'CloseBtn');
  const panel = {
    targetId: null,
    requestId: 0,
    open(slotId) {
      panel.targetId = slotId;
      openOverlay(overlay, closeBtn);
      onOpen(panel);
    },
    close() {
      closeOverlay(overlay);
      panel.targetId = null;
      panel.requestId++;
    },
    // 古いリクエストの結果で上書きしないよう、最新のリクエストだけ反映する
    load(promise, render) {
      const id = ++panel.requestId;
      body.replaceChildren(panelMessage('nijisanji-loading', '読み込み中…'));
      promise.then(data => { if (id === panel.requestId) render(data); })
        .catch(err => {
          if (id === panel.requestId) body.replaceChildren(panelMessage('nijisanji-error', '読み込みに失敗しました。', err.message));
        });
    },
    // sections: [{ label, streams }]
    render(sections) {
      const total = sections.reduce((n, sec) => n + sec.streams.length, 0);
      if (!total) { body.replaceChildren(panelMessage('nijisanji-empty', '配信が見つかりませんでした')); return; }
      body.replaceChildren();
      sections.forEach(sec => {
        if (!sec.streams.length) return;
        if (sec.label) {
          const header = elem('div', 'nijisanji-section', sec.label + ' ');
          header.appendChild(elem('span', 'nijisanji-section-count', String(sec.streams.length)));
          body.appendChild(header);
        }
        sec.streams.forEach(stream => body.appendChild(buildStreamCard(normalize(stream), panel)));
      });
      body.scrollTop = 0;
    },
  };
  closeBtn.addEventListener('click', panel.close);
  overlay.addEventListener('click', e => { if (e.target === overlay) panel.close(); });
  overlayClosers.set(overlay, panel.close);
  return panel;
}

// --- にじさんじ ---
const nijisanjiPanel = createStreamPanel('nijisanji', {
  normalize: stream => {
    const ch = stream['youtube-channel'] || {};
    return {
      url: stream.url, title: stream.title, channel: ch.name, avatar: ch['thumbnail-url'],
      thumb: stream['thumbnail-url'], fallbackThumb: stream['fallback-thumbnail-url'], site: 'youtube',
    };
  },
  onOpen: panel => panel.load(fetchApi('/api/nijisanji-streams'), json => {
    // 旧形式(streams)互換、新形式(days)対応
    const days = json.days || [{ label: '🔴 ON AIR', streams: json.streams || [] }];
    panel.render(days.map(d => ({ label: d.label, streams: d.streams || [] })));
  }),
});

// --- 勢いランキング ---
let ikioiKeyword = 'Vtuber';
const listedStream = stream => ({
  url: stream.url, title: stream.title, channel: stream.channel, avatar: stream['channel-thumbnail'],
  thumb: stream['thumbnail-url'], site: stream.site, viewers: stream.viewers, agencyLabel: stream['agency-label'],
});
const ikioiPanel = createStreamPanel('ikioi', {
  normalize: listedStream,
  onOpen: panel => { $('ikioiKeyword').value = ikioiKeyword; loadIkioiResults(); },
});
function loadIkioiResults() {
  const keyword = ikioiKeyword;
  ikioiPanel.load(fetchApi(`/api/ikioi-streams?keyword=${encodeURIComponent(keyword)}`),
    json => ikioiPanel.render([{ label: `🔥 ${keyword}`, streams: json.streams || [] }]));
}
function submitIkioiSearch() {
  const kw = $('ikioiKeyword').value.trim();
  if (!kw) return;
  ikioiKeyword = kw;
  loadIkioiResults();
}
$('ikioiSearchBtn').addEventListener('click', submitIkioiSearch);
$('ikioiKeyword').addEventListener('keydown', e => { if (e.key === 'Enter') submitIkioiSearch(); });

// --- ぶいみる（事務所で絞り込み） ---
let vmiruStreams = [];
let vmiruFilter = '';   // '' = すべて、それ以外は agency キー
const vmiruPanel = createStreamPanel('vmiru', {
  normalize: listedStream,
  onOpen: panel => {
    vmiruFilter = '';
    $('vmiruCats').replaceChildren();
    panel.load(fetchApi('/api/vmiru-streams'), json => {
      vmiruStreams = json.streams || [];
      renderVmiruCats();
      renderVmiruList();
    });
  },
});
function renderVmiruCats() {
  const cats = $('vmiruCats');
  cats.replaceChildren();
  // agency キー → ラベル、件数を集計（出現順を維持）
  const order = [];
  const labelOf = {}, countOf = {};
  vmiruStreams.forEach(s => {
    const key = s.agency || '__none';
    if (!(key in countOf)) { order.push(key); countOf[key] = 0; labelOf[key] = s['agency-label'] || 'その他'; }
    countOf[key]++;
  });
  const mkChip = (key, label, count) => {
    const b = elem('button', 'vmiru-cat' + (vmiruFilter === key ? ' active' : ''), label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(vmiruFilter === key));
    b.appendChild(elem('span', 'cat-count', String(count)));
    b.addEventListener('click', () => { vmiruFilter = key; renderVmiruCats(); renderVmiruList(); });
    cats.appendChild(b);
  };
  mkChip('', 'すべて', vmiruStreams.length);
  order.forEach(key => mkChip(key, labelOf[key], countOf[key]));
}
function renderVmiruList() {
  const list = vmiruFilter
    ? vmiruStreams.filter(s => (s.agency || '__none') === vmiruFilter)
    : vmiruStreams;
  vmiruPanel.render([{ label: null, streams: list }]);
}

function openNijisanjiPanel(slotId) { nijisanjiPanel.open(slotId); }
function openIkioiPanel(slotId) { ikioiPanel.open(slotId); }
function openVmiruPanel(slotId) { vmiruPanel.open(slotId); }

// ===== Init =====
loadToolbarVisibility();
renderLayoutTiles();
const loadedFromShare = load();
if (state.slots.length === 0) {
  state.layout = state.layout || '4';
  for (let i = 0; i < layoutCells(state.layout); i++) state.slots.push(makeSlot());
}
renderLayoutTiles();
renderGrid();
if (loadedFromShare) save();
fetchTitles();
$('settingsBtn').classList.toggle('active', !!ytApiKey);
startViewerPolling();
