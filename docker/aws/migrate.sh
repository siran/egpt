#!/bin/bash
# migrate.sh [--apply]
# Cutover: moves EDW's state (volumes egpt-home and egpt-claude) from the laptop to the AWS
# instance through a private, encrypted S3 bucket. The tars hold secrets: never printed,
# deleted from S3 as soon as the instance has them. The local edw container is stopped and
# kept, volumes untouched, as the fallback.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
parse_apply "$@"
check_account

VOLS=(egpt-home egpt-claude)
REMOTE=$(mktemp)
LOCAL_TMP=$(mktemp -d)
UPLOADED=0 STOPPED=0 DONE=0

cleanup() {
  rm -rf "$LOCAL_TMP" "$REMOTE"
  if [ $UPLOADED = 1 ] && [ $DONE = 0 ]; then
    aws s3 rm --only-show-errors --recursive "s3://$BUCKET/$PREFIX" \
      || log "WARNING: could not delete s3://$BUCKET/$PREFIX (the lifecycle rule expires it in a day)"
  fi
  if [ $STOPPED = 1 ] && [ $DONE = 0 ]; then
    log "local edw is stopped. To fall back: docker update --restart unless-stopped edw && docker start edw"
  fi
}
trap cleanup EXIT

# Instance side, as root over SSM: "check", or "fetch BUCKET PREFIX SHA256-HOME SHA256-CLAUDE".
cat >"$REMOTE" <<'EOF'
#!/bin/bash
set -euo pipefail
mountpoint -q /srv/egpt || { echo "/srv/egpt is not mounted"; exit 1; }
[ -z "$(docker ps -aq --filter name=^edw$)" ] || { echo "a container edw exists here; migrate goes before run.sh"; exit 1; }
for v in egpt-home egpt-claude; do
  [ -d /srv/egpt/$v ] || { echo "missing /srv/egpt/$v"; exit 1; }
  [ -z "$(ls -A /srv/egpt/$v)" ] || { echo "/srv/egpt/$v is not empty; not overwriting it"; exit 1; }
done
if [ "$1" = check ]; then echo "instance ready: targets empty, no edw container"; exit 0; fi
bucket=$2 prefix=$3
shift 3
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for v in egpt-home egpt-claude; do
  aws s3 cp --only-show-errors --region us-east-1 "s3://$bucket/$prefix$v.tgz" "$tmp/$v.tgz"
  aws s3 rm --only-show-errors --region us-east-1 "s3://$bucket/$prefix$v.tgz"
  echo "$1  $tmp/$v.tgz" | sha256sum -c --quiet
  shift
  tar -xzpf "$tmp/$v.tgz" --numeric-owner -C /srv/egpt/$v
  echo "$v: $(find /srv/egpt/$v | wc -l) entries, $(du -sh /srv/egpt/$v | cut -f1)"
done
stat -c '%a %u:%g %n' /srv/egpt/egpt-home /srv/egpt/egpt-home/secrets /srv/egpt/egpt-home/secrets/* \
  /srv/egpt/egpt-claude/.credentials.json || true
EOF

remote() {
  if [ "$APPLY" = 1 ]; then ssm_send "$INST" "$REMOTE" /root/edw-migrate.sh "$@"
  else log "[dry] on ${INST:-<the edw-node instance>} over SSM, as root: bash /root/edw-migrate.sh $*"; fi
}

bucket_state() {
  local err
  if err=$(aws s3api head-bucket --bucket "$BUCKET" 2>&1); then
    [ "$(q s3api get-bucket-tagging --bucket "$BUCKET" --query "TagSet[?Key=='Project'].Value" 2>/dev/null)" = "$PROJECT" ] \
      || die "bucket $BUCKET exists but is not tagged Project=$PROJECT"
    echo exists
  elif grep -q 'Not Found' <<<"$err"; then echo missing
  else die "bucket $BUCKET: $err"; fi
}

# Preflight, read-only.
docker inspect edw >/dev/null 2>&1 || die "no local container edw"
IMG=$(docker inspect -f '{{.Config.Image}}' edw)
STATE=$(docker inspect -f '{{.State.Status}}' edw)
log "local    edw $STATE ($IMG)"
for v in "${VOLS[@]}"; do docker volume inspect "$v" >/dev/null || die "no local volume $v"; done
docker system df -v | awk '$1 == "egpt-home" || $1 == "egpt-claude" { print "volume   " $1 " " $3 }' >&2
if [ "$STATE" = running ]; then
  log "checkout $(docker exec edw git --no-optional-locks -C /home/egpt/src/egpt status -sb | sed -n 1p)," \
    "$(docker exec edw git --no-optional-locks -C /home/egpt/src/egpt status --porcelain | wc -l) uncommitted (AWS clones origin/edw fresh)"
fi
INST=$(find_instance)
ONLINE=no
if [ -n "$INST" ]; then ssm_online "$INST" && ONLINE=yes; log "instance $INST (ssm online: $ONLINE)"
else log "instance none yet (provision.sh)"; fi
BSTATE=$(bucket_state)
log "bucket   $BUCKET ($BSTATE)"
log "instance-side script, /root/edw-migrate.sh:"
sed 's/^/  | /' "$REMOTE" >&2

if [ "$APPLY" = 1 ]; then
  [ -n "$INST" ] || die "no instance tagged $PROJECT/edw-node (provision.sh --apply)"
  [ $ONLINE = yes ] || die "$INST is not online in SSM"
fi
remote check

# One poller per bot token: the local container stops before anything is copied.
run docker update --restart=no edw
run docker stop edw
[ "$APPLY" = 0 ] || STOPPED=1

# claude keeps ~/.claude.json (account, settings) outside its folder unless CLAUDE_CONFIG_DIR says
# otherwise; the image now sets CLAUDE_CONFIG_DIR=~/.claude, so the file travels inside egpt-claude.
run docker cp edw:/home/egpt/.claude.json "$LOCAL_TMP/claude.json"
run docker run --rm --user 0 --entrypoint sh -v egpt-claude:/v -v "$LOCAL_TMP:/in:ro" "$IMG" \
  -c "[ -e /v/.claude.json ] || { cp /in/claude.json /v/.claude.json && chown 1000:1000 /v/.claude.json && chmod 600 /v/.claude.json; }"

SUMS=()
for v in "${VOLS[@]}"; do
  run docker run --rm --user 0 --entrypoint sh -v "$v:/v:ro" -v "$LOCAL_TMP:/out" "$IMG" \
    -c "umask 077 && tar --numeric-owner -C /v -czf /out/$v.tgz . && chown $(id -u):$(id -g) /out/$v.tgz"
  if [ "$APPLY" = 1 ]; then SUMS+=("$(sha256sum "$LOCAL_TMP/$v.tgz" | cut -d' ' -f1)")
  else SUMS+=("<sha256-of-$v.tgz>"); fi
done

if [ "$BSTATE" = missing ]; then
  run aws s3api create-bucket --bucket "$BUCKET"
  run aws s3api put-bucket-tagging --bucket "$BUCKET" \
    --tagging '{"TagSet":[{"Key":"Project","Value":"'$PROJECT'"},{"Key":"Name","Value":"edw-transfer"}]}'
  run aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  run aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  run aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration \
    '{"Rules":[{"ID":"expire-transfer","Status":"Enabled","Filter":{"Prefix":"'$PREFIX'"},"Expiration":{"Days":1}}]}'
fi

[ "$APPLY" = 0 ] || UPLOADED=1
for v in "${VOLS[@]}"; do
  run aws s3 cp --only-show-errors --sse AES256 "$LOCAL_TMP/$v.tgz" "s3://$BUCKET/$PREFIX$v.tgz"
done
remote fetch "$BUCKET" "$PREFIX" "${SUMS[@]}"
run aws s3 rm --only-show-errors --recursive "s3://$BUCKET/$PREFIX"
if [ "$APPLY" = 1 ]; then
  DONE=1
  log "objects left under s3://$BUCKET/$PREFIX: $(q s3api list-objects-v2 --bucket "$BUCKET" --prefix "$PREFIX" --query KeyCount)"
  log "done. Next: run.sh --apply. The local edw stays stopped (restart=no), its volumes untouched."
fi
