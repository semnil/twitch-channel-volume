// page-bridge.js — Runs in MAIN world on Twitch pages.
// Owns the AudioContext, the GainNode and the LUFS measurement of core/loudness.js.
// Twitch publishes no loudness metadata, so the bridge measures the playing
// <video> directly via Web Audio. It also hooks fetch to read Twitch's GraphQL
// responses for the authoritative user_id/login, and wraps the Worker
// constructor to hear the ad cues the player's own media engine posts.

(() => {
  'use strict';

  const MSG_OUT = '__twitch_channel_volume__';
  const MSG_IN = '__twitch_channel_volume_cmd__';

  // The page shares this window and can send the same commands content.js
  // sends, so the module to load is derived here instead of being received:
  // this script is served from the extension, and its own stack frames name
  // the origin it was served from.
  const SELF_ORIGIN = (() => {
    const found = /chrome-extension:\/\/[0-9a-z]+/.exec(new Error().stack || '');
    return found ? found[0] : '';
  })();
  const WORKLET_URL = SELF_ORIGIN ? `${SELF_ORIGIN}/audio-worklet.js` : '';

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
  let resumeRefusalReported = false;
  let reportedTakenElsewhere = false;
  let attachAttempts = 0;

  // The measurement itself is core/loudness.js's, loaded ahead of this script
  // in the same world; what the bridge tells it — the windows an ad holds out,
  // the ones a boundary skips, the ones taken back at an ad's start — is
  // decided here.
  const {
    BLOCK_SEC,
    BOUNDARY_SKIP_BLOCKS,
    meanSquareToLufs,
    normalizeForVolume,
    buildChain,
    createMeter
  } = channelVolumeLoudness;
  const meter = createMeter();
  // An ad's end and a volume change are boundaries in the tapped signal. The
  // meter keeps the windows that span one out; the reason and what was dropped
  // are kept here for the log.
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
  // Stamped onto every posted measurement so content.js can drop blocks that
  // the bridge produced before it handled the matching reset command.
  let measurementEpoch = 0;

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
      integrated: integrated.lufs,
      integratedWindows: integrated.windows,
      // The element the measurement taps plays to the viewer: it is neither
      // paused nor muted, at any volume.
      playing: !!attachedVideo && !attachedVideo.paused && !attachedVideo.muted
    }, '*');
  }

  function postContextState() {
    window.postMessage({
      type: MSG_OUT,
      event: 'audio-context',
      state: ctx ? ctx.state : 'none'
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

  function resetMeasurement(initialIntegratedLufs, epoch, initialIntegratedWindows) {
    if (Number.isFinite(epoch)) measurementEpoch = epoch;
    meter.reset(initialIntegratedLufs, initialIntegratedWindows);
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
      ctx.addEventListener('statechange', postContextState);
      postContextState();
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
      workletNode = buildChain(c, sourceNode, onBlockMs);
      console.info('[TCV] measurement chain ready');
    } catch (err) {
      console.warn('[TCV] measurement chain failed', err);
    }
  }

  function heldAsAdElement(video) {
    return adElementChains.some((chain) => chain.video === video);
  }

  // A MediaElementAudioSourceNode outputs silence when its element loaded a
  // cross-origin resource outside CORS mode, and the element's audio does not
  // return to the player once the node exists. Such an element is left alone.
  const MEDIA_REACHABLE = 'reachable';
  const MEDIA_PENDING = 'pending';
  const MEDIA_CROSS_ORIGIN = 'cross-origin';

  function mediaReach(video) {
    if (video.srcObject) return MEDIA_REACHABLE;
    const src = video.currentSrc || video.src || '';
    if (!src) return MEDIA_PENDING;
    if (video.crossOrigin) return MEDIA_REACHABLE;
    try {
      return new URL(src, location.href).origin === location.origin
        ? MEDIA_REACHABLE
        : MEDIA_CROSS_ORIGIN;
    } catch (err) {
      return MEDIA_CROSS_ORIGIN;
    }
  }

  // The attach loop asks again every second, so a refusal is logged and
  // reported once per element rather than once per attempt. The ad path keeps
  // its own record: it reports nothing, and the player path still has its one
  // report to make about the same element.
  const crossOriginLogged = new WeakSet();
  const crossOriginReported = new WeakSet();

  function mayTakeMedia(video, forAd) {
    const reach = mediaReach(video);
    if (reach === MEDIA_CROSS_ORIGIN) {
      if (!crossOriginLogged.has(video)) {
        crossOriginLogged.add(video);
        console.info('[TCV] media served from another origin without CORS; the element keeps the player audio path', { ad: !!forAd });
      }
      if (!forAd && !crossOriginReported.has(video)) {
        crossOriginReported.add(video);
        postReady({
          event: 'attach-failed',
          cause: 'cross-origin',
          reason: 'media is served from another origin without CORS'
        });
      }
    }
    return reach === MEDIA_REACHABLE;
  }

  function findVideo() {
    const all = document.querySelectorAll('video');
    let best = null;
    for (const v of all) {
      if (attachFailedFor.has(v) || heldAsAdElement(v)) continue;
      if (!v.src && v.readyState === 0) continue;
      // An element whose media another origin serves is passed over while
      // another one is there to take. It is read again on the next tick, so an
      // element that has not loaded yet is not decided here.
      if (mediaReach(v) === MEDIA_CROSS_ORIGIN) continue;
      if (!best || (v.clientWidth * v.clientHeight) > (best.clientWidth * best.clientHeight)) {
        best = v;
      }
    }
    if (best) return best;
    // Nothing could be taken, so the element that was passed over is offered
    // after all: refusing it is what reports it. An element that has loaded
    // nothing is not that element, and is read again on the next tick.
    for (const v of all) {
      if (attachFailedFor.has(v) || heldAsAdElement(v)) continue;
      if (!v.src && v.readyState === 0) continue;
      return v;
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
      clearInterval(adClock);
      adClock = null;
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
    if (!mayTakeMedia(video, false)) return;
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
    // The element can load a different resource while the context is built.
    if (!mayTakeMedia(video, false)) return;
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
    meter.clearBlocks();
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
      console.warn('[TCV] attached without a measurement chain; the worklet module is not loaded');
    }
    // With no measurement chain to send blocks, the attachment re-reads the ad
    // state on a timer of the block's period.
    if (!workletNode) adClock = setInterval(rereadAdState, BLOCK_SEC * 1000);
    postAttached();
  }

  let receivedFirstBlock = false;

  // Re-reads the ad state while the attachment has no measurement chain.
  let adClock = null;

  function rereadAdState() {
    updateAdState();
    if (adActive || adElementChains.length) syncAdElementGains();
  }

  function onBlockMs(ev) {
    const raw = ev.data?.ms;
    if (!Number.isFinite(raw)) return;
    if (!receivedFirstBlock) {
      receivedFirstBlock = true;
      console.info('[TCV] first measurement block received');
    }
    // The measurement taps the element ahead of the player's own volume, so
    // the viewer's volume setting scales it. Measurements are referenced to
    // volume 1.
    const ms = normalizeForVolume(raw, attachedVideo?.volume);
    // The playhead passing the end the cue gave is what ends a break, so the
    // state is re-read on every block, ahead of the window the block completes.
    rereadAdState();
    const measured = meter.addBlock(ms, adActive);
    if (measured.skipped) {
      boundarySkipDropped++;
      boundarySkipLufs.push(Number(meanSquareToLufs(measured.window).toFixed(2)));
      if (boundarySkipLufs.length > BOUNDARY_SKIP_BLOCKS) boundarySkipLufs.shift();
      if (meter.boundaryWindowsLeft() === 0) {
        console.info('[TCV] gate resumed', {
          reason: boundarySkipReason,
          dropped: boundarySkipDropped,
          windowLufs: boundarySkipLufs
        });
      }
    }
    postLufs(measured.momentary, measured.shortTerm, measured.integrated);
  }

  // A slider drag fires volumechange per step. Report the start of a skip and
  // its end, not every step and every window.
  function armBoundarySkip(reason) {
    if (meter.boundaryWindowsLeft() === 0 || boundarySkipReason !== reason) {
      // A skip cut short by a different boundary never reports its own total.
      const superseded = meter.boundaryWindowsLeft() > 0
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
    meter.skipBoundary();
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
    baselineGain = Number.isFinite(value) ? Math.max(0, Math.min(6, value)) : 1;
    applyEffectiveGain();
    syncAdElementGains();
  }

  function setAdGainOffset(value) {
    adGainOffset = Math.max(0, Math.min(6, Number(value) || 1));
    applyEffectiveGain();
    syncAdElementGains();
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

  function rollBackAdStart(blocks) {
    const requested = Math.max(0, blocks);
    // Asking for a window the boundary skip already kept out takes a content
    // window in its place, and that window's level leaves the gate with it.
    // The span is named by its first window, so every window it covers is
    // accounted for however many of them the gate dropped.
    const observed = meter.windowsObserved();
    const firstWindow = Math.max(1, observed - requested + 1);
    const covered = Math.max(0, observed - firstWindow + 1);
    const wanted = meter.appendedWindowsSince(firstWindow);
    const skipped = covered - wanted;
    const removed = meter.removeRecentWindows(wanted)
      .map((ms) => Number(meanSquareToLufs(ms).toFixed(2)));
    const half = ROLLBACK_LOG_SAMPLES / 2;
    const truncated = removed.length > ROLLBACK_LOG_SAMPLES;
    console.info('[TCV] ad start rollback', {
      removed: removed.length,
      requested,
      skipped,
      // The span reached back as far as it was asked to, so at the budget the
      // removal stopped short of the ad's own start.
      exhausted: covered === requested,
      windowsSinceReset: meter.windowsSinceReset(),
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
    if (!mayTakeMedia(video, true)) return null;
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

  // A mirror of TWITCH_RESERVED_PATHS in utils.js, which this world does not load.
  const RESERVED_PATHS = new Set([
    'directory', 'subscriptions', 'inventory', 'wallet', 'drops',
    'settings', 'friends', 'following', 'p', 'jobs', 'turbo',
    'videos', 'login', 'signup', 'search'
  ]);

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
      if (segs.length === 1 && !RESERVED_PATHS.has(segs[0])) {
        return { kind: 'live', id: segs[0].toLowerCase() };
      }
    } catch (_) {}
    return { kind: 'none', id: '' };
  }

  // A request made on a live, VOD or clip page goes through
  // requestMadeOnContentPage below, and the TypeError a request that could not
  // be made rejects with carries the stack of the call that made it. An
  // unhandled rejection whose reason is that TypeError, with that function in
  // its stack, has its default prevented. Any other rejection is left as it is.
  const CONTENT_REQUEST_FRAME = /\bat requestMadeOnContentPage \(chrome-extension:\/\//;
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    if (r instanceof TypeError && r.message === 'Failed to fetch' && CONTENT_REQUEST_FRAME.test(String(r.stack))) {
      e.preventDefault();
    }
  });

  const origFetch = window.fetch;
  function requestMadeOnContentPage(page, fetchArgs) {
    return origFetch.apply(page, fetchArgs);
  }
  window.fetch = function (...args) {
    const requestIdentity = currentContentIdentity();
    const result = requestIdentity.kind !== 'none'
      ? requestMadeOnContentPage(this, args)
      : origFetch.apply(this, args);
    let url = '';
    try { url = (typeof args[0] === 'string') ? args[0] : (args[0]?.url || ''); } catch (_) {}

    if (url.includes('gql.twitch.tv')) {
      result.then((resp) => resp.clone().json()).then((data) => {
        extractOwnerFromGraphQL(data);
      }).catch(() => {});
    }
    return result;
  };

  function extractOwnerFromGraphQL(payload) {
    const items = Array.isArray(payload) ? payload : [payload];
    for (const item of items) {
      try {
        const data = item?.data;
        if (!data) continue;
        // VideoMetadata: data.video.{id,owner.{id,login,displayName}}. An
        // owner whose answer names no video is not taken as any video's.
        const v = data.video;
        if (v?.owner?.id && v?.owner?.login && v.id != null) {
          postOwner({
            userId: String(v.owner.id),
            login: v.owner.login,
            displayName: v.owner.displayName || v.owner.login,
            source: 'video',
            contentKind: 'vod',
            contentId: String(v.id)
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
        resetMeasurement(
          data.initialIntegratedLufs,
          data.epoch,
          data.initialIntegratedWindows
        );
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
          await ensureContext();
          await ctx?.resume();
          if (ctx && ctx.state !== 'running') {
            // Every gesture asks again until the context runs, and a context
            // that will not move answers every one of them.
            if (!resumeRefusalReported) {
              resumeRefusalReported = true;
              console.warn('[TCV] audio context stayed', ctx.state, 'after resume');
            }
          } else {
            resumeRefusalReported = false;
          }
        } catch (err) {
          console.warn('[TCV] audio context resume failed', err);
        }
        // A context that was already running changes no state, and the answer
        // is what tells content.js to stop asking.
        postContextState();
        break;
    }
  });

  postReady({ event: 'loaded' });
})();
