#!/usr/bin/env bats
# The usage text of bin/ilcli documents every command, and asking for it calls no docker.

load helpers

setup() { common_setup; }

@test "help, -h and --help list every command and call no docker" {
  for form in help -h --help; do
    run "$ILCLI" $form
    [ "$status" -eq 0 ]
    for command in run shell review build down release upgrade help; do
      [[ "$output" == *"  $command "* ]] || { echo "'$form' does not list $command"; echo "$output"; return 1; }
    done
  done
  [ ! -s "$STUB_LOG" ]
}

@test "help run prints run's own usage, which names Claude Code" {
  run "$ILCLI" help run
  [ "$status" -eq 0 ]
  [[ "$output" == *"ilcli run"* ]]
  [[ "$output" == *"Claude Code"* ]]
  [ ! -s "$STUB_LOG" ]
}

@test "help review documents review" {
  run "$ILCLI" help review
  [ "$status" -eq 0 ]
  [[ "$output" == *"ilcli review"* ]]
  [[ "$output" == *"/opt/interloq/src/main.ts"* ]]
}

@test "help shell prints shell's usage and makes no docker call" {
  run "$ILCLI" help shell
  [ "$status" -eq 0 ]
  [[ "$output" == *"ilcli shell"* ]]
  [ ! -s "$STUB_LOG" ]
}

# W2-R1-1: after shell, build and down, --help and -h are ilcli's (the developer's decision of 27 Sep 2026), so
# their usage offers them truthfully; after run and review they are passed on, and the usage says so beside
# bashly's fixed usage line, which cannot be removed the supported way.
@test "the usage of shell, build and down offers --help; run and review say that --help is passed on" {
  for command in shell build down; do
    run "$ILCLI" help "$command"
    [[ "$output" == *"ilcli $command --help | -h"* ]] || { echo "help $command"; echo "$output"; return 1; }
    [[ "$output" != *"--help and -h are ignored"* ]]
  done
  run "$ILCLI" help run
  [[ "$output" == *"--help and -h are passed to claude"* ]] || { echo "$output"; return 1; }
  run "$ILCLI" help review
  [[ "$output" == *"--help and -h are passed to main.ts"* ]] || { echo "$output"; return 1; }
  [ ! -s "$STUB_LOG" ]
}
