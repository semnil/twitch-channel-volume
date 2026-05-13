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

  async function loadAll() {
    const data = await chrome.storage.local.get([SETTINGS_KEY, CHANNEL_VOLUMES_KEY]);
    const settings = data[SETTINGS_KEY] || {};
    $('targetLufs').value = settings.targetLufs ?? DEFAULT_TARGET_LUFS;
    $('targetLufsValue').textContent = String($('targetLufs').value);
    $('adGainDb').value = settings.adGainDb ?? DEFAULT_AD_GAIN_DB;
    $('adGainValue').textContent = $('adGainDb').value + ' dB';
    $('displayUnit').value = settings.displayUnit || '%';
    renderChannels(data[CHANNEL_VOLUMES_KEY] || {}, $('displayUnit').value);
  }

  function renderChannels(all, unit) {
    const body = $('channelsBody');
    body.innerHTML = '';
    const ids = Object.keys(all);
    $('emptyMsg').style.display = ids.length === 0 ? '' : 'none';
    for (const id of ids) {
      const entry = all[id];
      const tr = document.createElement('tr');
      const name = entry.name || id;
      const url = entry.url || twitchUrlForId(id, entry);
      const link = url ? `<a href="${esc(url)}" target="_blank">${esc(name)}</a>` : esc(name);
      tr.innerHTML = `
        <td>${link}</td>
        <td class="right">${formatGainCell(entry.gainLive, unit)}</td>
        <td class="right">${formatGainCell(entry.gainVod, unit)}</td>
        <td class="right">${formatGainCell(entry.gainClip, unit)}</td>
        <td class="right"><button class="secondary" data-id="${esc(id)}" data-i18n="delete">削除</button></td>
      `;
      body.appendChild(tr);
    }
    body.querySelectorAll('button[data-id]').forEach((btn) => {
      btn.addEventListener('click', () => removeChannel(btn.getAttribute('data-id')));
    });
    applyI18n();
  }

  function formatGainCell(g, unit) {
    if (!Number.isFinite(g)) return '—';
    const f = formatGain(g, unit);
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
      displayUnit: $('displayUnit').value
    };
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  }

  async function removeChannel(id) {
    const data = await chrome.storage.local.get(CHANNEL_VOLUMES_KEY);
    const all = data[CHANNEL_VOLUMES_KEY] || {};
    delete all[id];
    await chrome.storage.local.set({ [CHANNEL_VOLUMES_KEY]: all });
    renderChannels(all, $('displayUnit').value);
  }

  async function clearAll() {
    if (!confirm(msg('clearAllConfirm'))) return;
    await chrome.storage.local.set({ [CHANNEL_VOLUMES_KEY]: {} });
    renderChannels({}, $('displayUnit').value);
  }

  $('targetLufs').addEventListener('input', (e) => {
    $('targetLufsValue').textContent = String(e.target.value);
  });
  $('targetLufs').addEventListener('change', saveSettings);
  $('adGainDb').addEventListener('input', (e) => {
    $('adGainValue').textContent = e.target.value + ' dB';
  });
  $('adGainDb').addEventListener('change', saveSettings);
  $('displayUnit').addEventListener('change', async () => {
    await saveSettings();
    const data = await chrome.storage.local.get(CHANNEL_VOLUMES_KEY);
    renderChannels(data[CHANNEL_VOLUMES_KEY] || {}, $('displayUnit').value);
  });
  $('clearAllBtn').addEventListener('click', clearAll);

  chrome.storage.onChanged.addListener((changes) => {
    if (changes[CHANNEL_VOLUMES_KEY]) {
      renderChannels(changes[CHANNEL_VOLUMES_KEY].newValue || {}, $('displayUnit').value);
    }
  });

  applyI18n();
  loadAll();
})();
