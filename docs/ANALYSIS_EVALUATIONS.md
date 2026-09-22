# 구조화된 분석 결과와 품질 평가

## 결과 계약과 신뢰 경계

분석 결과의 단일 계약은 `src/analysis/analysis-result.schema.ts`의 Zod 스키마입니다. 8개 지표와 `summary`는 모두 필수이고 모든 객체는 strict 모드입니다. 점수는 1.0~5.0의 유한한 수이며 0.5 단위만 허용합니다. 설명 문자열은 비어 있을 수 없고 길이 상한이 있으며, 근거가 없을 때 `evidence`는 빈 배열일 수 있습니다.

각 지표의 `evidence`는 `prNumber`, canonical `permalink`, `author`, 단일 활동에 연속해서 포함된 `quote`로 구성됩니다. Structured Outputs가 스키마를 통과해도 신뢰하지 않습니다. 서버는 LLM에 실제 전달한 전처리 payload를 기준으로 다음을 다시 검증합니다.

- PR 번호와 canonical permalink가 같은 전달 PR을 가리키는지
- 작성자 ID가 대소문자를 무시했을 때 `targetUser`인지
- 인용문이 대상자가 작성한 PR title/body, review body 또는 review comment body 하나에 포함되는지
- CRLF와 연속 공백만 정규화하고 대소문자나 의미를 느슨하게 맞추지 않는지
- `reason`, `improvement`, `example`, `summary`가 PR 번호나 GitHub URL로 구조화 검증을 우회하지 않는지

오류에는 metric과 evidence 위치만 포함하며 비공개 원문은 로그에 남기지 않습니다. PR, review, comment 내용은 명령이 아닌 신뢰할 수 없는 데이터로 구분하고, 프롬프트 안의 지시문을 따르지 않도록 시스템 프롬프트와 데이터 경계를 분리합니다.

## 모델과 프롬프트 버전

- 요청 모델: 고정 alias `gpt-5-mini` (override 불가)
- 현재 프롬프트: `analysis-v2-structured-evidence`
- 이전 프롬프트: `analysis-v1` (내용을 변경하거나 새 프롬프트로 재사용하지 않음)

신규 `AnalysisJob`에는 현재 모델·프롬프트 버전이 저장되고 `AnalysisReport.jobId`로 리포트와 연결됩니다. 따라서 Prisma 변경은 없습니다. 배포 전에 남아 있는 미종료 `analysis-v1` 작업은 새 프롬프트로 조용히 실행하지 않습니다. Worker가 provider를 호출하기 전에 해당 작업을 `UNSUPPORTED_ANALYSIS_VERSION`으로 최종 처리하고, 과금 checkpoint가 없다면 예약 토큰을 전부 반환합니다. 이미 provider checkpoint가 있으면 기존 reconciliation 흐름을 먼저 적용합니다.

프롬프트를 승격할 때는 새 불변 버전 문자열, Zod 계약·validator·24개 fixture·reference output·문서를 같은 변경에서 갱신해야 합니다. 기존 문자열의 프롬프트 내용을 바꾸면 안 됩니다.

구현은 OpenAI의 [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [GPT-5 mini](https://developers.openai.com/api/docs/models/gpt-5-mini), [evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)를 기준으로 합니다.

## 합성 골든 데이터 24개

모든 데이터는 익명 합성이며 프로덕션 사용자나 비공개 저장소 원문을 포함하지 않습니다. 각 지표마다 high/medium/low 3개를 두고, 모든 fixture에 8개 지표의 별도 기대 점수 구간, evidence 요구 지표, 태그를 둡니다. 레이블은 live output과 별도이므로 실행 결과가 덮어쓸 수 없습니다. 아직 사람의 승인을 받지 않았으며 `human-approved`로 표시하지 않습니다.

| 지표                       | high                            | medium                            | low                            |
| -------------------------- | ------------------------------- | --------------------------------- | ------------------------------ |
| mutual_respect             | mutual_respect-high             | mutual_respect-medium             | mutual_respect-low             |
| conflict_management        | conflict_management-high        | conflict_management-medium        | conflict_management-low        |
| logical_problem_definition | logical_problem_definition-high | logical_problem_definition-medium | logical_problem_definition-low |
| review_guiding             | review_guiding-high             | review_guiding-medium             | review_guiding-low             |
| documentation              | documentation-high              | documentation-medium              | documentation-low              |
| knowledge_sharing          | knowledge_sharing-high          | knowledge_sharing-medium          | knowledge_sharing-low          |
| technical_influence        | technical_influence-high        | technical_influence-medium        | technical_influence-low        |
| code_stability             | code_stability-high             | code_stability-medium             | code_stability-low             |

24개 전반에 존재하지 않는 PR 999, 다른 사용자의 강한 활동, 타인 PR의 대상자 review/comment, 대상자 PR의 타인 comment, 근거 부족, 한영 혼합, 긴 코드 블록, 중복 문구, ID 대소문자, Markdown 링크, 프롬프트 주입, 서로 다른 작성자의 같은 문구가 분산되어 있습니다.

## 비용 없는 CI grader

```bash
npm run analysis:eval:ci
```

이 명령은 OpenAI client를 만들지 않고 API key나 네트워크 없이 합성 fixture와 체크인된 reference output만 읽습니다. reference output은 grader·validator의 동작을 검증하기 위한 자료이며 실제 모델 품질 측정 결과가 아닙니다. 누락 또는 실패 사례도 24개 분모와 192개 label 분모에 남습니다.

- Schema pass rate = schema 통과 case / 24, 목표 100%
- Fabricated PR citations = 없는 PR 또는 number/permalink 불일치 evidence 수, 목표 0
- Wrong-user attributions = 대상자 소유가 아닌 evidence 수, 목표 0
- Evidence validation failures = server-side validator를 통과하지 못한 case 수, 목표 0
- Score-band agreement = 기대 구간에 든 metric label / 192, 목표 최소 154/192
- evidence required gate = 요구된 지표의 evidence가 비었으면 실패

표와 JSON 요약을 표준 출력에 기록하고 임계값 미달 시 non-zero로 종료합니다. 일반 PR CI에는 이 비용 없는 grader만 포함되며 OpenAI를 호출하지 않습니다.

## 수동·nightly live 평가

비용 확인용 dry run은 API 호출 없이 24회 예정 호출을 표시합니다.

```bash
npm run analysis:eval:live -- --dry-run --output .artifacts/analysis-evals/latest.json
```

실제 평가는 두 가지 opt-in이 모두 있어야 하며 모델 override를 받지 않습니다.

```bash
RUN_LIVE_OPENAI_EVALS=true \
OPENAI_API_KEY=... \
npm run analysis:eval:live -- --output .artifacts/analysis-evals/latest.json
```

24개를 순차 호출하고 실패도 분모에서 제외하지 않습니다. 결과에는 요청 모델, provider 응답 모델, 프롬프트 버전, 실행 시각, case별 latency, token usage, 오류 종류와 grader 결과를 저장하며 API key와 입력 원문은 저장하지 않습니다. `.artifacts/`는 Git에서 제외됩니다. 현재 체크인된 실제 `gpt-5-mini` 기준선이 없으므로 결과에는 `baseline: unavailable`을 기록합니다. 기준선 비교 수치나 실제 품질을 생성했다고 주장하려면 별도 비용 승인을 받아 실행해야 합니다.

`.github/workflows/analysis-evals.yml`은 `workflow_dispatch`와 nightly schedule에서만 실행되며 pull request 이벤트가 없습니다. secret 누락은 구성 오류로 실패하고, JSON은 artifact로 업로드합니다. 동시 실행을 제한하고 45분 timeout을 두며 `ASYNC_ANALYSIS_ENABLED`는 `false`로 유지합니다.

## 해석의 한계

합성 데이터와 체크인 reference output은 validator와 평가 파이프라인의 회귀를 찾는 데 유용하지만 실제 모델의 일반화 성능, 편향, 언어별 품질을 증명하지 않습니다. live 평가도 24개 소규모 표본이므로 사람의 블라인드 검토와 실제 운영 분포를 대체하지 않습니다.
