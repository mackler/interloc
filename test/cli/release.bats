#!/usr/bin/env bats
# bin/ilcli release, in a development clone of a temporary origin: it pushes main or refuses without pushing.

load helpers

setup() {
  common_setup
  make_origin
  clone_dev
}

release() { run "$T/dev/bin/ilcli" release; }

@test "a clean main that is ahead is pushed, and the output names the commits and the route" {
  commit_in "$T/dev" "Add the feature"
  release
  [ "$status" -eq 0 ]
  [ "$(head_of "$T/origin.git" main)" = "$(head_of "$T/dev")" ]
  [[ "$output" == *"Add the feature"* ]]
  [[ "$output" == *"CI"* ]]
  [[ "$output" == *"release"* ]]
  [[ "$output" == *"$(git -C "$T/dev" rev-parse --short HEAD)"* ]]
  [[ "$output" == *"bin/ilcli upgrade"* ]]
}

@test "a modified tracked file is refused and nothing is pushed" {
  commit_in "$T/dev" "Add the feature"
  echo change >> "$T/dev/.gitignore"
  local before
  before="$(head_of "$T/origin.git" main)"
  release
  [ "$status" -ne 0 ]
  [[ "$output" == *"refused"* ]]
  [[ "$output" == *".gitignore"* ]]
  [ "$(head_of "$T/origin.git" main)" = "$before" ]
}

@test "an untracked file is refused" {
  commit_in "$T/dev" "Add the feature"
  touch "$T/dev/new.txt"
  release
  [ "$status" -ne 0 ]
  [[ "$output" == *"new.txt"* ]]
}

@test "a branch other than main is refused, naming it" {
  git -C "$T/dev" switch -q -c feature
  commit_in "$T/dev" "Add the feature"
  release
  [ "$status" -ne 0 ]
  [[ "$output" == *"feature"* ]]
  [[ "$output" == *"main"* ]]
}

@test "a main behind origin/main is refused" {
  advance main "Someone else's change"
  release
  [ "$status" -ne 0 ]
  [[ "$output" == *"refused"* ]]
  [[ "$output" == *"origin/main"* ]]
}

@test "a main diverged from origin/main is refused and nothing is pushed" {
  advance main "Someone else's change"
  local before
  before="$(head_of "$T/origin.git" main)"
  commit_in "$T/dev" "My change"
  release
  [ "$status" -ne 0 ]
  [[ "$output" == *"diverged"* ]]
  [ "$(head_of "$T/origin.git" main)" = "$before" ]
}

@test "a main equal to origin/main has nothing to publish and exits 0" {
  release
  [ "$status" -eq 0 ]
  [[ "$output" == *"nothing to publish"* ]]
}

@test "an unreachable origin is refused with nothing pushed" {
  commit_in "$T/dev" "Add the feature"
  git -C "$T/dev" remote set-url origin "$T/missing.git"
  release
  [ "$status" -ne 0 ]
  [[ "$output" == *"nothing was pushed"* ]]
}
