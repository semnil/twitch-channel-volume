#!/usr/bin/env bash
# What a run is for. A tag push is an intent to release, so its name has to be
# one this workflow makes a release from; a run started by hand carries a branch
# name where the tag would be and makes none. A tag naming no release is refused
# here: passed on, it produces a run that packs, uploads and releases nothing,
# and reports success.
set -euo pipefail
shopt -s extglob
if [[ -n "${RUNNER_DEBUG:-}" ]]; then set -x; fi

event="${1:-${GITHUB_EVENT_NAME:-}}"
ref="${2:-${GITHUB_REF_NAME:-}}"
out="${GITHUB_OUTPUT:-/dev/stdout}"

if [[ "${event}" != 'push' ]]; then
  echo 'validTag=false' >> "${out}"
  exit 0
fi

case "${ref#v}" in
  +([0-9]).+([0-9]).+([0-9]) )
    printf 'validTag=true\nprerelease=false\nversion=%s\n' "${ref}" >> "${out}"
    ;;
  +([0-9]).+([0-9]).+([0-9])-@(beta|rc|alpha)*([0-9.]) )
    printf 'validTag=true\nprerelease=true\nversion=%s\n' "${ref}" >> "${out}"
    ;;
  *)
    echo "::error::tag ${ref} names no release this workflow makes"
    exit 1
    ;;
esac
