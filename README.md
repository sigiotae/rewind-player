# Rewind

예전엔 다 들었지만 요즘은 잘 안 듣는 노래를 장르별로 한 곡씩 틀어주는 사이트.

- 탐색: 외국/한국을 고른다. 외국은 장르, 한국은 연간 차트 연도대로 골라 한 곡씩 재생하고, 좋아요를 누른 곡은 내 플리에 모인다.
- 검색: 가수·곡 이름으로 찾아 바로 재생하거나 내 플리에 담는다.
- 내 플리: 링크로 공유(`#pl=곡id.곡id&t=제목`, 서버 불필요)하거나 공유 플리에 올린다.
- 공유 플리: 다른 사람이 올린 플리를 최신·인기순으로 보고, 듣고, 좋아요를 누르고, 내 플리에 담는다.

## 구조

```
site/                 Cloudflare Pages에 배포되는 정적 사이트
  index.html, style.css, app.js
  songs.json          곡 목록 (GitHub Actions가 매일 갱신)
functions/api/[[path]].js  공유 플리 API (Cloudflare Pages Functions + D1)
scripts/build_songs.py  곡 목록 생성 스크립트
scripts/tidy.py         가수·곡 이름 정리, 중복 제거
data/video_cache.json   YouTube 검색 결과 캐시 (할당량 절약)
.github/workflows/update-songs.yml  매일 17:17(KST) 자동 실행
```

## 곡 선정 기준

**한국**: 2000~2020년 연도별 멜론·가온 연간 차트 재생목록(YouTube)에서 곡을 모으고 차트에 오른 해를 기록한다. 차트 연도가 5년 이상 지났고, 조회수 100만 이상이며, Last.fm 한국 현재 인기곡이 아닌 곡만 남긴다.

**외국**: 한글이 들어간 곡과 K-POP은 빼고 아래 기준을 쓴다.

1. YouTube에서 장르·연대별 히트곡 재생목록을 찾아 곡을 한꺼번에 가져오고, Last.fm 장르 태그별 누적 인기곡도 후보로 더한다.
2. Last.fm 현재 글로벌 차트 상위 500곡에 있는 곡은 뺀다.
3. YouTube에서 영상을 찾아 **조회수 3천만 이상**, **업로드 5년 이상** 지난 곡만 남긴다.

기준은 워크플로의 환경 변수 `MIN_VIEWS`, `MIN_AGE_YEARS`로 바꿀 수 있다.
YouTube 할당량(하루 10,000단위, 한국시간 16~17시 초기화) 안에서 매일 새 재생목록을 처리하므로 목록은 며칠에 걸쳐 늘어난다.

## 설정

1. 저장소 **Settings → Secrets and variables → Actions → New repository secret**
   - `LASTFM_API_KEY`
   - `YOUTUBE_API_KEY`
2. **Actions** 탭 → *Update song list* → *Run workflow*로 첫 실행
3. Cloudflare Pages: 이 저장소 연결, 빌드 명령 없음, 출력 디렉터리 `site`
4. 공유 플리: Cloudflare에서 D1 데이터베이스를 만들고, Pages 프로젝트 **Settings → Bindings**에 D1을 변수 이름 `DB`로 연결한 뒤 다시 배포한다. 테이블은 첫 요청 때 자동으로 만들어진다.

처음 올린 `site/songs.json`은 화면 확인용 예시 10곡이며 첫 자동 실행 때 실제 목록으로 바뀐다.

## 로컬 실행

```
npx wrangler pages dev site --d1 DB=local-rewind
```
공유 플리 없이 화면만 볼 때는 `cd site && python3 -m http.server`.
