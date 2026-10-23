#!/usr/bin/env bash

set -euo pipefail

MODE="${1:-plan}"
STAGE="${STAGE:-production}"
FRONTEND_URL="${FRONTEND_URL:-https://git-mate-frontend.vercel.app}"
STACK_NAME="GitMateAsyncAnalysis-${STAGE}"

if [[ ! "$STAGE" =~ ^[a-z0-9][a-z0-9-]{0,19}$ ]]; then
  echo "STAGE must contain 1-20 lowercase letters, numbers, or hyphens." >&2
  exit 1
fi

if [[ ! "$FRONTEND_URL" =~ ^https:// ]]; then
  echo "FRONTEND_URL must use HTTPS." >&2
  exit 1
fi

if [[ -z "${RUNTIME_SECRET_ARN:-}" ]]; then
  echo "RUNTIME_SECRET_ARN is required." >&2
  exit 1
fi

if [[ ! "$RUNTIME_SECRET_ARN" =~ ^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:.+$ ]]; then
  echo "RUNTIME_SECRET_ARN must be a complete Secrets Manager ARN." >&2
  exit 1
fi

if [[ -z "${RUNTIME_SECRET_VERSION_ID:-}" ]]; then
  AWS_REGION_ARGUMENTS=()
  if [[ -n "${AWS_REGION:-}" ]]; then
    AWS_REGION_ARGUMENTS=(--region "$AWS_REGION")
  fi
  RUNTIME_SECRET_VERSION_ID="$(
    aws "${AWS_REGION_ARGUMENTS[@]}" secretsmanager list-secret-version-ids \
      --secret-id "$RUNTIME_SECRET_ARN" \
      --query 'Versions[?contains(VersionStages, `AWSCURRENT`)].VersionId | [0]' \
      --output text \
      --no-cli-pager
  )"
fi

if [[ ! "$RUNTIME_SECRET_VERSION_ID" =~ ^[A-Za-z0-9_-]{32,64}$ ]]; then
  echo "RUNTIME_SECRET_VERSION_ID must identify the 32-64 character AWSCURRENT secret version." >&2
  exit 1
fi

PARAMETERS=(
  --parameters "RuntimeSecretArn=${RUNTIME_SECRET_ARN}"
  --parameters "RuntimeSecretVersionId=${RUNTIME_SECRET_VERSION_ID}"
  --parameters "FrontendUrl=${FRONTEND_URL}"
)
if [[ -n "${ALARM_EMAIL:-}" ]]; then
  PARAMETERS+=(--parameters "AlarmEmail=${ALARM_EMAIL}")
fi

deploy_stack() {
  local async_analysis_enabled="$1"
  local worker_enabled="$2"

  npx cdk deploy "$STACK_NAME" \
    -c "stage=${STAGE}" \
    -c "asyncAnalysisEnabled=${async_analysis_enabled}" \
    -c "workerEnabled=${worker_enabled}" \
    "${PARAMETERS[@]}" \
    --require-approval broadening
}

diff_stack() {
  local async_analysis_enabled="$1"
  local worker_enabled="$2"

  npx cdk diff "$STACK_NAME" \
    -c "stage=${STAGE}" \
    -c "asyncAnalysisEnabled=${async_analysis_enabled}" \
    -c "workerEnabled=${worker_enabled}" \
    "${PARAMETERS[@]}"
}

case "$MODE" in
  plan)
    npm run infra:check
    diff_stack true true
    ;;
  plan-provision)
    npm run infra:check
    diff_stack false false
    ;;
  provision)
    npm run infra:check
    deploy_stack false false
    ;;
  worker-only)
    npm run infra:check
    deploy_stack false true
    ;;
  deploy)
    npm run infra:check
    deploy_stack true true
    ;;
  disable)
    deploy_stack false false
    ;;
  *)
    echo "Usage: $0 [plan|plan-provision|provision|worker-only|deploy|disable]" >&2
    exit 1
    ;;
esac
