# GitHub 증분 수집 정책

## 고정 수집 구간

한 번의 분석 작업은 다음 반개구간에 포함된 pull request만 수집합니다.

```text
sourceCursor < pullRequest.updatedAt <= collectionCutoff
```

- `sourceCursor`는 마지막으로 성공한 repository의 `lastSyncTime`입니다. 최초 분석에는 없습니다.
- 비동기 Worker의 `collectionCutoff`은 Job 승인 시 별도 필드에 고정해 저장합니다. `createdAt`은 실제 Job 생성 시각으로만 사용합니다.
- 동기 sync의 `collectionCutoff`은 GitHub 호출 전에 기록한 `syncStartedAt`입니다.
- POST retry는 새 시각을 만들지 않고 원래 Job의 `sourceCursor`와 `collectionCutoff`을 복사합니다. 연쇄 retry도 최초 수집 구간을 유지합니다.

GitHub PR 연결은 `UPDATED_AT DESC`이므로 `sourceCursor` 이하의 PR을 만나면 더 오래된 페이지는 조회하지 않습니다. 반대로 cutoff보다 최신인 PR만 있는 페이지는 종료 조건이 아닙니다. cutoff 이하의 PR이 있는 뒤 페이지까지 계속 조회합니다. GitHub가 잘못된 날짜를 반환하면 해당 PR을 건너뛰지 않고 작업 전체를 실패시킵니다.

## 계층별 cursor pagination

수집기는 연결을 세 단계로 나누어 순차 조회합니다.

1. repository의 pull request 연결(페이지당 100개)
2. 각 pull request의 review 연결(페이지당 50개)
3. 각 review의 comment 연결(페이지당 50개)

각 연결과 각 parent는 독립 cursor를 가집니다. `hasNextPage=false`가 될 때까지 직전 `endCursor`를 다음 요청에 전달합니다. 다음 페이지가 있다고 응답하면서 cursor가 없거나, cursor가 반복되거나, 빈 페이지가 다음 페이지를 주장하면 `GITHUB_PAGINATION_INVALID`로 실패합니다.

페이지 경계에서 같은 GitHub node ID가 반복되면 최초 관찰 순서를 유지하며 한 번만 포함합니다. 같은 ID가 다른 내용이나 다른 parent 아래에서 반복되면 임의로 병합하지 않고 실패합니다. 이 ID는 내부 검증에만 쓰며 공개 `CollectedDataDto`에는 추가하지 않습니다.

삭제된 GitHub 사용자의 nullable `author`는 `[deleted]`로 변환합니다. GitHub username으로 사용할 수 없는 표현이므로 분석 대상 사용자로 오인되지 않습니다.

## 완전성 상한

production과 테스트는 다음 공통 상수를 사용합니다.

| 대상 | 최대값 |
| --- | ---: |
| 수집 구간 내 변경 PR | 100 |
| unique review + comment node 합계 | 2,000 |
| refiner·preprocessor 후 실제 LLM prompt 추정 입력 | 80,000 tokens |

최대값까지는 성공할 수 있고 최대값보다 하나라도 더 발견하면 `INPUT_LIMIT_EXCEEDED`로 작업 전체를 실패시킵니다. page size를 줄이거나 일부 데이터를 잘라 성공시키지 않습니다. 토큰 상한도 estimate API와 실제 분석 예약이 동일한 메시지 생성·tokenizer 경로를 사용합니다. 기존 preprocessor의 50줄 초과 code block 축약은 `... (truncated for analysis)`로 표시되며, 상한을 우회하는 추가 silent truncation은 하지 않습니다.

입력 상한 초과는 같은 고정 구간을 retry해도 달라지지 않으므로 non-retryable입니다. 수집 상한은 token 예약 전에, token 상한은 token 예약과 OpenAI 호출 전에 판정됩니다. 따라서 실패 시 부분 수집 결과, report, stat, checkpoint가 저장되지 않습니다. 이미 예약된 retry Job이 token 상한으로 끝나면 기존 정산 트랜잭션으로 예약분을 반환합니다.

## GitHub rate limit과 retry

GitHub 오류는 status, response metadata, `Retry-After`, `x-ratelimit-remaining`, `x-ratelimit-reset`을 함께 검사합니다. 일반 permission 403은 rate limit으로 간주하지 않습니다.

retry 시각 우선순위는 다음과 같습니다.

1. 유효한 숫자형 `Retry-After`
2. remaining이 0일 때 미래의 유효한 epoch reset
3. 429 또는 metadata로 확인한 secondary rate limit에 대해 현재 시각 + 1분

과거 reset, 음수·NaN·24시간보다 큰 지연은 무효로 보고 안전한 1분 fallback을 사용합니다. Lambda 안에서 sleep하지 않습니다. 수집기가 `retryAt`을 Worker로 전달하며 최종 예약 시각은 다음과 같습니다.

```text
nextPublishAt = max(workerExponentialBackoffWithJitter, githubRetryAt)
```

GitHub primary/secondary 403과 429, 5xx, timeout/network 오류는 retryable입니다. 일반 permission 403, token 갱신 후에도 계속되는 401, repository 404는 non-retryable입니다. installation token 401 갱신 구조는 기존처럼 한 번만 재실행하며, 재실행은 pagination accumulator를 새로 만들어 첫 페이지부터 시작합니다.

## 부분 실패, heartbeat, checkpoint

어느 페이지에서든 rate limit, 일시 네트워크 오류, 잘못된 pageInfo, 반복 cursor, 상한 초과가 발생하면 메모리의 부분 결과를 폐기합니다. retry는 같은 고정 구간을 첫 페이지부터 다시 수집합니다.

Worker는 수집기의 page callback으로 최대 30초 간격의 lease-fenced heartbeat를 보냅니다. stage는 `COLLECTING`, progress는 기존 수집 단계 값인 10을 유지합니다. heartbeat의 조건부 갱신이 실패하면 stale Worker는 이후 GitHub·LLM 호출을 하지 않습니다. 동기 sync와 estimate 경로는 callback 없이 같은 수집기를 사용합니다.

checkpoint는 report 생성, stat 갱신, token 정산, Job 완료와 같은 성공 트랜잭션 안에서 `collectionCutoff`으로 이동합니다. 분석 성공과 정상적인 no-data에서만 이동하며, GitHub/입력/토큰/OpenAI/DB/stale lease 실패에서는 이동하지 않습니다. 조건부 `updateMany`가 현재 값보다 최신인 cutoff만 기록하므로 오래된 Job이 늦게 끝나도 checkpoint를 뒤로 돌리지 못합니다.

예를 들어 Job A가 `(10:00, 10:05]`를 수집하는 동안 PR이 10:06에 변경되면 A에서는 제외되고 다음 Job B에 포함됩니다. A가 10:07에 retry돼도 cutoff는 계속 10:05입니다. A의 두 번째 review 페이지가 일시 실패하면 A는 분석하거나 checkpoint를 10:05로 옮기지 않고, 같은 구간 전체를 다시 수집합니다.

`ASYNC_ANALYSIS_ENABLED`의 기본값은 계속 `false`입니다. 이 문서는 수집 정확도와 복구 정책만 정의하며 Structured Outputs/eval, SQS 설정 변경, CDK 배포 및 운영 활성화는 포함하지 않습니다.
