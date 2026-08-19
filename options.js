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
  let defaultAutoApply = {
    live: DEFAULT_AUTO_APPLY_LOUDNESS,
    vod: DEFAULT_AUTO_APPLY_LOUDNESS,
    clip: DEFAULT_AUTO_APPLY_LOUDNESS
  };

  async function loadAll() {
    const data = await chrome.storage.local.get([SETTINGS_KEY, CHANNEL_VOLUMES_KEY]);
    const settings = data[SETTINGS_KEY] || {};
    const target = settings.targetLufs ?? DEFAULT_TARGET_LUFS;
    $('targetLufs').value = String(target);
    $('targetLufsValue').textContent = target + ' LUFS';
    const adDb = settings.adGainDb ?? DEFAULT_AD_GAIN_DB;
    $('adGainDb').value = String(adDb);
    $('adGainValue').textContent = (adDb > 0 ? '+' : '') + adDb + ' dB';
    displayUnit = settings.displayUnit || '%';
    setActiveUnit(displayUnit);
    for (const kind of ['live', 'vod', 'clip']) {
      defaultAutoApply[kind] =
        settings[autoApplyDefaultFieldForKind(kind)] ?? DEFAULT_AUTO_APPLY_LOUDNESS;
      $(`defaultAuto${kind[0].toUpperCase()}${kind.slice(1)}Toggle`).checked =
        defaultAutoApply[kind];
    }
    $('overlayToggle').checked = settings.showGainOverlay ?? true;
    renderChannels(data[CHANNEL_VOLUMES_KEY] || {});
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
      const url = entry.url || twitchUrlForId(id, entry);
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
    if (entry?.url) return entry.url;
    if (id.startsWith('login:')) return `https://www.twitch.tv/${id.slice(6)}`;
    if (entry?.login) return `https://www.twitch.tv/${entry.login}`;
    return '';
  }

  async function mutateChannelVolumes(mutation) {
    const response = await chrome.runtime.sendMessage({
      type: CHANNEL_MUTATION_MESSAGE,
      mutation
    });
    if (!response?.ok) throw new Error(response?.reason || 'channelVolumes mutation failed');
  }

  async function saveSettings() {
    const settings = {
      targetLufs: Number($('targetLufs').value),
      adGainDb: Number($('adGainDb').value),
      displayUnit,
      autoApplyLoudnessLiveDefault: $('defaultAutoLiveToggle').checked,
      autoApplyLoudnessVodDefault: $('defaultAutoVodToggle').checked,
      autoApplyLoudnessClipDefault: $('defaultAutoClipToggle').checked,
      showGainOverlay: $('overlayToggle').checked
    };
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
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
  $('targetLufs').addEventListener('change', saveSettings);
  $('adGainDb').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('adGainValue').textContent = (v > 0 ? '+' : '') + v + ' dB';
  });
  $('adGainDb').addEventListener('change', saveSettings);

  for (const kind of ['live', 'vod', 'clip']) {
    const id = `defaultAuto${kind[0].toUpperCase()}${kind.slice(1)}Toggle`;
    const toggle = $(id);
    toggle.addEventListener('change', async () => {
      const previous = defaultAutoApply[kind];
      defaultAutoApply[kind] = toggle.checked;
      toggle.disabled = true;
      try {
        await saveSettings();
      } catch (error) {
        defaultAutoApply[kind] = previous;
        toggle.checked = previous;
        try {
          await loadAll();
        } catch (reloadError) {
          console.error('[TCV] failed to reload settings after save failure', reloadError);
        }
        showSettingsError(true);
        console.error('[TCV] failed to save Auto default', error);
        return;
      } finally {
        toggle.disabled = false;
      }
      showSettingsError(false);
      try {
        const data = await chrome.storage.local.get(CHANNEL_VOLUMES_KEY);
        renderChannels(data[CHANNEL_VOLUMES_KEY] || {});
      } catch (error) {
        console.error('[TCV] failed to refresh channels after settings save', error);
      }
    });
  }

  document.querySelectorAll('#unitToggle button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      displayUnit = btn.getAttribute('data-unit');
      setActiveUnit(displayUnit);
      await saveSettings();
      const data = await chrome.storage.local.get(CHANNEL_VOLUMES_KEY);
      renderChannels(data[CHANNEL_VOLUMES_KEY] || {});
    });
  });

  $('overlayToggle').addEventListener('change', saveSettings);

  $('clearAllBtn').addEventListener('click', clearAll);

  chrome.storage.onChanged.addListener((changes) => {
    if (changes[CHANNEL_VOLUMES_KEY]) {
      renderChannels(changes[CHANNEL_VOLUMES_KEY].newValue || {});
    }
    if (changes[SETTINGS_KEY]) loadAll();
  });

  applyI18n();
  loadAll();
})();
