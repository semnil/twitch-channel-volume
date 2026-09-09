#!/bin/sh
# The twitch suite without the packaging surface — the store package, the
# screenshot generator and its --check, the release-tag scripts and the icons.
# The slow ones there shell out to python, which is what this is for; the rest
# go with them because what is matched is the case's name.
#
# So a case is excluded for what it is called. Whole words keep the obvious
# collisions out ("stage" is not "tag", "versions" is not "version"), but a
# behavioural case named with one of these words is still swept out — "draws"
# takes the popup and options drawing cases with it — which is why a sweep
# judged by this file is judged again by MUTATE_CONFIRM="node test.js" before a
# survivor is written down. Naming a behavioural case with one of these words
# costs the sweep its power over that case.
exec node --test --test-skip-pattern="pack\.py|package|screenshot|\bzip\b|python|manifest|\bicons?\b|\btags?\b|\bversion\b|drawing|\bdraws\b|tracked|--check|--out|\bPNG\b|IDAT|faces|\bdirectory\b|backup|\bimages?\b|README|privacy|\bCI\b|reserved names|generator" test.js
