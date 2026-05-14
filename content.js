// content.js — ISOLATED world. Bridges page-bridge.js with chrome.storage.
// Resolves the current channel (Live/VOD/Clip), applies the saved gain, and
// continuously updates per-channel integrated LUFS from measurements.

(() => {
  'use strict';

  const MSG_IN = '__twitch_channel_volume__';
  const MSG_OUT = '__twitch_channel_volume_cmd__';

  function isContextValid() {
    try { return !!chrome.runtime?.id; } catch (_) { return false; }
  }

  let currentChannel = { id: '', login: '', name: '', url: '', kind: 'none' };
  let currentGain = 1.0;
  let currentAdGainDb = DEFAULT_AD_GAIN_DB;
  let targetLufs = DEFAULT_TARGET_LUFS;
  let showGainOverlay = true;
  let lastLufs = { momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity };
  let adActive = false;
  let pendingAdRanges = [];

  // ── Storage helpers ────────────────────────────────────────────────

  async function loadSettings() {
    if (!isContextValid()) return;
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    const s = data[SETTINGS_KEY] || {};
    targetLufs = s.targetLufs ?? DEFAULT_TARGET_LUFS;
    currentAdGainDb = s.adGainDb ?? DEFAULT_AD_GAIN_DB;
    showGainOverlay = s.showGainOverlay ?? true;
    sendCmd({ cmd: 'setAdGain', value: dbToGain(currentAdGainDb) });
  }

  function channelKeyForKind(kind, id, slug) {
    if (kind === 'clip') return `clip:${slug}`;
    return id;
  }

  function gainFieldForKind(kind) {
    if (kind === 'live') return 'gainLive';
    if (kind === 'vod') return 'gainVod';
    if (kind === 'clip') return 'gainClip';
    return 'gainLive';
  }

  function extractGainForKind(entry, kind) {
    if (!entry) return null;
    if ('gain' in entry && !('gainLive' in entry) && !('gainVod' in entry) && !('gainClip' in entry)) {
      return entry.gain;
    }
    const v = entry[gainFieldForKind(kind)];
    if (Number.isFinite(v)) return v;
    return entry.gainLive ?? entry.gainVod ?? null;
  }

  async function loadChannelGain(channelId, kind) {
    if (!channelId || !isContextValid()) return null;
    const data = await chrome.storage.local.get(CHANNEL_VOLUMES_KEY);
    const all = data[CHANNEL_VOLUMES_KEY] || {};
    return extractGainForKind(all[channelId], kind);
  }

  async function saveChannelGain(channelId, name, gain, kind, url) {
    if (!channelId || !isContextValid()) return;
    const data = await chrome.storage.local.get(CHANNEL_VOLUMES_KEY);
    const all = data[CHANNEL_VOLUMES_KEY] || {};
    const entry = all[channelId] || { name: name || channelId };
    if (name) entry.name = name;
    if (url) entry.url = url;
    if ('gain' in entry) delete entry.gain;
    entry[gainFieldForKind(kind)] = gain;
    all[channelId] = entry;
    await chrome.storage.local.set({ [CHANNEL_VOLUMES_KEY]: all });
  }

  async function saveLastIntegrated(channelId, kind, lufs) {
    if (!channelId || !isContextValid() || !Number.isFinite(lufs)) return;
    const data = await chrome.storage.local.get(CHANNEL_VOLUMES_KEY);
    const all = data[CHANNEL_VOLUMES_KEY] || {};
    const entry = all[channelId] || { name: channelId };
    entry.lastLufs = entry.lastLufs || {};
    entry.lastLufs[kind] = lufs;
    entry.lastMeasuredAt = Date.now();
    all[channelId] = entry;
    await chrome.storage.local.set({ [CHANNEL_VOLUMES_KEY]: all });
  }

  async function deleteChannel(channelId) {
    if (!channelId || !isContextValid()) return;
    const data = await chrome.storage.local.get(CHANNEL_VOLUMES_KEY);
    const all = data[CHANNEL_VOLUMES_KEY] || {};
    delete all[channelId];
    await chrome.storage.local.set({ [CHANNEL_VOLUMES_KEY]: all });
  }

  // ── Page-bridge command helpers ────────────────────────────────────

  function sendCmd(payload) {
    window.postMessage({ type: MSG_OUT, ...payload }, '*');
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

  async function resolveChannel(seed) {
    const c = classify();
    let channelId = '';
    let login = '';
    let name = '';
    const url = location.href;

    if (c.kind === 'live') {
      login = c.login;
      channelId = `login:${login}`;
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
    currentChannel = { id: channelId, login, name, url, kind: c.kind, slug: c.slug, videoId: c.videoId };
    return currentChannel;
  }

  let pendingOwner = null;

  async function reapplyForCurrentChannel() {
    const ch = currentChannel;
    if (!ch.id || ch.kind === 'none') {
      applyGain(1.0);
      return;
    }
    const saved = await loadChannelGain(ch.id, ch.kind);
    if (Number.isFinite(saved)) {
      applyGain(saved);
    } else {
      applyGain(1.0);
    }
  }

  // ── Message handler from page-bridge ───────────────────────────────

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== MSG_IN) return;

    switch (data.event) {
      case 'loaded':
        // page-bridge may post `loaded` before our listener attaches. The
        // startup IIFE handles init/attach unconditionally; this case only
        // matters for hot-reloads where the bridge restarts mid-session.
        injectWorklet();
        break;
      case 'init-done':
        initResolve && initResolve();
        break;
      case 'attached':
        break;
      case 'lufs':
        lastLufs = {
          momentary: Number.isFinite(data.momentary) ? data.momentary : -Infinity,
          shortTerm: Number.isFinite(data.shortTerm) ? data.shortTerm : -Infinity,
          integrated: Number.isFinite(data.integrated) ? data.integrated : -Infinity
        };
        if (Number.isFinite(lastLufs.integrated) && currentChannel.id) {
          throttledSaveIntegrated();
        }
        break;
      case 'manifest-ad':
        if (Array.isArray(data.ranges)) pendingAdRanges = data.ranges;
        break;
      case 'owner':
        pendingOwner = data;
        await resolveChannel();
        await reapplyForCurrentChannel();
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
    saveLastIntegrated(currentChannel.id, currentChannel.kind, lastLufs.integrated);
  }

  // ── DOM-based ad detection (fallback) ─────────────────────────────

  function checkAdDom() {
    const node = document.querySelector(
      '[data-a-target="video-ad-countdown"], [data-test-selector="ad-banner-default-text"]'
    );
    const detected = !!node;
    if (detected !== adActive) {
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
    sendCmd({ cmd: 'resetMeasurement' });
    sendCmd({ cmd: 'attach' });
    await resolveChannel();
    await reapplyForCurrentChannel();
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
      const adDb = next.adGainDb ?? DEFAULT_AD_GAIN_DB;
      if (adDb !== currentAdGainDb) {
        currentAdGainDb = adDb;
        sendCmd({ cmd: 'setAdGain', value: dbToGain(currentAdGainDb) });
      }
      showGainOverlay = next.showGainOverlay ?? true;
      updateGainOverlay();
    }
    if (changes[CHANNEL_VOLUMES_KEY] && currentChannel.id) {
      const all = changes[CHANNEL_VOLUMES_KEY].newValue || {};
      const saved = extractGainForKind(all[currentChannel.id], currentChannel.kind);
      if (Number.isFinite(saved) && saved !== currentGain) {
        applyGain(saved);
      }
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
          gain: currentGain,
          adActive,
          targetLufs,
          adGainDb: currentAdGainDb
        });
        return;
      case 'setGain':
        applyGain(req.gain);
        saveChannelGain(currentChannel.id, currentChannel.name, currentGain, currentChannel.kind, currentChannel.url);
        sendResponse({ ok: true });
        return;
      case 'resume':
        sendCmd({ cmd: 'resume' });
        sendResponse({ ok: true });
        return;
      case 'deleteChannel':
        deleteChannel(req.channelId);
        sendResponse({ ok: true });
        return;
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
    await reapplyForCurrentChannel();
    // Wait for the worklet to be ready before attaching so the measurement
    // chain is wired up on first attach. Fall back after a timeout.
    await Promise.race([
      initPromise,
      new Promise((r) => setTimeout(r, 3000))
    ]);
    sendCmd({ cmd: 'attach' });
  })();
})();
