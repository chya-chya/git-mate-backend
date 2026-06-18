# GitHub App 운영 재배포 Runbook

## 운영 주소

- Backend:
  `https://rq66ppmlfz5dj2t6hnxz7rowgq0aqdst.lambda-url.ap-northeast-2.on.aws`
- GitHub App Setup URL:
  `https://rq66ppmlfz5dj2t6hnxz7rowgq0aqdst.lambda-url.ap-northeast-2.on.aws/github-app/installations/callback`
- GitHub App Webhook URL:
  `https://rq66ppmlfz5dj2t6hnxz7rowgq0aqdst.lambda-url.ap-northeast-2.on.aws/github-app/webhooks`

GitHub App 설정에서 `Redirect on update`를 활성화하고 Webhook 이벤트로
`Installation`, `Installation repositories`를 선택한다.

## Lambda 환경변수

기존 환경변수를 유지하면서 다음 값을 추가한다.

- `GITHUB_APP_ID`
- `GITHUB_APP_INSTALL_URL`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_APP_WEBHOOK_SECRET`

`GITHUB_APP_PRIVATE_KEY`는 PEM 줄바꿈을 `\n`으로 치환한 문자열로 등록한다.
AWS CLI 명령 인자나 shell history에 private key를 직접 넣지 않는다. Lambda 콘솔이나
권한이 제한된 임시 JSON 파일을 사용하고, 등록 직후 임시 파일을 삭제한다.

현재 코드 배포 전에 Lambda 환경변수 키 목록에서 위 4개가 모두 존재하는지 다시 확인한다.

## Private Key 검사

- `.env`, `certs/*.pem`, `certs/*private-key*`는 Git과 Docker build context에서 제외한다.
- Lambda 이미지는 Supabase CA 파일만 포함해야 한다.
- 빌드 후 아래 검사를 수행한다.

```bash
docker run --rm --entrypoint sh <image-tag> -c \
  'find /app/certs -maxdepth 1 -type f -printf "%f\n"'
```

출력에는 `supabase-ca.crt`만 있어야 한다.

## 운영 DB 백업 및 Migration

이번 migration은 기존 테이블을 삭제하거나 변경하지 않고 enum, 설치 관련 테이블 3개,
인덱스와 외래키를 추가한다. 애플리케이션 rollback 시 새 테이블은 남겨도 기존 버전에
영향을 주지 않는다.

Supabase transaction pooler 주소가 아니라 direct database URL을 사용한다.

```bash
export DIRECT_DATABASE_URL='<production-direct-database-url>'

mkdir -p backups
pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="backups/git-mate-before-github-app-$(date -u +%Y%m%dT%H%M%SZ).dump" \
  "$DIRECT_DATABASE_URL"

DATABASE_URL="$DIRECT_DATABASE_URL" npx prisma migrate status
DATABASE_URL="$DIRECT_DATABASE_URL" npx prisma migrate deploy
DATABASE_URL="$DIRECT_DATABASE_URL" npx prisma migrate status
```

백업 파일 크기가 0보다 큰지 확인하고 접근 권한을 `600`으로 제한한다. 운영 DB migration은
백업 확인 후 사용자 승인 뒤 실행한다.

## 배포 및 Rollback

배포 스크립트는 기존 Lambda 이미지 URI와 revision ID를
`deploy/rollback/`에 기록하고, Git commit과 UTC 시각이 포함된 고유 ECR tag를 사용한다.

현재 rollback 기준:

- Source commit: `0f64926`
- Lambda image digest:
  `sha256:654f26c594f40d6883ce36c2eb57bcd4ac4eb47d6d2f524ee5737c6fe85b15c6`

애플리케이션 rollback은 생성된 rollback 파일의 `PREVIOUS_IMAGE_URI`로
`aws lambda update-function-code`를 실행한다. DB는 additive migration이므로 애플리케이션
rollback만 우선 수행하고, 테이블 제거 대신 백업 복원을 별도 장애 대응 절차로 취급한다.

## 배포 후 확인

1. `/` health endpoint가 `200`을 반환한다.
2. GitHub OAuth 로그인에서 `read:user`, `read:org`만 요청한다.
3. `/github-app/installations/status`가 `200`을 반환한다.
4. GitHub App 설치 callback이 사용자와 installation을 연결한다.
5. GitHub Webhook `ping` delivery가 `202`를 반환한다.
6. `/collection/repos`가 installation이 허용한 저장소만 반환한다.
7. 허용된 저장소 estimate는 `200`, 허용되지 않은 저장소는 `403`을 반환한다.
