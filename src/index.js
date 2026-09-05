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

// 표지 프록시로 통과시킬 호스트(접미사 매칭). 실제 Pyxis 데이터에 등장하는 것 + 흔한 서점.
// 아무 URL이나 열어주면 공개 이미지 프록시로 악용되므로 반드시 화이트리스트로 제한한다.
const COVER_HOSTS = [
  "aladin.co.kr",
  "kakaocdn.net",
  "pstatic.net",
  "kyobobook.co.kr",
  "yes24.com",
  "nl.go.kr",
  "chungbuk.ac.kr",
];

/**
 * 엣지 캐시 정책.
 * `fresh` = 이 시간 안이면 그대로 신선한 응답. 지나면 stale 을 즉시 주고 뒤에서 갱신한다.
 * 캐시 API 자체에는 HARD_TTL 만큼 보관시켜(=Cache-Control max-age) 만료로 지워지지 않게 한다.
 * (Workers Cache API 는 stale-while-revalidate 를 스스로 해주지 않으므로 직접 구현.)
 */
const HARD_TTL = 86400; // 캐시 보관 기간(초)
const FRESH = { search: 180, biblio: 1800, cover: 604800 };
const UPSTREAM_TIMEOUT_MS = 6000;

// 보안 헤더. CSP는 외부 표지(img https:)와 인라인 onerror/style('unsafe-inline')을
// 허용해 앱이 깨지지 않게 하면서, 외부 스크립트·object·클릭재킹은 막는다.
const SECURITY = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'self'; object-src 'none'; " +
    "frame-ancestors 'none'; form-action 'self'; " +
    // blob: 은 대출목록 캔버스로 만든 PNG 미리보기용.
    "img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self' 'unsafe-inline'; connect-src 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
};

function json(data, { status = 200, fresh = 0 } = {}) {
  // 브라우저용 Cache-Control. swr 을 넉넉히 줘서 재방문 시 네트워크를 기다리지 않게 한다.
  const cc = fresh
    ? `public, max-age=${fresh}, stale-while-revalidate=${fresh * 8}`
    : "no-store";
  const res = new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cc,
      ...SECURITY,
    },
  });
  // 엣지 캐시가 "언제까지 신선한지" 판단할 근거. 캐시에 저장할 때만 의미가 있다.
  if (fresh) res.headers.set("x-cbnu-fresh", String(fresh));
  return res;
}

/** 캐시에 넣을 사본. 오래 보관되도록 max-age 를 늘리고 저장 시각을 박아둔다. */
function forCache(res) {
  const copy = new Response(res.body, res);
  copy.headers.set("Cache-Control", `public, max-age=${HARD_TTL}`);
  copy.headers.set("x-cbnu-at", String(Date.now()));
  return copy;
}

/** 캐시에서 꺼낸 사본을 브라우저용 헤더로 되돌린다. */
function fromCache(hit, state) {
  const res = new Response(hit.body, hit);
  const fresh = +res.headers.get("x-cbnu-fresh") || FRESH.search;
  res.headers.delete("x-cbnu-at");
  res.headers.set(
    "Cache-Control",
    `public, max-age=${fresh}, stale-while-revalidate=${fresh * 8}`
  );
  res.headers.set("x-cbnu-cache", state);
  return res;
}

/** 저장된 캐시 사본이 아직 신선한가. */
function isFresh(hit) {
  const at = +hit.headers.get("x-cbnu-at") || 0;
  const fresh = +hit.headers.get("x-cbnu-fresh") || FRESH.search;
  return Date.now() - at < fresh * 1000;
}

/** 업스트림에 GET 후 JSON 파싱. 실패·타임아웃 시 throw. */
async function upstreamGet(path) {
  const res = await fetch(UPSTREAM + path, {
    headers: {
      Accept: "application/json",
      // 도서관 서버가 가끔 빈 UA 를 막으므로 평범한 값을 보낸다.
      "User-Agent": "Mozilla/5.0 (cbnul-lite proxy)",
    },
    cf: { cacheTtl: 180, cacheEverything: true },
    // 도서관 서버가 가끔 수 초씩 멈춘다. 무한정 기다리지 않고 끊는다
    // (stale 캐시가 있으면 이미 그걸 돌려준 뒤의 백그라운드 갱신이라 사용자 영향 없음).
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
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

  // 자료유형 우선순위로 페이지 내 재정렬: 국내단행본 → (전자책·서양서·기타 단행본) → 나머지.
  // (Pyxis 정렬 결과를 유형 묶음으로만 재배치, 묶음 안 순서는 유지 = 안정 정렬)
  const items = list.map(normalizeBiblio);
  items.sort((a, b) => typeRank(a.type) - typeRank(b.type));

  return json({ total, page, size, items }, { fresh: FRESH.search });
}

// 자료유형 정렬 순위(작을수록 먼저).
function typeRank(type) {
  const t = type || "";
  if (t === "국내단행본") return 0;
  if (t === "전자책" || t.includes("단행본")) return 1; // 전자책·서양서단행본·기타 단행본
  return 2; // 정기간행물·학위논문·비도서 등
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
    { fresh: FRESH.biblio }
  );
}

/**
 * 표지 이미지 프록시.
 * 목적은 두 가지 — ① 대출목록 이미지를 만들 때 캔버스가 오염(tainted)되지 않게
 * 같은 출처로 이미지를 받아오고(다른 출처 이미지를 그리면 toBlob 이 SecurityError),
 * ② 엣지에 오래 캐싱해 표지 로딩을 빠르게 한다.
 * 화이트리스트 호스트만 통과시켜 공개 이미지 프록시로 악용되는 걸 막는다.
 */
async function handleCover(url) {
  const raw = url.searchParams.get("u") || "";
  let target;
  try {
    target = new URL(raw);
  } catch {
    return json({ error: "잘못된 주소" }, { status: 400 });
  }
  if (target.protocol !== "https:") {
    return json({ error: "https 만 허용" }, { status: 400 });
  }
  const host = target.hostname.toLowerCase();
  const allowed = COVER_HOSTS.some(
    (h) => host === h || host.endsWith("." + h)
  );
  if (!allowed) return json({ error: "허용되지 않은 출처" }, { status: 403 });

  const up = await fetch(target.toString(), {
    headers: { Accept: "image/*", "User-Agent": "Mozilla/5.0 (cbnul-lite proxy)" },
    cf: { cacheTtl: FRESH.cover, cacheEverything: true },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const type = up.headers.get("content-type") || "";
  if (!up.ok || !type.startsWith("image/")) {
    return json({ error: "표지를 가져오지 못했습니다." }, { status: 404 });
  }
  const res = new Response(up.body, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Cache-Control": `public, max-age=${FRESH.cover}, immutable`,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
  res.headers.set("x-cbnu-fresh", String(FRESH.cover));
  return res;
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
    // http(s) 링크만 허용 (javascript:/data: 등 위험 스킴 차단)
    .filter((l) => /^https?:\/\//i.test(l.url));

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

/**
 * 중앙도서관 청구기호(KDC 분류번호) → 층/자료실 위치.
 * (현장 안내판 기준. 중앙도서관에만 적용 — 타 분관은 건물이 달라 알 수 없음.)
 *   000 총류·100 철학·600 예술 → 4층 4-3·4
 *   400 자연·500 기술          → 4층 4-1·2
 *   200 종교                   → 3층 3-3
 *   300 사회과학               → 3층 3-3·4
 *   700 언어·900 역사          → 3층 3-1
 *   800 문학                   → 3층 3-2
 *   서양서(저자기호가 로마자) → 전 주제 4층 4-3·4
 */
const KDC_FLOOR = {
  0: { floor: "4층", room: "4-3·4 자료실" },
  1: { floor: "4층", room: "4-3·4 자료실" },
  2: { floor: "3층", room: "3-3 자료실" },
  3: { floor: "3층", room: "3-3·4 자료실" },
  4: { floor: "4층", room: "4-1·2 자료실" },
  5: { floor: "4층", room: "4-1·2 자료실" },
  6: { floor: "4층", room: "4-3·4 자료실" },
  7: { floor: "3층", room: "3-1 자료실" },
  8: { floor: "3층", room: "3-2 자료실" },
  9: { floor: "3층", room: "3-1 자료실" },
};

function shelfLocation(callNo) {
  if (!callNo) return null;
  const s = callNo.trim();
  // 별치기호(P=정기간행물, R=참고 등)로 시작하면 일반 서가와 위치가 달라 추정하지 않는다.
  if (/^[A-Za-z]{1,3}\s+\d/.test(s)) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(\S*)/);
  if (!m) return null;
  // 저자기호가 로마자면 서양서 → 전 주제 4층 4-3·4
  if (/^[A-Za-z]/.test(m[2])) return { floor: "4층", room: "4-3·4 자료실" };
  return KDC_FLOOR[+m[1][0]] || null;
}

/**
 * 대출상태 코드 표준화.
 * Pyxis 의 cStateCode 는 대출가능을 "READY" 로 주는데, 프론트는 "AVAILABLE"/
 * "NOT_AVAILABLE" 만 색으로 처리한다. 여기서 한 번에 표준 코드로 맞춘다.
 * (정확한 한글 상태 텍스트는 cState 로 그대로 전달되니 표시는 영향 없음.)
 */
function canonStateCode(code, text) {
  if (code === "READY" || code === "AVAILABLE") return "AVAILABLE";
  if (code === "NOT_AVAILABLE") return "NOT_AVAILABLE";
  // 알 수 없는 코드는 상태 텍스트로 추정 ("…가능" 이면 대출가능).
  if (typeof text === "string" && text.includes("가능")) return "AVAILABLE";
  return "NOT_AVAILABLE";
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
    holdings: (r.branchVolumes || []).map((b) => {
      const callNo = b.volume && b.volume !== "-" ? b.volume : null;
      return {
        branch: b.name,
        state: b.cState, // "대출가능" / "대출불가" ... (표시용 원문)
        stateCode: canonStateCode(b.cStateCode, b.cState), // "AVAILABLE" / "NOT_AVAILABLE"
        callNo,
        // 층 안내판은 중앙도서관 전용이라 타 분관은 null.
        location: b.name === "중앙도서관" ? shelfLocation(callNo) : null,
      };
    }),
  };
}

/** 경로 → 실제 처리. 캐시 갱신에서도 같은 함수를 재사용한다. */
function route(url) {
  if (url.pathname === "/api/search") return handleSearch(url);
  if (url.pathname === "/api/cover") return handleCover(url);
  const m = url.pathname.match(/^\/api\/biblio\/(.+)$/);
  if (m) return handleBiblio(m[1]);
  return Promise.resolve(json({ error: "not found" }, { status: 404 }));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: SECURITY });
    }

    if (url.pathname.startsWith("/api/")) {
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), { method: "GET" });
      const hit = await cache.match(cacheKey);

      // 캐시가 있으면 신선하든 아니든 **즉시** 돌려준다. 오래됐으면 응답을 보낸 뒤
      // 백그라운드로 갱신(stale-while-revalidate) → 사용자는 업스트림을 기다리지 않는다.
      if (hit) {
        if (isFresh(hit)) return fromCache(hit, "HIT");
        ctx.waitUntil(
          route(url)
            .then((fresh) =>
              fresh.ok ? cache.put(cacheKey, forCache(fresh)) : null
            )
            .catch(() => {}) // 갱신 실패는 조용히 무시 (다음 요청에서 재시도)
        );
        return fromCache(hit, "STALE");
      }

      // Rate limit: 캐시 미스(=실제 업스트림 호출)에만 IP당 적용 → 일반 사용자엔 무영향,
      // 남용·도서관 서버 보호용. 바인딩 미가용 시 조용히 통과(부작용 방지).
      if (env.RATE_LIMITER) {
        const ip = request.headers.get("cf-connecting-ip") || "anon";
        try {
          const { success } = await env.RATE_LIMITER.limit({ key: ip });
          if (!success) {
            return json(
              { error: "요청이 너무 많습니다. 잠시 후 다시 시도하세요." },
              { status: 429 }
            );
          }
        } catch (_) {
          /* 바인딩 문제 시 무시하고 진행 */
        }
      }

      try {
        const res = await route(url);
        // 성공 응답만 캐시에 저장(에러/빈검색 제외). 저장은 응답 반환을 막지 않게 비동기로.
        if (res.ok) {
          const store = forCache(res.clone());
          ctx.waitUntil(cache.put(cacheKey, store));
        }
        return res;
      } catch (err) {
        return json(
          { error: "도서관 서버 응답 오류", detail: String(err) },
          { status: 502 }
        );
      }
    }

    // 정적 자산 (보안 헤더를 입혀 반환)
    const asset = await env.ASSETS.fetch(request);
    const out = new Response(asset.body, asset);
    for (const [k, v] of Object.entries(SECURITY)) out.headers.set(k, v);
    return out;
  },
};
