// page-bridge.js — Runs in MAIN world on Twitch pages.
// Owns the AudioContext, GainNode and K-weighted LUFS measurement pipeline.
// Twitch publishes no loudness metadata, so the bridge measures the playing
// <video> directly via Web Audio. It also hooks fetch to capture HLS
// manifests (EXT-X-DATERANGE CLASS="twitch-stitched-ad") for ad detection
// and Twitch's GraphQL responses to learn the authoritative user_id/login.

(() => {
  'use strict';

  const MSG_OUT = '__twitch_channel_volume__';
  const MSG_IN = '__twitch_channel_volume_cmd__';
  const REF_RATE = 48000;

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

  let workletUrl = '';
  let ctx = null;
  let gain = null;
  let sourceNode = null;
  let attachedVideo = null;
  let workletReady = false;
  let workletNode = null;
  let baselineGain = 1.0;
  let adGainOffset = 1.0;
  let adActive = false;
  let attachTimer = null;
  const attachFailedFor = new WeakSet();
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

  function postAd(active, range) {
    window.postMessage({
      type: MSG_OUT,
      event: 'ad',
      active,
      range: range || null
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
    return integratedLufs();
  }

  function resetMeasurement(initialIntegratedLufs, epoch) {
    if (Number.isFinite(epoch)) measurementEpoch = epoch;
    blocks.length = 0;
    integratedBlockStart = 0;
    integratedBlockLength = 0;
    absoluteGatedRoot = null;
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
    ctxPromise = (async () => {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      ctx = new C();
      gain = ctx.createGain();
      gain.gain.value = baselineGain;
      gain.connect(ctx.destination);
      if (workletUrl) {
        try {
          await ctx.audioWorklet.addModule(workletUrl);
          workletReady = true;
          console.info('[TCV] worklet module loaded');
          // If we already attached before the worklet finished loading, wire
          // up the measurement chain retroactively.
          if (attachedVideo && sourceNode && !workletNode) {
            buildMeasurementChain(ctx);
          }
        } catch (err) {
          console.warn('[TCV] worklet load failed', err);
        }
      }
      return ctx;
    })();
    return ctxPromise;
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

  function findVideo() {
    const all = document.querySelectorAll('video');
    let best = null;
    for (const v of all) {
      if (attachFailedFor.has(v)) continue;
      if (!v.src && v.readyState === 0) continue;
      if (!best || (v.clientWidth * v.clientHeight) > (best.clientWidth * best.clientHeight)) {
        best = v;
      }
    }
    if (best) return best;
    for (const v of all) {
      if (!attachFailedFor.has(v)) return v;
    }
    return null;
  }

  function clearStaleAttachment() {
    if (attachedVideo && !attachedVideo.isConnected) {
      console.info('[TCV] previous video detached from DOM; resetting attachment');
      try { sourceNode?.disconnect(); } catch (_) {}
      try { workletNode?.disconnect(); } catch (_) {}
      attachedVideo.removeEventListener('volumechange', onVolumeChange);
      attachedVideo = null;
      lastVolumeState = '';
      sourceNode = null;
      workletNode = null;
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
          console.info('[TCV] waiting for <video> element (attempt', attachAttempts, ')');
        }
        return;
      }
      attachAttempts = 0;
      await attach(v);
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

  setInterval(clearStaleAttachment, 2000);

  async function attach(video) {
    if (!video || attachedVideo === video) return;
    const c = await ensureContext();
    if (!c) return;
    try {
      sourceNode = c.createMediaElementSource(video);
    } catch (err) {
      attachFailedFor.add(video);
      console.warn('[TCV] createMediaElementSource failed (possibly already attached by another extension)', err);
      postReady({ event: 'attach-failed', reason: String(err?.message || err) });
      return;
    }
    sourceNode.connect(gain);
    attachedVideo = video;
    lastVolumeState = volumeState(video);
    video.addEventListener('volumechange', onVolumeChange);
    console.info('[TCV] attached to video', { sampleRate: c.sampleRate, state: c.state });

    if (workletReady) {
      buildMeasurementChain(c);
    } else {
      console.warn('[TCV] worklet not ready yet; will wire measurement chain after load');
    }
    postReady({ event: 'attached' });
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
    // Credit is spent on windows, so a reset that empties the sub-block buffer
    // does not consume it before a window exists.
    const skipBoundary = boundarySkipBlocks > 0 && gateWindow !== null;
    if (skipBoundary && !adActive) {
      boundarySkipBlocks--;
      boundarySkipDropped++;
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
      boundarySkipDropped = 0;
      boundarySkipLufs = [];
      console.info('[TCV] gate boundary', {
        reason,
        blocks: BOUNDARY_SKIP_BLOCKS,
        adActive,
        volume: attachedVideo ? attachedVideo.volume : null,
        muted: attachedVideo ? attachedVideo.muted : null,
        videoTime: attachedVideo ? Number(attachedVideo.currentTime.toFixed(3)) : null
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

  function setAdActive(active, range) {
    if (adActive === !!active) return;
    adActive = !!active;
    if (!adActive) armBoundarySkip('ad-end');
    applyEffectiveGain();
    postAd(adActive, range);
  }

  // ── Fetch hook: HLS manifests + GraphQL ─────────────────────────────

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

    if (url.includes('usher.ttvnw.net') || url.endsWith('.m3u8')) {
      result.then((resp) => resp.clone().text()).then((text) => {
        parseManifestForAds(text);
      }).catch(() => {});
    } else if (url.includes('gql.twitch.tv')) {
      result.then((resp) => resp.clone().json()).then((data) => {
        extractOwnerFromGraphQL(data, requestIdentity);
      }).catch(() => {});
    }
    return result;
  };

  function parseManifestForAds(text) {
    if (typeof text !== 'string') return;
    const ranges = [];
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith('#EXT-X-DATERANGE:')) continue;
      const attrs = {};
      const body = line.slice('#EXT-X-DATERANGE:'.length);
      const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
      let m;
      while ((m = re.exec(body)) !== null) {
        attrs[m[1]] = m[3] !== undefined ? m[3] : m[2];
      }
      const isAd = attrs.CLASS === 'twitch-stitched-ad'
        || (typeof attrs.ID === 'string' && attrs.ID.startsWith('stitched-ad-'));
      if (isAd) ranges.push(attrs);
    }
    if (ranges.length > 0) {
      window.postMessage({
        type: MSG_OUT,
        event: 'manifest-ad',
        ranges
      }, '*');
    }
  }

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
        workletUrl = data.workletUrl || '';
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
        setAdActive(data.active, data.range);
        break;
      case 'resetMeasurement':
        resetMeasurement(data.initialIntegratedLufs, data.epoch);
        break;
      case 'resume':
        try { await ctx?.resume(); } catch (_) {}
        break;
    }
  });

  postReady({ event: 'loaded' });
})();
