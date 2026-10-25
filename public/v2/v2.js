"use strict";

/*
 * v2 전용 상호작용. app.js 를 건드리지 않고 시작화면만 얹는다.
 *  - 스크롤 등장(.reveal)
 *  - 주제 원형 포트레이트 → 검색 실행
 *  - 스크롤 시 네비게이션 알약 압축
 */

/* ---------- 스크롤 등장 ---------- */
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (reduced) {
  document.querySelectorAll(".reveal").forEach((e) => e.classList.add("in"));
} else {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("in");
        io.unobserve(e.target); // 한 번만 등장시킨다
      }
    },
    { rootMargin: "0px 0px -12% 0px", threshold: 0.08 }
  );
  document.querySelectorAll(".reveal").forEach((e) => io.observe(e));
}

/* ---------- 주제 포트레이트 → 검색 ---------- */
// app.js 의 submit 핸들러를 그대로 타게 해서 검색 로직을 한 곳에 둔다.
document.querySelectorAll(".topic button[data-q]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.getElementById("q");
    input.value = btn.dataset.q;
    document
      .getElementById("searchForm")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  });
});

/* ---------- 히어로 CTA → 검색창 포커스 ---------- */
const heroCta = document.getElementById("heroCta");
if (heroCta) {
  heroCta.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
    document.getElementById("q").focus();
  });
}

/* ---------- 스크롤하면 네비게이션을 조금 조인다 ---------- */
const navwrap = document.getElementById("navwrap");
let ticking = false;
addEventListener(
  "scroll",
  () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      navwrap.classList.toggle("stuck", window.scrollY > 16);
      ticking = false;
    });
  },
  { passive: true }
);
