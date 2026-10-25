/**
 * cbnu-books 릴레이 — 한국 경유지에서 도서관 Pyxis API 를 대신 호출한다.
 *
 * 왜 필요한가:
 *   충북대 방화벽이 Cloudflare 엣지에서 오는 연결을 조용히 드롭한다(측정: 엣지 57%,
 *   한국 일반 IP 100%, 실패는 전부 6초 타임아웃). Worker 가 직접 부르면 신뢰도가
 *   안 나오므로, 한국 IP 를 가진 이 프로세스가 대신 호출해 결과만 돌려준다.
 *
 * 보안:
 *   공개 프록시가 되면 안 되므로 ① 경로를 /pyxis-api/1/ 로 제한, ② 요청마다
 *   HMAC-SHA256 서명(타임스탬프 포함)을 검증, ③ 전역 레이트리밋을 건다.
 *   서명에 타임스탬프가 들어가므로 평문 HTTP 로 떠도 캡처한 요청을 두고두고
 *   재사용할 수 없다(기본 허용 오차 120초).
 *
 * 의존성 없음. Node 18+ 에서 `node relay.mjs` 로 실행.
 *
 * 환경변수:
 *   RELAY_SECRET  (필수) Worker 와 공유하는 비밀키
 *   PORT          (기본 8080)
 *   RATE_LIMIT    (기본 600) 분당 최대 요청 수
 */

import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 8080);
const SECRET = process.env.RELAY_SECRET;
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 600);

const UPSTREAM_ORIGIN = "https://cbnul.chungbuk.ac.kr";
const ALLOW_PREFIX = "/pyxis-api/1/";
const MAX_SKEW_MS = 120_000;
const UPSTREAM_TIMEOUT_MS = 10_000;

if (!SECRET) {
  console.error("RELAY_SECRET 환경변수가 필요합니다.");
  process.exit(1);
}

/* ---------- 레이트리밋 (전역 슬라이딩 윈도) ---------- */
let hits = [];
function rateOk() {
  const now = Date.now();
  hits = hits.filter((t) => now - t < 60_000);
  if (hits.length >= RATE_LIMIT) return false;
  hits.push(now);
  return true;
}

/* ---------- 서명 검증 ---------- */
function signatureOk(ts, sig, path) {
  if (!ts || !sig) return false;
  const skew = Math.abs(Date.now() - Number(ts));
  if (!Number.isFinite(skew) || skew > MAX_SKEW_MS) return false;

  const expected = crypto
    .createHmac("sha256", SECRET)
    .update(`${ts}\n${path}`)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(sig), "utf8");
  // 길이가 다르면 timingSafeEqual 이 던지므로 먼저 거른다.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- 서버 ---------- */
const server = http.createServer(async (req, res) => {
  const send = (status, body, type = "application/json; charset=utf-8") => {
    res.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  if (req.method !== "GET") return send(405, { error: "GET only" });

  // 상태 확인용. 서명 없이 열어두되 아무 정보도 노출하지 않는다.
  if (req.url === "/healthz") return send(200, { ok: true });

  const path = req.url || "";
  if (!path.startsWith(ALLOW_PREFIX)) {
    return send(403, { error: "forbidden path" });
  }
  if (!signatureOk(req.headers["x-cbnu-ts"], req.headers["x-cbnu-sig"], path)) {
    return send(401, { error: "bad signature" });
  }
  if (!rateOk()) return send(429, { error: "rate limited" });

  try {
    const upstream = await fetch(UPSTREAM_ORIGIN + path, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (cbnu-books relay)",
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      "Content-Type":
        upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(text);
  } catch (err) {
    console.error("[upstream]", err.name, err.message);
    send(502, { error: "upstream failed", name: err.name });
  }
});

server.listen(PORT, () => {
  console.log(`cbnu-books relay listening on :${PORT} (rate ${RATE_LIMIT}/min)`);
});
