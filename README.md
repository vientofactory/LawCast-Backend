# LawCast 백엔드

LawCast 서비스의 백엔드 API 서버입니다. NestJS 프레임워크를 기반으로 구축되었으며, 국회 입법예고 데이터를 크롤링하고 웹훅을 통해 디스코드 알림을 전송하는 기능을 제공합니다.

## 기능

- **크롤링 서비스**: 국회 입법예고 데이터를 주기적으로 수집
- **웹훅 관리**: 디스코드 웹훅 등록 및 관리
- **알림 서비스**: 입법예고 변동사항을 웹훅으로 전송
- **Redis 캐시**: 분산 캐시 시스템으로 성능 최적화 및 데이터 영속성 보장
- **배치 처리**: 대량 데이터 처리 기능
- **reCAPTCHA 검증**: 웹훅 등록 시 봇 방지
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

# reCAPTCHA 설정
RECAPTCHA_SECRET_KEY=your-recaptcha-secret-key

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
- `POST /api/webhooks` - 웹훅 등록
- `DELETE /api/webhooks/:id` - 웹훅 삭제
- `GET /api/stats` - 시스템 통계 및 Redis 캐시 정보 조회
- `GET /api/health` - 서버 상태 및 Redis 연결 상태 확인

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
