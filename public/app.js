"use strict";

const $ = (sel) => document.querySelector(sel);
const el = {
  form: $("#searchForm"),
  q: $("#q"),
  field: $("#field"),
  sort: $("#sort"),
  meta: $("#meta"),
  count: $("#count"),
  status: $("#status"),
  intro: $("#intro"),
  suggest: $("#suggest"),
  results: $("#results"),
  pager: $("#pager"),
  modal: $("#modal"),
  modalBody: $("#modal-body"),
};

const PAGE_SIZE = 20;
// 마지막 검색 결과 캐시(id -> item). 상세 모달과 담기 버튼이 소장정보를 재활용한다.
const itemCache = new Map();
window.itemCache = itemCache; // cart.js 가 담을 때 참조
let state = { q: "", field: "all", sort: "score", page: 1 };

/* ---------- 네트워크 (메모리 캐시 + 프리페치) ---------- */
/*
 * 같은 URL 은 한 번만 가져온다. 자동완성이 이미 받아온 응답을 검색 실행이 그대로
 * 재사용하도록 URL 을 searchUrl() 하나로 통일한 게 핵심 — 엔터를 눌러도 네트워크가
 * 아예 발생하지 않는다. (엣지 캐시까지 못 가고 여기서 끝남)
 */
const NET_TTL = 120000;
const netCache = new Map(); // url -> { t, data }
const inflight = new Map(); // url -> Promise (동시 중복 요청 합치기)

async function getJSON(url) {
  const hit = netCache.get(url);
  if (hit && Date.now() - hit.t < NET_TTL) return hit.data;
  if (inflight.has(url)) return inflight.get(url);

  const p = (async () => {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) {
      // Worker 가 알려준 분류를 그대로 달아둔다 — 호출부가 재시도 여부를 판단한다.
      const err = new Error(data.error || "요청에 실패했습니다.");
      err.code = data.code;
      err.retryable = !!data.retryable;
      err.status = res.status;
      throw err;
    }
    // 업스트림이 죽어 묵은 캐시가 내려온 경우를 화면에 알릴 수 있게 나이를 함께 둔다.
    data._age = +res.headers.get("x-cbnu-age") || 0;
    netCache.set(url, { t: Date.now(), data });
    if (netCache.size > 80) netCache.delete(netCache.keys().next().value);
    return data;
  })();
  inflight.set(url, p);
  try {
    return await p;
  } finally {
    inflight.delete(url);
  }
}

/** 캐시에 이미 있으면 그 자리에서 꺼낸다(동기). 없으면 null. */
function peekJSON(url) {
  const hit = netCache.get(url);
  return hit && Date.now() - hit.t < NET_TTL ? hit.data : null;
}

/** 검색 URL. 자동완성·검색·프리페치가 **반드시** 같은 문자열을 만들어야 캐시가 공유된다. */
function searchUrl(q, field, sort, page) {
  return (
    "/api/search?" +
    new URLSearchParams({
      q: q.trim(),
      field,
      sort,
      page: String(page),
      size: String(PAGE_SIZE),
    })
  );
}

const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1));
function prefetch(url) {
  if (peekJSON(url) || inflight.has(url)) return;
  idle(() => getJSON(url).catch(() => {}));
}

/* ---------- 유틸 ---------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function holdingClass(code) {
  if (code === "AVAILABLE") return "ok";
  if (code === "NOT_AVAILABLE") return "no";
  return "";
}

// 청구기호가 여러 개(쉼표 구분)면 쉼표 대신 줄바꿈으로 분리해 표시한다.
function callNoHtml(callNo) {
  if (!callNo) return "-";
  return callNo
    .split(",")
    .map((s) => esc(s.trim()))
    .filter(Boolean)
    .join("<br>");
}

/* ---------- URL <-> 상태 ---------- */
function readUrl() {
  const p = new URLSearchParams(location.search);
  state.q = p.get("q") || "";
  state.field = p.get("field") || "all";
  state.sort = p.get("sort") || "score";
  state.page = Math.max(+p.get("page") || 1, 1);
  el.q.value = state.q;
  el.field.value = state.field;
  el.sort.value = state.sort;
}

function writeUrl(push) {
  const p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  if (state.field !== "all") p.set("field", state.field);
  if (state.sort !== "score") p.set("sort", state.sort);
  if (state.page > 1) p.set("page", state.page);
  const url = location.pathname + (p.toString() ? "?" + p : "");
  if (push) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
}

/* ---------- 검색 ---------- */
async function search(attempt = 0) {
  if (!state.q.trim()) {
    el.meta.hidden = true;
    el.results.innerHTML = "";
    el.pager.hidden = true;
    el.intro.hidden = false;
    el.status.textContent = "";
    el.status.className = "status";
    return;
  }
  el.intro.hidden = true;
  el.status.className = "status";
  if (attempt === 0) clearTimeout(retryTimer); // 사용자가 새로 검색하면 재시도 중단

  const url = searchUrl(state.q, state.field, state.sort, state.page);

  // 자동완성이 이미 받아둔 결과면 즉시 그린다 (네트워크·깜빡임 없음).
  const cached = peekJSON(url);
  if (cached) {
    el.status.textContent = "";
    renderResults(cached);
    return;
  }

  el.status.textContent = "";
  el.results.innerHTML = skeletonHtml();
  el.pager.hidden = true;

  const seq = ++searchSeq;
  try {
    const data = await getJSON(url);
    if (seq !== searchSeq) return; // 더 최근 검색이 시작됐으면 버린다
    renderResults(data);
  } catch (err) {
    if (seq !== searchSeq) return;
    el.meta.hidden = true;
    el.pager.hidden = true;
    el.results.innerHTML = "";
    if (err.retryable) {
      lastFailAt = Date.now();
      showUpstreamError(seq, attempt);
    }
    else {
      el.status.textContent = "오류: " + err.message;
      el.status.className = "status error";
    }
  }
}

let searchSeq = 0;
let retryTimer = null;
let lastFailAt = 0; // 마지막 업스트림 실패 시각 (차단 창 판단용)

function inBlockWindow() {
  return Date.now() - lastFailAt < BLOCK_WINDOW_MS;
}

/*
 * 도서관 서버 연결 실패는 대체로 일시적이라, 빈 화면에 에러만 띄우지 않고
 * 자동으로 몇 번 더 시도한다. 새 검색이 시작되면 seq 가 어긋나 조용히 멈춘다.
 */
/*
 * 간격은 실측으로 정했다(2026-10-25). 실패 직후 2초·5초 재시도는 **반드시** 또 실패하고
 * 10초를 넘겨야 회복된다 — 도서관 방화벽의 차단 창이 5~10초이고, 그동안 Cloudflare 도
 * 연결 실패를 캐싱해 같은 530 을 2ms 만에 돌려주기 때문. 빨리 여러 번 때리는 것보다
 * 한 번을 늦게 때리는 쪽이 압도적으로 낫다.
 *
 *   지연:      2s   5s   10s  20s  30s  45s
 *   라운드 1:  503  503  200  200  200  200
 *   라운드 2:  503  503  200  200  200  200
 */
const RETRY_DELAYS = [10000, 20000, 30000];
const BLOCK_WINDOW_MS = 10000; // 이 시간 안엔 재요청해도 어차피 실패한다

function showUpstreamError(seq, attempt) {
  clearTimeout(retryTimer);
  const willRetry = attempt < RETRY_DELAYS.length;
  const wait = willRetry ? RETRY_DELAYS[attempt] : 0;

  el.status.className = "status";
  el.status.innerHTML = `
    <div class="failbox">
      <p class="fail-title">도서관 서버에 연결하지 못했습니다</p>
      <p class="fail-sub">충북대 도서관 서버가 잠시 연결을 받지 않고 있습니다.<br />
        보통 10초쯤 뒤면 풀립니다.</p>
      <p class="fail-sub" id="retryNote">${
        willRetry
          ? `<span id="retrySec">${Math.ceil(wait / 1000)}</span>초 후 자동으로 다시 시도합니다…`
          : "자동 재시도를 모두 마쳤습니다."
      }</p>
      <div class="fail-actions">
        <button type="button" id="retryNow">지금 다시 시도</button>
        <a class="ext-link" target="_blank" rel="noopener"
           href="https://cbnul.chungbuk.ac.kr">충북대 도서관에서 검색 ↗</a>
      </div>
    </div>`;

  const retryNow = document.getElementById("retryNow");
  if (retryNow) {
    retryNow.addEventListener("click", () => {
      clearTimeout(retryTimer);
      search(0);
    });
  }

  if (!willRetry) return;

  // 남은 시간 카운트다운
  let left = Math.ceil(wait / 1000);
  const tick = setInterval(() => {
    if (seq !== searchSeq) return clearInterval(tick);
    left -= 1;
    const span = document.getElementById("retrySec");
    if (span && left > 0) span.textContent = String(left);
    if (left <= 0) clearInterval(tick);
  }, 1000);

  retryTimer = setTimeout(() => {
    clearInterval(tick);
    if (seq !== searchSeq) return; // 그 사이 사용자가 새로 검색함
    search(attempt + 1);
  }, wait);
}

// 결과를 기다리는 동안의 자리표시자. 빈 화면보다 체감이 빠르고 레이아웃도 안 튄다.
function skeletonHtml() {
  return Array.from(
    { length: 6 },
    () => `<li class="card skel" aria-hidden="true">
      <div class="cover"></div>
      <div class="card-body">
        <span class="sk-line w30"></span>
        <span class="sk-line w80"></span>
        <span class="sk-line w50"></span>
      </div>
    </li>`
  ).join("");
}

function renderResults(data) {
  itemCache.clear();
  data.items.forEach((it) => itemCache.set(String(it.id), it));

  if (data.total === 0) {
    el.meta.hidden = true;
    el.status.textContent = `'${state.q}' 검색 결과가 없습니다.`;
    return;
  }
  el.status.textContent = "";
  el.meta.hidden = false;
  el.count.innerHTML =
    `전체 <strong>${data.total.toLocaleString()}</strong>건` + staleNote(data._age);

  el.results.innerHTML = data.items.map(cardHtml).join("");
  fitCallNos();
  renderPager(data.total);
  Cart.syncButtons();

  // 다음 페이지를 미리 받아둔다 → 페이지 넘김이 즉시.
  if (state.page * PAGE_SIZE < data.total) {
    prefetch(searchUrl(state.q, state.field, state.sort, state.page + 1));
  }
}

/*
 * 도서관 서버가 오래 죽어 있으면 꽤 묵은 캐시가 내려올 수 있다. 그때 대출상태가
 * 실제와 다를 수 있으니 한 시간을 넘긴 자료는 언제 기준인지 밝힌다.
 */
function staleNote(ageSec) {
  if (!ageSec || ageSec < 3600) return "";
  const h = Math.floor(ageSec / 3600);
  const label = h < 24 ? `${h}시간 전` : `${Math.floor(h / 24)}일 전`;
  return ` <span class="stale" title="도서관 서버에 연결되지 않아 저장해 둔 결과를 보여줍니다">· ${label} 정보</span>`;
}

// 청구기호가 타입칩 옆 남은 폭을 넘치면 줄바꿈 대신 글자 크기를 줄여 한 줄에 맞춘다.
function fitCallNos() {
  el.results.querySelectorAll(".callno").forEach((node) => {
    let fs = 11;
    node.style.fontSize = fs + "px";
    let guard = 0;
    while (node.scrollWidth > node.clientWidth + 0.5 && fs > 8 && guard++ < 12) {
      fs -= 0.5;
      node.style.fontSize = fs + "px";
    }
  });
}

function cardHtml(it) {
  const cover = it.thumbnail
    ? `<img class="cover" loading="lazy" src="${esc(
        it.thumbnail
      )}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'cover placeholder',textContent:'📕'}))" />`
    : `<div class="cover placeholder">📕</div>`;

  const holds = (it.holdings || [])
    .slice(0, 4)
    .map(
      (h) =>
        `<span class="chip ${holdingClass(h.stateCode)}"><span class="dot"></span>${esc(
          h.branch
        )}${h.location ? " " + esc(h.location.floor) : ""} · ${esc(
          h.state || ""
        )}</span>`
    )
    .join("");

  // 제일 위(첫) 소장의 청구기호 한 개만 타입칩 옆에 연하게.
  const firstCall = (it.holdings || []).map((h) => h.callNo).find(Boolean);
  const callNo = firstCall ? esc(firstCall.split(",")[0].trim()) : "";
  const head =
    it.type || callNo
      ? `<div class="card-head">${
          it.type ? `<span class="type">${esc(it.type)}</span>` : ""
        }${
          callNo ? `<span class="callno" title="청구기호">${callNo}</span>` : ""
        }</div>`
      : "";

  return `<li class="card" data-id="${it.id}" tabindex="0" role="button">
    ${cover}
    <div class="card-body">
      ${head}
      <h3>${esc(it.title)}</h3>
      <p class="by">${esc(it.author || "저자 미상")}${
    it.publication ? " · " + esc(it.publication) : ""
  }</p>
      <div class="holdings">${holds || ""}</div>
    </div>
    <button class="cart-add" data-cart="${it.id}" type="button"
            aria-label="대출 목록에 담기"></button>
  </li>`;
}

function renderPager(total) {
  const pages = Math.min(Math.ceil(total / PAGE_SIZE), 500); // 안전 상한
  if (pages <= 1) {
    el.pager.hidden = true;
    return;
  }
  const cur = state.page;
  const win = 2;
  let from = Math.max(1, cur - win);
  let to = Math.min(pages, cur + win);
  if (cur <= win) to = Math.min(pages, 1 + win * 2);
  if (cur > pages - win) from = Math.max(1, pages - win * 2);

  const btn = (label, page, opts = {}) =>
    `<button ${opts.disabled ? "disabled" : ""} ${
      opts.current ? 'aria-current="true"' : ""
    } data-page="${page}">${label}</button>`;

  let html = btn("‹", cur - 1, { disabled: cur === 1 });
  if (from > 1) html += btn("1", 1) + (from > 2 ? "<span>…</span>" : "");
  for (let i = from; i <= to; i++) html += btn(i, i, { current: i === cur });
  if (to < pages)
    html += (to < pages - 1 ? "<span>…</span>" : "") + btn(pages, pages);
  html += btn("›", cur + 1, { disabled: cur === pages });

  el.pager.innerHTML = html;
  el.pager.hidden = false;
}

/* ---------- 상세 모달 ---------- */
async function openDetail(id) {
  const base = itemCache.get(String(id)) || {};
  el.modalBody.innerHTML = `<p class="status">불러오는 중…</p>`;
  showModal(true);

  let d = {};
  try {
    d = await getJSON("/api/biblio/" + id);
  } catch (_) {
    /* 상세 실패해도 검색결과 정보로 표시 */
  }

  const title = d.title || base.title || "";
  const author = d.author || base.author || "";
  const publication = d.publication || base.publication || "";
  const isbn = d.isbn || base.isbn || "";
  const thumb = d.thumbnail || base.thumbnail || "";
  const type = d.type || base.type || "";
  const marc = d.marc || {};
  const holds = base.holdings || [];

  const cover = thumb
    ? `<img class="cover" src="${esc(thumb)}" alt="" />`
    : `<div class="cover placeholder">📕</div>`;

  const holdRows = holds.length
    ? `<table class="hold-table">
        <thead><tr><th>소장처</th><th>청구기호</th><th>위치</th><th>상태</th></tr></thead>
        <tbody>${holds
          .map(
            (h) =>
              `<tr><td>${esc(h.branch)}</td><td>${callNoHtml(
                h.callNo
              )}</td><td>${
                h.location
                  ? esc(h.location.floor + " " + h.location.room)
                  : "-"
              }</td><td class="${holdingClass(h.stateCode)}" style="color:var(--${
                h.stateCode === "AVAILABLE" ? "ok" : h.stateCode === "NOT_AVAILABLE" ? "no" : "muted"
              })">${esc(h.state || "-")}</td></tr>`
          )
          .join("")}</tbody>
      </table>`
    : `<p class="detail-meta">소장 정보가 없습니다.</p>`;

  const facts = [
    marc.physical && ["형태사항", esc(marc.physical)],
    marc.series && ["총서", esc(marc.series)],
  ].filter(Boolean);
  const factsHtml = facts.length
    ? `<p class="detail-meta">${facts
        .map(([k, v]) => `<b>${k}</b> ${v}`)
        .join(" · ")}</p>`
    : "";

  const subjectsHtml =
    marc.subjects && marc.subjects.length
      ? `<div class="detail-section"><h4>주제어</h4><div class="holdings">${marc.subjects
          .map((s) => `<span class="chip">${esc(s)}</span>`)
          .join("")}</div></div>`
      : "";

  const abstractHtml = marc.abstract
    ? `<div class="detail-section"><h4>책 소개</h4><div class="detail-content">${esc(
        marc.abstract
      )}</div></div>`
    : "";

  const tocHtml = marc.toc
    ? `<div class="detail-section"><h4>목차</h4><div class="detail-content">${esc(
        marc.toc
      )}</div></div>`
    : "";

  const linksHtml =
    marc.links && marc.links.length
      ? `<div class="detail-section"><h4>관련 링크</h4>${marc.links
          .map(
            (l) =>
              `<a class="ext-link" target="_blank" rel="noopener" href="${esc(
                l.url
              )}">${esc(l.label)} ↗</a>`
          )
          .join("<br/>")}</div>`
      : "";

  el.modalBody.innerHTML = `
    <div class="detail-head">
      ${cover}
      <div>
        ${type ? `<span class="type">${esc(type)}</span>` : ""}
        <h2 id="m-title">${esc(title)}</h2>
        ${author ? `<p class="detail-meta">${esc(author)}</p>` : ""}
        ${publication ? `<p class="detail-meta">${esc(publication)}</p>` : ""}
        ${isbn ? `<p class="detail-meta">ISBN ${esc(isbn)}</p>` : ""}
        ${factsHtml}
        <button class="cart-add btn-wide" data-cart="${esc(id)}" type="button"></button>
      </div>
    </div>

    <div class="detail-section">
      <h4>소장 정보</h4>
      ${holdRows}
    </div>

    ${abstractHtml}
    ${tocHtml}
    ${subjectsHtml}
    ${linksHtml}

    <a class="ext-link" target="_blank" rel="noopener"
       href="https://cbnul.chungbuk.ac.kr/#/search/detail/${id}">
      충북대 도서관에서 보기 ↗
    </a>`;

  Cart.syncButtons();
}

function showModal(show) {
  el.modal.hidden = !show;
  document.body.style.overflow = show ? "hidden" : "";
}

/* ---------- 이벤트 ---------- */
el.form.addEventListener("submit", (e) => {
  e.preventDefault();
  state.q = el.q.value;
  state.field = el.field.value;
  state.page = 1;
  writeUrl(true);
  hideSuggest();
  maybeEasterEgg(state.q);
  search();
});

el.field.addEventListener("change", () => {
  if (!state.q) return;
  state.field = el.field.value;
  state.page = 1;
  writeUrl(true);
  search();
});

el.sort.addEventListener("change", () => {
  state.sort = el.sort.value;
  state.page = 1;
  writeUrl(true);
  search();
});

el.pager.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-page]");
  if (!b || b.disabled) return;
  state.page = +b.dataset.page;
  writeUrl(true);
  search();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

el.results.addEventListener("click", (e) => {
  if (e.target.closest("[data-cart]")) return; // 담기 버튼은 상세를 열지 않는다
  const card = e.target.closest(".card");
  if (card) openDetail(card.dataset.id);
});

// 카드에 마우스를 올리면 상세를 미리 받아둔다 → 클릭 시 모달이 바로 채워진다.
el.results.addEventListener("pointerover", (e) => {
  const card = e.target.closest(".card[data-id]");
  if (card) prefetch("/api/biblio/" + card.dataset.id);
});
el.results.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    const card = e.target.closest(".card");
    if (card) {
      e.preventDefault();
      openDetail(card.dataset.id);
    }
  }
});

el.modal.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) showModal(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el.modal.hidden) showModal(false);
});

window.addEventListener("popstate", () => {
  readUrl();
  search();
});

/* ---------- 연관 도서 자동완성 ---------- */
let sgTimer = null;
let sgItems = [];
let sgActive = -1;
let sgSeq = 0; // 요청 시퀀스. 닫히거나 새 요청이 시작되면 늦게 온 응답을 무효화.

el.q.addEventListener("input", () => {
  const q = el.q.value.trim();
  clearTimeout(sgTimer);
  if (q.length < 2) {
    hideSuggest();
    return;
  }
  sgTimer = setTimeout(() => fetchSuggest(q), 220);
});

async function fetchSuggest(q) {
  const seq = ++sgSeq;
  // 검색 실행과 **완전히 같은 URL**로 요청한다. 그래야 엔터를 눌렀을 때 응답이
  // 이미 메모리에 있어 네트워크 없이 즉시 결과가 그려진다. (상위 6개만 노출)
  const url = searchUrl(q, state.field, state.sort, 1);

  const cached = peekJSON(url);
  if (cached) {
    sgItems = (cached.items || []).slice(0, 6);
    renderSuggest();
    return;
  }
  // 차단 창 안에서는 어차피 실패한다. 괜히 도서관 서버를 더 때려 차단을 연장하지 않는다.
  if (inBlockWindow()) return;

  try {
    // 일부러 abort 하지 않는다 — 이 응답이 곧 실행될 검색과 같은 URL 이라,
    // 끝까지 받아 캐시에 넣어두는 편이 이득이다. 늦게 온 응답은 seq 로 걸러낸다.
    const data = await getJSON(url);
    // 그 사이 닫혔거나(엔터/Esc) 새 요청이 시작됐거나 입력이 바뀌면 무시
    if (seq !== sgSeq || el.q.value.trim() !== q) return;
    sgItems = (data.items || []).slice(0, 6);
    renderSuggest();
  } catch (_) {
    /* abort/네트워크 오류 무시 */
  }
}

// 자료의 대출 가능 여부 요약(드롭다운용).
function availOf(holdings) {
  const hs = holdings || [];
  if (hs.some((h) => h.stateCode === "AVAILABLE"))
    return { cls: "ok", label: "대출가능" };
  if (hs.length) return { cls: "no", label: "대출불가" };
  return null;
}

function renderSuggest() {
  if (!sgItems.length) {
    hideSuggest();
    return;
  }
  sgItems.forEach((it) => itemCache.set(String(it.id), it));
  sgActive = -1;
  el.suggest.innerHTML = sgItems
    .map((it, i) => {
      const av = availOf(it.holdings);
      return `<li role="option" data-i="${i}" data-id="${it.id}">
          ${
            it.thumbnail
              ? `<img class="s-cover" loading="lazy" src="${esc(
                  it.thumbnail
                )}" alt="" />`
              : `<span class="s-cover ph">📖</span>`
          }
          <span class="s-meta">
            <span class="s-title">${esc(it.title)}</span>
            <span class="s-sub">
              ${it.type ? `<span class="s-type">${esc(it.type)}</span>` : ""}
              ${
                av
                  ? `<span class="s-av ${av.cls}"><span class="dot"></span>${av.label}</span>`
                  : ""
              }
              <span class="s-by">${esc(it.author || "저자 미상")}</span>
            </span>
          </span>
        </li>`;
    })
    .join("");
  el.suggest.hidden = false;
  el.q.setAttribute("aria-expanded", "true");
}

// 항목 선택: 전체 검색을 실행해 결과 화면으로 간 뒤 그 책 상세를 연다.
async function chooseSuggest(id) {
  const item = sgItems.find((x) => String(x.id) === String(id));
  hideSuggest();
  el.q.blur();
  state.q = el.q.value;
  state.field = el.field.value;
  state.page = 1;
  writeUrl(true);
  maybeEasterEgg(state.q);
  await search();
  if (item) itemCache.set(String(id), item); // 상세 소장정보 보장
  openDetail(id);
}

function hideSuggest() {
  sgSeq++; // 진행 중 응답·대기 중 디바운스를 무효화(요청 자체는 캐시용으로 끝까지 둔다)
  clearTimeout(sgTimer);
  el.suggest.hidden = true;
  el.suggest.innerHTML = "";
  sgItems = [];
  sgActive = -1;
  el.q.setAttribute("aria-expanded", "false");
}

function moveSuggest(d) {
  if (!sgItems.length) return;
  sgActive = (sgActive + d + sgItems.length) % sgItems.length;
  [...el.suggest.children].forEach((li, i) =>
    li.setAttribute("aria-selected", String(i === sgActive))
  );
  prefetch("/api/biblio/" + sgItems[sgActive].id);
}

// 드롭다운 항목에 마우스를 올리면 상세를 미리 받아둔다.
el.suggest.addEventListener("pointerover", (e) => {
  const li = e.target.closest("li[data-id]");
  if (li) prefetch("/api/biblio/" + li.dataset.id);
});

el.q.addEventListener("keydown", (e) => {
  if (el.suggest.hidden) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    moveSuggest(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    moveSuggest(-1);
  } else if (e.key === "Enter" && sgActive >= 0) {
    e.preventDefault();
    chooseSuggest(sgItems[sgActive].id);
  } else if (e.key === "Escape") {
    hideSuggest();
  }
});

// mousedown(=blur 전에 발화)로 선택해야 클릭이 먹는다.
el.suggest.addEventListener("mousedown", (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  e.preventDefault();
  chooseSuggest(li.dataset.id);
});

el.q.addEventListener("blur", () => setTimeout(hideSuggest, 150));

/* ---------- 재미 요소 ① 로고 말풍선 ---------- */
/* 대사(QUIPS / EGGS / SLEEP_WORDS)는 eggs.js 에서 정의 (app.js 보다 먼저 로드) */
let quipTimer = null;
let quipIdx = -1;

function showQuip(text) {
  const brand = document.querySelector(".brand");
  if (!brand) return;
  let bubble = brand.querySelector(".quip");
  if (!bubble) {
    bubble = document.createElement("span");
    bubble.className = "quip";
    brand.appendChild(bubble);
  }
  if (!text) {
    let i;
    do {
      i = Math.floor(Math.random() * QUIPS.length);
    } while (QUIPS.length > 1 && i === quipIdx);
    quipIdx = i;
    text = QUIPS[i];
  }
  bubble.textContent = text;
  bubble.classList.remove("show");
  void bubble.offsetWidth; // 애니메이션 리스타트
  bubble.classList.add("show");
  clearTimeout(quipTimer);
  quipTimer = setTimeout(() => bubble.classList.remove("show"), 2800);
}

// 로고 클릭: 메인(시작화면)으로 이동 + 사서 말풍선.
// 전체 새로고침하면 말풍선이 사라지니 클라이언트 측에서 시작화면으로 리셋한다.
const brand = document.querySelector(".brand");
if (brand) {
  brand.addEventListener("click", (e) => {
    e.preventDefault();
    goHome();
    showQuip();
  });
}

function goHome() {
  el.q.value = "";
  el.field.value = "all";
  el.sort.value = "score";
  state = { q: "", field: "all", sort: "score", page: 1 };
  hideSuggest();
  writeUrl(true); // URL 을 "/" 로
  search(); // 빈 검색어 → 시작화면(층 안내) 노출
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------- 재미 요소 ② 특정 검색어 이스터에그 ---------- */
/* EGGS / SLEEP_WORDS 는 eggs.js 에서 정의 */

function maybeEasterEgg(q) {
  const k = (q || "").replace(/\s+/g, "").toLowerCase();
  if (!k) return;
  if (SLEEP_WORDS.has(k)) {
    showQuip("…금방 잘 거예요. 💤");
    return;
  }
  if (EGGS[k]) showQuip(EGGS[k]);
}

/* ---------- 시작 ---------- */
readUrl();
if (state.q) {
  el.intro.hidden = true;
  search();
}
