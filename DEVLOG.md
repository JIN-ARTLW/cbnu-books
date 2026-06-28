# CBNU Books — 개발 기록 (DEVLOG)

충북대학교 도서관(`cbnul.chungbuk.ac.kr`)이 무거워서, **장서검색만** 떼어낸 경량 사이트.
이 문서는 프로젝트 메모리 + 작업 세션(2026-06-26 ~ 06-28) 전체 기록이다.

- **라이브**: https://cbnu-books.gumayusi.workers.dev
- **저장소**: https://github.com/JIN-ARTLW/cbnu-books (public)
- **로컬**: `/Users/jin-yeseo/code/cbnu-books`
- 2026-06-26 생성. (원래 폴더명 `cbnul-lite` → repo·Worker 이름과 맞춰 `cbnu-books`로 통일.)

---

## 1. 아키텍처

단일 **Cloudflare Worker**가 두 역할을 겸한다.

```
브라우저 ──▶ Cloudflare Worker (cbnu-books)
              ├─ /api/*   → Pyxis API 프록시 (+캐시/정렬/보안)
              └─ 그 외     → 정적 자산(public/) 직접 서빙
                                      │
                                      ▼
                         cbnul.chungbuk.ac.kr (Pyxis)
```

- 코어: `src/index.js` (Worker), `public/`(정적), `wrangler.toml`(`name = "cbnu-books"`).
- 정적 파일: `public/index.html`, `public/app.js`, `public/style.css`, `public/_headers`.
- 로컬 개발: `npm run dev`(:8787). 배포: `npm run deploy`.
- **프록시 경로(앱이 호출하는 주소)**:
  - `GET /api/search?q=&field=&size=&page=&sort=&order=`
  - `GET /api/biblio/{id}`
  - (업스트림 `/pyxis-api/...`가 아니라 우리 `/api/...`임 — 헷갈리지 말 것)
- 배포 계정: `진예서`(andrewtaylorweir@gmail.com OAuth, account `967ee98d689bc14d4b3ac89ff1e9fa34`),
  wrangler 3.114 사용(4.x 권고 경고만 뜸).

### Cloudflare 서브도메인 주의
계정 서브도메인 = **`gumayusi`**. 같은 계정에 미담 업로드 워커
`midam-upload.gumayusi.workers.dev`도 있음 → **서브도메인 바꾸면 미담 업로드 URL이 끊기니 바꾸지 말 것.**
로컬 `npm run dev`와 IDE preview가 같은 8787을 쓰면 "Workers runtime failed to start"(포트 충돌) →
검증 후 서버 비울 것.

---

## 2. Pyxis API — 비자명한 함정들

도서관은 **Pyxis(퓨처누리)** 시스템. API는 인증 없이 열려 있음.

- **검색**: `GET /pyxis-api/1/collections/2/search?all=k|a|검색어&facet=false&fuzzy=false&max=&offset=&isForPyxis3=true`
  - ⚠️ **`isForPyxis3=true`가 없으면 무조건 `parameterMissing`** — 가장 큰 함정이었음.
  - 값 형식 `매치타입|연산자|값` (k=키워드, a=AND). 필드키: `all`/`title`/`author`/`publisher`.
  - `collections/2` = 전체 장서.
- ⚠️ **CORS가 `Access-Control-Allow-Origin: instagram`** 으로 막혀 브라우저 직접 호출 불가 → **Worker 프록시 필수.**
- ⚠️ **대출상태 코드**: `cStateCode`가 대출가능을 `AVAILABLE`이 아니라 **`READY`** 로 준다
  (불가는 `NOT_AVAILABLE`, 가끔 null). 프론트가 `AVAILABLE`만 초록 처리하던 탓에 "대출가능"이
  회색으로 나오던 버그 → Worker `canonStateCode()`에서 `READY→AVAILABLE`로 표준화(표시용 한글
  `cState`는 그대로 둠).
- 검색 레코드에 `branchVolumes`(소장관별 대출상태+청구기호) 포함 → 목록에서 바로 표시.
- 상세 `GET /biblios/{id}?isForPyxis3=true`의 `content`는 책소개가 아니라 **MARC 레코드** →
  Worker `parseMarc()`로 형태/총서/주제/목차/초록/링크 추출.
- 상세 외부링크 `#/search/detail/{id}` 패턴은 **추정값(미검증)**.

### 표지 이미지
- 절대 URL(알라딘/네이버/카카오)은 `http→https` 통일 후 사용.
- 상대경로 `/attachments/biblio/thumbnails/{uuid}`(도서관 자체 스캔본)는 외부 직접 접근 불가
  (여러 경로 시도 모두 badRequest/SPA폴백) → `cleanThumb()`에서 null 처리해 placeholder(📕).
  정확한 원본 URL은 실사이트 네트워크 캡처가 있어야 프록시 가능.

---

## 3. 기능

### 검색 / 결과
- 통합·필드(제목/저자/출판사) 검색, 정렬(관련도/연도/제목/저자), 페이지네이션.
- **결과 유형 정렬**: Worker `typeRank()`로 페이지 내 재정렬 —
  `국내단행본`(0) → `전자책·서양서·기타 단행본`(1) → 나머지(2). 묶음 안 순서는 유지(안정 정렬).
  ※ 페이지 단위 재정렬(전 결과 통합 아님), 유형이 정렬 옵션보다 우선.
- **결과 카드에 청구기호**: 첫(제일 위) 소장의 청구기호 1개를 타입칩과 같은 줄(`.card-head`)에
  연한 회색으로. `.callno`는 flex:1+nowrap+overflow:hidden, `fitCallNos()`가 칸 넘치면
  폰트를 11→8px로 줄여 한 줄 유지(말줄임 없음). 전자책 등 청구기호 없으면 미표시.
- 상세 모달: 서지 + 소장표(소장처·청구기호·위치·상태) + 주제어 + 목차 + 관련링크 + 외부링크.
  - 청구기호 여러 개(쉼표)는 `callNoHtml()`로 `<br>` 분리. 소장표 상태 칸 nowrap 고정
    (글자단위 세로쪼개짐 방지), 위치 칸은 줄바꿈 허용.

### 연관도서 자동완성
- 검색창 입력 시(디바운스 220ms, 2자+) `/api/search?size=20` 호출 → **유형정렬 상위 6개**만
  드롭다운(`#suggest`)에 표시(단행본 위주로 뜨게 함).
- 항목: 표지 + 제목 + 장서종류칩 + 대출가능/불가(`availOf`, 초록/빨강) + 저자.
- ↑↓ 탐색, Esc/blur 닫힘, **AbortController + 시퀀스 토큰(`sgSeq`)으로 늦게 온 응답 무효화**
  (엔터 후 드롭다운이 다시 열리던 레이스 해결).
- 항목 선택(`chooseSuggest`) = **전체검색 실행 → 결과 화면으로 이동 → 그 책 상세 모달**
  (결과목록을 뒤에 깔고, 검색 후 itemCache 재설정해 소장정보 보장).
- index.html은 form을 `.search-wrap`으로 감싸 드롭다운 absolute 기준 제공.

### 층/자료실 안내 (중앙도서관 전용)
- 청구기호(KDC 분류번호)로 층을 추정해 카드 칩("중앙도서관 3층")·상세표 "위치" 칼럼에 표시.
- `src/index.js`의 `shelfLocation()` + `KDC_FLOOR` 맵. **현장 안내판 사진 기준 매핑**:
  - 000/100/600 → 4층 4-3·4 · 400/500 → 4층 4-1·2
  - 200 → 3층 3-3 · 300 → 3층 3-3·4 · 700/900 → 3층 3-1 · 800 → 3층 3-2
  - 저자기호가 로마자면 **서양서 → 전 주제 4층 4-3·4**
  - 별치기호(`P `=정기간행물, `R `=참고 등, 로마자+공백+숫자로 시작)는 위치 불확실 → 생략
  - 중앙도서관 외 분관(법학 등)은 건물이 달라 층 표시 안 함
- 시작화면(검색 전)에 **"중앙도서관 층별 자료실 안내"** 섹션(`#intro`). 검색하면 숨김, 검색어
  비우면 다시 노출.
- **TODO(현장 확인 후)**: 300(사회과학)이 3-3·3-4 두 방에 분산 — 방별 세부 분류(예: 320은 3-3,
  330은 3-4)를 받으면 `KDC_FLOOR`/`shelfLocation()`을 분류번호 둘째자리까지 세분화. 현재는
  "3-3·4 자료실"로 묶어 표시 중.

### 재미요소(이스터에그)
- **로고 클릭** → 까칠한 "사서" 랜덤 말풍선(`showQuip`/`.quip`). 클릭 시 **메인(시작화면)으로
  리셋 + 말풍선**(`goHome()` — 새로고침 대신 클라이언트 리셋이라 말풍선이 안 사라짐).
- **검색어 이스터에그**(`EGGS`/`maybeEasterEgg`, 폼 submit에서 호출) — 아래 목록 참고.
- ※ 한때 있던 "탭 이탈 시 제목 변경", "유휴 12초 → 로고 💤", 실존인물(보위) 이스터에그는
  사용자 요청으로 **제거**함.

#### 로고 말풍선 대사 (QUIPS)
```
쉿— 여긴 도서관입니다.
검색은 셀프입니다.
나 지금 좋은 장면이었는데.
그건 아마 4층에 있을걸요.
그 책보다 재밌는 거, 알려줄까요?
한 권만 더 읽고 도와드릴게요.
최고의 독자가 있을 곳은 도서관이니까.
독자는 도서한테 지지 않습니다.
오늘 너와 나 둘 중 하나는 읽는다.
막는 게 아니라, 읽어버리도록 하겠습니다.
독자로 들어왔고 독자로 떠날 계획입니다.
이곳이 도서관이기 때문입니다.
그 문장들, 책으로 바꿔줄게.
잇츠 북!
꾸준히 하면 언젠간 최고가 될거야.
가까워 보여도 너무나 멀리 있지.
사물은 모아도 허전하고 삶은 때로 비참하지만, 책장을 넘기면 견딜 만해요.   (레 미제라블 + 페렉 『사물들』)
```

#### 검색어 이스터에그 (EGGS) — 띄어쓰기·대소문자 무시
| 트리거 | 멘트 |
|---|---|
| 한강 | 한강 작가님, 노벨문학상 축하합니다 🎉 |
| 충북대 / 충북대학교 / cbnu | 여기가 우리 집이죠. 🏫 |
| 사서 | 네, 부르셨어요? |
| 이스터에그 / easteregg | 오, 찾으셨네요. 🥚 |
| 레 미제라블 | 신념의 충돌! |
| 앙졸라 | ABC 카페의 리더. 안목 좋으시네요. 🚩 |
| 사물들 | 명작을 알아보시네요. |
| 페렉 / 조르주 페렉 | 천재를 알아보시네요. |
| 구마유시 / gumayusi | One ADC to Rule Them All🏆🏆🏆 |
| 페이커 / faker | GOAT. 더 설명이 필요한가요? 🐐 |
| 졸려 / 굿나잇 / goodnight / 자자 / 잘래 | …금방 잘 거예요. 💤 |

---

## 4. 성능 (캐싱)

병목은 Pyxis 호출(~0.44s, 가끔 스파이크). Worker/네트워크는 빠름.

- Worker가 **최종 응답을 `caches.default`(엣지 Cache API)에 URL 기준 캐싱**(성공분만,
  `ctx.waitUntil`).
- 응답 헤더 `Cache-Control: max-age=180, stale-while-revalidate=600` (상세는 1800/86400).
- 업스트림 서브요청 `cf.cacheTtl 180`.
- 효과: 반복/인기 검색 ~40ms HIT. **첫 검색(cold)은 업스트림 의존이라 줄일 수 없음.**

---

## 5. 보안

- **MARC 856 링크는 `http(s)`만 허용**(javascript:/data: 등 위험 스킴 차단).
- **보안 헤더**: CSP / `X-Content-Type-Options:nosniff` / `Referrer-Policy` / `X-Frame-Options:DENY`.
  - API 응답은 Worker `json()`의 `SECURITY` 객체로 부여.
  - ⚠️ **정적 자산은 Worker를 안 거치고 직접 서빙되므로 `public/_headers`로 부여**(핵심 함정).
  - CSP는 외부 표지(`img-src https:`)·인라인 onerror/style(`'unsafe-inline'`)·파비콘
    (`data:`)을 허용해 앱이 안 깨짐.
- **Rate limit**: `wrangler.toml`의 `[[unsafe.bindings]] type=ratelimit RATE_LIMITER`(120회/60초),
  **캐시 미스에만** IP(`cf-connecting-ip`)별 적용 → 일반 사용자 무영향. 바인딩 없으면 조용히 통과.
- **CORS 와일드카드 제거**(앱은 같은 출처라 불필요).
- **실존인물 사진 미사용**: 보위·구마유시 사진을 로고/파비콘/빈검색결과로 썼다가 저작권·초상권
  우려로 전부 제거. 사진 무드 원하면 무료스톡(Unsplash CC0)·일러스트로 가야 안전.

---

## 6. 디자인

### 헤더 / 브랜딩
- 큰 타이틀 **"CBNU Books"** + 소제목 "충북대 장서검색", 📚 이모지 로고.
- 파비콘: 📚 SVG **data-URI**(이미지 파일 없음).
- 데스크톱: 두 줄 브랜드 + 검색창. 모바일: `.brand-text` 숨기고 아이콘 + 검색창 **한 줄**
  (`.search-wrap{flex:1 1 0}`, iOS 자동확대 방지 input 16px). 상세 모달은 모바일에서 bottom-sheet.

### 색상 (2026-06-28 확정)
- **포인트색 = 차콜**:
  - 라이트 `--accent:#334155` (+`--accent-weak:#e6e9ee`)
  - 다크 `--accent:#a9b9cf` (스틸 슬레이트, +weak `#262b33`)
  - 흰/검 글자는 `--on-accent`(라이트 `#fff` / 다크 `#11161d`)로 분기 → 검색버튼·활성 페이지
    글자 대비 확보.
- **층 태그 = 현장 사인물 기반**(4층 파랑·3층 금색):
  - 4층 `.floor.f4` 라이트 `#2f7fd1` / 다크 `#5b9bd5`
  - 3층 `.floor.f3` 라이트 `#a16207` / 다크 `#d9c45e`
  - 글자색 `--fct`(라이트 흰색, 다크는 어두운 색). 흰 배경에선 노란 알약+흰 글자가 안 보여
    라이트는 진한 금색 사용.
  - 포인트(차콜)가 무채색이라 층 파랑/금색과 색이 안 겹침.
- 라이트/다크 모두 시인성(대비) 검증 완료.

### 버전 실험 종료
한때 v2(버건디 그리드)·v3(버건디 리스트)·v4(흑백 필름)·v5(장난)·v5g(구마유시)를 `/vN`
경로로 병행 실험했으나, **전부 삭제하고 단일 루트(`/`)로 통합**. 지금 `public/`엔 단일
세트만 있음.

---

## 7. 세션 작업 일지 (요약)

### 2026-06-26 ~ 06-27
- 프로젝트 생성, Pyxis API 분석(`isForPyxis3` 함정, CORS 차단 → 프록시 구조 확립).
- Cloudflare 배포(https://cbnu-books.gumayusi.workers.dev), 검색/상세/정적 라이브 검증.
- 청구기호 → 층/자료실 자동 안내(`shelfLocation`/`KDC_FLOOR`) + 시작화면 층 안내 섹션 추가.
- `cStateCode = READY` 버그 발견·수정(`canonStateCode` 표준화).
- 디자인 버전 실험(v2~v5) 진행.
- 모바일 최적화(빈 status 여백 제거, 검색창 전체폭, bottom-sheet 모달, 소장표 칸 줄바꿈 규칙).
- 상세표 청구기호 `<br>` 분리, 결과 카드에 청구기호 표시.
- **성능**: 엣지 Cache API + stale-while-revalidate 도입.
- **보안**: 링크 스킴 검증 + 보안헤더(`_headers`) + Rate limit 바인딩 + CORS 제거.

### 2026-06-28
- 로고를 사진으로 바꿨다가(보위) **롤백**, v5g(구마유시) 만들었다가 **저작권 우려로 전부 삭제**.
- **v1으로 통합**: 자동완성 + 로고 말풍선 + 검색어 이스터에그를 v1에 이식, 나머지 버전 폴더 삭제.
- 말풍선/이스터에그 대사 추가·수정(레 미제라블/페렉/구마유시/페이커 등), 온점 정리.
- 검색 결과·자동완성 **단행본 위주 정렬**(`typeRank`, 자동완성은 size=20→상위 6).
- 자동완성 **엔터 후 재오픈 레이스 수정**(`sgSeq` 시퀀스 토큰).
- 로고 클릭 = **메인 리셋 + 말풍선**(`goHome`).
- placeholder 예시 제거, 시작화면 안내문 둘째 줄 삭제.
- 타이틀 = "CBNU Books" / 소제목 = "충북대 장서검색"으로 스왑, 📚 파비콘(SVG data-URI) 추가.
- **색상 확정**: 포인트색 차콜(라이트 #334155 / 다크 #a9b9cf) + 층 태그 사인물 파랑/금색.
