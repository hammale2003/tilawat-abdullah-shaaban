# تلاوات عبد الله أحمد شعبان

A web app for listening to the young reciter عبد الله أحمد شعبان, installable on
iPhone, iPad and Android from the browser. Free, no ads, no accounts, no tracking.
It is the sibling of
[tilawat-omar-ibn-abdulaziz](https://github.com/hammale2003/tilawat-omar-ibn-abdulaziz)
and shares its player engine, with a design of its own (below).

It exists because Android has apps for this reciter and the App Store has none.

## Install

**iPhone / iPad** — open <https://hammale2003.github.io/tilawat-abdullah-shaaban/>
in Safari, tap Share, then «إضافة إلى الشاشة الرئيسية».
**Android** — open the same link in Chrome and choose «تثبيت التطبيق».

## What's in it

**69 recordings, 12 hours.**

| Section | Count | Length | What it is |
|---|---|---|---|
| السور | 29 | 9.9 h | الفاتحة to المرسلات: every surah he has published, one file each |
| جزء عمّ | 37 | 0.9 h | the whole juz, النبأ to الناس |
| رقية وأذكار | 3 | 1.2 h | الرقية الشرعية, أذكار الصباح, أذكار المساء |

The surahs: 1 2 3 12 15 18 19 20 23 36 37 40 41 44 55 56 58 59, all of
67–114. **There is no complete mushaf in his voice**; the app presents what
exists and gains surahs as he publishes them.

## Where the recordings come from

Only from his official channel, <https://www.youtube.com/@Abdullahshaab1>. The
channel puts this under every upload:

> أي تحميل للتلاوات القديمة المسجلة بصوت القارئ عبد الله شعبان سوف يعرض قناتك
> الى الحذف ونبرأ الى الله تعالى منها … وذلك لوجود أخطاء في أحكام التلاوة
> والتجويد ومخارج الحروف

So his old recordings, which circulate widely on other channels and apps, are
deliberately absent. `tools/sources.json` names the exact upload behind every
file.

Most surahs have an upload of their own. The rest were cut out of his complete
جزء تبارك and جزء عمّ recordings and three multi-surah uploads. A cut is never a
guessed timestamp:

- speech recognition (faster-whisper) transcribes the recording;
- in a continuous recitation a surah only starts after a basmala, so the
  basmalas are the only candidate cut points, and each recording had exactly as
  many basmalas as surahs;
- the words after each basmala are matched to that surah's opening ayat
  (quran.com API), and the cut goes in the pause before the basmala;
- every output file, split or not, has its opening transcribed and checked
  against the surah it claims to be. `tools/build-log.json` keeps what was heard.

The one order that was not known in advance — الحشر and المجادلة share an
upload — was measured the same way, not assumed.

The riwaya is not stated in the app: on الفاتحة the recogniser heard «ملك يوم
الدين», which a small model can mishear for «مالك». It will be shown once
confirmed.

## Adding a surah he publishes

1. Add `"<surah number>": "<video id>"` to `singles` in `tools/sources.json`.
2. Fetch it: `yt-dlp -f 140 -o 'CACHE/%(id)s.%(ext)s' <url>`
3. `python tools/build_audio.py --cache CACHE --quran quran.json --only <n>`
   (needs `numpy` and `faster-whisper`; `quran.json` maps each surah to its
   first ayat)
4. Bump `CACHE` in `docs/sw.js`, commit, push.

## Hosting

GitHub Pages, branch `main`, folder `/docs`. Audio is mp3, 64 kbps mono,
loudness-levelled to −16 LUFS, served from the same origin as the app: 347 MB
in all, well inside the 1 GB site limit; the largest file (البقرة) is 63 MB,
inside the 100 MB file limit.

The service worker caches the app shell only and never touches `audio/`: a
service worker answering media Range requests is what breaks seeking and
lock-screen playback on iOS. Recitations stream by default.

To listen without internet, a recitation can be saved on the device: the
button beside each surah, the one in the player, «حفظ الجزء» for جزء عمّ, or
«حفظ كل التلاوات» in the settings. A saved recitation shows a tick, which
does nothing when tapped; it is deleted with the trash button beside it (or
for the whole juz, or everything from the settings), always after a
confirmation. Saved files are Blobs in IndexedDB (the
`shaaban` database), checked against the catalogue's byte count, and played
through blob: URLs created at start-up, so a tap starts playback without
waiting on the database (iOS only allows `play()` inside the tap). Offline,
recordings that are not saved are dimmed and skipped by next/previous. On an
iPhone, the home-screen app and Safari keep separate storage, so recitations
must be saved from the installed app.

## Design — «المحراب»

Drawn first as a Claude Design canvas (home by day and by night, the player,
جزء عمّ, the icon), then built from it.

- **Night navy, ivory paper, gold hairlines**, from the illuminated mushaf.
  The player is always night: it is where the listening happens.
- **The player is a mihrab.** Its gold outline fills from the right, over the
  apex and down as the surah plays; the lamp hanging from it brightens while
  he recites.
- **The surah list is set like a mushaf's فهرس**: an eight-point medallion,
  the name in Amiri, a dotted leader to the duration, «مكية · آياتها ١١٠».
- **جزء عمّ is a mosaic** of tiles, one tap to any short surah — what children
  recite most — and «استمع للجزء كاملاً» to hear it through.
- **Eastern Arabic numerals** everywhere; Amiri for names, IBM Plex Sans Arabic
  for everything else, both subset to Arabic and served by the app itself (no
  font requests to Google at runtime).

## Licences

- Code: as tilawat-omar-ibn-abdulaziz.
- Fonts: Amiri and IBM Plex Sans Arabic, SIL Open Font License (`docs/fonts/*-OFL.txt`).
- Surah metadata: Quran.com API.
- Audio: the reciter's own. His channel asks that his new recitations be shared
  without ownership claims; none are made here.
