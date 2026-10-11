#!/usr/bin/env bash
# The release a commit on main asks for. Prints the tag for the version the
# commit's manifest.json shows (version_name where it has one, version otherwise)
# when that differs from its first parent's, and prints nothing when the version
# did not move or the commit has no parent. A version the release path would
# decline exits 1 before any tag exists: the tag is asked of tools/check-tag.sh
# and the manifest of tools/verify-version.sh, the scripts release.yaml runs on it.
# Everything but the tag goes to stderr.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
sha="${1:?usage: tag-plan.sh <commit>}"
box="$(mktemp -d)"
trap 'rm -rf "${box}"' EXIT

shown() {
  python3 -c "import json,sys;m=json.load(open(sys.argv[1]));print(m.get('version_name') or m.get('version') or '')" "$1"
}

git show "${sha}:manifest.json" > "${box}/head.json"
if ! parent="$(git rev-parse --verify --quiet "${sha}^")"; then
  echo "${sha} has no parent — not a release" >&2
  exit 0
fi
if ! git show "${parent}:manifest.json" > "${box}/parent.json"; then
  echo "::error::cannot read manifest.json at ${parent} — refusing to tag" >&2
  exit 1
fi

previous="$(shown "${box}/parent.json")"
current="$(shown "${box}/head.json")"
if [[ -z "${previous}" ]]; then
  echo "::error::manifest.json at ${parent} names no version — refusing to tag" >&2
  exit 1
fi
if [[ "${current}" == "${previous}" ]]; then
  echo "version unchanged at ${current} — not a release" >&2
  exit 0
fi

tag="v${current}"
GITHUB_OUTPUT="${box}/check-tag" bash "${here}/check-tag.sh" tag "${tag}" >&2
bash "${here}/verify-version.sh" "${box}/head.json" "${tag}" >&2
echo "version ${previous} -> ${current}" >&2
echo "${tag}"
