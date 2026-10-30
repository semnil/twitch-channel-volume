// content.js — ISOLATED world. Bridges page-bridge.js with chrome.storage.
// Resolves the current channel (Live/VOD), keeps its integrated LUFS, and applies
// the saved gain or, with auto-follow on, the one that brings it to Target LUFS.

(() => {
  'use strict';

  const MSG_IN = '__twitch_channel_volume__';
  const MSG_OUT = '__twitch_channel_volume_cmd__';
  const CHANNEL_MUTATION_MESSAGE = '__twitch_channel_volume_channel_mutation__';

  function isContextValid() {
    try { return !!chrome.runtime?.id; } catch (_) { return false; }
  }

  let currentChannel = { id: '', login: '', name: '', url: '', kind: 'none' };
  let currentGain = 1.0;
  let currentAdGainDb = DEFAULT_AD_GAIN_DB;
  let targetLufs = DEFAULT_TARGET_LUFS;
  let showGainOverlay = true;
  let defaultAutoApplyLoudnessLive = DEFAULT_AUTO_APPLY_LOUDNESS;
  let defaultAutoApplyLoudnessVod = DEFAULT_AUTO_APPLY_LOUDNESS;
  let currentChannelEntry = null;

  // What a gesture from the popup was made against. The popup echoes it back
  // with the gesture, and one whose state has moved on is not applied to the
  // state that replaced it. Derived from the state itself, so there is no
  // counter to advance and none to forget. The video is part of it because a
  // route change within one channel changes the measurement the popup shows.
  function currentGestureState() {
    return currentChannel.id + '|' + currentChannel.kind + '|' + (currentChannel.videoId || '');
  }
  let currentAutoApplyLoudness = false;
  let lastLufs;
  // Whether the player was playing — neither paused nor muted — at the lufs
  // notification lastLufs was taken from. Only a playing tab saves the
  // channel's level or the Auto gain a settings change gives.
  let lastLufsPlaying;
  // How many gating windows lastLufs.integrated stands on. Saved with it so the
  // next session continues that measurement instead of restarting it.
  let integratedWindows;
  let adActive = false;
  let requestedAdActive = false;
  // Filled on a route change with the indicator elements the media that ended
  // left in the page.
  let staleAdIndicators = new Set();
  let lastSeenAdIndicators = new Set();
  let audioUnavailable = false;
  let audioUnavailableCause = '';
  // Causes the popup has a message for. Anything else reads as another script
  // holding the element.
  const REPORTED_AUDIO_CAUSES = new Set(['audio-context', 'cross-origin']);
  let measurementUnavailable = false;
  let preferenceRevision = 0;
  let channelMutationQueue = Promise.resolve();
  let migratingChannelId = '';
  let autoMutationPending = false;
  let measurementResetPending = false;
  let measurementEpoch = 0;
  let currentCanonicalChannelId = '';
  let seededMeasurementTarget = '';
  // Set at startup, on a route change and where an owner moves what is being
  // measured: the measurement is owed a reset seeded from the row, and
  // whichever read of the row wins sends it, a read a write reaching
  // chrome.storage.onChanged started included.
  let seededResetPending = false;
  let lastAutoGainUpdateAt = -Infinity;
  // When a measured level last set the gain Auto plays; null from a
  // measurement reset, a settings change or a saved Auto toggle until the next
  // measured gain, which then plays as it stands.
  let autoRaiseFrom = null;
  // When the last ad ended. For the span of the short-term loudness after it,
  // that loudness still takes in the ad's own blocks.
  let adEndedAt = -Infinity;

  function clearMeasurementCache() {
    lastLufs = { momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity };
    integratedWindows = 0;
  }
  clearMeasurementCache();

  // ── Storage helpers ────────────────────────────────────────────────

  // Advanced by every synced settings change. The read below is answered with
  // what storage held when it went out, so a change that arrived meanwhile is
  // newer than what it read and is not undone by it.
  let settingsRevision = 0;

  async function loadSettings() {
    if (!isContextValid()) return;
    const revision = settingsRevision;
    const s = (await readStoredSettings(chrome.storage, SETTINGS_KEY)) || {};
    if (revision === settingsRevision) {
      targetLufs = s.targetLufs ?? DEFAULT_TARGET_LUFS;
      currentAdGainDb = s.adGainDb ?? DEFAULT_AD_GAIN_DB;
      showGainOverlay = s.showGainOverlay ?? true;
      defaultAutoApplyLoudnessLive =
        s.autoApplyLoudnessLiveDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS;
      defaultAutoApplyLoudnessVod =
        s.autoApplyLoudnessVodDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS;
    }
    sendCmd({ cmd: 'setAdGain', value: dbToGain(currentAdGainDb) });
  }

  function defaultAutoApplyForKind(kind) {
    if (kind === 'vod') return defaultAutoApplyLoudnessVod;
    return defaultAutoApplyLoudnessLive;
  }

  function resolveAutoApplyForKind(entry, kind) {
    return resolveAutoApplySetting(entry, kind, defaultAutoApplyForKind(kind));
  }

  function twitchChannelUrl(login) {
    return typeof login === 'string' && login
      ? `https://www.twitch.tv/${login.toLowerCase()}`
      : '';
  }

  async function loadChannelEntry(channelId) {
    if (!channelId || !isContextValid()) return null;
    const data = await chrome.storage.local.get([CHANNEL_VOLUMES_KEY, CHANNEL_ALIASES_KEY]);
    const all = data[CHANNEL_VOLUMES_KEY] || {};
    const canonicalId = resolveChannelIdAlias(channelId, data[CHANNEL_ALIASES_KEY] || {});
    return { canonicalId, entry: all[canonicalId] || null };
  }

  function sendChannelMutation(mutation) {
    const task = channelMutationQueue.then(async () => {
      if (!isContextValid()) throw new Error('runtime context invalid');
      const response = await chrome.runtime.sendMessage({
        type: CHANNEL_MUTATION_MESSAGE,
        mutation
      });
      if (!response?.ok) {
        throw new Error(response?.reason || 'channelVolumes mutation failed');
      }
      return response;
    });
    // Preserve order within this tab. The service worker adds the global queue
    // shared by content scripts, popup, and options contexts.
    channelMutationQueue = task.catch(() => {});
    return task;
  }

  function channelMetadata(channel = currentChannel) {
    const login = channel?.login || '';
    return {
      name: channel?.name || '',
      login,
      url: twitchChannelUrl(login)
    };
  }

  function saveChannelGain(channelId, name, gain, kind, url) {
    if (!channelId || !isContextValid()) return Promise.resolve();
    return sendChannelMutation({
      operation: 'saveGain',
      channelId,
      kind,
      gain,
      channel: { name: name || channelId, url: url || '' }
    });
  }

  function saveChannelAutoApply(channelId, name, enabled, kind, url, autoGain) {
    if (!channelId || !isContextValid()) return Promise.resolve();
    return sendChannelMutation({
      operation: 'saveAuto',
      channelId,
      kind,
      enabled: !!enabled,
      ...(Number.isFinite(autoGain) ? { autoGain, reference: LUFS_REFERENCE_VOLUME_1 } : {}),
      channel: { name: name || channelId, url: url || '' }
    });
  }

  function saveLastIntegrated(channelId, kind, lufs, windows, autoGain) {
    if (!channelId || !isContextValid() || !Number.isFinite(lufs)) {
      return Promise.resolve();
    }
    const snapshot = currentChannel.id === channelId ? { ...currentChannel } : null;
    return sendChannelMutation({
      operation: 'saveMeasurement',
      channelId,
      kind,
      lufs,
      reference: LUFS_REFERENCE_VOLUME_1,
      // The count is whatever the bridge reported, already held to a
      // non-negative integer where it arrives; 0 means it named none.
      ...(windows ? { windows } : {}),
      ...(Number.isFinite(autoGain) ? { autoGain } : {}),
      channel: channelMetadata(snapshot)
    });
  }

  function saveChannelAutoGain(channelId, kind, autoGain) {
    if (!channelId || !isContextValid() || !Number.isFinite(autoGain)) {
      return Promise.resolve();
    }
    const snapshot = currentChannel.id === channelId ? { ...currentChannel } : null;
    return sendChannelMutation({
      operation: 'saveAutoGain',
      channelId,
      kind,
      autoGain,
      reference: LUFS_REFERENCE_VOLUME_1,
      channel: channelMetadata(snapshot)
    });
  }

  function clearSavedMeasurement(channelId, kind) {
    if (!channelId || !isContextValid()) return Promise.resolve();
    return sendChannelMutation({
      operation: 'clearMeasurement',
      channelId,
      kind
    });
  }

  function migrateChannelId(fromId, toId, kind, channel) {
    if (!fromId || !toId || fromId === toId) return Promise.resolve();
    return sendChannelMutation({
      operation: 'mergeChannelIds',
      fromId,
      toId,
      kind,
      channel: channelMetadata(channel)
    });
  }

  // ── Page-bridge command helpers ────────────────────────────────────

  function sendCmd(payload) {
    window.postMessage({ type: MSG_OUT, ...payload }, '*');
  }

  function sendResetMeasurement(seed) {
    measurementEpoch++;
    lastAutoGainUpdateAt = -Infinity;
    autoRaiseFrom = null;
    sendCmd({
      cmd: 'resetMeasurement',
      epoch: measurementEpoch,
      ...(seed ? {
        initialIntegratedLufs: seed.lufs,
        ...(seed.windows ? { initialIntegratedWindows: seed.windows } : {})
      } : {})
    });
  }

  // Saved values without the reference marker were measured at an unknown
  // player volume, so they do not seed a new measurement. The window count is
  // what the value was measured over; entries written before it was stored
  // leave the bridge to weigh the seed on its own.
  function savedMeasurementForCurrentChannel() {
    const kind = currentChannel.kind;
    if (currentChannelEntry?.lastLufsRef?.[kind] !== LUFS_REFERENCE_VOLUME_1) return null;
    const saved = currentChannelEntry?.lastLufs?.[kind];
    if (!Number.isFinite(saved)) return null;
    const windows = currentChannelEntry?.lastLufsWindows?.[kind];
    return {
      lufs: saved,
      windows: Number.isSafeInteger(windows) && windows > 0 ? windows : 0
    };
  }

  // Identity of the measurement in progress. The stored LUFS is not usable here
  // because this tab overwrites it every few seconds while measuring.
  function currentMeasurementTarget() {
    return `${currentCanonicalChannelId}\n${currentChannel.kind}`;
  }

  function resetMeasurementForCurrentChannel() {
    seededMeasurementTarget = currentMeasurementTarget();
    sendResetMeasurement(savedMeasurementForCurrentChannel());
  }

  function sendPendingSeededReset() {
    if (!seededResetPending) return;
    seededResetPending = false;
    resetMeasurementForCurrentChannel();
  }

  let initResolve;
  const initPromise = new Promise((res) => { initResolve = res; });

  function injectWorklet() {
    sendCmd({ cmd: 'init' });
  }

  function applyGain(gain) {
    if (!Number.isFinite(gain)) gain = 1.0;
    currentGain = Math.max(MIN_GAIN, Math.min(MAX_GAIN, gain));
    sendCmd({ cmd: 'setGain', value: currentGain });
    updateGainOverlay();
  }

  // The gain Auto plays for the measurement it holds. Where the short-term
  // loudness is AUTO_RISE_DB or more over the Integrated value, the gain is
  // worked out as if the Integrated value were AUTO_RISE_AHEAD_DB louder; the
  // short-term loudness is not looked at during an ad or for the
  // SHORT_TERM_MS after one. A gain below the one playing plays at once. One
  // above it plays no more than AUTO_RAISE_DB higher for every
  // AUTO_RAISE_PERIOD_MS since a measured level last set the gain, and gets
  // there over the applies that come after. The first measured gain after
  // autoRaiseFrom was cleared, and one over a gain of 0, play as they stand.
  const AUTO_RAISE_DB = 1.5;
  const AUTO_RAISE_PERIOD_MS = 30000;
  const AUTO_RISE_DB = 6;
  const AUTO_RISE_AHEAD_DB = 3;
  // The span of the bridge's short-term loudness.
  const SHORT_TERM_MS = 3000;

  function autoGainToPlay() {
    const asked = calcGain(lastLufs.integrated, targetLufs);
    const now = Date.now();
    const from = autoRaiseFrom;
    autoRaiseFrom = now;
    if (from === null || !(currentGain > 0)) return asked;
    const rose = !adActive && now - adEndedAt >= SHORT_TERM_MS &&
      lastLufs.shortTerm - lastLufs.integrated >= AUTO_RISE_DB;
    const gain = rose ? calcGain(lastLufs.integrated + AUTO_RISE_AHEAD_DB, targetLufs) : asked;
    const allowedDb = AUTO_RAISE_DB * Math.max(0, now - from) / AUTO_RAISE_PERIOD_MS;
    return Math.min(gain, currentGain * Math.pow(10, allowedDb / 20));
  }

  function applyAutoGain() {
    if (previewHoldsGain()) return;
    const now = Date.now();
    const elapsed = now - lastAutoGainUpdateAt;
    if (elapsed >= 0 && elapsed < DISPLAY_UPDATE_INTERVAL_MS) return;
    lastAutoGainUpdateAt = now;
    applyGain(autoGainToPlay());
  }

  // ── Gain overlay on Twitch player ───────────────────────────────────

  let _overlayEl = null;

  // The badge reports the gain the player runs at. While the bridge holds no
  // media element source, the gain node sits outside the player's audio path.
  function updateGainOverlay() {
    if (!showGainOverlay || audioUnavailable || currentGain === 1.0) {
      if (_overlayEl) {
        if (_overlayEl.parentNode) _overlayEl.parentNode.removeChild(_overlayEl);
        _overlayEl = null;
      }
      return;
    }
    // Place the badge as the next sibling of `.volume-slider__slider-container`
    // inside the volume row. The row is a flex container holding the mute
    // button wrapper and the slider container side-by-side, so the badge
    // lands directly to the right of the slider bar. Visibility follows
    // `[data-a-target="player-controls"][data-a-visible]` automatically
    // because the badge lives inside the controls subtree.
    const sliderContainer = document.querySelector('.volume-slider__slider-container');
    if (!sliderContainer || !sliderContainer.parentElement) return;
    if (!_overlayEl) {
      _overlayEl = document.createElement('span');
      _overlayEl.style.cssText =
        'font-size:13px;font-weight:700;color:#4ecdc4;margin-left:8px;' +
        'font-variant-numeric:tabular-nums;pointer-events:none;white-space:nowrap;' +
        'line-height:1;display:inline-flex;align-items:center;align-self:center;';
    }
    _overlayEl.textContent = Math.round(currentGain * 100) + '%';
    // A rebuilt player is a different slider container, and inserting moves the
    // badge already made into it rather than leaving a copy in the old one.
    if (_overlayEl.previousElementSibling !== sliderContainer) {
      sliderContainer.insertAdjacentElement('afterend', _overlayEl);
    }
  }

  // ── URL / channel resolution ───────────────────────────────────────

  function classify() {
    return classifyTwitchUrl(location.href);
  }

  async function acceptOwner(owner) {
    const classified = classify();
    if (!ownerMatchesTwitchContent(owner, classified)) return;

    // A name the event carries is taken only as text.
    const login = typeof owner.login === 'string' ? owner.login : '';
    const displayName = typeof owner.displayName === 'string' ? owner.displayName : '';
    const confirmedId = String(owner.userId);
    const provisionalId = provisionalChannelIdForContent(classified);
    const confirmedChannel = {
      ...currentChannel,
      id: confirmedId,
      login: login || currentChannel.login,
      name: displayName || login || currentChannel.name,
      url: twitchChannelUrl(login || currentChannel.login),
      kind: classified.kind,
      slug: classified.slug,
      videoId: classified.videoId
    };

    if (provisionalId && provisionalId !== confirmedId) {
      migratingChannelId = provisionalId;
      try {
        await migrateChannelId(provisionalId, confirmedId, classified.kind, confirmedChannel);
      } catch (error) {
        migratingChannelId = '';
        if (!isContextValid()) return;
        console.warn('[TCV] provisional channel migration failed', error);
        return;
      }
    }

    // Navigation can occur while the service worker waits behind earlier
    // mutations. The storage migration remains valid for the old content, but
    // its owner must not become the channel for the new URL.
    if (!ownerMatchesTwitchContent(owner, classify())) {
      migratingChannelId = '';
      return;
    }

    pendingOwner = { ...owner, login, displayName };
    try {
      await resolveChannel();
    } finally {
      migratingChannelId = '';
    }
    if (currentMeasurementTarget() !== seededMeasurementTarget) seededResetPending = true;
    await reapplyForCurrentChannel();
  }

  async function resolveChannel(seed) {
    const c = classify();
    let channelId = '';
    let login = '';
    let name = '';
    let url = '';

    if (c.kind === 'live') {
      login = c.login;
      channelId = pendingOwner?.userId ? String(pendingOwner.userId) : `login:${login}`;
      name = pendingOwner?.displayName || login;
    } else if (c.kind === 'vod') {
      channelId = pendingOwner?.userId ? String(pendingOwner.userId) : `vod-owner:${c.videoId}`;
      login = pendingOwner?.login || '';
      name = pendingOwner?.displayName || login || c.videoId;
    }
    // A clip resolves to no channel: its volume is left to the player.
    url = twitchChannelUrl(login);
    const previousId = currentChannel.id;
    const previousKind = currentChannel.kind;
    currentChannel = { id: channelId, login, name, url, kind: c.kind, slug: c.slug, videoId: c.videoId };
    if (previousId !== channelId || previousKind !== c.kind) {
      preferenceRevision++;
      currentCanonicalChannelId = channelId;
      currentChannelEntry = null;
      currentAutoApplyLoudness = false;
    }
    return currentChannel;
  }

  let pendingOwner = null;

  async function reapplyForCurrentChannel() {
    const ch = currentChannel;
    if (!ch.id || ch.kind === 'none') {
      currentCanonicalChannelId = ch.id;
      currentChannelEntry = null;
      currentAutoApplyLoudness = false;
      applyGain(1.0);
      sendPendingSeededReset();
      return true;
    }
    const revision = ++preferenceRevision;
    const resolved = await loadChannelEntry(ch.id);
    if (revision !== preferenceRevision ||
        ch.id !== currentChannel.id || ch.kind !== currentChannel.kind) return false;
    currentCanonicalChannelId = resolved?.canonicalId || ch.id;
    currentChannelEntry = resolved?.entry || null;
    const preferred = resolvePreferredGain(
      currentChannelEntry,
      ch.kind,
      defaultAutoApplyForKind(ch.kind),
      lastLufs.integrated,
      targetLufs
    );
    currentAutoApplyLoudness = preferred.autoApply;
    if (!previewHoldsGain()) {
      applyGain(preferred.autoApply && Number.isFinite(lastLufs.integrated)
        ? autoGainToPlay()
        : preferred.gain);
    }
    sendPendingSeededReset();
    return true;
  }

  // ── Message handler from page-bridge ───────────────────────────────

  window.addEventListener('message', async (event) => {
    try {
      await handleBridgeMessage(event);
    } catch (error) {
      console.warn('[TCV] failed to handle a bridge message', {
        event: event.data?.event,
        error
      });
    }
  });

  async function handleBridgeMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== MSG_IN) return;
    if (!isContextValid()) return;

    switch (data.event) {
      case 'loaded':
        // page-bridge may post `loaded` before our listener attaches. The
        // startup IIFE handles init/attach unconditionally; this case only
        // matters for hot-reloads where the bridge restarts mid-session.
        audioUnavailable = false;
        audioUnavailableCause = '';
        measurementUnavailable = false;
        injectWorklet();
        resetMeasurementForCurrentChannel();
        // A restarted bridge attaches only when asked, so the cleared state
        // gets its own attach result instead of standing on the old one.
        sendCmd({ cmd: 'attach' });
        break;
      case 'init-done':
        initResolve && initResolve();
        break;
      case 'attached': {
        // Attaching to a different element leaves the held one playing
        // untouched, so the bridge reports whether one is still on the page.
        const recovered = audioUnavailable && !data.takenElsewhere;
        audioUnavailable = !!data.takenElsewhere;
        audioUnavailableCause = audioUnavailable ? 'element-taken' : '';
        measurementUnavailable = !audioUnavailable && data.measuring === false;
        // The blocks measured until now came from an element the player was
        // not using, and they stay in the bridge's window.
        if (recovered) resetMeasurementForCurrentChannel();
        updateGainOverlay();
        break;
      }
      case 'attach-failed':
        // The gain node reaches the player only through the media element
        // source, so a failed attach stops gain and measurement alike.
        audioUnavailable = true;
        audioUnavailableCause = REPORTED_AUDIO_CAUSES.has(data.cause) ? data.cause : 'element-taken';
        measurementUnavailable = false;
        // Media another origin serves is the one cause with nothing for the
        // viewer to do about it, so it is kept out of the extension's error
        // list. The others name an action: disable the extension holding the
        // element, or reload the page.
        if (audioUnavailableCause === 'cross-origin') {
          console.info('[TCV] player audio unavailable', data.cause, data.reason);
        } else {
          console.warn('[TCV] player audio unavailable', data.cause, data.reason);
        }
        updateGainOverlay();
        break;
      case 'lufs':
        if (measurementResetPending) break;
        // A measurement taken while the player's audio is out of reach belongs
        // to some other element; saving it would overwrite the channel's level.
        if (audioUnavailable) break;
        if (Number.isFinite(data.epoch) && data.epoch < measurementEpoch) break;
        lastLufs = {
          momentary: Number.isFinite(data.momentary) ? data.momentary : -Infinity,
          shortTerm: Number.isFinite(data.shortTerm) ? data.shortTerm : -Infinity,
          integrated: Number.isFinite(data.integrated) ? data.integrated : -Infinity
        };
        integratedWindows = Number.isSafeInteger(data.integratedWindows) &&
          data.integratedWindows > 0 ? data.integratedWindows : 0;
        lastLufsPlaying = data.playing === true;
        if (Number.isFinite(lastLufs.integrated) && currentChannel.id) {
          if (currentAutoApplyLoudness) {
            applyAutoGain();
          }
          // Only a tab whose player is playing saves the channel's level, so
          // a paused or muted tab on the same channel does not write over it.
          if (lastLufsPlaying) throttledSaveIntegrated();
        }
        break;
      case 'owner':
        await acceptOwner(data);
        break;
      case 'ad':
        if (!data.active) adEndedAt = Date.now();
        adActive = !!data.active;
        break;
      case 'audio-context':
        listenForResumeGesture(data.state !== 'running');
        break;
    }
  }

  // ── Save integrated periodically to limit storage churn ───────────

  // A failed save is repeated with the next block, which arrives ten times a
  // second. A stretch of failures is named at info where it starts and as a
  // warning once it has lasted this long; Chrome collects the warning as an
  // error of the extension.
  const SAVE_FAILURE_WARN_AFTER_MS = 5000;

  let lastSavedAt = 0;
  let saveFailingSince = 0;
  let saveFailureWarned = false;

  function measurementSaved() {
    saveFailingSince = 0;
    saveFailureWarned = false;
  }

  function measurementSaveFailed(error) {
    lastSavedAt = 0;
    // Nothing is named once the page has outlived the extension.
    if (!isContextValid()) return;
    const now = Date.now();
    if (!saveFailingSince) {
      saveFailingSince = now;
      console.info('[TCV] measurement not persisted', error);
      return;
    }
    if (!saveFailureWarned && now - saveFailingSince >= SAVE_FAILURE_WARN_AFTER_MS) {
      saveFailureWarned = true;
      console.warn('[TCV] failed to persist measurement and Auto gain', error);
    }
  }

  function throttledSaveIntegrated() {
    const now = Date.now();
    if (now - lastSavedAt < 5000) return;
    lastSavedAt = now;
    saveLastIntegrated(
      currentChannel.id,
      currentChannel.kind,
      lastLufs.integrated,
      integratedWindows,
      currentAutoApplyLoudness ? calcGain(lastLufs.integrated, targetLufs) : undefined
    ).then(measurementSaved, measurementSaveFailed);
  }

  // ── DOM-based ad detection ────────────────────────────────────────
  const AD_INDICATOR_SELECTOR =
    '[data-a-target="video-ad-countdown"], [data-test-selector="ad-banner-default-text"]';

  // The indicator appears after the ad's first audio and can stay in the page
  // after the break, so the bridge prefers the player's own cue and falls back
  // to this where no cue arrives.

  // Right after a route change the player being left is still in the page, and
  // the elements it put there say nothing about the new media. What the page
  // held the last time it was read is what belongs to the old media, and every
  // read happens before the route change is handled - so which elements to
  // ignore is decided by element, not by when the page is read, and an
  // indicator that is not one of them counts however it got there.
  function adIndicatorPresent() {
    for (const node of staleAdIndicators) {
      if (!node.isConnected) staleAdIndicators.delete(node);
    }
    lastSeenAdIndicators = new Set(document.querySelectorAll(AD_INDICATOR_SELECTOR));
    for (const node of lastSeenAdIndicators) {
      if (!staleAdIndicators.has(node)) return true;
    }
    return false;
  }

  function checkAdDom() {
    const detected = adIndicatorPresent();
    // adActive only catches up when the bridge echoes the change back, so the
    // request is what this compares against.
    if (detected !== requestedAdActive) {
      requestedAdActive = detected;
      const video = document.querySelector('video');
      console.info('[TCV] ad detected in DOM', {
        detected,
        videoTime: video ? Number(video.currentTime.toFixed(3)) : null
      });
      sendCmd({ cmd: 'setAdActive', active: detected });
    }
  }

  // ── SPA navigation ─────────────────────────────────────────────────

  let lastHref = location.href;
  async function onNavigate() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    pendingOwner = null;
    preferenceRevision++;
    currentChannelEntry = null;
    currentAutoApplyLoudness = false;
    clearMeasurementCache();
    lastSavedAt = 0;
    // A clip's refusal was about the clip's own element, and the bridge reports
    // the next page's element for itself. Every other notice is kept, whatever
    // page it is carried across: an SPA navigation that keeps the same element
    // gets no second report, and an audio context that would not start reports
    // once per state rather than once per attach, so clearing either here would
    // drop that notice for good.
    if (currentChannel.kind === 'clip' && audioUnavailableCause === 'cross-origin') {
      audioUnavailable = false;
      audioUnavailableCause = '';
      measurementUnavailable = false;
    }
    // New media: the break the player cued for the old one no longer applies.
    // The bridge drops the indicator state with it, so the cache here matches
    // it again and the observer reports the new media's own transitions.
    sendCmd({ cmd: 'mediaChanged' });
    requestedAdActive = false;
    // These were the media being left; the new one has to put its own indicator
    // in the page to be heard.
    for (const node of lastSeenAdIndicators) staleAdIndicators.add(node);
    // The batch that carried the route change can have carried the new media's
    // indicator with it, and nothing more needs to happen in the page for it to
    // count.
    checkAdDom();
    sendResetMeasurement();
    sendCmd({ cmd: 'attach' });
    await resolveChannel();
    seededResetPending = true;
    await reapplyForCurrentChannel();
  }

  // Every entry point below starts the handling and drops the promise.
  function handleNavigation() {
    onNavigate().catch((error) => {
      console.warn('[TCV] failed to handle a route change', error);
    });
  }

  // Read the page before the URL moves: an indicator that is up at that point
  // belongs to the media being left, even if nothing has observed it yet.
  const origPush = history.pushState;
  history.pushState = function (...args) {
    checkAdDom();
    const r = origPush.apply(this, args);
    queueMicrotask(handleNavigation);
    return r;
  };
  const origReplace = history.replaceState;
  history.replaceState = function (...args) {
    checkAdDom();
    const r = origReplace.apply(this, args);
    queueMicrotask(handleNavigation);
    return r;
  };
  window.addEventListener('popstate', handleNavigation);
  // Ahead of the ad observer, so a batch that carries a route change is read
  // against the media that arrived rather than the one that left.
  new MutationObserver(handleNavigation).observe(document, { subtree: true, childList: true });

  const adObserver = new MutationObserver(() => checkAdDom());
  adObserver.observe(document.documentElement, { subtree: true, childList: true });

  // ── Popup slider preview ───────────────────────────────────────────

  // While a key held on the popup's slider previews a gain, the gain a reapply
  // of the row resolves and the Auto gain a measurement plays are held back
  // rather than applied; what the reapply reads and saves goes ahead. The
  // preview lasts until its gesture ends: the setGain that ends the hold
  // arrives, or PREVIEW_IDLE_MS pass after the last previewGain, which the
  // popup sends again while the key is held. A preview that ends with no save,
  // and a save refused after a preview, put back what storage holds then. A
  // preview whose state has moved holds nothing back.
  const PREVIEW_IDLE_MS = 2000;
  let preview = null;

  function startPreview(appliesTo) {
    if (preview) clearTimeout(preview.timer);
    preview = { appliesTo, timer: setTimeout(endIdlePreview, PREVIEW_IDLE_MS) };
  }

  // Whether a preview was in progress.
  function endPreview() {
    if (!preview) return false;
    clearTimeout(preview.timer);
    preview = null;
    return true;
  }

  function putBackStoredGain() {
    reapplyForCurrentChannel().catch((error) => {
      console.warn('[TCV] failed to put back the stored gain after a preview', error);
    });
  }

  function endIdlePreview() {
    if (endPreview()) putBackStoredGain();
  }

  function previewHoldsGain() {
    return !!preview && preview.appliesTo === currentGestureState();
  }

  // ── Storage onChanged → cross-tab sync ────────────────────────────

  // Chrome sends one event per area. The settings are taken from sync alone: in
  // local the key changes only when the worker moves it out, and that removal
  // carries no value to take. The channel keys are kept in local alone.
  chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName === 'sync' && changes[SETTINGS_KEY]) {
      settingsRevision++;
      const next = changes[SETTINGS_KEY].newValue || {};
      const autoInputs = () => [targetLufs, defaultAutoApplyLoudnessLive, defaultAutoApplyLoudnessVod];
      const previousAutoInputs = autoInputs();
      targetLufs = next.targetLufs ?? DEFAULT_TARGET_LUFS;
      defaultAutoApplyLoudnessLive =
        next.autoApplyLoudnessLiveDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS;
      defaultAutoApplyLoudnessVod =
        next.autoApplyLoudnessVodDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS;
      const adDb = next.adGainDb ?? DEFAULT_AD_GAIN_DB;
      if (adDb !== currentAdGainDb) {
        currentAdGainDb = adDb;
        sendCmd({ cmd: 'setAdGain', value: dbToGain(currentAdGainDb) });
      }
      showGainOverlay = next.showGainOverlay ?? true;
      updateGainOverlay();
      autoRaiseFrom = null;
      // The Auto gain on file follows the target and the Auto defaults, and
      // no other setting.
      const autoInputsChanged = autoInputs().some((value, i) => value !== previousAutoInputs[i]);
      reapplyForCurrentChannel()
        // A read that was overtaken applied nothing, and the Auto save went
        // with it; the reapply is made once more against the channel and the
        // row as they stand then.
        .then((applied) => applied || reapplyForCurrentChannel())
        .then((applied) => {
          // A tab whose player is not playing applies the gain and saves
          // nothing, as it saves no measurement.
          if (!autoInputsChanged || !applied || !currentAutoApplyLoudness ||
              !lastLufsPlaying || !Number.isFinite(lastLufs.integrated)) {
            return;
          }
          return saveChannelAutoGain(
            currentChannel.id,
            currentChannel.kind,
            calcGain(lastLufs.integrated, targetLufs)
          );
        }).catch((error) => {
          console.warn('[TCV] failed to reapply or persist settings', error);
        });
    }
    if (areaName === 'local' && (changes[CHANNEL_VOLUMES_KEY] || changes[CHANNEL_ALIASES_KEY]) &&
        currentChannel.id) {
      if (currentChannel.id === migratingChannelId) return;
      reapplyForCurrentChannel().catch((error) => {
        console.warn('[TCV] failed to synchronize channel settings', error);
      });
    }
  });

  // ── Popup / options message API ───────────────────────────────────

  // Why a gain the popup sends is not applied, or '' where it is.
  function gainGestureRefusal(req) {
    if (!currentChannel.id || req.appliesTo !== currentGestureState()) return 'state moved';
    // A gain saved here would be applied on a later visit without the viewer
    // ever hearing what they set.
    if (audioUnavailable) return 'audio unavailable';
    if (autoMutationPending) return 'auto update pending';
    if (currentAutoApplyLoudness) return 'auto apply enabled';
    return '';
  }

  chrome.runtime.onMessage?.addListener((req, _sender, sendResponse) => {
    if (!req || typeof req !== 'object') return;
    switch (req.cmd) {
      case 'getState':
        sendResponse({
          appliesTo: currentGestureState(),
          channel: currentChannel,
          lufs: lastLufs,
          hasSavedMeasurement: Number.isFinite(
            currentChannelEntry?.lastLufs?.[currentChannel.kind]
          ),
          gain: currentGain,
          adActive,
          audioUnavailable,
          audioUnavailableCause,
          measurementUnavailable,
          targetLufs,
          adGainDb: currentAdGainDb,
          autoApplyLoudness: currentAutoApplyLoudness,
          autoApplyLoudnessLive: resolveAutoApplyForKind(currentChannelEntry, 'live'),
          autoApplyLoudnessVod: resolveAutoApplyForKind(currentChannelEntry, 'vod')
        });
        return;
      case 'previewGain': {
        // A key held on the popup's slider: the gain is heard, and the setGain
        // that ends the hold saves it.
        const refusal = gainGestureRefusal(req);
        if (refusal) {
          sendResponse({ ok: false, reason: refusal });
          return;
        }
        applyGain(req.gain);
        startPreview(req.appliesTo);
        sendResponse({ ok: true });
        return;
      }
      case 'setGain': {
        // The save ends the preview, whatever becomes of it.
        const previewed = endPreview();
        const refusal = gainGestureRefusal(req);
        if (refusal) {
          if (previewed) putBackStoredGain();
          sendResponse({ ok: false, reason: refusal });
          return;
        }
        applyGain(req.gain);
        // The media can change while the save is in flight, so what is being
        // saved and what the failure names both come from this moment.
        const target = currentChannel;
        const targetGain = currentGain;
        saveChannelGain(
          target.id,
          target.name,
          targetGain,
          target.kind,
          target.url
        ).then(() => {
          sendResponse({ ok: true });
        }).catch(async (saveError) => {
          console.warn('[TCV] failed to save gain', {
            channelId: target.id,
            kind: target.kind,
            gain: targetGain,
            saveError
          });
          try {
            await reapplyForCurrentChannel();
          } catch (reapplyError) {
            console.warn('[TCV] failed to restore gain after save failure', reapplyError);
          }
          sendResponse({ ok: false, reason: 'storage update failed' });
        });
        return true;
      }
      case 'setAutoApplyLoudness': {
        if (!currentChannel.id || req.appliesTo !== currentGestureState()) {
          sendResponse({ ok: false, reason: 'state moved' });
          return;
        }
        const kind = currentChannel.kind;
        if (autoMutationPending || audioUnavailable) {
          sendResponse({
            ok: false,
            reason: audioUnavailable ? 'audio unavailable' : 'auto update pending'
          });
          return;
        }
        const autoGain = req.enabled && Number.isFinite(lastLufs.integrated)
          ? calcGain(lastLufs.integrated, targetLufs)
          : undefined;
        autoMutationPending = true;
        saveChannelAutoApply(
          currentChannel.id,
          currentChannel.name,
          !!req.enabled,
          kind,
          currentChannel.url,
          autoGain
        ).then(async () => {
          // A toggle that was saved for the state on screen plays its gain as
          // it stands; one that was not saved leaves Auto as it was going.
          if (req.appliesTo === currentGestureState()) autoRaiseFrom = null;
          try {
            await reapplyForCurrentChannel();
          } catch (error) {
            // The mutation is already durable. Keep this tab consistent with
            // the saved Auto choice even if the follow-up read fails.
            if (req.appliesTo === currentGestureState()) {
              currentChannelEntry = {
                ...(currentChannelEntry || {}),
                [autoApplyFieldForKind(kind)]: !!req.enabled,
                ...(Number.isFinite(autoGain)
                  ? {
                    [autoGainFieldForKind(kind)]: autoGain,
                    autoGainRef: {
                      ...(currentChannelEntry?.autoGainRef || {}),
                      [kind]: LUFS_REFERENCE_VOLUME_1
                    }
                  }
                  : {})
              };
              const preferred = resolvePreferredGain(
                currentChannelEntry,
                kind,
                defaultAutoApplyForKind(kind),
                lastLufs.integrated,
                targetLufs
              );
              currentAutoApplyLoudness = preferred.autoApply;
              applyGain(preferred.gain);
            }
            console.warn('[TCV] Auto setting saved but local reapply failed', error);
          }
          sendResponse({
            ok: true,
            gain: currentGain,
            autoApplyLoudness: currentAutoApplyLoudness
          });
        }, (error) => {
          console.warn('[TCV] failed to save Auto setting', error);
          sendResponse({ ok: false, reason: 'storage update failed' });
        }).finally(() => {
          autoMutationPending = false;
        });
        return true;
      }
      case 'resetMeasurement': {
        if (!currentChannel.id || req.appliesTo !== currentGestureState()) {
          sendResponse({ ok: false, reason: 'state moved' });
          return;
        }
        const kind = currentChannel.kind;
        if (audioUnavailable) {
          // Deleting the saved level here leaves nothing able to rebuild it.
          sendResponse({ ok: false, reason: 'audio unavailable' });
          return;
        }
        if (measurementResetPending) {
          sendResponse({ ok: false, reason: 'measurement reset pending' });
          return;
        }
        const channelId = currentChannel.id;
        measurementResetPending = true;
        clearSavedMeasurement(channelId, kind).then(() => {
          if (currentChannel.id === channelId && currentChannel.kind === kind) {
            clearMeasurementCache();
            lastSavedAt = 0;
            if (currentChannelEntry) {
              const entry = { ...currentChannelEntry };
              const savedLufs = { ...(entry.lastLufs || {}) };
              delete savedLufs[kind];
              if (Object.keys(savedLufs).length) entry.lastLufs = savedLufs;
              else {
                delete entry.lastLufs;
                delete entry.lastMeasuredAt;
              }
              currentChannelEntry = entry;
            }
            sendResetMeasurement();
          }
          sendResponse({ ok: true });
        }).catch((error) => {
          console.warn('[TCV] failed to reset measurement', error);
          sendResponse({ ok: false, reason: 'storage update failed' });
        }).finally(() => {
          measurementResetPending = false;
        });
        return true;
      }
      case 'resume':
        sendCmd({ cmd: 'resume' });
        sendResponse({ ok: true });
        return;
      default:
        console.warn('[TCV] unknown command', req.cmd);
        sendResponse({ ok: false, reason: 'unknown command' });
        return;
    }
  });

  // A suspended context passes no audio, and the media element source puts it
  // between the player and the speakers. A gesture that arrives before the
  // context exists cannot resume it, and unmuting from the keyboard sends no
  // click, so both gestures are heard until the bridge reports it running.
  function requestAudioContextResume() {
    sendCmd({ cmd: 'resume' });
  }

  function listenForResumeGesture(listening) {
    if (listening) {
      document.addEventListener('click', requestAudioContextResume, true);
      document.addEventListener('keydown', requestAudioContextResume, true);
    } else {
      document.removeEventListener('click', requestAudioContextResume, true);
      document.removeEventListener('keydown', requestAudioContextResume, true);
    }
  }

  listenForResumeGesture(true);

  setInterval(updateGainOverlay, 2000);

  // page-bridge.js loads at document_start and may post `loaded` before our
  // listener is registered. Drive init/attach explicitly here so the order is
  // deterministic: workletUrl set → context created → media element attached.
  (async () => {
    injectWorklet();
    await loadSettings();
    await resolveChannel();
    seededResetPending = true;
    await reapplyForCurrentChannel();
    // Wait for the worklet to be ready before attaching so the measurement
    // chain is wired up on first attach. Fall back after a timeout.
    await Promise.race([
      initPromise,
      new Promise((r) => setTimeout(r, 3000))
    ]);
    sendCmd({ cmd: 'attach' });
  })().catch((error) => {
    console.warn('[TCV] failed to start up', error);
  });
})();
