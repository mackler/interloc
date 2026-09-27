## The shared functions of bin/ilcli.

# The root of the clone that contains this script.
ilcli_root() (
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
)

# docker compose over compose.cc.yaml of that clone, as bin/dev-claude called it.
ilcli_compose() {
  docker compose -f "$(ilcli_root)/compose.cc.yaml" "$@"
}

# 'up -d' does nothing when the container is already running. Its progress output is held back so that
# it does not interfere with the interactive session, and shown only on failure.
ensure_running() {
  local output
  if ! output=$(ilcli_compose up -d 2>&1); then
    printf '%s\n' "$output" >&2
    echo "ilcli: 'docker compose up' failed" >&2
    exit 1
  fi
}

# The arguments as the user typed them (saved by initialize.sh before bashly parses them), without the
# command's own name when it was given: bashly drops a literal -- from its catch-all, this keeps it.
forwarded_args() {
  forwarded=("${ilcli_argv[@]}")
  if [[ ${forwarded[0]:-} == "$1" ]]; then
    forwarded=("${forwarded[@]:1}")
  fi
}

# say <command> <text>: a line of progress; refuse <command> <text> [details]: the reason on stderr, exit 1.
say() {
  printf 'ilcli %s: %s\n' "$1" "$2"
}

refuse() {
  printf 'ilcli %s: refused: %s\n' "$1" "$2" >&2
  if [[ -n ${3:-} ]]; then
    printf '%s\n' "$3" | sed 's/^/  /' >&2
  fi
  exit 1
}

# The short hash and subject of a commit.
commit_line() {
  git -C "$(ilcli_root)" log -1 --format='%h %s' "$1"
}
