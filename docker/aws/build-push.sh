#!/bin/bash
# build-push.sh [--deploy edw] [--apply]
# Builds the image from the checkout this script is in, tags it egpt:<short sha> and
# egpt:<deployment>, and pushes both to the deployment account's ECR repository "egpt",
# creating it (tagged) when missing.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
parse_apply "$@"
check_account

ROOT=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel) \
  || die "git cannot read this checkout from here (a Git Bash worktree?); use a plain one, e.g. ~/src/egpt in WSL"
SHA=$(git -C "$ROOT" rev-parse --short HEAD)
REPO=$REGISTRY/egpt
ARN=
if err=$(aws ecr describe-repositories --repository-names egpt 2>&1 >/dev/null); then
  ARN=$(q ecr describe-repositories --repository-names egpt --query 'repositories[0].repositoryArn')
elif ! grep -q RepositoryNotFoundException <<<"$err"; then die "$err"; fi
if [ -z "$ARN" ]; then
  run aws ecr create-repository --repository-name egpt --tags "Key=Project,Value=$PROJECT" Key=Name,Value=egpt \
    --query repository.repositoryUri
elif [ "$ECR_UNTAGGED" != 1 ]; then
  ours "$(q ecr list-tags-for-resource --resource-arn "$ARN" --query "tags[?Key=='Project'].Value | [0]")" "ECR repository egpt"
fi

log "checkout $ROOT ($(git -C "$ROOT" rev-parse --abbrev-ref HEAD) $SHA)"
[ -z "$(git -C "$ROOT" status --porcelain -- docker)" ] \
  || log "WARNING: docker/ has uncommitted changes; the image will not match $SHA"
[ -z "$ARN" ] || log "in ECR now: $(q ecr describe-images --repository-name egpt --query 'imageDetails[].imageTags[]' | tr -s '\t' ' ')"

run docker build -f "$ROOT/docker/Dockerfile" \
  -t "egpt:$SHA" -t "egpt:$N" "$ROOT"

if size=$(docker image inspect -f '{{.Size}}' "egpt:$SHA" 2>/dev/null); then
  log "image egpt:$SHA is $(awk -v b="$size" 'BEGIN { printf "%.2f GB", b / 1e9 }') uncompressed"
else
  log "image egpt:$SHA is not built yet; its size prints here after the build"
fi

run docker tag "egpt:$SHA" "$REPO:$SHA"
run docker tag "egpt:$SHA" "$REPO:$N"
run sh -c "aws ecr get-login-password | docker login --username AWS --password-stdin $REGISTRY"
run docker push "$REPO:$SHA"
run docker push "$REPO:$N"
