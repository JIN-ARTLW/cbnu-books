/**
 * cbnul-lite — 충북대학교 도서관 장서검색 (경량 버전)
 *
 * 단일 Cloudflare Worker 가 두 가지 역할을 한다:
 *   1) /api/*  → 충북대 Pyxis API 프록시 (브라우저 CORS 우회 + 캐싱)
 *   2) 그 외   → public/ 정적 자산 서빙 (env.ASSETS)
 *
 * Pyxis 검색 호출 형식 (직접 확인함):
 *   GET /pyxis-api/1/collections/2/search
 *       ?all=k|a|검색어        ← 필드명=매치타입|연산자|값  (k=키워드, a=AND)
 *       &facet=false&fuzzy=false&max=20&offset=0
 *       &isForPyxis3=true       ← 이게 없으면 parameterMissing
 *   collection 2 = 전체 장서
 */

const UPSTREAM = "https://cbnul.chungbuk.ac.kr/pyxis-api/1";
const COLLECTION = "2"; // 전체 장서
const ALLOWED_FIELDS = new Set(["all", "title", "author", "publisher"]);
const ALLOWED_SORTS = new Set(["score", "PUBLISH_YEAR", "TITLE", "AUTHOR"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, { status = 200, maxAge = 0 } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store",
      ...CORS,
    },
  });
}

/** 업스트림에 GET 후 JSON 파싱. 실패 시 throw. */
async function upstreamGet(path) {
  const res = await fetch(UPSTREAM + path, {
    headers: {
      Accept: "application/json",
      // 도서관 서버가 가끔 빈 UA 를 막으므로 평범한 값을 보낸다.
      "User-Agent": "Mozilla/5.0 (cbnul-lite proxy)",
    },
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return res.json();
}

async function handleSearch(url) {
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ error: "검색어가 비어 있습니다." }, { status: 400 });

  const field = ALLOWED_FIELDS.has(url.searchParams.get("field"))
    ? url.searchParams.get("field")
    : "all";
  const size = Math.min(Math.max(+url.searchParams.get("size") || 20, 1), 50);
  const page = Math.max(+url.searchParams.get("page") || 1, 1);
  const offset = (page - 1) * size;
  const sort = ALLOWED_SORTS.has(url.searchParams.get("sort"))
    ? url.searchParams.get("sort")
    : "score";
  const order = url.searchParams.get("order") === "ASC" ? "ASC" : "DESC";

  // Pyxis 값 형식: 매치타입(k) | 연산자(a) | 검색어
  const value = `k|a|${q}`;
  const params = new URLSearchParams({
    [field]: value,
    facet: "false",
    fuzzy: "false",
    max: String(size),
    offset: String(offset),
    isForPyxis3: "true",
  });
  if (sort !== "score") {
    params.set("sort", sort);
    params.set("order", order);
  }

  const raw = await upstreamGet(
    `/collections/${COLLECTION}/search?${params.toString()}`
  );
  const data = raw?.data;
  const list = data && typeof data === "object" ? data.list || [] : [];
  const total =
    data && typeof data === "object" && typeof data.totalCount === "number"
      ? data.totalCount
      : 0;

  return json(
    {
      total,
      page,
      size,
      items: list.map(normalizeBiblio),
    },
    { maxAge: 60 }
  );
}

async function handleBiblio(id) {
  if (!/^\d+$/.test(id)) return json({ error: "잘못된 id" }, { status: 400 });
  const raw = await upstreamGet(`/biblios/${id}?isForPyxis3=true`);
  const rec = raw?.data?.list?.[0];
  if (!rec) return json({ error: "자료를 찾을 수 없습니다." }, { status: 404 });

  return json(
    {
      id,
      title: rec.titleStatement || "",
      author: rec.author || "",
      publication: rec.publication || "",
      isbn: rec.isbn || null,
      thumbnail: cleanThumb(rec.thumbnail),
      type: rec.biblioType?.name || rec.materialType?.name || "",
      // content 는 책 소개가 아니라 MARC 레코드라 파싱해서 의미있는 항목만.
      marc: parseMarc(rec.content),
    },
    { maxAge: 600 }
  );
}

/**
 * Pyxis 의 content(MARC JSON)를 사람이 읽을 서지정보로 변환.
 * data field 구조: [tag, ind1, ind2, [[subcode, value], ...]]
 * control field 구조: [tag, value]
 */
function parseMarc(content) {
  let m;
  try {
    m = typeof content === "string" ? JSON.parse(content) : content;
  } catch {
    return null;
  }
  if (!m || !Array.isArray(m.fields)) return null;
  const fields = m.fields;
  const df = (tag) => fields.filter((f) => f[0] === tag);
  const subs = (f) => (Array.isArray(f[3]) ? f[3] : []);
  const sv = (f, ...codes) =>
    subs(f)
      .filter((s) => !codes.length || codes.includes(s[0]))
      .map((s) => s[1])
      .join(" ");
  const first = (tag, ...codes) => {
    const f = df(tag)[0];
    return f ? sv(f, ...codes).trim() : "";
  };
  const clean = (s) => s.replace(/\s*[\/:;,]\s*$/, "").trim();

  const subjects = [
    ...new Set(
      [...df("650"), ...df("653")].map((f) => clean(sv(f, "a"))).filter(Boolean)
    ),
  ];
  const links = df("856")
    .map((f) => ({ label: sv(f, "3") || sv(f, "z") || "관련 링크", url: sv(f, "u") }))
    .filter((l) => l.url);

  return {
    physical: clean(first("300")), // 형태사항 (예: 215 p. ; 22 cm)
    series: clean(first("490", "a") || first("440", "a")), // 총서
    abstract: first("520", "a"), // 초록/책소개 (있을 때만)
    toc: first("505", "a"), // 목차
    subjects,
    links,
  };
}

/**
 * 표지 URL 정리.
 * - 절대 URL(알라딘·네이버·카카오 등): http→https 로 통일해 그대로 사용.
 * - 상대경로(도서관 자체 스캔본 /attachments/...): 외부에서 직접 접근이 안 되므로
 *   null 처리해 placeholder 로 대체한다. (404 방지)
 */
function cleanThumb(u) {
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u.replace(/^http:\/\//i, "https://");
  return null;
}

/** 검색 레코드에서 프론트가 쓰는 필드만 추린다. */
function normalizeBiblio(r) {
  return {
    id: r.id,
    title: r.titleStatement || "",
    author: r.author || "",
    publication: r.publication || "",
    isbn: r.isbn || null,
    thumbnail: cleanThumb(r.thumbnailUrl),
    type: r.biblioType?.name || r.materialType?.name || "",
    received: r.dateReceived || null,
    holdings: (r.branchVolumes || []).map((b) => ({
      branch: b.name,
      state: b.cState, // "대출가능" / "대출불가" ...
      stateCode: b.cStateCode, // "AVAILABLE" / "NOT_AVAILABLE" ...
      callNo: b.volume && b.volume !== "-" ? b.volume : null,
    })),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        if (url.pathname === "/api/search") return await handleSearch(url);
        const m = url.pathname.match(/^\/api\/biblio\/(.+)$/);
        if (m) return await handleBiblio(m[1]);
        return json({ error: "not found" }, { status: 404 });
      } catch (err) {
        return json(
          { error: "도서관 서버 응답 오류", detail: String(err) },
          { status: 502 }
        );
      }
    }

    // 정적 자산
    return env.ASSETS.fetch(request);
  },
};
