# cbnul-lite

충북대학교 도서관 장서를 가볍고 빠르게 검색하는 비공식 클라이언트.

공식 사이트(`cbnul.chungbuk.ac.kr`)가 무겁게 느껴져서, **장서검색 기능만** 떼어
낸 경량 버전입니다. 데이터는 도서관의 Pyxis API를 그대로 사용합니다.

## 구조

```
브라우저(정적 HTML/JS) → Cloudflare Worker(프록시+캐싱) → 충북대 Pyxis API
```

단일 Worker가 두 역할을 합니다.

- `/api/*` — 도서관 API 프록시 (브라우저 CORS 제약 우회, 응답 캐싱)
- 그 외 경로 — `public/` 정적 자산 서빙

> 도서관 API는 `Access-Control-Allow-Origin` 이 막혀 있어 브라우저에서 직접
> 호출할 수 없습니다. 그래서 Worker 프록시가 필수입니다.

## 개발

```bash
npm install
npm run dev        # http://localhost:8787
```

## 배포 (Cloudflare)

```bash
npm run deploy
```

## API

| 엔드포인트 | 설명 |
|---|---|
| `GET /api/search?q=&field=&sort=&page=&size=` | 장서 검색 |
| `GET /api/biblio/:id` | 자료 상세 |

- `field`: `all`(전체) · `title`(제목) · `author`(저자) · `publisher`(출판사)
- `sort`: `score`(관련도) · `PUBLISH_YEAR` · `TITLE` · `AUTHOR`

## 메모: Pyxis 검색 호출 형식

```
GET https://cbnul.chungbuk.ac.kr/pyxis-api/1/collections/2/search
    ?all=k|a|검색어        # 필드=매치타입(k:키워드)|연산자(a:AND)|값
    &facet=false&fuzzy=false&max=20&offset=0
    &isForPyxis3=true      # ← 누락 시 parameterMissing 오류
```

`collections/2` = 전체 장서. 검색 결과 레코드에 소장관별 대출상태와 청구기호
(`branchVolumes`)가 포함되어 있어, 목록에서 바로 소장 정보를 보여줄 수 있습니다.
