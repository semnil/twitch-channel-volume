// popup.js — Twitch Channel Volume popup.

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

  function fmtLufs(v) {
    if (!Number.isFinite(v)) return '—';
    return v.toFixed(1);
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
    $('channelName').textContent = ch.name || msg('channelNotDetected');
    const kindEl = $('channelKind');
    kindEl.className = 'kind ' + (ch.kind || 'none');
    let kindLabel = '—';
    if (ch.kind === 'live') kindLabel = msg('typeLive');
    else if (ch.kind === 'vod') kindLabel = msg('typeVod');
    else if (ch.kind === 'clip') kindLabel = msg('typeClip');
    kindEl.textContent = kindLabel;

    const lufs = state.lufs || {};
    $('momentary').textContent = fmtLufs(lufs.momentary);
    $('shortTerm').textContent = fmtLufs(lufs.shortTerm);
    $('integrated').textContent = fmtLufs(lufs.integrated);

    const measured = Number.isFinite(lufs.integrated) ? lufs.integrated : lufs.shortTerm;
    if (Number.isFinite(measured) && Number.isFinite(state.targetLufs)) {
      const g = calcGain(measured, state.targetLufs);
      $('suggested').textContent = gainToPercent(g) + '%';
      $('applyBtn').disabled = false;
    } else {
      $('suggested').textContent = '—';
      $('applyBtn').disabled = true;
    }

    $('current').textContent = gainToPercent(state.gain || 1) + '%';
    $('manualSlider').value = String(gainToPercent(state.gain || 1));
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
    const v = Number(e.target.value);
    $('current').textContent = v + '%';
  });
  $('manualSlider').addEventListener('change', (e) => setGain(Number(e.target.value)));
  document.querySelectorAll('.presets button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = Number(btn.getAttribute('data-gain'));
      $('manualSlider').value = String(v);
      setGain(v);
    });
  });
  $('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

  applyI18n();
  refresh();
  setInterval(refresh, 1000);
})();
