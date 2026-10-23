# Rewind

예전엔 다 들었지만 요즘은 잘 안 듣는 노래를 장르별로 한 곡씩 틀어주는 사이트.
좋아요를 누른 곡은 내 플레이리스트에 모인다.

## 구조

```
site/                 Cloudflare Pages에 배포되는 정적 사이트
  index.html, style.css, app.js
  songs.json          곡 목록 (GitHub Actions가 매일 갱신)
scripts/build_songs.py  곡 목록 생성 스크립트
data/video_cache.json   YouTube 검색 결과 캐시 (할당량 절약)
.github/workflows/update-songs.yml  매일 03:17(KST) 자동 실행
```

## 곡 선정 기준

1. Last.fm 장르 태그별 누적 인기곡을 후보로 가져온다.
2. Last.fm 현재 글로벌 차트 상위 500곡에 있는 곡은 뺀다.
3. YouTube에서 영상을 찾아 **조회수 3천만 이상**, **업로드 5년 이상** 지난 곡만 남긴다.

기준은 워크플로의 환경 변수 `MIN_VIEWS`, `MIN_AGE_YEARS`로 바꿀 수 있다.
YouTube 할당량 때문에 하루에 약 90곡씩 검색하므로 목록은 며칠에 걸쳐 늘어난다.

## 설정

1. 저장소 **Settings → Secrets and variables → Actions → New repository secret**
   - `LASTFM_API_KEY`
   - `YOUTUBE_API_KEY`
2. **Actions** 탭 → *Update song list* → *Run workflow*로 첫 실행
3. Cloudflare Pages: 이 저장소 연결, 빌드 명령 없음, 출력 디렉터리 `site`

처음 올린 `site/songs.json`은 화면 확인용 예시 10곡이며 첫 자동 실행 때 실제 목록으로 바뀐다.

## 로컬 실행

```
cd site && python3 -m http.server
```
