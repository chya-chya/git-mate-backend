# 비동기 분석 인프라 운영 가이드

## 범위

`GitMateAsyncAnalysis-production` CDK 스택은 다음 리소스를 한 단위로 관리합니다.

- 공개 HTTP 진입점이 연결된 API Lambda
- SQS FIFO를 소비하는 Worker Lambda
- 1분마다 outbox를 복구하는 Reconciler Lambda
- source FIFO queue와 FIFO DLQ
- 역할별 최소 권한 IAM
- 보존형 CloudWatch Log Group, 로그 기반 지표, 대시보드와 알람
- 세 Lambda의 Active X-Ray tracing

PostgreSQL과 Secrets Manager secret 자체는 스택이 생성하거나 삭제하지 않습니다. 기존 운영 리소스를 참조하므로 CDK 삭제가 데이터베이스나 비밀값을 제거하지 않습니다.

## 운영 기본값

| 항목 | 값 |
| --- | ---: |
| Worker batch size | 1 |
| Worker timeout | 5분 |
| Source queue visibility timeout | 30분 |
| Worker reserved concurrency | 3 |
| SQS max receive count | 5 |
| DLQ alarm | visible message 1개 이상 |
| Queue age alarm | oldest message 10분 이상 |
| Source queue retention | 4일 |
| DLQ retention | 14일 |
| Reconciler schedule | 1분 |

visibility timeout은 Worker timeout의 6배이며, 부분 배치 실패 응답을 활성화합니다. FIFO 순서와 DB lease fencing이 최종 중복 방지를 담당합니다.

## 보안 경계

API Function URL은 GitHub OAuth callback과 webhook 수신을 위해 AWS IAM 인증 없이 공개됩니다. 애플리케이션의 사용자 API는 JWT를 검증하고, GitHub webhook은 서명을 검증합니다. 비동기 Job API는 사용자 소유권 검사와 사용자별 rate limit을 적용합니다.

역할별 SQS 권한은 다음으로 제한합니다.

| 역할 | 허용된 큐 작업 |
| --- | --- |
| API | source queue에 `SendMessage` |
| Worker | source queue의 `ReceiveMessage`, `DeleteMessage`, visibility 변경 |
| Reconciler | source queue에 `SendMessage` |

각 역할은 자기 Log Group 쓰기와 X-Ray segment 전송 권한만 추가로 가집니다. queue와 DLQ는 SQS 관리형 암호화와 TLS 강제를 사용합니다.

## Secrets Manager 계약

배포 시 전달하는 값은 secret 내용이 아니라 기존 secret의 전체 ARN뿐입니다. secret은 다음 JSON 키를 모두 가져야 합니다.

```json
{
  "DATABASE_URL": "...",
  "JWT_SECRET": "...",
  "ENCRYPTION_KEY": "64-character hex string",
  "OPENAI_API_KEY": "...",
  "GITHUB_CLIENT_ID": "...",
  "GITHUB_CLIENT_SECRET": "...",
  "GITHUB_CALLBACK_URL": "https://...",
  "GITHUB_APP_ID": "...",
  "GITHUB_APP_INSTALL_URL": "https://...",
  "GITHUB_APP_WEBHOOK_SECRET": "...",
  "GITHUB_APP_PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----..."
}
```

CloudFormation이 Secrets Manager dynamic reference를 배포 시점에 해석합니다. secret 값은 CDK 소스, 합성 template, Git 기록, 배포 명령에 들어가지 않습니다. secret을 회전한 뒤에는 Lambda 환경을 갱신하도록 같은 커밋에서 CDK를 다시 배포합니다.

## 최초 준비

1. AWS 계정과 리전에 CDK bootstrap을 한 번 수행합니다.
2. 위 계약의 Secrets Manager JSON secret을 준비합니다.
3. `prisma migrate deploy`로 기존 AnalysisJob migration이 적용됐는지 확인합니다.
4. 알람을 받을 이메일과 운영 담당자를 정합니다. 이메일 구독은 수신자가 확인해야 활성화됩니다.
5. 로컬 또는 CI에서 아래 검사를 통과시킵니다.

```bash
npm ci
npx prisma generate
npm run lint
npm run build
npm run test -- --runInBand
npm run infra:check
```

bootstrap 예시:

```bash
npx cdk bootstrap aws://ACCOUNT_ID/ap-northeast-2
```

## 변경 계획과 배포

```bash
export AWS_PROFILE='production-deployer'
export AWS_REGION='ap-northeast-2'
export RUNTIME_SECRET_ARN='arn:aws:secretsmanager:ap-northeast-2:ACCOUNT_ID:secret:git-mate-production-XXXXXX'
export FRONTEND_URL='https://frontend.example.com'
export ALARM_EMAIL='oncall@example.com'

./scripts/deploy_async_analysis.sh plan
./scripts/deploy_async_analysis.sh deploy
```

배포는 IAM 변경을 자동 승인하지 않습니다. CDK가 `broadening` 승인을 요구하면 역할별 정책 diff를 검토한 뒤 승인합니다. 이 PR은 AWS 배포나 데이터베이스 migration을 직접 실행하지 않습니다.

production 기본 배포는 API의 `ASYNC_ANALYSIS_ENABLED=true`와 Worker event source mapping을 동시에 활성화합니다. 기존 동기 API는 Swagger에서 deprecated로 표시되지만 전환 기간에는 롤백 경로로 남습니다.

## 배포 후 확인

1. stack output의 API Function URL과 queue URL을 기록합니다.
2. `GET /` health 응답과 Swagger의 동기 API deprecated 표시를 확인합니다.
3. 테스트 사용자로 `POST /analysis/jobs`를 한 번 호출하고 `202`, `Location`, `Retry-After`를 확인합니다.
4. 같은 idempotency key 재호출이 같은 Job을 반환하는지 확인합니다.
5. CloudWatch dashboard에서 queue depth, age, Worker invocation과 duration을 확인합니다.
6. Job이 `SUCCEEDED`가 되고 queue depth가 0으로 돌아오는지 확인합니다.
7. X-Ray service map에서 API, Worker, Reconciler invocation segment가 생성되는지 확인합니다.

실제 OpenAI 호출을 포함하는 smoke test는 운영 비용과 사용자 데이터를 사용하므로 별도 승인된 계정·저장소로만 수행합니다.

## 알람과 대응

| 알람 | 의미 | 첫 대응 |
| --- | --- | --- |
| `analysis-dlq-not-empty` | 최대 5회 수신 후에도 처리 실패 | DLQ 메시지의 `jobId`, Job 상태, Worker 로그를 함께 대사 |
| `analysis-queue-age` | oldest message가 10분 이상 대기 | Worker throttling/concurrency, DB·외부 API 장애 확인 |
| `worker-errors` | Lambda invocation 실패 | 해당 request ID와 X-Ray trace 확인 |
| `worker-job-failures` | 구조화된 Job 실패 로그 발생 | `lastErrorCode`, retryable 여부, 토큰 정산 확인 |
| `worker-throttles` | reserved concurrency 3 소진 | queue age와 DB connection 사용량 확인 후 용량 변경 검토 |
| `worker-duration-p95` | p95가 4분 이상 | GitHub 수집량과 OpenAI 지연을 확인하고 5분 timeout 접근 전 분할 검토 |
| `reconciler-errors` | outbox 복구 invocation 실패 | DB 연결과 SQS 발행 권한 확인 |

DLQ는 자동 소비하거나 자동 redrive하지 않습니다. 원인을 수정하고 Job의 DB 상태와 토큰 정산을 대사한 뒤 운영자가 제한된 수량만 source queue로 redrive합니다. queue 또는 DLQ를 purge하지 않습니다.

## 점진 전환과 롤백

긴급 중지는 새 Job 접수와 Worker 소비를 함께 끕니다. queue, DLQ, Job ledger는 보존됩니다.

```bash
./scripts/deploy_async_analysis.sh disable
```

확인 사항:

- `POST /analysis/jobs`가 `503 ASYNC_ANALYSIS_DISABLED`를 반환합니다.
- Worker event source mapping이 disabled입니다.
- 기존 queue와 DLQ 메시지 수가 유지됩니다.
- deprecated 동기 API는 전환 기간 동안 사용할 수 있습니다.

코드 롤백은 검증된 이전 Git ref를 별도 checkout에서 합성·검토한 뒤 같은 stack 이름으로 재배포합니다. 먼저 `disable`로 신규 유입을 막고, 이전 template의 queue 교체 여부가 없는지 `cdk diff`로 확인합니다. FIFO queue와 Log Group은 `Retain` 정책이므로 stack 삭제를 롤백 수단으로 사용하지 않습니다.

복구 후에는 아래 순서로 다시 켭니다.

1. 원인 수정과 migration 상태 확인
2. Worker mapping 활성화 배포
3. queue age와 DLQ를 감시하며 backlog 처리
4. 비동기 API 활성화
5. smoke test와 알람 정상화 확인
