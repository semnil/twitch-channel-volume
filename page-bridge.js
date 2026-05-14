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
  const MAX_BLOCKS = 60 * 60 * 10;
  const integratedBlocks = [];

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

  function blocksToLufs(list, count) {
    if (list.length === 0) return -Infinity;
    const n = Math.min(count, list.length);
    let sum = 0;
    for (let i = list.length - n; i < list.length; i++) sum += list[i];
    return msToLufs(sum / n);
  }

  function integratedLufs() {
    if (integratedBlocks.length === 0) return -Infinity;
    const ABS_GATE_MS = Math.pow(10, (-70 + 0.691) / 10);
    const passAbs = integratedBlocks.filter((v) => v >= ABS_GATE_MS);
    if (passAbs.length === 0) return -Infinity;
    const meanAbs = passAbs.reduce((s, v) => s + v, 0) / passAbs.length;
    const relGateLufs = msToLufs(meanAbs) - 10;
    const relGateMs = Math.pow(10, (relGateLufs + 0.691) / 10);
    const passRel = passAbs.filter((v) => v >= relGateMs);
    if (passRel.length === 0) return -Infinity;
    const meanRel = passRel.reduce((s, v) => s + v, 0) / passRel.length;
    return msToLufs(meanRel);
  }

  function resetMeasurement() {
    blocks.length = 0;
    integratedBlocks.length = 0;
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
      attachedVideo = null;
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
    console.info('[TCV] attached to video', { sampleRate: c.sampleRate, state: c.state });

    if (workletReady) {
      buildMeasurementChain(c);
    } else {
      console.warn('[TCV] worklet not ready yet; will wire measurement chain after load');
    }
    postReady({ event: 'attached' });
  }

  let receivedFirstBlock = false;

  function onBlockMs(ev) {
    const ms = ev.data?.ms;
    if (!Number.isFinite(ms)) return;
    if (!receivedFirstBlock) {
      receivedFirstBlock = true;
      console.info('[TCV] first measurement block received');
    }
    blocks.push(ms);
    if (blocks.length > Math.max(MOMENTARY_BLOCKS, SHORT_BLOCKS) * 4) {
      blocks.splice(0, blocks.length - SHORT_BLOCKS * 4);
    }
    if (!adActive) {
      integratedBlocks.push(ms);
      if (integratedBlocks.length > MAX_BLOCKS) integratedBlocks.shift();
    }
    const mom = blocksToLufs(blocks, MOMENTARY_BLOCKS);
    const st = blocksToLufs(blocks, SHORT_BLOCKS);
    const intg = integratedLufs();
    postLufs(mom, st, intg);
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
    applyEffectiveGain();
    postAd(adActive, range);
  }

  // ── Fetch hook: HLS manifests + GraphQL ─────────────────────────────

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const result = origFetch.apply(this, args);
    let url = '';
    try { url = (typeof args[0] === 'string') ? args[0] : (args[0]?.url || ''); } catch (_) {}

    if (url.includes('usher.ttvnw.net') || url.endsWith('.m3u8')) {
      result.then((resp) => resp.clone().text()).then((text) => {
        parseManifestForAds(text);
      }).catch(() => {});
    } else if (url.includes('gql.twitch.tv')) {
      result.then((resp) => resp.clone().json()).then((data) => {
        extractOwnerFromGraphQL(data);
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

  function extractOwnerFromGraphQL(payload) {
    const items = Array.isArray(payload) ? payload : [payload];
    for (const item of items) {
      try {
        const data = item?.data;
        if (!data) continue;
        // VideoMetadata: data.video.owner.{id,login,displayName}
        const v = data.video;
        if (v?.owner?.id && v?.owner?.login) {
          postOwner({ userId: String(v.owner.id), login: v.owner.login, displayName: v.owner.displayName || v.owner.login, source: 'video' });
        }
        // StreamMetadata / User: data.user.{id,login,displayName}
        const u = data.user;
        if (u?.id && u?.login) {
          postOwner({ userId: String(u.id), login: u.login, displayName: u.displayName || u.login, source: 'user' });
        }
        // Clip
        const c = data.clip;
        if (c?.broadcaster?.id && c?.broadcaster?.login) {
          postOwner({ userId: String(c.broadcaster.id), login: c.broadcaster.login, displayName: c.broadcaster.displayName || c.broadcaster.login, source: 'clip' });
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
        resetMeasurement();
        break;
      case 'resume':
        try { await ctx?.resume(); } catch (_) {}
        break;
    }
  });

  postReady({ event: 'loaded' });
})();
