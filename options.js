// options.js — Twitch Channel Volume settings.

(() => {
  'use strict';

  const CHANNEL_MUTATION_MESSAGE = '__twitch_channel_volume_channel_mutation__';
  // How long the page waits for a load that never answers before it says so.
  const LOAD_TIMEOUT_MS = 3000;

  function $(id) { return document.getElementById(id); }

  function showSettingsError(visible, key = 'settingsSaveFailed') {
    const line = $('settingsError');
    if (visible) line.textContent = msg(key);
    line.classList.toggle('hidden', !visible);
  }

  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      const text = msg(key);
      if (text && text !== key) el.textContent = text;
    });
    const language = msg('pageLanguage');
    if (language !== 'pageLanguage') document.documentElement.lang = language;
  }

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
    const target = currentSettings.targetLufs;
    $('targetLufs').value = String(target);
    $('targetLufsValue').textContent = target + ' LUFS';
    const adDb = currentSettings.adGainDb;
    $('adGainDb').value = String(adDb);
    $('adGainValue').textContent = (adDb > 0 ? '+' : '') + adDb + ' dB';
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
      readStoredSettings(chrome.storage, SETTINGS_KEY),
      chrome.storage.local.get(CHANNEL_VOLUMES_KEY)
    ]);
    // The page has already been shown as one whose load did not arrive, so what
    // arrives afterwards does not get to fill it in behind that.
    if (loadFailed) return;
    if (initialSettingsRevision === settingsRevision) {
      renderSettings(settings || {});
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
    const ids = Object.keys(all);
    $('emptyMsg').style.display = ids.length === 0 ? '' : 'none';
    document.querySelector('.channel-table').style.display = ids.length === 0 ? 'none' : '';
    for (const id of ids) {
      const entry = all[id];
      const tr = document.createElement('tr');
      // A stored name that is not text is shown as the channel id.
      const name = typeof entry.name === 'string' && entry.name ? entry.name : id;
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
    const response = await chrome.runtime.sendMessage({
      type: CHANNEL_MUTATION_MESSAGE,
      mutation
    });
    if (!response?.ok) throw new Error(response?.reason || 'channelVolumes mutation failed');
  }

  async function mutateSettings(patch) {
    if (!settingsReady) throw new Error('settings not loaded');
    const response = await chrome.runtime.sendMessage({
      type: SETTINGS_MUTATION_MESSAGE,
      mutation: { operation: 'patchSettings', patch }
    });
    if (!response?.ok) throw new Error(response?.reason || 'settings mutation failed');
  }

  // The page says the saved value was put back, or, where the re-read failed
  // as well, asks for a reload.
  async function reloadSettingsAfterFailure(error) {
    const revision = settingsRevision;
    let errorKey = 'settingsSaveFailed';
    try {
      const settings = await readStoredSettings(chrome.storage, SETTINGS_KEY);
      if (revision === settingsRevision) renderSettings(settings || {});
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
  // repeats fire write nothing. The value is written once, where the key is let
  // go or focus leaves the slider or the page; after a loss of focus the
  // slider's input does nothing and its change puts the thumb back to the value
  // written then, until a key or the pointer is pressed on it again.
  function holdSettingsSlider(field, drawLabel) {
    const slider = $(field);
    let keyHeld = false;
    let keyMoved = false;
    let gestureEnded = false;
    let valueAtEnd = '';
    // Whether a key was held.
    const endKeyHold = () => {
      if (!keyHeld) return false;
      keyHeld = false;
      const moved = keyMoved;
      keyMoved = false;
      if (moved) void updateSettings({ [field]: Number(slider.value) });
      return true;
    };
    const endGestureOnBlur = () => {
      if (!endKeyHold()) return;
      gestureEnded = true;
      valueAtEnd = slider.value;
    };
    slider.addEventListener('pointerdown', () => { gestureEnded = false; });
    slider.addEventListener('keydown', (e) => {
      if (!e.repeat) gestureEnded = false;
      keyHeld = true;
    });
    slider.addEventListener('keyup', endKeyHold);
    slider.addEventListener('blur', endGestureOnBlur);
    window.addEventListener('blur', endGestureOnBlur);
    slider.addEventListener('input', (e) => {
      if (gestureEnded) return;
      if (keyHeld) keyMoved = true;
      drawLabel(Number(e.target.value));
    });
    slider.addEventListener('change', (e) => {
      if (gestureEnded) {
        e.target.value = valueAtEnd;
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

  function revealOptions() {
    // Commit the values the load wrote while the transitions are off, then show
    // the page on the next frame.
    void document.body.offsetWidth;
    requestAnimationFrame(() => {
      document.body.classList.remove('initializing');
    });
  }

  function loadDeadline() {
    return new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('settings load timed out')), LOAD_TIMEOUT_MS);
    });
  }

  applyI18n();
  setSettingsControlsDisabled(true);
  // A load that never settles would leave the page hidden for good, so the wait
  // has an end and it ends the same way a failure does.
  Promise.race([loadAll(), loadDeadline()]).then(() => {
    settingsReady = true;
    setSettingsControlsDisabled(false);
    // The rows were built while the load was still out, so their delete buttons
    // carry the state it had then.
    renderChannels(channelVolumes);
  }).catch((error) => {
    loadFailed = true;
    showSettingsError(true, 'settingsLoadFailed');
    console.error('[TCV] failed to load settings', error);
  }).finally(revealOptions);
})();
