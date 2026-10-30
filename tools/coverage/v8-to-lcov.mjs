// Turns the V8 coverage the suites leave under NODE_V8_COVERAGE into an lcov
// report of the named sources.
//   node tools/coverage/v8-to-lcov.mjs <coverage dir> <lcov out> <source>...
// A source is counted from every script compiled from it, whatever context
// loaded it: a file: URL has to name the source's own path, and any other URL
// (a vm filename, a chrome-extension: URL) has to end in its name. A script
// whose text is not as long as the source (a source the harness edited first)
// is not counted. A line counts as run where any of its code ran, and as partly run,
// reported as a branch left untaken, where some of its code did not. Blank
// lines and lines holding only a comment are not reported. A named source no
// suite loaded is reported with every line unrun.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [covDir, outFile, ...files] = process.argv.slice(2);
if (!covDir || !outFile || files.length === 0) {
  console.error('usage: v8-to-lcov.mjs <coverage dir> <lcov out> <source>...');
  process.exit(2);
}

const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
const counts = new Map(files.map((f) => [f, new Float64Array(sources.get(f).length)]));
const loaded = new Map(files.map((f) => [f, 0]));
const byName = new Map(files.map((f) => [path.basename(f), f]));

for (const name of readdirSync(covDir)) {
  if (!name.endsWith('.json')) continue;
  const { result } = JSON.parse(readFileSync(path.join(covDir, name), 'utf8'));
  for (const script of result) {
    const file = byName.get(script.url.split('/').pop());
    if (!file) continue;
    if (script.url.startsWith('file:') && fileURLToPath(script.url) !== path.resolve(file)) continue;
    const src = sources.get(file);
    const top = script.functions[0]?.ranges[0];
    if (!top || top.startOffset !== 0 || top.endOffset !== src.length) continue;
    loaded.set(file, loaded.get(file) + 1);
    // The innermost range holds a character's count: widest ranges first.
    const ranges = script.functions.flatMap((f) => f.ranges)
      .sort((a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset));
    const own = new Float64Array(src.length);
    for (const r of ranges) own.fill(r.count, r.startOffset, r.endOffset);
    const total = counts.get(file);
    for (let i = 0; i < total.length; i++) total[i] += own[i];
  }
}

// The offsets of code: everything but whitespace and comments. Strings,
// template literals and regular expression literals are code.
function codeMask(src) {
  const code = new Uint8Array(src.length);
  let i = 0;
  let prev = '';
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`' || (c === '/' && !/[\w)\]$]/.test(prev))) {
      const start = i++;
      let inClass = false;
      while (i < src.length) {
        const d = src[i];
        if (d === '\\') { i += 2; continue; }
        if (c === '/' && d === '[') inClass = true;
        else if (c === '/' && d === ']') inClass = false;
        else if (d === c && !inClass) { i++; break; }
        else if (c !== '`' && d === '\n') break;
        i++;
      }
      code.fill(1, start, i);
      prev = 'a';
      continue;
    }
    if (!/\s/.test(c)) {
      code[i] = 1;
      prev = c;
    }
    i++;
  }
  return code;
}

let out = '';
const summary = [];
for (const file of files) {
  const src = sources.get(file);
  const total = counts.get(file);
  const code = codeMask(src);
  out += `TN:\nSF:${file}\n`;
  let found = 0, hit = 0, brFound = 0, brHit = 0;
  let start = 0;
  for (let line = 1; start <= src.length; line++) {
    let end = src.indexOf('\n', start);
    if (end < 0) end = src.length;
    let max = -1, min = Infinity;
    for (let i = start; i < end; i++) {
      if (!code[i]) continue;
      max = Math.max(max, total[i]);
      min = Math.min(min, total[i]);
    }
    if (max >= 0) {
      found++;
      if (max > 0) hit++;
      out += `DA:${line},${max}\n`;
      if (max > 0 && min === 0) {
        out += `BRDA:${line},0,0,1\nBRDA:${line},0,1,-\n`;
        brFound += 2;
        brHit += 1;
      }
    }
    start = end + 1;
  }
  out += `BRF:${brFound}\nBRH:${brHit}\nLF:${found}\nLH:${hit}\nend_of_record\n`;
  summary.push(`${file}\tscripts ${loaded.get(file)}\tlines ${hit}/${found}\tpartly run ${brFound / 2}`);
}
writeFileSync(outFile, out);
console.log(summary.join('\n'));
