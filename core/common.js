// core/common.js — The helpers the channel-volume extensions share, loaded as
// a classic script ahead of each extension's utils.js wherever that loads
// (content script, popup, options page, and the service worker where it
// imports utils.js). Every name here is a top-level declaration the scripts
// after it read.

// Gain is a linear factor: 1 is 100% and 0 dB.
function gainToPercent(gain) { return Math.round(gain * 100); }
function percentToGain(pct) { return pct / 100; }

function gainToDb(gain) {
  if (gain <= 0) return '-Inf';
  return (20 * Math.log10(gain)).toFixed(1);
}

// The catalog's text for key, or the key itself where the catalog has none or
// there is no chrome.i18n to ask.
function msg(key, substitutions) {
  if (typeof chrome === 'undefined' || !chrome?.i18n) return key;
  return chrome.i18n.getMessage(key, substitutions) || key;
}

// The gain as the text and unit the display unit setting shows it in.
function formatGain(gain, displayUnit) {
  if (displayUnit === 'dB') return { text: gainToDb(gain), unit: ' dB' };
  return { text: String(gainToPercent(gain)), unit: '%' };
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  // Serialising a text node leaves both quotes alone, and every caller puts the
  // result inside a quoted attribute as well as between tags.
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
