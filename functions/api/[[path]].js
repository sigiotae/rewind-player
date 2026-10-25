// 공유 플리 API (Cloudflare Pages Functions + D1)
//
//   GET    /api/playlists?sort=new|top&limit=30   목록
//   POST   /api/playlists                          올리기 {title, author, songs:[videoId]}
//   GET    /api/playlists/:id                      상세
//   POST   /api/playlists/:id/like                 좋아요 +1
//   DELETE /api/playlists/:id                      올린 사람만 삭제 (X-Owner-Token 헤더)
//
// Pages 프로젝트에 D1 데이터베이스를 변수 이름 DB 로 연결해야 한다. 테이블은 처음 요청 때 자동으로 만든다.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS playlists (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     author TEXT NOT NULL,
     songs TEXT NOT NULL,
     song_count INTEGER NOT NULL,
     likes INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     owner_hash TEXT NOT NULL,
     ip_hash TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_pl_created ON playlists(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_pl_likes ON playlists(likes DESC, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_pl_ip ON playlists(ip_hash, created_at)`,
  `CREATE TABLE IF NOT EXISTS likes (
     playlist_id TEXT NOT NULL,
     ip_hash TEXT NOT NULL,
     PRIMARY KEY (playlist_id, ip_hash)
   )`,
];

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_SONGS = 100;
const MAX_PER_HOUR = 5; // 같은 접속에서 한 시간에 올릴 수 있는 개수

let schemaReady = false;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomId(len) {
  const abc = "abcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => abc[b % abc.length]).join("");
}

function cleanText(s, max) {
  return String(s ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  schemaReady = true;
}

function summary(row) {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    count: row.song_count,
    likes: row.likes,
    created: row.created_at,
    preview: JSON.parse(row.songs).slice(0, 4),
  };
}

export async function onRequest({ request, env, params }) {
  const db = env.DB;
  if (!db) return json({ error: "공유 플리 저장소가 아직 연결되지 않았어요." }, 503);
  await ensureSchema(db);

  const path = params.path || [];
  const method = request.method;
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const ipHash = await sha256("rewind:" + ip);

  if (path[0] !== "playlists") return json({ error: "없는 주소예요." }, 404);
  const id = path[1];

  // 목록
  if (!id && method === "GET") {
    const url = new URL(request.url);
    const sort = url.searchParams.get("sort") === "top" ? "top" : "new";
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "30", 10) || 30, 1), 60);
    const before = parseInt(url.searchParams.get("before") || "0", 10) || 0;
    const order = sort === "top" ? "likes DESC, created_at DESC" : "created_at DESC";
    const where = sort === "new" && before ? "WHERE created_at < ?1" : "";
    const stmt = db.prepare(`SELECT * FROM playlists ${where} ORDER BY ${order} LIMIT ${limit}`);
    const { results } = await (where ? stmt.bind(before) : stmt).all();
    return json({ items: results.map(summary) });
  }

  // 올리기
  if (!id && method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "잘못된 요청이에요." }, 400);
    }
    const title = cleanText(body.title, 40);
    const author = cleanText(body.author, 20) || "익명";
    const songs = [...new Set((Array.isArray(body.songs) ? body.songs : []).filter((s) => VIDEO_ID.test(s)))].slice(0, MAX_SONGS);
    if (!title) return json({ error: "제목을 적어주세요." }, 400);
    if (songs.length < 1) return json({ error: "곡이 한 곡 이상 있어야 해요." }, 400);

    const hourAgo = Date.now() - 3600_000;
    const recent = await db
      .prepare("SELECT COUNT(*) AS n FROM playlists WHERE ip_hash = ?1 AND created_at > ?2")
      .bind(ipHash, hourAgo)
      .first();
    if (recent && recent.n >= MAX_PER_HOUR) return json({ error: "잠시 후에 다시 올려주세요." }, 429);

    const newId = randomId(8);
    const ownerToken = randomId(24);
    await db
      .prepare(
        "INSERT INTO playlists (id, title, author, songs, song_count, likes, created_at, owner_hash, ip_hash) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8)"
      )
      .bind(newId, title, author, JSON.stringify(songs), songs.length, Date.now(), await sha256(ownerToken), ipHash)
      .run();
    return json({ id: newId, ownerToken }, 201);
  }

  if (!/^[a-z0-9]{8}$/.test(id)) return json({ error: "없는 플레이리스트예요." }, 404);

  // 좋아요 (같은 접속에서 한 번만)
  if (path[2] === "like" && method === "POST") {
    const exists = await db.prepare("SELECT 1 FROM playlists WHERE id = ?1").bind(id).first();
    if (!exists) return json({ error: "없는 플레이리스트예요." }, 404);
    const ins = await db
      .prepare("INSERT OR IGNORE INTO likes (playlist_id, ip_hash) VALUES (?1, ?2)")
      .bind(id, ipHash)
      .run();
    if (ins.meta.changes) await db.prepare("UPDATE playlists SET likes = likes + 1 WHERE id = ?1").bind(id).run();
    const row = await db.prepare("SELECT likes FROM playlists WHERE id = ?1").bind(id).first();
    return json({ likes: row.likes, liked: true });
  }

  if (path.length > 2) return json({ error: "없는 주소예요." }, 404);

  // 상세
  if (method === "GET") {
    const row = await db.prepare("SELECT * FROM playlists WHERE id = ?1").bind(id).first();
    if (!row) return json({ error: "없는 플레이리스트예요." }, 404);
    return json({ ...summary(row), songs: JSON.parse(row.songs) });
  }

  // 삭제 (올린 사람만)
  if (method === "DELETE") {
    const token = request.headers.get("x-owner-token") || "";
    const row = await db.prepare("SELECT owner_hash FROM playlists WHERE id = ?1").bind(id).first();
    if (!row) return json({ error: "없는 플레이리스트예요." }, 404);
    if (!token || (await sha256(token)) !== row.owner_hash) return json({ error: "올린 사람만 지울 수 있어요." }, 403);
    await db.batch([
      db.prepare("DELETE FROM playlists WHERE id = ?1").bind(id),
      db.prepare("DELETE FROM likes WHERE playlist_id = ?1").bind(id),
    ]);
    return json({ deleted: true });
  }

  return json({ error: "지원하지 않는 요청이에요." }, 405);
}
