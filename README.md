# LawCast Backend

국회 입법예고(PAL)와 국민참여입법센터(NSM)의 법률안 정보를 수집하고, 검색 가능한 아카이브와 변경 이력, 요약 및 알림 기능을 제공하는 NestJS API 서버입니다.

## 주요 기능

### 입법예고 수집 및 아카이브

- PAL과 NSM에서 신규 및 진행 중인 법률안을 정기적으로 수집합니다.
- NSM에서 먼저 확인된 법률안이 PAL에 공개되면 동일 의안으로 연결합니다.
- 원문, HTTP 메타데이터, 스크린샷을 보존하고 SHA-256으로 무결성을 검증합니다.
- 누락된 원문, 제안 이유, 요약 등의 데이터는 정기 작업에서 다시 수집합니다.
- 심사가 종료된 법률안의 상태를 주기적으로 갱신합니다.

### 조회 및 검색

- 최근 입법예고와 전체 아카이브를 페이지 단위로 조회할 수 있습니다.
- 의안명, 의안번호, 제안 이유, 발의자 등의 정보를 검색할 수 있습니다.
- 날짜, 처리 상태, 정렬 순서, 원문 포함 여부로 결과를 필터링할 수 있습니다.
- 자주 사용되는 검색어를 빠른 검색용 키워드로 제공합니다.
- Redis 캐시를 사용해 최근 목록과 검색 응답 성능을 높입니다.

### AI 요약

- Ollama를 연결하면 법률안 내용을 자동으로 요약합니다.
- 요약 생성에 실패하거나 아직 생성되지 않은 항목은 자동으로 재시도합니다.
- CPU 모드에서 배치 크기, 처리 간격, 동시 실행 수를 제한할 수 있습니다.
- Ollama를 설정하지 않아도 수집, 검색, 아카이브 기능은 정상 동작합니다.

### 변경 이력 및 무결성 감사

- 법률안의 주요 정보가 바뀌면 변경 전후 값과 감지 시점을 기록합니다.
- 법률안별 변경 타임라인과 특정 리비전 시점의 상세 정보를 조회할 수 있습니다.
- 소스에서 삭제되거나 의안번호가 변경된 경우도 무효화 이력으로 남깁니다.
- 변경 이력은 append-only 해시 체인으로 보호되며 일일 및 주간 감사로 누락이나 변조 여부를 검사합니다.
- 과거 버전에서 생성된 변경 이력도 당시 검증 규칙을 유지합니다.

### 알림

- 신규 입법예고와 주요 변경 사항을 Discord 웹훅으로 전송합니다.
- VAPID 기반 Web Push 구독 등록, 해지 및 브라우저 알림 전송을 지원합니다.
- 만료된 Web Push 구독은 자동으로 비활성화합니다.
- 웹훅 등록 시 HashGuard 기반 PoW 검증을 사용할 수 있습니다.

### 내보내기 및 운영

- 법률안별 원문, 변경 이력, 무결성 정보, 스크린샷을 ZIP 파일로 내보낼 수 있습니다.
- 헬스 상태, 배치 진행 상황, 캐시, Redis, 웹훅 통계를 API로 확인할 수 있습니다.
- 민감 테이블을 제외한 데이터베이스 덤프를 file.kiwi에 정기 백업할 수 있습니다.
- Discord Debug Bridge를 통해 상태 조회와 수집 작업 실행 등 운영 명령을 사용할 수 있습니다.

## 기술 스택

- Framework: NestJS 11
- Language: TypeScript
- Database: SQLite + TypeORM
- Cache: Redis (`@keyv/redis`, `@nestjs/cache-manager`)
- Crawler: `pal-crawl`
- Scheduler: `@nestjs/schedule`
- Notification: `discord-webhook-node`, `web-push`

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
# 개발 모드
npm run start:dev

# 디버그 모드
npm run start:debug

# 프로덕션 빌드 및 실행
npm run build
npm run start:prod
```

기본 API 포트는 `3001`이며 `PORT`로 변경할 수 있습니다.

### 테스트

```bash
npm run test
npm run test:cov
npm run test:e2e
```

## 환경 변수

프로젝트 루트의 `.env` 파일에서 서버와 선택 기능을 설정합니다.

```env
# Server
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
CRON_TIMEZONE=Asia/Seoul

# Database
DATABASE_PATH=lawcast.db

# Redis
REDIS_URL=redis://localhost:6379
REDIS_KEY_PREFIX=lawcast:
REDIS_TTL=1800

# HashGuard
HASHGUARD_API_URL=https://hashguard.viento.me
HASHGUARD_API_KEY=

# Web Push (optional)
WEB_PUSH_ENABLED=false
WEB_PUSH_VAPID_PUBLIC_KEY=
WEB_PUSH_VAPID_PRIVATE_KEY=
WEB_PUSH_SUBJECT=mailto:lawcast@example.com

# Ollama (optional)
OLLAMA_ENABLED=false
OLLAMA_CPU_MODE=false
OLLAMA_API_URL=http://localhost:11434
OLLAMA_MODEL=gemma3:1b
OLLAMA_TIMEOUT=10000

# Archive sync tuning
ARCHIVE_SYNC_CRAWLER_CONCURRENCY=4
ARCHIVE_SYNC_NSM_CRAWLER_CONCURRENCY=3
ARCHIVE_SYNC_DONE_CRAWLER_CONCURRENCY=3
ARCHIVE_SYNC_FULL_SYNC_APPLY_BATCH_SIZE=100
ARCHIVE_SYNC_FULL_SYNC_APPLY_BATCH_DELAY_MS=100
ARCHIVE_SYNC_PENDING_RECOMPARE_APPLY_BATCH_SIZE=100
ARCHIVE_SYNC_PENDING_RECOMPARE_APPLY_BATCH_DELAY_MS=150
ARCHIVE_SYNC_ASYNC_APPLY_QUEUE_TTL_SECONDS=604800
ARCHIVE_SYNC_SUMMARY_BACKFILL_CPU_BATCH_SIZE=5
ARCHIVE_SYNC_SUMMARY_BACKFILL_CPU_BATCH_DELAY_MS=250
ARCHIVE_SYNC_SUMMARY_BACKFILL_CPU_CONCURRENCY=1

# Database mirror to file.kiwi (optional)
FILE_MIRROR_ENABLED=false
FILE_MIRROR_CRON=47 6 * * *
FILE_MIRROR_API_BASE_URL=https://api.file.kiwi
FILE_MIRROR_DUMP_DIR=./tmp/db-mirror
FILE_MIRROR_TITLE_PREFIX=lawcast-db-mirror
FILE_MIRROR_KEEP_LOCAL_DUMP=false
FILE_MIRROR_TEST_UPLOAD_ON_STARTUP=false
FILE_MIRROR_DISCORD_CHANNEL_ID=

# Discord Debug Bridge (optional)
DISCORD_BRIDGE_ENABLED=false
DISCORD_BRIDGE_BOT_TOKEN=
DISCORD_BRIDGE_GUILD_ID=
DISCORD_BRIDGE_CHANNEL_ID=
DISCORD_BRIDGE_LOG_CHANNEL_ID=
DISCORD_BRIDGE_LOG_LEVEL=LOG
DISCORD_BRIDGE_ADMIN_USER_IDS=
```

### Ollama 설정

- `OLLAMA_ENABLED=true`: AI 요약을 활성화합니다.
- `OLLAMA_ENABLED=false`: AI 요약을 비활성화합니다.
- `OLLAMA_ENABLED` 미설정: `OLLAMA_API_URL`과 `OLLAMA_MODEL`이 모두 있을 때 활성화합니다.

CPU 사용량을 낮추려면 다음과 같이 설정합니다.

```env
OLLAMA_ENABLED=true
OLLAMA_CPU_MODE=true
OLLAMA_API_URL=http://localhost:11434
OLLAMA_MODEL=gemma3:1b
OLLAMA_TIMEOUT=30000
ARCHIVE_SYNC_SUMMARY_BACKFILL_CPU_BATCH_SIZE=5
ARCHIVE_SYNC_SUMMARY_BACKFILL_CPU_BATCH_DELAY_MS=250
ARCHIVE_SYNC_SUMMARY_BACKFILL_CPU_CONCURRENCY=1
```

### Web Push 설정

1. VAPID 키를 생성합니다.

```bash
npx web-push generate-vapid-keys
```

2. 생성된 키를 `.env`에 설정합니다.

```env
WEB_PUSH_ENABLED=true
WEB_PUSH_VAPID_PUBLIC_KEY=...
WEB_PUSH_VAPID_PRIVATE_KEY=...
WEB_PUSH_SUBJECT=mailto:lawcast@example.com
```

`WEB_PUSH_ENABLED=true`이고 공개키와 비밀키가 모두 설정되어야 Web Push가 활성화됩니다. 개발 도메인과 운영 도메인은 각각 별도의 브라우저 구독이 필요합니다.

### 데이터베이스 미러 설정

`FILE_MIRROR_ENABLED=true`로 설정하면 지정된 스케줄에 따라 민감 테이블을 제외한 SQLite 덤프를 file.kiwi에 업로드합니다. 로컬 덤프 보존 여부와 Discord 알림 채널을 추가로 설정할 수 있습니다.

## API

Base path: `/api`

### 법률안 및 아카이브

| Method | Path                       | Description                              |
| ------ | -------------------------- | ---------------------------------------- |
| `GET`  | `/notices/recent`          | 최근 입법예고 목록                       |
| `GET`  | `/notices/keywords`        | 빠른 검색용 추천 키워드                  |
| `GET`  | `/notices/archive`         | 아카이브 목록 조회, 필터 및 페이지네이션 |
| `GET`  | `/notices/search`          | 법률안 통합 검색                         |
| `GET`  | `/notices/:num/detail`     | 법률안 상세 또는 특정 리비전 조회        |
| `GET`  | `/notices/:num/changes`    | 법률안별 변경 타임라인                   |
| `GET`  | `/notices/changes`         | 전체 변경 이벤트 목록                    |
| `GET`  | `/notices/changes/summary` | 비교 가능한 변경 이벤트 통계             |
| `GET`  | `/notices/:num/screenshot` | 보관된 법률안 스크린샷                   |
| `GET`  | `/notices/:num/export`     | 법률안 아카이브 ZIP 내보내기             |

### 알림

| Method   | Path                  | Description                      |
| -------- | --------------------- | -------------------------------- |
| `POST`   | `/webhooks`           | Discord 웹훅 등록                |
| `GET`    | `/push/public-key`    | Web Push 공개키 및 활성화 상태   |
| `POST`   | `/push/subscriptions` | Web Push 구독 등록 또는 재활성화 |
| `DELETE` | `/push/subscriptions` | Web Push 구독 해지               |

### 운영 상태

| Method | Path                       | Description               |
| ------ | -------------------------- | ------------------------- |
| `GET`  | `/stats`                   | 아카이브, 요약, 캐시 통계 |
| `GET`  | `/batch/status`            | 배치 작업 상태            |
| `GET`  | `/health`                  | 서버 헬스 상태            |
| `GET`  | `/webhooks/stats/detailed` | 웹훅 상세 통계            |
| `GET`  | `/webhooks/system-health`  | 웹훅 시스템 상태          |
| `GET`  | `/redis/status`            | Redis 상세 상태           |
| `GET`  | `/redis/connection`        | Redis 연결 여부           |
| `GET`  | `/packages`                | 주요 패키지 버전          |

### 주요 쿼리 파라미터

`GET /api/notices/keywords`

- `limit`: 응답 개수, 기본값 `8`

`GET /api/notices/archive`

- `page`: 페이지, 기본값 `1`
- `limit`: 페이지당 항목 수, 기본값 `10`, 최대 `50`
- `search`: 검색어
- `startDate`, `endDate`: 날짜 범위
- `sortOrder`: `asc` 또는 `desc`, 기본값 `desc`
- `isDone`: 종료 여부 (`true` 또는 `false`)
- `fullText`: `true`이면 원문 텍스트 포함 검색

`GET /api/notices/search`

- `q`: 검색어
- `page`: 페이지, 기본값 `1`
- `limit`: 페이지당 항목 수, 기본값 `10`, 최대 `50`
- `includeDone`: 종료된 법률안 포함 여부, 기본값 `true`

`GET /api/notices/:num/detail`

- `rev`: 조회할 변경 리비전, `1` 이상의 정수

`GET /api/notices/:num/changes`

- `limit`: 응답 개수, 기본값 `20`

`GET /api/notices/changes`

- `page`: 페이지, 기본값 `1`
- `limit`: 페이지당 항목 수, 기본값 `20`
- `eventType`: `updated` 또는 `invalidated`
- `excludeLegacyGenesisSource`: 레거시 초기 이벤트 제외 여부
- `comparableOnly`: 비교 가능한 변경 이벤트만 조회할지 여부

## 아카이브 내보내기

`GET /api/notices/:num/export`는 다음 파일을 ZIP으로 제공합니다.

- `<base>.json`: 법률안 원본 레코드, 무결성 정보, HTTP 메타데이터
- `<base>.changes.json`: 변경 타임라인과 필드별 변경 내용
- `<base>.integrity.txt`: 무결성 검증 정보
- `verify-integrity.sh`: Bash 검증 스크립트
- `verify-integrity.ps1`: PowerShell 검증 스크립트
- `screenshot.<format>`: 보관된 스크린샷이 있을 때 포함

파일명 기준인 `<base>`는 `lawcast-archive-<noticeNum>-<timestamp>` 형식입니다.

## 기본 스케줄

시간대는 `CRON_TIMEZONE`으로 설정하며 기본 운영 기준은 다음과 같습니다.

| Schedule          | Task                               |
| ----------------- | ---------------------------------- |
| `2-59/10 * * * *` | PAL 신규 및 변경 법률안 확인       |
| `6-59/20 * * * *` | NSM 발의 단계 법률안 확인          |
| `9-59/15 * * * *` | 누락된 제안 이유 재수집            |
| `11 * * * *`      | 추천 검색어 갱신                   |
| `13 */6 * * *`    | 법률안 종료 상태 갱신              |
| `43 3 * * *`      | 아카이브 무결성 재검사             |
| `7 4 * * *`       | 변경 이력 일일 감사                |
| `19 4 * * 1`      | 변경 이력 주간 감사                |
| `1 0 * * *`       | 웹훅 정리                          |
| `1 2 * * *`       | 웹훅 데이터 최적화                 |
| `0 * * * *`       | 시스템 상태 점검                   |
| `31 5 * * 0`      | SQLite 파일 공간 회수              |
| `47 6 * * *`      | file.kiwi 데이터베이스 미러 업로드 |

동시에 실행하면 충돌할 수 있는 수집, 동기화, 감사 작업은 자동으로 중복 실행을 피합니다.

## Discord Debug Bridge

`DISCORD_BRIDGE_ENABLED=true`일 때 다음 슬래시 명령을 사용할 수 있습니다.

| Command          | Description                      |
| ---------------- | -------------------------------- |
| `/status`        | 서비스 상태 조회                 |
| `/health`        | 헬스 상태 조회                   |
| `/stats`         | 주요 통계 조회                   |
| `/cache`         | 캐시 상태 조회                   |
| `/crawl`         | 수집 작업 실행                   |
| `/batch-history` | 배치 실행 이력 조회              |
| `/webhooks`      | 웹훅 상태 조회                   |
| `/loglevel`      | 로그 레벨 조회 또는 변경         |
| `/locks`         | 예약 작업 실행 및 대기 상태 조회 |

`DISCORD_BRIDGE_GUILD_ID`를 설정하면 해당 서버에 명령이 즉시 등록됩니다. 설정하지 않으면 전역 명령으로 등록되어 반영까지 시간이 걸릴 수 있습니다.

## 프로젝트 구조

```text
src/
├── config/       # 환경 설정
├── controllers/  # HTTP API
├── e2e/          # E2E 테스트
├── migrations/   # 데이터베이스 마이그레이션
├── modules/      # 도메인 기능
├── types/        # 공통 타입
└── utils/        # 공통 유틸리티
```

## 라이선스

MIT
