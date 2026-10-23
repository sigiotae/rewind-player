"""
장르별 '예전엔 인기 있었지만 요즘은 잘 안 듣는 곡' 목록을 만든다.

흐름
1. Last.fm 장르 태그별 누적 인기곡(tag.getTopTracks)을 후보로 가져온다.
2. Last.fm 현재 글로벌 차트(chart.getTopTracks)에 있는 곡은 '요즘 듣는 곡'으로 보고 뺀다.
3. 후보마다 YouTube에서 영상을 찾아 조회수·업로드일·임베드 가능 여부를 확인한다.
4. 조회수 MIN_VIEWS 이상, 업로드 MIN_AGE_YEARS년 이상 지난 곡만 site/songs.json 에 넣는다.

YouTube 검색은 하루 할당량(10,000단위, 검색 1회 100단위)이 작아서
한 번 실행할 때 MAX_SEARCHES_PER_RUN 회만 검색하고, 결과는 data/video_cache.json 에
저장해 다음 실행 때 재사용한다. 매일 돌리면 목록이 조금씩 늘어난다.

필요한 환경 변수: LASTFM_API_KEY, YOUTUBE_API_KEY
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_PATH = os.path.join(ROOT, "data", "video_cache.json")
OUT_PATH = os.path.join(ROOT, "site", "songs.json")

# 장르 id, 화면 표시 이름, Last.fm 태그
GENRES = [
    ("pop", "팝", ["pop"]),
    ("dance", "댄스", ["dance", "electropop"]),
    ("hiphop", "힙합", ["hip-hop", "rap"]),
    ("rnb", "R&B", ["rnb", "soul"]),
    ("rock", "록", ["rock", "alternative rock"]),
    ("indie", "인디", ["indie", "indie pop"]),
    ("electronic", "일렉트로닉", ["electronic", "edm"]),
    ("ballad", "발라드", ["ballad", "acoustic"]),
    ("kpop", "K-POP", ["k-pop"]),
    ("latin", "라틴", ["latin", "reggaeton"]),
]

TRACKS_PER_TAG = 150          # 태그당 가져올 후보 수
CURRENT_CHART_SIZE = 500      # '요즘 듣는 곡'으로 볼 현재 차트 범위
MIN_VIEWS = int(os.environ.get("MIN_VIEWS", 30_000_000))
MIN_AGE_YEARS = float(os.environ.get("MIN_AGE_YEARS", 5))
MAX_SEARCHES_PER_RUN = int(os.environ.get("MAX_SEARCHES_PER_RUN", 90))

LASTFM_URL = "https://ws.audioscrobbler.com/2.0/"
YT_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
YT_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"


def http_get_json(url, params):
    full = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(full, headers={"User-Agent": "rewind-player/1.0"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "ignore")
            if e.code == 403 and "quota" in body.lower():
                raise QuotaExceeded(body)
            if attempt == 2:
                raise RuntimeError(f"HTTP {e.code}: {body[:300]}")
        except urllib.error.URLError:
            if attempt == 2:
                raise
        time.sleep(1.5 * (attempt + 1))


class QuotaExceeded(Exception):
    pass


def norm(s):
    s = s.lower()
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s)
    s = re.sub(r"[^0-9a-z가-힣]+", " ", s)
    return " ".join(s.split())


def key_of(artist, track):
    return f"{norm(artist)} - {norm(track)}"


# ---------- Last.fm ----------

def lastfm(method, key, **params):
    params.update({"method": method, "api_key": key, "format": "json"})
    data = http_get_json(LASTFM_URL, params)
    if "error" in data:
        raise RuntimeError(f"Last.fm {method}: {data.get('message')}")
    return data


def tag_top_tracks(key, tag, limit):
    tracks, page = [], 1
    while len(tracks) < limit:
        data = lastfm("tag.gettoptracks", key, tag=tag, limit=50, page=page)
        items = data.get("tracks", {}).get("track", [])
        if not items:
            break
        for t in items:
            tracks.append((t["artist"]["name"], t["name"]))
        page += 1
    return tracks[:limit]


def current_chart(key, size):
    keys, page = set(), 1
    while len(keys) < size:
        data = lastfm("chart.gettoptracks", key, limit=50, page=page)
        items = data.get("tracks", {}).get("track", [])
        if not items:
            break
        for t in items:
            keys.add(key_of(t["artist"]["name"], t["name"]))
        page += 1
    return keys


# ---------- YouTube ----------

def find_video(yt_key, artist, track):
    """검색 1회(100단위) + 상세 조회 1회(1단위). 가장 그럴듯한 영상 정보를 돌려준다."""
    data = http_get_json(YT_SEARCH_URL, {
        "part": "id",
        "q": f"{artist} {track}",
        "type": "video",
        "videoCategoryId": "10",  # Music
        "maxResults": 5,
        "key": yt_key,
    })
    ids = [it["id"]["videoId"] for it in data.get("items", []) if it.get("id", {}).get("videoId")]
    if not ids:
        return None
    details = http_get_json(YT_VIDEOS_URL, {
        "part": "snippet,statistics,status",
        "id": ",".join(ids),
        "key": yt_key,
    })
    want = norm(track)
    best = None
    for v in details.get("items", []):
        if not v.get("status", {}).get("embeddable", False):
            continue
        title = norm(v["snippet"]["title"])
        views = int(v.get("statistics", {}).get("viewCount", 0))
        score = views * (2 if want and want in title else 1)
        if best is None or score > best[0]:
            best = (score, v)
    if not best:
        return None
    v = best[1]
    return {
        "id": v["id"],
        "views": int(v.get("statistics", {}).get("viewCount", 0)),
        "published": v["snippet"]["publishedAt"],
        "ytTitle": v["snippet"]["title"],
    }


# ---------- 메인 ----------

def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def clean_title(t):
    # "Song (Remastered 2011)" 같은 꼬리표 제거 (feat. 표기는 유지)
    t = re.sub(r"\s*[\(\[](?!feat|ft)[^\)\]]*(remaster|version|edit|mix|live|mono|stereo)[^\)\]]*[\)\]]", "", t, flags=re.I)
    t = re.sub(r"\s+-\s+[^-]*(remaster|version|edit|mix|live|mono|stereo)[^-]*$", "", t, flags=re.I)
    return t.strip() or t


def years_since(iso):
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (datetime.now(timezone.utc) - dt).days / 365.25


def main():
    lf_key = os.environ.get("LASTFM_API_KEY")
    yt_key = os.environ.get("YOUTUBE_API_KEY")
    if not lf_key or not yt_key:
        sys.exit("LASTFM_API_KEY, YOUTUBE_API_KEY 환경 변수가 필요합니다.")

    cache = load_json(CACHE_PATH, {})  # key -> {artist, track, genres, video|None}

    print("현재 차트 불러오는 중…")
    now_playing = current_chart(lf_key, CURRENT_CHART_SIZE)

    # 장르별 후보 수집
    per_genre = {}
    for gid, _, tags in GENRES:
        seen, lst = set(), []
        for tag in tags:
            for artist, track in tag_top_tracks(lf_key, tag, TRACKS_PER_TAG):
                k = key_of(artist, track)
                if k in seen or k in now_playing:
                    continue
                seen.add(k)
                lst.append((k, artist, track))
        per_genre[gid] = lst
        print(f"  {gid}: 후보 {len(lst)}곡")

    # 장르 정보 갱신 (같은 곡이 여러 장르에 속할 수 있음)
    for gid, lst in per_genre.items():
        for k, artist, track in lst:
            entry = cache.setdefault(k, {"artist": artist, "track": track, "genres": []})
            if gid not in entry["genres"]:
                entry["genres"].append(gid)

    # 아직 검색 안 한 곡을 장르 돌아가며 골라서 검색 (특정 장르만 쌓이지 않게)
    queues = {gid: [x for x in lst if "video" not in cache[x[0]]] for gid, lst in per_genre.items()}
    searches = 0
    try:
        while searches < MAX_SEARCHES_PER_RUN and any(queues.values()):
            for gid in list(queues):
                if not queues[gid] or searches >= MAX_SEARCHES_PER_RUN:
                    continue
                k, artist, track = queues[gid].pop(0)
                if "video" in cache[k]:
                    continue
                cache[k]["video"] = find_video(yt_key, artist, track)
                searches += 1
    except QuotaExceeded:
        print("YouTube 할당량 소진 — 여기까지 저장합니다.")
    print(f"이번 실행 검색 {searches}회")

    os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
    with open(CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=1, sort_keys=True)

    # 최종 목록
    songs = []
    for k, e in cache.items():
        v = e.get("video")
        if not v or k in now_playing:
            continue
        if v["views"] < MIN_VIEWS or years_since(v["published"]) < MIN_AGE_YEARS:
            continue
        songs.append({
            "id": v["id"],
            "artist": e["artist"],
            "title": clean_title(e["track"]),
            "genres": e["genres"],
            "views": v["views"],
            "year": int(v["published"][:4]),
        })
    songs.sort(key=lambda s: -s["views"])

    out = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "genres": [{"id": g, "label": label} for g, label, _ in GENRES],
        "songs": songs,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"songs.json: {len(songs)}곡")


if __name__ == "__main__":
    main()
