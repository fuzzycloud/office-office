#!/usr/bin/env bats
# Bats runs each test in its own process; these exported values are intentional.
# shellcheck disable=SC2030,SC2031

setup() {
  export TEST_ROOT
  TEST_ROOT=$(mktemp -d)
  mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/data"
  export PATH="$TEST_ROOT/bin:$PATH"
  export OFFICE_DATABASE_PATH="$TEST_ROOT/data/office.sqlite3"
  export OFFICE_LITESTREAM_CONFIG="$TEST_ROOT/litestream.yml"
  export OFFICE_LITESTREAM_ENABLED=true
  export OFFICE_BACKUP_BUCKET=office-backups
  export OFFICE_BACKUP_PREFIX=office/test
  export AWS_REGION=us-east-1
  export OFFICE_ALLOW_NEW_DATABASE=false
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY OFFICE_DEMO_MODE RESTORE_MODE
  : > "$OFFICE_LITESTREAM_CONFIG"

  cat > "$TEST_ROOT/bin/litestream" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case $1 in
  restore)
    printf '%s\n' "$@" > "$TEST_ROOT/restore.args"
    output=''
    while [[ $# -gt 0 ]]; do
      if [[ $1 == -o ]]; then output=$2; shift 2; else shift; fi
    done
    case ${RESTORE_MODE:-empty} in
      restored) printf 'SQLite format 3\000backup' > "$output" ;;
      collision)
        printf 'SQLite format 3\000backup' > "$output"
        printf 'newer local database' > "$OFFICE_DATABASE_PATH"
        ;;
      error) exit 17 ;;
      zero) : > "$output" ;;
      empty) ;;
    esac
    ;;
  replicate)
    printf '%s\n' "$@" > "$TEST_ROOT/replicate.args"
    shift
    while [[ $1 != -exec ]]; do shift; done
    shift
    exec "$@"
    ;;
  version) printf 'version\n' > "$TEST_ROOT/custom-command" ;;
esac
EOF
  cat > "$TEST_ROOT/bin/office-server" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$TEST_ROOT/server.args"
printf 'server started\n'
EOF
  chmod +x "$TEST_ROOT/bin/litestream" "$TEST_ROOT/bin/office-server"
  ENTRYPOINT="$BATS_TEST_DIRNAME/../../deploy/entrypoint.sh"
}

teardown() {
  rm -rf -- "$TEST_ROOT"
}

@test "disabled mode launches without backup settings" {
  export OFFICE_LITESTREAM_ENABLED=false
  unset OFFICE_BACKUP_BUCKET OFFICE_BACKUP_PREFIX AWS_REGION
  run "$ENTRYPOINT" office-server --listen localhost
  [ "$status" -eq 0 ]
  [ "$output" = 'server started' ]
  [ "$(< "$TEST_ROOT/server.args")" = '--listen
localhost' ]
  [ ! -e "$TEST_ROOT/restore.args" ]
  [ ! -e "$TEST_ROOT/replicate.args" ]
}

@test "existing database is never restored" {
  printf 'existing database' > "$OFFICE_DATABASE_PATH"
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  [ "$(< "$OFFICE_DATABASE_PATH")" = 'existing database' ]
  [ ! -e "$TEST_ROOT/restore.args" ]
  [ -e "$TEST_ROOT/replicate.args" ]
}

@test "missing database is restored then replicated" {
  export RESTORE_MODE=restored
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  [ -s "$OFFICE_DATABASE_PATH" ]
  [ -e "$TEST_ROOT/restore.args" ]
  [ -e "$TEST_ROOT/replicate.args" ]
  [[ $(< "$TEST_ROOT/restore.args") == *'-if-replica-exists'* ]]
  [[ $(< "$TEST_ROOT/restore.args") == *'-integrity-check
quick'* ]]
  [[ $(< "$TEST_ROOT/restore.args") == *"$OFFICE_DATABASE_PATH" ]]
  [[ $(< "$TEST_ROOT/replicate.args") == *'-exec
office-server' ]]
  [ "$(stat -c %a "$OFFICE_DATABASE_PATH")" = 600 ]
  [ -z "$(find "$TEST_ROOT/data" -name '.office-restore.*' -print)" ]
}

@test "fresh office requires an explicit flag when no replica exists" {
  run "$ENTRYPOINT"
  [ "$status" -ne 0 ]
  [ ! -e "$OFFICE_DATABASE_PATH" ]
  [ ! -e "$TEST_ROOT/replicate.args" ]

  export OFFICE_ALLOW_NEW_DATABASE=true
  run "$ENTRYPOINT"
  [ "$status" -eq 0 ]
  [ -e "$TEST_ROOT/replicate.args" ]
}

@test "restore errors remain fatal even when fresh startup is allowed" {
  export OFFICE_ALLOW_NEW_DATABASE=true RESTORE_MODE=error
  run "$ENTRYPOINT"
  [ "$status" -ne 0 ]
  [ ! -e "$OFFICE_DATABASE_PATH" ]
  [ ! -e "$TEST_ROOT/replicate.args" ]
}

@test "zero-byte restore output is fatal even when fresh startup is allowed" {
  export OFFICE_ALLOW_NEW_DATABASE=true RESTORE_MODE=zero
  run "$ENTRYPOINT"
  [ "$status" -ne 0 ]
  [ ! -e "$OFFICE_DATABASE_PATH" ]
  [ ! -e "$TEST_ROOT/replicate.args" ]
}

@test "invalid or partial configuration is rejected before Litestream starts" {
  export OFFICE_LITESTREAM_ENABLED=maybe
  run "$ENTRYPOINT"
  [ "$status" -ne 0 ]

  export OFFICE_LITESTREAM_ENABLED=true
  unset OFFICE_BACKUP_BUCKET
  run "$ENTRYPOINT"
  [ "$status" -ne 0 ]

  export OFFICE_BACKUP_BUCKET=office-backups AWS_ACCESS_KEY_ID=id
  run "$ENTRYPOINT"
  [ "$status" -ne 0 ]

  export AWS_SECRET_ACCESS_KEY=secret OFFICE_LITESTREAM_CONFIG="$TEST_ROOT/missing.yml"
  run "$ENTRYPOINT"
  [ "$status" -ne 0 ]
  [ ! -e "$TEST_ROOT/restore.args" ]
}

@test "demo mode and relative database paths are rejected" {
  export OFFICE_DEMO_MODE=true
  run "$ENTRYPOINT"
  [ "$status" -ne 0 ]
  unset OFFICE_DEMO_MODE

  export OFFICE_DATABASE_PATH=relative.sqlite3
  run "$ENTRYPOINT"
  [ "$status" -ne 0 ]
  [ ! -e "$TEST_ROOT/restore.args" ]
}

@test "stale SQLite sidecars prevent a missing database restore" {
  : > "${OFFICE_DATABASE_PATH}-wal"
  run "$ENTRYPOINT"
  [ "$status" -ne 0 ]
  [ ! -e "$TEST_ROOT/restore.args" ]
}

@test "a concurrently created database cannot be overwritten" {
  export RESTORE_MODE=collision
  run "$ENTRYPOINT"
  [ "$status" -ne 0 ]
  [ "$(< "$OFFICE_DATABASE_PATH")" = 'newer local database' ]
  [ ! -e "$TEST_ROOT/replicate.args" ]
}

@test "custom command passes through and server arguments are rejected in enabled mode" {
  run "$ENTRYPOINT" litestream version
  [ "$status" -eq 0 ]
  [ -e "$TEST_ROOT/custom-command" ]
  [ ! -e "$TEST_ROOT/restore.args" ]

  run "$ENTRYPOINT" office-server --listen localhost
  [ "$status" -ne 0 ]
  [ ! -e "$TEST_ROOT/restore.args" ]
  [ ! -e "$TEST_ROOT/replicate.args" ]
}
