# shellcheck shell=bash disable=SC2034
# Shared by the ECS scripts in docker/aws/ecs (sourced, not run). Builds on ../lib.sh.

. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

CLUSTER=edw
SERVICE=edw
FAMILY=edw
LT=edw-ecs-lt
ASG=edw-ecs-asg
ROLE=edw-ecs-role
IPROFILE=edw-ecs-profile
NODE=edw-ecs-node            # Name of the ASG's instances (the old one is edw-node)
TYPES=(t3a.small t3.small)   # Spot pools; on-demand takes the first
AMI_PARAM=/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id
SRV=/srv/egpt
ATTR=edw-data                # instance attribute, set once $SRV is mounted; the task requires it
MEM_MIB=1024                 # memoryReservation (soft); t3a.small registers ~1.9 GiB

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

find_volume() {
  one volume "$(q ec2 describe-volumes --filters "$TAGF" Name=tag:Name,Values=edw-data --query 'Volumes[].VolumeId')"
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
  jq -n --arg image "$1" --arg family $FAMILY --arg srv $SRV --arg attr $ATTR --argjson mem $MEM_MIB '
    [["egpt-home", "/home/egpt/.egpt"], ["egpt-claude", "/home/egpt/.claude"],
     ["egpt-src", "/home/egpt/src/egpt"], ["egpt-jsonl", "/home/egpt/.egpt-jsonl"]] as $vols
    | {
      family: $family,
      networkMode: "host",
      requiresCompatibilities: ["EC2"],
      placementConstraints: [{type: "memberOf", expression: "attribute:\($attr) == mounted"}],
      volumes: [$vols[] | {name: .[0], host: {sourcePath: "\($srv)/\(.[0])"}}],
      containerDefinitions: [{
        name: "edw",
        image: $image,
        essential: true,
        privileged: true,
        memoryReservation: $mem,
        linuxParameters: {sharedMemorySize: 1024},
        environment: [{name: "EGPT_BRANCH", value: "main"}, {name: "EGPT_BEEPER", value: "off"}],
        mountPoints: [$vols[] | {sourceVolume: .[0], containerPath: .[1]}],
        logConfiguration: {logDriver: "json-file", options: {"max-size": "50m", "max-file": "3"}}
      }]
    }'
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
# latest revision's spec (the edw-spec tag) differs.
taskdef_for() {
  local json h latest
  json=$(taskdef_json "$1")
  h=$(spec_hash "$json")
  latest=$(latest_taskdef)
  if [ -n "$latest" ]; then
    ours "$(td_tag "$latest" Project)" "task definition $latest"
    if [ "$(td_tag "$latest" edw-spec)" = "$h" ]; then
      log "taskdef  ${latest##*/} has this spec ($h)"
      echo "$latest"
      return
    fi
    log "taskdef  ${latest##*/} is image $(td_image "$latest")"
  fi
  log "task definition to register (spec $h):"
  jq . <<<"$json" | sed 's/^/  | /' >&2
  jq --arg p "$PROJECT" --arg h "$h" '. + {tags: [{key: "Project", value: $p}, {key: "edw-spec", value: $h}]}' \
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
