#!/bin/sh
# The twitch suite without the cases that shell out to python — the packaging
# selection, the screenshot generator and the release-tag scripts. The names are
# matched on whole words so that a behavioural case is not swept out with them
# ("stage" is not "tag", "versions" is not "version").
exec node --test --test-skip-pattern="pack\.py|package|screenshot|\bzip\b|python|manifest|\bicons?\b|\btags?\b|\bversion\b|drawing|\bdraws\b|tracked|--check|--out|\bPNG\b|IDAT|faces|\bdirectory\b|backup|\bimages?\b|README|privacy|\bCI\b|reserved names|generator" test.js
