#!/bin/bash
# build-push.sh [--apply]
# Builds the EDW image from the checkout this script is in, tags it egpt:<short sha> and
# egpt:edw, and pushes both to EduWeb's ECR repository "egpt".
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
parse_apply "$@"
check_account

ROOT=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel) \
  || die "git cannot read this checkout from here (a Git Bash worktree?); use a plain one, e.g. ~/src/egpt in WSL"
SHA=$(git -C "$ROOT" rev-parse --short HEAD)
REPO=$REGISTRY/egpt
[ -n "$(q ecr describe-repositories --repository-names egpt --query 'repositories[0].repositoryUri')" ] \
  || die "ECR repository egpt not found"

log "checkout $ROOT ($(git -C "$ROOT" rev-parse --abbrev-ref HEAD) $SHA)"
[ -z "$(git -C "$ROOT" status --porcelain -- docker)" ] \
  || log "WARNING: docker/ has uncommitted changes; the image will not match $SHA"
log "in ECR now: $(q ecr describe-images --repository-name egpt --query 'imageDetails[].imageTags[]' | tr -s '\t' ' ')"

run docker build -f "$ROOT/docker/Dockerfile" \
  -t "egpt:$SHA" -t egpt:edw "$ROOT"

if size=$(docker image inspect -f '{{.Size}}' "egpt:$SHA" 2>/dev/null); then
  log "image egpt:$SHA is $(awk -v b="$size" 'BEGIN { printf "%.2f GB", b / 1e9 }') uncompressed"
else
  log "image egpt:$SHA is not built yet; its size prints here after the build"
fi

run docker tag "egpt:$SHA" "$REPO:$SHA"
run docker tag "egpt:$SHA" "$REPO:edw"
run sh -c "aws ecr get-login-password | docker login --username AWS --password-stdin $REGISTRY"
run docker push "$REPO:$SHA"
run docker push "$REPO:edw"
