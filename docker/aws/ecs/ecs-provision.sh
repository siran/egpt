#!/bin/bash
# ecs-provision.sh [--deploy edw] [--on-demand] [--apply]
# A deployment on ECS over EC2: cluster $N, a launch template and an Auto Scaling group for its one
# container instance (Spot unless --on-demand or ON_DEMAND=1), the task definition and the service $N.
# With a LEGACY_NODE (EDW) it reuses provision.sh's subnet, security group and data volume; without
# one it makes them. Re-running finds what exists.
# With a ZONE (EDW: egpt.internal), the instance points DNS_NAME at itself at every boot.
# The ASG and the service start at 0; ecs-cutover.sh moves EDW over, or starts a new deployment.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/ecs-lib.sh"

OD=0
[ "$ON_DEMAND" != 1 ] || OD=100
while [ $# -gt 0 ]; do
  case $1 in
    --apply) APPLY=1 ;;
    --on-demand) OD=100 ;;
    *) die "usage: ecs-provision.sh [--deploy edw] [--on-demand] [--apply]" ;;
  esac
  shift
done
check_account

ROOT_GB=30
ARN_EC2=arn:aws:ec2:$AWS_DEFAULT_REGION:$ACCOUNT
# The instance attaches the data volume to itself at boot: AttachVolume on our tagged volume and instances only.
ATTACH='{"Version":"2012-10-17","Statement":[
{"Sid":"DataVolume","Effect":"Allow","Action":"ec2:AttachVolume","Resource":"'$ARN_EC2':volume/*",
 "Condition":{"StringEquals":{"aws:ResourceTag/Project":"'$PROJECT'","aws:ResourceTag/Name":"'$DATA'"}}},
{"Sid":"OurInstances","Effect":"Allow","Action":"ec2:AttachVolume","Resource":"'$ARN_EC2':instance/*",
 "Condition":{"StringEquals":{"aws:ResourceTag/Project":"'$PROJECT'"}}},
{"Sid":"Describe","Effect":"Allow","Action":"ec2:DescribeVolumes","Resource":"*"}]}'
DEPLOY_CFG='{"maximumPercent":100,"minimumHealthyPercent":0,"deploymentCircuitBreaker":{"enable":true,"rollback":true}}'

user_data() {  # data-volume-id zone-id
  local v bdirs=''
  for v in "${BEEPER_VOLS[@]}"; do bdirs+=" ${v%%:*}"; done
  {
    cat <<'EOF'
#!/bin/bash
# @LABEL@ ECS container instance, first boot. Output: /var/log/cloud-init-output.log
# Docker and the ECS agent start after cloud-init: never start or restart them here.
set -euxo pipefail
VOL=@VOL@
SRV=/srv/egpt
trap 'echo "@LABEL@: boot setup failed; no @ATTR@ attribute, so the @N@ task is not placed here"' ERR

cat >>/etc/ecs/ecs.config <<'CFG'
ECS_CLUSTER=@CLUSTER@
ECS_ENABLE_TASK_IAM_ROLE=false
ECS_ENABLE_TASK_IAM_ROLE_NETWORK_HOST=false
ECS_ENABLE_SPOT_INSTANCE_DRAINING=true
CFG

# The task shares the host network: only root may reach the metadata service (the role's credentials).
command -v iptables || dnf install -y iptables-nft
cat >/etc/systemd/system/@N@-imds-guard.service <<'UNIT'
[Unit]
Description=@LABEL@: only root reaches the instance metadata service
Before=docker.service ecs.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=-iptables -w -D OUTPUT -d 169.254.169.254/32 -m owner ! --uid-owner 0 -j REJECT
ExecStart=iptables -w -I OUTPUT -d 169.254.169.254/32 -m owner ! --uid-owner 0 -j REJECT
[Install]
WantedBy=multi-user.target
UNIT
mkdir -p /etc/systemd/system/ecs.service.d
printf '[Unit]\nRequires=@N@-imds-guard.service\nAfter=@N@-imds-guard.service\n' >/etc/systemd/system/ecs.service.d/@N@-guard.conf
systemctl daemon-reload
systemctl enable --now @N@-imds-guard.service

mkdir -p /etc/docker
[ -s /etc/docker/daemon.json ] \
  || echo '{"log-driver":"json-file","log-opts":{"max-size":"50m","max-file":"3"}}' >/etc/docker/daemon.json

# Host network: the task takes the host's name. Keep the old container's (sudo, Chrome profile locks).
echo 'preserve_hostname: true' >/etc/cloud/cloud.cfg.d/99-@N@-hostname.cfg
hostnamectl set-hostname @N@
grep -q '[[:space:]]@N@$' /etc/hosts || echo '127.0.0.1 @N@' >>/etc/hosts

EOF
    [ -z "$ZONE" ] || cat <<'EOF'
# Every boot: @DNS_NAME@ (private zone, read in EduWeb's production VPC) -> this instance's private IP.
cat >/usr/local/sbin/@N@-dns <<'DNS'
#!/bin/bash
# Log: journalctl -u @N@-dns (also on the console)
name=@DNS_NAME@ zone=@ZONE_ID@
export AWS_DEFAULT_REGION=@REGION@ AWS_PAGER=
command -v aws >/dev/null || dnf install -y awscli-2 || { echo "@N@-dns: no aws cli; $name not updated"; exit 1; }
for i in $(seq 18); do
  if tok=$(curl -sf -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60') \
    && ip=$(curl -sf -H "X-aws-ec2-metadata-token: $tok" http://169.254.169.254/latest/meta-data/local-ipv4) \
    && aws route53 change-resource-record-sets --hosted-zone-id "$zone" --query ChangeInfo.Id --output text --change-batch \
      '{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"'"$name"'","Type":"A","TTL":60,"ResourceRecords":[{"Value":"'"$ip"'"}]}}]}'
  then echo "@N@-dns: $name A $ip"; exit 0; fi
  echo "@N@-dns: try $i/18 failed; again in 10 s"
  sleep 10
done
echo "@N@-dns: gave up; $name keeps its old address"
exit 1
DNS
chmod 755 /usr/local/sbin/@N@-dns
cat >/etc/systemd/system/@N@-dns.service <<'UNIT'
[Unit]
Description=@LABEL@: point @DNS_NAME@ at this instance
Wants=network-online.target
After=network-online.target
[Service]
Type=exec
ExecStart=/usr/local/sbin/@N@-dns
StandardOutput=journal+console
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now @N@-dns.service || true

EOF
    cat <<'EOF'
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=@SWAP_MB@
  chmod 600 /swapfile
  mkswap /swapfile
  echo '/swapfile none swap defaults 0 0' >>/etc/fstab
fi
swapon -a

# The data volume: attach it to this instance, waiting while a previous instance lets go of it.
command -v aws || dnf install -y awscli-2
tok=$(curl -sf -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 600')
md() { curl -sf -H "X-aws-ec2-metadata-token: $tok" "http://169.254.169.254/latest/meta-data/$1"; }
me=$(md instance-id)
AWS_DEFAULT_REGION=$(md placement/region)
export AWS_DEFAULT_REGION
[ "$(aws ec2 describe-volumes --volume-ids "$VOL" --query "Volumes[0].Tags[?Key=='Project'].Value | [0]" --output text)" = @PROJECT@ ]
att=
for _ in $(seq 120); do
  read -r state att <<<"$(aws ec2 describe-volumes --volume-ids "$VOL" --query 'Volumes[0].[State,Attachments[0].InstanceId]' --output text)"
  [ "$att" = "$me" ] && break
  if [ "$state" = available ]; then aws ec2 attach-volume --volume-id "$VOL" --instance-id "$me" --device /dev/sdf || true; fi
  sleep 10
done
[ "$att" = "$me" ]
dev=/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${VOL//-/}
for _ in $(seq 60); do [ -e "$dev" ] && break; sleep 2; done
uuid='' fstype=''
for _ in $(seq 5); do
  uuid=$(blkid -o value -s UUID "$dev") && fstype=$(blkid -o value -s TYPE "$dev") && break
  sleep 2
done
EOF
    if [ "$DATA_INIT" = format ]; then cat <<'EOF'
# Formatted only with no filesystem AND tagged DataInit=pending (set by ecs-provision.sh at create-volume), then DataInit=done.
# A new encrypted volume reads as random bytes, not zeros, so the tag is the only sign that it is blank.
fresh=''
if [ -z "$uuid" ]; then
  init=$(aws ec2 describe-volumes --volume-ids "$VOL" --query "Volumes[0].Tags[?Key=='DataInit'].Value | [0]" --output text)
  [ "$init" = pending ] || { echo "@LABEL@: $VOL has no filesystem and DataInit is '$init', not pending; it is not formatted"; exit 1; }
  mkfs.xfs "$dev"
  udevadm settle
  uuid=$(blkid -p -o value -s UUID "$dev") fstype=xfs fresh=1
  [ -n "$uuid" ]
fi
grep -q "UUID=$uuid" /etc/fstab || echo "UUID=$uuid $SRV $fstype defaults,nofail 0 2" >>/etc/fstab
mkdir -p "$SRV"
systemctl daemon-reload
mountpoint -q "$SRV" || mount "$SRV"
if [ -n "$fresh" ]; then
  install -d -o 1000 -g 1000 -m 755 "$SRV/egpt-home"
  aws ec2 create-tags --resources "$VOL" --tags Key=DataInit,Value=done \
    || echo "@LABEL@: could not tag $VOL DataInit=done; it has a filesystem now, so no boot formats it"
fi
[ -d "$SRV/egpt-home" ] || { echo "@LABEL@: $VOL has no egpt-home"; exit 1; }
EOF
    else cat <<'EOF'
[ -n "$uuid" ] || { echo "@LABEL@: no filesystem found on $VOL; it is never formatted here"; exit 1; }
grep -q "UUID=$uuid" /etc/fstab || echo "UUID=$uuid $SRV $fstype defaults,nofail 0 2" >>/etc/fstab
mkdir -p "$SRV"
systemctl daemon-reload
mountpoint -q "$SRV" || mount "$SRV"
[ -f "$SRV/egpt-home/config/config.yaml" ] || { echo "@LABEL@: $VOL has no egpt-home/config/config.yaml"; exit 1; }
EOF
    fi
    cat <<'EOF'
for d in egpt-claude egpt-src egpt-jsonl@BEEPER_DIRS@; do [ -d "$SRV/$d" ] || install -d -o 1000 -g 1000 -m 755 "$SRV/$d"; done

# From now on the agent runs only with the volume mounted, and the task may be placed here.
printf '[Unit]\nRequiresMountsFor=%s\n' "$SRV" >/etc/systemd/system/ecs.service.d/@N@-data.conf
systemctl daemon-reload
echo 'ECS_INSTANCE_ATTRIBUTES={"@ATTR@":"mounted"}' >>/etc/ecs/ecs.config
touch /etc/egpt-@N@-ecs-node
EOF
  } | sed -e "s/@VOL@/$1/" -e "s/@CLUSTER@/$CLUSTER/" -e "s/@ATTR@/$ATTR/g" -e "s/@PROJECT@/$PROJECT/" \
    -e "s/@ZONE_ID@/$2/" -e "s/@DNS_NAME@/$DNS_NAME/g" -e "s/@REGION@/$AWS_DEFAULT_REGION/" \
    -e "s/@N@/$N/g" -e "s/@LABEL@/$LABEL/g" -e "s/@SWAP_MB@/$SWAP_MB/" -e "s/@BEEPER_DIRS@/$bdirs/"
}

if [ -n "$LEGACY_NODE" ]; then
  # What provision.sh made
  SUBNET=$(byname describe-subnets 'Subnets[].SubnetId' "$N-public")
  [ -n "$SUBNET" ] || die "no subnet $N-public tagged $PROJECT (provision.sh)"
  AZ=$(q ec2 describe-subnets --subnet-ids "$SUBNET" --query 'Subnets[0].AvailabilityZone')
  log "subnet   $SUBNET ($AZ)"
  SG=$(byname describe-security-groups 'SecurityGroups[].GroupId' "$N-sg")
  [ -n "$SG" ] || die "no security group $N-sg tagged $PROJECT (provision.sh)"
  log "sg       $SG"
  [ -z "$(q ec2 describe-security-groups --group-ids "$SG" --query 'SecurityGroups[0].IpPermissions')" ] \
    || log "WARNING: $N-sg has inbound rules; it should have none"
else
  ensure_network "${TYPES[@]}" t3a.large
fi
VOL=$(find_volume) vatt=
if [ -n "$VOL" ]; then
  read -r vaz vatt <<<"$(q ec2 describe-volumes --volume-ids "$VOL" --query 'Volumes[0].[AvailabilityZone,Attachments[0].InstanceId]')"
  [ "$vatt" = None ] && vatt=
  [ "$vaz" = "$AZ" ] || die "$DATA is in $vaz but the subnet is in $AZ"
  log "data     $VOL ($vaz, attached to ${vatt:-nothing})"
else
  [ -z "$LEGACY_NODE" ] || die "no volume $DATA tagged $PROJECT (provision.sh)"
  # Created empty; with DATA_INIT=format it is tagged DataInit=pending and the instance formats it at its first boot.
  init=
  [ "$DATA_INIT" != format ] || init='{Key=DataInit,Value=pending}'
  VOL=$(new data-volume ec2 create-volume --availability-zone "$AZ" --size "$DATA_GB" --volume-type gp3 --encrypted \
    --tag-specifications "$(tagspec volume "$DATA" "$init")" --query VolumeId)
  run aws ec2 wait volume-available --volume-ids "$VOL"
fi
DIGEST=$(ecr_digest "$N")
if [ -n "$DIGEST" ]; then
  log "image    egpt:$N = $DIGEST"
else
  [ "$APPLY" = 0 ] || die "egpt:$N is not in ECR (build-push.sh)"
  DIGEST="<digest-of-egpt:$N>"
  log "image    egpt:$N is not in ECR yet (build-push.sh --apply); the plan uses $DIGEST"
fi

# Private zone in EduWeb's production VPC (Portales-new, over the peering); the instance keeps $DNS_NAME current.
ZID=
[ -z "$ZONE" ] || ZID=$(find_zone)
if [ -z "$ZONE" ]; then
  log "zone     none"
elif [ -n "$ZID" ]; then
  vpcs=$(q route53 get-hosted-zone --id "$ZID" --query 'VPCs[].VPCId' | tr '\t' ' ')
  log "zone     $ZONE $ZID (vpcs: $vpcs)"
  [[ " $vpcs " == *" $ZONE_VPC "* ]] || run aws route53 associate-vpc-with-hosted-zone --hosted-zone-id "$ZID" \
    --vpc "VPCRegion=$AWS_DEFAULT_REGION,VPCId=$ZONE_VPC" --query ChangeInfo.Status
  rec=$(q route53 list-resource-record-sets --hosted-zone-id "$ZID" \
    --query "ResourceRecordSets[?Name=='$DNS_NAME.' && Type=='A'].ResourceRecords[].Value" | tr '\t' ' ')
  nip=$(q ec2 describe-instances --filters "$TAGF" "Name=tag:Name,Values=$NODE" Name=instance-state-name,Values=running \
    --query 'Reservations[].Instances[].PrivateIpAddress' | tr '\t' ' ')
  log "dns      $DNS_NAME A ${rec:-none} (running $NODE: ${nip:-none})"
else
  ZID=$(new zone route53 create-hosted-zone --name $ZONE --caller-reference "$PROJECT-$(date +%s)" \
    --vpc "VPCRegion=$AWS_DEFAULT_REGION,VPCId=$ZONE_VPC" --hosted-zone-config "PrivateZone=true,Comment=$PROJECT" \
    --query HostedZone.Id)
  ZID=${ZID#/hostedzone/}
  run aws route53 change-tags-for-resource --resource-type hostedzone --resource-id "$ZID" \
    --add-tags "Key=Project,Value=$PROJECT" "Key=Name,Value=$ZONE"
fi
# The instance may UPSERT its own A record and nothing else.
DNS='{"Version":"2012-10-17","Statement":[
{"Sid":"OwnRecord","Effect":"Allow","Action":"route53:ChangeResourceRecordSets","Resource":"arn:aws:route53:::hostedzone/'$ZID'",
 "Condition":{"ForAllValues:StringEquals":{"route53:ChangeResourceRecordSetsNormalizedRecordNames":["'$DNS_NAME'"],
  "route53:ChangeResourceRecordSetsRecordTypes":["A"],"route53:ChangeResourceRecordSetsActions":["UPSERT"]}}}]}'

# Instance role: what edw-instance-role has, plus the ECS agent's policy, attaching the data volume and its DNS record.
role_new=0
if iam_has get-role --role-name $ROLE; then
  ours "$(q iam list-role-tags --role-name $ROLE --query "Tags[?Key=='Project'].Value")" "role $ROLE"
  log "role     $ROLE"
else
  run aws iam create-role --role-name $ROLE --assume-role-policy-document "$TRUST" \
    --description "$LABEL ECS container instance (egpt)" --tags Key=Project,Value=$PROJECT Key=Name,Value=$ROLE
  role_new=1
fi
for p in AmazonSSMManagedInstanceCore AmazonEC2ContainerRegistryReadOnly service-role/AmazonEC2ContainerServiceforEC2Role; do
  arn=arn:aws:iam::aws:policy/$p
  if [ $role_new = 1 ] || [ -z "$(q iam list-attached-role-policies --role-name $ROLE \
      --query "AttachedPolicies[?PolicyArn=='$arn'].PolicyArn")" ]; then
    run aws iam attach-role-policy --role-name $ROLE --policy-arn "$arn"
  fi
done
inline() {  # name document: puts the inline policy unless it is already this document
  local have
  if [ $role_new = 0 ] && have=$(aws iam get-role-policy --role-name $ROLE --policy-name "$1" \
      --query PolicyDocument --output json 2>/dev/null) && [ "$(jq -S -c . <<<"$have")" = "$(jq -S -c . <<<"$2")" ]; then
    log "policy   $1 (current)"
  else
    run aws iam put-role-policy --role-name $ROLE --policy-name "$1" --policy-document "$(jq -c . <<<"$2")"
  fi
}
[ -z "$BUCKET" ] || inline "$N-transfer" "$TRANSFER"
# DATA_INIT=format: after formatting, the instance may set DataInit=done on its data volume, and no other tag.
DONE='{"Sid":"DataInitDone","Effect":"Allow","Action":"ec2:CreateTags","Resource":"'$ARN_EC2:volume/$VOL'",
 "Condition":{"StringEquals":{"aws:RequestTag/DataInit":"done"},"ForAllValues:StringEquals":{"aws:TagKeys":["DataInit"]}}}'
[ "$DATA_INIT" != format ] || ATTACH=$(jq -c --argjson s "$DONE" '.Statement += [$s]' <<<"$ATTACH")
inline "$N-data-attach" "$ATTACH"
[ -z "$ZONE" ] || inline "$N-dns" "$DNS"

prof_new=0 roles=''
if iam_has get-instance-profile --instance-profile-name $IPROFILE; then
  ours "$(q iam list-instance-profile-tags --instance-profile-name $IPROFILE --query "Tags[?Key=='Project'].Value")" \
    "instance profile $IPROFILE"
  log "profile  $IPROFILE"
  roles=$(q iam get-instance-profile --instance-profile-name $IPROFILE --query 'InstanceProfile.Roles[].RoleName')
else
  run aws iam create-instance-profile --instance-profile-name $IPROFILE \
    --tags Key=Project,Value=$PROJECT Key=Name,Value=$IPROFILE
  prof_new=1
fi
[ "$roles" = $ROLE ] || run aws iam add-role-to-instance-profile --instance-profile-name $IPROFILE --role-name $ROLE

# Cluster
CST=$(cluster_status)
if [ "$CST" = ACTIVE ]; then
  ours "$(q ecs describe-clusters --clusters $CLUSTER --include TAGS --query "clusters[0].tags[?key=='Project'].value | [0]")" \
    "cluster $CLUSTER"
  log "cluster  $CLUSTER"
else
  run aws ecs create-cluster --cluster-name $CLUSTER --settings name=containerInsights,value=disabled \
    --tags key=Project,value=$PROJECT key=Name,value=$CLUSTER --query cluster.clusterArn
fi

# Launch template: the AMI is resolved now, so every instance of one version boots the same image.
AMI=$(q ssm get-parameter --name $AMI_PARAM --query Parameter.Value)
read -r AMI_NAME ROOTDEV <<<"$(q ec2 describe-images --image-ids "$AMI" --query 'Images[0].[Name,RootDeviceName]')"
log "ami      $AMI ($AMI_NAME, root $ROOTDEV)"
user_data "$VOL" "$ZID" >"$TMP/user-data.sh"
jq -n --arg ami "$AMI" --arg type "${TYPES[0]}" --arg prof $IPROFILE --arg sg "$SG" --arg rootdev "$ROOTDEV" \
  --argjson gb $ROOT_GB --arg p $PROJECT --arg node $NODE --arg root "$N-ecs-root" --arg ud "$(base64 -w0 "$TMP/user-data.sh")" '{
  ImageId: $ami,
  InstanceType: $type,
  IamInstanceProfile: {Name: $prof},
  NetworkInterfaces: [{DeviceIndex: 0, AssociatePublicIpAddress: true, Groups: [$sg], DeleteOnTermination: true}],
  MetadataOptions: {HttpTokens: "required", HttpEndpoint: "enabled", HttpPutResponseHopLimit: 1},
  BlockDeviceMappings: [{DeviceName: $rootdev,
    Ebs: {VolumeSize: $gb, VolumeType: "gp3", Encrypted: true, DeleteOnTermination: true}}],
  TagSpecifications: [
    {ResourceType: "instance", Tags: [{Key: "Project", Value: $p}, {Key: "Name", Value: $node}]},
    {ResourceType: "volume", Tags: [{Key: "Project", Value: $p}, {Key: "Name", Value: $root}]}],
  UserData: $ud}' >"$TMP/lt.json"
LT_SPEC="spec $(spec_hash "$(cat "$TMP/lt.json")")"
read -r lt_id lt_proj <<<"$(q ec2 describe-launch-templates --filters "Name=launch-template-name,Values=$LT" \
  --query "LaunchTemplates[0].[LaunchTemplateId,Tags[?Key=='Project'].Value | [0]]")"
lt_desc=
if [ -n "$lt_id" ]; then
  ours "$lt_proj" "launch template $LT"
  # shellcheck disable=SC2016  # $Default is AWS's alias for the default version
  lt_desc=$(q ec2 describe-launch-template-versions --launch-template-id "$lt_id" --versions '$Default' \
    --query 'LaunchTemplateVersions[0].VersionDescription')
fi
if [ "$lt_desc" = "$LT_SPEC" ]; then
  log "template $LT $lt_id ($LT_SPEC, current)"
else
  log "launch template data ($LT_SPEC):"
  jq '.UserData = "<base64 of the user data below>"' "$TMP/lt.json" | sed 's/^/  | /' >&2
  log "user data:"
  sed 's/^/  | /' "$TMP/user-data.sh" >&2
  if [ -z "$lt_id" ]; then
    run aws ec2 create-launch-template --launch-template-name $LT --version-description "$LT_SPEC" \
      --launch-template-data "file://$TMP/lt.json" --tag-specifications "$(tagspec launch-template $LT)" \
      --query LaunchTemplate.LaunchTemplateId
  else
    log "template $LT $lt_id is at '$lt_desc'; the next instance boots the new version"
    v=$(new lt-version ec2 create-launch-template-version --launch-template-id "$lt_id" \
      --version-description "$LT_SPEC" --launch-template-data "file://$TMP/lt.json" \
      --query LaunchTemplateVersion.VersionNumber)
    run aws ec2 modify-launch-template --launch-template-id "$lt_id" --default-version "$v" \
      --query LaunchTemplate.DefaultVersionNumber
  fi
fi

# Auto Scaling group: one instance in the data volume's AZ; Spot over two pools unless --on-demand.
MIP=$(jq -nc --arg lt $LT --argjson od $OD '{
  LaunchTemplate: {LaunchTemplateSpecification: {LaunchTemplateName: $lt, Version: "$Default"},
    Overrides: [$ARGS.positional[] | {InstanceType: .}]},
  InstancesDistribution: {OnDemandAllocationStrategy: "prioritized", OnDemandBaseCapacity: 0,
    OnDemandPercentageAboveBaseCapacity: $od, SpotAllocationStrategy: "price-capacity-optimized"}}' \
  --args "${TYPES[@]}")
MIP_KEY='{lt: .LaunchTemplate.LaunchTemplateSpecification.LaunchTemplateName,
  v: .LaunchTemplate.LaunchTemplateSpecification.Version, types: [.LaunchTemplate.Overrides[].InstanceType],
  od: .InstancesDistribution.OnDemandPercentageAboveBaseCapacity, spot: .InstancesDistribution.SpotAllocationStrategy}'
if asg_exists; then
  ours "$(q autoscaling describe-auto-scaling-groups --auto-scaling-group-names $ASG \
    --query "AutoScalingGroups[0].Tags[?Key=='Project'].Value | [0]")" "auto scaling group $ASG"
  log "asg      $ASG (min/max/desired $(q autoscaling describe-auto-scaling-groups --auto-scaling-group-names $ASG \
    --query 'AutoScalingGroups[0].[MinSize,MaxSize,DesiredCapacity]' | tr '\t' /), instances: $(asg_instances))"
  have=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names $ASG \
    --query 'AutoScalingGroups[0].MixedInstancesPolicy' --output json | jq -c "$MIP_KEY")
  if [ "$have" != "$(jq -c "$MIP_KEY" <<<"$MIP")" ]; then
    log "asg policy now: $have"
    run aws autoscaling update-auto-scaling-group --auto-scaling-group-name $ASG --mixed-instances-policy "$MIP"
    log "a running instance keeps its purchase option; the next one gets ${OD}% on-demand"
  fi
else
  run aws autoscaling create-auto-scaling-group --auto-scaling-group-name $ASG --mixed-instances-policy "$MIP" \
    --min-size 0 --max-size 1 --desired-capacity 0 --vpc-zone-identifier "$SUBNET" \
    --health-check-type EC2 --health-check-grace-period 300 \
    --tags "ResourceId=$ASG,ResourceType=auto-scaling-group,Key=Project,Value=$PROJECT,PropagateAtLaunch=true" \
    "ResourceId=$ASG,ResourceType=auto-scaling-group,Key=Name,Value=$NODE,PropagateAtLaunch=true"
fi

# Task definition: the first revision only; ecs-deploy.sh registers the next ones.
TD=$(latest_taskdef)
if [ -n "$TD" ]; then
  ours "$(td_tag "$TD" Project)" "task definition $TD"
  log "taskdef  ${TD##*/} ($(td_image "$TD"))"
else
  TD=$(taskdef_for "$REGISTRY/egpt@$DIGEST")
fi

# Service: never two copies (one Telegram poller per bot token), so min 0 / max 100.
read -r sst sdes _ std <<<"$(service_info)"
if [ "$sst" = ACTIVE ]; then
  ours "$(q ecs describe-services --cluster $CLUSTER --services $SERVICE --include TAGS \
    --query "services[0].tags[?key=='Project'].value | [0]")" "service $SERVICE"
  log "service  $SERVICE (desired $sdes, ${std##*/})"
  [ "$(q ecs describe-services --cluster $CLUSTER --services $SERVICE --query \
    'services[0].deploymentConfiguration.[minimumHealthyPercent,maximumPercent]' | tr '\t' /)" = 0/100 ] \
    || run aws ecs update-service --cluster $CLUSTER --service $SERVICE --deployment-configuration "$DEPLOY_CFG" \
      --query service.serviceName
else
  run aws ecs create-service --cluster $CLUSTER --service-name $SERVICE --task-definition "$TD" --desired-count 0 \
    --launch-type EC2 --scheduling-strategy REPLICA --deployment-configuration "$DEPLOY_CFG" \
    --enable-ecs-managed-tags --propagate-tags SERVICE --tags key=Project,value=$PROJECT key=Name,value=$SERVICE \
    --query service.serviceArn
fi

[ $prof_new = 0 ] || [ "$APPLY" = 0 ] || log "note: a new instance profile takes ~20s to reach EC2; wait before ecs-cutover.sh"
if [ -n "$LEGACY_NODE" ]; then
  log "next: ecs-cutover.sh (stops $N on ${vatt:-$LEGACY_NODE}, moves $DATA, scales $ASG to 1, service to 1)"
else
  log "next: ecs-cutover.sh --deploy $DEPLOY (scales $ASG to 1, waits for $DATA, service to 1)"
fi
