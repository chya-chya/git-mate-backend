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
