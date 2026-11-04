# shellcheck shell=bash disable=SC2034
# Shared by the laptop-side scripts in docker/aws (sourced, not run).
# The deployment is <name>.env, picked with --deploy <name> (default $EGPT_AWS_DEPLOY), in
# $EGPT_AWS_DEPLOYMENTS (default ~/.egpt/config/aws-deployments, outside the repo), else in
# deployments/ here (example.env); this takes --deploy out of the caller's arguments.
# Everything a deployment creates carries its Project tag and is looked up by that tag.

log() { echo "$*" >&2; }
die() { echo "ERROR: $*" >&2; exit 1; }

DEPLOY=${EGPT_AWS_DEPLOY:-} _args=()
while [ $# -gt 0 ]; do
  case $1 in
    --deploy) [ $# -ge 2 ] || die "--deploy needs a name"; DEPLOY=$2; shift ;;
    *) _args+=("$1") ;;
  esac
  shift
done
set -- "${_args[@]}"
DEPLOYMENTS=${EGPT_AWS_DEPLOYMENTS:-${EGPT_HOME:-$HOME/.egpt}/config/aws-deployments}
[ -n "$DEPLOY" ] || die "no deployment: pass --deploy <name> or set EGPT_AWS_DEPLOY (looked for $DEPLOYMENTS/<name>.env)"
DEPLOY_ENV=$DEPLOYMENTS/$DEPLOY.env
[ -f "$DEPLOY_ENV" ] || DEPLOY_ENV=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deployments/$DEPLOY.env
[[ $DEPLOY =~ ^[a-z0-9-]+$ && -f $DEPLOY_ENV ]] \
  || die "no deployment '$DEPLOY' ($DEPLOYMENTS/$DEPLOY.env, docker/aws/deployments/$DEPLOY.env)"
SSH_PORT=                    # default; a deployment may set it: sshd in the container, an EIP, tcp $SSH_PORT open
SSH_PERMIT_LISTEN=           # default; with SSH_PORT: "host:port ..." that reverse forwards (ssh -R) may listen on
# shellcheck source=deployments/example.env
. "$DEPLOY_ENV"

export AWS_PROFILE=${AWS_PROFILE:-$PROFILE}
export AWS_DEFAULT_REGION=$REGION
REGISTRY=$ACCOUNT.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com
DATA=$N-data                 # the data volume's Name
PREFIX=migrate/
TAGF="Name=tag:Project,Values=$PROJECT"
APPLY=0

# Prints a command line, quoting the args that need it.
show() {
  local a out=
  for a; do
    if [[ $a == *"'"* ]]; then a=$(printf '%q' "$a")
    elif [[ -z $a || $a =~ [^A-Za-z0-9_./:=,@+%-] ]]; then a="'$a'"; fi
    out+="$a "
  done
  echo "${out% }"
}

# run CMD...: runs CMD with --apply, otherwise only prints it.
run() {
  if [ "$APPLY" = 1 ]; then log "+ $(show "$@")"; "$@"; else log "[dry] $(show "$@")"; fi
}

# aws with text output; v1 prints "None" for an empty result.
q() {
  local out
  out=$(aws "$@" --output text) || return
  [ "$out" = None ] && out=
  printf '%s' "$out"
}

# new LABEL AWS-ARGS...: an aws create call that prints the new id; a dry run prints <new-LABEL>.
new() {
  local label=$1; shift
  if [ "$APPLY" = 1 ]; then log "+ aws $(show "$@")"; q "$@"
  else log "[dry] aws $(show "$@")"; echo "<new-$label>"; fi
}

is_new() { [[ $1 == '<new-'* ]]; }

# one LABEL IDS: IDS (a flat id list) must hold at most one id.
one() {
  [ "$(wc -w <<<"$2")" -le 1 ] || die "more than one $1 tagged $PROJECT: $(tr -s '\t\n' ' ' <<<"$2")"
  printf '%s' "$2"
}

tagspec() { echo "ResourceType=$1,Tags=[{Key=Project,Value=$PROJECT},{Key=Name,Value=$2}${3:+,$3}]"; }  # type name [{Key=K,Value=V}]

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

# Instance roles: EC2 may assume them; the transfer policy gets/deletes under the bucket's prefix only.
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
TRANSFER=
[ -z "$BUCKET" ] || TRANSFER='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:DeleteObject"],"Resource":"arn:aws:s3:::'$BUCKET/$PREFIX'*"}]}'

offered() {  # instance type: the AZs that offer it, sorted
  q ec2 describe-instance-type-offerings --location-type availability-zone \
    --filters "Name=instance-type,Values=$1" --query 'InstanceTypeOfferings[].Location' | tr -s '\t ' '\n' | LC_ALL=C sort
}

# ensure_network TYPE...: the deployment's VPC (one public subnet, internet gateway, no NAT) and a
# security group with no inbound rules (with SSH_PORT: tcp $SSH_PORT from anywhere, only);
# a new subnet goes in the first AZ offering every TYPE.
# Sets VPC IGW SUBNET AZ RT SG.
ensure_network() {
  local att='' gw='' assoc='' azs t rules='' ssh_in='' ssh="tcp $SSH_PORT $SSH_PORT 0.0.0.0/0"
  VPC=$(byname describe-vpcs 'Vpcs[].VpcId' "$N-vpc")
  if [ -n "$VPC" ]; then log "vpc      $VPC"
  else VPC=$(new vpc ec2 create-vpc --cidr-block "$VPC_CIDR" --tag-specifications "$(tagspec vpc "$N-vpc")" --query Vpc.VpcId); fi

  IGW=$(byname describe-internet-gateways 'InternetGateways[].InternetGatewayId' "$N-igw")
  if [ -n "$IGW" ]; then
    log "igw      $IGW"
    att=$(q ec2 describe-internet-gateways --internet-gateway-ids "$IGW" --query 'InternetGateways[0].Attachments[0].VpcId')
  else
    IGW=$(new igw ec2 create-internet-gateway --tag-specifications "$(tagspec internet-gateway "$N-igw")" --query InternetGateway.InternetGatewayId)
  fi
  if [ -z "$att" ]; then run aws ec2 attach-internet-gateway --internet-gateway-id "$IGW" --vpc-id "$VPC"
  elif [ "$att" != "$VPC" ]; then die "$N-igw is attached to $att, not $VPC"; fi

  SUBNET=$(byname describe-subnets 'Subnets[].SubnetId' "$N-public")
  if [ -n "$SUBNET" ]; then
    AZ=$(q ec2 describe-subnets --subnet-ids "$SUBNET" --query 'Subnets[0].AvailabilityZone')
    log "subnet   $SUBNET ($AZ)"
  else
    azs=$(offered "$1")
    for t in "${@:2}"; do azs=$(LC_ALL=C comm -12 <(printf '%s\n' "$azs") <(offered "$t")); done
    AZ=$(sed -n 1p <<<"$azs")
    [ -n "$AZ" ] || die "no AZ offers all of: $*"
    SUBNET=$(new subnet ec2 create-subnet --vpc-id "$VPC" --cidr-block "$SUBNET_CIDR" --availability-zone "$AZ" \
      --tag-specifications "$(tagspec subnet "$N-public")" --query Subnet.SubnetId)
  fi

  RT=$(byname describe-route-tables 'RouteTables[].RouteTableId' "$N-rt")
  if [ -n "$RT" ]; then
    log "routes   $RT"
    gw=$(q ec2 describe-route-tables --route-table-ids "$RT" --query "RouteTables[0].Routes[?DestinationCidrBlock=='0.0.0.0/0'].GatewayId")
    assoc=$(q ec2 describe-route-tables --route-table-ids "$RT" --query "RouteTables[0].Associations[?SubnetId=='$SUBNET'].RouteTableAssociationId")
  else
    RT=$(new rt ec2 create-route-table --vpc-id "$VPC" --tag-specifications "$(tagspec route-table "$N-rt")" --query RouteTable.RouteTableId)
  fi
  [ -n "$gw" ] || run aws ec2 create-route --route-table-id "$RT" --destination-cidr-block 0.0.0.0/0 --gateway-id "$IGW"
  [ -n "$assoc" ] || run aws ec2 associate-route-table --route-table-id "$RT" --subnet-id "$SUBNET"

  SG=$(byname describe-security-groups 'SecurityGroups[].GroupId' "$N-sg")
  if [ -n "$SG" ]; then
    log "sg       $SG"
    if [ -z "$SSH_PORT" ]; then
      [ -z "$(q ec2 describe-security-groups --group-ids "$SG" --query 'SecurityGroups[0].IpPermissions')" ] \
        || log "WARNING: $N-sg has inbound rules; it should have none"
    else
      rules=$(q ec2 describe-security-group-rules --filters "Name=group-id,Values=$SG" \
        --query 'SecurityGroupRules[?!IsEgress].[IpProtocol,FromPort,ToPort,CidrIpv4]' | tr '\t' ' ')
      if grep -qxF "$ssh" <<<"$rules"; then ssh_in=1; log "ssh      $N-sg allows $ssh"; fi
      [ -z "$(grep -vxF "$ssh" <<<"$rules")" ] || log "WARNING: $N-sg has inbound rules besides $ssh; it should have none"
    fi
  else
    SG=$(new sg ec2 create-security-group --group-name "$N-sg" --description "$LABEL node: no inbound" --vpc-id "$VPC" \
      --tag-specifications "$(tagspec security-group "$N-sg")" --query GroupId)
  fi
  [ -z "$SSH_PORT" ] || [ -n "$ssh_in" ] || run aws ec2 authorize-security-group-ingress --group-id "$SG" \
    --protocol tcp --port "$SSH_PORT" --cidr 0.0.0.0/0 --tag-specifications "$(tagspec security-group-rule "$N-ssh")" \
    --query 'SecurityGroupRules[0].SecurityGroupRuleId'
}

parse_apply() {  # for scripts whose only flag is --apply
  for a; do
    case $a in --apply) APPLY=1 ;; *) die "unknown argument: $a (only --apply)" ;; esac
  done
}

check_account() {
  local a
  a=$(q sts get-caller-identity --query Account) || die "aws sts failed (profile $AWS_PROFILE)"
  [ "$a" = "$ACCOUNT" ] || die "profile $AWS_PROFILE is account $a, expected $ACCOUNT"
  if [ "$APPLY" = 1 ]; then log "account $a ($AWS_PROFILE, $AWS_DEFAULT_REGION) - APPLY"
  else log "account $a ($AWS_PROFILE, $AWS_DEFAULT_REGION) - DRY RUN, nothing changes (add --apply)"; fi
}

# provision.sh, migrate.sh and run.sh drive the plain-EC2 host, LEGACY_NODE; a deployment without one is refused.
legacy_only() {
  [ -n "$LEGACY_NODE" ] || die "$(basename "$0") is the plain-EC2 path; deployment $DEPLOY has none (use ecs/)"
}

# The plain-EC2 instance LEGACY_NODE (pending/running/stopping/stopped), or empty.
find_instance() {
  [ -n "$LEGACY_NODE" ] || return 0
  one instance "$(q ec2 describe-instances --filters "$TAGF" "Name=tag:Name,Values=$LEGACY_NODE" \
    Name=instance-state-name,Values=pending,running,stopping,stopped \
    --query 'Reservations[].Instances[].InstanceId')"
}

ssm_online() {
  [ "$(q ssm describe-instance-information --filters "Key=InstanceIds,Values=$1" \
    --query 'InstanceInformationList[0].PingStatus')" = Online ]
}

# ssm_send INSTANCE FILE DEST ARGS...: writes FILE to DEST on the instance, runs it there
# as root with ARGS, prints its output. Fails unless the command succeeds.
ssm_send() {
  local id=$1 file=$2 dest=$3; shift 3
  local cmd params cid st=Pending
  cmd="echo $(base64 -w0 "$file") | base64 -d > $dest && bash $dest $*"
  params=$(jq -nc --arg c "$cmd" '{commands: [$c], executionTimeout: ["3600"]}')
  cid=$(q ssm send-command --instance-ids "$id" --document-name AWS-RunShellScript \
    --comment "$PROJECT $(basename "$dest") ${1:-}" --parameters "$params" --query Command.CommandId)
  log "ssm command $cid on $id: bash $dest $*"
  for _ in $(seq 720); do
    sleep 5
    st=$(q ssm get-command-invocation --command-id "$cid" --instance-id "$id" --query Status 2>/dev/null) || st=Pending
    case $st in Pending|InProgress|Delayed) ;; *) break ;; esac
  done
  q ssm get-command-invocation --command-id "$cid" --instance-id "$id" --query StandardOutputContent; echo
  q ssm get-command-invocation --command-id "$cid" --instance-id "$id" --query StandardErrorContent >&2; echo >&2
  log "ssm status: $st"
  [ "$st" = Success ]
}
