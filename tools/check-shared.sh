#!/usr/bin/env bash
# Compares the files this extension shares with its siblings with the commit
# of semnil/channel-volume-core that core.json locks, and exits 1 where one of
# them differs. The repository is named here rather than read from the tree,
# so a change to core.json can move the commit but not the source;
# CORE_SOURCE names another one to fetch from (a local clone, in the tests).
set -euo pipefail

origin="${CORE_SOURCE:-https://github.com/semnil/channel-volume-core}"

commit="$(node -p "require('./core.json').core.commit")"
if [[ ! "${commit}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "core.json locks no commit: ${commit}" >&2
  exit 1
fi
source="$(mktemp -d)"
trap 'rm -rf "${source}"' EXIT
git init -q "${source}"
git -C "${source}" fetch -q --depth 1 "${origin}" "${commit}"
git -C "${source}" checkout -q FETCH_HEAD
node "${source}/sync.mjs" --check "${source}" .
