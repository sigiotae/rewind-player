"""
곡 목록을 화면에 보여주기 전에 가수·곡 이름을 정리한다.

YouTube 영상 제목에서 가수와 곡명을 뽑으면 이런 찌꺼기가 남는다.
- "See You Again ft. Charlie Puth  Furious 7 Soundtrack"  → 영화 OST 꼬리말
- "Sorry (PURPOSE : The Movement)", "Work (Explicit)"     → 괄호 속 부가 정보
- 가수 "Fueled By Ramen", 곡 "twenty one pilots: Heathens" → 레이블 채널이 올린 영상
- 가수 "Numb", 곡 "Linkin Park"                            → 앞뒤가 뒤바뀜
- "Starboy ft. Daft Punk  ft. Daft Punk"                  → 피처링 중복
- 같은 곡이 다른 영상으로 두 번 들어간 경우
"""

import re
from collections import Counter, defaultdict

QUOTES = "\"'“”‘’「」『』"

# 괄호 안에 이런 말이 있으면 곡 이름이 아니라 부가 정보로 본다
EXTRA_IN_PARENS = re.compile(
    r"from\b|soundtrack|\bost\b|explicit|clean|movie|album|the movement|dir\.?:|cap\.\s*\d|records|"
    r"official|video|audio|lyric|visuali[sz]er|\bm/?v\b|remaster|version|\bver\b|\bedit\b|"
    r"\blive\b|mono|stereo|^\s*(19|20)\d\d\s*$|^\s*\d{1,2}\s*$|reimagined|prod\.|"
    r"\bsub\b|\d{3,4}p\b|^\s*main\s*$|버전|버젼|안무|뮤직\s*비디오|티저|teaser|\bost\b",
    re.I,
)
FEAT = re.compile(r"\b(?:ft\.?|feat\.?|featuring)\s+", re.I)


def norm(s):
    s = s.lower()
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s)
    s = re.sub(r"[\W_]+", " ", s)
    return " ".join(s.split())


def squash(s):
    return " ".join(s.split())


def drop_extra_parens(t):
    def repl(m):
        inner = m.group(0)[1:-1]
        if FEAT.match(inner.strip()):
            return m.group(0)  # (feat. X)는 남김
        return " " if EXTRA_IN_PARENS.search(inner) else m.group(0)
    prev = None
    while prev != t:
        prev = t
        t = re.sub(r"\([^()]*\)|\[[^\[\]]*\]|【[^【】]*】", repl, t)
    return t


def trim_quotes(t):
    """양 끝의 따옴표는 짝이 안 맞을 때만 떼어낸다 (Héctor "El Father", Lovin' 은 그대로)."""
    t = t.strip()
    while t and t[0] in QUOTES and sum(t.count(q) for q in QUOTES) % 2 == 1:
        t = t[1:].strip()
    while t and t[-1] in QUOTES and sum(t.count(q) for q in QUOTES) % 2 == 1 and not re.search(r"in['’]$", t):
        t = t[:-1].strip()
    return t


def strip_quotes(t):
    t = t.strip()
    # ‘곡’ 또는 "곡" with X 처럼 따옴표로 시작하면 따옴표 안을 곡 이름으로
    m = re.match(r"^[%s]([^%s]+)[%s]\s*(.*)$" % (QUOTES, QUOTES, QUOTES), t)
    if m:
        rest = m.group(2)
        t = m.group(1) + (" " + rest if re.match(r"(ft\.?|feat\.?|with)\s", rest, re.I) else "")
    for q in "\"“”":
        if t.count(q) == 1:
            t = t.replace(q, "")
    return trim_quotes(t)


VIDEO_JUNK = re.compile(
    r"\s*[-_–|]?\s*\b(official\s+(music\s+)?video|music\s+video|official\s+audio|official\s+lyric\s+video|"
    r"lyric\s+video|4k\s+video|hd\s+video|video\s+oficial)\b.*$|\s*뮤직\s*비디오.*$", re.I)


def cut_tails(t):
    t = t.split(" | ")[0]
    t = re.sub(r"\s{2,}[^()]*\b(soundtrack|ost)\b.*$", "", t, flags=re.I)
    t = re.sub(r"\s+[-–]\s*[^()]*\b(soundtrack|ost)\b.*$", "", t, flags=re.I)
    t = re.sub(r",?\s+a visual$", "", t, flags=re.I)
    return t


def drop_video_junk(t):
    t = VIDEO_JUNK.sub("", t)
    t = re.sub(r"^\s*(m/?v|mv)\b\s*", "", t, flags=re.I)
    t = re.sub(r"\*[^*]+\*", " ", t)                       # *OFFICIAL FRIENDZONE ANTHEM*
    t = re.sub(r"\s+with lyrics.*$", "", t, flags=re.I)
    t = re.sub(r"\s+(long|extended|radio|original)\s+(version|edit|mix)\W*$", "", t, flags=re.I)
    t = re.sub(r"\s*[-_–]?\s*\bofficial\s*$", "", t, flags=re.I)
    t = re.sub(r"(\s+\b(m/?v|4k|hd|hq)\b)+\s*$", "", t, flags=re.I)
    # 짝 없는 닫는 괄호 제거
    for o, c in ("()", "[]"):
        while t.count(c) > t.count(o):
            i = t.rfind(c)
            t = t[:i] + t[i + 1:]
    t = re.sub(r"\(\s+", "(", t)
    t = re.sub(r"\s+\)", ")", t)
    t = re.sub(r"\(\s*\)", "", t)
    return squash(t)


def dedupe_feat(t):
    parts = re.split(r"(\(?\b(?:ft\.?|feat\.?|featuring)\s+(?:(?!\b(?:ft\.?|feat\.?|featuring)\s)[^()])+\)?)", t, flags=re.I)
    seen, out = set(), []
    for p in parts:
        if FEAT.search(p):
            k = norm(FEAT.sub("", p))
            if k in seen:
                continue
            seen.add(k)
        out.append(p)
    return squash("".join(out))


def split_artist_feat(a):
    """'Ariana Grande ft. Nicki Minaj' → ('Ariana Grande', 'Nicki Minaj')"""
    m = re.match(r"^(.*?)\s*[\(\[]?\s*\b(?:ft\.?|feat\.?|featuring)\s+([^()\[\]]+?)[\)\]]?\s*$", a, re.I)
    if m and m.group(1):
        return m.group(1).strip(), m.group(2).strip()
    return a, None


def tidy_pair(artist, title):
    artist = re.sub(r"^\s*\d{1,3}\.\s+", "", artist)
    artist = re.sub(r"^\s*\[[^\]]*\]\s*(?=\S)", "", artist)          # [도깨비 OST Part 1] 찬열
    artist = trim_quotes(drop_video_junk(artist)).strip(" -_~")
    title = drop_video_junk(cut_tails(drop_extra_parens(title)))
    # 곡 이름 앞의 [가수] 표기 제거
    m = re.match(r"^\s*\[([^\]]+)\]\s*(.+)$", title)
    if m and (norm(artist) in norm(m.group(1)) or norm(m.group(1)) in norm(artist)):
        title = m.group(2)
    title = strip_quotes(title)

    # "Paramore: Decode", 레이블 채널의 "twenty one pilots: Heathens"
    m = re.match(r"^([^:()]{0,39}[^\s:()]):\s+(.+)$", title)
    if m:
        who, rest = m.group(1).strip(), m.group(2).strip()
        if norm(who) == norm(artist) or not FEAT.search(who):
            artist, title = who, rest

    artist, art_feat = split_artist_feat(artist)
    if art_feat and not FEAT.search(title):
        title = f"{title} (feat. {art_feat})"

    title = trim_quotes(drop_video_junk(dedupe_feat(squash(title))).strip(" -_"))
    return squash(artist), squash(title)


def display_name(variants):
    """같은 가수의 여러 표기 중 하나 고르기: 많이 쓰인 것, 대문자만 아닌 것, 짧은 것 순."""
    c = Counter(variants)
    return sorted(c, key=lambda v: (-c[v], v.isupper(), len(v)))[0]


def tidy_songs(songs):
    """songs: [{id, artist, title, genres, views, year}] → 정리·중복 제거한 목록"""
    rows = []
    for s in songs:
        a, t = tidy_pair(s["artist"], s["title"])
        if not norm(a) or not norm(t):
            continue
        if a[0] in QUOTES or a.count("[") != a.count("]") or a.count("(") != a.count(")"):
            continue  # 제목을 제대로 나누지 못한 영상
        rows.append(dict(s, artist=a, title=t))

    # 앞뒤가 바뀐 경우: 곡 이름이 다른 곡들에서 가수로 쓰이고, 가수 이름은 그렇지 않으면 맞바꿈
    artist_count = Counter(norm(r["artist"]) for r in rows)
    for r in rows:
        if artist_count[norm(r["title"])] >= 2 and artist_count[norm(r["artist"])] <= 1:
            r["artist"], r["title"] = r["title"], r["artist"]

    # 가수 표기 통일 (USHER / Usher, BTS / BTS (방탄소년단))
    names = defaultdict(list)
    for r in rows:
        names[norm(r["artist"])].append(r["artist"])
    shown = {k: display_name(v) for k, v in names.items()}
    # 검색용 다른 이름 (IU(아이유) → "아이유", 소녀시대 / Girls' Generation 등)
    aka = {}
    for k, variants in names.items():
        extra = set()
        for v in set(variants):
            extra.update(x.strip() for x in re.findall(r"\(([^()]+)\)", v))
            extra.add(re.sub(r"\s*\([^()]*\)", "", v).strip())
        extra = {x for x in extra if x and norm(x) != norm(shown[k]) and len(x) <= 30}
        if extra:
            aka[k] = " ".join(sorted(extra))

    # 같은 곡 중복 제거 (피처링 표기 차이는 무시)
    best = {}
    for r in rows:
        k = norm(r["artist"])
        r["artist"] = shown[k]
        if k in aka:
            r["aka"] = aka[k]
        key = (norm(r["artist"]), norm(FEAT.split(r["title"])[0]))
        if key in best:
            keep = best[key]
            genres = keep["genres"] + [g for g in r["genres"] if g not in keep["genres"]]
            year = min(keep.get("year", 9999), r.get("year", 9999))
            if r["views"] > keep["views"]:
                keep = dict(r)
            keep["genres"] = genres
            if year != 9999:
                keep["year"] = year
            best[key] = keep
        else:
            best[key] = dict(r)
    out = list(best.values())
    out.sort(key=lambda s: -s["views"])
    return out
