// options.js — Twitch Channel Volume settings.

(() => {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      const text = msg(key);
      if (text && text !== key) el.textContent = text;
    });
  }

  let displayUnit = '%';

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
      tr.innerHTML = `
        <td class="ch-name">${link}</td>
        <td class="${gainCellClass(entry.gainLive)}">${formatGainCell(entry.gainLive)}</td>
        <td class="${gainCellClass(entry.gainVod)}">${formatGainCell(entry.gainVod)}</td>
        <td class="${gainCellClass(entry.gainClip)}">${formatGainCell(entry.gainClip)}</td>
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

  async function saveSettings() {
    const settings = {
      targetLufs: Number($('targetLufs').value),
      adGainDb: Number($('adGainDb').value),
      displayUnit,
      showGainOverlay: $('overlayToggle').checked
    };
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  }

  async function removeChannel(id) {
    const data = await chrome.storage.local.get(CHANNEL_VOLUMES_KEY);
    const all = data[CHANNEL_VOLUMES_KEY] || {};
    delete all[id];
    await chrome.storage.local.set({ [CHANNEL_VOLUMES_KEY]: all });
    renderChannels(all);
  }

  async function clearAll() {
    if (!confirm(msg('clearAllConfirm'))) return;
    await chrome.storage.local.set({ [CHANNEL_VOLUMES_KEY]: {} });
    renderChannels({});
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
  });

  applyI18n();
  loadAll();
})();
