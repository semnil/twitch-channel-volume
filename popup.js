// popup.js — Twitch Channel Volume popup.

(() => {
  'use strict';

  function $(id) { return document.getElementById(id); }

  let displayUnit = '%';

  function formatGainText(gain) {
    const f = formatGain(gain, displayUnit);
    return f.text + f.unit;
  }

  function applyI18n() {
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

  function setLufsCell(id, v) {
    const el = $(id);
    const s = fmtLufs(v);
    if (s === null) {
      el.textContent = '---';
      el.classList.add('unknown');
    } else {
      el.textContent = s + ' LUFS';
      el.classList.remove('unknown');
    }
  }

  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
  }

  async function requestState() {
    const tab = await getActiveTab();
    if (!tab?.url || !/twitch\.tv/.test(tab.url)) {
      showError(msg('openOnTwitch'));
      return null;
    }
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { cmd: 'getState' });
      return res;
    } catch (err) {
      showError(msg('reloadPageNeeded'));
      return null;
    }
  }

  function showError(text) {
    const box = $('errBox');
    box.textContent = text;
    box.classList.remove('hidden');
    $('mainArea').classList.add('hidden');
  }

  function renderState(state) {
    if (!state) return;
    const ch = state.channel || {};
    const nameEl = $('channelName');
    if (ch.name) {
      nameEl.textContent = ch.name;
      nameEl.classList.remove('empty');
    } else {
      nameEl.textContent = msg('channelNotDetected');
      nameEl.classList.add('empty');
    }
    const kindEl = $('channelKind');
    if (ch.kind && ch.kind !== 'none') {
      kindEl.className = 'type-badge ' + ch.kind;
      let kindLabel = '';
      if (ch.kind === 'live') kindLabel = msg('typeLive');
      else if (ch.kind === 'vod') kindLabel = msg('typeVod');
      else if (ch.kind === 'clip') kindLabel = msg('typeClip');
      kindEl.textContent = kindLabel;
    } else {
      kindEl.className = 'type-badge hidden';
      kindEl.textContent = '';
    }

    const lufs = state.lufs || {};
    setLufsCell('integrated', lufs.integrated);

    const suggestedEl = $('suggested');
    const measured = Number.isFinite(lufs.integrated) ? lufs.integrated : lufs.shortTerm;
    if (Number.isFinite(measured) && Number.isFinite(state.targetLufs)) {
      const g = calcGain(measured, state.targetLufs);
      suggestedEl.textContent = formatGainText(g);
      suggestedEl.classList.remove('unknown');
      $('applyBtn').disabled = false;
      $('applyHint').textContent = '';
    } else {
      suggestedEl.textContent = '---';
      suggestedEl.classList.add('unknown');
      $('applyBtn').disabled = true;
      $('applyHint').textContent = msg('hintNoLufs');
    }

    const gain = state.gain || 1;
    const gainPct = gainToPercent(gain);
    $('current').textContent = formatGainText(gain);
    $('manualSlider').value = String(gainPct);
    $('manualValue').textContent = formatGainText(gain);

    const adGainEl = $('adGainLabel');
    if (Number.isFinite(state.adGainDb)) {
      adGainEl.textContent = (state.adGainDb > 0 ? '+' : '') + state.adGainDb + ' dB';
      adGainEl.classList.remove('unknown');
    } else {
      adGainEl.textContent = '---';
      adGainEl.classList.add('unknown');
    }

    $('adFlag').classList.toggle('hidden', !state.adActive);
  }

  async function applyMeasured() {
    const tab = await getActiveTab();
    if (!tab) return;
    await chrome.tabs.sendMessage(tab.id, { cmd: 'resume' });
    const res = await chrome.tabs.sendMessage(tab.id, { cmd: 'applyMeasured' });
    if (res?.ok) refresh();
  }

  async function setGain(percent) {
    const tab = await getActiveTab();
    if (!tab) return;
    const gain = percentToGain(percent);
    await chrome.tabs.sendMessage(tab.id, { cmd: 'setGain', gain });
  }

  async function refresh() {
    const state = await requestState();
    renderState(state);
  }

  $('applyBtn').addEventListener('click', applyMeasured);
  $('manualSlider').addEventListener('input', (e) => {
    const g = percentToGain(Number(e.target.value));
    $('current').textContent = formatGainText(g);
    $('manualValue').textContent = formatGainText(g);
  });
  $('manualSlider').addEventListener('change', (e) => setGain(Number(e.target.value)));
  document.querySelectorAll('.presets button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = Number(btn.getAttribute('data-gain'));
      const g = percentToGain(v);
      $('manualSlider').value = String(v);
      $('manualValue').textContent = formatGainText(g);
      $('current').textContent = formatGainText(g);
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
      refresh();
    }
  });

  applyI18n();
  (async () => {
    await loadDisplayUnit();
    refresh();
  })();
  setInterval(refresh, 1000);
})();
