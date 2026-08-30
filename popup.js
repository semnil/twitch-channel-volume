// popup.js — Twitch Channel Volume popup.

(() => {
  'use strict';

  function $(id) { return document.getElementById(id); }

  let displayUnit = '%';
  let lastSuggestedGain = null;
  let sliderSynced = false;
  let currentChannel = { id: '', kind: 'none' };
  let currentAutoApplyLoudness = false;
  let audioUnavailable = false;
  let audioUnavailableCause = '';
  let measurementUnavailable = false;
  let autoUpdatePending = false;
  let measurementResetPending = false;
  let hasResettableMeasurement = false;
  let gainSaveError = false;

  function syncInteractionDisabledState() {
    const validChannel = !!currentChannel.id &&
      ['live', 'vod'].includes(currentChannel.kind);
    $('autoApplyToggle').disabled = autoUpdatePending || measurementResetPending ||
      audioUnavailable || !validChannel;
    // Resetting clears the saved measurement, and nothing would rebuild it.
    $('resetMeasurementBtn').disabled = autoUpdatePending || measurementResetPending ||
      audioUnavailable || !validChannel || !hasResettableMeasurement;
    if (autoUpdatePending) $('applyBtn').disabled = true;
    if (measurementResetPending) $('applyBtn').disabled = true;

    // The gain is saved against a channel, so there is nothing to set on a page
    // that has none.
    const manualDisabled = currentAutoApplyLoudness || autoUpdatePending ||
      audioUnavailable || !validChannel;
    $('manualSection').classList.toggle('disabled', manualDisabled);
    $('manualSlider').disabled = manualDisabled;
    document.querySelectorAll('.presets button').forEach((btn) => {
      btn.disabled = manualDisabled;
    });
  }

  // Each failure has its own remedy: another script holding the element, an
  // audio context that would not start, a measurement path that never came up.
  function noticeText() {
    if (!audioUnavailable) return msg('measurementUnavailable');
    if (audioUnavailableCause === 'audio-context') return msg('audioContextUnavailable');
    if (audioUnavailableCause === 'cross-origin') return msg('audioCrossOriginUnavailable');
    return msg('audioUnavailable');
  }

  // The gain reaches the player only while the bridge holds its audio.
  function currentCardClass() {
    return audioUnavailable ? 'current unknown' : 'current';
  }

  function formatGainText(gain) {
    const f = formatGain(gain, displayUnit);
    return f.text + f.unit;
  }

  function setCardValue(el, text, unitText, extraClass) {
    el.innerHTML = '';
    el.className = 'value' + (extraClass ? ' ' + extraClass : '');
    el.appendChild(document.createTextNode(text));
    if (unitText) {
      const unit = document.createElement('span');
      unit.className = 'unit';
      unit.textContent = unitText;
      el.appendChild(unit);
    }
  }

  function applyI18n() {
    $('resetMeasurementBtn').title = msg('resetMeasurement');
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      const text = msg(key);
      if (text && text !== key) el.textContent = text;
    });
  }

  function fmtLufs(v) {
    if (!Number.isFinite(v)) return null;
    return v.toFixed(1);
  }

  // A value the pipeline can no longer update is shown in the unknown style:
  // it is the last one measured, not the level playing now.
  function setLufsCell(id, v) {
    const el = $(id);
    const s = fmtLufs(v);
    if (s === null) {
      setCardValue(el, '---', null, 'unknown');
    } else {
      setCardValue(el, s, ' LUFS', audioUnavailable ? 'unknown' : '');
    }
  }

  function syncSlider(gain) {
    const gainPct = gainToPercent(gain);
    const fc = formatGain(gain, displayUnit);
    $('manualSlider').value = String(gainPct);
    $('manualValue').textContent = fc.text + fc.unit;
    setCardValue($('current'), fc.text, fc.unit, currentCardClass());
  }

  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
  }

  // The display polls every second and a page that cannot answer goes on not
  // answering, so the reason is named once per stretch rather than once per
  // poll, and again after the next request arrives.
  let stateRequestFailureReported = false;

  function reportStateRequestFailure(reason) {
    if (stateRequestFailureReported) return;
    stateRequestFailureReported = true;
    console.warn('[TCV] state request failed', reason);
  }

  async function requestState({ showConnectionError = true } = {}) {
    try {
      const tab = await getActiveTab();
      // A tab whose URL the popup can read is one the extension runs in: the
      // manifest asks for twitch.tv alone and for no tabs permission, so Chrome
      // withholds the URL of every other tab.
      if (!tab?.url || !/twitch\.tv/.test(tab.url)) {
        reportStateRequestFailure('no Twitch tab to ask');
        if (showConnectionError) showStatus(msg('openOnTwitch'));
        return null;
      }
      const res = await chrome.tabs.sendMessage(tab.id, { cmd: 'getState' });
      stateRequestFailureReported = false;
      return res;
    } catch (err) {
      // A content script that was never injected, a tab that has gone and a
      // runtime the reload invalidated all leave the viewer the same one thing
      // to do, and the status line says that much. The two callers that ask for
      // no status line keep the message they put up themselves, so the reason
      // is named here, where the rest of the popup's failures are named.
      reportStateRequestFailure(err);
      if (showConnectionError) showStatus(msg('reloadPageNeeded'));
      return null;
    }
  }

  // The status line stands in for the whole screen: it answers for a page the
  // extension does not act on.
  function showStatus(text) {
    const box = $('errBox');
    box.textContent = text;
    box.classList.remove('hidden');
    $('mainArea').classList.add('hidden');
  }

  function hideStatus() {
    $('errBox').classList.add('hidden');
    $('mainArea').classList.remove('hidden');
  }

  function renderState(state) {
    if (!state) return;
    const ch = state.channel || {};
    if (currentChannel.id &&
        (ch.id !== currentChannel.id || ch.kind !== currentChannel.kind)) {
      gainSaveError = false;
      $('resetMeasurementError').classList.add('hidden');
    }
    currentChannel = ch;
    currentAutoApplyLoudness = !!state.autoApplyLoudness;
    audioUnavailable = !!state.audioUnavailable;
    audioUnavailableCause = state.audioUnavailableCause || '';
    measurementUnavailable = !audioUnavailable && !!state.measurementUnavailable;
    // A clip's volume is left to the player, so the screen says that alone.
    if (ch.kind === 'clip') {
      showStatus(msg('clipNotAdjustable'));
      return;
    }
    hideStatus();
    // Both notices name the player of a channel, so neither is shown on a page
    // where no channel was resolved.
    const notice = ch.id && (audioUnavailable || measurementUnavailable);
    $('audioError').classList.toggle('hidden', !notice);
    if (notice) $('audioError').textContent = noticeText();
    const nameEl = $('channelName');
    if (ch.name) {
      nameEl.textContent = ch.name;
      nameEl.classList.remove('empty');
    } else {
      nameEl.textContent = msg('channelNotDetected');
      nameEl.classList.add('empty');
    }
    // The name truncates to fit the row, so keep the full text on hover.
    nameEl.title = nameEl.textContent;
    const kindEl = $('channelKind');
    if (ch.kind && ch.kind !== 'none') {
      kindEl.className = 'type-badge ' + ch.kind;
      let kindLabel = '';
      if (ch.kind === 'live') kindLabel = msg('typeLive');
      else if (ch.kind === 'vod') kindLabel = msg('typeVod');
      kindEl.textContent = kindLabel;
    } else {
      kindEl.className = 'type-badge hidden';
      kindEl.textContent = '';
    }

    const lufs = state.lufs || {};
    setLufsCell('integrated', lufs.integrated);
    const hasIntegrated = Number.isFinite(lufs.integrated);
    hasResettableMeasurement = hasIntegrated || !!state.hasSavedMeasurement;

    const autoToggle = $('autoApplyToggle');
    if (!autoUpdatePending) autoToggle.checked = currentAutoApplyLoudness;
    $('fallbackBadge').classList.toggle(
      'hidden',
      !currentAutoApplyLoudness || hasIntegrated
    );

    const suggestedEl = $('suggested');
    lastSuggestedGain = suggestedGain(lufs.integrated, state.targetLufs);
    const fs = formatGain(lastSuggestedGain, displayUnit);
    setCardValue(
      suggestedEl,
      fs.text,
      fs.unit,
      hasIntegrated && !audioUnavailable ? 'suggested' : 'suggested unknown'
    );

    const applyButton = $('applyBtn');
    if (!currentAutoApplyLoudness && hasIntegrated && ch.id && !audioUnavailable) {
      applyButton.textContent =
        msg('applyToChannelWithValue', [formatGainText(lastSuggestedGain)]);
    } else {
      applyButton.textContent = msg('applyToChannel');
    }

    $('applyHint').classList.toggle('error', gainSaveError);
    if (gainSaveError) {
      // The save failure is the viewer's own last action; the notice above
      // carries the audio state alongside it.
      applyButton.disabled =
        currentAutoApplyLoudness || audioUnavailable || !hasIntegrated || !ch.id;
      $('applyHint').textContent = msg('gainSaveFailed');
    } else if (audioUnavailable && ch.id) {
      // The notice carries the reason; the hint stays empty.
      applyButton.disabled = true;
      $('applyHint').textContent = '';
    } else if (currentAutoApplyLoudness && ch.id) {
      applyButton.disabled = true;
      $('applyHint').textContent = msg('hintAutoApplyEnabled');
    } else if (hasIntegrated && ch.id) {
      applyButton.disabled = false;
      $('applyHint').textContent = '';
    } else {
      applyButton.disabled = true;
      // The notice already says a stalled measurement is not coming.
      $('applyHint').textContent = ch.id
        ? (measurementUnavailable ? '' : msg('hintNoLufs'))
        : msg('channelNotDetected');
    }

    const actualGain = Number.isFinite(state.gain) ? state.gain : 1.0;
    if (currentAutoApplyLoudness || !sliderSynced) {
      // syncSlider owns the Current card whenever it runs.
      syncSlider(actualGain);
      sliderSynced = true;
    } else {
      const currentFormatted = formatGain(actualGain, displayUnit);
      setCardValue($('current'), currentFormatted.text, currentFormatted.unit, currentCardClass());
    }

    syncInteractionDisabledState();

    $('adFlag').classList.toggle('hidden', !state.adActive);
  }

  async function applyMeasured() {
    if (autoUpdatePending || measurementResetPending || audioUnavailable ||
        !Number.isFinite(lastSuggestedGain)) return;
    try {
      const tab = await getActiveTab();
      if (!tab) throw new Error('No active tab');
      await chrome.tabs.sendMessage(tab.id, { cmd: 'resume' });
      const res = await chrome.tabs.sendMessage(
        tab.id,
        { cmd: 'setGain', gain: lastSuggestedGain }
      );
      if (!res?.ok) throw new Error(res?.reason || 'Gain update failed');
      gainSaveError = false;
      syncSlider(lastSuggestedGain);
    } catch (error) {
      console.warn('[TCV] suggested gain request failed', error);
      gainSaveError = true;
      sliderSynced = false;
    }
    await refresh();
  }

  async function setGain(percent) {
    if (autoUpdatePending || audioUnavailable) return;
    try {
      const tab = await getActiveTab();
      if (!tab) throw new Error('No active tab');
      const gain = percentToGain(percent);
      const res = await chrome.tabs.sendMessage(tab.id, { cmd: 'setGain', gain });
      if (!res?.ok) throw new Error(res?.reason || 'Gain update failed');
      gainSaveError = false;
    } catch (error) {
      console.warn('[TCV] gain request failed', error);
      gainSaveError = true;
      sliderSynced = false;
    }
    await refresh();
  }

  async function setAutoApplyLoudness() {
    const toggle = $('autoApplyToggle');
    if (audioUnavailable) {
      toggle.checked = currentAutoApplyLoudness;
      return;
    }
    if (autoUpdatePending || measurementResetPending ||
        !currentChannel.id || currentChannel.kind === 'none') return;
    const enabled = toggle.checked;
    $('autoError').classList.add('hidden');
    autoUpdatePending = true;
    syncInteractionDisabledState();
    try {
      const tab = await getActiveTab();
      if (!tab) throw new Error('No active tab');
      const res = await chrome.tabs.sendMessage(tab.id, {
        cmd: 'setAutoApplyLoudness',
        channelId: currentChannel.id,
        kind: currentChannel.kind,
        enabled
      });
      if (!res?.ok) throw new Error(res?.reason || 'Auto update failed');
      currentAutoApplyLoudness = !!res.autoApplyLoudness;
      autoUpdatePending = false;
      $('autoError').classList.add('hidden');
      if (Number.isFinite(res.gain)) {
        syncSlider(res.gain);
        sliderSynced = true;
      }
      await refresh();
    } catch (error) {
      console.warn('[TCV] Auto setting request failed', error);
      autoUpdatePending = false;
      $('autoError').textContent = msg('autoSaveFailed');
      $('autoError').classList.remove('hidden');
      const latestState = await requestState({ showConnectionError: false });
      if (latestState) {
        renderState(latestState);
      } else {
        toggle.checked = currentAutoApplyLoudness;
        syncInteractionDisabledState();
      }
    }
  }

  async function resetMeasurement() {
    if (measurementResetPending || audioUnavailable || !hasResettableMeasurement ||
        !currentChannel.id || currentChannel.kind === 'none') return;
    $('resetMeasurementError').classList.add('hidden');
    measurementResetPending = true;
    syncInteractionDisabledState();
    try {
      const tab = await getActiveTab();
      if (!tab) throw new Error('No active tab');
      const res = await chrome.tabs.sendMessage(tab.id, {
        cmd: 'resetMeasurement',
        channelId: currentChannel.id,
        kind: currentChannel.kind
      });
      if (!res?.ok) throw new Error(res?.reason || 'Measurement reset failed');
      hasResettableMeasurement = false;
      measurementResetPending = false;
      await refresh();
    } catch (error) {
      console.warn('[TCV] measurement reset request failed', error);
      measurementResetPending = false;
      $('resetMeasurementError').textContent = msg('resetMeasurementFailed');
      $('resetMeasurementError').classList.remove('hidden');
      const latestState = await requestState({ showConnectionError: false });
      if (latestState) renderState(latestState);
    } finally {
      measurementResetPending = false;
      syncInteractionDisabledState();
    }
  }

  async function refresh() {
    const state = await requestState();
    renderState(state);
  }

  $('applyBtn').addEventListener('click', applyMeasured);
  $('resetMeasurementBtn').addEventListener('click', resetMeasurement);
  $('autoApplyToggle').addEventListener('change', setAutoApplyLoudness);
  $('manualSlider').addEventListener('input', (e) => {
    if (autoUpdatePending) return;
    const g = percentToGain(Number(e.target.value));
    const f = formatGain(g, displayUnit);
    setCardValue($('current'), f.text, f.unit, 'current');
    $('manualValue').textContent = f.text + f.unit;
  });
  $('manualSlider').addEventListener('change', (e) => setGain(Number(e.target.value)));
  document.querySelectorAll('.presets button').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (autoUpdatePending) return;
      const v = Number(btn.getAttribute('data-gain'));
      const g = percentToGain(v);
      const f = formatGain(g, displayUnit);
      $('manualSlider').value = String(v);
      $('manualValue').textContent = f.text + f.unit;
      setCardValue($('current'), f.text, f.unit, 'current');
      setGain(v);
    });
  });
  $('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

  async function loadDisplayUnit() {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    const s = data[SETTINGS_KEY] || {};
    displayUnit = s.displayUnit || '%';
  }

  chrome.storage.onChanged?.addListener((changes) => {
    if (changes[SETTINGS_KEY]) {
      const next = changes[SETTINGS_KEY].newValue || {};
      displayUnit = next.displayUnit || '%';
      sliderSynced = false;
      refresh();
    }
  });

  function revealPopup() {
    // Commit the values the load wrote while the transitions are off, then show
    // the popup on the next frame.
    void document.body.offsetWidth;
    requestAnimationFrame(() => {
      document.body.classList.remove('initializing');
    });
  }

  applyI18n();
  (async () => {
    try {
      await loadDisplayUnit();
      await refresh();
    } finally {
      revealPopup();
    }
  })();
  setInterval(refresh, DISPLAY_UPDATE_INTERVAL_MS);
})();
