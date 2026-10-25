# cbnu-books 릴레이 (한국 경유지)

## 왜 필요한가

충북대 방화벽이 **Cloudflare 엣지에서 오는 연결을 조용히 드롭**한다.
2026-10-25 실측 (25초 간격 14회, 같은 시각 동시 측정):

| 경로 | 성공률 | 실패 양상 |
|---|---|---|
| Cloudflare 엣지 → 도서관 | **8/14 (57%)** | 전부 정확히 6초 타임아웃 |
| 한국 일반 IP → 도서관 | **14/14 (100%)** | — |

짧은 시간에 몰아서 부르면 성공률이 0~20%까지 떨어진다.
`cf` 캐시 옵션·User-Agent·Referer·헤더 최소화 등 5가지 변형 전부 동일하게 실패했고,
TLS 인증서 체인도 정상이므로 **우리 쪽 코드로는 해결 불가**다.

브라우저에서 직접 부르는 것도 막혀 있다 — 도서관 API 의 CORS 설정이
`Access-Control-Allow-Origin: https://www.instagram.com/*` 로 잘못 박혀 있다.

그래서 **한국 IP 를 가진 이 릴레이**가 대신 호출한다.
Worker 는 릴레이를 우선 쓰고, 릴레이가 죽으면 직접 호출로 떨어진다(0%보다 57%가 나으므로).

```
브라우저 → Cloudflare Worker ──(1순위)──▶ 릴레이(한국 VPS) ──▶ 충북대 Pyxis
                             └─(2순위)──▶ 충북대 Pyxis  (직접, 57%)
```

## 보안

공개 프록시가 되면 안 되므로 세 겹으로 막는다.

1. **경로 제한** — `/pyxis-api/1/` 로 시작하는 요청만 통과. 그 외 전부 403.
2. **HMAC 서명** — 요청마다 `x-cbnu-ts`(epoch ms) + `x-cbnu-sig`
   (= HMAC-SHA256(secret, `ts\n경로`)) 를 검증. 시각 오차 120초 초과면 거부.
   타임스탬프가 서명에 들어가므로 평문 HTTP 로 떠도 **캡처한 요청을 재사용할 수 없다.**
3. **레이트리밋** — 전역 분당 600회(기본).

## Oracle Cloud 무료 VPS 에 올리기

### 1. 인스턴스 만들기
- Oracle Cloud 가입 → **Always Free** (카드 인증만, 과금 없음)
- 리전: **서울(ap-seoul-1)** 또는 춘천(ap-chuncheon-1) — 한국이어야 의미가 있다
- Compute → Instances → Create
  - Image: **Ubuntu 22.04 또는 24.04**
  - Shape: `VM.Standard.A1.Flex` (ARM, 무료 한도 넉넉) 또는 `VM.Standard.E2.1.Micro`
  - SSH 공개키 등록
- 생성 후 **공인 IP** 를 적어둔다.

### 2. 포트 열기 (두 군데 모두 해야 한다)

Oracle Ubuntu 이미지는 VCN 방화벽과 인스턴스 iptables **둘 다** 막혀 있다.

**(a) VCN 보안 목록** — Networking → VCN → Subnet → Security List → Add Ingress Rule
- Source CIDR `0.0.0.0/0`, IP Protocol `TCP`, Destination Port `8080`

**(b) 인스턴스 iptables**
```bash
sudo iptables -I INPUT 6 -p tcp --dport 8080 -j ACCEPT
sudo netfilter-persistent save
```

### 3. 릴레이 설치
```bash
sudo apt update && sudo apt install -y nodejs   # Node 18+ 필요. 낮으면 nodesource 사용
node -v                                          # v18 이상인지 확인

sudo useradd -r -s /usr/sbin/nologin cbnu
sudo mkdir -p /opt/cbnu-relay
sudo cp relay.mjs /opt/cbnu-relay/
sudo chown -R cbnu:cbnu /opt/cbnu-relay

# 비밀키 생성 (이 값을 Worker 에도 똑같이 넣는다)
SECRET=$(openssl rand -hex 32); echo "$SECRET"
sudo tee /etc/cbnu-relay.env >/dev/null <<EOT
RELAY_SECRET=$SECRET
PORT=8080
RATE_LIMIT=600
EOT
sudo chmod 600 /etc/cbnu-relay.env

sudo cp cbnu-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cbnu-relay
sudo systemctl status cbnu-relay --no-pager
```

### 4. 동작 확인
```bash
curl http://<공인IP>:8080/healthz          # {"ok":true}
curl http://<공인IP>:8080/admin            # {"error":"forbidden path"}  ← 403 이어야 정상
```

### 5. Worker 에 연결
```bash
cd ~/code/cbnu-books
npx wrangler secret put RELAY_BASE      # http://<공인IP>:8080   (끝에 / 없이)
npx wrangler secret put RELAY_SECRET    # 위에서 만든 SECRET 과 동일한 값
npm run deploy
```

### 6. 릴레이로 나가는지 확인
```bash
curl -sI "https://cbnu-books.gumayusi.workers.dev/api/search?q=%ED%95%9C%EA%B0%95&field=all&sort=score&page=1&size=20" \
  | grep x-cbnu-route
# x-cbnu-route: relay   ← relay 면 성공. direct 면 릴레이에 못 닿고 있다는 뜻.
```

## 운영

- 로그: `sudo journalctl -u cbnu-relay -f`
- 재시작: `sudo systemctl restart cbnu-relay`
- `x-cbnu-route` 가 `direct` 로 바뀌면 릴레이가 죽었거나 방화벽이 닫힌 것이다.
  (사이트는 계속 돌아가지만 성공률이 57%로 떨어진다)

### HTTPS 로 올리고 싶다면
도메인이 있으면 VPS 에 Caddy 를 얹어 자동 TLS 를 받고 `RELAY_BASE` 를
`https://...` 로 바꾸면 된다. HMAC 서명이 재사용을 막아주므로 평문 HTTP 로도
안전성 자체는 유지되지만, TLS 를 쓰면 중간에서 내용을 들여다보는 것까지 막힌다.
