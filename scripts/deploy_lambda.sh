#!/bin/bash
# AWS Lambda Deployment Script (Container Image)

# Load .env variables if file exists
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
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

echo "Logging in to Amazon ECR..."
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_URI_BASE

echo "Building Docker image for Lambda (x86_64)..."
docker build --platform linux/amd64 --provenance=false -t $AWS_ECR_IMAGE_NAME -f Dockerfile.lambda .

echo "Tagging image..."
docker tag $AWS_ECR_IMAGE_NAME:latest $ECR_URI_BASE/$AWS_ECR_IMAGE_NAME:latest

echo "Pushing image to ECR..."
docker push $ECR_URI_BASE/$AWS_ECR_IMAGE_NAME:latest

echo "Updating Lambda function code..."
aws lambda update-function-code --function-name $AWS_LAMBDA_FUNCTION_NAME --image-uri $ECR_URI_BASE/$AWS_ECR_IMAGE_NAME:latest --region $AWS_REGION

echo "Deployment complete!"
