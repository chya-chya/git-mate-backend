# Git-Mate Backend

GitHub Pull Request와 리뷰 활동을 수집해 개발자의 협업·엔지니어링 역량을 분석하는 NestJS 백엔드입니다. PostgreSQL/Prisma를 영속 저장소로 사용하며, 운영 분석은 SQS FIFO와 Lambda Worker로 비동기 처리합니다.

## 주요 구성

- API: NestJS, Swagger, JWT 인증
- 데이터: PostgreSQL, Prisma
- 비동기 분석: `AnalysisJob` outbox, SQS FIFO, Worker Lambda
- 복구: EventBridge로 실행되는 Reconciler Lambda
- AI 분석: `gpt-5-mini`, Structured Outputs, 결정적 evidence 검증
- 인프라: AWS CDK, CloudWatch, X-Ray

## 로컬 실행

```bash
npm ci
npx prisma generate
npm run start:dev
```

로컬 SQS 통합 환경은 `docker-compose.yml`과 `scripts/localstack/init-sqs.sh`를 사용합니다. 필요한 환경 변수와 메시지 계약은 [SQS 분석 Job 문서](docs/SQS_ANALYSIS_JOBS.md)를 참고하세요.

## 검사

```bash
npm run lint
npm run build
npm run test -- --runInBand
npm run analysis:eval:ci
npm run infra:check
```

`infra:check`는 CDK TypeScript 검사, assertion 테스트, CloudFormation 합성을 네트워크 호출 없이 수행합니다.

## 비동기 분석 API

운영 CDK 스택은 `ASYNC_ANALYSIS_ENABLED=true`로 배포됩니다.

- `POST /analysis/jobs`: 분석 Job 접수
- `GET /analysis/jobs`: 현재 사용자의 Job 목록
- `GET /analysis/jobs/:id`: Job 상태 조회
- `POST /analysis/jobs/:id/retry`: 재시도 가능한 실패 Job 재접수

기존 `POST /collection/sync/:githubRepoId`는 전환 기간을 위한 deprecated 동기 경로입니다. 신규 클라이언트는 비동기 API를 사용해야 합니다.

## AWS 배포

CDK 스택은 API Lambda, Worker Lambda, Reconciler, FIFO 큐와 DLQ, 최소 권한 IAM, CloudWatch 대시보드·알람, X-Ray를 함께 관리합니다.

```bash
export RUNTIME_SECRET_ARN='arn:aws:secretsmanager:REGION:ACCOUNT:secret:NAME'
# 선택 사항: 생략하면 스크립트가 AWSCURRENT VersionId를 조회합니다.
# export RUNTIME_SECRET_VERSION_ID='00000000-0000-0000-0000-000000000000'
export FRONTEND_URL='https://frontend.example.com'
export ALARM_EMAIL='oncall@example.com'

# 최초 배포: 외부 라우팅을 바꾸기 전에 비동기 접수와 소비를 끈 채 생성
./scripts/deploy_async_analysis.sh plan-provision
./scripts/deploy_async_analysis.sh provision
# Function URL 기준으로 secret과 GitHub OAuth callback/webhook을 갱신한 뒤 활성화
./scripts/deploy_async_analysis.sh deploy
# smoke test 통과 후 프론트엔드 API base를 새 Function URL로 전환
```

실제 AWS 배포와 비밀값 변경은 이 저장소의 테스트 과정에서 수행하지 않습니다. 사전 조건, Secrets Manager JSON 계약, 배포 확인, 알람 대응 및 롤백은 [비동기 분석 운영 가이드](docs/ASYNC_ANALYSIS_OPERATIONS.md)에 정리되어 있습니다.

## 설계 문서

- [비동기 분석 운영 가이드](docs/ASYNC_ANALYSIS_OPERATIONS.md)
- [SQS 분석 Job 계약](docs/SQS_ANALYSIS_JOBS.md)
- [비동기 파이프라인 ADR](docs/adr/0001-asynchronous-analysis-pipeline.md)
- [분석 품질 평가](docs/ANALYSIS_EVALUATIONS.md)
- [전체 아키텍처](docs/ARCHITECTURE.md)
