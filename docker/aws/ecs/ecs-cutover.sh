#!/bin/bash
# ecs-cutover.sh [--rollback] [--apply]
# Moves EDW from the hand-run container on edw-node to the ECS service edw:
#   stops edw on edw-node (restart=no), stops edw-node (kept, NOT terminated), detaches edw-data,
#   scales the ASG to 1 (its instance attaches edw-data at boot), then sets the service to 1.
# --rollback: service to 0, ASG to 0, edw-data back on edw-node, edw-node and its edw started.
# One poller per bot token: the old container is stopped before the new task can start.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/ecs-lib.sh"

ROLLBACK=0
for a; do
  case $a in
    --apply) APPLY=1 ;;
    --rollback) ROLLBACK=1 ;;
    *) die "usage: ecs-cutover.sh [--rollback] [--apply]" ;;
  esac
done
check_account

OLD=$(find_instance) OST=
[ -z "$OLD" ] || OST=$(q ec2 describe-instances --instance-ids "$OLD" --query 'Reservations[0].Instances[0].State.Name')
VOL=$(find_volume)
[ -n "$VOL" ] || die "no volume edw-data tagged $PROJECT"
read -r VST VATT <<<"$(q ec2 describe-volumes --volume-ids "$VOL" --query 'Volumes[0].[State,Attachments[0].InstanceId]')"
[ "$VATT" = None ] && VATT=
read -r sst sdes srun std <<<"$(service_info)"
ASG_OK=0 NEWI=()
if asg_exists; then ASG_OK=1; read -ra NEWI <<<"$(asg_instances)"; fi

log "old      ${OLD:-none}${OST:+ ($OST)}"
log "data     $VOL ($VST${VATT:+, attached to $VATT})"
if [ $ASG_OK = 1 ]; then log "asg      $ASG, instances: ${NEWI[*]:-none}"; else log "asg      $ASG does not exist yet"; fi
if [ "$sst" = ACTIVE ]; then log "service  $SERVICE: desired $sdes, running $srun, ${std##*/} ($(td_image "$std"))"
else log "service  $SERVICE does not exist yet"; fi
if [ "$APPLY" = 1 ] && { [ $ASG_OK = 0 ] || [ "$sst" != ACTIVE ]; }; then
  die "the ASG or the service is missing (ecs-provision.sh --apply)"
fi

# remote NAME: runs $TMP/NAME on edw-node as root over SSM (printed in a dry run).
remote() {
  if [ "$APPLY" = 1 ]; then ssm_send "$OLD" "$TMP/$1" "/root/$1"
  else log "[dry] on ${OLD:-edw-node} over SSM, as root:"; sed 's/^/  | /' "$TMP/$1" >&2; fi
}

wait_container_instance() {
  local ci='' _
  if [ "$APPLY" = 0 ]; then
    log "[dry] wait (up to 20 min) for a container instance in $CLUSTER with $ATTR=mounted"
    return
  fi
  for _ in $(seq 80); do
    ci=$(q ecs list-container-instances --cluster $CLUSTER --status ACTIVE \
      --filter "attribute:$ATTR == mounted and agentConnected == true" --query 'containerInstanceArns[0]') || ci=''
    [ -n "$ci" ] && break
    log "  waiting for an instance with edw-data mounted (asg: $(asg_instances | tr '\t' ' '))"
    sleep 15
  done
  [ -n "$ci" ] || die "no instance mounted edw-data in 20 min; on the ASG's instance see /var/log/cloud-init-output.log"
  read -r ec2id agent <<<"$(q ecs describe-container-instances --cluster $CLUSTER --container-instances "$ci" \
    --query 'containerInstances[0].[ec2InstanceId,versionInfo.agentVersion]')"
  log "ready    $ec2id ($(q ec2 describe-instances --instance-ids "$ec2id" \
    --query 'Reservations[0].Instances[0].[InstanceType,InstanceLifecycle]' | tr '\t' ' '), ECS agent $agent)"
}

if [ $ROLLBACK = 0 ]; then
  cat >"$TMP/edw-stop.sh" <<'EOF'
#!/bin/bash
# On edw-node: stop the hand-run edw for good and release the data volume.
set -euo pipefail
if docker inspect edw >/dev/null 2>&1; then
  docker update --restart=no edw
  docker stop -t 30 edw
fi
docker ps -a --filter name=^edw$ --format '{{.Names}}: {{.Status}}'
sync
if umount /srv/egpt; then echo "unmounted /srv/egpt"; else echo "/srv/egpt still in use; stopping the instance releases it"; fi
EOF
  if [ "$OST" = running ]; then
    [ "$APPLY" = 0 ] || ssm_online "$OLD" || die "$OLD runs but is not online in SSM; stop edw there first"
    remote edw-stop.sh
    run aws ec2 stop-instances --instance-ids "$OLD" --query 'StoppingInstances[0].CurrentState.Name'
    run aws ec2 wait instance-stopped --instance-ids "$OLD"
  elif [ -n "$OLD" ] && [ "$OST" != stopped ]; then
    run aws ec2 wait instance-stopped --instance-ids "$OLD"
  fi
  if [ -n "$VATT" ] && [ "$VATT" = "$OLD" ]; then
    run aws ec2 detach-volume --volume-id "$VOL" --query State
    run aws ec2 wait volume-available --volume-ids "$VOL"
  elif [ -n "$VATT" ] && [[ " ${NEWI[*]} " != *" $VATT "* ]]; then
    die "edw-data is attached to $VATT, which is neither edw-node nor in $ASG"
  fi
  run aws autoscaling update-auto-scaling-group --auto-scaling-group-name $ASG --min-size 1 --max-size 1 --desired-capacity 1
  wait_container_instance
  run aws ecs update-service --cluster $CLUSTER --service $SERVICE --desired-count 1 --query service.desiredCount
  if [ "$APPLY" = 1 ]; then
    wait_stable || die "the service did not settle; see the events above (rollback: ecs-cutover.sh --rollback --apply)"
  fi
  log "${OLD:-edw-node} stays stopped. Once ECS has proven itself: aws ec2 terminate-instances --instance-ids ${OLD:-<id>}"
  log "(its root volume goes with it; edw-data stays)"
  exit 0
fi

# Rollback
[ -n "$OLD" ] || die "no edw-node instance to roll back to"
cat >"$TMP/edw-start.sh" <<'EOF'
#!/bin/bash
# On edw-node: mount edw-data and start the hand-run edw again.
set -euo pipefail
for _ in $(seq 30); do
  mountpoint -q /srv/egpt && break
  mount /srv/egpt 2>/dev/null || sleep 2
done
mountpoint -q /srv/egpt
docker update --restart unless-stopped edw
docker start edw
docker ps -a --filter name=^edw$ --format '{{.Names}}: {{.Status}}'
EOF
if [ "$sst" = ACTIVE ] && [ "$sdes" != 0 ]; then
  run aws ecs update-service --cluster $CLUSTER --service $SERVICE --desired-count 0 --query service.desiredCount
  if [ "$APPLY" = 1 ]; then wait_stable || die "the service did not stop its task"; fi
fi
if [ $ASG_OK = 1 ]; then
  run aws autoscaling update-auto-scaling-group --auto-scaling-group-name $ASG --min-size 0 --desired-capacity 0
  [ ${#NEWI[@]} = 0 ] || run aws ec2 wait instance-terminated --instance-ids "${NEWI[@]}"
fi
if [ "$VATT" != "$OLD" ]; then
  [ -z "$VATT" ] || run aws ec2 wait volume-available --volume-ids "$VOL"
  run aws ec2 attach-volume --volume-id "$VOL" --instance-id "$OLD" --device /dev/sdf --query State
  run aws ec2 wait volume-in-use --volume-ids "$VOL"
fi
if [ "$OST" != running ]; then
  run aws ec2 start-instances --instance-ids "$OLD" --query 'StartingInstances[0].CurrentState.Name'
  run aws ec2 wait instance-running --instance-ids "$OLD"
fi
if [ "$APPLY" = 1 ]; then
  for _ in $(seq 40); do ssm_online "$OLD" && break; sleep 15; done
  ssm_online "$OLD" || die "$OLD is not online in SSM; start edw there by hand (see edw-start.sh in this script)"
fi
remote edw-start.sh
if [ "$APPLY" = 1 ]; then log "rolled back: edw runs on $OLD again"; fi
