"use strict";

/**
 * 대출 목록 — 로그인 없이 브라우저에만 저장하는 "빌릴 책 담기".
 *
 * 담은 책을 자료실(층)별로 묶고 청구기호 순으로 정렬해 보여준다. 그대로 도서관에
 * 들고 가면 되도록 PNG 이미지로 내보낼 수 있다(표지·제목·청구기호·위치·상태 포함).
 *
 * 이미지는 캔버스에 직접 그린다. 외부 표지 이미지를 그대로 그리면 캔버스가 오염돼
 * toBlob() 이 SecurityError 를 내므로, 표지는 같은 출처인 /api/cover 프록시로 받는다.
 */

const CART_KEY = "cbnu.cart.v1";
const CART_MAX = 60;

const Cart = {
  items: [],

  /* ---------- 저장소 ---------- */
  load() {
    try {
      const raw = localStorage.getItem(CART_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      this.items = Array.isArray(arr) ? arr : [];
    } catch (_) {
      this.items = []; // 시크릿 모드 등 localStorage 접근 불가 → 메모리로만 동작
    }
  },
  save() {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(this.items));
    } catch (_) {
      /* 저장 실패해도 이번 세션 동안은 그대로 쓴다 */
    }
  },

  /* ---------- 조작 ---------- */
  has(id) {
    return this.items.some((x) => String(x.id) === String(id));
  },
  add(item) {
    if (!item || this.has(item.id)) return false;
    if (this.items.length >= CART_MAX) {
      toast(`대출 목록은 최대 ${CART_MAX}권까지예요.`);
      return false;
    }
    // 담는 시점의 정보를 그대로 보관 — 나중에 다시 조회하지 않아도 목록이 완성돼 있다.
    this.items.push({
      id: item.id,
      title: item.title || "",
      author: item.author || "",
      publication: item.publication || "",
      type: item.type || "",
      thumbnail: item.thumbnail || null,
      holdings: (item.holdings || []).map((h) => ({
        branch: h.branch,
        callNo: h.callNo || null,
        state: h.state || "",
        stateCode: h.stateCode || "",
        location: h.location || null,
      })),
      addedAt: Date.now(),
    });
    this.save();
    return true;
  },
  remove(id) {
    this.items = this.items.filter((x) => String(x.id) !== String(id));
    this.save();
  },
  clear() {
    this.items = [];
    this.save();
  },

  toggle(id) {
    if (this.has(id)) {
      this.remove(id);
      toast("대출 목록에서 뺐어요.");
    } else {
      const item = window.itemCache && window.itemCache.get(String(id));
      if (!item) {
        toast("책 정보를 찾지 못했어요.");
        return;
      }
      if (this.add(item)) toast(`담았어요 · ${this.items.length}권`);
    }
    this.syncButtons();
    this.updateBadge();
    if (!cartModal.hidden) this.renderList();
  },

  /* ---------- UI 동기화 ---------- */
  updateBadge() {
    const n = this.items.length;
    cartBadge.textContent = String(n);
    cartBtn.classList.toggle("empty", n === 0);
    cartBtn.setAttribute("aria-label", `대출 목록 ${n}권`);
  },

  /** 화면에 있는 모든 담기 버튼의 상태를 현재 목록에 맞춘다. */
  syncButtons() {
    document.querySelectorAll("[data-cart]").forEach((b) => {
      const on = this.has(b.dataset.cart);
      const label = on ? "대출 목록에서 빼기" : "대출 목록에 담기";
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      if (b.classList.contains("btn-wide")) {
        b.textContent = on ? "✓ 대출 목록에 담김" : "＋ 대출 목록에 담기";
      } else {
        b.textContent = on ? "✓" : "＋";
        b.title = label;
        b.setAttribute("aria-label", label);
      }
    });
  },

  open() {
    this.renderList();
    cartModal.hidden = false;
    document.body.style.overflow = "hidden";
  },
  close() {
    cartModal.hidden = true;
    document.body.style.overflow = "";
    clearPreview();
  },

  renderList() {
    cartCount.textContent = this.items.length
      ? `${this.items.length}권`
      : "";
    cartActions.hidden = this.items.length === 0;

    if (!this.items.length) {
      cartBody.innerHTML = `<p class="cart-empty">아직 담은 책이 없어요.<br />
        검색 결과의 <b>＋</b> 버튼으로 빌릴 책을 담아두면,<br />
        자료실별로 정리해서 이미지로 저장할 수 있어요.</p>`;
      return;
    }

    cartBody.innerHTML = groupItems(this.items)
      .map(
        (g) => `
        <div class="cart-group">
          <div class="cart-group-head ${g.floorClass}">
            <span class="cart-group-name">${esc(g.label)}</span>
            <span class="cart-group-n">${g.items.length}권</span>
          </div>
          <ul class="cart-list">
            ${g.items.map(rowHtml).join("")}
          </ul>
        </div>`
      )
      .join("");
  },
};

/* ---------- 그룹핑 ---------- */

/** 담은 책에서 "실제로 찾아갈" 소장본 하나를 고른다: 대출가능 > 중앙도서관 > 청구기호 있음. */
function pickHolding(it) {
  const hs = it.holdings || [];
  if (!hs.length) return null;
  const score = (h) =>
    (h.stateCode === "AVAILABLE" ? 0 : 8) +
    (h.branch === "중앙도서관" ? 0 : 4) +
    (h.callNo ? 0 : 2) +
    (h.location ? 0 : 1);
  return hs.slice().sort((a, b) => score(a) - score(b))[0];
}

function firstCallNo(h) {
  if (!h || !h.callNo) return "";
  return h.callNo.split(",")[0].trim();
}

/** 자료실(층) 단위로 묶고, 층 → 자료실 → 청구기호 순으로 정렬한다. */
function groupItems(items) {
  const map = new Map();
  for (const it of items) {
    const h = pickHolding(it);
    const label = !h
      ? "위치 정보 없음"
      : h.location
      ? `${h.branch} ${h.location.floor} ${h.location.room}`
      : h.branch || "위치 정보 없음";
    if (!map.has(label)) {
      map.set(label, {
        label,
        floor: h && h.location ? parseInt(h.location.floor, 10) : 99,
        floorClass:
          h && h.location ? "f" + parseInt(h.location.floor, 10) : "fx",
        items: [],
      });
    }
    map.get(label).items.push({ ...it, _h: h, _call: firstCallNo(h) });
  }
  const groups = [...map.values()];
  groups.sort((a, b) => a.floor - b.floor || a.label.localeCompare(b.label, "ko"));
  for (const g of groups) {
    g.items.sort((a, b) => a._call.localeCompare(b._call, "ko", { numeric: true }));
  }
  return groups;
}

/* ---------- 목록 행 ---------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function stateClass(code) {
  return code === "AVAILABLE" ? "ok" : code === "NOT_AVAILABLE" ? "no" : "";
}

function rowHtml(it) {
  const h = it._h;
  const cover = it.thumbnail
    ? `<img class="c-cover" loading="lazy" src="${esc(it.thumbnail)}" alt="" />`
    : `<span class="c-cover ph">📕</span>`;
  return `<li class="cart-row">
    ${cover}
    <div class="c-meta">
      <span class="c-title">${esc(it.title)}</span>
      <span class="c-by">${esc(it.author || "저자 미상")}</span>
      <span class="c-tags">
        ${it._call ? `<span class="c-call">${esc(it._call)}</span>` : ""}
        ${
          h && h.state
            ? `<span class="c-state ${stateClass(h.stateCode)}">${esc(
                h.state
              )}</span>`
            : ""
        }
      </span>
    </div>
    <button class="c-del" type="button" data-del="${esc(
      String(it.id)
    )}" aria-label="목록에서 빼기">✕</button>
  </li>`;
}

/* ---------- 토스트 ---------- */
let toastTimer = null;
function toast(msg) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.className = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1900);
}

/* ---------- PNG 이미지 만들기 ---------- */

const IMG = {
  w: 920,
  scale: 2,
  pad: 36,
  rowH: 92,
  groupH: 46,
  gapGroup: 18,
  headH: 104,
  footH: 54,
};

const C = {
  bg: "#ffffff",
  panel: "#f7f7f8",
  line: "#e3e5e9",
  text: "#1c1d21",
  muted: "#6b7079",
  accent: "#334155",
  ok: "#1a8a52",
  okBg: "#e3f5ec",
  no: "#c0392b",
  noBg: "#fbe9e7",
  f3: "#a16207",
  f4: "#2f7fd1",
  fx: "#6b7079",
};

const FONT =
  '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = String(text);
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}

/** 알약 배지를 그리고 오른쪽 끝 x 를 돌려준다. */
function pill(ctx, x, y, text, fg, bg, { mono = false, size = 13 } = {}) {
  ctx.font = `600 ${size}px ${mono ? 'ui-monospace, "SF Mono", Menlo, ' : ""}${FONT}`;
  const w = ctx.measureText(text).width + 18;
  const h = size + 11;
  ctx.fillStyle = bg;
  roundRect(ctx, x, y - h / 2, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 9, y + 0.5);
  return x + w;
}

/** 같은 출처 프록시로 표지를 받아온다(캔버스 오염 방지). 실패하면 null. */
function loadCover(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = "/api/cover?u=" + encodeURIComponent(url);
    setTimeout(() => resolve(null), 6000);
  });
}

async function buildImage() {
  const groups = groupItems(Cart.items);
  const rows = Cart.items.length;

  const height =
    IMG.headH +
    groups.length * (IMG.groupH + IMG.gapGroup) +
    rows * IMG.rowH +
    IMG.footH;

  const canvas = document.createElement("canvas");
  canvas.width = IMG.w * IMG.scale;
  canvas.height = height * IMG.scale;
  const ctx = canvas.getContext("2d");
  ctx.scale(IMG.scale, IMG.scale);
  ctx.textBaseline = "alphabetic";

  // 배경
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, IMG.w, height);

  const L = IMG.pad;
  const R = IMG.w - IMG.pad;

  /* 머리말 */
  ctx.fillStyle = C.text;
  ctx.font = `700 25px ${FONT}`;
  ctx.fillText("📚 대출 목록", L, 52);

  const now = new Date();
  const stamp = `${now.getFullYear()}. ${now.getMonth() + 1}. ${now.getDate()}. ${String(
    now.getHours()
  ).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  ctx.font = `500 14px ${FONT}`;
  ctx.fillStyle = C.muted;
  ctx.textAlign = "right";
  ctx.fillText(`${rows}권 · ${stamp}`, R, 52);
  ctx.textAlign = "left";

  ctx.font = `400 13px ${FONT}`;
  ctx.fillText("충북대학교 중앙도서관 · 자료실별 정리", L, 74);

  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(L, 88.5);
  ctx.lineTo(R, 88.5);
  ctx.stroke();

  // 표지는 병렬로 미리 받아둔다.
  const covers = new Map();
  await Promise.all(
    Cart.items.map(async (it) => {
      covers.set(String(it.id), await loadCover(it.thumbnail));
    })
  );

  let y = IMG.headH;

  for (const g of groups) {
    /* 자료실 머리 */
    const gc = C[g.floorClass] || C.fx;
    ctx.fillStyle = gc;
    roundRect(ctx, L, y, 5, IMG.groupH - 12, 2.5);
    ctx.fill();

    ctx.fillStyle = C.text;
    ctx.font = `700 16px ${FONT}`;
    ctx.fillText(g.label, L + 16, y + 22);

    ctx.fillStyle = C.muted;
    ctx.font = `500 13px ${FONT}`;
    ctx.textAlign = "right";
    ctx.fillText(`${g.items.length}권`, R, y + 22);
    ctx.textAlign = "left";

    y += IMG.groupH;

    for (const it of g.items) {
      const top = y;
      const mid = top + IMG.rowH / 2;

      // 체크박스 — 찾은 책을 표시하며 다니라고.
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1.5;
      roundRect(ctx, L, mid - 9, 18, 18, 4);
      ctx.stroke();

      // 표지
      const cx = L + 32;
      const cw = 46;
      const ch = 64;
      const im = covers.get(String(it.id));
      ctx.save();
      roundRect(ctx, cx, mid - ch / 2, cw, ch, 4);
      ctx.clip();
      if (im) {
        // cover 방식으로 채우기(비율 유지 + 잘라내기)
        const s = Math.max(cw / im.width, ch / im.height);
        const dw = im.width * s;
        const dh = im.height * s;
        ctx.drawImage(im, cx + (cw - dw) / 2, mid - ch / 2 + (ch - dh) / 2, dw, dh);
      } else {
        ctx.fillStyle = C.panel;
        ctx.fillRect(cx, mid - ch / 2, cw, ch);
        ctx.fillStyle = C.muted;
        ctx.font = `20px ${FONT}`;
        ctx.textAlign = "center";
        ctx.fillText("📕", cx + cw / 2, mid + 7);
        ctx.textAlign = "left";
      }
      ctx.restore();

      // 글
      const tx = cx + cw + 16;
      ctx.fillStyle = C.text;
      ctx.font = `650 16px ${FONT}`;
      ctx.fillText(fitText(ctx, it.title, R - tx), tx, mid - 14);

      ctx.fillStyle = C.muted;
      ctx.font = `400 13px ${FONT}`;
      const by = [it.author || "저자 미상", it.publication]
        .filter(Boolean)
        .join(" · ");
      ctx.fillText(fitText(ctx, by, R - tx), tx, mid + 6);

      // 청구기호 + 상태
      let px = tx;
      if (it._call) {
        px = pill(ctx, px, mid + 24, it._call, C.accent, "#eef0f3", {
          mono: true,
          size: 13,
        });
        px += 6;
      }
      const h = it._h;
      if (h && h.state) {
        const okish = h.stateCode === "AVAILABLE";
        pill(
          ctx,
          px,
          mid + 24,
          h.state,
          okish ? C.ok : C.no,
          okish ? C.okBg : C.noBg,
          { size: 12 }
        );
      }

      // 행 구분선
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(L, top + IMG.rowH - 0.5);
      ctx.lineTo(R, top + IMG.rowH - 0.5);
      ctx.stroke();

      y += IMG.rowH;
    }
    y += IMG.gapGroup;
  }

  /* 꼬리말 */
  ctx.fillStyle = C.muted;
  ctx.font = `400 12px ${FONT}`;
  ctx.fillText(
    "CBNU Books · 층·자료실은 청구기호로 추정한 값이라 실제 배치와 다를 수 있습니다.",
    L,
    height - 22
  );

  return canvas;
}

function clearPreview() {
  const img = cartPreview.querySelector("img");
  if (img && img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  cartPreview.innerHTML = "";
  cartPreview.hidden = true;
}

let lastFile = null;

async function makeImage() {
  if (!Cart.items.length) return;
  cartImage.disabled = true;
  cartImage.textContent = "만드는 중…";
  try {
    const canvas = await buildImage();
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    if (!blob) throw new Error("이미지 생성 실패");

    const d = new Date();
    const name = `대출목록_${d.getFullYear()}${String(d.getMonth() + 1).padStart(
      2,
      "0"
    )}${String(d.getDate()).padStart(2, "0")}.png`;
    lastFile = new File([blob], name, { type: "image/png" });

    clearPreview();
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    img.alt = "대출 목록 이미지";
    img.dataset.url = url;
    cartPreview.appendChild(img);

    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.className = "cart-dl";
    a.textContent = "⬇ 이미지 내려받기";
    cartPreview.appendChild(a);

    const note = document.createElement("p");
    note.className = "cart-note";
    note.textContent =
      "모바일에서는 위 이미지를 길게 눌러 저장하거나 화면을 캡처하세요.";
    cartPreview.appendChild(note);

    cartPreview.hidden = false;
    cartShare.hidden = !(
      navigator.canShare && navigator.canShare({ files: [lastFile] })
    );
    cartPreview.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    toast("이미지를 만들지 못했어요: " + err.message);
  } finally {
    cartImage.disabled = false;
    cartImage.textContent = "🖼 이미지로 저장";
  }
}

/* ---------- 요소 · 이벤트 ---------- */
const cartBtn = document.getElementById("cartBtn");
const cartBadge = document.getElementById("cartBadge");
const cartModal = document.getElementById("cartModal");
const cartBody = document.getElementById("cartBody");
const cartCount = document.getElementById("cartCount");
const cartActions = document.getElementById("cartActions");
const cartPreview = document.getElementById("cartPreview");
const cartImage = document.getElementById("cartImage");
const cartShare = document.getElementById("cartShare");
const cartClear = document.getElementById("cartClear");

cartBtn.addEventListener("click", () => Cart.open());

cartModal.addEventListener("click", (e) => {
  if (e.target.closest("[data-cart-close]")) Cart.close();
  const del = e.target.closest("[data-del]");
  if (del) {
    Cart.remove(del.dataset.del);
    Cart.renderList();
    Cart.updateBadge();
    Cart.syncButtons();
    clearPreview();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !cartModal.hidden) Cart.close();
});

// 담기 버튼(카드·상세 모달)은 위임으로 한 번에 처리한다.
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-cart]");
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  Cart.toggle(b.dataset.cart);
});

cartImage.addEventListener("click", makeImage);

cartShare.addEventListener("click", async () => {
  if (!lastFile) return;
  try {
    await navigator.share({ files: [lastFile], title: "대출 목록" });
  } catch (_) {
    /* 사용자가 취소 */
  }
});

cartClear.addEventListener("click", () => {
  if (!confirm("대출 목록을 모두 비울까요?")) return;
  Cart.clear();
  Cart.renderList();
  Cart.updateBadge();
  Cart.syncButtons();
  clearPreview();
});

Cart.load();
Cart.updateBadge();
