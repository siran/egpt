#!/bin/bash
# provision.sh [--type t3a.medium] [--apply]
# EDW's AWS host: its own VPC (one public subnet, internet gateway, no NAT), a security group
# with no inbound rules, an instance role, an encrypted data volume and one Amazon Linux 2023
# instance. Access is SSM only: no key pair, no open port. Re-running finds what exists.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TYPE=t3a.medium
while [ $# -gt 0 ]; do
  case $1 in
    --apply) APPLY=1 ;;
    --type) TYPE=${2:?--type needs a value}; shift ;;
    *) die "usage: provision.sh [--type t3a.medium] [--apply]" ;;
  esac
  shift
done
check_account

VPC_CIDR=10.88.0.0/16
SUBNET_CIDR=10.88.1.0/24
ROLE=edw-instance-role
IPROFILE=edw-instance-profile
ROOT_GB=30
DATA_GB=30
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
TRANSFER='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:DeleteObject"],"Resource":"arn:aws:s3:::'$BUCKET/$PREFIX'*"}]}'

byname() {  # describe-call query name: our resource ids with that Name
  one "$3" "$(q ec2 "$1" --filters "$TAGF" "Name=tag:Name,Values=$3" --query "$2")"
}

iam_has() {  # iam get-call args: 0 exists, 1 missing, else dies
  local err
  err=$(aws iam "$@" 2>&1 >/dev/null) && return 0
  grep -q NoSuchEntity <<<"$err" && return 1
  die "$err"
}

ours() {  # project-tag-value what
  [ "$1" = "$PROJECT" ] || die "$2 exists but is not tagged Project=$PROJECT; not touching it"
}

user_data() {  # data-volume-id
  sed "s/@VOL@/${1//-/}/" <<'EOF'
#!/bin/bash
# EDW host, first boot. Output: /var/log/cloud-init-output.log
set -euxo pipefail
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=4096
  chmod 600 /swapfile
  mkswap /swapfile
  echo '/swapfile none swap defaults 0 0' >> /etc/fstab
fi
swapon -a
dnf install -y docker
mkdir -p /etc/docker
echo '{"log-driver":"json-file","log-opts":{"max-size":"50m","max-file":"3"}}' > /etc/docker/daemon.json
systemctl enable --now docker
dev=/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_@VOL@
for _ in $(seq 120); do [ -e $dev ] && break; sleep 5; done
[ -e $dev ]
blkid $dev || mkfs.xfs $dev
uuid=$(blkid -o value -s UUID $dev)
grep -q "UUID=$uuid" /etc/fstab || echo "UUID=$uuid /srv/egpt xfs defaults,nofail 0 2" >> /etc/fstab
mkdir -p /srv/egpt
mountpoint -q /srv/egpt || mount /srv/egpt
install -d -o 1000 -g 1000 -m 755 /srv/egpt/egpt-home /srv/egpt/egpt-claude /srv/egpt/egpt-src
touch /etc/egpt-edw-node
EOF
}

# Network
VPC=$(byname describe-vpcs 'Vpcs[].VpcId' edw-vpc)
if [ -n "$VPC" ]; then log "vpc      $VPC"
else VPC=$(new vpc ec2 create-vpc --cidr-block $VPC_CIDR --tag-specifications "$(tagspec vpc edw-vpc)" --query Vpc.VpcId); fi

IGW=$(byname describe-internet-gateways 'InternetGateways[].InternetGatewayId' edw-igw)
att=
if [ -n "$IGW" ]; then
  log "igw      $IGW"
  att=$(q ec2 describe-internet-gateways --internet-gateway-ids "$IGW" --query 'InternetGateways[0].Attachments[0].VpcId')
else
  IGW=$(new igw ec2 create-internet-gateway --tag-specifications "$(tagspec internet-gateway edw-igw)" --query InternetGateway.InternetGatewayId)
fi
if [ -z "$att" ]; then run aws ec2 attach-internet-gateway --internet-gateway-id "$IGW" --vpc-id "$VPC"
elif [ "$att" != "$VPC" ]; then die "edw-igw is attached to $att, not $VPC"; fi

SUBNET=$(byname describe-subnets 'Subnets[].SubnetId' edw-public)
if [ -n "$SUBNET" ]; then
  AZ=$(q ec2 describe-subnets --subnet-ids "$SUBNET" --query 'Subnets[0].AvailabilityZone')
  log "subnet   $SUBNET ($AZ)"
else
  offered() {
    q ec2 describe-instance-type-offerings --location-type availability-zone \
      --filters "Name=instance-type,Values=$1" --query 'InstanceTypeOfferings[].Location' | tr -s '\t ' '\n' | LC_ALL=C sort
  }
  # The first AZ that also offers t3a.large, the resize target.
  AZ=$(LC_ALL=C comm -12 <(offered "$TYPE") <(offered t3a.large) | sed -n 1p)
  [ -n "$AZ" ] || die "no AZ offers both $TYPE and t3a.large"
  SUBNET=$(new subnet ec2 create-subnet --vpc-id "$VPC" --cidr-block $SUBNET_CIDR --availability-zone "$AZ" \
    --tag-specifications "$(tagspec subnet edw-public)" --query Subnet.SubnetId)
fi

RT=$(byname describe-route-tables 'RouteTables[].RouteTableId' edw-rt)
gw='' assoc=''
if [ -n "$RT" ]; then
  log "routes   $RT"
  gw=$(q ec2 describe-route-tables --route-table-ids "$RT" --query "RouteTables[0].Routes[?DestinationCidrBlock=='0.0.0.0/0'].GatewayId")
  assoc=$(q ec2 describe-route-tables --route-table-ids "$RT" --query "RouteTables[0].Associations[?SubnetId=='$SUBNET'].RouteTableAssociationId")
else
  RT=$(new rt ec2 create-route-table --vpc-id "$VPC" --tag-specifications "$(tagspec route-table edw-rt)" --query RouteTable.RouteTableId)
fi
[ -n "$gw" ] || run aws ec2 create-route --route-table-id "$RT" --destination-cidr-block 0.0.0.0/0 --gateway-id "$IGW"
[ -n "$assoc" ] || run aws ec2 associate-route-table --route-table-id "$RT" --subnet-id "$SUBNET"

SG=$(byname describe-security-groups 'SecurityGroups[].GroupId' edw-sg)
if [ -n "$SG" ]; then
  log "sg       $SG"
  [ -z "$(q ec2 describe-security-groups --group-ids "$SG" --query 'SecurityGroups[0].IpPermissions')" ] \
    || log "WARNING: edw-sg has inbound rules; it should have none"
else
  SG=$(new sg ec2 create-security-group --group-name edw-sg --description "EDW node: no inbound" --vpc-id "$VPC" \
    --tag-specifications "$(tagspec security-group edw-sg)" --query GroupId)
fi

# Instance role: SSM, ECR pull, and get/delete on the transfer prefix only.
role_new=0
if iam_has get-role --role-name $ROLE; then
  ours "$(q iam list-role-tags --role-name $ROLE --query "Tags[?Key=='Project'].Value")" "role $ROLE"
  log "role     $ROLE"
else
  run aws iam create-role --role-name $ROLE --assume-role-policy-document "$TRUST" \
    --description "EDW instance (egpt)" --tags Key=Project,Value=$PROJECT Key=Name,Value=$ROLE
  role_new=1
fi
for p in AmazonSSMManagedInstanceCore AmazonEC2ContainerRegistryReadOnly; do
  arn=arn:aws:iam::aws:policy/$p
  if [ $role_new = 1 ] || [ -z "$(q iam list-attached-role-policies --role-name $ROLE \
      --query "AttachedPolicies[?PolicyArn=='$arn'].PolicyArn")" ]; then
    run aws iam attach-role-policy --role-name $ROLE --policy-arn "$arn"
  fi
done
if [ $role_new = 1 ] || ! iam_has get-role-policy --role-name $ROLE --policy-name edw-transfer; then
  run aws iam put-role-policy --role-name $ROLE --policy-name edw-transfer --policy-document "$TRANSFER"
fi

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

# Data volume: survives the instance (attached, so DeleteOnTermination is false).
VOL=$(byname describe-volumes 'Volumes[].VolumeId' edw-data)
vatt=
if [ -n "$VOL" ]; then
  read -r vaz vatt <<<"$(q ec2 describe-volumes --volume-ids "$VOL" --query 'Volumes[0].[AvailabilityZone,Attachments[0].InstanceId]')"
  [ "$vatt" = None ] && vatt=
  [ "$vaz" = "$AZ" ] || die "edw-data is in $vaz but the subnet is in $AZ"
  log "data     $VOL ($vaz${vatt:+, attached to $vatt})"
else
  VOL=$(new data-volume ec2 create-volume --availability-zone "$AZ" --size $DATA_GB --volume-type gp3 --encrypted \
    --tag-specifications "$(tagspec volume edw-data)" --query VolumeId)
  run aws ec2 wait volume-available --volume-ids "$VOL"
fi

# Instance
INST=$(find_instance)
if [ -n "$INST" ]; then
  read -r ist itype <<<"$(q ec2 describe-instances --instance-ids "$INST" --query 'Reservations[0].Instances[0].[State.Name,InstanceType]')"
  log "instance $INST ($ist, $itype)"
  [ "$itype" = "$TYPE" ] || log "note: the instance is $itype; --type $TYPE applies only to a new instance (resize: README)"
else
  AMI=$(q ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value)
  ROOTDEV=$(q ec2 describe-images --image-ids "$AMI" --query 'Images[0].RootDeviceName')
  log "ami      $AMI (Amazon Linux 2023, root $ROOTDEV)"
  ud=$(mktemp)
  trap 'rm -f "$ud"' EXIT
  user_data "$VOL" >"$ud"
  log "user-data:"
  sed 's/^/  | /' "$ud" >&2
  if [ $prof_new = 1 ] && [ "$APPLY" = 1 ]; then log "waiting 20s for the new instance profile to reach EC2"; sleep 20; fi
  INST=$(new instance ec2 run-instances --image-id "$AMI" --instance-type "$TYPE" --count 1 \
    --iam-instance-profile Name=$IPROFILE \
    --network-interfaces "[{\"DeviceIndex\":0,\"SubnetId\":\"$SUBNET\",\"Groups\":[\"$SG\"],\"AssociatePublicIpAddress\":true}]" \
    --metadata-options HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=1 \
    --block-device-mappings "[{\"DeviceName\":\"$ROOTDEV\",\"Ebs\":{\"VolumeSize\":$ROOT_GB,\"VolumeType\":\"gp3\",\"Encrypted\":true,\"DeleteOnTermination\":true}}]" \
    --user-data "file://$ud" \
    --tag-specifications "$(tagspec instance edw-node)" "$(tagspec volume edw-root)" \
    --query 'Instances[0].InstanceId')
  run aws ec2 wait instance-running --instance-ids "$INST"
fi

if [ -z "$vatt" ]; then run aws ec2 attach-volume --volume-id "$VOL" --instance-id "$INST" --device /dev/sdf
elif [ "$vatt" != "$INST" ]; then die "edw-data is attached to $vatt, not $INST"; fi

if is_new "$INST"; then
  log "would launch $TYPE in $AZ; ids and IPs are known after --apply"
else
  q ec2 describe-instances --instance-ids "$INST" --query \
    'Reservations[0].Instances[0].[InstanceId,InstanceType,State.Name,Placement.AvailabilityZone,PrivateIpAddress,PublicIpAddress]' |
    awk -F'\t' '{printf "instance %s (%s, %s)\naz       %s\nprivate  %s\npublic   %s\n", $1, $2, $3, $4, $5, $6}'
fi
