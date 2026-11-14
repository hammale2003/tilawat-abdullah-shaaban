/* تلاوات عبد الله أحمد شعبان — «المحراب».
 *
 * One recording at a time with an explicit "what plays next" rule (the
 * section you are browsing), per-recording resume, and nothing leaving the
 * device. Audio is served from this same origin; the service worker never
 * touches it, so iOS gets plain Range requests and the lock screen works.
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

/* ---------- state ---------- */

const S = {
  reciter: null, sections: [], recordings: [], surahs: new Map(),
  section: Prefs.section, query: '',
  current: null, queue: [], playing: false,
  repeat: Prefs.repeat, speed: Prefs.speed,
  sleepTimer: null, sleepAtEnd: false, sleepUntil: 0,
  seeking: false, bandVisible: true, playerOpen: false,
};
const audio = $('#audio');
const inSection = (id) => S.recordings.filter((r) => r.section === id);
const surahOf = (r) => (r && r.surahId ? S.surahs.get(r.surahId) : null);
const recById = (id) => S.recordings.find((r) => r.id === id) || null;
const nameOf = (r) => { const s = surahOf(r); return s ? s.ar : r.title; };
const metaOf = (r) => { const s = surahOf(r); return s ? `${s.place} · آياتها ${ar(s.ayahs)}` : ''; };

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

  $('#reciter-name').textContent = S.reciter.ar;
  $('#player-reciter').textContent = S.reciter.ar;
  const hours = S.recordings.reduce((a, r) => a + r.secs, 0) / 3600;
  $('#about-counts').textContent =
    `${ar(S.recordings.length)} تلاوة · نحو ${ar(hours.toFixed(1).replace(/\.0$/, ''))} ساعة · تُضاف السور الجديدة عند نشرها`;

  renderTabs();
  renderView();
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
  return `<li><button class="row" data-play="${r.id}" aria-current="${isCurrent(r)}"
    aria-label="${r.title}، ${fmt(r.secs)}">
    <span class="med">${STAR}<span>${r.surahId ? ar(r.surahId) : '۞'}</span></span>
    <span class="txt"><span class="line"><span class="name">${nameOf(r)}</span><span class="leader" aria-hidden="true"></span>
    <span class="dur">${fmt(r.secs)}</span></span>${meta ? `<span class="meta">${meta}</span>` : ''}</span>
  </button></li>`;
}

function tileHTML(r) {
  return `<button class="tile" data-play="${r.id}" aria-current="${isCurrent(r)}" aria-label="${r.title}، ${fmt(r.secs)}">
    <span class="tt"><span class="n">${ar(r.surahId)}</span><span class="d">${fmt(r.secs)}</span></span>
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
      <button class="outline" id="play-juz"><svg class="ic"><use href="#i-play"/></svg>استمع للجزء كاملاً</button></div>
      <div class="mosaic">${items.map(tileHTML).join('')}</div>`;
  } else {
    view.innerHTML = `<ul class="index">${items.map(rowHTML).join('')}</ul>`;
  }
}

function markCurrent() {
  $$('[data-play]').forEach((el) => el.setAttribute('aria-current', String(!!S.current && el.dataset.play === S.current.id)));
}

/* ---------- playback ---------- */

function load(rec, { autoplay = true } = {}) {
  S.current = rec;
  Prefs.last = rec.id;
  audio.src = rec.url;
  audio.playbackRate = S.speed;
  const resume = Prefs.posFor(rec.id);
  if (resume > 2 && resume < rec.secs - 4) {
    audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = resume; } catch {} }, { once: true });
  }
  renderPlayer(); markCurrent(); renderBand(); setMediaMetadata(rec);
  // Not awaited: play() settles only once sound starts, and nothing should wait on that.
  if (autoplay) audio.play().catch(() => {});
}

function playRecording(id) {
  const rec = recById(id);
  if (!rec) return;
  if (isCurrent(rec)) { if (audio.paused) audio.play().catch(() => {}); openPlayer(); return; }
  S.queue = queueFor(rec);
  openPlayer();
  load(rec);
}

function toggle() { if (!S.current) return; audio.paused ? audio.play().catch(() => {}) : audio.pause(); }

function step(delta) {
  if (!S.current) return;
  const list = S.queue.length ? S.queue : inSection(S.current.section);
  const next = list[list.findIndex((r) => r.id === S.current.id) + delta];
  if (next) load(next);
}

function onEnded() {
  if (S.current) Prefs.clearPos(S.current.id);
  if (S.sleepAtEnd) { stopSleep(true); return; }
  if (S.repeat === 1) { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  const i = S.queue.findIndex((r) => r.id === (S.current && S.current.id));
  if (S.queue[i + 1]) { load(S.queue[i + 1]); return; }
  if (S.repeat === 2 && S.queue.length) load(S.queue[0]);
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

/* ---------- install ---------- */

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => !/Android/i.test(navigator.userAgent) &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
let deferredPrompt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; });

function installText() {
  return isIOS()
    ? 'في Safari اضغط زر المشاركة <svg class="ic share"><use href="#i-share"/></svg> ثم «إضافة إلى الشاشة الرئيسية». يفتح بعدها من أيقونته، ويستمر التشغيل والشاشة مقفلة.'
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
    if (e.target.closest('#play-juz')) {
      const juz = inSection('amma'); S.queue = juz; openPlayer(); load(juz[0]); return;
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
  audio.addEventListener('error', () => { if (S.current && !navigator.onLine) toast('لا يوجد اتصال بالإنترنت'); });

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
