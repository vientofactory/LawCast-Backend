# LawCast Backend

NestJS 기반 API 서버입니다. 국회 입법예고(PAL)와 국민참여입법센터(NSM) 데이터를 수집/동기화하고, 아카이브 저장, 요약 생성, Discord 웹훅 알림, 운영용 디버그 브릿지를 제공합니다.

## 주요 기능

- PAL/NSM 크롤링 기반 입법예고 수집
- 아카이브 영속화(SQLite + TypeORM) 및 무결성(SHA-256) 검증
- NSM 선감지 → PAL 전환 시 동일 의안번호 기준 아카이브 갱신
- Redis 캐시 기반 최근 목록/검색 성능 최적화
- Ollama 연동 AI 요약(선택)
- Discord 웹훅 알림 전송
- Discord Debug Bridge(슬래시 커맨드 기반 운영 도구)

## 기술 스택

- Framework: NestJS 11
- Language: TypeScript
- DB: SQLite + TypeORM
- Cache: Redis (`@keyv/redis`, `@nestjs/cache-manager`)
- Crawler: `pal-crawl`
- Scheduler: `@nestjs/schedule`
- Notification: `discord-webhook-node`

## 설치 및 실행

### 요구사항

- Node.js
- npm
- Redis

### 설치

```bash
npm install
```

### 실행

```bash
# development
npm run start:dev

# debug (watch)
npm run start:debug

# production build
npm run build
npm run start:prod

# production (nest start)
npm run start
```

### 테스트

```bash
npm run test
npm run test:cov
npm run test:e2e
```

## 환경 변수

`.env` 예시:

```env
# Server
PORT=3001
NODE_ENV=development

# Database
DATABASE_PATH=lawcast.db

# Redis
REDIS_URL=redis://localhost:6379
REDIS_KEY_PREFIX=lawcast:
REDIS_TTL=1800

# HashGuard (webhook PoW)
HASHGUARD_API_URL=https://hashguard.viento.me
HASHGUARD_API_KEY=

# Ollama (optional)
OLLAMA_ENABLED=false
OLLAMA_API_URL=http://localhost:11434
OLLAMA_MODEL=gemma3:1b
OLLAMA_TIMEOUT=10000

# CORS origins (comma-separated)
FRONTEND_URL=http://localhost:5173

# Cron timezone
CRON_TIMEZONE=Asia/Seoul

# Discord Debug Bridge (optional)
DISCORD_BRIDGE_ENABLED=false
DISCORD_BRIDGE_BOT_TOKEN=
DISCORD_BRIDGE_GUILD_ID=
DISCORD_BRIDGE_CHANNEL_ID=
DISCORD_BRIDGE_LOG_CHANNEL_ID=
DISCORD_BRIDGE_LOG_LEVEL=LOG
DISCORD_BRIDGE_ADMIN_USER_IDS=
```

### Ollama 활성화 규칙

- `OLLAMA_ENABLED=true`: 항상 활성화 시도
- `OLLAMA_ENABLED=false`: 항상 비활성화
- `OLLAMA_ENABLED` 미설정: `OLLAMA_API_URL` + `OLLAMA_MODEL`이 모두 있을 때만 활성화

## 아카이브 동기화 파이프라인

서버 시작 시 백그라운드에서 아래 순서로 bootstrap 파이프라인이 실행됩니다.

1. Pending sync (NSM)
2. Full sync (PAL)
3. HTML backfill (PAL/NSM)
4. Summary backfill
5. Unavailable summary retry
6. isDone sync
7. Integrity check

추가로 정기 크론으로 보강 작업이 실행됩니다.

## 스케줄(기본값)

- `*/10 * * * *`: crawling check (PAL 중심 신규 감지/처리)
- `*/20 * * * *`: pending crawling check (NSM 발의 단계)
- `0 */6 * * *`: isDone sync
- `0 */1 * * *`: HTML backfill + summary pipeline
- `0 3 * * *`: integrity rescan
- `0 */1 * * *`: screenshot backfill (서비스 내 offset 적용)
- `1 0 * * *`: webhook cleanup
- `1 2 * * *`: webhook optimization
- `0 * * * *`: system monitoring

## API 엔드포인트

Base path: `/api`

| Method | Path                       | Description                                |
| ------ | -------------------------- | ------------------------------------------ |
| `POST` | `/webhooks`                | Discord 웹훅 등록 (PoW proof 필요)         |
| `GET`  | `/notices/recent`          | 최근 입법예고 목록                         |
| `GET`  | `/notices/archive`         | 아카이브 목록 조회(필터/정렬/페이지네이션) |
| `GET`  | `/notices/search`          | 통합 검색                                  |
| `GET`  | `/notices/:num/detail`     | 의안번호 상세(아카이브 기반)               |
| `GET`  | `/notices/:num/screenshot` | 아카이브 스크린샷 이미지                   |
| `GET`  | `/notices/:num/export`     | 아카이브 ZIP 내보내기                      |
| `GET`  | `/stats`                   | 런타임 통계(아카이브/요약/캐시 포함)       |
| `GET`  | `/batch/status`            | 배치 상태                                  |
| `GET`  | `/health`                  | 헬스 상태                                  |
| `GET`  | `/webhooks/stats/detailed` | 웹훅 상세 통계                             |
| `GET`  | `/webhooks/system-health`  | 웹훅 시스템 헬스                           |
| `GET`  | `/redis/status`            | Redis 상세 상태                            |
| `GET`  | `/redis/connection`        | Redis 연결 여부                            |
| `GET`  | `/packages`                | 패키지 버전 정보                           |

### 주요 쿼리 파라미터

`GET /api/notices/archive`

- `page` (default: `1`)
- `limit` (default: `10`, max: `50`)
- `search`
- `startDate`, `endDate`
- `sortOrder` (`asc` or `desc`, default: `desc`)
- `isDone` (`true`/`false`)
- `fullText` (`true`일 때 원문 텍스트 검색 포함)

`GET /api/notices/search`

- `q` (검색어)
- `page`, `limit`
- `includeDone` (default: `true`)

## 아카이브 Export ZIP 구성

`GET /api/notices/:num/export`는 다음 아티팩트를 ZIP으로 제공합니다.

- `<base>.json`: DB raw record + integrity snapshot + HTTP metadata
- `<base>.integrity.txt`: 무결성 메타데이터 텍스트
- `verify-integrity.sh`: Bash 검증 스크립트
- `verify-integrity.ps1`: PowerShell 검증 스크립트
- `screenshot.<format>`: 스크린샷이 존재할 때만 포함

`<base>`는 `lawcast-archive-<noticeNum>-<timestamp>` 형식입니다.

## Discord Debug Bridge

`DISCORD_BRIDGE_ENABLED=true`일 때 Discord 봇이 슬래시 커맨드를 등록합니다.

지원 명령:

- `/status`
- `/health`
- `/stats`
- `/cache`
- `/crawl`
- `/batch-history`
- `/webhooks`
- `/loglevel` (조회/변경)

`DISCORD_BRIDGE_GUILD_ID`가 설정되면 guild 명령으로 즉시 등록되고, 미설정 시 global 명령으로 등록됩니다(전파 지연 가능).

## 프로젝트 구조

```text
src/
├── app.module.ts
├── main.ts
├── config/
├── controllers/
├── e2e/
├── migrations/
├── modules/
│   ├── cache/
│   ├── crawling/
│   ├── discord-bridge/
│   ├── health/
│   ├── notice/
│   ├── notification/
│   ├── ollama/
│   ├── scheduling/
│   ├── shared/
│   └── webhook/
├── types/
└── utils/
```

## 라이선스

MIT
