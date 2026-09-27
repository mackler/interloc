#!/usr/bin/env bats
# The committed bin/ilcli is what bashly generates from bin/ilcli.bashly/: a source edited without
# `npm run generate:cli` fails here.

load helpers

@test "bashly generates a script identical to the committed bin/ilcli" {
  cd "$REPO_ROOT"
  mkdir -p "$BATS_TEST_TMPDIR/out"
  BASHLY_TARGET_DIR="$BATS_TEST_TMPDIR/out" BASHLY_SETTINGS_PATH=bin/ilcli.bashly/settings.yml run bashly generate --quiet
  [ "$status" -eq 0 ]
  cmp "$BATS_TEST_TMPDIR/out/ilcli" "$REPO_ROOT/bin/ilcli"
}
