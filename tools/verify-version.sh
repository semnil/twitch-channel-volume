#!/usr/bin/env bash
# The version a tag stands for. Chrome reads manifest.json's version as numbers
# alone, so a prerelease shows its name in version_name and keeps the numbers it
# is built on in version; a tag is met by whichever of the two the manifest has.
set -euo pipefail

manifest="${1:-manifest.json}"
tag="${2:-${GITHUB_REF_NAME:-}}"
tag="${tag#v}"

field() {
  python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" \
    "${manifest}" "$1"
}

version="$(field version)"
shown="$(field version_name)"

if [[ -z "${version}" ]]; then
  echo "::error::manifest.json names no version"
  exit 1
fi
if [[ -z "${shown}" ]]; then
  shown="${version}"
elif [[ "${shown}" != "${version}"* ]]; then
  echo "::error::manifest.json version_name (${shown}) does not begin with version (${version})"
  exit 1
fi
if [[ "${tag}" != "${shown}" ]]; then
  echo "::error::manifest.json version (${shown}) does not match tag (${tag})"
  exit 1
fi
echo "version check OK: ${shown}"
