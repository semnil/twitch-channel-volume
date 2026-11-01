// options.js — Twitch Channel Volume settings.

(() => {
  'use strict';

  const CHANNEL_MUTATION_MESSAGE = '__twitch_channel_volume_channel_mutation__';

  function $(id) { return document.getElementById(id); }

  let displayUnit = '%';
  let settingsReady = false;
  let loadFailed = false;
  let channelsRead = false;
  let settingsRevision = 0;
  let channelRevision = 0;
  let currentSettings = {};
  let channelVolumes = {};
  let defaultAutoApply = {
    live: DEFAULT_AUTO_APPLY_LOUDNESS,
    vod: DEFAULT_AUTO_APPLY_LOUDNESS
  };

  function setSettingsControlsDisabled(disabled) {
    for (const id of [
      'targetLufs',
      'adGainDb',
      'defaultAutoLiveToggle',
      'defaultAutoVodToggle',
      'overlayToggle',
      'clearAllBtn'
    ]) {
      $(id).disabled = disabled;
    }
    document.querySelectorAll('#unitToggle button').forEach((button) => {
      button.disabled = disabled;
    });
  }

  // Whether a key or the pointer is held on a settings slider, by field, set by
  // holdSettingsSlider. renderSettings takes the setting all the same and
  // leaves such a slider and its label on the value the gesture moved to.
  const settingsSliderHeld = {};

  function renderSettings(settings) {
    currentSettings = {
      targetLufs: settings.targetLufs ?? DEFAULT_TARGET_LUFS,
      adGainDb: settings.adGainDb ?? DEFAULT_AD_GAIN_DB,
      displayUnit: settings.displayUnit || '%',
      showGainOverlay: settings.showGainOverlay ?? true,
      autoApplyLoudnessLiveDefault:
        settings.autoApplyLoudnessLiveDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS,
      autoApplyLoudnessVodDefault:
        settings.autoApplyLoudnessVodDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS
    };
    if (!settingsSliderHeld.targetLufs?.()) {
      const target = currentSettings.targetLufs;
      $('targetLufs').value = String(target);
      $('targetLufsValue').textContent = target + ' LUFS';
    }
    if (!settingsSliderHeld.adGainDb?.()) {
      const adDb = currentSettings.adGainDb;
      $('adGainDb').value = String(adDb);
      $('adGainValue').textContent = (adDb > 0 ? '+' : '') + adDb + ' dB';
    }
    displayUnit = currentSettings.displayUnit;
    setActiveUnit(displayUnit);
    for (const kind of ['live', 'vod']) {
      defaultAutoApply[kind] = currentSettings[autoApplyDefaultFieldForKind(kind)];
      $(`defaultAuto${kind[0].toUpperCase()}${kind.slice(1)}Toggle`).checked =
        defaultAutoApply[kind];
    }
    $('overlayToggle').checked = currentSettings.showGainOverlay;
  }

  async function loadAll() {
    try {
      await mutateChannelVolumes({ operation: 'normalizeChannels' });
    } catch (error) {
      console.warn('[TCV] failed to normalize stored channels', error);
    }
    const initialSettingsRevision = settingsRevision;
    const initialChannelRevision = channelRevision;
    // The two are kept in different areas. Either read failing fails the load,
    // so the page never shows one of them read and the other not.
    const [settings, data] = await Promise.all([
      readSettings(chrome.storage),
      chrome.storage.local.get(CHANNEL_VOLUMES_KEY)
    ]);
    // The page has already been shown as one whose load did not arrive, so what
    // arrives afterwards does not get to fill it in behind that.
    if (loadFailed) return;
    if (initialSettingsRevision === settingsRevision) {
      renderSettings(settings);
    }
    if (initialChannelRevision === channelRevision) {
      channelVolumes = data[CHANNEL_VOLUMES_KEY] || {};
      channelsRead = true;
      renderChannels(channelVolumes);
    }
  }

  function setActiveUnit(unit) {
    document.querySelectorAll('#unitToggle button').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-unit') === unit);
    });
  }

  function renderChannels(all) {
    // Whether the list is empty is something only a read can say. Until one has
    // happened the table and its empty-list line stay as the markup ships them,
    // so a render driven by anything else leaves them alone.
    if (!channelsRead) return;
    const body = $('channelsBody');
    body.innerHTML = '';
    // The rows are in the order of what each is shown under.
    const ids = Object.keys(all).sort((a, b) => rowLabel(a, all[a]).localeCompare(rowLabel(b, all[b])));
    $('emptyMsg').style.display = ids.length === 0 ? '' : 'none';
    document.querySelector('.channel-table').style.display = ids.length === 0 ? 'none' : '';
    for (const id of ids) {
      const entry = all[id];
      const tr = document.createElement('tr');
      // A stored name that is not text is shown as the channel id.
      const name = rowLabel(id, entry);
      const url = twitchUrlForId(id, entry);
      const link = url
        ? `<a class="ch-link" href="${esc(url)}" target="_blank">${esc(name)}</a>`
        : esc(name);
      const live = formatChannelGain(entry, 'live');
      const vod = formatChannelGain(entry, 'vod');
      tr.innerHTML = `
        <td class="ch-name">${link}</td>
        <td class="${live.className}">${live.text}</td>
        <td class="${vod.className}">${vod.text}</td>
        <td style="text-align:right;"><button class="ch-del" data-id="${esc(id)}"${settingsReady ? '' : ' disabled'} title="${esc(msg('delete'))}">&times;</button></td>
      `;
      body.appendChild(tr);
    }
    body.querySelectorAll('button[data-id]').forEach((btn) => {
      btn.addEventListener('click', () => removeChannel(btn.getAttribute('data-id')));
    });
  }

  function gainCellClass(g) {
    return Number.isFinite(g) ? 'ch-vol' : 'ch-vol empty';
  }

  function manualGainForKind(entry, kind) {
    return extractGainForKind(entry, kind);
  }

  function formatChannelGain(entry, kind) {
    const manualGain = manualGainForKind(entry, kind);
    const auto = resolveAutoApplySetting(entry, kind, defaultAutoApply[kind]);
    if (auto) {
      return {
        className: 'ch-vol auto',
        text: esc(formatAutoGain(
          extractAutoDisplayGain(entry, kind),
          displayUnit,
          msg('labelAuto')
        ))
      };
    }
    return {
      className: gainCellClass(manualGain),
      text: formatGainCell(manualGain)
    };
  }

  function formatGainCell(g) {
    if (!Number.isFinite(g)) return '—';
    const f = formatGain(g, displayUnit);
    return esc(f.text + f.unit);
  }

  function twitchUrlForId(id, entry) {
    return twitchChannelUrlForEntry(id, entry);
  }

  async function mutateChannelVolumes(mutation) {
    await requestWrite({ type: CHANNEL_MUTATION_MESSAGE, mutation });
  }

  async function mutateSettings(patch) {
    if (!settingsReady) throw new Error('settings not loaded');
    await requestWrite({ type: SETTINGS_MUTATION_MESSAGE, mutation: { operation: 'patchSettings', patch } });
  }

  // The page says the saved value was put back, or, where the re-read failed
  // as well, asks for a reload.
  async function reloadSettingsAfterFailure(error) {
    const revision = settingsRevision;
    let errorKey = 'settingsSaveFailed';
    try {
      const settings = await readSettings(chrome.storage);
      if (revision === settingsRevision) renderSettings(settings);
      renderChannels(channelVolumes);
    } catch (reloadError) {
      errorKey = 'settingsLoadFailed';
      console.error('[TCV] failed to reload settings after save failure', reloadError);
    }
    showSettingsError(true, errorKey);
    console.error('[TCV] failed to save settings field', error);
  }

  async function updateSettings(patch) {
    if (!settingsReady) return;
    renderSettings({ ...currentSettings, ...patch });
    renderChannels(channelVolumes);
    try {
      await mutateSettings(patch);
      showSettingsError(false);
    } catch (error) {
      await reloadSettingsAfterFailure(error);
    }
  }

  async function removeChannel(id) {
    // The rows a load never finished are not rows to delete from.
    if (!settingsReady) return;
    try {
      await mutateChannelVolumes({ operation: 'deleteChannel', channelId: id });
    } catch (error) {
      console.warn('[TCV] failed to delete the channel', error);
      alert(msg('channelUpdateFailed'));
    }
  }

  async function clearAll() {
    if (!settingsReady) return;
    if (!confirm(msg('clearAllConfirm'))) return;
    try {
      await mutateChannelVolumes({ operation: 'clearChannels' });
    } catch (error) {
      console.warn('[TCV] failed to clear the saved channels', error);
      alert(msg('channelUpdateFailed'));
    }
  }

  // A key held on a settings slider moves its label alone, and the changes its
  // repeats fire write nothing: the value is written once, where the last of the
  // keys that move the value (createSliderKeys) is let go; any other key takes
  // no part. A key or the pointer held on the slider when focus leaves the slider or
  // the page ends the gesture there; a key's value is written then, and a
  // drag's by the change Chrome fires ahead of the blur. After that the
  // slider's input does nothing and its change puts the thumb back to the
  // setting the page holds (the value written, or the one a failed write put
  // back), until the pointer or a key that moves the value is pressed on it
  // again. A settings change that arrives during a gesture is
  // left off the slider (settingsSliderHeld); a gesture that writes nothing at
  // its end (a key that moved nothing, a drag let go of where it began, a press
  // a blur ended) draws the setting there.
  function holdSettingsSlider(field, drawLabel) {
    const slider = $(field);
    const keys = createSliderKeys();
    let keyHeld = false;
    let keyMoved = false;
    let pointerHeld = false;
    let pointerStart = null;
    let gestureEnded = false;
    settingsSliderHeld[field] = () => keyHeld || pointerHeld;
    const drawSetting = () => {
      slider.value = String(currentSettings[field]);
      drawLabel(currentSettings[field]);
    };
    // Whether a key was held.
    const endKeyHold = () => {
      if (!keyHeld) return false;
      keyHeld = false;
      const moved = keyMoved;
      keyMoved = false;
      if (moved) void updateSettings({ [field]: Number(slider.value) });
      else drawSetting();
      return true;
    };
    const endGestureOnBlur = () => {
      keys.clear();
      if (!endKeyHold() && !pointerHeld) return;
      drawSetting();
      pointerHeld = false;
      gestureEnded = true;
    };
    // Only the primary button drags the slider; another button moves no value,
    // and its release goes to the window, so it begins no gesture.
    slider.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      pointerHeld = true;
      pointerStart = Number(slider.value);
      gestureEnded = false;
    });
    // A release on the value the press began on fires no change after it, and
    // draws the setting, which a settings change during the press may have moved.
    const releasePointer = () => {
      if (pointerHeld && Number(slider.value) === pointerStart) drawSetting();
      pointerHeld = false;
    };
    slider.addEventListener('pointerup', releasePointer);
    slider.addEventListener('pointercancel', releasePointer);
    slider.addEventListener('keydown', (e) => {
      if (!keys.press(e)) return;
      gestureEnded = false;
      keyHeld = true;
    });
    slider.addEventListener('keyup', (e) => {
      if (keys.release(e)) endKeyHold();
    });
    slider.addEventListener('blur', endGestureOnBlur);
    window.addEventListener('blur', endGestureOnBlur);
    slider.addEventListener('input', (e) => {
      if (gestureEnded) return;
      if (keyHeld) keyMoved = true;
      drawLabel(Number(e.target.value));
    });
    slider.addEventListener('change', (e) => {
      if (gestureEnded) {
        drawSetting();
        return;
      }
      if (keyHeld) return;
      void updateSettings({ [field]: Number(e.target.value) });
    });
  }
  holdSettingsSlider('targetLufs', (v) => {
    $('targetLufsValue').textContent = v + ' LUFS';
  });
  holdSettingsSlider('adGainDb', (v) => {
    $('adGainValue').textContent = (v > 0 ? '+' : '') + v + ' dB';
  });

  for (const kind of ['live', 'vod']) {
    const id = `defaultAuto${kind[0].toUpperCase()}${kind.slice(1)}Toggle`;
    const toggle = $(id);
    toggle.addEventListener('change', async () => {
      if (!settingsReady) return;
      const field = autoApplyDefaultFieldForKind(kind);
      toggle.disabled = true;
      try {
        await updateSettings({ [field]: toggle.checked });
      } finally {
        toggle.disabled = false;
      }
    });
  }

  document.querySelectorAll('#unitToggle button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!settingsReady) return;
      // The unit already in use is not written again.
      if (btn.getAttribute('data-unit') === displayUnit) return;
      await updateSettings({ displayUnit: btn.getAttribute('data-unit') });
    });
  });

  $('overlayToggle').addEventListener('change', (event) => {
    void updateSettings({ showGainOverlay: event.target.checked });
  });

  $('clearAllBtn').addEventListener('click', clearAll);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    // The page that could not read its own settings is telling the viewer to
    // reload it. What another tab writes after that would stand on a page whose
    // own read never landed, so none of it is taken. A change that arrived
    // before the failure is already on screen and stays there.
    if (loadFailed) return;
    // Chrome sends one event per area. The channel list is kept in local and
    // the settings in sync; the settings key changes in local only when the
    // worker moves it out, and that removal carries no value to render.
    if (areaName === 'local' && changes[CHANNEL_VOLUMES_KEY]) {
      channelRevision++;
      channelVolumes = changes[CHANNEL_VOLUMES_KEY].newValue || {};
      channelsRead = true;
      renderChannels(channelVolumes);
    }
    if (areaName === 'sync' && changes[SETTINGS_KEY]) {
      settingsRevision++;
      renderSettings(changes[SETTINGS_KEY].newValue || {});
      renderChannels(channelVolumes);
    }
  });

  applyI18n();
  setSettingsControlsDisabled(true);
  // A load that never settles would leave the page hidden for good, so the wait
  // has an end (runPageLoad's) and it ends the same way a failure does.
  runPageLoad(loadAll, {
    onLoaded() {
      settingsReady = true;
      setSettingsControlsDisabled(false);
      // The rows were built while the load was still out, so their delete
      // buttons carry the state it had then.
      renderChannels(channelVolumes);
    },
    onFailed(error) {
      loadFailed = true;
      showSettingsError(true, 'settingsLoadFailed');
      console.error('[TCV] failed to load settings', error);
    }
  });
})();
