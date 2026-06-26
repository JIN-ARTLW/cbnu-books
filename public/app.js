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
    el.status.textContent = "검색어를 입력하세요.";
    el.status.className = "status";
    return;
  }
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
  renderPager(data.total);
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
        )} · ${esc(h.state || "")}</span>`
    )
    .join("");

  return `<li class="card" data-id="${it.id}" tabindex="0" role="button">
    ${cover}
    <div class="card-body">
      ${it.type ? `<span class="type">${esc(it.type)}</span>` : ""}
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
        <thead><tr><th>소장처</th><th>청구기호</th><th>상태</th></tr></thead>
        <tbody>${holds
          .map(
            (h) =>
              `<tr><td>${esc(h.branch)}</td><td>${esc(
                h.callNo || "-"
              )}</td><td class="${holdingClass(h.stateCode)}" style="color:var(--${
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

/* ---------- 시작 ---------- */
readUrl();
if (state.q) search();
else {
  el.status.textContent = "충북대학교 도서관 장서를 검색해 보세요.";
}
