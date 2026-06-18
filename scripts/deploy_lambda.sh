#!/usr/bin/env bash
# AWS Lambda Deployment Script (Container Image)

set -euo pipefail

# Load .env variables if file exists
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# Check required variables
REQUIRED_VARS=("AWS_ACCOUNT_ID" "AWS_REGION" "AWS_ECR_IMAGE_NAME" "AWS_LAMBDA_FUNCTION_NAME")
for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var}" ]; then
    echo "Error: $var is not set in .env"
    exit 1
  fi
done

ECR_URI_BASE="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
SOURCE_COMMIT="$(git rev-parse HEAD)"
SOURCE_STATE="clean"
if [ -n "$(git status --porcelain)" ]; then
  SOURCE_STATE="dirty"
fi
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)-${SOURCE_STATE}-$(date -u +%Y%m%d%H%M%S)}"
IMAGE_URI="${ECR_URI_BASE}/${AWS_ECR_IMAGE_NAME}:${IMAGE_TAG}"
ROLLBACK_DIR="${ROLLBACK_DIR:-deploy/rollback}"
ROLLBACK_FILE="${ROLLBACK_DIR}/lambda-${AWS_LAMBDA_FUNCTION_NAME}-$(date -u +%Y%m%dT%H%M%SZ).env"

mkdir -p "$ROLLBACK_DIR"

CURRENT_IMAGE_URI="$(
  aws lambda get-function \
    --function-name "$AWS_LAMBDA_FUNCTION_NAME" \
    --region "$AWS_REGION" \
    --query 'Code.ImageUri' \
    --output text
)"
CURRENT_REVISION_ID="$(
  aws lambda get-function-configuration \
    --function-name "$AWS_LAMBDA_FUNCTION_NAME" \
    --region "$AWS_REGION" \
    --query 'RevisionId' \
    --output text
)"

cat > "$ROLLBACK_FILE" <<EOF
AWS_LAMBDA_FUNCTION_NAME=${AWS_LAMBDA_FUNCTION_NAME}
AWS_REGION=${AWS_REGION}
PREVIOUS_IMAGE_URI=${CURRENT_IMAGE_URI}
PREVIOUS_REVISION_ID=${CURRENT_REVISION_ID}
SOURCE_COMMIT=${SOURCE_COMMIT}
SOURCE_STATE=${SOURCE_STATE}
RECORDED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
chmod 600 "$ROLLBACK_FILE"

echo "Rollback information saved to $ROLLBACK_FILE"

echo "Logging in to Amazon ECR..."
aws ecr get-login-password --region "$AWS_REGION" |
  docker login --username AWS --password-stdin "$ECR_URI_BASE"

echo "Building Docker image for Lambda (x86_64)..."
docker build \
  --platform linux/amd64 \
  --provenance=false \
  -t "${AWS_ECR_IMAGE_NAME}:${IMAGE_TAG}" \
  -f Dockerfile.lambda \
  .

echo "Tagging image..."
docker tag "${AWS_ECR_IMAGE_NAME}:${IMAGE_TAG}" "$IMAGE_URI"

echo "Pushing image to ECR..."
docker push "$IMAGE_URI"

echo "Updating Lambda function code..."
aws lambda update-function-code \
  --function-name "$AWS_LAMBDA_FUNCTION_NAME" \
  --image-uri "$IMAGE_URI" \
  --region "$AWS_REGION" \
  --revision-id "$CURRENT_REVISION_ID" \
  --query '{FunctionName:FunctionName,LastModified:LastModified,RevisionId:RevisionId,State:State,LastUpdateStatus:LastUpdateStatus}' \
  --output json \
  --no-cli-pager

echo "Deployment complete: $IMAGE_URI"
echo "Rollback command:"
echo "aws lambda update-function-code --function-name \"$AWS_LAMBDA_FUNCTION_NAME\" --image-uri \"$CURRENT_IMAGE_URI\" --region \"$AWS_REGION\""
