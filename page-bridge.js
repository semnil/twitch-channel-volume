// page-bridge.js — Runs in MAIN world on Twitch pages.
// Owns the AudioContext, GainNode and K-weighted LUFS measurement pipeline.
// Twitch publishes no loudness metadata, so the bridge measures the playing
// <video> directly via Web Audio. It also hooks fetch to read Twitch's GraphQL
// responses for the authoritative user_id/login, and wraps the Worker
// constructor to hear the ad cues the player's own media engine posts.

(() => {
  'use strict';

  const MSG_OUT = '__twitch_channel_volume__';
  const MSG_IN = '__twitch_channel_volume_cmd__';
  const REF_RATE = 48000;

  // The page shares this window and can send the same commands content.js
  // sends, so the module to load is derived here instead of being received:
  // this script is served from the extension, and its own stack frames name
  // the origin it was served from.
  const SELF_ORIGIN = (() => {
    const found = /chrome-extension:\/\/[0-9a-z]+/.exec(new Error().stack || '');
    return found ? found[0] : '';
  })();
  const WORKLET_URL = SELF_ORIGIN ? `${SELF_ORIGIN}/audio-worklet.js` : '';

  const K_PRE_48K = {
    b: [1.53512485958697, -2.69169618940638, 1.19839281085285],
    a: [1.0, -1.69065929318241, 0.73248077421585]
  };
  const K_RLB_48K = {
    b: [1.0, -2.0, 1.0],
    a: [1.0, -1.99004745483398, 0.99007225036621]
  };

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

  function kForSampleRate(sr) {
    if (Math.abs(sr - REF_RATE) < 1) return { pre: K_PRE_48K, rlb: K_RLB_48K };
    return {
      pre: redesignBiquad(K_PRE_48K, REF_RATE, sr),
      rlb: redesignBiquad(K_RLB_48K, REF_RATE, sr)
    };
  }

  function msToLufs(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return -Infinity;
    return -0.691 + 10 * Math.log10(ms);
  }

  let ctx = null;
  let gain = null;
  let sourceNode = null;
  let attachedVideo = null;
  let workletReady = false;
  let workletNode = null;
  let baselineGain = 1.0;
  let adGainOffset = 1.0;
  let adActive = false;
  let domAdActive = false;
  // The media times the player's cues gave for the break it is playing, and
  // whether any cue has been accepted for this media.
  let adBreakStartMedia = Infinity;
  let adBreakEndMedia = -Infinity;
  // The cue said another creative of the pod follows the one it named.
  let adPodPending = false;
  let adCueSeen = false;
  let attachTimer = null;
  const attachFailedFor = new WeakSet();
  // Elements another script holds. They keep the gain node out of the player's
  // audio path even after a different element attaches.
  const takenVideos = [];
  let contextFailureReported = false;
  let reportedTakenElsewhere = false;
  let attachAttempts = 0;

  const blocks = [];
  const BLOCK_SEC = 0.1;
  const MOMENTARY_BLOCKS = 4;
  const SHORT_BLOCKS = 30;
  // BS.1770-4 gates 400ms blocks overlapping by 75%: one gating window per
  // 100ms sub-block, formed from the most recent GATE_BLOCKS sub-blocks.
  const GATE_BLOCKS = 4;
  const MAX_INTEGRATED_BLOCKS = 60 * 60 * 10;
  // A gating window that spans the end of an ad or a volume change carries
  // audio it cannot represent. Windows stay out of Integrated until they are
  // clear of the boundary.
  const BOUNDARY_SKIP_BLOCKS = GATE_BLOCKS;
  let boundarySkipBlocks = 0;
  let boundarySkipReason = '';
  let boundarySkipDropped = 0;
  let boundarySkipLufs = [];
  let lastVolumeState = '';
  // The ad marker appears in the DOM after the ad's first audio, so the windows
  // appended just before it are removed again. The count covers the observed
  // marker delay and no more: content windows removed beyond it take their own
  // level out of the gate's population, which moves the result.
  const AD_START_ROLLBACK_BLOCKS = 5;
  const ROLLBACK_LOG_SAMPLES = 8;
  let windowsSinceReset = 0;
  // A window the boundary skip dropped was never appended, so a rollback that
  // spans it has nothing there to take back. The indices of the dropped ones
  // say how many of the windows the rollback spans are already out.
  const SKIPPED_WINDOW_HISTORY = 64;
  let windowsObserved = 0;
  let skippedWindows = [];
  const ABSOLUTE_GATE_MEAN_SQUARE = Math.pow(10, (-70 + 0.691) / 10);
  const RELATIVE_GATE_FACTOR = Math.pow(10, -10 / 10);
  const integratedBlocks = new Array(MAX_INTEGRATED_BLOCKS);
  let integratedBlockStart = 0;
  let integratedBlockLength = 0;
  let absoluteGatedRoot = null;
  // Stamped onto every posted measurement so content.js can drop blocks that
  // the bridge produced before it handled the matching reset command.
  let measurementEpoch = 0;

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

  function appendIntegratedBlock(ms) {
    let removed;
    if (integratedBlockLength < MAX_INTEGRATED_BLOCKS) {
      const index = (integratedBlockStart + integratedBlockLength) % MAX_INTEGRATED_BLOCKS;
      integratedBlocks[index] = ms;
      integratedBlockLength++;
    } else {
      removed = integratedBlocks[integratedBlockStart];
      integratedBlocks[integratedBlockStart] = ms;
      integratedBlockStart = (integratedBlockStart + 1) % MAX_INTEGRATED_BLOCKS;
    }
    if (removed >= ABSOLUTE_GATE_MEAN_SQUARE) {
      absoluteGatedRoot = removeTreeValue(absoluteGatedRoot, removed);
    }
    if (ms >= ABSOLUTE_GATE_MEAN_SQUARE) {
      absoluteGatedRoot = insertTreeValue(absoluteGatedRoot, ms);
    }
  }

  function postReady(extra) {
    window.postMessage({
      type: MSG_OUT,
      event: 'ready',
      sampleRate: ctx?.sampleRate || null,
      videoConnected: !!sourceNode,
      ...extra
    }, '*');
  }

  function postLufs(momentary, shortTerm, integrated) {
    window.postMessage({
      type: MSG_OUT,
      event: 'lufs',
      epoch: measurementEpoch,
      momentary,
      shortTerm,
      integrated
    }, '*');
  }

  function postAd(active) {
    window.postMessage({
      type: MSG_OUT,
      event: 'ad',
      active
    }, '*');
  }

  function postOwner(info) {
    window.postMessage({
      type: MSG_OUT,
      event: 'owner',
      ...info
    }, '*');
  }

  function volumeState(video) {
    return video ? `${video.volume}|${video.muted}` : '';
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
    return msToLufs(sum / n);
  }

  function integratedLufs() {
    const absoluteGatedCount = treeCount(absoluteGatedRoot);
    if (absoluteGatedCount === 0) return -Infinity;
    const absoluteMeanSquare = treeSum(absoluteGatedRoot) / absoluteGatedCount;
    const relativeGate = absoluteMeanSquare * RELATIVE_GATE_FACTOR;
    const gated = treeValuesAtOrAbove(absoluteGatedRoot, relativeGate);
    return gated.count === 0 ? -Infinity : msToLufs(gated.sum / gated.count);
  }

  function updateIntegratedLufs(ms) {
    appendIntegratedBlock(ms);
    windowsSinceReset++;
    return integratedLufs();
  }

  // Only windows appended since the last reset are removable. Removing the
  // newest entry frees the slot the next append reuses, so a full ring is no
  // different; what the eviction took stays gone either way.
  function removeRecentIntegratedBlocks(count) {
    const removed = [];
    while (removed.length < count && windowsSinceReset > 0 && integratedBlockLength > 0) {
      const index = (integratedBlockStart + integratedBlockLength - 1) % MAX_INTEGRATED_BLOCKS;
      const ms = integratedBlocks[index];
      if (ms >= ABSOLUTE_GATE_MEAN_SQUARE) {
        absoluteGatedRoot = removeTreeValue(absoluteGatedRoot, ms);
      }
      integratedBlockLength--;
      windowsSinceReset--;
      removed.push(Number(msToLufs(ms).toFixed(2)));
    }
    return removed.reverse();
  }

  function resetMeasurement(initialIntegratedLufs, epoch) {
    if (Number.isFinite(epoch)) measurementEpoch = epoch;
    blocks.length = 0;
    integratedBlockStart = 0;
    integratedBlockLength = 0;
    absoluteGatedRoot = null;
    windowsSinceReset = 0;
    windowsObserved = 0;
    skippedWindows = [];
    if (!Number.isFinite(initialIntegratedLufs)) return;
    const initialMeanSquare = Math.pow(10, (initialIntegratedLufs + 0.691) / 10);
    if (!Number.isFinite(initialMeanSquare)) return;
    // Values below the absolute gate reach the ring buffer but not the index,
    // so they never contribute to Integrated.
    appendIntegratedBlock(initialMeanSquare);
  }

  let ctxPromise = null;
  async function ensureContext() {
    if (ctxPromise) return ctxPromise;
    ctxPromise = createContext();
    const created = await ctxPromise;
    // A failed attempt is not cached: the next call builds its own context.
    if (!created) ctxPromise = null;
    return created;
  }

  async function createContext() {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) {
      console.warn('[TCV] Web Audio is unavailable in this page');
      return null;
    }
    try {
      ctx = new C();
      gain = ctx.createGain();
      gain.gain.value = baselineGain;
      gain.connect(ctx.destination);
      // The retry can land mid-ad, and baselineGain alone is the content level.
      applyEffectiveGain();
    } catch (err) {
      console.warn('[TCV] audio context unavailable', err);
      ctx = null;
      gain = null;
      return null;
    }
    if (WORKLET_URL) {
      try {
        await ctx.audioWorklet.addModule(WORKLET_URL);
        workletReady = true;
        console.info('[TCV] worklet module loaded');
      } catch (err) {
        console.warn('[TCV] worklet load failed', err);
      }
    }
    return ctx;
  }

  function buildMeasurementChain(c) {
    if (!workletReady || workletNode || !sourceNode) return;
    try {
      const { pre, rlb } = kForSampleRate(c.sampleRate);
      const preNode = c.createIIRFilter(pre.b, pre.a);
      const rlbNode = c.createIIRFilter(rlb.b, rlb.a);
      workletNode = new AudioWorkletNode(c, 'k-mean-square', {
        processorOptions: { blockSec: BLOCK_SEC }
      });
      workletNode.port.onmessage = onBlockMs;
      sourceNode.connect(preNode);
      preNode.connect(rlbNode);
      rlbNode.connect(workletNode);
      // Terminate the measurement path without contributing to output.
      const silentGain = c.createGain();
      silentGain.gain.value = 0;
      workletNode.connect(silentGain);
      silentGain.connect(c.destination);
      console.info('[TCV] measurement chain ready');
    } catch (err) {
      console.warn('[TCV] measurement chain failed', err);
    }
  }

  function heldAsAdElement(video) {
    return adElementChains.some((chain) => chain.video === video);
  }

  function findVideo() {
    const all = document.querySelectorAll('video');
    let best = null;
    for (const v of all) {
      if (attachFailedFor.has(v) || heldAsAdElement(v)) continue;
      if (!v.src && v.readyState === 0) continue;
      if (!best || (v.clientWidth * v.clientHeight) > (best.clientWidth * best.clientHeight)) {
        best = v;
      }
    }
    if (best) return best;
    for (const v of all) {
      if (!attachFailedFor.has(v) && !heldAsAdElement(v)) return v;
    }
    return null;
  }

  // Elements pruned as they leave the page: a held element that is gone no
  // longer stands between the gain node and the player.
  function takenVideoPresent() {
    for (let i = takenVideos.length - 1; i >= 0; i--) {
      if (!takenVideos[i].isConnected) takenVideos.splice(i, 1);
    }
    return takenVideos.length > 0;
  }

  function postAttached() {
    reportedTakenElsewhere = takenVideoPresent();
    postReady({
      event: 'attached',
      measuring: !!workletNode,
      takenElsewhere: reportedTakenElsewhere
    });
  }

  function clearStaleAttachment() {
    if (attachedVideo && !attachedVideo.isConnected) {
      console.info('[TCV] previous video detached from DOM; resetting attachment');
      try { sourceNode?.disconnect(); } catch (_) {}
      try { workletNode?.disconnect(); } catch (_) {}
      attachedVideo.removeEventListener('volumechange', onVolumeChange);
      attachedVideo = null;
      lastVolumeState = '';
      forgetCues();
      sourceNode = null;
      workletNode = null;
      updateAdState();
      // The element that replaces it needs the loop that first attached.
      scheduleAttach();
    }
  }

  function scheduleAttach() {
    if (attachTimer) return;
    const tick = async () => {
      clearStaleAttachment();
      if (attachedVideo) {
        stopAttachLoop();
        return;
      }
      const v = findVideo();
      if (!v) {
        attachAttempts++;
        if (attachAttempts === 1 || attachAttempts % 10 === 0) {
          if (takenVideoPresent()) {
            console.info('[TCV] no attachable <video>; the player audio is held elsewhere (attempt', attachAttempts, ')');
          } else {
            console.info('[TCV] waiting for <video> element (attempt', attachAttempts, ')');
          }
        }
        return;
      }
      attachAttempts = 0;
      try {
        await attach(v);
      } catch (err) {
        console.warn('[TCV] attach failed', err);
      }
      if (attachedVideo) stopAttachLoop();
    };
    attachTimer = setInterval(tick, 1000);
    tick();
  }

  function stopAttachLoop() {
    if (attachTimer) {
      clearInterval(attachTimer);
      attachTimer = null;
    }
  }

  function syncAttachment() {
    clearStaleAttachment();
    // A held element can leave the page after the attach that reported it.
    if (attachedVideo && takenVideoPresent() !== reportedTakenElsewhere) postAttached();
  }

  setInterval(syncAttachment, 2000);

  async function attach(video) {
    if (!video || attachedVideo === video) return;
    const c = await ensureContext();
    // Another tick can finish this attach while the context is still being
    // built. The element is ours by then, and taking it again throws.
    if (attachedVideo) return;
    if (!c) {
      if (!contextFailureReported) {
        contextFailureReported = true;
        postReady({
          event: 'attach-failed',
          cause: 'audio-context',
          reason: 'audio context unavailable'
        });
      }
      return;
    }
    contextFailureReported = false;
    try {
      sourceNode = c.createMediaElementSource(video);
    } catch (err) {
      attachFailedFor.add(video);
      takenVideos.push(video);
      console.warn('[TCV] createMediaElementSource failed (possibly already attached by another extension)', err);
      postReady({
        event: 'attach-failed',
        cause: 'element-taken',
        reason: String(err?.message || err)
      });
      return;
    }
    sourceNode.connect(gain);
    attachedVideo = video;
    // A gating window must not span two media elements.
    blocks.length = 0;
    lastVolumeState = volumeState(video);
    video.addEventListener('volumechange', onVolumeChange);
    console.info('[TCV] attached to video', {
      sampleRate: c.sampleRate,
      state: c.state,
      videoTime: Number(video.currentTime.toFixed(3)),
      volume: video.volume
    });

    if (workletReady) {
      buildMeasurementChain(c);
    } else {
      console.warn('[TCV] worklet not ready yet; will wire measurement chain after load');
    }
    postAttached();
  }

  let receivedFirstBlock = false;

  // The measurement taps the element ahead of the player's own volume, so the
  // viewer's volume setting scales it. Measurements are referenced to volume 1.
  function normalizeForVolume(ms) {
    const volume = attachedVideo?.volume;
    if (!Number.isFinite(volume) || volume <= 0 || volume >= 1) return ms;
    return ms / (volume * volume);
  }

  function onBlockMs(ev) {
    const raw = ev.data?.ms;
    if (!Number.isFinite(raw)) return;
    if (!receivedFirstBlock) {
      receivedFirstBlock = true;
      console.info('[TCV] first measurement block received');
    }
    const ms = normalizeForVolume(raw);
    blocks.push(ms);
    if (blocks.length > Math.max(MOMENTARY_BLOCKS, SHORT_BLOCKS) * 4) {
      blocks.splice(0, blocks.length - SHORT_BLOCKS * 4);
    }
    const mom = blocksToLufs(blocks, MOMENTARY_BLOCKS);
    const st = blocksToLufs(blocks, SHORT_BLOCKS);
    const gateWindow = blocksMeanSquare(blocks, GATE_BLOCKS);
    // The playhead passing the end the cue gave is what ends a break, so the
    // state is re-read on every block.
    updateAdState();
    if (adActive || adElementChains.length) syncAdElementGains();
    // Credit is spent on windows, so a reset that empties the sub-block buffer
    // does not consume it before a window exists.
    if (gateWindow !== null) windowsObserved++;
    const skipBoundary = boundarySkipBlocks > 0 && gateWindow !== null;
    if (skipBoundary && !adActive) {
      boundarySkipBlocks--;
      boundarySkipDropped++;
      skippedWindows.push(windowsObserved);
      if (skippedWindows.length > SKIPPED_WINDOW_HISTORY) skippedWindows.shift();
      boundarySkipLufs.push(Number(msToLufs(gateWindow).toFixed(2)));
      if (boundarySkipLufs.length > BOUNDARY_SKIP_BLOCKS) boundarySkipLufs.shift();
      if (boundarySkipBlocks === 0) {
        console.info('[TCV] gate resumed', {
          reason: boundarySkipReason,
          dropped: boundarySkipDropped,
          windowLufs: boundarySkipLufs
        });
      }
    }
    const intg = (adActive || skipBoundary || gateWindow === null)
      ? integratedLufs()
      : updateIntegratedLufs(gateWindow);
    postLufs(mom, st, intg);
  }

  // A slider drag fires volumechange per step. Report the start of a skip and
  // its end, not every step and every window.
  function armBoundarySkip(reason) {
    if (boundarySkipBlocks === 0 || boundarySkipReason !== reason) {
      // A skip cut short by a different boundary never reports its own total.
      const superseded = boundarySkipBlocks > 0
        ? { superseded: boundarySkipReason, droppedBefore: boundarySkipDropped }
        : null;
      boundarySkipDropped = 0;
      boundarySkipLufs = [];
      console.info('[TCV] gate boundary', {
        reason,
        adActive,
        volume: attachedVideo ? attachedVideo.volume : null,
        muted: attachedVideo ? attachedVideo.muted : null,
        videoTime: attachedVideo ? Number(attachedVideo.currentTime.toFixed(3)) : null,
        ...(superseded || {})
      });
    }
    boundarySkipBlocks = BOUNDARY_SKIP_BLOCKS;
    boundarySkipReason = reason;
  }

  // volumechange also fires when the player rewrites the value it already had.
  // Only an actual change alters the tapped signal.
  function onVolumeChange() {
    const state = volumeState(attachedVideo);
    if (state === lastVolumeState) return;
    lastVolumeState = state;
    armBoundarySkip('volume');
  }

  function setGain(value) {
    baselineGain = Math.max(0, Math.min(6, Number(value) || 1));
    applyEffectiveGain();
  }

  function setAdGainOffset(value) {
    adGainOffset = Math.max(0, Math.min(6, Number(value) || 1));
    applyEffectiveGain();
  }

  function applyEffectiveGain() {
    if (!gain || !ctx) return;
    const effective = adActive ? baselineGain * adGainOffset : baselineGain;
    gain.gain.setTargetAtTime(effective, ctx.currentTime, 0.02);
  }

  const AD_CUE_LEAD_SEC = 1;
  // The cue for the next creative of a pod arrives shortly after the one before
  // it ended, and the break is held that long rather than closing between them.
  const AD_POD_GAP_SEC = 0.4;

  // The cue names the break in the media timeline of the element that is being
  // measured, so the break runs from the start it gave until the playhead
  // passes the end.
  function playerBreakActive() {
    const position = attachedVideo?.currentTime;
    if (!Number.isFinite(position) || position < adBreakStartMedia) return false;
    if (position < adBreakEndMedia) return true;
    return adPodPending && position < adBreakEndMedia + AD_POD_GAP_SEC;
  }

  function forgetCuedBreak() {
    adBreakStartMedia = Infinity;
    adBreakEndMedia = -Infinity;
    adPodPending = false;
  }

  // A cue's times belong to one element's timeline, and whether the media is
  // cued at all is unknown again once that element changes.
  function forgetCues() {
    adCueSeen = false;
    forgetCuedBreak();
  }

  // The cue arrives a little after the break's first audio, and the windows
  // appended over that distance are the ones holding it.
  function adStartRollbackBlocks() {
    const position = attachedVideo?.currentTime;
    if (!adCueSeen || !Number.isFinite(position) || !Number.isFinite(adBreakStartMedia)) {
      return AD_START_ROLLBACK_BLOCKS;
    }
    return 1 + Math.floor(Math.max(0, position - adBreakStartMedia) / BLOCK_SEC);
  }

  // The player's cue names the break with its first audio and ends it on time;
  // the DOM indicator does neither, so it only stands in where no cue arrives,
  // which is where a VOD's client-side ad lives.
  function adWanted() {
    return adCueSeen ? playerBreakActive() : domAdActive;
  }

  // The windows the boundary skip dropped inside the span the rollback covers.
  function skippedWithinSpan(requested) {
    const spanStart = windowsObserved - requested;
    let overlap = 0;
    for (let i = skippedWindows.length - 1; i >= 0 && skippedWindows[i] > spanStart; i--) {
      overlap++;
    }
    return overlap;
  }

  function rollBackAdStart(blocks) {
    const requested = Math.max(0, blocks);
    // Asking for a window the boundary skip already kept out takes a content
    // window in its place, and that window's level leaves the gate with it.
    const skipped = skippedWithinSpan(requested);
    const wanted = Math.max(0, requested - skipped);
    const removed = removeRecentIntegratedBlocks(wanted);
    const half = ROLLBACK_LOG_SAMPLES / 2;
    const truncated = removed.length > ROLLBACK_LOG_SAMPLES;
    console.info('[TCV] ad start rollback', {
      removed: removed.length,
      requested,
      skipped,
      // At the budget the removal stopped short of the ad's own start.
      exhausted: wanted > 0 && removed.length === wanted,
      windowsSinceReset,
      windowLufs: truncated
        ? [...removed.slice(0, half), ...removed.slice(-half)]
        : removed,
      ...(truncated ? { truncated: true } : {})
    });
  }

  function updateAdState() {
    const wanted = adWanted();
    if (wanted === adActive) return;
    adActive = wanted;
    if (adActive) {
      rollBackAdStart(adStartRollbackBlocks());
    } else {
      // The break the cue named is behind the playhead; moving back into it
      // must not open it again.
      forgetCuedBreak();
      armBoundarySkip('ad-end');
    }
    applyEffectiveGain();
    syncAdElementGains();
    postAd(adActive);
  }

  function setDomAdActive(active) {
    if (domAdActive === !!active) return;
    domAdActive = !!active;
    updateAdState();
  }

  // ── Ad breaks: the player's own cues ────────────────────────────────
  // The player runs its media engine in a worker and posts a cue for each ad it
  // is about to play. The Worker constructor is wrapped only to listen; the
  // worker is created from the argument the page passed, untouched.

  function onPlayerWorkerMessage(event) {
    const cue = event.data?.arg;
    if (!cue || typeof cue !== 'object') return;
    if (typeof cue.rollType !== 'string') return;
    const { startTime, endTime } = cue;
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return;
    if (endTime <= startTime) return;
    const position = attachedVideo?.currentTime;
    if (!Number.isFinite(position)) return;
    // A second player runs during a break and cues its own ads; the cue that
    // belongs to the element being measured is the one holding its playhead.
    if (position < startTime - AD_CUE_LEAD_SEC || position >= endTime) return;
    adCueSeen = true;
    // Only a cue that says it is the last of its pod closes it; anything else
    // leaves the break open for a creative that may still be cued.
    adPodPending = !(Number.isFinite(cue.podPosition)
      && Number.isFinite(cue.podCount)
      && cue.podPosition >= cue.podCount - 1);
    if (endTime <= adBreakEndMedia) return;
    // The start belongs to the cue that opened the break; the ones that follow
    // it in the same pod only push the end out.
    if (adBreakEndMedia === -Infinity) adBreakStartMedia = startTime;
    adBreakEndMedia = endTime;
    console.info('[TCV] ad cue from the player', {
      rollType: cue.rollType,
      startTime: Number(startTime.toFixed(3)),
      endTime: Number(endTime.toFixed(3)),
      videoTime: Number(position.toFixed(3)),
      pod: `${cue.podPosition}/${cue.podCount}`
    });
    updateAdState();
  }

  function installWorkerHook() {
    const NativeWorker = window.Worker;
    if (typeof NativeWorker !== 'function') return;
    try {
      window.Worker = class extends NativeWorker {
        constructor(url, options) {
          super(url, options);
          this.addEventListener('message', onPlayerWorkerMessage);
        }
      };
    } catch (err) {
      // The rest of the bridge runs after this; an unwritable Worker must not
      // take the measurement down with it.
      console.warn('[TCV] Worker constructor could not be wrapped; ads are detected from the DOM alone', err);
    }
  }

  installWorkerHook();

  // ── Ad breaks: the element a client-side ad plays in ────────────────
  // A VOD ad is a second element playing at its own volume while the element
  // being measured is paused, so the ad gain has to reach it and cancel the
  // difference between the two volumes.

  const adElementChains = [];

  function attachAdElement(video) {
    if (!ctx || ctx.state !== 'running' || attachFailedFor.has(video)) return null;
    try {
      const source = ctx.createMediaElementSource(video);
      const node = ctx.createGain();
      node.gain.value = 1;
      source.connect(node);
      node.connect(ctx.destination);
      const chain = { video, source, node };
      adElementChains.push(chain);
      console.info('[TCV] ad element attached', {
        volume: video.volume,
        playerVolume: attachedVideo ? attachedVideo.volume : null
      });
      return chain;
    } catch (err) {
      attachFailedFor.add(video);
      console.warn('[TCV] ad element could not be attached', err);
      return null;
    }
  }

  function adElementGain(video) {
    const reference = attachedVideo?.volume;
    const own = video.volume;
    const match = (Number.isFinite(reference) && own > 0) ? reference / own : 1;
    return baselineGain * adGainOffset * match;
  }

  function syncAdElementGains() {
    if (!ctx) return;
    for (let i = adElementChains.length - 1; i >= 0; i--) {
      const chain = adElementChains[i];
      if (chain.video.isConnected) continue;
      try { chain.source.disconnect(); } catch (_) {}
      try { chain.node.disconnect(); } catch (_) {}
      adElementChains.splice(i, 1);
    }
    // Only a client-side ad leaves the measured element paused while another
    // element plays; a stitched ad stays in the element already attached.
    const clientSideAd = adActive && attachedVideo?.paused === true;
    if (clientSideAd) {
      for (const video of document.querySelectorAll('video')) {
        if (video === attachedVideo) continue;
        if (video.paused || video.muted || video.volume === 0) continue;
        if (heldAsAdElement(video)) continue;
        attachAdElement(video);
      }
    }
    for (const chain of adElementChains) {
      const value = clientSideAd ? adElementGain(chain.video) : 1;
      chain.node.gain.setTargetAtTime(value, ctx.currentTime, 0.02);
    }
  }

  // ── Fetch hook: GraphQL ─────────────────────────────────────────────

  function currentContentIdentity() {
    try {
      const url = new URL(location.href);
      const segs = url.pathname.split('/').filter(Boolean);
      if (segs[0] === 'videos' && segs[1]) return { kind: 'vod', id: segs[1] };
      if (segs.length >= 3 && segs[1] === 'clip') {
        return { kind: 'clip', id: segs[2] };
      }
      if (url.hostname === 'clips.twitch.tv' && segs[0]) {
        return { kind: 'clip', id: segs[0] };
      }
      if (segs.length === 1) return { kind: 'live', id: segs[0].toLowerCase() };
    } catch (_) {}
    return { kind: 'none', id: '' };
  }

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const requestIdentity = currentContentIdentity();
    const result = origFetch.apply(this, args);
    let url = '';
    try { url = (typeof args[0] === 'string') ? args[0] : (args[0]?.url || ''); } catch (_) {}

    if (url.includes('gql.twitch.tv')) {
      result.then((resp) => resp.clone().json()).then((data) => {
        extractOwnerFromGraphQL(data, requestIdentity);
      }).catch(() => {});
    }
    return result;
  };

  function extractOwnerFromGraphQL(payload, requestIdentity) {
    const items = Array.isArray(payload) ? payload : [payload];
    for (const item of items) {
      try {
        const data = item?.data;
        if (!data) continue;
        // VideoMetadata: data.video.owner.{id,login,displayName}
        const v = data.video;
        if (v?.owner?.id && v?.owner?.login) {
          postOwner({
            userId: String(v.owner.id),
            login: v.owner.login,
            displayName: v.owner.displayName || v.owner.login,
            source: 'video',
            contentKind: 'vod',
            contentId: v.id != null
              ? String(v.id)
              : (requestIdentity?.kind === 'vod' ? requestIdentity.id : '')
          });
        }
        // StreamMetadata / User: data.user.{id,login,displayName}
        const u = data.user;
        if (u?.id && u?.login) {
          postOwner({
            userId: String(u.id),
            login: u.login,
            displayName: u.displayName || u.login,
            source: 'user',
            contentKind: 'live',
            contentId: u.login.toLowerCase()
          });
        }
        // Clip
        const c = data.clip;
        if (c?.broadcaster?.id && c?.broadcaster?.login) {
          postOwner({
            userId: String(c.broadcaster.id),
            login: c.broadcaster.login,
            displayName: c.broadcaster.displayName || c.broadcaster.login,
            source: 'clip',
            contentKind: 'clip',
            contentId: typeof c.slug === 'string'
              ? c.slug
              : (requestIdentity?.kind === 'clip' ? requestIdentity.id : '')
          });
        }
      } catch (_) {}
    }
  }

  // ── Command listener (from content.js) ──────────────────────────────

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== MSG_IN) return;
    switch (data.cmd) {
      case 'init':
        if (!WORKLET_URL) console.error('[TCV] extension origin unavailable, measurement stays off');
        await ensureContext();
        postReady({ event: 'init-done' });
        break;
      case 'attach': {
        scheduleAttach();
        break;
      }
      case 'setGain':
        setGain(data.value);
        break;
      case 'setAdGain':
        setAdGainOffset(data.value);
        break;
      case 'setAdActive':
        setDomAdActive(data.active);
        break;
      case 'resetMeasurement':
        resetMeasurement(data.initialIntegratedLufs, data.epoch);
        break;
      case 'mediaChanged':
        // New media answers for itself: the old cues mean nothing against its
        // timeline, and the indicator is reported against it again by
        // content.js rather than carried over.
        forgetCues();
        domAdActive = false;
        updateAdState();
        break;
      case 'resume':
        try {
          await ctx?.resume();
          if (ctx && ctx.state !== 'running') {
            console.warn('[TCV] audio context stayed', ctx.state, 'after resume');
          }
        } catch (err) {
          console.warn('[TCV] audio context resume failed', err);
        }
        break;
    }
  });

  postReady({ event: 'loaded' });
})();
