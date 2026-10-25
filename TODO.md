# TODO

CBNU Books 남은 작업 / 검토 항목. (상세 배경은 [DEVLOG.md](DEVLOG.md) 참고)

## 해야 할 것
- [ ] **릴레이 VPS 올리기** — 검색 100% 신뢰도의 전제. `relay/README.md` 대로
      Oracle Cloud 무료 서울 인스턴스에 올리고 `wrangler secret put RELAY_BASE`
      / `RELAY_SECRET` 설정. 올리기 전까지는 직접 호출만 쓰므로 성공률 ~57%.
      확인: 응답 헤더 `x-cbnu-route` 가 `relay` 면 정상, `direct` 면 릴레이 미연결.
- [ ] **300번대(사회과학) 층 세분화** — 현장 안내판상 300이 3-3·3-4 두 방에 분산됨.
      방별 세부 분류(예: 320은 3-3, 330은 3-4)를 현장 확인 후, `src/index.js`의
      `KDC_FLOOR`/`shelfLocation()`을 분류번호 둘째 자리까지 세분화. 현재는 "3-3·4"로 묶어 표시.

## 검증 필요(추정값)
- [ ] **상세 외부링크 패턴** `#/search/detail/{id}` 가 실제로 맞는지 확인 (추정값).
- [ ] **도서관 자체 스캔본 표지** `/attachments/biblio/thumbnails/{uuid}` 의 진짜 원본 URL —
      실사이트 네트워크 캡처를 떠야 프록시 가능. 현재는 placeholder(📕) 처리.

## 아이디어 / 선택
- [ ] **한 번도 검색된 적 없는 검색어**의 첫 호출은 여전히 Pyxis 속도에 묶임 —
      인기 검색어 cron 워밍 정도가 남은 수단. (만료 후 재검색은 SWR로 해결됨)
- [ ] 대출 목록을 링크로 공유(현재는 이 브라우저에만 저장 · 이미지로만 내보내기).
- [ ] 사진 무드 다시 원하면 무료 스톡(Unsplash CC0)·일러스트로 (실존인물 사진은 저작권·초상권 NG).
- [ ] 정기간행물(P)·참고자료 등 별치 자료에도 위치 안내를 줄지 (현재는 일부러 생략).

## 운영 메모
- 재배포: `npm run deploy`
- 이스터에그/말풍선 대사 편집: `public/eggs.js` 만 고치면 됨.
- 대출목록 PNG 레이아웃 수정: `public/cart.js` 의 `IMG`(치수)·`C`(색)·`buildImage()`.
- 표지 프록시 허용 호스트: `src/index.js` 의 `COVER_HOSTS`. 새 서점 표지가 안 뜨면 여기 추가.
- Cloudflare 서브도메인 `gumayusi` 는 바꾸지 말 것(미담 업로드 워커 URL이 끊김).
