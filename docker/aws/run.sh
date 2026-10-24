#!/bin/bash
# run.sh [--tag edw] [--apply]
# (Re)starts EDW's container on the AWS instance from the ECR image.
# On the instance (as root) it does the work; anywhere else (WSL) it sends itself
# to the instance over SSM and runs there.
set -euo pipefail

if [ -f /etc/egpt-edw-node ]; then  # written by provision.sh's user-data
  ON_HOST=1 APPLY=0
  log() { echo "$*" >&2; }
  die() { echo "ERROR: $*" >&2; exit 1; }
  run() { if [ "$APPLY" = 1 ]; then log "+ $*"; "$@"; else log "[dry] $*"; fi; }
else
  ON_HOST=0
  . "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
fi

TAG=edw
while [ $# -gt 0 ]; do
  case $1 in
    --apply) APPLY=1 ;;
    --tag) TAG=${2:?--tag needs a value}; shift ;;
    *) die "usage: run.sh [--tag edw] [--apply]" ;;
  esac
  shift
done

REGION=us-east-1
SRV=/srv/egpt
FLAGS=(-d --name edw --hostname edw --restart unless-stopped
  --security-opt seccomp=unconfined --security-opt systempaths=unconfined
  --shm-size=1g --env-file "$SRV/vnc.env"
  -e EGPT_BRANCH=edw -e EGPT_BEEPER=off
  -p 127.0.0.1:5900:5900 -p 127.0.0.1:6080:6080
  -v "$SRV/egpt-home:/home/egpt/.egpt" -v "$SRV/egpt-claude:/home/egpt/.claude"
  -v "$SRV/egpt-src:/home/egpt/src/egpt")

if [ $ON_HOST = 0 ]; then
  check_account
  IMAGE=$REGISTRY/egpt:$TAG
  if pushed=$(q ecr describe-images --repository-name egpt --image-ids "imageTag=$TAG" \
      --query 'imageDetails[0].[imageDigest,imagePushedAt]' 2>/dev/null); then
    log "ECR egpt:$TAG = $pushed"
  else
    log "egpt:$TAG is not in ECR yet (build-push.sh --apply)"
  fi
  INST=$(find_instance)
  if [ "$APPLY" = 1 ]; then
    [ -n "$INST" ] || die "no instance tagged $PROJECT/edw-node (provision.sh --apply)"
    ssm_online "$INST" || die "$INST is not online in SSM"
    ssm_send "$INST" "${BASH_SOURCE[0]}" $SRV/run.sh --apply --tag "$TAG"
  else
    log "[dry] copy run.sh to ${INST:-<the edw-node instance>}:$SRV/run.sh over SSM and run it with --apply --tag $TAG, which:"
    log "  writes $SRV/vnc.env (0600, random VNC password) if missing"
    log "  logs docker in to $REGISTRY and pulls $IMAGE"
    log "  if edw exists and does not run that image: docker stop edw; docker rm -v edw"
    log "  $(show docker run "${FLAGS[@]}" "$IMAGE")"
    log "  docker image prune -f"
  fi
  exit 0
fi

# On the instance.
[ "$(id -u)" = 0 ] || die "run as root: sudo bash $0"
mountpoint -q $SRV || die "$SRV is not mounted"
REGISTRY=$(aws sts get-caller-identity --region $REGION --query Account --output text).dkr.ecr.$REGION.amazonaws.com
IMAGE=$REGISTRY/egpt:$TAG
digest=$(aws ecr describe-images --region $REGION --repository-name egpt --image-ids "imageTag=$TAG" \
  --query 'imageDetails[0].imageDigest' --output text)
state=$(docker inspect -f '{{.State.Status}}' edw 2>/dev/null || true)
have=$(docker inspect -f '{{.Image}}' edw 2>/dev/null | xargs -r docker image inspect -f '{{join .RepoDigests " "}}' 2>/dev/null || true)
log "edw: ${state:-no container}; ECR egpt:$TAG = $digest"
if [ "$state" = running ] && [[ " $have " == *"@$digest "* ]]; then
  log "edw already runs $IMAGE"
  exit 0
fi

[ -f $SRV/vnc.env ] || run sh -c "umask 077 && echo VNC_PASSWORD=\$(openssl rand -base64 6) > $SRV/vnc.env"
run sh -c "aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $REGISTRY"
run docker pull "$IMAGE"
if [ -n "$state" ]; then
  run docker stop edw
  run docker rm -v edw
fi
run docker run "${FLAGS[@]}" "$IMAGE"
run docker image prune -f
docker ps -a --filter name=^edw$ --format '{{.Names}} {{.Image}} {{.Status}}'
