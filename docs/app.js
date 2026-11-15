/* تلاوات عبد الله أحمد شعبان — «المحراب».
 *
 * One recording at a time with an explicit "what plays next" rule (the
 * section you are browsing), per-recording resume, and nothing leaving the
 * device. Audio streams from this same origin and the service worker never
 * touches it, so iOS gets plain Range requests and the lock screen works.
 *
 * Recitations saved for offline listening are Blobs in IndexedDB, played
 * through blob: URLs made once at start-up. Having the URL ready before the
 * tap keeps play() inside the user's gesture, which iOS insists on, and a
 * blob: URL hands the browser the whole file, so seeking needs no network.
 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ---------- Arabic formatting ---------- */

const AR = '٠١٢٣٤٥٦٧٨٩';
const ar = (v) => String(v).replace(/[0-9]/g, (d) => AR[d]).replace(/\./g, '٫');
function fmt(total) {
  if (!isFinite(total) || total < 0) total = 0;
  const s = Math.floor(total % 60), m = Math.floor(total / 60) % 60, h = Math.floor(total / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return ar(h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`);
}
const minutes = (secs) => ar(Math.max(1, Math.round(secs / 60)));

/* "الاخلاص" finds "الإخلاص": harakat stripped, alif/ya/ta-marbuta unified. */
const normalise = (s) => s
  .replace(/[ً-ْـ]/g, '')
  .replace(/[إأآا]/g, 'ا')
  .replace(/ى/g, 'ي')
  .replace(/ة/g, 'ه');

/* ---------- device-only preferences ---------- */

const Store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const Prefs = {
  get last() { return Store.get('last_recording', null); }, set last(v) { Store.set('last_recording', v); },
  posFor(id) { return Store.get('pos_' + id, 0); }, savePos(id, s) { Store.set('pos_' + id, s); }, clearPos(id) { Store.del('pos_' + id); },
  get speed() { return Store.get('speed', 1); }, set speed(v) { Store.set('speed', v); },
  get repeat() { return Store.get('repeat_mode', 0); }, set repeat(v) { Store.set('repeat_mode', v); },
  get section() { return Store.get('section', 'surahs'); }, set section(v) { Store.set('section', v); },
  get bookmarks() { return Store.get('bookmarks', []); }, set bookmarks(v) { Store.set('bookmarks', v); },
  get theme() { return Store.get('theme', 'system'); }, set theme(v) { Store.set('theme', v); },
};

/* ---------- saved recitations ---------- */

const DB = {
  _p: null,
  open() {
    if (!this._p) {
      this._p = new Promise((res, rej) => {
        const r = indexedDB.open('shaaban', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('audio');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      }).catch(() => null);
    }
    return this._p;
  },
  // Settles on the transaction, not the request: a full disk only shows up at commit.
  async _run(mode, fn) {
    const db = await this.open();
    if (!db) throw new Error('no-db');
    return new Promise((res, rej) => {
      const tx = db.transaction('audio', mode);
      const req = fn(tx.objectStore('audio'));
      tx.oncomplete = () => res(req.result);
      tx.onerror = tx.onabort = () => rej(tx.error || req.error);
    });
  },
  get: (id) => DB._run('readonly', (s) => s.get(id)).catch(() => undefined),
  put: (id, blob) => DB._run('readwrite', (s) => s.put(blob, id)).then(() => true, () => false),
  del: (id) => DB._run('readwrite', (s) => s.delete(id)).catch(() => {}),
  keys: () => DB._run('readonly', (s) => s.getAllKeys()).catch(() => []),
  all: () => DB._run('readonly', (s) => s.getAll()).catch(() => []),
};

const Saved = {
  urls: new Map(), // recording id -> blob: URL
  async boot() {
    const [keys, blobs] = await Promise.all([DB.keys(), DB.all()]);
    keys.forEach((id, i) => {
      const rec = recById(id), b = blobs[i];
      // A copy that no longer matches the catalogue (re-encoded, removed) is dropped.
      if (rec && b && b.size === rec.bytes) Saved.urls.set(id, URL.createObjectURL(b));
      else DB.del(id);
    });
  },
};

/* ---------- state ---------- */

const S = {
  reciter: null, sections: [], recordings: [], surahs: new Map(),
  section: Prefs.section, query: '',
  current: null, queue: [], playing: false,
  repeat: Prefs.repeat, speed: Prefs.speed,
  sleepTimer: null, sleepAtEnd: false, sleepUntil: 0,
  seeking: false, bandVisible: true, playerOpen: false, want: false,
};
const audio = $('#audio');
const inSection = (id) => S.recordings.filter((r) => r.section === id);
const surahOf = (r) => (r && r.surahId ? S.surahs.get(r.surahId) : null);
const recById = (id) => S.recordings.find((r) => r.id === id) || null;
const nameOf = (r) => { const s = surahOf(r); return s ? s.ar : r.title; };
const metaOf = (r) => { const s = surahOf(r); return s ? `${s.place} · آياتها ${ar(s.ayahs)}` : ''; };
const isSaved = (r) => Saved.urls.has(r.id);
const playable = (r) => navigator.onLine || isSaved(r);
const mb = (b) => ar(b < 1e7 ? (b / 1e6).toFixed(1) : Math.round(b / 1e6));
const tilawat = (n) => (n === 1 ? 'تلاوة واحدة' : n === 2 ? 'تلاوتان' : n <= 10 ? `${ar(n)} تلاوات` : `${ar(n)} تلاوة`);

/* ---------- boot ---------- */

async function boot() {
  applyTheme();
  const [cat, surahs] = await Promise.all([
    fetch('catalog.json').then((r) => r.json()),
    fetch('surahs.json').then((r) => r.json()),
  ]);
  S.reciter = cat.reciter;
  S.sections = cat.sections;
  S.recordings = cat.recordings.map((j) => ({ id: j.id, section: j.section, title: j.title,
    surahId: j.surah ?? null, url: j.url, bytes: j.bytes, secs: j.secs }));
  surahs.forEach((s) => S.surahs.set(s.id, s));
  if (!S.sections.some((s) => s.id === S.section)) S.section = S.sections[0].id;
  await Saved.boot();

  $('#reciter-name').textContent = S.reciter.ar;
  $('#player-reciter').textContent = S.reciter.ar;
  const hours = S.recordings.reduce((a, r) => a + r.secs, 0) / 3600;
  $('#about-counts').textContent =
    `${ar(S.recordings.length)} تلاوة · نحو ${ar(hours.toFixed(1).replace(/\.0$/, ''))} ساعة · تُضاف السور الجديدة عند نشرها`;

  renderTabs();
  renderView();
  onNetwork();
  const last = Prefs.last && recById(Prefs.last);
  if (last) { S.queue = queueFor(last); load(last, { autoplay: false }); }
  wire();
  registerSW();
  setTimeout(maybeOfferInstall, 2500);
}

/* ---------- browsing ---------- */

function results() {
  const q = S.query.trim();
  if (!q) return inSection(S.section);
  const n = normalise(q), lower = q.toLowerCase();
  return S.recordings.filter((r) => {
    if (normalise(r.title).includes(n)) return true;
    const s = surahOf(r);
    return !!s && (normalise(s.ar).includes(n) || (s.en || '').toLowerCase().includes(lower) ||
      String(s.id) === q || ar(s.id) === q);
  });
}
const queueFor = (rec) => (S.query ? results() : inSection(rec.section));

function renderTabs() {
  $('#tabs').innerHTML = S.sections.map((s) => `<button class="tab" role="tab" data-section="${s.id}"
    aria-selected="${!S.query && s.id === S.section}">${s.ar} <span class="count">${ar(inSection(s.id).length)}</span></button>`).join('');
}

const STAR = '<svg aria-hidden="true"><use href="#i-star"/></svg>';
const isCurrent = (r) => !!S.current && S.current.id === r.id;

function rowHTML(r) {
  const meta = metaOf(r);
  return `<li><button class="row" data-play="${r.id}" data-saved="${isSaved(r)}" aria-current="${isCurrent(r)}"
    aria-label="${r.title}، ${fmt(r.secs)}">
    <span class="med">${STAR}<span>${r.surahId ? ar(r.surahId) : '۞'}</span></span>
    <span class="txt"><span class="line"><span class="name">${nameOf(r)}</span><span class="leader" aria-hidden="true"></span>
    <span class="dur">${fmt(r.secs)}</span></span>${meta ? `<span class="meta">${meta}</span>` : ''}</span>
  </button>${dlButton(r)}${trashButton(r)}</li>`;
}

function tileHTML(r) {
  return `<button class="tile" data-play="${r.id}" data-saved="${isSaved(r)}" aria-current="${isCurrent(r)}" aria-label="${r.title}، ${fmt(r.secs)}">
    <span class="tt"><span class="n">${ar(r.surahId)}</span><span class="d"><svg class="ok" aria-hidden="true"><use href="#i-saved"/></svg>${fmt(r.secs)}</span></span>
    <span class="name">${nameOf(r)}</span>
    <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span></button>`;
}

function renderView() {
  const items = results();
  const view = $('#view');
  if (S.query.trim() && !items.length) {
    view.innerHTML = `<p class="empty"><b>لا نتائج</b>لم تُنشر هذه السورة بصوت القارئ بعد.</p>`;
  } else if (!S.query.trim() && S.section === 'amma') {
    const secs = items.reduce((a, r) => a + r.secs, 0);
    view.innerHTML = `<div class="juzhead"><p>من ${nameOf(items[0])} إلى ${nameOf(items[items.length - 1])} · ${minutes(secs)} دقيقة</p>
      <span class="acts"><button class="round trash" id="trash-juz" aria-label="حذف المحفوظ من جزء عمّ" hidden><svg class="ic"><use href="#i-trash"/></svg></button>
      <button class="round" id="save-juz" data-state="idle" aria-label="حفظ الجزء للاستماع دون إنترنت"><svg class="ic"><use href="#i-save"/></svg></button>
      <button class="outline" id="play-juz"><svg class="ic"><use href="#i-play"/></svg>استمع للجزء كاملاً</button></span></div>
      <div class="mosaic">${items.map(tileHTML).join('')}</div>`;
  } else {
    view.innerHTML = `<ul class="index">${items.map(rowHTML).join('')}</ul>`;
  }
  paintSaveAll();
}

function markCurrent() {
  $$('[data-play]').forEach((el) => el.setAttribute('aria-current', String(!!S.current && el.dataset.play === S.current.id)));
}

/* ---------- playback ---------- */

function load(rec, { autoplay = true } = {}) {
  S.current = rec;
  Prefs.last = rec.id;
  audio.src = Saved.urls.get(rec.id) || rec.url;
  audio.playbackRate = S.speed;
  const resume = Prefs.posFor(rec.id);
  if (resume > 2 && resume < rec.secs - 4) {
    audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = resume; } catch {} }, { once: true });
  }
  renderPlayer(); markCurrent(); renderBand(); setMediaMetadata(rec);
  // Not awaited: play() settles only once sound starts, and nothing should wait on that.
  if (autoplay) { S.want = true; audio.play().catch(() => {}); }
}

const NEEDS_NET = 'غير محفوظة على الجهاز — تحتاج إلى اتصال';

function playRecording(id) {
  const rec = recById(id);
  if (!rec) return;
  if (!playable(rec)) { toast(NEEDS_NET); return; }
  if (isCurrent(rec)) { if (audio.paused) toggle(); openPlayer(); return; }
  S.queue = queueFor(rec);
  openPlayer();
  load(rec);
}

function toggle() {
  if (!S.current) return;
  if (!audio.paused) { audio.pause(); return; }
  if (!playable(S.current)) { toast(NEEDS_NET); return; }
  // Saved since it was loaded: play the copy on the device from here on.
  const saved = Saved.urls.get(S.current.id);
  if (saved && audio.src !== saved) { swapSource(saved, true); return; }
  // A source that failed (offline at start-up) is dead until it is set again.
  if (audio.error) { load(S.current); return; }
  S.want = true; audio.play().catch(() => {});
}

/* Points the player at another copy of the current recording, keeping the position. */
function swapSource(url, play) {
  const t = audio.currentTime;
  audio.src = url;
  audio.playbackRate = S.speed;
  audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = t; } catch {} }, { once: true });
  if (play) { S.want = true; audio.play().catch(() => {}); }
}

/* The next recording in `list` that can play now: offline, unsaved ones are skipped. */
function nextIn(list, from, delta) {
  for (let i = from + delta; i >= 0 && i < list.length; i += delta) if (playable(list[i])) return list[i];
  return null;
}

function step(delta) {
  if (!S.current) return;
  const list = S.queue.length ? S.queue : inSection(S.current.section);
  const next = nextIn(list, list.findIndex((r) => r.id === S.current.id), delta);
  if (next) load(next);
}

function onEnded() {
  if (S.current) Prefs.clearPos(S.current.id);
  if (S.sleepAtEnd) { stopSleep(true); return; }
  if (S.repeat === 1) { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  const i = S.queue.findIndex((r) => r.id === (S.current && S.current.id));
  const next = nextIn(S.queue, i, 1) || (S.repeat === 2 ? nextIn(S.queue, -1, 1) : null);
  if (next) load(next);
}

/* ---------- lock screen ---------- */

function setMediaMetadata(rec) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: rec.title, artist: S.reciter.ar, album: rec.surahId ? 'القرآن الكريم' : 'رقية وأذكار',
    artwork: [{ src: 'art.png', sizes: '512x512', type: 'image/png' },
              { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
  });
}
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const on = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch {} };
  on('play', () => audio.play().catch(() => {}));
  on('pause', () => audio.pause());
  on('previoustrack', () => step(-1));
  on('nexttrack', () => step(1));
  on('seekbackward', (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); });
  on('seekforward', (d) => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 10)); });
  on('seekto', (d) => { audio.currentTime = d.seekTime; });
}
function updatePositionState() {
  const ms = navigator.mediaSession;
  if (!ms || !ms.setPositionState || !isFinite(audio.duration) || audio.duration <= 0) return;
  try { ms.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate || 1 }); } catch {}
}

/* ---------- now playing: band, pill, player ---------- */

const progress = () => { const d = audio.duration || (S.current && S.current.secs) || 0; return d ? audio.currentTime / d : 0; };

function setIcon(btn, playing) {
  btn.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  btn.setAttribute('aria-label', playing ? 'إيقاف مؤقت' : 'تشغيل');
}

function renderBand() {
  const rec = S.current;
  $('#band').hidden = !rec;
  if (!rec) return renderPill();
  $('#band-kicker').textContent = S.playing ? 'تستمع الآن' : 'تابع الاستماع';
  $('#band-title').textContent = rec.title;
  $('#pill-title').textContent = rec.title;
  const d = audio.duration || rec.secs;
  const t = audio.currentTime || Prefs.posFor(rec.id) || 0;
  $('#band-sub').textContent = `${fmt(t)} من ${fmt(d)}`;
  const pct = `${Math.min(100, (t / d) * 100)}%`;
  $('#band-fill').style.width = pct;
  $('#pill-fill').style.width = pct;
  setIcon($('#band-toggle'), S.playing);
  setIcon($('#pill-toggle'), S.playing);
  renderPill();
}

function renderPill() {
  const on = !!S.current && !S.bandVisible && !S.playerOpen;
  $('#pill').classList.toggle('on', on);
  document.body.classList.toggle('pill-on', on);
}

function renderPlayer() {
  const rec = S.current;
  if (!rec) return;
  const name = nameOf(rec);
  $('#now-kind').hidden = !rec.surahId;
  $('#now-title').textContent = name;
  $('#now-title').style.setProperty('--name-size', `${Math.max(34, Math.min(62, 62 - (name.length - 5) * 4.5))}px`);
  $('#now-meta').textContent = metaOf(rec) || (S.sections.find((s) => s.id === rec.section) || {}).ar || '';
  $('#now-num').textContent = rec.surahId ? ar(rec.surahId) : '۞';
  const marked = Prefs.bookmarks.includes(rec.id);
  $('#btn-bookmark use').setAttribute('href', marked ? '#i-bookmark-on' : '#i-bookmark');
  $('#btn-bookmark').setAttribute('aria-pressed', String(marked));
  $('#btn-save').dataset.dl = rec.id;
  paintDl(rec, true);
  $('#t-dur').textContent = fmt(audio.duration || rec.secs);
  setIcon($('#b-play'), S.playing);
  updateRepeatUI(); updateSpeedUI(); paintProgress();
}

function paintProgress() {
  const p = progress() * 100;
  $('#arch').style.strokeDasharray = `${p} 100`;
  if (!S.seeking) {
    $('#seek').value = Math.round(p * 10);
    $('#seek').style.setProperty('--pct', `${p}%`);
    $('#t-pos').textContent = fmt(audio.currentTime);
  }
}

let lastSave = 0;
function onTime() {
  if (!S.current) return;
  paintProgress();
  const d = audio.duration || S.current.secs;
  $('#band-sub').textContent = `${fmt(audio.currentTime)} من ${fmt(d)}`;
  const pct = `${Math.min(100, (audio.currentTime / d) * 100)}%`;
  $('#band-fill').style.width = pct; $('#pill-fill').style.width = pct;
  if (Date.now() - lastSave > 4000) {
    lastSave = Date.now();
    if (audio.currentTime > 3) Prefs.savePos(S.current.id, Math.floor(audio.currentTime));
    updatePositionState();
  }
}

function openPlayer() {
  S.playerOpen = true;
  $('#player').classList.add('on'); $('#player').setAttribute('aria-hidden', 'false');
  renderPill();
}
function closePlayer() {
  S.playerOpen = false;
  $('#player').classList.remove('on'); $('#player').setAttribute('aria-hidden', 'true');
  renderPill();
}

/* ---------- repeat, speed, sleep ---------- */

const REPEAT = ['تكرار', 'تكرار السورة', 'تكرار الكل'];
function updateRepeatUI() { $('#repeat-lbl').textContent = REPEAT[S.repeat]; $('#b-repeat').dataset.on = S.repeat > 0; }

const SPEEDS = [0.75, 1, 1.25, 1.5];
function updateSpeedUI() { $('#speed-lbl').textContent = `${ar(S.speed)}×`; $('#b-speed').dataset.on = S.speed !== 1; }

const SLEEPS = [{ m: 10 }, { m: 20 }, { m: 30 }, { m: 60 }, { end: true }];
let sleepIdx = -1;
function stopSleep(pause) {
  clearTimeout(S.sleepTimer); S.sleepTimer = null; S.sleepAtEnd = false; sleepIdx = -1;
  $('#b-sleep').dataset.on = 'false'; $('#sleep-lbl').textContent = 'مؤقّت النوم';
  if (pause) audio.pause();
}
function cycleSleep() {
  sleepIdx += 1;
  clearTimeout(S.sleepTimer);
  if (sleepIdx >= SLEEPS.length) { stopSleep(false); toast('أُلغي مؤقّت النوم'); return; }
  const o = SLEEPS[sleepIdx];
  $('#b-sleep').dataset.on = 'true';
  if (o.end) {
    S.sleepAtEnd = true;
    $('#sleep-lbl').textContent = 'حتى نهاية السورة';
    toast('يتوقّف عند نهاية السورة');
  } else {
    S.sleepAtEnd = false;
    S.sleepTimer = setTimeout(() => stopSleep(true), o.m * 60000);
    $('#sleep-lbl').textContent = `بعد ${ar(o.m)} دقيقة`;
    toast(`يتوقّف بعد ${ar(o.m)} دقيقة`);
  }
}

/* ---------- saving for offline ---------- */

const DL = { list: [], cur: null, ctrl: null, p: 0, batch: 0, painted: 0 };
const dlState = (r) => (DL.cur === r ? 'running' : DL.list.includes(r) ? 'queued' : isSaved(r) ? 'done' : 'idle');
const DL_LABEL = {
  idle: 'حفظ للاستماع دون إنترنت', queued: 'في انتظار الحفظ — اضغط للإلغاء',
  running: 'جارٍ الحفظ — اضغط للإيقاف', done: 'محفوظة على الجهاز',
};
const DL_ICON = { idle: 'i-save', queued: 'i-wait', done: 'i-saved' };

function dlInner(state) {
  if (state !== 'running') return `<svg class="ic" aria-hidden="true"><use href="#${DL_ICON[state]}"/></svg>`;
  return `<svg class="ring" viewBox="0 0 24 24" aria-hidden="true"><circle class="bg" cx="12" cy="12" r="8.5"/>
    <circle class="fg" cx="12" cy="12" r="8.5" pathLength="100" stroke-dasharray="${ringDash()}"/>
    <rect class="stop" x="9.75" y="9.75" width="4.5" height="4.5" rx="0.8"/></svg>`;
}
const ringDash = () => `${Math.max(2, DL.p * 100).toFixed(1)} 100`;

function dlButton(r) {
  const st = dlState(r);
  return `<button class="dl" data-dl="${r.id}" data-state="${st}" aria-label="${DL_LABEL[st]}: ${r.title}">${dlInner(st)}</button>`;
}
/* Deleting has its own button beside the tick, so a second tap on the tick can never delete. */
function trashButton(r) {
  return `<button class="trash" data-trash="${r.id}" aria-label="حذف «${r.title}» من الجهاز"${isSaved(r) ? '' : ' hidden'}>
    <svg class="ic" aria-hidden="true"><use href="#i-trash"/></svg></button>`;
}

/* Repaints every control showing recording r: its row and tile, and the player's button. */
function paintDl(r, force = false) {
  const st = dlState(r);
  $$(`[data-dl="${r.id}"]`).forEach((el) => {
    if (st === 'running' && el.dataset.state === 'running' && !force) {
      const fg = el.querySelector('.fg');
      if (fg) fg.setAttribute('stroke-dasharray', ringDash());
      return;
    }
    if (el.dataset.state === st && !force) return;
    el.dataset.state = st;
    el.setAttribute('aria-label', `${DL_LABEL[st]}: ${r.title}`);
    el.innerHTML = dlInner(st);
  });
  $$(`[data-play="${r.id}"]`).forEach((el) => { el.dataset.saved = String(isSaved(r)); });
  $$(`[data-trash="${r.id}"]`).forEach((el) => { el.hidden = st !== 'done'; });
}

function enqueue(recs) {
  const add = recs.filter((r) => dlState(r) === 'idle');
  if (!add.length) return;
  DL.list.push(...add);
  DL.batch += add.length;
  add.forEach((r) => paintDl(r));
  paintSaveAll();
  if (!DL.cur) runQueue();
}
function unqueue(r) {
  DL.list = DL.list.filter((x) => x !== r);
  DL.batch = Math.max(0, DL.batch - 1);
  paintDl(r); paintSaveAll();
}
function stopAll() {
  const left = DL.list;
  DL.list = [];
  left.forEach((r) => paintDl(r));
  if (DL.ctrl) DL.ctrl.abort();
  paintSaveAll();
}

let persistAsked = false;
function askPersist() {
  if (persistAsked) return;
  persistAsked = true;
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch {}
}

async function runQueue() {
  askPersist();
  let saved = 0, last = null;
  while (DL.list.length) {
    const r = DL.list.shift();
    DL.cur = r; DL.p = 0;
    paintDl(r); paintSaveAll();
    const res = await fetchOne(r);
    DL.cur = null; DL.ctrl = null;
    paintDl(r);
    if (res === 'ok') {
      saved += 1; last = r;
      if (isCurrent(r) && audio.paused) swapSource(Saved.urls.get(r.id), false);
      continue;
    }
    if (res === 'aborted') { if (!DL.list.length && !saved) toast('أُوقف الحفظ'); continue; }
    const left = DL.list;
    DL.list = [];
    left.forEach((x) => paintDl(x));
    toast(res === 'full' ? 'تعذّر الحفظ — لا توجد مساحة كافية على الجهاز' : 'تعذّر الحفظ — تحقّق من الاتصال');
    break;
  }
  const batch = DL.batch;
  DL.batch = 0; DL.p = 0;
  paintSaveAll();
  if (saved === 1 && batch === 1) toast(`حُفظت «${last.title}» على الجهاز`);
  else if (saved > 1) toast(`حُفظت ${tilawat(saved)} على الجهاز`);
}

/* One recording into IndexedDB: 'ok', 'aborted', 'net' or 'full'. */
async function fetchOne(r) {
  const ctrl = new AbortController();
  DL.ctrl = ctrl;
  try {
    const res = await fetch(r.url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const chunks = [];
    let got = 0;
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        DL.p = Math.min(1, got / r.bytes);
        if (Date.now() - DL.painted > 200) { DL.painted = Date.now(); paintDl(r); paintSaveAll(); }
      }
    } else {
      const buf = new Uint8Array(await res.arrayBuffer());
      chunks.push(buf);
      got = buf.length;
    }
    if (got !== r.bytes) throw new Error('incomplete');
    const blob = new Blob(chunks, { type: 'audio/mpeg' });
    chunks.length = 0;
    if (!(await DB.put(r.id, blob))) return 'full';
    // Read it back: the stored Blob is backed by the file on disk, the fetched one by memory.
    const stored = await DB.get(r.id);
    Saved.urls.set(r.id, URL.createObjectURL(stored || blob));
    return 'ok';
  } catch (e) {
    return e && e.name === 'AbortError' ? 'aborted' : 'net';
  }
}

async function removeSaved(r) {
  const url = Saved.urls.get(r.id);
  await DB.del(r.id);
  Saved.urls.delete(r.id);
  // Carry on from the same second, streaming.
  if (url && isCurrent(r) && audio.src === url) swapSource(r.url, !audio.paused);
  if (url) URL.revokeObjectURL(url);
  paintDl(r); paintSaveAll();
}

function onTrash(r) {
  if (!r || !isSaved(r)) return;
  if (confirm(`حذف «${r.title}» من الجهاز؟ ستحتاج بعدها إلى اتصال لسماعها.`)) {
    removeSaved(r).then(() => toast('حُذفت من الجهاز'));
  }
}

function onDl(r) {
  if (!r) return;
  const st = dlState(r);
  if (st === 'queued') unqueue(r);
  else if (st === 'running') { if (DL.ctrl) DL.ctrl.abort(); }
  else if (st === 'done') toast('محفوظة على الجهاز، تعمل دون إنترنت');
  else if (!navigator.onLine) toast('لا يوجد اتصال بالإنترنت');
  else enqueue([r]);
}

const JUZ = {
  idle: ['i-save', 'حفظ الجزء للاستماع دون إنترنت'],
  running: ['i-wait', 'جارٍ حفظ الجزء — اضغط للإيقاف'],
  done: ['i-saved', 'الجزء محفوظ على الجهاز'],
};

function paintSaveAll() {
  const total = S.recordings.length;
  const missing = S.recordings.filter((r) => !isSaved(r));
  const n = total - missing.length;
  const busy = !!DL.cur || DL.list.length > 0;
  const btn = $('#btn-save-all');
  const st = busy ? 'running' : missing.length ? 'idle' : 'done';
  btn.dataset.state = st;
  btn.querySelector('use').setAttribute('href', st === 'done' ? '#i-saved' : st === 'running' ? '#i-wait' : '#i-save');
  if (busy) {
    $('#save-all-lbl').textContent = 'جارٍ الحفظ… اضغط للإيقاف';
    const k = Math.max(1, DL.batch - DL.list.length);
    $('#save-all-sub').textContent =
      `${DL.cur ? DL.cur.title + ' · ' : ''}${ar(k)} من ${ar(Math.max(k, DL.batch))} · ${ar(Math.round(DL.p * 100))}٪`;
  } else if (missing.length) {
    $('#save-all-lbl').textContent = n ? 'حفظ بقية التلاوات' : 'حفظ كل التلاوات على الجهاز';
    $('#save-all-sub').textContent = `${mb(missing.reduce((a, r) => a + r.bytes, 0))} م.ب · تعمل بعدها دون إنترنت`;
  } else {
    $('#save-all-lbl').textContent = 'كل التلاوات محفوظة';
    $('#save-all-sub').textContent = 'تعمل كلها دون إنترنت';
  }
  const bytes = S.recordings.filter(isSaved).reduce((a, r) => a + r.bytes, 0);
  $('#saved-sub').textContent = n ? `${tilawat(n)} من ${ar(total)} · ${mb(bytes)} م.ب` : 'لا شيء بعد';
  $('#btn-clear-saved').hidden = !n;

  const jb = $('#save-juz');
  if (jb) {
    const juz = inSection('amma');
    const jst = juz.some((r) => ['running', 'queued'].includes(dlState(r))) ? 'running' : juz.every(isSaved) ? 'done' : 'idle';
    if (jb.dataset.state !== jst) {
      jb.dataset.state = jst;
      jb.querySelector('use').setAttribute('href', '#' + JUZ[jst][0]);
      jb.setAttribute('aria-label', JUZ[jst][1]);
    }
    $('#trash-juz').hidden = jst === 'running' || !juz.some(isSaved);
  }
}

function onNetwork() {
  document.body.classList.toggle('offline', !navigator.onLine);
}

/* ---------- install ---------- */

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => !/Android/i.test(navigator.userAgent) &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
let deferredPrompt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; });

function installText() {
  return isIOS()
    ? 'في Safari اضغط زر المشاركة <svg class="ic share"><use href="#i-share"/></svg> ثم «إضافة إلى الشاشة الرئيسية». يفتح بعدها من أيقونته، ويستمر التشغيل والشاشة مقفلة، ويمكنك حفظ السور فيه للاستماع دون إنترنت.'
    : 'أضفه إلى شاشتك الرئيسية ليفتح كتطبيق كامل.';
}
function showInstall() {
  $('#install-text').innerHTML = installText();
  $('#install-go').hidden = !deferredPrompt;
  $('#install').classList.add('on');
}
function maybeOfferInstall() {
  if (isStandalone() || Store.get('install_dismissed', false)) return;
  if (isIOS() || deferredPrompt) showInstall();
}

/* ---------- theme, toast ---------- */

function applyTheme() {
  const t = Prefs.theme, root = document.documentElement;
  t === 'system' ? root.removeAttribute('data-theme') : root.setAttribute('data-theme', t);
  $$('#theme-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === t)));
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  $$('meta[name="theme-color"]').forEach((m) => m.remove());
  const m = document.createElement('meta');
  m.name = 'theme-color'; m.content = S.playerOpen ? '#0B1424' : (dark ? '#0B1424' : '#F6F1E6');
  document.head.appendChild(m);
}

let toastTimer;
function toast(msg) {
  const el = $('#toast'); el.firstElementChild.textContent = msg; el.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
}

/* ---------- events ---------- */

function wire() {
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-section]');
    if (!b) return;
    S.section = b.dataset.section; Prefs.section = S.section;
    if (S.query) { S.query = ''; $('#q').value = ''; }
    renderTabs(); renderView();
  });

  $('#btn-search').addEventListener('click', () => {
    const row = $('#searchrow'), on = !row.classList.contains('on');
    row.classList.toggle('on', on); $('#btn-search').setAttribute('aria-expanded', String(on));
    if (on) $('#q').focus(); else { S.query = ''; $('#q').value = ''; renderTabs(); renderView(); }
  });
  $('#q').addEventListener('input', () => { S.query = $('#q').value; renderTabs(); renderView(); });
  $('#clearq').addEventListener('click', (e) => { e.preventDefault(); $('#btn-search').click(); });

  $('#view').addEventListener('click', (e) => {
    const tr = e.target.closest('[data-trash]');
    if (tr) { onTrash(recById(tr.dataset.trash)); return; }
    const dl = e.target.closest('[data-dl]');
    if (dl) { onDl(recById(dl.dataset.dl)); return; }
    if (e.target.closest('#trash-juz')) {
      const saved = inSection('amma').filter(isSaved);
      if (saved.length && confirm(`حذف ${tilawat(saved.length)} محفوظة من جزء عمّ؟`)) {
        Promise.all(saved.map(removeSaved)).then(() => toast('حُذف الجزء من الجهاز'));
      }
      return;
    }
    if (e.target.closest('#save-juz')) {
      const juz = inSection('amma'), st = $('#save-juz').dataset.state;
      if (st === 'done') toast('الجزء محفوظ على الجهاز');
      else if (st === 'running') {
        juz.filter((r) => dlState(r) === 'queued').forEach(unqueue);
        if (juz.includes(DL.cur) && DL.ctrl) DL.ctrl.abort();
      } else if (!navigator.onLine) toast('لا يوجد اتصال بالإنترنت');
      else {
        const rest = juz.filter((r) => !isSaved(r));
        enqueue(rest);
        toast(`يُحفظ الجزء: ${tilawat(rest.length)} · ${mb(rest.reduce((a, r) => a + r.bytes, 0))} م.ب`);
      }
      return;
    }
    if (e.target.closest('#play-juz')) {
      const juz = inSection('amma'), first = nextIn(juz, -1, 1);
      if (!first) { toast(NEEDS_NET); return; }
      S.queue = juz; openPlayer(); load(first); return;
    }
    const b = e.target.closest('[data-play]');
    if (b) playRecording(b.dataset.play);
  });

  $('#band-open').addEventListener('click', openPlayer);
  $('#band-toggle').addEventListener('click', toggle);
  $('#pill-open').addEventListener('click', openPlayer);
  $('#pill-toggle').addEventListener('click', toggle);
  new IntersectionObserver(([en]) => { S.bandVisible = en.isIntersecting; renderPill(); }).observe($('#band'));

  $('#player-close').addEventListener('click', closePlayer);
  $('#b-play').addEventListener('click', toggle);
  $('#b-next').addEventListener('click', () => step(1));
  $('#b-prev').addEventListener('click', () => { if (audio.currentTime > 4) audio.currentTime = 0; else step(-1); });
  $('#b-back').addEventListener('click', () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
  $('#b-fwd').addEventListener('click', () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10); });
  $('#b-repeat').addEventListener('click', () => {
    S.repeat = (S.repeat + 1) % 3; Prefs.repeat = S.repeat; updateRepeatUI();
    toast(S.repeat ? REPEAT[S.repeat] : 'بدون تكرار');
  });
  $('#b-speed').addEventListener('click', () => {
    S.speed = SPEEDS[(SPEEDS.indexOf(S.speed) + 1) % SPEEDS.length] || 1;
    Prefs.speed = S.speed; audio.playbackRate = S.speed; updateSpeedUI(); updatePositionState();
  });
  $('#b-sleep').addEventListener('click', cycleSleep);
  $('#btn-save').addEventListener('click', () => onDl(S.current));
  $('#btn-save-all').addEventListener('click', () => {
    const st = $('#btn-save-all').dataset.state;
    if (st === 'running') { stopAll(); return; }
    if (st === 'done') return;
    if (!navigator.onLine) { toast('لا يوجد اتصال بالإنترنت'); return; }
    const missing = S.recordings.filter((r) => !isSaved(r));
    const size = mb(missing.reduce((a, r) => a + r.bytes, 0));
    if (confirm(`سيُحفظ ${size} م.ب على الجهاز (${tilawat(missing.length)}). يُفضَّل الاتصال بشبكة Wi-Fi. متابعة؟`)) enqueue(missing);
  });
  $('#btn-clear-saved').addEventListener('click', async () => {
    const ids = [...Saved.urls.keys()];
    if (!ids.length || !confirm(`حذف ${tilawat(ids.length)} محفوظة من الجهاز؟`)) return;
    stopAll();
    for (const id of ids) await removeSaved(recById(id));
    toast('حُذف كل المحفوظ من الجهاز');
  });
  addEventListener('online', onNetwork);
  addEventListener('offline', onNetwork);
  $('#btn-bookmark').addEventListener('click', () => {
    if (!S.current) return;
    const b = Prefs.bookmarks.slice(), i = b.indexOf(S.current.id);
    i === -1 ? b.push(S.current.id) : b.splice(i, 1);
    Prefs.bookmarks = b; renderPlayer();
    toast(i === -1 ? 'أُضيفت علامة' : 'حُذفت العلامة');
  });

  const seek = $('#seek');
  seek.addEventListener('input', () => {
    S.seeking = true;
    const d = audio.duration || (S.current && S.current.secs) || 0;
    seek.style.setProperty('--pct', `${seek.value / 10}%`);
    $('#t-pos').textContent = fmt((seek.value / 1000) * d);
    $('#arch').style.strokeDasharray = `${seek.value / 10} 100`;
  });
  seek.addEventListener('change', () => {
    const d = audio.duration || (S.current && S.current.secs) || 0;
    audio.currentTime = (seek.value / 1000) * d; S.seeking = false;
  });

  $('#btn-settings').addEventListener('click', () => { $('#settings').classList.add('on'); $('#settings').setAttribute('aria-hidden', 'false'); });
  $('#settings-close').addEventListener('click', () => { $('#settings').classList.remove('on'); $('#settings').setAttribute('aria-hidden', 'true'); });
  $('#theme-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme]'); if (!b) return;
    Prefs.theme = b.dataset.theme; applyTheme();
  });
  $('#btn-install-help').addEventListener('click', () => { Store.del('install_dismissed'); showInstall(); });
  $('#install-x').addEventListener('click', () => { $('#install').classList.remove('on'); Store.set('install_dismissed', true); });
  $('#install-go').addEventListener('click', () => { if (!deferredPrompt) return; $('#install').classList.remove('on'); deferredPrompt.prompt(); deferredPrompt = null; });

  audio.addEventListener('play', () => { S.playing = true; document.body.classList.add('playing'); $('#player').classList.add('playing-now'); renderBand(); setIcon($('#b-play'), true); updatePositionState(); });
  audio.addEventListener('pause', () => {
    S.playing = false; document.body.classList.remove('playing'); $('#player').classList.remove('playing-now');
    renderBand(); setIcon($('#b-play'), false);
    if (S.current && audio.currentTime > 3) Prefs.savePos(S.current.id, Math.floor(audio.currentTime));
  });
  audio.addEventListener('timeupdate', onTime);
  audio.addEventListener('loadedmetadata', () => { audio.playbackRate = S.speed; $('#t-dur').textContent = fmt(audio.duration); paintProgress(); updatePositionState(); });
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('playing', () => { S.want = false; });
  audio.addEventListener('error', () => { if (S.current && S.want && !navigator.onLine) { S.want = false; toast(NEEDS_NET); } });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (Prefs.theme === 'system') applyTheme(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && S.current && audio.currentTime > 3) Prefs.savePos(S.current.id, Math.floor(audio.currentTime));
  });
  setupMediaSession();
}

/* ---------- service worker ---------- */

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const go = () => navigator.serviceWorker.register('sw.js').catch(() => {});
  document.readyState === 'complete' ? go() : addEventListener('load', go, { once: true });
}

boot();
