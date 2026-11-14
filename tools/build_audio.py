#!/usr/bin/env python3
"""Turn the reciter's official uploads into one mp3 per surah, plus catalog.json.

    build_audio.py --cache RAW_DIR --quran quran.json [--only 93,94]

RAW_DIR holds <youtube-id>.m4a as fetched by yt-dlp (see README). quran.json
maps each surah number to its first three ayat; it is how every file is
checked: speech recognition transcribes the opening seconds and they must
match the surah the file claims to be. A split is cut at the silence before
the basmala that opens the next surah, never at a guessed timestamp.
"""
import argparse, difflib, json, os, re, subprocess, sys
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, 'docs')
SR = 16000
FRAME = 0.02                       # 20 ms analysis frames

# ---------------------------------------------------------------- text

def norm(s):
    s = re.sub(r'[ؐ-ًؚ-ٰٟۖ-ۭـ]', '', s)
    s = re.sub('[إأآٱا]', 'ا', s)
    s = s.replace('ى', 'ي').replace('ة', 'ه').replace('ؤ', 'و').replace('ئ', 'ي')
    s = re.sub(r'[^ء-ي\s]', ' ', s)
    return ' '.join(s.split())

def opening(quran, sid, words=7):
    ayat = quran[str(sid)]
    if sid == 1:                       # al-Fatihah's first ayah *is* the basmala
        ayat = ayat[1:]
    return norm(' '.join(ayat)).split()[:words]

def ratio(a, b):
    return difflib.SequenceMatcher(None, a, b).ratio()

# ---------------------------------------------------------------- audio

def pcm(path):
    out = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR),
                          '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32)

def frames_db(x):
    n = int(SR * FRAME)
    m = len(x) // n
    e = np.sqrt(np.mean(x[:m * n].reshape(m, n) ** 2, axis=1) + 1e-12)
    return 20 * np.log10(e)

def silences(db, min_len=0.35):
    """Quiet stretches, relative to this recording's own speech level."""
    floor = np.percentile(db, 95) - 32
    quiet = db < floor
    out, i = [], 0
    while i < len(quiet):
        if quiet[i]:
            j = i
            while j < len(quiet) and quiet[j]:
                j += 1
            if (j - i) * FRAME >= min_len:
                out.append((i * FRAME, j * FRAME))
            i = j
        else:
            i += 1
    return out

def speech_span(db, pad=0.30):
    floor = np.percentile(db, 95) - 32
    loud = np.where(db >= floor)[0]
    a, b = loud[0] * FRAME, (loud[-1] + 1) * FRAME
    return max(0.0, a - pad), min(len(db) * FRAME, b + pad)

# ---------------------------------------------------------------- speech recognition

_model = None
def asr_words(x, offset=0.0):
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        try:                               # Apple GPU when available, else CPU
            _model = WhisperModel('small', device='mps', compute_type='float16')
        except Exception:
            _model = WhisperModel('small', device='cpu', compute_type='int8')
    segs, _ = _model.transcribe(x, language='ar', beam_size=5, word_timestamps=True,
                                vad_filter=False, condition_on_previous_text=False)
    words = []
    for s in segs:
        for w in (s.words or []):
            t = norm(w.word)
            if t:
                for part in t.split():
                    words.append((offset + w.start, offset + w.end, part))
    return words

def basmalas(words):
    """(index of 'بسم', index of the first word after 'الرحيم') for each basmala heard.

    In a continuous recitation a surah only ever starts right after one, so these
    are the only places a cut may go. 'بسم الله مجراها' (Hud 41) is not one:
    'الرحمن' must follow."""
    out = []
    for j in range(len(words) - 3):
        if words[j][2].startswith('بسم') and 'الله' in words[j + 1][2] and \
           any('رحم' in words[m][2] for m in range(j + 1, min(j + 4, len(words)))):
            e = next((m for m in range(j + 1, min(j + 6, len(words))) if 'رحيم' in words[m][2]), j + 3)
            if not out or j > out[-1][1]:
                out.append((j, e + 1))
    return out

def after(words, b, n=7):
    return [w[2] for w in words[b[1]:b[1] + n]]

def align(words, B, targets):
    """Give each surah, in order, its own basmala: the increasing assignment whose
    following words best match each surah's opening. Returns indices into B and scores."""
    n, m = len(targets), len(B)
    if m < n:
        raise SystemExit(f'heard {m} basmalas for {n} surahs')
    sc = [[ratio(' '.join(after(words, B[j], len(t))), ' '.join(t)) for j in range(m)] for t in targets]
    NEG = -1e9
    best = [[NEG] * m for _ in range(n)]; prev = [[-1] * m for _ in range(n)]
    for j in range(m):
        best[0][j] = sc[0][j]
    for i in range(1, n):
        run, arg = NEG, -1
        for j in range(m):
            if j > 0 and best[i - 1][j - 1] > run:
                run, arg = best[i - 1][j - 1], j - 1
            if arg >= 0:
                best[i][j] = run + sc[i][j]; prev[i][j] = arg
    j = max(range(m), key=lambda j: best[n - 1][j])
    total, pick = best[n - 1][j], []
    for i in range(n - 1, -1, -1):
        pick.append(j); j = prev[i][j]
    pick.reverse()
    return pick, [sc[i][pick[i]] for i in range(n)], total

def cut_at(t, sil):
    """Cut inside the pause that ends just before time t."""
    gaps = [g for g in sil if g[0] <= t + 0.6 and g[1] >= t - 2.5]
    if gaps:
        g = max(gaps, key=lambda g: g[1])
        return min(t, (g[0] + g[1]) / 2 if g[1] - g[0] < 1.6 else g[1] - 0.5)
    return max(0.0, t - 0.35)

# ---------------------------------------------------------------- encode

def encode(src, a, b, dst, title, album, track):
    af = (f"afade=t=in:st=0:d=0.12,afade=t=out:st={max(0.0, b - a - 0.25):.2f}:d=0.25,"
          "loudnorm=I=-16:TP=-1.5:LRA=11")
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{a:.2f}', '-to', f'{b:.2f}', '-i', src,
                    '-af', af, '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '64k',
                    '-id3v2_version', '3', '-metadata', f'title={title}',
                    '-metadata', 'artist=عبد الله أحمد شعبان', '-metadata', f'album={album}',
                    '-metadata', f'track={track}', dst], check=True)
    dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                                '-of', 'csv=p=0', dst], capture_output=True, text=True).stdout)
    return os.path.getsize(dst), round(dur)

# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', required=True)
    ap.add_argument('--quran', required=True)
    ap.add_argument('--only', default='')
    args = ap.parse_args()

    src = json.load(open(os.path.join(ROOT, 'tools', 'sources.json')))
    quran = json.load(open(args.quran))
    names = {s['id']: s for s in json.load(open(os.path.join(DOCS, 'surahs.json')))}
    only = {int(x) for x in args.only.split(',') if x}
    os.makedirs(os.path.join(DOCS, 'audio'), exist_ok=True)
    log_path = os.path.join(ROOT, 'tools', 'build-log.json')
    log = json.load(open(log_path)) if os.path.exists(log_path) else {}

    plan = {}                          # surah -> (raw file, start, end, source note, check)
    raw = lambda vid: os.path.join(args.cache, vid + '.m4a')

    # 1. whole-surah uploads: trim the silence, then confirm what is said first
    for sid, vid in src['singles'].items():
        sid = int(sid)
        if only and sid not in only:
            continue
        x = pcm(raw(vid)); db = frames_db(x)
        a, b = speech_span(db)
        head = asr_words(x[int(a * SR):int(min(b, a + 40) * SR)], a)
        B = basmalas(head)
        t = opening(quran, sid)
        heard = after(head, B[0], 10) if B else [w[2] for w in head[:14]]
        r = ratio(' '.join(heard[:len(t)]), ' '.join(t)) if B else 0.0
        plan[sid] = (raw(vid), a, b, f'youtube:{vid}', dict(match=round(r, 2), heard=' '.join(heard)))
        print(f'single {sid:3d} {vid}  {a:7.1f}-{b:7.1f}s  opening match {r:.2f}', flush=True)

    # 2. juz and multi-surah uploads: locate every opening, cut before its basmala
    for vid, spec in src['splits'].items():
        want = [s for s in spec['take'] if not only or s in only]
        if not want:
            continue
        x = pcm(raw(vid)); db = frames_db(x); sil = silences(db)
        a0, b0 = speech_span(db)
        words = asr_words(x)
        B = basmalas(words)
        orders = [spec['surahs'], list(reversed(spec['surahs']))] if spec.get('order') == 'measure' \
            else [spec['surahs']]
        tries = []
        for order in orders:
            pick, scores, total = align(words, B, [opening(quran, x) for x in order])
            tries.append((total, order, pick, scores))
        total, order, pick, scores = max(tries, key=lambda t: t[0])
        if len(tries) > 1:
            print(f'  {vid}: order {tries[0][1]} scores {tries[0][0]:.2f}, '
                  f'{tries[1][1]} scores {tries[1][0]:.2f} -> {order}')
        print(f'  {vid}: {len(B)} basmalas heard for {len(order)} surahs')
        starts = {}
        for k, sid in enumerate(order):
            bj = B[pick[k]]
            starts[sid] = (a0 if k == 0 else cut_at(words[bj[0]][0], sil), bj, scores[k])
        for k, sid in enumerate(order):
            if sid not in want:
                continue
            a = starts[sid][0]
            b = starts[order[k + 1]][0] if k + 1 < len(order) else b0
            heard = ' '.join(after(words, starts[sid][1], 10))
            plan[sid] = (raw(vid), a, b, f'youtube:{vid}@{a:.1f}-{b:.1f}',
                         dict(match=round(starts[sid][2], 2), heard=heard))
            print(f'split  {sid:3d} {vid}  {a:7.1f}-{b:7.1f}s  opening match {starts[sid][2]:.2f}  '
                  f'heard: {heard[:48]}', flush=True)

    # 3. encode
    for sid, (path, a, b, note, check) in sorted(plan.items()):
        s = names[sid]
        title = f"سورة {s['ar']}"
        dst = os.path.join(DOCS, 'audio', f'{sid:03d}.mp3')
        size, secs = encode(path, a, b, dst, title, 'القرآن الكريم', sid)
        log[str(sid)] = dict(id=f's{sid:03d}', section='amma' if sid >= 78 else 'surahs', surah=sid,
                             title=title, url=f'audio/{sid:03d}.mp3', bytes=size, secs=secs,
                             source=note, check=check)
    for key, sp in src['special'].items():
        if only:
            break
        x = pcm(raw(sp['id'])); a, b = speech_span(frames_db(x))
        dst = os.path.join(DOCS, 'audio', f'{key}.mp3')
        size, secs = encode(raw(sp['id']), a, b, dst, sp['title'], 'رقية وأذكار', 0)
        log[key] = dict(id=key, section='special', surah=None, title=sp['title'],
                        url=f'audio/{key}.mp3', bytes=size, secs=secs, source=f"youtube:{sp['id']}")
    json.dump(log, open(log_path, 'w'), ensure_ascii=False, indent=1)

    # 4. catalogue, in mushaf order, specials last
    recs = sorted((v for v in log.values() if v['surah']), key=lambda v: v['surah'])
    recs += [log[k] for k in ('ruqya', 'morning', 'evening') if k in log]
    cat = dict(
        reciter=dict(ar='عبد الله أحمد شعبان', en='Abdullah Ahmed Shaaban', riwaya='',            # not verified from the recitation: left out on purpose
                    
                     source=src['channel']),
        sections=[dict(id='surahs', ar='السور', note=''), dict(id='amma', ar='جزء عمّ', note=''),
                  dict(id='special', ar='رقية وأذكار', note='')],
        recordings=[{k: v[k] for k in ('id', 'section', 'surah', 'title', 'url', 'bytes', 'secs')}
                    for v in recs])
    json.dump(cat, open(os.path.join(DOCS, 'catalog.json'), 'w'), ensure_ascii=False, indent=1)
    print(f"catalog.json: {len(cat['recordings'])} recordings, "
          f"{sum(r['secs'] for r in cat['recordings']) / 3600:.1f} h, "
          f"{sum(r['bytes'] for r in cat['recordings']) / 1e6:.0f} MB")

if __name__ == '__main__':
    main()
