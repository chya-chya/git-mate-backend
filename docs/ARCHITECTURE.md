# Git-Mate 백엔드 모듈 아키텍처 가이드

이 문서는 `git-mate-backend` 프로젝트의 서버 아키텍처와 각 모듈의 역할에 대해 설명합니다. 본 프로젝트는 NestJS 프레임워크를 기반으로 하며, 기능별로 모듈화된 구조를 따릅니다.

## 1. 전체 구조 개요

프로젝트는 도메인 기반의 모듈 시스템을 채택하여 확장성과 유지보수성을 높였습니다. 모든 비즈니스 로직은 `src/` 폴더 내의 각 모듈에서 독립적으로 관리됩니다.

## 2. 모듈별 역할 정의

### 📂 Auth Module (`src/auth`)

- **역할**: 사용자 인증 및 권한 부여를 담당합니다.
- **주요 기능**:
  - GitHub OAuth 연동을 통한 로그인 처리.
  - JWT 기반의 세션 관리.
  - Progressive Authorization(필요 시점에 권한 요청) 로직 구현.

### 📂 User Module (`src/user`)

- **역할**: 사용자의 계정 정보 및 서비스 이용 관련 데이터(토큰 등)를 관리합니다.
- **주요 기능**:
  - 사용자 프로필(ID, 유저명, 아바타 등) 조회.
  - 사용 가능한 분석 토큰(`availableTokens`) 잔액 정보 제공.
  - 인증된 사용자의 데이터 접근 제어.

### 📂 Analysis Module (`src/analysis`)

- **역할**: 수집된 데이터를 가공하고 LLM(Large Language Model)을 통해 분석합니다.
- **상세 아키텍처**: 세부 서비스 구성 및 데이터 파이프라인은 [ANALYSIS_ARCHITECTURE.md](./ANALYSIS_ARCHITECTURE.md)를 참조하세요.
- **주요 기능**:
  - PR 리뷰 코멘트의 문맥 분석 및 정제(Refinement).
  - 커뮤니케이션 스타일 분류 및 핵심 지표 산출.
  - 가중 평균을 이용한 사용자 역량 통계 갱신.

### 📂 Collection Module (`src/collection`)

- **역할**: 외부 데이터 소스(GitHub)로부터 데이터를 효율적으로 수집합니다.
- **주요 기능**:
  - GitHub GraphQL API (v4) 연동.
  - Delta Sync (증분 동기화) 로직을 통한 데이터 수집 최적화.
  - PR, Review, Commit 데이터 파싱.

### 📂 Prisma Module (`src/prisma`)

- **역할**: 데이터베이스 접근 및 ORM 관리를 담당합니다.
- **주요 기능**:
  - `PrismaClient`를 확장한 `PrismaService` 제공.
  - 데이터베이스 연결 및 트랜잭션 관리.
  - 다른 모듈에서 DB에 접근할 수 있도록 전역 주입 가능.

## 3. 핵심 아키텍처 구성

- **Global Infrastructure**:
  - **Main**: `main.ts`에서 Swagger(API 문서화) 및 ValidationPipe(유효성 검사) 등을 전역 설정합니다.
  - **AppModule**: 모든 모듈을 통합하는 루트 모듈입니다.
- **Async Task Queue**:
  - `AnalysisJob`을 durable outbox로 사용하고 SQS FIFO에 최소 메시지를 발행합니다.
  - API 발행 실패는 독립 실행형 reconciler가 재발행하며, FIFO 중복 제거 ID와 DB 조건부 갱신으로 중복을 흡수합니다.

## 4. 디렉토리 구조 요약

```text
src/
├── app.module.ts        # 모든 모듈을 통합하는 루트 모듈
├── main.ts              # 서버 엔트리 포인트 및 전역 설정
├── auth/                # GitHub OAuth 및 인증 모듈
├── user/                # 사용자 정보 및 토큰 관리 모듈
├── analysis/            # LLM 분석 및 지표 산출 모듈
├── collection/          # GitHub 데이터 수집 모듈
└── prisma/              # 데이터베이스(Prisma) 연동 모듈
```
