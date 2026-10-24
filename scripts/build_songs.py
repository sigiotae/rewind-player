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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tidy import tidy_songs  # noqa: E402

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
MAX_SEARCHES_PER_RUN = int(os.environ.get("MAX_SEARCHES_PER_RUN", 60))

LASTFM_URL = "https://ws.audioscrobbler.com/2.0/"
YT_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
YT_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"
YT_PLAYLIST_ITEMS_URL = "https://www.googleapis.com/youtube/v3/playlistItems"


def http_get_json(url, params):
    full = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(full, headers={"User-Agent": "rewind-player/1.0"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "ignore")
            if e.code in (403, 429) and "quota" in body.lower():
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


# ---------- YouTube 인기 재생목록 수집 ----------
# 곡마다 검색하면 하루 약 90곡이 한계라서, 장르별 '그 시절 히트곡' 재생목록을 찾아
# 통째로 가져온다. 재생목록 검색 1회(100단위)로 곡 수백 개를 1~2단위에 확인할 수 있다.

PLAYLIST_QUERIES = {
    "pop": ["90s pop hits", "2000s pop hits", "2010s pop hits", "best pop songs 2005", "best pop songs 2012",
            "throwback pop songs", "early 2000s pop songs"],
    "dance": ["90s dance hits", "2000s dance hits", "2010s dance hits", "eurodance 90s", "2000s club hits",
              "party anthems 2010s"],
    "hiphop": ["90s hip hop hits", "2000s hip hop hits", "2010s hip hop hits", "old school hip hop classics",
               "2000s rap hits", "2010s rap hits"],
    "rnb": ["90s r&b hits", "2000s r&b hits", "2010s r&b hits", "90s r&b slow jams", "2000s rnb love songs"],
    "rock": ["90s rock hits", "2000s rock hits", "2010s rock hits", "2000s alternative rock", "90s grunge hits",
             "pop punk 2000s", "2000s emo songs"],
    "indie": ["2000s indie rock hits", "2010s indie pop hits", "indie classics 2000s", "2010s indie hits",
              "indie folk 2010s", "indie rock anthems", "alternative indie 2000s playlist", "tumblr indie songs 2013",
              "indie sleaze playlist"],
    "electronic": ["2000s electronic hits", "2010s edm hits", "edm classics 2012", "electro house 2010",
                   "dubstep 2011 hits", "progressive house classics", "trance classics 2000s",
                   "electronic music 2000s classics", "future bass 2016 hits"],
    "ballad": ["2000년대 발라드 명곡", "2010년대 발라드 명곡", "2000s love ballads", "90년대 발라드 명곡",
               "90s love songs", "power ballads"],
    "kpop": ["2000s kpop hits", "2010s kpop hits", "2세대 아이돌 노래 모음", "3세대 아이돌 명곡",
             "2010년대 가요 히트곡", "kpop 2012 hits", "kpop 2016 hits"],
    "latin": ["2000s reggaeton hits", "2010s latin hits", "reggaeton old school", "latin pop 2000s",
              "bachata hits 2010s"],
}
PLAYLISTS_PER_QUERY = 3
MAX_ITEMS_PER_PLAYLIST = 200
UNIT_BUDGET = int(os.environ.get("UNIT_BUDGET", 9500))  # 하루 할당량 10,000 중 여유를 남김

NOT_A_SONG = re.compile(r"full album|playlist|\b\d+\s*hours?\b|1 hour|compilation|megamix|non-?stop|노래\s*모음|연속\s*듣기", re.I)


class Units:
    def __init__(self, budget):
        self.budget, self.used = budget, 0

    def spend(self, n):
        if self.used + n > self.budget:
            raise QuotaExceeded("budget")
        self.used += n


def split_title(title, channel):
    """'Artist - Song (Official Video)' 형태의 영상 제목에서 가수와 곡 이름을 뽑는다."""
    t = re.sub(r"[\(\[【][^\)\]】]*(official|video|audio|lyric|m/?v|visualizer|hd|4k|remaster|가사|뮤직비디오)[^\)\]】]*[\)\]】]", "", title, flags=re.I)
    t = re.sub(r"^\s*\[(m/?v|mv|teaser)\]\s*", "", t, flags=re.I)
    t = re.sub(r"\s*(official\s*(music\s*)?video|official\s*audio|lyric\s*video|lyrics?|m/?v|music\s*video)\s*$", "", t, flags=re.I)
    t = t.strip()
    for sep in (" - ", " – ", " — ", " _ ", " | "):
        if sep in t:
            a, b = t.split(sep, 1)
            return a.strip(), b.strip(" \"'“”")
    m = re.match(r"^(.+?)\s*[\"“'‘]([^\"”'’]+)[\"”'’]", t)  # Artist "Song" 형태
    if m:
        return m.group(1).strip(), m.group(2).strip()
    ch = re.sub(r"\s*-\s*Topic$|VEVO$|\s*Official$", "", channel, flags=re.I).strip()
    return ch, t.strip(" \"'“”")


def search_playlists(yt_key, query, units):
    units.spend(100)
    data = http_get_json(YT_SEARCH_URL, {
        "part": "id", "q": query, "type": "playlist",
        "maxResults": PLAYLISTS_PER_QUERY, "key": yt_key,
    })
    return [it["id"]["playlistId"] for it in data.get("items", []) if it.get("id", {}).get("playlistId")]


def playlist_video_ids(yt_key, pid, units):
    ids, token = [], None
    while len(ids) < MAX_ITEMS_PER_PLAYLIST:
        units.spend(1)
        params = {"part": "contentDetails", "playlistId": pid, "maxResults": 50, "key": yt_key}
        if token:
            params["pageToken"] = token
        try:
            data = http_get_json(YT_PLAYLIST_ITEMS_URL, params)
        except RuntimeError:
            break  # 비공개·삭제된 재생목록
        ids += [it["contentDetails"]["videoId"] for it in data.get("items", [])]
        token = data.get("nextPageToken")
        if not token:
            break
    return ids


def video_details(yt_key, ids, units):
    out = []
    for i in range(0, len(ids), 50):
        units.spend(1)
        data = http_get_json(YT_VIDEOS_URL, {
            "part": "snippet,statistics,status", "id": ",".join(ids[i:i + 50]), "key": yt_key,
        })
        out += data.get("items", [])
    return out


def harvest_playlists(yt_key, cache, units):
    meta = cache.setdefault("__meta__", {"queries_done": [], "playlists_done": []})
    id_to_key = {e["video"]["id"]: k for k, e in cache.items() if not k.startswith("__") and e.get("video")}
    added = 0
    for gid, queries in PLAYLIST_QUERIES.items():
        for q in queries:
            if q in meta["queries_done"]:
                continue
            for pid in search_playlists(yt_key, q, units):
                if pid in meta["playlists_done"]:
                    continue
                vids = []
                for vid in playlist_video_ids(yt_key, pid, units):
                    if vid in id_to_key:  # 이미 아는 곡이면 장르만 추가
                        g = cache[id_to_key[vid]]["genres"]
                        if gid not in g:
                            g.append(gid)
                    else:
                        vids.append(vid)
                for v in video_details(yt_key, vids, units):
                    sn = v["snippet"]
                    views = int(v.get("statistics", {}).get("viewCount", 0))
                    if not v.get("status", {}).get("embeddable", False) or views < MIN_VIEWS:
                        continue
                    if NOT_A_SONG.search(sn["title"]):
                        continue
                    artist, track = split_title(sn["title"], sn.get("channelTitle", ""))
                    if not artist or not track:
                        continue
                    k = key_of(artist, track)
                    entry = cache.setdefault(k, {"artist": artist, "track": track, "genres": []})
                    if not entry.get("video"):
                        entry["video"] = {"id": v["id"], "views": views, "published": sn["publishedAt"],
                                          "ytTitle": sn["title"], "channel": sn.get("channelTitle", "")}
                        id_to_key[v["id"]] = k
                        added += 1
                    if gid not in entry["genres"]:
                        entry["genres"].append(gid)
                meta["playlists_done"].append(pid)
            meta["queries_done"].append(q)
            print(f"  재생목록 '{q}' 완료 (누적 {added}곡, {units.used}단위)")
    return added


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


def build_list(cache, now_playing):
    """캐시에서 조건(조회수·연도·현재 차트 제외)에 맞는 곡을 골라 이름을 정리한다."""
    by_id = {}
    for k, e in cache.items():
        if k.startswith("__"):
            continue
        v = e.get("video")
        if not v or k in now_playing or not e.get("genres"):
            continue
        if v["views"] < MIN_VIEWS or years_since(v["published"]) < MIN_AGE_YEARS:
            continue
        if v["id"] in by_id:
            for g in e["genres"]:
                if g not in by_id[v["id"]]["genres"]:
                    by_id[v["id"]]["genres"].append(g)
            continue
        by_id[v["id"]] = {
            "id": v["id"],
            "artist": e["artist"],
            "title": clean_title(e["track"]),
            "genres": list(e["genres"]),
            "views": v["views"],
            "year": int(v["published"][:4]),
        }
    return tidy_songs(list(by_id.values()))


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

    units = Units(UNIT_BUDGET)
    searches = 0
    try:
        # 1) 인기 재생목록에서 한꺼번에 수집 (할당량 대비 곡 수가 훨씬 많음)
        print("재생목록 수집 중…")
        added = harvest_playlists(yt_key, cache, units)
        print(f"재생목록에서 새로 찾은 곡 {added}곡")

        # 2) 남은 할당량으로 Last.fm 후보를 한 곡씩 검색 (장르 돌아가며)
        queues = {gid: [x for x in lst if "video" not in cache[x[0]]] for gid, lst in per_genre.items()}
        while searches < MAX_SEARCHES_PER_RUN and any(queues.values()):
            for gid in list(queues):
                if not queues[gid] or searches >= MAX_SEARCHES_PER_RUN:
                    continue
                k, artist, track = queues[gid].pop(0)
                if "video" in cache[k]:
                    continue
                units.spend(101)
                cache[k]["video"] = find_video(yt_key, artist, track)
                searches += 1
    except QuotaExceeded:
        print("YouTube 할당량 소진 — 여기까지 저장합니다.")
    except Exception as e:  # 예기치 못한 오류가 나도 지금까지 모은 결과는 저장
        print(f"수집 중 오류 — 여기까지 저장합니다: {e}")
    print(f"이번 실행: 곡 검색 {searches}회, 사용 {units.used}단위")

    os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
    with open(CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=1, sort_keys=True)

    songs = build_list(cache, now_playing)

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
