# Git-Mate Backend - AI Coder Guide

이 문서는 Git-Mate Backend 프로젝트 환경에서 코드 작성, 수정, 디버깅을 수행하는 에이전트를 위한 기준 가이드입니다. **모든 코드 생성 및 수정 작업 시 이 원칙을 절대 기준으로 삼아주세요.**

## 1. Project Overview
- **목적:** GitHub PR 리뷰 및 코멘트 데이터를 분석하여 개발자의 커뮤니케이션 성향을 객관화하고, 상호보완적인 동료를 추천하는 서비스.
- **타겟 고객:** 자신의 코드 리뷰 스타일을 객관적으로 파악하고 개선하고 싶은 개발자, 시너지를 고려해 팀을 구성하려는 리더.

## 2. Tech Stack
- **Framework:** NestJS
- **Language:** TypeScript
- **Database & ORM:** PostgreSQL, Prisma (`@prisma/client`)
- **Queue/Cache:** BullMQ (Redis)
- **API Docs:** Swagger (`@nestjs/swagger`)
- **Testing & Tools:** Jest, ESLint, Prettier

## 3. Architecture
- **레이어드 아키텍처:** 표준 NestJS 모듈형 패턴 (Module -> Controller -> Service).
- **데이터 흐름:** Client -> Controller (DTO 검증 및 Swagger 명세) -> Service (비즈니스 로직 및 외부 API/GitHub 데이터 처리) -> Prisma DB 접근.
- **비동기 처리:** 대규모 데이터(PR 리뷰 등) 스크래핑/분석은 BullMQ를 이용해 비동기 작업 큐로 분리하여 처리.

## 4. Coding Conventions
- **Naming Rule:** 변수/함수는 camelCase, 클래스와 인터페이스/DTO는 PascalCase, DB 컬럼은 snake_case (또는 Prisma 매핑 준수)를 사용합니다.
- **DTO Validation:** `class-validator`, `class-transformer`를 활용하여 모든 요청(Controller 입출력)을 엄격히 검증합니다.
- **코드 품질:** 작업 후 반드시 `npm run lint`를 통해 스타일 가이드 위배 여부를 확인하고 수정해야 합니다.

## 5. API Design System
- 엔드포인트 명명은 RESTful 원칙을 준수합니다.
- 모든 기능은 Swagger 데코레이터(`@ApiOperation`, `@ApiResponse`, `@ApiProperty` 등)를 통해 필수적으로 문서화합니다.

## 6. Content and Copy Guidance
- 코드 내 주석과 에러 로그는 트러블슈팅이 쉽도록 명확하고 구체적으로 작성합니다. (로깅/명명은 영어, 사용자/개발자 가이드 문서는 한글 선호).
- 에이전트의 답변이나 아티팩트는 한국어를 기본으로 합니다.

## 7. Testing and Quality Bar
- 주요 비즈니스 로직과 데이터 분석/추천 알고리즘 작업 시 단위 테스트(`*.spec.ts`)를 작성해야 합니다.
- **Definition of Done (완료 기준):** 로컬 환경에서 `npm run lint`와 `npm run test` 통과 확인.

## 8. File and Content Placement
- 애플리케이션 코드는 `src/` 내에 도메인별 디렉토리 단위(예: `src/analysis/`, `src/github/`)로 응집도 높게 배치합니다.
- DTO 및 타입 정의는 도메인별 하위 디렉토리(예: `dto/`)에 명확하게 분리합니다.

## 9. Safe Change Rules (안전 변경 규칙)
- **DB 스키마 변경:** `prisma/schema.prisma` 변경이나 DB 데이터 직접 수정 시 **반드시 사용자에게 수정 전/후 예측 결과를 보고하고 승인을 받은 후** 진행해야 합니다.
- **코어 설정 변경 제한:** 인증/인가(JWT, Passport 로직), 외부 API 인증 구조, Redis/BullMQ 연결 설정 관련 코드는 사전 협의 없이 함부로 수정하지 마세요.

## 10. Specific Commands
- 개발 서버 실행: `npm run dev` (또는 `npm run start:dev`)
- 린트 검사 및 수정: `npm run lint`
- 코드 포맷팅: `npm run format`
- 프리즈마 생태계: `npx prisma generate` / `npx prisma db push` (DB 수정 시)
## 11. Deployment (AWS Lambda)
- **배포 스크립트:** `./scripts/deploy_lambda.sh`
- **배포 설정:** 보안 및 관리 편의성을 위해 다음 항목을 `.env` 파일에서 관리합니다.
  - `AWS_ACCOUNT_ID`, `AWS_REGION`, `AWS_ECR_IMAGE_NAME`, `AWS_LAMBDA_FUNCTION_NAME`
- **실행 방법:**
  ```bash
  # 배포 실행
  ./scripts/deploy_lambda.sh
  ```
- **핵심 설정 (스크립트 내부):**
  - `--platform linux/amd64` (Lambda 호환성) / `--provenance=false` (매니페스트 호환성)
