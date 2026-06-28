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
// 마지막 검색 결과 캐시(id -> item). 상세 모달이 소장정보를 재활용한다.
const itemCache = new Map();
let state = { q: "", field: "all", sort: "score", page: 1 };

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
async function search() {
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
  el.status.textContent = "검색 중…";
  el.status.className = "status";
  el.results.innerHTML = "";
  el.pager.hidden = true;

  const p = new URLSearchParams({
    q: state.q,
    field: state.field,
    sort: state.sort,
    page: state.page,
    size: PAGE_SIZE,
  });

  try {
    const res = await fetch("/api/search?" + p.toString());
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "검색 실패");
    renderResults(data);
  } catch (err) {
    el.meta.hidden = true;
    el.status.textContent = "오류: " + err.message;
    el.status.className = "status error";
  }
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
  el.count.innerHTML = `전체 <strong>${data.total.toLocaleString()}</strong>건`;

  el.results.innerHTML = data.items.map(cardHtml).join("");
  fitCallNos();
  renderPager(data.total);
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
    const res = await fetch("/api/biblio/" + id);
    if (res.ok) d = await res.json();
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
  const card = e.target.closest(".card");
  if (card) openDetail(card.dataset.id);
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
let sgController = null;
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
  try {
    if (sgController) sgController.abort();
    sgController = new AbortController();
    // 넉넉히 받아(유형정렬 적용됨) 단행본이 위로 오게 한 뒤 상위 6개만 노출.
    const p = new URLSearchParams({ q, field: state.field, size: 20 });
    const res = await fetch("/api/search?" + p.toString(), {
      signal: sgController.signal,
    });
    if (!res.ok) return;
    const data = await res.json();
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
  sgSeq++; // 진행 중 응답·대기 중 디바운스를 무효화
  clearTimeout(sgTimer);
  if (sgController) sgController.abort();
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
}

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
const QUIPS = [
  "쉿— 여긴 도서관입니다.",
  "검색은 셀프입니다.",
  "나 지금 좋은 장면이었는데.",
  "그건 아마 4층에 있을걸요.",
  "그 책보다 재밌는 거, 알려줄까요?",
  "한 권만 더 읽고 도와드릴게요.",
  "최고의 독자가 있을 곳은 도서관이니까.",
  "독자는 도서한테 지지 않습니다.",
  "오늘 너와 나 둘 중 하나는 읽는다.",
  "막는 게 아니라, 읽어버리도록 하겠습니다.",
  "독자로 들어왔고 독자로 떠날 계획입니다.",
  "이곳이 도서관이기 때문입니다.",
  "그 문장들, 책으로 바꿔줄게.",
  "잇츠 북!",
  "꾸준히 하면 언젠간 최고가 될거야.",
  "가까워 보여도 너무나 멀리 있지.",
  "사물은 모아도 허전하고 삶은 때로 비참하지만, 책장을 넘기면 견딜 만해요.",
];
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
const EGGS = {
  한강: "한강 작가님, 노벨문학상 축하합니다 🎉",
  충북대: "여기가 우리 집이죠. 🏫",
  충북대학교: "여기가 우리 집이죠. 🏫",
  cbnu: "여기가 우리 집이죠. 🏫",
  사서: "네, 부르셨어요?",
  이스터에그: "오, 찾으셨네요. 🥚",
  easteregg: "오, 찾으셨네요. 🥚",
  레미제라블: "신념의 충돌!",
  앙졸라: "ABC 카페의 리더. 안목 좋으시네요. 🚩",
  사물들: "명작을 알아보시네요.",
  페렉: "천재를 알아보시네요.",
  조르주페렉: "천재를 알아보시네요.",
  구마유시: "One ADC to Rule Them All🏆🏆🏆",
  gumayusi: "One ADC to Rule Them All🏆🏆🏆",
  페이커: "GOAT. 더 설명이 필요한가요? 🐐",
  faker: "GOAT. 더 설명이 필요한가요? 🐐",
};
const SLEEP_WORDS = new Set(["졸려", "굿나잇", "goodnight", "자자", "잘래"]);

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
