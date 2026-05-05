# LawCast 백엔드

LawCast 서비스의 백엔드 API 서버입니다. NestJS 프레임워크를 기반으로 구축되었으며, 국회 입법예고 데이터를 크롤링하고 웹훅을 통해 디스코드 알림을 전송하는 기능을 제공합니다.

## 기능

- **크롤링 서비스**: 국회 입법예고 데이터를 주기적으로 수집
- **웹훅 관리**: 디스코드 웹훅 등록 및 관리
- **알림 서비스**: 입법예고 변동사항을 웹훅으로 전송
- **선택 요약 기능**: Ollama를 연결하면 "제안이유 및 주요내용" 핵심 요약을 알림 임베드에 포함
- **요약 캐시 파이프라인**: 서버 시작 초기 캐싱/신규 입법예고 감지 시점에 AI 요약을 생성해 캐시에 함께 저장
- **아카이브 동기화 파이프라인**: 서버 시작 시 4단계 동기화를 백그라운드로 순차 실행
  1. **전체 동기화** — 전체 입법예고 목록을 순회하며 누락된 레코드를 DB에 저장
  2. **isDone 동기화** — 크롤러의 완료 목록과 DB를 대조하여 `isDone` 플래그를 정합 상태로 유지
  3. **무결성 검사** — 모든 아카이브 레코드의 SHA-256 해시를 원문과 재대조하여 위변조 여부 기록
  4. **요약 백필** — AI 요약이 활성화된 경우, 기존 미처리(`not_requested`) 레코드를 순회하며 요약 생성
- **원문 조회 API**: 법률안 번호 기반으로 "제안이유 및 주요내용" 원문을 조회하는 상세 API 제공
- **아카이브 내보내기**: 특정 법률안의 원문·메타데이터·무결성 검증 스크립트를 ZIP으로 패키징하여 다운로드
- **Redis 캐시**: 분산 캐시 시스템으로 성능 최적화 및 데이터 영속성 보장
- **배치 처리**: 대량 데이터 처리 기능
- **HashGuard(PoW) 작업증명**: 웹훅 등록 시 스팸 방지
- **스케줄링**: 정기적인 작업 자동화

## 기술 스택

- **프레임워크**: NestJS
- **언어**: TypeScript
- **데이터베이스**: SQLite (TypeORM)
- **캐시**: Redis (@keyv/redis, @nestjs/cache-manager)
- **크롤링**: [pal-crawl](https://github.com/vientorepublic/pal-crawl)
- **알림**: [discord-webhook-node](https://github.com/matthew1232/discord-webhook-node)
- **스케줄링**: @nestjs/schedule

## 설치 및 실행

### 사전 요구사항

- Node.js (버전 18 이상)
- npm 또는 yarn
- Redis (버전 6 이상)

### 설치

```bash
npm install
```

### 환경 설정

프로젝트 루트에 `.env` 파일을 생성하고 다음 변수를 설정하세요:

요약 기능은 선택사항이며, `OLLAMA_ENABLED` 플래그를 기준으로 동작합니다.

- `OLLAMA_ENABLED=true` 이고 `OLLAMA_API_URL`, `OLLAMA_MODEL`이 모두 설정된 경우: AI 요약 기능 활성화
- `OLLAMA_ENABLED=false` 인 경우: 환경변수 값과 무관하게 AI 요약 기능 강제 비활성화
- `OLLAMA_ENABLED` 미설정인 경우: `OLLAMA_API_URL`, `OLLAMA_MODEL`이 모두 있을 때만 활성화

비활성화 시 서버는 요약 생성/재시도 로직을 모두 스킵하며, 관련 상태는 `not_requested`로 유지됩니다.

```env
# 서버 설정
PORT=3001
NODE_ENV=production

# 데이터베이스 설정
DATABASE_PATH=lawcast.db

# Redis 캐시 설정
REDIS_URL=redis://localhost:6379
REDIS_KEY_PREFIX=lawcast:
REDIS_TTL=1800

# HashGuard(PoW) API 설정 (선택사항)
HASHGUARD_API_URL=https://hashguard.viento.me

# Ollama 요약 API 설정 (선택사항)
# 명시적으로 켜고 싶으면 true, 끄려면 false
OLLAMA_ENABLED=false
# 활성화 시 필수
OLLAMA_API_URL=http://localhost:11434
OLLAMA_MODEL=gemma3:1b
OLLAMA_TIMEOUT=10000

# 크론 작업 시간대
CRON_TIMEZONE=Asia/Seoul

# CORS 허용 도메인 (쉼표로 구분)
FRONTEND_URL=http://localhost:5173,http://localhost:3002

# Discord 디버그 브릿지 (선택사항)
DISCORD_BRIDGE_ENABLED=false
DISCORD_BRIDGE_BOT_TOKEN=
DISCORD_BRIDGE_GUILD_ID=
DISCORD_BRIDGE_CHANNEL_ID=
DISCORD_BRIDGE_LOG_CHANNEL_ID=
DISCORD_BRIDGE_LOG_LEVEL=LOG
DISCORD_BRIDGE_ADMIN_USER_IDS=

```

### Discord 디버그 브릿지

`DISCORD_BRIDGE_ENABLED=true`로 설정하면 Discord 봇을 통해 서버 런타임 상태를 실시간으로 모니터링하고 조작할 수 있습니다.

| 환경변수                        | 필수 | 설명                                                                                     |
| ------------------------------- | ---- | ---------------------------------------------------------------------------------------- |
| `DISCORD_BRIDGE_ENABLED`        | -    | `true`로 설정해야 활성화 (기본값: `false`)                                               |
| `DISCORD_BRIDGE_BOT_TOKEN`      | ✅   | Discord 봇 토큰 (Developer Portal > Bot > Token)                                         |
| `DISCORD_BRIDGE_GUILD_ID`       | -    | 길드(서버) ID - 설정 시 슬래시 명령어 즉시 등록, 미설정 시 글로벌 등록 (최대 1시간 소요) |
| `DISCORD_BRIDGE_CHANNEL_ID`     | ✅   | 슬래시 명령어를 입력할 채널 Snowflake ID                                                 |
| `DISCORD_BRIDGE_LOG_CHANNEL_ID` | ✅   | 이벤트 로그가 전송될 채널 Snowflake ID                                                   |
| `DISCORD_BRIDGE_LOG_LEVEL`      | -    | 최대 로그 레벨: `ERROR` `WARN` `LOG` `DEBUG` `VERBOSE` (기본값: `LOG`)                   |
| `DISCORD_BRIDGE_ADMIN_USER_IDS` | ✅   | 명령어 사용 가능 유저 ID 목록, 쉼표 구분 (예: `111,222,333`)                             |

**봇 권한 요구사항**: 두 채널 모두 슬래시 명령어 사용 및 메시지 전송 권한 필요. `DISCORD_BRIDGE_GUILD_ID` 설정 시 명령어가 해당 서버에 즉시 등록됩니다.

**지원 명령어** (브릿지 채널, 관리자 전용):

| 명령어           | 설명                       |
| ---------------- | -------------------------- |
| `/status`        | 업타임, 메모리, Node 환경  |
| `/health`        | Redis·Ollama 헬스 체크     |
| `/stats`         | 런타임 집계 통계           |
| `/cache`         | 캐시 현황                  |
| `/crawl`         | 수동 크롤링 실행           |
| `/batch-history` | 최근 배치 작업 이력        |
| `/webhooks`      | 웹훅 통계                  |
| `/loglevel`      | 로그 레벨 조회/런타임 변경 |

### 실행

```bash
# 개발 모드
npm run start:dev

# 프로덕션 모드
npm run start:prod

# 디버그 모드
npm run start:debug
```

## 테스트

```bash
# 단위 테스트
npm run test

# E2E 테스트
npm run test:e2e

# 테스트 커버리지
npm run test:cov
```

## API 엔드포인트

| 메서드   | 경로                       | 설명                                                                |
| -------- | -------------------------- | ------------------------------------------------------------------- |
| `GET`    | `/api/notices/recent`      | 최근 입법예고 목록 조회 (Redis 캐시 활용)                           |
| `GET`    | `/api/notices/archive`     | 전체 입법예고 목록 조회 (검색/날짜 필터/정렬/페이지네이션)          |
| `GET`    | `/api/notices/:num/detail` | 특정 법률안 상세 조회 (원문: 제안이유 및 주요내용 포함)             |
| `GET`    | `/api/notices/:num/export` | 법률안 아카이브 ZIP 다운로드 (원문·메타데이터·무결성 검증 스크립트) |
| `POST`   | `/api/webhooks`            | 웹훅 등록                                                           |
| `DELETE` | `/api/webhooks/:id`        | 웹훅 삭제                                                           |
| `GET`    | `/api/stats`               | 시스템 통계 및 아카이브 동기화 상태 조회                            |
| `GET`    | `/api/batch/status`        | 배치 처리 상태 조회                                                 |
| `GET`    | `/api/health`              | 서버 상태 및 Redis 연결 상태 확인                                   |

### 전체 입법예고 목록 조회 파라미터

`GET /api/notices/archive`

지원 쿼리 파라미터:

- `page` : 페이지 번호 (기본값 `1`)
- `limit` : 페이지 크기 (기본값 `10`, 최대 `50`)
- `search` : 키워드 검색 (법률안명, 소관위원회, 원문 텍스트 일부)
- `startDate` : 시작일 (`YYYY-MM-DD`)
- `endDate` : 종료일 (`YYYY-MM-DD`)
- `sortOrder` : 의안번호 정렬 (`desc` 기본값, `asc` 지원)
- `isDone` : 완료 처리된 법률안 필터 (`true` / `false`, 미설정 시 전체 조회)

예시:

```http
GET /api/notices/archive?page=1&limit=10&search=교육&startDate=2026-04-01&endDate=2026-04-17&sortOrder=desc
```

참고:

- `startDate` / `endDate` 형식이 유효하지 않으면 해당 조건은 무시됩니다.
- 날짜 범위가 역순이어도 서버에서 내부적으로 범위를 보정해 조회합니다.

### 상세 조회 응답 예시

```json
{
  "success": true,
  "data": {
    "aiSummaryEnabled": true,
    "notice": {
      "num": 2212345,
      "subject": "예시 법률안",
      "aiSummary": "핵심 정책 변화 요약",
      "contentId": "PRC_..."
    },
    "originalContent": {
      "contentId": "PRC_...",
      "title": "[의안번호] 예시 법률안",
      "proposalReason": "제안이유 및 주요내용 원문"
    }
  }
}
```

### 아카이브 내보내기

`GET /api/notices/:num/export`

응답 형식: `application/zip`

ZIP 파일 내부 구성:

| 파일             | 설명                                                  |
| ---------------- | ----------------------------------------------------- |
| `source.html`    | 크롤링 당시의 원본 HTML                               |
| `integrity.json` | SHA-256 해시·검증 일시·통과 여부 등 무결성 메타데이터 |
| `verify.sh`      | Bash 기반 해시 검증 스크립트                          |
| `verify.ps1`     | PowerShell 기반 해시 검증 스크립트                    |

### AI 요약 기능 플래그 응답

프론트엔드가 AI 요약 UI를 렌더링할지 판단할 수 있도록 아래 API 응답에 `aiSummaryEnabled`가 포함됩니다.

- `GET /api/stats`
- `GET /api/notices/archive`
- `GET /api/notices/:num/detail`

권장 동작:

- `aiSummaryEnabled=false`이면 AI 요약 카드/안내 문구를 렌더링하지 않음
- `aiSummaryEnabled=true`일 때만 AI 요약 UI를 렌더링

## AI 요약 아키텍처

### aiSummaryStatus 상태값

각 아카이브 레코드는 `aiSummaryStatus` 필드로 요약 상태를 관리합니다.

| 상태값          | 의미                                                            |
| --------------- | --------------------------------------------------------------- |
| `not_requested` | 아직 요약 생성이 시도되지 않은 상태 (기본값)                    |
| `ready`         | 요약 생성 완료                                                  |
| `unavailable`   | 요약 생성 시도했으나 실패 (Ollama 응답 오류, 원문 조회 실패 등) |
| `not_supported` | 요약 생성이 불가한 법률안 유형 (지원 콘텐츠 없음)               |

### 활성화 상태

- **캐시 초기화 시점**: 최근 입법예고 목록을 크롤링한 뒤, 각 항목의 contentId를 기반으로 원문을 조회하고 Ollama 요약을 생성합니다.
- **신규 감지 시점**: 새로 감지된 입법예고에 대해서만 요약을 생성합니다.
- **재사용 전략**: 생성된 요약은 Redis 캐시에 저장되며, 이후 알림 전송/프론트 응답에서 우선 재사용됩니다.
- **요약 백필**: 서버 시작 시 아카이브 동기화 파이프라인 4단계로 실행됩니다. `not_requested` 상태로 남아있는 기존 레코드를 50개씩 배치로 순회하며 요약을 생성합니다. 처리된 레코드는 즉시 상태가 업데이트되어 다음 배치에서 제외됩니다(drain 패턴).
- **안정성 정책**: 요약 실패 시 전체 크롤링/알림 플로우를 중단하지 않고, 원문 조회 불가/요약 실패를 로그에 남긴 뒤 `unavailable` 상태로 기록합니다.

### 비활성화 상태

- Ollama 클라이언트 호출을 수행하지 않습니다.
- 서버 시작 초기화와 크론 사이클 모두에서 요약 생성/재시도 로직을 건너뜁니다.
- 요약 백필(Phase 4)도 AI가 비활성화된 경우 즉시 early exit하며, 레코드 상태를 변경하지 않습니다.
- 알림/응답은 요약 없이 동작하며, 요약 상태는 `not_requested`로 유지됩니다.

## 프로젝트 구조

```
src/
├── config/          # 환경변수 설정
├── controllers/     # API 컨트롤러
├── cronjobs/        # 스케줄 기반 크론 작업
├── dto/             # 데이터 전송 객체
├── e2e/             # E2E 테스트
├── entities/        # TypeORM 엔티티
├── migrations/      # DB 마이그레이션
├── modules/
│   ├── discord-bridge/  # 디스코드 디버그 브릿지
│   └── ollama/          # Ollama AI 클라이언트
├── services/        # 비즈니스 로직 서비스
├── types/           # 타입 정의
└── utils/           # 유틸리티 함수
```

## 라이선스

MIT License
