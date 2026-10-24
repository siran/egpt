# shellcheck shell=bash disable=SC2034
# Shared by the laptop-side scripts in docker/aws (sourced, not run).
# Everything they create carries Project=egpt-edw and is looked up by that tag.

PROJECT=egpt-edw
ACCOUNT=331665579468   # EduWeb; any other account is refused
export AWS_PROFILE=${AWS_PROFILE:-eduweb}
export AWS_DEFAULT_REGION=us-east-1
REGISTRY=$ACCOUNT.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com
BUCKET=egpt-edw-transfer-$ACCOUNT
PREFIX=migrate/
TAGF="Name=tag:Project,Values=$PROJECT"
APPLY=0

log() { echo "$*" >&2; }
die() { echo "ERROR: $*" >&2; exit 1; }

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

tagspec() { echo "ResourceType=$1,Tags=[{Key=Project,Value=$PROJECT},{Key=Name,Value=$2}]"; }

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

# The EDW instance (pending/running/stopping/stopped), or empty.
find_instance() {
  one instance "$(q ec2 describe-instances --filters "$TAGF" Name=tag:Name,Values=edw-node \
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
    --comment "egpt-edw $(basename "$dest") ${1:-}" --parameters "$params" --query Command.CommandId)
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
