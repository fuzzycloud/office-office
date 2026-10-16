#!/usr/bin/env bash
set -Eeuo pipefail

die() {
  printf 'office-office: %s\n' "$1" >&2
  exit 1
}

[[ $# -gt 0 ]] || set -- office-server
[[ $1 == office-server ]] || exec "$@"

case ${OFFICE_LITESTREAM_ENABLED:-false} in
  false) exec "$@" ;;
  true) ;;
  *) die 'OFFICE_LITESTREAM_ENABLED must be true or false' ;;
esac

[[ $# -eq 1 ]] || die 'office-server arguments are unsupported with Litestream enabled'
[[ ${OFFICE_DEMO_MODE:-false} != true ]] || die 'Litestream requires durable storage; disable OFFICE_DEMO_MODE'

database=${OFFICE_DATABASE_PATH:-/data/office-office.sqlite3}
[[ $database == /* && $database != */ ]] || die 'OFFICE_DATABASE_PATH must be an absolute file path'
export OFFICE_DATABASE_PATH=$database

for name in OFFICE_BACKUP_BUCKET OFFICE_BACKUP_PREFIX AWS_REGION; do
  [[ -n ${!name:-} ]] || die "$name is required with Litestream enabled"
done
if [[ -n ${AWS_ACCESS_KEY_ID:-} || -n ${AWS_SECRET_ACCESS_KEY:-} ]]; then
  [[ -n ${AWS_ACCESS_KEY_ID:-} && -n ${AWS_SECRET_ACCESS_KEY:-} ]] ||
    die 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together'
fi

case ${OFFICE_ALLOW_NEW_DATABASE:-false} in
  true|false) ;;
  *) die 'OFFICE_ALLOW_NEW_DATABASE must be true or false' ;;
esac

config=${OFFICE_LITESTREAM_CONFIG:-/etc/office-office/litestream.yml}
[[ -f $config && -r $config ]] || die 'OFFICE_LITESTREAM_CONFIG must name a readable file'
[[ ! -L $database ]] || die 'database path must not be a symlink'
[[ ! -e $database || -f $database ]] || die 'database path must be a regular file'

restore_dir=''
cleanup() {
  if [[ -n $restore_dir ]]; then
    rm -rf -- "$restore_dir"
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ ! -e $database ]]; then
  [[ ! -e ${database}-wal && ! -L ${database}-wal && ! -e ${database}-shm && ! -L ${database}-shm ]] ||
    die 'database is missing but a WAL or SHM file remains'

  database_dir=${database%/*}
  [[ -n $database_dir ]] || database_dir=/
  [[ -d $database_dir ]] || die 'database directory does not exist'
  restore_dir=$(mktemp -d "$database_dir/.office-restore.XXXXXXXX") || die 'cannot create restore directory'
  chmod 0700 "$restore_dir"
  restored_database=$restore_dir/office-office.sqlite3

  if ! litestream restore -config "$config" -if-replica-exists -integrity-check quick \
    -o "$restored_database" "$database"; then
    die 'Litestream restore failed'
  fi

  if [[ -e $restored_database || -L $restored_database ]]; then
    [[ -f $restored_database && ! -L $restored_database && -s $restored_database ]] ||
      die 'restore did not create a nonempty regular database file'
    chmod 0600 "$restored_database"
    # A hard link publishes the restored file atomically and cannot replace a file
    # another process created during the restore.
    ln -- "$restored_database" "$database" || die 'database appeared during restore or could not be promoted'
  elif [[ ${OFFICE_ALLOW_NEW_DATABASE:-false} != true ]]; then
    die 'no backup was found; set OFFICE_ALLOW_NEW_DATABASE=true for a new office'
  fi

  cleanup
  restore_dir=''
fi

exec litestream replicate -config "$config" -exec office-server
