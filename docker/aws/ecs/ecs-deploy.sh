#!/bin/bash
# ecs-deploy.sh [--tag edw] [--restart] [--apply]
# Points the service edw at egpt:<tag> as ECR has it now, pinned by digest: registers a
# task-definition revision when the image or the definition changed, then updates the service.
# The old task stops before the new one starts (never two pollers). Replaces run.sh on ECS.
# --restart replaces the task even when nothing changed.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/ecs-lib.sh"

TAG=edw RESTART=0
while [ $# -gt 0 ]; do
  case $1 in
    --apply) APPLY=1 ;;
    --tag) TAG=${2:?--tag needs a value}; shift ;;
    --restart) RESTART=1 ;;
    *) die "usage: ecs-deploy.sh [--tag edw] [--restart] [--apply]" ;;
  esac
  shift
done
check_account

DIGEST=$(ecr_digest "$TAG")
[ -n "$DIGEST" ] || die "egpt:$TAG is not in ECR (build-push.sh)"
log "image    egpt:$TAG = $DIGEST"

read -r sst sdes srun std <<<"$(service_info)"
if [ "$sst" = ACTIVE ]; then
  log "service  $SERVICE: desired $sdes, running $srun, ${std##*/} ($(td_image "$std" | sed 's/.*@//'))"
else
  [ "$APPLY" = 0 ] || die "no service $SERVICE in cluster $CLUSTER (ecs-provision.sh --apply)"
  log "service  $SERVICE does not exist yet (ecs-provision.sh); showing what a deploy would register"
fi

TD=$(taskdef_for "$REGISTRY/egpt@$DIGEST")
if [ "$TD" != "$std" ]; then
  run aws ecs update-service --cluster $CLUSTER --service $SERVICE --task-definition "$TD" --query service.taskDefinition
elif [ $RESTART = 1 ]; then
  run aws ecs update-service --cluster $CLUSTER --service $SERVICE --force-new-deployment --query service.taskDefinition
else
  log "the service already runs ${TD##*/}; nothing to do (--restart replaces the task anyway)"
  exit 0
fi

if [ "$APPLY" = 1 ] && [ "$sdes" -gt 0 ]; then
  wait_stable || die "the service did not settle; see the events above"
  now=$(q ecs describe-services --cluster $CLUSTER --services $SERVICE --query 'services[0].taskDefinition')
  [ "$now" = "$TD" ] || die "the service runs ${now##*/}, not ${TD##*/}: the circuit breaker rolled it back"
elif [ "${sdes:-0}" = 0 ]; then
  log "desired count is 0: no task starts until ecs-cutover.sh"
fi
