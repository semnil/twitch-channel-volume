#!/usr/bin/env node
// Generates mutants from a source file by rule rather than by recall, runs a
// suite against each, and reports the ones that live through it.
//
//   node tools/mutation/sweep.mjs <tree> <source file> <test command…>
//   node tools/mutation/sweep.mjs --verify [<tree>]
//
// A mutant that does not parse is not a measurement and is left out of the
// count. The source file is put back after every run and read again to check
// that it came back; where it did not, the marker stays over the tree and the
// exit says so rather than 0.
//
// Ctrl-C reaches the suite the sweep is running, and a run a signal took is not
// a verdict: the source goes back and the exit is 130. The marker goes with it
// where the source came back and stays where it did not. A signal sent to this
// process alone waits for the run in flight, because the loop is synchronous
// and the handler cannot be reached until it yields.
//
// --verify writes nothing and runs no suite: it regenerates the mutants and
// asks whether every entry in equivalents.md still names one. An entry that
// names a site the code no longer has is a reason nobody can check, which is
// what an equivalents list turns into on its own.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, openSync, closeSync, fstatSync, statSync } from 'node:fs';
import { dirname, join, relative as relativeTo } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EQUIVALENTS = join(HERE, 'equivalents.md');
const USAGE = 'usage: node tools/mutation/sweep.mjs <tree> <source file> <test command…>\n' +
  '       node tools/mutation/sweep.mjs --verify [<tree>]';

const argv = process.argv.slice(2);
const verifying = argv[0] === '--verify';
const [tree, relative, ...command] = verifying
  ? [argv[1] || join(HERE, '..', '..'), null]
  : argv;
if (!tree || (!verifying && (!relative || !command.length))) {
  console.error(USAGE);
  process.exit(2);
}
const path = relative === null ? null : join(tree, relative);
let marker, original, claimed = null;
// Where the source stands, and with it what may be done with the marker:
//   'before'   — nothing has been written to it; the tree is as it was found.
//   'mutating' — what is on disk may be a mutant.
//   'restored' — it was written back, read again, and matched.
// Only 'before' and 'restored' are states in which the tree is the operator's
// again, and only those two release the marker.
let state = 'before';
// Every way out of a run that has claimed the marker goes through here, so that
// neither a marker it could not put down nor a source it could not put back can
// leave by a path that says the run went well. Exit 4 is "the tree holds a
// mutant", exit 5 is "the tree is still marked".
function finish(code) {
  if (state === 'mutating') {
    console.error(`${relative} is not what it was before the sweep; the tree holds a mutant, and ${marker} stays`);
    process.exit(code === 0 ? 4 : code);
  }
  const left = releaseMarker();
  process.exit(left && code === 0 ? 5 : code);
}

if (!verifying) guardTree();
function guardTree() {
// The sweep writes mutants into the working tree, so anything else writing or
// reading that tree meanwhile sees them — a commit made mid-run carries one.
// Refusing to start on a dirty file does not stop that, so the sweep also
// leaves a marker naming itself while it holds the file.
const dirty = execFileSync('git', ['status', '--porcelain', '--', relative], { cwd: tree, encoding: 'utf8' }).trim();
if (dirty) {
  console.error(`${relative} has uncommitted changes; commit or set them aside before sweeping`);
  process.exit(2);
}
marker = join(tree, '.mutation-sweep-running');
// One sweep at a time per tree. Two of them put two mutants in front of one
// suite, so neither kill nor survivor belongs to either mutation, and the one
// that finishes first takes the marker away from the one still running —
// leaving a tree that holds a mutant looking like a tree that does not.
// 'wx' is the claim: refused rather than overwritten where someone holds it.
let claim;
try {
  claim = openSync(marker, 'wx');
} catch (err) {
  if (err.code !== 'EEXIST') throw err;
  const owner = Number((readFileSync(marker, 'utf8').match(/pid (\d+)/) || [])[1]);
  let alive = false;
  try { process.kill(owner, 0); alive = true; } catch (_) {}
  console.error(alive
    ? `${tree} is already being swept by pid ${owner}; one sweep at a time per tree`
    : `${tree} carries a marker from pid ${owner || 'a process'} that is gone; ` +
      `the tree may hold a mutant it left behind. Check it, then remove ${marker}`);
  process.exit(2);
}
// What makes the marker this run's is having created it, not the line written
// into it afterwards: a write that fails leaves a file with no pid in it, and
// a run that reads ownership out of the text then walks away from its own lock.
// The file it created is identified by its inode, taken before anything else
// can fail.
try {
  const { dev, ino } = fstatSync(claim);
  claimed = { dev, ino };
} finally {
  closeSync(claim);
}
try {
  writeFileSync(marker, `${relative} is being mutated by tools/mutation/sweep.mjs (pid ${process.pid}) — do not commit this tree\n`);
} catch (err) {
  console.error(`${marker} could not be written (${err.code || err.message})`);
  finish(2);
}
try {
  original = readFileSync(path, 'utf8');
} catch (err) {
  // Nothing has been written to the source yet, so there is nothing to put
  // back; the marker is all this run leaves, and it goes.
  console.error(`${relative} could not be read (${err.code || err.message})`);
  finish(2);
}
// The marker stands for the whole run, not for one mutant: it is what says the
// source on disk may not be the source, and it stays up from the first mutant
// until a restore has been read back and matched.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { putBack(); finish(130); });
}

// Whether the marker is still there when this returns. Only the run that made
// it takes it away, and the file it made is the one with that inode: a marker
// somebody else replaced in the meantime is not this run's to remove.
function releaseMarker() {
  if (!claimed) return false;
  try {
    const now = statSync(marker);
    if (now.dev !== claimed.dev || now.ino !== claimed.ino) return false;
    unlinkSync(marker);
    return false;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    console.error(`the sweep could not take its marker off ${marker} (${err.code || err.message})`);
    return true;
  }
}

// The two ways the source is written. Everything the sweep puts on disk goes
// through one of them, so that the state above cannot fall behind the file.
// putMutant moves to 'mutating' before the write, because a write that lands
// only in part leaves a source that is not the source either.
function putMutant(text) {
  state = 'mutating';
  writeFileSync(path, text);
}
// A restore is not a restore until the file has been read again: a write that
// reports success and puts down something else leaves the tree holding a
// mutant, and saying so is what keeps the marker up. The state goes back to
// 'mutating' first: what a restore that did not take leaves behind is not the
// source either, whatever the restore before it left.
function putBack() {
  state = 'mutating';
  try {
    writeFileSync(path, original);
  } catch (err) {
    console.error(`${relative} could not be written back (${err.code || err.message})`);
    return;
  }
  let back;
  try {
    back = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`${relative} could not be read back (${err.code || err.message})`);
    return;
  }
  if (back === original) state = 'restored';
}

// Each rule turns one occurrence into one mutant. `find` is matched with a
// global regular expression so that every site is taken, one at a time.
const RULES = [
  ['a guard is dropped', /^[ \t]*if \([^\n]*\) return[^\n]*;\n/gm, () => ''],
  ['a guard body is dropped', /^([ \t]*)if \(([^\n]*)\) \{\n/gm, (m, indent) => `${indent}if (false) {\n`],
  ['a guard is always taken', /^([ \t]*)if \(([^\n]*)\) \{\n/gm, (m, indent) => `${indent}if (true) {\n`],
  ['&& becomes ||', / && /g, () => ' || '],
  ['|| becomes &&', / \|\| /g, () => ' && '],
  ['=== becomes !==', / === /g, () => ' !== '],
  ['!== becomes ===', / !== /g, () => ' === '],
  ['a negation is dropped', /\(!([A-Za-z_$][\w$.?]*)\)/g, (m, name) => `(${name})`],
  ['true becomes false', /return true;/g, () => 'return false;'],
  ['false becomes true', /return false;/g, () => 'return true;'],
  ['some becomes every', /\.some\(/g, () => '.every('],
  ['every becomes some', /\.every\(/g, () => '.some('],
  ['filter is dropped', /\.filter\(([A-Za-z_$][\w$]*)\)/g, () => ''],
  ['the first is taken for the last', /\[([A-Za-z_$][\w$]*)\.length - 1\]/g, () => '[0]'],
  ['an await is dropped', /await /g, () => ''],
];

// Optional chaining in these files guards against page shapes the suites do
// not enumerate — a player response missing a field YouTube always sends. The
// rule finds those, in numbers, and none of them is a contract the extension
// owes anyone, so it is asked for by name rather than run by default.
if (process.env.MUTATE_OPTIONAL === '1') {
  RULES.push(['an optional call is made unconditional', /\?\./g, () => '.']);
}

function mutantsFor(source) {
  const found = [];
  for (const [label, pattern, replace] of RULES) {
    for (const match of source.matchAll(pattern)) {
      const at = match.index;
      const body = replace(...match);
      if (body === match[0]) continue;
      const line = source.slice(0, at).split('\n').length;
      found.push({
        label, line,
        text: source.slice(0, at) + body + source.slice(at + match[0].length),
        was: match[0].trim().slice(0, 72)
      });
    }
  }
  return found;
}

// Every mutant this repository's suite is known to let through, read back from
// equivalents.md and put to the code as it stands now. Nothing is run: this
// asks only whether each entry still names a site, so that a reason cannot go
// on standing for a mutation the code no longer has.
//
// An entry names the file, the line, the rule and the text the rule matched,
// and ×N is how many of that group are equivalent — fewer than the line carries
// where one of a line's two `===` is equivalent and the other is killed. The
// text is part of the key because a line number on its own moves onto whatever
// takes that line: a reason measured for one guard would otherwise go on
// standing for a different guard nobody has measured.
//
// The check is that the site still holds at least as many as are named. Both of
// the other ways a list drifts are the sweep's job rather than this one's: a
// line that grew a mutant nobody has judged comes back from the next sweep as
// one standing unnamed, and an entry whose mutant the suite has come to kill
// still names a site, so nothing here can see it — only a sweep of that file
// can, by what it does not find standing.
if (verifying) {
  let text;
  try { text = readFileSync(EQUIVALENTS, 'utf8'); }
  catch { console.error(`${EQUIVALENTS} is not there`); process.exit(2); }
  const wanted = new Map();
  // In this file a list item is an entry: any markdown bullet, numbered or not
  // and indented or not, is read as one, and prose that is not a list item is
  // passed over. The canonical form is what passes — `- \`file:line\` label ×N —
  // was` at the margin, with a count of at least one, since ×0 covers no mutant
  // and so asks nothing of the code.
  const CANDIDATE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;
  const ENTRY = /^-\s+`([^`:]+):(\d+)`\s+(.+?)\s+×([1-9]\d*)\s+—\s+(.*?)\s*$/;
  let entries = 0;
  const malformed = [];
  for (const line of text.split('\n')) {
    // A line that opens like an entry and does not parse is a dropped entry,
    // not prose. Skipping it quietly is how a list loses a mutant while the
    // count it prints stays true to what it managed to read.
    if (!CANDIDATE.test(line)) continue;
    const m = line.match(ENTRY);
    if (!m) { malformed.push(line.trim()); continue; }
    entries += 1;
    const key = `${m[1]}\u0000${m[2]}\u0000${m[3]}\u0000${m[5]}`;
    wanted.set(key, (wanted.get(key) || 0) + Number(m[4]));
  }
  if (malformed.length) {
    console.error(
      `${EQUIVALENTS} has ${malformed.length} entries it cannot read:\n  ${malformed.join('\n  ')}`
    );
    process.exit(2);
  }
  if (!entries) {
    console.error(`${EQUIVALENTS} names no mutants; the format is "- \`file:line\` label ×N — was"`);
    process.exit(2);
  }
  const have = new Map();
  const sources = new Set([...wanted.keys()].map((key) => key.split('\u0000')[0]));
  for (const file of sources) {
    let source;
    try { source = readFileSync(join(tree, file), 'utf8'); }
    catch { console.error(`${file}: named in equivalents.md, not in the tree`); process.exit(1); }
    for (const mutant of mutantsFor(source)) {
      // The text is cut to a fixed width, which can leave a trailing space that
      // an entry read back from markdown no longer has.
      const key = `${file}\u0000${mutant.line}\u0000${mutant.label}\u0000${mutant.was.trimEnd()}`;
      have.set(key, (have.get(key) || 0) + 1);
    }
  }
  const wrong = [];
  for (const [key, count] of wanted) {
    const [file, line, label, was] = key.split('\u0000');
    const found = have.get(key) || 0;
    if (found < count) {
      wrong.push(`${file}:${line} ${label} — named ×${count}, the code has ×${found} of "${was}"`);
    }
  }
  if (wrong.length) {
    console.error(`equivalents.md has moved away from the code:\n  ${wrong.join('\n  ')}`);
    process.exit(1);
  }
  const total = [...wanted.values()].reduce((sum, n) => sum + n, 0);
  console.log(
    `equivalents.md: ${entries} entries covering ${total} mutants of ${sources.size} sources, ` +
    'every one of them still a site the code has'
  );
  process.exit(0);
}

const mutants = mutantsFor(original);

// A sweep of one region: the whole file takes hours where a batch of work
// touches a hundred lines of it. MUTATE_LINES=<first>-<last> keeps the mutants
// whose site falls inside those lines, and the control below still runs against
// the whole file, so a region sweep cannot be powerless without saying so.
const range = process.env.MUTATE_LINES;
if (range) {
  const [first, last] = range.split('-').map(Number);
  if (!Number.isInteger(first) || !Number.isInteger(last) || first > last) {
    console.error(`MUTATE_LINES wants <first>-<last>, got ${range}`);
    finish(2);
  }
  const before = mutants.length;
  for (let i = mutants.length - 1; i >= 0; i--) {
    if (mutants[i].line < first || mutants[i].line > last) mutants.splice(i, 1);
  }
  console.error(`lines ${first}-${last}: ${mutants.length} of ${before} mutants`);
}

// Sizing a run before committing to it: how many suite runs it is going to be.
// This writes nothing and runs nothing, so it says nothing about power either.
if (process.env.MUTATE_COUNT) {
  console.log(`${relative}: ${mutants.length} mutants`);
  finish(0);
}

// A repository with more than one suite: a mutant the cheap one kills is
// killed whatever the other one says, so the second command is spent on the
// survivors alone. MUTATE_CONFIRM=<shell line> names it.
const confirm = process.env.MUTATE_CONFIRM;

// A child that never ran, or that a signal took, measured nothing. Counting
// either as a verdict is how a sweep reports a score it did not earn, so every
// status is read through here first — the control, the baseline, the syntax
// check, each mutant, and the same four on the confirming side. A signal is the
// operator asking for the run to end, and the run ends: the source goes back,
// the exit says it was interrupted, and the marker goes only where the source
// came back.
function ranAtAll(run, what) {
  if (run.error && run.error.code === 'ETIMEDOUT') return run;
  if (run.signal) {
    console.error(`${what} was stopped by ${run.signal}`);
    putBack();
    finish(130);
  }
  if (run.error) {
    console.error(`${what} could not be run (${run.error.code || run.error.message})`);
    putBack();
    finish(3);
  }
  return run;
}

// A sweep of a file the suite never loads reports every mutant as standing,
// which reads exactly like a file with no guards on it. The control is a
// version that cannot run at all: if the suite passes that, this run has no
// power to say anything and stops instead of printing a list.
const control = `throw new Error('mutation control');\n` + original;
putMutant(control);
const controlRun = ranAtAll(
  spawnSync(command[0], command.slice(1), { cwd: tree, encoding: 'utf8', timeout: 180000 }),
  'the control run'
);
putBack();
if (controlRun.status === 0) {
  console.error(`the suite passes with ${relative} replaced by a throw — it does not read this file`);
  finish(3);
}
const baseline = ranAtAll(
  spawnSync(command[0], command.slice(1), { cwd: tree, encoding: 'utf8', timeout: 180000 }),
  'the baseline run'
);
if (baseline.status !== 0) {
  console.error(`the suite is not green before any mutation is applied (exit ${baseline.status})`);
  finish(3);
}

let ran = 0, killed = 0, hung = 0;
const survivors = [];
const unparsed = [];
for (const mutant of mutants) {
  putMutant(mutant.text);
  const parses = spawnSync('node', ['--check', path], { encoding: 'utf8' });
  ranAtAll(parses, 'the syntax check');
  if (parses.status !== 0) { unparsed.push(mutant); continue; }
  ran += 1;
  const started = Date.now();
  const run = spawnSync(command[0], command.slice(1), { cwd: tree, encoding: 'utf8', timeout: 180000 });
  const seconds = (Date.now() - started) / 1000;
  ranAtAll(run, 'the suite');
  if (run.error && run.error.code === 'ETIMEDOUT') {
    hung += 1;
    survivors.push({ ...mutant, verdict: 'HUNG', seconds });
  } else if (run.status === 0) {
    survivors.push({ ...mutant, verdict: 'SURVIVED', seconds });
  } else {
    killed += 1;
  }
  process.stderr.write(`\r${ran}/${mutants.length - unparsed.length} run, ${survivors.length} standing`);
}
putBack();
process.stderr.write('\n');

if (confirm && survivors.length) {
  process.stderr.write(`confirming ${survivors.length} survivors against: ${confirm}\n`);
  const control = `throw new Error('mutation control');\n` + original;
  putMutant(control);
  const powered = ranAtAll(
    spawnSync('sh', ['-c', confirm], { cwd: tree, encoding: 'utf8', timeout: 180000 }),
    "the confirming command's control run"
  );
  putBack();
  // A confirming command with no power over this file kills nothing, which
  // costs the run its survivors rather than its correctness: it is said and
  // skipped rather than ending the sweep that has already been measured.
  let powerless = powered.status === 0;
  if (powerless) {
    console.error(`the confirming command does not execute ${relative}; the survivors stand as the sweep found them`);
  } else {
    const green = ranAtAll(
      spawnSync('sh', ['-c', confirm], { cwd: tree, encoding: 'utf8', timeout: 180000 }),
      "the confirming command's baseline run"
    );
    if (green.status !== 0) {
      console.error(
        `the confirming command is not green before any mutation is applied (exit ${green.status}); ` +
        'the survivors stand as the sweep found them'
      );
      powerless = true;
    }
  }
  putBack();
  for (let i = powerless ? -1 : survivors.length - 1; i >= 0; i--) {
    putMutant(survivors[i].text);
    const run = spawnSync('sh', ['-c', confirm], { cwd: tree, encoding: 'utf8', timeout: 180000 });
    ranAtAll(run, 'the confirming command');
    const timedOut = run.error && run.error.code === 'ETIMEDOUT';
    if (!timedOut && run.status !== 0) {
      if (survivors[i].verdict === 'HUNG') hung -= 1;
      survivors.splice(i, 1);
      killed += 1;
    }
  }
  putBack();
}

console.log(`${relative}: ${mutants.length} mutants, ${unparsed.length} did not parse, ${ran} run, ${killed} killed, ${survivors.length} standing (${hung} of them hung)\n`);
for (const s of survivors) {
  console.log(`${s.verdict.padEnd(9)} ${relative}:${String(s.line).padEnd(4)} ${s.label} — ${s.was}`);
}
if (state === 'restored') console.log(`\n${relative} is back as it was`);
finish(0);
