# AI 분석 품질 평가 시스템

## 목적과 범위

이 저장소는 프롬프트 변경 전후를 같은 합성 입력, 같은 `gpt-5-mini`, 같은 호출 제한으로 실행하여 품질·실제 API token usage·지연 시간을 비교합니다. 일반 PR CI는 네트워크나 OpenAI API를 사용하지 않으며, 유료 평가는 수동 또는 nightly workflow에서만 실행됩니다.

평가 harness는 저장소가 직접 소유합니다. 별도 OpenAI Evals 플랫폼에는 의존하지 않습니다.

## 결과 계약과 신뢰 경계

결과의 단일 계약은 `src/analysis/analysis-result.schema.ts`입니다.

- 8개 역량과 `summary`는 모두 필수이며 모든 객체는 strict Zod schema입니다.
- 점수는 1.0~5.0의 0.5 단위입니다.
- 각 evidence에는 `prNumber`, canonical `permalink`, `author`, `sourceType`, `targetRelation`, 공백 정규화 후 최소 20자인 단일 활동의 연속 원문 `quote`, `scoreRationale`가 필요합니다.
- 최종 결과의 `metadata`에는 요청 모델, provider 응답 모델, prompt version, `analysis-result-v3` schema version, 생성 시각을 기록합니다.
- 모델에는 metadata 생성을 맡기지 않습니다. provider 응답을 검증한 뒤 서버가 metadata를 추가합니다.

PR 본문·review·review comment는 명령이 아닌 비신뢰 데이터입니다. 시스템 프롬프트와 `<github_data>` 경계를 분리하고, 입력 안의 지시문을 따르지 않도록 명시합니다.

Structured Outputs 통과 후에도 서버는 실제 모델 입력 payload를 기준으로 다음을 다시 검사합니다.

- PR 번호와 permalink가 같은 입력 PR을 가리키는지
- author가 대소문자를 무시했을 때 target user인지
- `sourceType`과 `targetRelation` 조합이 실제 PR/review/review comment 소유 관계와 일치하는지
- quote가 공백 정규화 후 최소 20자이며 대상자가 작성한 단일 활동에 연속해서 포함되는지
- 구조화되지 않은 PR/GitHub 참조가 reason, improvement, example, summary, evidence의 scoreRationale에 없는지
- evidence가 없을 때 점수가 기본 구간 3.0~3.5인지

오류에는 metric과 evidence 위치만 포함합니다. 원문, API key, provider 응답 본문은 로그에 남기지 않습니다. 검증 실패 결과는 리포트·통계에 저장하지 않고 기존 provider reconciliation 경로로 처리합니다.

## 모델·프롬프트·스키마 버전

- 모델: 정확히 `gpt-5-mini`
- baseline prompt: `analysis-v1`
- candidate prompt: `analysis-v4-minimum-evidence-quote`
- retired prompt: `analysis-v1`, `analysis-v2-structured-evidence`, `analysis-v3-structured-evidence-rationale`
- result schema: `analysis-result-v3`

baseline은 구조화 평가 도입 직전 커밋 `e4368db13ffe283333a8e814da19d2888a31bc4a`의 실제 system/user prompt와 `json_object` 조건을 복원합니다. candidate는 production Structured Outputs 프롬프트와 schema/validator를 그대로 사용합니다.

baseline 결과는 당시의 8개 점수·설명 JSON 스키마로 검증하고, 각 역량의 `reason`·`improvement`·`example` 안의 PR 번호와 permalink를 입력 및 fixture 계약과 대조해 허위 PR, 대상자 활동이 전혀 없는 PR 귀속, 근거 없는 비중립 점수, 다른 역량의 근거 재사용을 판정합니다. legacy 스키마에는 작성자·근거 유형 필드가 없으므로 이 필드들은 입력 PR의 대상자 활동 존재 여부로 확인합니다. candidate 결과는 현재 구조화 스키마와 evidence validator로 전체 evidence 필드를 대조합니다. 따라서 두 버전의 schema 통과는 각각 당시/현재 계약을 충족했다는 뜻이며, baseline을 현재 스키마에 억지로 대입해 자동 실패시키지 않습니다.

두 prompt manifest는 `src/analysis/evals/prompt-variants.ts`에 전체 template, source revision, 응답 형식, 최대 completion token과 SHA-256 checksum을 기록합니다. baseline의 source revision은 복원 대상 commit이며, candidate는 `CURRENT_CHECKOUT`으로 표시하고 실제 실행 revision은 보고서의 `executionRevision`(`GITHUB_SHA`, 명시한 로컬 revision 또는 `local-working-tree`)에 별도로 기록합니다.

- baseline checksum: `b6f1cbd3195f41b292e6aca9e64b6d5b11395de899fb99c1b18382afc03c4eb6`
- candidate checksum: `087df75828355ab92310bd6e8c84e234f104464bd9ade36a31cabc98ed303a4a`

checksum은 공백을 포함한 전체 template이나 실행 조건이 바뀌면 달라집니다. 의도적으로 변경할 때는 fixture·reference output·문서와 함께 검토하고 integrity checksum을 갱신합니다. 기존 prompt version 문자열에 다른 내용을 재사용하지 않습니다.

## 합성 골든 데이터 24개

8개 역량별 high/medium/low 한 개씩 정확히 24개를 사용합니다. 프로덕션 사용자나 비공개 저장소 데이터는 포함하지 않습니다.

각 fixture는 다음을 갖습니다.

- 안정적인 fixture ID와 target user
- 합성 PR/review/comment 입력
- 8개 역량의 draft 기대 점수 구간
- 8개 역량별 `mustCite`/`mustNotCite` evidence 계약
- 계약에 기록된 PR 번호, permalink, 작성자, 활동 유형, target relation, 사람이 의도한 합성 근거 quote
- 검증 위험과 태그
- label review version/status

prompt injection, 존재하지 않는 PR 999, 타인의 강한 활동, 타인 PR의 대상자 review/comment, 대상자 PR의 타인 comment, 근거 부족, 한영 혼합, 긴 코드 블록과 review thread, Markdown 링크, 중복 quote, GitHub ID 대소문자, 유사 사용자명이 24개에 분산되어 있습니다.

| 역량 | high fixture | medium fixture | low fixture |
| --- | --- | --- | --- |
| mutual_respect | `mutual_respect-high` | `mutual_respect-medium` | `mutual_respect-low` |
| conflict_management | `conflict_management-high` | `conflict_management-medium` | `conflict_management-low` |
| logical_problem_definition | `logical_problem_definition-high` | `logical_problem_definition-medium` | `logical_problem_definition-low` |
| review_guiding | `review_guiding-high` | `review_guiding-medium` | `review_guiding-low` |
| documentation | `documentation-high` | `documentation-medium` | `documentation-low` |
| knowledge_sharing | `knowledge_sharing-high` | `knowledge_sharing-medium` | `knowledge_sharing-low` |
| technical_influence | `technical_influence-high` | `technical_influence-medium` | `technical_influence-low` |
| code_stability | `code_stability-high` | `code_stability-medium` | `code_stability-low` |

현재 label 상태는 다음과 같습니다.

| 항목 | 값 |
| --- | --- |
| version | `analysis-golden-labels-draft-v1` |
| status | `pending-user-approval` |
| approvedBy | 없음 |
| approvedAt | 없음 |

즉, 점수 구간은 검토용 draft이며 사람이 승인한 기준선으로 주장하지 않습니다. 승인하려면 24개 fixture의 입력·허용 evidence·192개 점수 구간을 검토한 뒤 status를 `approved`로 바꾸고 승인자와 시각을 기록하며 integrity checksum을 갱신해야 합니다.

## 비용 없는 CI grader

```bash
npm run analysis:eval:ci
```

이 명령은 OpenAI client를 생성하거나 네트워크를 호출하지 않습니다. 체크인된 reference output은 `human-authored-evaluation-reference`이며 `modelExecuted: false`로 명시됩니다.

CI grader는 다음을 검사합니다.

- 24/24 결과 schema
- 존재하지 않거나 permalink가 다른 PR
- 타인의 활동과 source/relation 오인
- evidence 없는 high/low 점수
- 역량별 `mustCite`의 활동 identity 및 정확한 quote 누락과 `mustNotCite` 활동 근거 재사용 gate
- 192개 점수 구간
- 누락 output을 포함한 고정 분모
- fixture, reference output, prompt manifest SHA-256 integrity

reference 결과의 기계적 회귀 검사가 통과해도 실제 모델 품질을 통과했다고 주장하지 않습니다. label 승인 전에는 `qualityClaimEligible: false`입니다.

## baseline/candidate 실제 비교

두 variant는 같은 순서의 24개 전처리 입력을 사용합니다. 호출은 순차 실행되어 concurrency가 1이고 SDK retry는 0입니다. 최대 호출 수는 baseline 24 + candidate 24 = 48입니다. 각 요청 timeout은 90초이며 workflow 전체 timeout은 45분입니다.

계산식은 다음과 같습니다.

- schema pass rate: schema 통과 case / 24, candidate 기준 24/24
- fabricated PR citations: unknown PR 또는 permalink mismatch evidence 위치 수, 목표 0
- wrong-user attribution: author/quote/source relation이 대상자 활동과 맞지 않는 evidence 위치 수, 목표 0
- unsupported claims: evidence 없이 3.0~3.5 밖의 점수를 사용하거나 최소 길이 미만 quote로 점수를 뒷받침한 evidence 위치 수, 목표 0
- evidence validation failures: candidate의 결정적 evidence 검증 실패 case 수, 목표 0
- evidence gate failures: fixture의 역량별 `mustCite` 활동과 정확한 quote를 충족하지 못하거나 `mustNotCite` 활동 근거를 quote 변형으로 재사용한 case 수, 목표 0
- score-band agreement: 기대 구간에 들어간 metric / 192, 최소 154/192
- candidate >= baseline: schema/evidence gate는 후퇴하지 않고 안전 위반 수는 증가하지 않으며 matching label 수는 같거나 많은 case, 최소 20/24
- 평균 총 token: 24개 모두의 실제 API `usage.total_tokens` 평균, candidate/baseline 비율 1.2 이하
- p95 latency: 24개 latency를 오름차순 정렬하고 `ceil(0.95 × N)`번째 값을 택하는 nearest-rank 방식, candidate/baseline 비율 1.2 이하

usage가 하나라도 없으면 평균 token 비교는 unavailable로 실패합니다. label이 승인되지 않은 상태에서도 실제 실행 결과는 기록할 수 있지만 전체 품질 gate는 PASS가 될 수 없습니다.

## 수동 실행과 비용 통제

비용 없는 계획 확인:

```bash
npm run analysis:eval:live -- --dry-run
```

실제 실행은 사용자가 48회 호출과 비용 영향을 승인한 뒤에만 수행합니다.

```bash
RUN_LIVE_OPENAI_EVALS=true \
OPENAI_API_KEY=... \
npm run analysis:eval:live -- \
  --output .artifacts/analysis-evals/latest.json
```

두 opt-in 값이 없으면 호출하지 않고 실패합니다. 모델 override와 max-case 우회는 제공하지 않습니다. 출력 경로는 `.artifacts/analysis-evals/` 아래의 `.json`으로 제한하며 같은 이름의 Markdown 보고서도 생성합니다. 파일 mode는 0600이고 `.artifacts/`는 Git에서 제외됩니다.

JSON에는 prompt 전체 template/checksum, variant 요약, case별 합성 output·usage·latency·오류가 들어갑니다. fixture가 익명 합성 데이터인지 코드에서 고정하며 API key는 report나 오류 출력에 포함하지 않습니다.

## nightly workflow

`.github/workflows/analysis-evals.yml`은 `workflow_dispatch`와 nightly schedule만 사용합니다. PR/push trigger는 없습니다. secret이 없으면 구성 오류로 실패하며, JSON과 Markdown을 artifact로 30일 보존합니다. concurrency group은 한 실행만 허용하고 취소 대신 대기합니다.

일반 PR의 `.github/workflows/analysis-ledger.yml`은 평가 소스, 스크립트, 이 문서, live workflow 변경을 모두 path filter에 포함하지만 실제 OpenAI 호출 대신 deterministic grader만 실행합니다.

## 재현과 승인 절차

1. `npm ci`로 lockfile 기준 의존성을 설치합니다.
2. `npm run analysis:eval:ci`로 fixture/reference/prompt integrity를 확인합니다.
3. `npm run analysis:eval:live -- --dry-run`에서 모델·prompt checksum·48회 호출 계획을 확인합니다.
4. label 승인 상태와 예상 비용을 확인하고 실제 실행 승인을 받습니다.
5. 같은 commit과 환경에서 수동 명령 또는 nightly workflow를 실행합니다.
6. JSON의 prompt manifest, 실제 usage와 latency, Markdown 비교표를 함께 보관합니다.

프롬프트나 모델을 변경할 때는 새 불변 version, 전체 prompt와 checksum, 24개 fixture/reference, 문서, 비용 승인을 같은 PR에서 검토합니다. 모델 변경은 별도 승인 없이는 금지하며 현재 평가는 계속 `gpt-5-mini`만 사용합니다.

## 현재 미실행 항목과 한계

이 구현 과정에서는 실제 OpenAI 평가를 실행하지 않았습니다. 따라서 실제 schema 통과율, 인용 오류, score-band agreement, baseline 대비 token, p95 latency, candidate >= baseline 기준은 모두 미측정입니다. 또한 draft labels는 사용자 승인이 필요합니다. 합성 24개는 운영 분포나 사람의 블라인드 평가를 대체하지 않습니다.
