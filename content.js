// content.js — ISOLATED world. Bridges page-bridge.js with chrome.storage.
// Resolves the current channel (Live/VOD/Clip), applies the saved gain, and
// continuously updates per-channel integrated LUFS from measurements.

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
  let defaultAutoApplyLoudnessClip = DEFAULT_AUTO_APPLY_LOUDNESS;
  let currentChannelEntry = null;
  let currentAutoApplyLoudness = false;
  let lastLufs = { momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity };
  let adActive = false;
  let pendingAdRanges = [];
  let preferenceRevision = 0;
  let channelMutationQueue = Promise.resolve();
  let migratingChannelId = '';
  let autoMutationPending = false;
  let measurementResetPending = false;
  let measurementEpoch = 0;
  let currentCanonicalChannelId = '';
  let seededMeasurementTarget = '';
  let lastAutoGainUpdateAt = -Infinity;

  // ── Storage helpers ────────────────────────────────────────────────

  async function loadSettings() {
    if (!isContextValid()) return;
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    const s = data[SETTINGS_KEY] || {};
    targetLufs = s.targetLufs ?? DEFAULT_TARGET_LUFS;
    currentAdGainDb = s.adGainDb ?? DEFAULT_AD_GAIN_DB;
    showGainOverlay = s.showGainOverlay ?? true;
    defaultAutoApplyLoudnessLive =
      s.autoApplyLoudnessLiveDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS;
    defaultAutoApplyLoudnessVod =
      s.autoApplyLoudnessVodDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS;
    defaultAutoApplyLoudnessClip =
      s.autoApplyLoudnessClipDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS;
    sendCmd({ cmd: 'setAdGain', value: dbToGain(currentAdGainDb) });
  }

  function channelKeyForKind(kind, id, slug) {
    if (kind === 'clip') return `clip:${slug}`;
    return id;
  }

  function defaultAutoApplyForKind(kind) {
    if (kind === 'vod') return defaultAutoApplyLoudnessVod;
    if (kind === 'clip') return defaultAutoApplyLoudnessClip;
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
      ...(Number.isFinite(autoGain) ? { autoGain } : {}),
      channel: { name: name || channelId, url: url || '' }
    });
  }

  function saveLastIntegrated(channelId, kind, lufs, autoGain) {
    if (!channelId || !isContextValid() || !Number.isFinite(lufs)) {
      return Promise.resolve();
    }
    const snapshot = currentChannel.id === channelId ? { ...currentChannel } : null;
    return sendChannelMutation({
      operation: 'saveMeasurement',
      channelId,
      kind,
      lufs,
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

  function deleteChannel(channelId) {
    if (!channelId || !isContextValid()) return Promise.resolve();
    return sendChannelMutation({ operation: 'deleteChannel', channelId });
  }

  // ── Page-bridge command helpers ────────────────────────────────────

  function sendCmd(payload) {
    window.postMessage({ type: MSG_OUT, ...payload }, '*');
  }

  function sendResetMeasurement(initialIntegratedLufs) {
    measurementEpoch++;
    lastAutoGainUpdateAt = -Infinity;
    sendCmd({
      cmd: 'resetMeasurement',
      epoch: measurementEpoch,
      ...(Number.isFinite(initialIntegratedLufs) ? { initialIntegratedLufs } : {})
    });
  }

  function savedIntegratedLufsForCurrentChannel() {
    const saved = currentChannelEntry?.lastLufs?.[currentChannel.kind];
    return Number.isFinite(saved) ? saved : undefined;
  }

  // Identity of the measurement in progress. The stored LUFS is not usable here
  // because this tab overwrites it every few seconds while measuring.
  function currentMeasurementTarget() {
    return `${currentCanonicalChannelId}\n${currentChannel.kind}`;
  }

  function resetMeasurementForCurrentChannel() {
    seededMeasurementTarget = currentMeasurementTarget();
    sendResetMeasurement(savedIntegratedLufsForCurrentChannel());
  }

  let initResolve;
  const initPromise = new Promise((res) => { initResolve = res; });

  function injectWorklet() {
    const url = chrome.runtime.getURL('audio-worklet.js');
    sendCmd({ cmd: 'init', workletUrl: url });
  }

  function applyGain(gain) {
    if (!Number.isFinite(gain)) gain = 1.0;
    currentGain = Math.max(MIN_GAIN, Math.min(MAX_GAIN, gain));
    sendCmd({ cmd: 'setGain', value: currentGain });
    updateGainOverlay();
  }

  function applyAutoGain(integratedLufs) {
    const now = Date.now();
    const elapsed = now - lastAutoGainUpdateAt;
    if (elapsed >= 0 && elapsed < DISPLAY_UPDATE_INTERVAL_MS) return;
    lastAutoGainUpdateAt = now;
    applyGain(calcGain(integratedLufs, targetLufs));
  }

  // ── Gain overlay on Twitch player ───────────────────────────────────

  let _overlayEl = null;

  function updateGainOverlay() {
    if (!showGainOverlay || currentGain === 1.0) {
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
    if (_overlayEl && !document.contains(_overlayEl)) _overlayEl = null;
    if (!_overlayEl) {
      _overlayEl = document.createElement('span');
      _overlayEl.style.cssText =
        'font-size:13px;font-weight:700;color:#4ecdc4;margin-left:8px;' +
        'font-variant-numeric:tabular-nums;pointer-events:none;white-space:nowrap;' +
        'line-height:1;display:inline-flex;align-items:center;align-self:center;';
    }
    _overlayEl.textContent = Math.round(currentGain * 100) + '%';
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
    if (!ownerMatchesTwitchContent(owner, classified)) return false;

    const confirmedId = String(owner.userId);
    const provisionalId = provisionalChannelIdForContent(classified);
    const confirmedChannel = {
      ...currentChannel,
      id: confirmedId,
      login: owner.login || currentChannel.login,
      name: owner.displayName || owner.login || currentChannel.name,
      url: twitchChannelUrl(owner.login || currentChannel.login),
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
        if (!isContextValid()) return false;
        console.warn('[TCV] provisional channel migration failed', error);
        return false;
      }
    }

    // Navigation can occur while the service worker waits behind earlier
    // mutations. The storage migration remains valid for the old content, but
    // its owner must not become the channel for the new URL.
    if (!ownerMatchesTwitchContent(owner, classify())) {
      migratingChannelId = '';
      return false;
    }

    pendingOwner = owner;
    try {
      await resolveChannel();
    } finally {
      migratingChannelId = '';
    }
    if (await reapplyForCurrentChannel() &&
        currentMeasurementTarget() !== seededMeasurementTarget) {
      resetMeasurementForCurrentChannel();
    }
    return true;
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
    } else if (c.kind === 'clip') {
      channelId = pendingOwner?.userId ? String(pendingOwner.userId) : `clip-owner:${c.slug}`;
      login = pendingOwner?.login || c.login || '';
      name = pendingOwner?.displayName || login || c.slug;
    }
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
    applyGain(preferred.gain);
    return true;
  }

  // ── Message handler from page-bridge ───────────────────────────────

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== MSG_IN) return;
    if (!isContextValid()) return;

    switch (data.event) {
      case 'loaded':
        // page-bridge may post `loaded` before our listener attaches. The
        // startup IIFE handles init/attach unconditionally; this case only
        // matters for hot-reloads where the bridge restarts mid-session.
        injectWorklet();
        resetMeasurementForCurrentChannel();
        break;
      case 'init-done':
        initResolve && initResolve();
        break;
      case 'attached':
        break;
      case 'lufs':
        if (measurementResetPending) break;
        if (Number.isFinite(data.epoch) && data.epoch < measurementEpoch) break;
        lastLufs = {
          momentary: Number.isFinite(data.momentary) ? data.momentary : -Infinity,
          shortTerm: Number.isFinite(data.shortTerm) ? data.shortTerm : -Infinity,
          integrated: Number.isFinite(data.integrated) ? data.integrated : -Infinity
        };
        if (Number.isFinite(lastLufs.integrated) && currentChannel.id) {
          if (currentAutoApplyLoudness) {
            applyAutoGain(lastLufs.integrated);
          }
          throttledSaveIntegrated();
        }
        break;
      case 'manifest-ad':
        if (Array.isArray(data.ranges)) pendingAdRanges = data.ranges;
        break;
      case 'owner':
        await acceptOwner(data);
        break;
      case 'ad':
        adActive = !!data.active;
        break;
    }
  });

  // ── Save integrated periodically to limit storage churn ───────────

  let lastSavedAt = 0;
  function throttledSaveIntegrated() {
    const now = Date.now();
    if (now - lastSavedAt < 5000) return;
    lastSavedAt = now;
    saveLastIntegrated(
      currentChannel.id,
      currentChannel.kind,
      lastLufs.integrated,
      currentAutoApplyLoudness ? currentGain : undefined
    ).catch((error) => {
      lastSavedAt = 0;
      console.warn('[TCV] failed to persist measurement and Auto gain', error);
    });
  }

  // ── DOM-based ad detection (fallback) ─────────────────────────────

  function checkAdDom() {
    const node = document.querySelector(
      '[data-a-target="video-ad-countdown"], [data-test-selector="ad-banner-default-text"]'
    );
    const detected = !!node;
    if (detected !== adActive) {
      const video = document.querySelector('video');
      console.info('[TCV] ad detected in DOM', {
        detected,
        videoTime: video ? Number(video.currentTime.toFixed(3)) : null
      });
      sendCmd({ cmd: 'setAdActive', active: detected });
    }
  }

  const adObserver = new MutationObserver(() => checkAdDom());
  adObserver.observe(document.documentElement, { subtree: true, childList: true });

  // ── SPA navigation ─────────────────────────────────────────────────

  let lastHref = location.href;
  async function onNavigate() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    pendingOwner = null;
    preferenceRevision++;
    currentChannelEntry = null;
    currentAutoApplyLoudness = false;
    lastLufs = { momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity };
    lastSavedAt = 0;
    sendResetMeasurement();
    sendCmd({ cmd: 'attach' });
    await resolveChannel();
    if (await reapplyForCurrentChannel()) resetMeasurementForCurrentChannel();
  }

  const origPush = history.pushState;
  history.pushState = function (...args) {
    const r = origPush.apply(this, args);
    queueMicrotask(onNavigate);
    return r;
  };
  const origReplace = history.replaceState;
  history.replaceState = function (...args) {
    const r = origReplace.apply(this, args);
    queueMicrotask(onNavigate);
    return r;
  };
  window.addEventListener('popstate', onNavigate);
  new MutationObserver(onNavigate).observe(document, { subtree: true, childList: true });

  // ── Storage onChanged → cross-tab sync ────────────────────────────

  chrome.storage.onChanged?.addListener((changes) => {
    if (changes[SETTINGS_KEY]) {
      const next = changes[SETTINGS_KEY].newValue || {};
      targetLufs = next.targetLufs ?? DEFAULT_TARGET_LUFS;
      defaultAutoApplyLoudnessLive =
        next.autoApplyLoudnessLiveDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS;
      defaultAutoApplyLoudnessVod =
        next.autoApplyLoudnessVodDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS;
      defaultAutoApplyLoudnessClip =
        next.autoApplyLoudnessClipDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS;
      const adDb = next.adGainDb ?? DEFAULT_AD_GAIN_DB;
      if (adDb !== currentAdGainDb) {
        currentAdGainDb = adDb;
        sendCmd({ cmd: 'setAdGain', value: dbToGain(currentAdGainDb) });
      }
      showGainOverlay = next.showGainOverlay ?? true;
      updateGainOverlay();
      reapplyForCurrentChannel().then((applied) => {
        if (!applied || !currentAutoApplyLoudness || !Number.isFinite(lastLufs.integrated)) {
          return;
        }
        return saveChannelAutoGain(currentChannel.id, currentChannel.kind, currentGain);
      }).catch((error) => {
        console.warn('[TCV] failed to reapply or persist settings', error);
      });
    }
    if ((changes[CHANNEL_VOLUMES_KEY] || changes[CHANNEL_ALIASES_KEY]) && currentChannel.id) {
      if (currentChannel.id === migratingChannelId) return;
      reapplyForCurrentChannel().catch((error) => {
        console.warn('[TCV] failed to synchronize channel settings', error);
      });
    }
  });

  // ── Popup / options message API ───────────────────────────────────

  chrome.runtime.onMessage?.addListener((req, _sender, sendResponse) => {
    if (!req || typeof req !== 'object') return;
    switch (req.cmd) {
      case 'getState':
        sendResponse({
          channel: currentChannel,
          lufs: lastLufs,
          hasSavedMeasurement: Number.isFinite(
            currentChannelEntry?.lastLufs?.[currentChannel.kind]
          ),
          gain: currentGain,
          adActive,
          targetLufs,
          adGainDb: currentAdGainDb,
          autoApplyLoudness: currentAutoApplyLoudness,
          autoApplyLoudnessLive: resolveAutoApplyForKind(currentChannelEntry, 'live'),
          autoApplyLoudnessVod: resolveAutoApplyForKind(currentChannelEntry, 'vod'),
          autoApplyLoudnessClip: resolveAutoApplyForKind(currentChannelEntry, 'clip')
        });
        return;
      case 'setGain':
        if (autoMutationPending || currentAutoApplyLoudness) {
          sendResponse({
            ok: false,
            reason: autoMutationPending ? 'auto update pending' : 'auto apply enabled'
          });
          return;
        }
        applyGain(req.gain);
        saveChannelGain(
          currentChannel.id,
          currentChannel.name,
          currentGain,
          currentChannel.kind,
          currentChannel.url
        ).then(() => {
          sendResponse({ ok: true });
        }).catch(async (saveError) => {
          try {
            await reapplyForCurrentChannel();
          } catch (reapplyError) {
            console.warn('[TCV] failed to restore gain after save failure', {
              channelId: currentChannel.id,
              kind: currentChannel.kind,
              saveError,
              reapplyError
            });
          }
          sendResponse({ ok: false, reason: 'storage update failed' });
        });
        return true;
      case 'setAutoApplyLoudness': {
        const kind = ['live', 'vod', 'clip'].includes(req.kind) ? req.kind : currentChannel.kind;
        if (!currentChannel.id || req.channelId !== currentChannel.id || kind !== currentChannel.kind) {
          sendResponse({ ok: false, reason: 'channel mismatch' });
          return;
        }
        if (autoMutationPending) {
          sendResponse({ ok: false, reason: 'auto update pending' });
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
          try {
            await reapplyForCurrentChannel();
          } catch (error) {
            // The mutation is already durable. Keep this tab consistent with
            // the saved Auto choice even if the follow-up read fails.
            if (currentChannel.id === req.channelId && currentChannel.kind === kind) {
              currentChannelEntry = {
                ...(currentChannelEntry || {}),
                [autoApplyFieldForKind(kind)]: !!req.enabled,
                ...(Number.isFinite(autoGain)
                  ? { [autoGainFieldForKind(kind)]: autoGain }
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
        const kind = ['live', 'vod', 'clip'].includes(req.kind) ? req.kind : '';
        if (!currentChannel.id || req.channelId !== currentChannel.id || kind !== currentChannel.kind) {
          sendResponse({ ok: false, reason: 'channel mismatch' });
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
            lastLufs = {
              momentary: -Infinity,
              shortTerm: -Infinity,
              integrated: -Infinity
            };
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
      case 'deleteChannel':
        deleteChannel(req.channelId).then(() => {
          sendResponse({ ok: true });
        }).catch(() => {
          sendResponse({ ok: false, reason: 'storage update failed' });
        });
        return true;
    }
    return false;
  });

  document.addEventListener('click', () => sendCmd({ cmd: 'resume' }), { once: true, capture: true });

  setInterval(updateGainOverlay, 2000);

  // page-bridge.js loads at document_start and may post `loaded` before our
  // listener is registered. Drive init/attach explicitly here so the order is
  // deterministic: workletUrl set → context created → media element attached.
  (async () => {
    injectWorklet();
    await loadSettings();
    await resolveChannel();
    if (await reapplyForCurrentChannel()) resetMeasurementForCurrentChannel();
    // Wait for the worklet to be ready before attaching so the measurement
    // chain is wired up on first attach. Fall back after a timeout.
    await Promise.race([
      initPromise,
      new Promise((r) => setTimeout(r, 3000))
    ]);
    sendCmd({ cmd: 'attach' });
  })();
})();
