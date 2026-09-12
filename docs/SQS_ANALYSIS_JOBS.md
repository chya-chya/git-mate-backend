# Analysis Job SQS 로컬 운영 가이드

비동기 Analysis Job은 PostgreSQL의 `AnalysisJob`을 outbox로 사용하고 SQS FIFO에 다음
최소 메시지만 발행합니다.

```json
{ "schemaVersion": 1, "jobId": "job UUID" }
```

## 환경 설정

| 변수 | 기본값 또는 용도 |
| --- | --- |
| `AWS_REGION` | SQS 리전. 발행 시 필수 |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | LocalStack은 `test`; 운영은 secret manager 또는 실행 역할 사용 |
| `SQS_ENDPOINT` | LocalStack은 `http://localhost:4566`; 운영 AWS에서는 생략 |
| `ANALYSIS_JOB_QUEUE_URL` | `.fifo`로 끝나는 source queue URL. 발행 시 필수 |
| `ANALYSIS_JOB_PUBLISH_MAX_ATTEMPTS` | 기본 `5` |
| `ANALYSIS_JOB_REPUBLISH_AFTER_SECONDS` | 기본 `60` |
| `ANALYSIS_JOB_RECONCILE_BATCH_SIZE` | 기본 `20` |
| `ASYNC_ANALYSIS_ENABLED` | 기본 `false`; 이번 단계에서는 켜지 않음 |

기능 플래그가 꺼져 있고 SQS 설정이 없어도 API는 시작됩니다. 이미 접수된 Job을 복구하는
reconciler는 기능 플래그와 독립적이며, 실제 발행 시 설정이 없으면 안전한 설정 오류를
기록하고 Job을 유지합니다.

## LocalStack 실행과 확인

```bash
docker compose up -d db localstack
docker compose ps
aws --endpoint-url=http://localhost:4566 sqs list-queues --region us-east-1
```

초기화 스크립트가 `git-mate-analysis.fifo`와 `git-mate-analysis-dlq.fifo`를 만듭니다.
로컬 reconciler는 API 컨테이너 또는 동일한 환경 변수가 설정된 셸에서 한 번 실행합니다.

```bash
npm run analysis-jobs:reconcile
```

통합 테스트는 queue를 purge하고 고유한 Job ID를 사용합니다.

```bash
RUN_SQS_INTEGRATION_TESTS=true npm test -- --runInBand \
  src/analysis-job/test/sqs-analysis-job.integration.spec.ts
```

운영 스케줄은 후속 인프라 PR에서 EventBridge 1분 스케줄 또는 전용 Lambda에 이 1회성
entrypoint를 연결합니다. API 프로세스의 timer에는 의존하지 않습니다.

## Analysis Worker

Lambda handler export 경로는
`dist/analysis-worker/analysis-worker.handler.handler`입니다. handler는 HTTP 서버를 열지 않고
Nest application context만 만들며, warm invocation에서는 같은 context를 재사용합니다.
운영 event source mapping과 Lambda concurrency/timeout 설정은 후속 인프라 PR 범위입니다.

Worker가 허용하는 본문은 아래 두 필드만 포함하는 JSON object입니다. UUID는 소문자로
정규화되어야 하며 추가 필드는 거부합니다. 사용자·저장소·증분 수집 기준은 메시지가 아니라
`jobId`로 조회한 PostgreSQL 값을 사용합니다.

```json
{ "schemaVersion": 1, "jobId": "8fe6a55c-956a-4d8f-985f-fcf2bc72e34c" }
```

유효한 Job ID가 없는 malformed message는 외부 API를 호출하지 않고 ack하여 poison loop를
막습니다. 유효한 Job ID가 있으나 버전 또는 구조가 잘못된 메시지는 `QUEUED` Job만
`INVALID_MESSAGE`로 종결합니다. SQS 본문, 전체 message attributes, GitHub/OpenAI token,
프롬프트·응답 원문, 전체 lease token은 로그에 기록하지 않습니다.

### 상태, lease, 진행률

| 시점 | status / stage | progress |
| --- | --- | ---: |
| 조건부 claim | `RUNNING / COLLECTING` | 10 |
| GitHub 수집 완료 | `RUNNING / RESERVING_TOKENS` | 35 |
| 토큰 예약 완료 | `RUNNING / ANALYZING` | 55 |
| 결과 저장 시작 | `RUNNING / SAVING` | 90 |
| 트랜잭션 성공 | `SUCCEEDED / null` | 100 |

`QUEUED` claim과 만료 lease takeover는 DB 조건부 갱신으로 `attemptCount`를 한 번만
증가시킵니다. 기본 lease는 15분이며 `ANALYSIS_WORKER_LEASE_SECONDS`로 1~3600초 범위에서
조정할 수 있습니다. 단계 변경마다 `heartbeatAt`과 만료 시각을 갱신하고, 모든 RUNNING
갱신은 `jobId + status + leaseToken` fence를 사용합니다. 유효한 lease가 있으면 현재 record를
재시도하여 다른 Worker의 실행을 방해하지 않습니다.

GitHub 수집 후에만 토큰을 예약하고, 이미 예약된 재시도 Job은 다시 차감하지 않습니다.
성공 또는 분석 데이터 없음에서만 `repository.lastSyncTime`을 Job의 `createdAt`까지 단조
증가시킵니다. 이 checkpoint는 리포트·통계·토큰 정산·Job 종결과 같은 transaction에
포함됩니다.

### 오류와 부분 배치 실패

| 분류 | 예시 | 처리 |
| --- | --- | --- |
| 재시도 가능 | GitHub/OpenAI 429·5xx·timeout, DB 연결/충돌, stale lease | provider 과금 증거가 없으면 `QUEUED / WAITING`, 지수 backoff+jitter, record failure |
| 재시도 불가 | 설치/권한 상실, OpenAI 400·401, 버전 불일치, 토큰 부족, invalid response | 예약 토큰을 한 번 정산하고 `FAILED`, record ack |
| 대사 필요 | provider request ID 또는 사용량이 확인된 뒤 저장 실패 | `PROVIDER_RECONCILIATION_REQUIRED`로 격리하고 OpenAI 자동 재호출 금지 |

Lambda 응답의 `itemIdentifier`는 Job ID가 아니라 SQS `messageId`입니다. FIFO 순서를 위해 첫
재시도 가능 실패부터 배치의 나머지 record를 처리하지 않고 모두 실패 목록에 포함합니다.
application context 생성 실패도 전체 record를 실패로 반환합니다.

DB `attemptCount/maxAttempts`와 SQS `ApproximateReceiveCount`를 함께 확인합니다. 최종 허용
수신에서 다시 실패하면 예약 토큰을 한 번 환불하고
`FAILED / MAX_ATTEMPTS_EXCEEDED`로 종결한 뒤 record failure를 반환하여 redrive policy가
DLQ로 이동하게 합니다. 최종 상태 저장 자체가 실패하면 ack하지 않습니다. PostgreSQL과
SQS 사이에는 분산 transaction이 없으므로 DB 장애가 DLQ 이동 시점까지 지속되면 Job 종결이
누락될 수 있으며, 이 경우 CloudWatch 구조화 로그와 DLQ를 운영자가 함께 대사해야 합니다.
DLQ consumer와 자동 redrive는 이 Worker에 포함되지 않습니다.

### 테스트

일반 단위·회귀 테스트:

```bash
npm test -- --runInBand
```

PostgreSQL claim, fencing, 중복 처리와 최종 정산:

```bash
RUN_DATABASE_INTEGRATION_TESTS=true npm test -- --runInBand \
  src/analysis-job/test/analysis-job.postgres.integration.spec.ts
```

LocalStack 발행·수신과 Worker 전달:

```bash
RUN_SQS_INTEGRATION_TESTS=true npm test -- --runInBand \
  src/analysis-job/test/sqs-analysis-job.integration.spec.ts
```

`ASYNC_ANALYSIS_ENABLED` 기본값은 계속 `false`입니다. 공개 API 접수 기능을 켜지 않아도 이미
큐에 들어간 Job 복구를 위해 handler 또는 Worker service로 직접 전달된 메시지는 처리합니다.
