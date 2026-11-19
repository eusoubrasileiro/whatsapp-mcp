#!/bin/sh
# Container entrypoint: the server and the hub run as the unprivileged user `wamcp`, never root.
#
# Started as root (the default), it first hands the data directory to that user, then drops to
# it for good. A volume written by an older root build is root-owned, and a pairing the app can
# no longer read is a pairing it replaces with a new QR code, so the ownership is fixed here
# rather than left to an operator step.
#
# - Only entries not already owned by the user are changed, so after the first start this
#   changes nothing.
# - `minio/` is the number's media store, written by the store container as its own user (uid
#   10001); it is never touched.
# - find does not follow symlinks and `chown -h` changes a link itself, so a link placed in the
#   data directory cannot point the chown at anything outside it.
#
# Started as a non-root user already (`docker run --user`), it changes nothing and just runs.
set -eu

APP_UID=10010
APP_GID=10010

hand_over() {
  dir=${1%/}
  [ -n "$dir" ] && [ -d "$dir" ] || return 0
  find "$dir" -path "$dir/minio" -prune -o \
    \( ! -user "$APP_UID" -o ! -group "$APP_GID" \) -exec chown -h "$APP_UID:$APP_GID" {} +
}

if [ "$(id -u)" = "0" ]; then
  hand_over "${WHATSAPP_MCP_DATA_DIR:-/data}"
  hand_over "${HUB_STATE_DIR:-}"
  exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --clear-groups --no-new-privs \
    -- /usr/bin/tini -- "$@"
fi

exec /usr/bin/tini -- "$@"
