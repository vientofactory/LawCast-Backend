# LawCast 백엔드

LawCast 서비스의 백엔드 API 서버입니다. NestJS 프레임워크를 기반으로 구축되었으며, 국회 입법예고 데이터를 크롤링하고 웹훅을 통해 디스코드 알림을 전송하는 기능을 제공합니다.

## 기능

- **크롤링 서비스**: 국회 입법예고 데이터를 주기적으로 수집
- **웹훅 관리**: 디스코드 웹훅 등록 및 관리
- **알림 서비스**: 입법예고 변동사항을 웹훅으로 전송
- **선택 요약 기능**: Ollama를 연결하면 "제안이유 및 주요내용" 핵심 요약을 알림 임베드에 포함
- **요약 캐시 파이프라인**: 서버 시작 초기 캐싱/신규 입법예고 감지 시점에 AI 요약을 생성해 캐시에 함께 저장
- **원문 조회 API**: 법률안 번호 기반으로 "제안이유 및 주요내용" 원문을 조회하는 상세 API 제공
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

요약 기능은 선택사항입니다. Ollama 연결 정보를 설정하면 알림에 "제안이유 및 주요내용" 핵심 요약이 함께 전송됩니다. 값을 설정하지 않으면 기존 알림(요약 없음)으로 동작합니다.

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
OLLAMA_API_URL=http://localhost:11434
OLLAMA_MODEL=gemma3:1b # 명시하지 않을 경우 기본값으로 gemma3:1b 사용
OLLAMA_TIMEOUT=10000

# 크론 작업 시간대
CRON_TIMEZONE=Asia/Seoul

# CORS 허용 도메인 (쉼표로 구분)
FRONTEND_URL=http://localhost:5173,http://localhost:3002

```

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

- `GET /api/notices/recent` - 최근 입법예고 목록 조회 (Redis 캐시 활용)
- `GET /api/notices/archive` - 전체 입법예고 목록 조회 (검색/날짜 필터/정렬/페이지네이션)
- `GET /api/notices/:num/detail` - 특정 법률안 상세 조회 (원문: 제안이유 및 주요내용 포함)
- `POST /api/webhooks` - 웹훅 등록
- `DELETE /api/webhooks/:id` - 웹훅 삭제
- `GET /api/stats` - 시스템 통계 및 Redis 캐시 정보 조회
- `GET /api/health` - 서버 상태 및 Redis 연결 상태 확인

### 전체 입법예고 목록 조회 파라미터

`GET /api/notices/archive`

지원 쿼리 파라미터:

- `page` : 페이지 번호 (기본값 `1`)
- `limit` : 페이지 크기 (기본값 `10`, 최대 `50`)
- `search` : 키워드 검색 (법률안명, 소관위원회, 원문 텍스트 일부)
- `startDate` : 시작일 (`YYYY-MM-DD`)
- `endDate` : 종료일 (`YYYY-MM-DD`)
- `sortOrder` : 의안번호 정렬 (`desc` 기본값, `asc` 지원)

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

## AI 요약 아키텍처

- 캐시 초기화 시점: 최근 입법예고 목록을 크롤링한 뒤, 각 항목의 contentId를 기반으로 원문을 조회하고 Ollama 요약을 생성합니다.
- 신규 감지 시점: 새로 감지된 입법예고에 대해서만 요약을 생성합니다.
- 재사용 전략: 생성된 요약은 Redis 캐시에 저장되며, 이후 알림 전송/프론트 응답에서 우선 재사용됩니다.
- 안정성 정책: 요약 실패 시 전체 크롤링/알림 플로우를 중단하지 않고, 원문 조회 불가/요약 실패를 로그에 남긴 뒤 null 요약으로 처리합니다.

## 프로젝트 구조

```
src/
├── config/          # 설정 파일
├── controllers/     # API 컨트롤러
├── services/        # 비즈니스 로직 서비스
├── entities/        # 데이터베이스 엔티티
├── dto/            # 데이터 전송 객체
├── types/          # 타입 정의
└── utils/          # 유틸리티 함수
```

## 라이선스

MIT License
