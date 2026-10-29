#!/usr/bin/env node
// Runs a suite and stops it at the first line it prints that reports a failed
// check, so that a mutant the suite kills costs the time to its first failure
// rather than the whole run.
//
//   node tools/mutation/bail.mjs <pattern> <test command…>
//
// <pattern> is a regular expression matched against each whole line the suite
// prints, on stdout and stderr alike. The first line that matches ends the run
// with exit 1, whatever the suite would have gone on to do. A run nothing
// matches exits as the suite did: with its status, or by the signal that took
// it.
//
// The suite runs in a process group of its own, and the stop takes the whole
// group, so nothing the suite started goes on writing after the run is over.
// A signal that reaches this process — Ctrl-C, or the sweep's timeout — is
// passed to that group and said on stderr. Once the suite itself has ended,
// what is left of its group is killed, its output is waited on no longer, and
// this process ends by the same signal, whatever the suite did with it: a run
// a signal took is not a verdict, and the sweep reading it has to see the
// signal rather than an exit status.
//
// What the suite prints is passed through as it was printed, up to the stop,
// and to a reader that is still there. A suite stopped this way runs none of
// its own clean-up.
//
// Windows has no process groups to stop, and there it refuses to run at all:
// exit 2, which a sweep reads as a baseline that is not green.
import { spawn } from 'node:child_process';

const USAGE = 'usage: node tools/mutation/bail.mjs <pattern> <test command…>';
const [source, ...command] = process.argv.slice(2);
if (process.platform === 'win32') {
  console.error('bail.mjs stops the process group a suite runs in, which Windows does not have');
  process.exit(2);
}
if (!source || !command.length) {
  console.error(USAGE);
  process.exit(2);
}
let pattern;
try {
  pattern = new RegExp(source);
} catch (err) {
  console.error(`${source} is not a regular expression (${err.message})`);
  process.exit(2);
}

const child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let bailed = false;
let stopping = null;
let ended = false;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function stopGroup(signal) {
  try { process.kill(-child.pid, signal); } catch (err) { if (err.code !== 'ESRCH') throw err; }
}
function letGo() {
  stopGroup('SIGKILL');
  child.stdout.destroy();
  child.stderr.destroy();
}
for (const signal of SIGNALS) {
  process.on(signal, () => {
    stopping = stopping || signal;
    if (ended) letGo();
    else if (child.pid) stopGroup(signal);
    console.error(`bail.mjs: ${signal} passed on to the suite`);
  });
}
child.on('exit', () => {
  ended = true;
  if (stopping) letGo();
});
// What is written for a reader that has gone away is lost, and the run goes on
// to its end.
for (const out of [process.stdout, process.stderr]) out.on('error', () => {});

// A line is matched once it is whole, and a chunk boundary can fall anywhere in
// one. A last line with no newline is the end of the run, and is not matched.
function watch(stream, out) {
  let partial = '';
  const look = (line) => {
    if (stopping || !pattern.test(line)) return;
    bailed = true;
    stopGroup('SIGKILL');
  };
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    if (!bailed) out.write(chunk);
    const lines = (partial + chunk).split('\n');
    partial = lines.pop();
    for (const line of lines) look(line);
  });
}
watch(child.stdout, process.stdout);
watch(child.stderr, process.stderr);

// What this process prints goes down a pipe, which Node writes asynchronously
// on some platforms; the exit waits for both to drain. How the run ends is
// read once they have, so a signal that arrives while they drain ends the run
// by that signal.
function leave(code, signal) {
  process.stdout.write('', () => process.stderr.write('', () => {
    const by = stopping || (bailed ? null : signal);
    if (by) {
      for (const s of SIGNALS) process.removeAllListeners(s);
      process.kill(process.pid, by);
      return;
    }
    process.exit(bailed ? 1 : code);
  }));
}
child.on('error', (err) => {
  console.error(`${command[0]} could not be run (${err.code || err.message})`);
  leave(127, null);
});
child.on('close', leave);
