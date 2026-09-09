#!/bin/sh
# Sweeps a tree's sources one file at a time into one report.
#
#   sweep-all.sh <tree> <report> <suite command> <file>…
#
# The suite command is one word or a quoted shell line; every file is swept
# against it. A sweep that stopped rather than finishing — a dirty source, a
# suite with no power over the file, a tree that is not there — takes the whole
# run down with it: a report is read as a measurement, and a section that is
# empty because nothing ran looks like a section with nothing to report.
tree=$1
report=$2
suite=$3
shift 3
here=$(dirname "$0")
: > "$report"
status=0
for file in "$@"; do
  echo "===== $file =====" >> "$report"
  out=$(node "$here/sweep.mjs" "$tree" "$file" sh -c "$suite" 2>&1) || status=$?
  # Everything the sweep says about what it measured, what it could not, and
  # whether it gave the tree back. Filtering to the survivor lines alone hides
  # the runs that never got as far as having survivors.
  printf '%s\n' "$out" \
    | grep -a -E "mutants,|^SURVIVED|^HUNG|^lines |does not read|does not execute|not green|is back as it was|holds a mutant|uncommitted changes|MUTATE_LINES wants|not there|not in the tree|cannot read|moved away|could not be written|could not be read|could not take its marker off" \
    >> "$report"
  if [ "$status" -ne 0 ]; then
    echo "===== $file stopped (exit $status) =====" >> "$report"
    echo "sweep-all: $file stopped the run (exit $status); see $report" >&2
    exit "$status"
  fi
done
echo "===== done =====" >> "$report"
