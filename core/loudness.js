// loudness.js — The loudness measurement the extensions share: the BS.1770-4
// K-weighting for the rate an AudioContext runs at, the chain that carries a
// media element's audio through it to audio-worklet.js, and the meter that
// turns the worklet's 100 ms blocks into Momentary, Short-term and a gated
// Integrated level. A classic script that declares one name and reaches for no
// extension API, so it can be loaded into a page's own world beside the page's
// scripts. What the meter is told — which windows to hold out, which to take
// back — is the caller's: it knows the operations, not the reasons for them.

const channelVolumeLoudness = (() => {
  'use strict';

  const REF_RATE = 48000;

  // The page can reach what this script hands out, so the coefficients it
  // builds every chain from cannot be written to.
  const frozenBiquad = (b, a) => Object.freeze({ b: Object.freeze(b), a: Object.freeze(a) });

  const K_PRE_48K = frozenBiquad(
    [1.53512485958697, -2.69169618940638, 1.19839281085285],
    [1.0, -1.69065929318241, 0.73248077421585]
  );
  const K_RLB_48K = frozenBiquad(
    [1.0, -2.0, 1.0],
    [1.0, -1.99004745483398, 0.99007225036621]
  );

  // A biquad written down at fs0, taken back to its analog form by the inverse
  // bilinear transform and brought to fs by the bilinear transform again.
  function redesignBiquad(coef, fs0, fs) {
    const K0 = 2 * fs0;
    const [b0, b1, b2] = coef.b;
    const [a0, a1, a2] = coef.a;
    const B0 = b0 + b1 + b2;
    const B1 = 2 * (b0 - b2) / K0;
    const B2 = (b0 - b1 + b2) / (K0 * K0);
    const A0 = a0 + a1 + a2;
    const A1 = 2 * (a0 - a2) / K0;
    const A2 = (a0 - a1 + a2) / (K0 * K0);
    const K = 2 * fs;
    const K2 = K * K;
    const denom = A0 + A1 * K + A2 * K2;
    return {
      b: [
        (B0 + B1 * K + B2 * K2) / denom,
        (2 * B0 - 2 * B2 * K2) / denom,
        (B0 - B1 * K + B2 * K2) / denom
      ],
      a: [
        1.0,
        (2 * A0 - 2 * A2 * K2) / denom,
        (A0 - A1 * K + A2 * K2) / denom
      ]
    };
  }

  // The two K-weighting filters for a sample rate: the coefficients as written
  // at 48 kHz, designed again for any other rate.
  function kForSampleRate(sr) {
    if (Math.abs(sr - REF_RATE) < 1) return { pre: K_PRE_48K, rlb: K_RLB_48K };
    return {
      pre: redesignBiquad(K_PRE_48K, REF_RATE, sr),
      rlb: redesignBiquad(K_RLB_48K, REF_RATE, sr)
    };
  }

  function meanSquareToLufs(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return -Infinity;
    return -0.691 + 10 * Math.log10(ms);
  }

  // A block tapped ahead of an element's own volume, referenced to volume 1.
  // A volume that is not between 0 and 1 leaves the block as it is.
  function normalizeForVolume(ms, volume) {
    if (!Number.isFinite(volume) || volume <= 0 || volume >= 1) return ms;
    return ms / (volume * volume);
  }

  const BLOCK_SEC = 0.1;
  const MOMENTARY_BLOCKS = 4;
  const SHORT_BLOCKS = 30;
  // BS.1770-4 gates 400ms blocks overlapping by 75%: one gating window per
  // 100ms sub-block, formed from the most recent GATE_BLOCKS sub-blocks.
  const GATE_BLOCKS = 4;
  const MAX_INTEGRATED_BLOCKS = 60 * 60 * 10;
  // A saved value seeds the new measurement as at least this many windows,
  // whatever the count stored with it says.
  const MIN_SEED_WINDOWS = 300;
  // and as at most this many, so a session of that length carries the same
  // weight as the seed and can move the value off it.
  const MAX_SEED_WINDOWS = 3 * 60 * 10;
  // A gating window that spans a boundary in the signal carries audio from
  // both sides of it. Windows stay out of Integrated until they are clear of it.
  const BOUNDARY_SKIP_BLOCKS = GATE_BLOCKS;
  const ABSOLUTE_GATE_MEAN_SQUARE = Math.pow(10, (-70 + 0.691) / 10);
  const RELATIVE_GATE_FACTOR = Math.pow(10, -10 / 10);

  // The processor audio-worklet.js registers.
  const WORKLET_PROCESSOR = 'k-mean-square';

  // The source carried through the two K-weighting filters to the worklet,
  // whose blocks reach onBlock, and from there into a gain of 0, so the
  // measurement path adds nothing to the output. The worklet's module is
  // loaded into the context before this is asked for.
  function buildChain(context, source, onBlock) {
    const { pre, rlb } = kForSampleRate(context.sampleRate);
    const preNode = context.createIIRFilter(pre.b, pre.a);
    const rlbNode = context.createIIRFilter(rlb.b, rlb.a);
    const node = new AudioWorkletNode(context, WORKLET_PROCESSOR, {
      processorOptions: { blockSec: BLOCK_SEC }
    });
    node.port.onmessage = onBlock;
    source.connect(preNode);
    preNode.connect(rlbNode);
    rlbNode.connect(node);
    const silentGain = context.createGain();
    silentGain.gain.value = 0;
    node.connect(silentGain);
    silentGain.connect(context.destination);
    return node;
  }

  // The index of the gated windows: a balanced tree keyed on the mean square,
  // carrying each subtree's sum and count.
  function treeHeight(node) {
    return node?.height || 0;
  }

  function treeCount(node) {
    return node?.subtreeCount || 0;
  }

  function treeSum(node) {
    return node?.subtreeSum || 0;
  }

  function updateTreeNode(node) {
    node.height = 1 + Math.max(treeHeight(node.left), treeHeight(node.right));
    node.subtreeCount = node.count + treeCount(node.left) + treeCount(node.right);
    node.subtreeSum = node.key * node.count + treeSum(node.left) + treeSum(node.right);
    return node;
  }

  function rotateTreeLeft(node) {
    const root = node.right;
    node.right = root.left;
    root.left = updateTreeNode(node);
    return updateTreeNode(root);
  }

  function rotateTreeRight(node) {
    const root = node.left;
    node.left = root.right;
    root.right = updateTreeNode(node);
    return updateTreeNode(root);
  }

  function balanceTree(node) {
    if (!node) return null;
    updateTreeNode(node);
    const balance = treeHeight(node.left) - treeHeight(node.right);
    if (balance > 1) {
      if (treeHeight(node.left.left) < treeHeight(node.left.right)) {
        node.left = rotateTreeLeft(node.left);
      }
      return rotateTreeRight(node);
    }
    if (balance < -1) {
      if (treeHeight(node.right.right) < treeHeight(node.right.left)) {
        node.right = rotateTreeRight(node.right);
      }
      return rotateTreeLeft(node);
    }
    return node;
  }

  function insertTreeValue(node, key) {
    if (!node) {
      return {
        key,
        count: 1,
        height: 1,
        subtreeCount: 1,
        subtreeSum: key,
        left: null,
        right: null
      };
    }
    if (key < node.key) node.left = insertTreeValue(node.left, key);
    else if (key > node.key) node.right = insertTreeValue(node.right, key);
    else node.count++;
    return balanceTree(node);
  }

  function removeTreeValue(node, key, removeAll = false) {
    if (!node) return null;
    if (key < node.key) node.left = removeTreeValue(node.left, key, removeAll);
    else if (key > node.key) node.right = removeTreeValue(node.right, key, removeAll);
    else if (node.count > 1 && !removeAll) node.count--;
    else {
      if (!node.left) return node.right;
      if (!node.right) return node.left;
      let successor = node.right;
      while (successor.left) successor = successor.left;
      node.key = successor.key;
      node.count = successor.count;
      node.right = removeTreeValue(node.right, successor.key, true);
    }
    return balanceTree(node);
  }

  function treeValuesAtOrAbove(node, threshold) {
    if (!node) return { sum: 0, count: 0 };
    if (node.key < threshold) return treeValuesAtOrAbove(node.right, threshold);
    const left = treeValuesAtOrAbove(node.left, threshold);
    return {
      sum: left.sum + node.key * node.count + treeSum(node.right),
      count: left.count + node.count + treeCount(node.right)
    };
  }

  function blocksMeanSquare(list, count) {
    if (list.length < count) return null;
    let sum = 0;
    for (let i = list.length - count; i < list.length; i++) sum += list[i];
    return sum / count;
  }

  function blocksToLufs(list, count) {
    if (list.length === 0) return -Infinity;
    const n = Math.min(count, list.length);
    let sum = 0;
    for (let i = list.length - n; i < list.length; i++) sum += list[i];
    return meanSquareToLufs(sum / n);
  }

  // What the caller says the saved value stands on, held to what a seed may
  // weigh. A count that is not a positive integer says nothing.
  function savedWindowCount(savedWindows) {
    const saved = Number.isSafeInteger(savedWindows) && savedWindows > 0 ? savedWindows : 0;
    return Math.min(MAX_SEED_WINDOWS, saved);
  }

  // One measurement: the recent blocks, and the gating windows of the last
  // hour in a ring buffer whose windows above the absolute gate are indexed.
  function createMeter() {
    const blocks = [];
    let boundarySkipBlocks = 0;
    let windowsSinceReset = 0;
    let windowsObserved = 0;
    // The windows behind the value: the ones inside the relative gate, with
    // the seed standing for what it was told the saved value was measured
    // over. The floor the seed is raised to is not one of them, and neither is
    // a window the gate left out - the value does not rest on either.
    let seedClaimedWindows = 0;
    let seedMeanSquare = null;
    let seedEntriesInRing = 0;
    const integratedBlocks = new Array(MAX_INTEGRATED_BLOCKS);
    // The gating window each appended block came from. A window the boundary
    // skip dropped was never appended, so a removal spanning it has nothing
    // there to take back; the stamps say which of the windows a span covers
    // are in the ring.
    const integratedBlockWindows = new Array(MAX_INTEGRATED_BLOCKS);
    let integratedBlockStart = 0;
    let integratedBlockLength = 0;
    let absoluteGatedRoot = null;

    function appendIntegratedBlock(ms, gatingWindow) {
      let removed;
      if (integratedBlockLength < MAX_INTEGRATED_BLOCKS) {
        const index = (integratedBlockStart + integratedBlockLength) % MAX_INTEGRATED_BLOCKS;
        integratedBlocks[index] = ms;
        integratedBlockWindows[index] = gatingWindow;
        integratedBlockLength++;
      } else {
        removed = integratedBlocks[integratedBlockStart];
        // Observed windows are stamped from one upwards, so the seed's own
        // entries are the ones the ring gives back with a stamp of zero.
        if (integratedBlockWindows[integratedBlockStart] === 0) seedEntriesInRing--;
        integratedBlocks[integratedBlockStart] = ms;
        integratedBlockWindows[integratedBlockStart] = gatingWindow;
        integratedBlockStart = (integratedBlockStart + 1) % MAX_INTEGRATED_BLOCKS;
      }
      if (removed >= ABSOLUTE_GATE_MEAN_SQUARE) {
        absoluteGatedRoot = removeTreeValue(absoluteGatedRoot, removed);
      }
      if (ms >= ABSOLUTE_GATE_MEAN_SQUARE) {
        absoluteGatedRoot = insertTreeValue(absoluteGatedRoot, ms);
      }
    }

    // The value, and the windows a later session would seed with if it were
    // stored now. The seed's entries stand for the count it was told rather
    // than for however many were laid down to weigh it.
    function integratedLufs() {
      const absoluteGatedCount = treeCount(absoluteGatedRoot);
      if (absoluteGatedCount === 0) return { lufs: -Infinity, windows: 0 };
      const absoluteMeanSquare = treeSum(absoluteGatedRoot) / absoluteGatedCount;
      const relativeGate = absoluteMeanSquare * RELATIVE_GATE_FACTOR;
      const gated = treeValuesAtOrAbove(absoluteGatedRoot, relativeGate);
      if (gated.count === 0) return { lufs: -Infinity, windows: 0 };
      const seedInGate = seedMeanSquare !== null &&
        seedMeanSquare >= ABSOLUTE_GATE_MEAN_SQUARE && seedMeanSquare >= relativeGate
        ? seedEntriesInRing
        : 0;
      const windows = Math.min(seedClaimedWindows, seedInGate) + (gated.count - seedInGate);
      return {
        lufs: meanSquareToLufs(gated.sum / gated.count),
        windows: Math.min(MAX_SEED_WINDOWS, windows)
      };
    }

    // A block of the worklet's, already referenced to the level it is measured
    // at. hold keeps its gating window out of Integrated and leaves the
    // boundary skip where it is. The answer carries the window the block
    // completed (null before there is one) and whether the boundary skip took
    // it.
    function addBlock(ms, hold) {
      blocks.push(ms);
      if (blocks.length > Math.max(MOMENTARY_BLOCKS, SHORT_BLOCKS) * 4) {
        blocks.splice(0, blocks.length - SHORT_BLOCKS * 4);
      }
      const momentary = blocksToLufs(blocks, MOMENTARY_BLOCKS);
      const shortTerm = blocksToLufs(blocks, SHORT_BLOCKS);
      const window = blocksMeanSquare(blocks, GATE_BLOCKS);
      // Credit is spent on windows, so a reset that empties the sub-block
      // buffer does not consume it before a window exists.
      if (window !== null) windowsObserved++;
      const skipBoundary = boundarySkipBlocks > 0 && window !== null;
      const skipped = skipBoundary && !hold;
      if (skipped) boundarySkipBlocks--;
      if (!hold && !skipBoundary && window !== null) {
        appendIntegratedBlock(window, windowsObserved);
        windowsSinceReset++;
      }
      return { momentary, shortTerm, window, skipped, integrated: integratedLufs() };
    }

    // The windows from firstWindow onward that are in the ring. Newest first,
    // so it stops at the first window the span does not reach.
    function appendedWindowsSince(firstWindow) {
      let count = 0;
      while (count < integratedBlockLength) {
        const index = (integratedBlockStart + integratedBlockLength - 1 - count) % MAX_INTEGRATED_BLOCKS;
        if (integratedBlockWindows[index] < firstWindow) break;
        count++;
      }
      return count;
    }

    // Only windows appended since the last reset are removable. Removing the
    // newest entry frees the slot the next append reuses, so a full ring is
    // no different; what the eviction took stays gone either way. The answer
    // is the mean square of each window removed, oldest first.
    function removeRecentWindows(count) {
      const removed = [];
      while (removed.length < count && windowsSinceReset > 0 && integratedBlockLength > 0) {
        const index = (integratedBlockStart + integratedBlockLength - 1) % MAX_INTEGRATED_BLOCKS;
        const ms = integratedBlocks[index];
        if (ms >= ABSOLUTE_GATE_MEAN_SQUARE) {
          absoluteGatedRoot = removeTreeValue(absoluteGatedRoot, ms);
        }
        integratedBlockLength--;
        windowsSinceReset--;
        removed.push(ms);
      }
      return removed.reverse();
    }

    // Empties the measurement and seeds it from a saved value, where one is
    // given, as the number of windows the saved value stands on or the floor
    // where that is less. The seed's entries carry a window stamp below every
    // observed window, so a removal of recent windows does not reach them. A
    // seed below the absolute gate reaches the ring but not the index, so it
    // never contributes to Integrated. A boundary skip in progress is not
    // part of the measurement and runs on.
    function reset(initialIntegratedLufs, initialIntegratedWindows) {
      blocks.length = 0;
      integratedBlockStart = 0;
      integratedBlockLength = 0;
      absoluteGatedRoot = null;
      windowsSinceReset = 0;
      windowsObserved = 0;
      seedClaimedWindows = 0;
      seedMeanSquare = null;
      seedEntriesInRing = 0;
      if (!Number.isFinite(initialIntegratedLufs)) return;
      const initialMeanSquare = Math.pow(10, (initialIntegratedLufs + 0.691) / 10);
      if (!Number.isFinite(initialMeanSquare)) return;
      seedClaimedWindows = savedWindowCount(initialIntegratedWindows);
      seedMeanSquare = initialMeanSquare;
      const seedWindows = Math.max(MIN_SEED_WINDOWS, seedClaimedWindows);
      for (let i = 0; i < seedWindows; i++) {
        appendIntegratedBlock(initialMeanSquare, windowsObserved);
      }
      seedEntriesInRing = seedWindows;
    }

    return Object.freeze({
      addBlock,
      // The next gating window starts from the next block: the blocks so far
      // are dropped, Integrated is kept.
      clearBlocks() { blocks.length = 0; },
      // The next BOUNDARY_SKIP_BLOCKS windows stay out of Integrated, counted
      // again from the full number where a skip is already running.
      skipBoundary() { boundarySkipBlocks = BOUNDARY_SKIP_BLOCKS; },
      boundaryWindowsLeft: () => boundarySkipBlocks,
      // The windows formed since the last reset, the first one being 1.
      windowsObserved: () => windowsObserved,
      windowsSinceReset: () => windowsSinceReset,
      appendedWindowsSince,
      removeRecentWindows,
      reset
    });
  }

  return Object.freeze({
    K_PRE_48K,
    K_RLB_48K,
    redesignBiquad,
    kForSampleRate,
    meanSquareToLufs,
    normalizeForVolume,
    BLOCK_SEC,
    MOMENTARY_BLOCKS,
    SHORT_BLOCKS,
    GATE_BLOCKS,
    MAX_INTEGRATED_BLOCKS,
    MIN_SEED_WINDOWS,
    MAX_SEED_WINDOWS,
    BOUNDARY_SKIP_BLOCKS,
    WORKLET_PROCESSOR,
    buildChain,
    createMeter
  });
})();
