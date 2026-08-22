// options.js — Twitch Channel Volume settings.

(() => {
  'use strict';

  const CHANNEL_MUTATION_MESSAGE = '__twitch_channel_volume_channel_mutation__';

  function $(id) { return document.getElementById(id); }

  function showSettingsError(visible) {
    $('settingsError').classList.toggle('hidden', !visible);
  }

  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      const text = msg(key);
      if (text && text !== key) el.textContent = text;
    });
  }

  let displayUnit = '%';
  let settingsReady = false;
  let settingsRevision = 0;
  let channelRevision = 0;
  let currentSettings = {};
  let channelVolumes = {};
  let defaultAutoApply = {
    live: DEFAULT_AUTO_APPLY_LOUDNESS,
    vod: DEFAULT_AUTO_APPLY_LOUDNESS,
    clip: DEFAULT_AUTO_APPLY_LOUDNESS
  };

  function setSettingsControlsDisabled(disabled) {
    for (const id of [
      'targetLufs',
      'adGainDb',
      'defaultAutoLiveToggle',
      'defaultAutoVodToggle',
      'defaultAutoClipToggle',
      'overlayToggle'
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
        settings.autoApplyLoudnessVodDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS,
      autoApplyLoudnessClipDefault:
        settings.autoApplyLoudnessClipDefault ?? DEFAULT_AUTO_APPLY_LOUDNESS
    };
    const target = currentSettings.targetLufs;
    $('targetLufs').value = String(target);
    $('targetLufsValue').textContent = target + ' LUFS';
    const adDb = currentSettings.adGainDb;
    $('adGainDb').value = String(adDb);
    $('adGainValue').textContent = (adDb > 0 ? '+' : '') + adDb + ' dB';
    displayUnit = currentSettings.displayUnit;
    setActiveUnit(displayUnit);
    for (const kind of ['live', 'vod', 'clip']) {
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
    const data = await chrome.storage.local.get([SETTINGS_KEY, CHANNEL_VOLUMES_KEY]);
    if (initialSettingsRevision === settingsRevision) {
      renderSettings(data[SETTINGS_KEY] || {});
    }
    if (initialChannelRevision === channelRevision) {
      channelVolumes = data[CHANNEL_VOLUMES_KEY] || {};
      renderChannels(channelVolumes);
    }
  }

  function setActiveUnit(unit) {
    document.querySelectorAll('#unitToggle button').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-unit') === unit);
    });
  }

  function renderChannels(all) {
    const body = $('channelsBody');
    body.innerHTML = '';
    const ids = Object.keys(all);
    $('emptyMsg').style.display = ids.length === 0 ? '' : 'none';
    document.querySelector('.channel-table').style.display = ids.length === 0 ? 'none' : '';
    for (const id of ids) {
      const entry = all[id];
      const tr = document.createElement('tr');
      const name = entry.name || id;
      const url = twitchUrlForId(id, entry);
      const link = url
        ? `<a class="ch-link" href="${esc(url)}" target="_blank">${esc(name)}</a>`
        : esc(name);
      const live = formatChannelGain(entry, 'live');
      const vod = formatChannelGain(entry, 'vod');
      const clip = formatChannelGain(entry, 'clip');
      tr.innerHTML = `
        <td class="ch-name">${link}</td>
        <td class="${live.className}">${live.text}</td>
        <td class="${vod.className}">${vod.text}</td>
        <td class="${clip.className}">${clip.text}</td>
        <td style="text-align:right;"><button class="ch-del" data-id="${esc(id)}" title="${esc(msg('delete'))}">&times;</button></td>
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

  async function reloadSettingsAfterFailure(error) {
    const revision = settingsRevision;
    try {
      const data = await chrome.storage.local.get(SETTINGS_KEY);
      if (revision === settingsRevision) renderSettings(data[SETTINGS_KEY] || {});
      renderChannels(channelVolumes);
    } catch (reloadError) {
      console.error('[TCV] failed to reload settings after save failure', reloadError);
    }
    showSettingsError(true);
    console.error('[TCV] failed to save settings field', error);
  }

  async function updateSettings(patch) {
    if (!settingsReady) return false;
    renderSettings({ ...currentSettings, ...patch });
    renderChannels(channelVolumes);
    try {
      await mutateSettings(patch);
      showSettingsError(false);
      return true;
    } catch (error) {
      await reloadSettingsAfterFailure(error);
      return false;
    }
  }

  async function removeChannel(id) {
    try {
      await mutateChannelVolumes({ operation: 'deleteChannel', channelId: id });
    } catch (_) {
      alert(msg('channelUpdateFailed'));
    }
  }

  async function clearAll() {
    if (!confirm(msg('clearAllConfirm'))) return;
    try {
      await mutateChannelVolumes({ operation: 'clearChannels' });
    } catch (_) {
      alert(msg('channelUpdateFailed'));
    }
  }

  $('targetLufs').addEventListener('input', (e) => {
    $('targetLufsValue').textContent = e.target.value + ' LUFS';
  });
  $('targetLufs').addEventListener('change', (e) => {
    void updateSettings({ targetLufs: Number(e.target.value) });
  });
  $('adGainDb').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('adGainValue').textContent = (v > 0 ? '+' : '') + v + ' dB';
  });
  $('adGainDb').addEventListener('change', (e) => {
    void updateSettings({ adGainDb: Number(e.target.value) });
  });

  for (const kind of ['live', 'vod', 'clip']) {
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

  chrome.storage.onChanged.addListener((changes) => {
    if (changes[CHANNEL_VOLUMES_KEY]) {
      channelRevision++;
      channelVolumes = changes[CHANNEL_VOLUMES_KEY].newValue || {};
      renderChannels(channelVolumes);
    }
    if (changes[SETTINGS_KEY]) {
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

  applyI18n();
  setSettingsControlsDisabled(true);
  loadAll().then(() => {
    settingsReady = true;
    setSettingsControlsDisabled(false);
  }).catch((error) => {
    showSettingsError(true);
    console.error('[TCV] failed to load settings', error);
  }).finally(revealOptions);
})();
