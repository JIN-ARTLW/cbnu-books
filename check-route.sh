#!/usr/bin/env bash
# 업스트림 경로 점검 — 캐시를 피하려고 매번 새 질의를 쓴다.
#   do     = 정상 (Durable Object 경유)
#   direct = DO 경로가 막힘 → relay/README.md 의 한국 릴레이 투입 검토
#   (없음) = 캐시된 응답이거나 실패
B="${1:-https://cbnu-books.gumayusi.workers.dev}"
Q="점검$RANDOM$RANDOM"
E=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$Q")
curl -sI "$B/api/search?q=$E&field=all&sort=score&page=1&size=20" \
  | grep -iE "^HTTP|^x-cbnu-route|^x-cbnu-cache" | tr -d '\r'
