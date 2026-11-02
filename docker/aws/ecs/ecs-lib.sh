# shellcheck shell=bash disable=SC2034
# Shared by the ECS scripts in docker/aws/ecs (sourced, not run). Builds on ../lib.sh.

. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

CLUSTER=$N
SERVICE=$N
FAMILY=$N
LT=$N-ecs-lt
ASG=$N-ecs-asg
ROLE=$N-ecs-role
IPROFILE=$N-ecs-profile
NODE=$N-ecs-node             # Name of the ASG's instances
AMI_PARAM=/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id
SRV=/srv/egpt
ATTR=$N-data                 # instance attribute, set once $SRV is mounted; the task requires it

# Beeper profiles on the data volume (host-dir:profile), named as the entrypoint names them:
# the first account ~/.config/BeeperTexts, the others ~/.config/BeeperTexts-<name>.
BEEPER_VOLS=()
if [ "$EGPT_BEEPER" != off ]; then
  IFS=', ' read -r -a _names <<<"$EGPT_BEEPER"
  BEEPER_VOLS=(egpt-beeper:/home/egpt/.config/BeeperTexts)
  for _n in "${_names[@]:1}"; do BEEPER_VOLS+=("egpt-beeper-$_n:/home/egpt/.config/BeeperTexts-$_n"); done
fi

# oficina-tunnel sidecar (OFICINA_TUNNEL=1): 127.0.0.1:18089 -> oficina's whisper-server (127.0.0.1:8089) over SSH.
# Never exits on its own: waits for its secrets and retries ssh every minute. ECS's restart policy
# is only a backstop (it did not restart a clean exit 0, 2026-10-26).
TUNNEL_SH='s=/home/egpt/.egpt/secrets
while :; do
  missing=
  for f in oficina-tunnel.key oficina.known_hosts oficina-tunnel.target; do [ -s $s/$f ] || missing=$f; done
  if [ -n "$missing" ]; then echo "oficina-tunnel: no secrets/$missing yet; checking again in 1 min"
  else
    ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$s/oficina.known_hosts -i $s/oficina-tunnel.key -L 127.0.0.1:18089:127.0.0.1:8089 -p 35547 "$(tr -d "[:space:]" <$s/oficina-tunnel.target)"
    echo "oficina-tunnel: ssh exited $?; retrying in 1 min"
  fi
  sleep 60
done'

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

find_volume() {
  one volume "$(q ec2 describe-volumes --filters "$TAGF" "Name=tag:Name,Values=$DATA" --query 'Volumes[].VolumeId')"
}

find_zone() {  # our private zone $ZONE: its id (Z...), or empty
  local zs z ids=''
  zs=$(q route53 list-hosted-zones-by-name --dns-name $ZONE \
    --query "HostedZones[?Name=='$ZONE.' && Config.PrivateZone].Id") || return
  for z in $zs; do
    z=${z#/hostedzone/}
    ours "$(q route53 list-tags-for-resource --resource-type hostedzone --resource-id "$z" \
      --query "ResourceTagSet.Tags[?Key=='Project'].Value | [0]")" "private zone $ZONE ($z)"
    ids+=${ids:+ }$z
  done
  one "zone $ZONE" "$ids"
}

ecr_digest() {  # tag
  q ecr describe-images --repository-name egpt --image-ids "imageTag=$1" --query 'imageDetails[0].imageDigest' 2>/dev/null || true
}

cluster_status() {
  q ecs describe-clusters --clusters $CLUSTER --query 'clusters[0].status'
}

# service_info: status desiredCount runningCount taskDefinition, or nothing.
service_info() {
  [ "$(cluster_status)" = ACTIVE ] || return 0
  q ecs describe-services --cluster $CLUSTER --services $SERVICE \
    --query 'services[0].[status,desiredCount,runningCount,taskDefinition]'
}

asg_exists() {
  [ -n "$(q autoscaling describe-auto-scaling-groups --auto-scaling-group-names $ASG --query 'AutoScalingGroups[0].AutoScalingGroupName')" ]
}

asg_instances() {
  q autoscaling describe-auto-scaling-groups --auto-scaling-group-names $ASG --query 'AutoScalingGroups[0].Instances[].InstanceId'
}

# The task definition for IMAGE (no tags).
taskdef_json() {
  jq -n --arg image "$1" --arg family $FAMILY --arg srv $SRV --arg attr $ATTR --argjson mem $MEM_MIB \
    --arg name "$N" --arg beeper "$EGPT_BEEPER" --arg tunnel "$TUNNEL_SH" --argjson sidecar "$OFICINA_TUNNEL" \
    --arg ssh "$SSH_PORT" --arg listen "$SSH_PERMIT_LISTEN" '
    ([["egpt-home", "/home/egpt/.egpt"], ["egpt-claude", "/home/egpt/.claude"],
      ["egpt-src", "/home/egpt/src/egpt"], ["egpt-jsonl", "/home/egpt/.egpt-jsonl"]]
     + [$ARGS.positional[] | split(":")]) as $vols
    | {
      family: $family,
      networkMode: "host",
      requiresCompatibilities: ["EC2"],
      placementConstraints: [{type: "memberOf", expression: "attribute:\($attr) == mounted"}],
      volumes: [$vols[] | {name: .[0], host: {sourcePath: "\($srv)/\(.[0])"}}],
      containerDefinitions: ([{
        name: $name,
        image: $image,
        essential: true,
        privileged: true,
        memoryReservation: $mem,
        linuxParameters: {sharedMemorySize: 1024},
        environment: ([{name: "EGPT_BRANCH", value: "main"}, {name: "EGPT_BEEPER", value: $beeper}]
          + if $ssh == "" then [] else [{name: "EGPT_SSH_PORT", value: $ssh}] end
          + if $listen == "" then [] else [{name: "EGPT_SSH_PERMIT_LISTEN", value: $listen}] end),
        mountPoints: [$vols[] | {sourceVolume: .[0], containerPath: .[1]}],
        logConfiguration: {logDriver: "json-file", options: {"max-size": "50m", "max-file": "3"}}
      }] + if $sidecar == 1 then [{
        name: "oficina-tunnel",
        image: $image,
        essential: false,
        memoryReservation: 32,
        memory: 128,
        entryPoint: ["/usr/bin/tini", "--", "/bin/sh", "-c"],
        command: [$tunnel],
        mountPoints: [{sourceVolume: "egpt-home", containerPath: "/home/egpt/.egpt", readOnly: true}],
        restartPolicy: {enabled: true, restartAttemptPeriod: 60},
        logConfiguration: {logDriver: "json-file", options: {"max-size": "50m", "max-file": "3"}}
      }] else [] end)
    }' --args "${BEEPER_VOLS[@]}"
}

spec_hash() { jq -S -c . <<<"$1" | sha256sum | cut -c1-12; }

latest_taskdef() {
  q ecs list-task-definitions --family-prefix $FAMILY --status ACTIVE --sort DESC --query 'taskDefinitionArns[0]'
}

td_tag() {  # arn key
  q ecs describe-task-definition --task-definition "$1" --include TAGS --query "tags[?key=='$2'].value | [0]"
}

td_image() {  # arn
  q ecs describe-task-definition --task-definition "$1" --query 'taskDefinition.containerDefinitions[0].image'
}

# taskdef_for IMAGE: prints the ARN of an ACTIVE revision for IMAGE, registering one when the
# latest revision's spec (the $N-spec tag) differs.
taskdef_for() {
  local json h latest
  json=$(taskdef_json "$1")
  h=$(spec_hash "$json")
  latest=$(latest_taskdef)
  if [ -n "$latest" ]; then
    ours "$(td_tag "$latest" Project)" "task definition $latest"
    if [ "$(td_tag "$latest" "$N-spec")" = "$h" ]; then
      log "taskdef  ${latest##*/} has this spec ($h)"
      echo "$latest"
      return
    fi
    log "taskdef  ${latest##*/} is image $(td_image "$latest")"
  fi
  log "task definition to register (spec $h):"
  jq . <<<"$json" | sed 's/^/  | /' >&2
  jq --arg p "$PROJECT" --arg k "$N-spec" --arg h "$h" '. + {tags: [{key: "Project", value: $p}, {key: $k, value: $h}]}' \
    <<<"$json" >"$TMP/taskdef.json"
  new taskdef ecs register-task-definition --cli-input-json "file://$TMP/taskdef.json" \
    --query taskDefinition.taskDefinitionArn
}

# Waits for the service to settle and prints where it stands.
wait_stable() {
  local i ok=1
  for i in 1 2 3; do
    log "waiting for the service to settle ($i/3, up to 10 min each)"
    aws ecs wait services-stable --cluster $CLUSTER --services $SERVICE && { ok=0; break; }
  done
  q ecs describe-services --cluster $CLUSTER --services $SERVICE \
    --query 'services[0].deployments[].[status,rolloutState,taskDefinition,runningCount]' >&2; echo >&2
  q ecs describe-services --cluster $CLUSTER --services $SERVICE \
    --query 'services[0].events[:5].[createdAt,message]' >&2; echo >&2
  return $ok
}
