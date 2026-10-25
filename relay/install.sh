#!/usr/bin/env bash
#
# cbnu-books 릴레이 설치 — Oracle Cloud(Ubuntu) 인스턴스에서 한 번 실행한다.
#
#   sudo bash install.sh
#
# relay.mjs 와 cbnu-relay.service 가 같은 디렉터리에 있어야 한다.
# 끝나면 Worker 에 넣을 RELAY_BASE / RELAY_SECRET 을 출력한다.

set -euo pipefail

PORT="${PORT:-8080}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "sudo 로 실행하세요: sudo bash install.sh" >&2
  exit 1
fi
for f in relay.mjs cbnu-relay.service; do
  [[ -f "$SRC/$f" ]] || { echo "$f 가 $SRC 에 없습니다." >&2; exit 1; }
done

echo "==> Node 18+ 확인"
# 함정: Ubuntu 22.04 의 apt 기본 nodejs 는 12.x 라 전역 fetch 가 없다.
#       (릴레이가 기동 직후 죽는다) 그래서 버전을 직접 확인하고 모자라면 NodeSource 를 쓴다.
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [[ "$major" -ge 18 ]] && need_node=0 && echo "    이미 Node $(node -v)"
fi
if [[ $need_node -eq 1 ]]; then
  echo "    Node 20 설치 중 (NodeSource)"
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  echo "    설치됨: $(node -v)"
fi

echo "==> 전용 사용자 / 파일 배치"
id -u cbnu >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin cbnu
install -d -o cbnu -g cbnu /opt/cbnu-relay
install -o cbnu -g cbnu -m 644 "$SRC/relay.mjs" /opt/cbnu-relay/relay.mjs

echo "==> 비밀키"
if [[ -f /etc/cbnu-relay.env ]] && grep -q '^RELAY_SECRET=' /etc/cbnu-relay.env; then
  SECRET="$(grep '^RELAY_SECRET=' /etc/cbnu-relay.env | cut -d= -f2-)"
  echo "    기존 키 재사용"
else
  SECRET="$(openssl rand -hex 32)"
  cat > /etc/cbnu-relay.env <<EOF
RELAY_SECRET=$SECRET
PORT=$PORT
RATE_LIMIT=600
EOF
  chmod 600 /etc/cbnu-relay.env
  echo "    새 키 생성"
fi

echo "==> systemd 등록"
install -m 644 "$SRC/cbnu-relay.service" /etc/systemd/system/cbnu-relay.service
systemctl daemon-reload
systemctl enable --now cbnu-relay >/dev/null
sleep 2
systemctl is-active --quiet cbnu-relay \
  && echo "    서비스 실행 중" \
  || { echo "    기동 실패:"; journalctl -u cbnu-relay -n 20 --no-pager; exit 1; }

echo "==> 방화벽 (인스턴스 쪽)"
# Oracle Ubuntu 이미지는 기본 iptables 가 22 번 외에는 막혀 있다.
if ! iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null; then
  iptables -I INPUT -p tcp --dport "$PORT" -j ACCEPT
  echo "    규칙 추가됨"
else
  echo "    이미 열려 있음"
fi
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent >/dev/null 2>&1 || true
command -v netfilter-persistent >/dev/null && netfilter-persistent save >/dev/null 2>&1 || true

echo "==> 자체 점검"
sleep 1
health="$(curl -s --max-time 5 "http://127.0.0.1:$PORT/healthz" || echo FAIL)"
guard="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/admin" || echo FAIL)"
echo "    healthz: $health   (기대: {\"ok\":true})"
echo "    경로차단: $guard        (기대: 403)"

IP="$(curl -s --max-time 5 https://api.ipify.org || echo '<공인IP>')"
cat <<EOF

────────────────────────────────────────────────
설치 완료.

아직 남은 것 — Oracle 콘솔에서 VCN 보안 목록에 수신 규칙을 추가하세요.
(인스턴스 iptables 는 위에서 열었지만, VCN 은 콘솔에서만 열 수 있습니다)

  Networking → VCN → Subnet → Security List → Add Ingress Rule
    Source CIDR      0.0.0.0/0
    IP Protocol      TCP
    Destination Port $PORT

그 다음 로컬(맥)에서:

  npx wrangler secret put RELAY_BASE
      http://$IP:$PORT

  npx wrangler secret put RELAY_SECRET
      $SECRET

  npm run deploy

확인:
  curl -sI "https://cbnu-books.gumayusi.workers.dev/api/search?q=%ED%95%9C%EA%B0%95&field=all&sort=score&page=1&size=20" | grep x-cbnu-route
  → x-cbnu-route: relay  이면 성공
────────────────────────────────────────────────
EOF
