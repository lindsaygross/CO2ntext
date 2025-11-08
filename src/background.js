const SETTINGS_KEY = 'ecoprompt_settings';
const TOTALS_KEY = 'ecoprompt_totals';
const HISTORY_KEY = 'ecoprompt_history';

const DEFAULT_SETTINGS = {
  mode: 'balanced',
  theme: 'sage',
  gridIntensity: 400
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get([SETTINGS_KEY, TOTALS_KEY, HISTORY_KEY], (data) => {
    const updates = {};
    if (!data[SETTINGS_KEY]) {
      updates[SETTINGS_KEY] = DEFAULT_SETTINGS;
    }
    if (!data[TOTALS_KEY]) {
      updates[TOTALS_KEY] = {};
    }
    if (!data[HISTORY_KEY]) {
      updates[HISTORY_KEY] = [];
    }
    if (Object.keys(updates).length) {
      chrome.storage.sync.set(updates);
    }
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ecoprompt:resetToday') {
    const today = new Date().toISOString().slice(0, 10);
    chrome.storage.sync.get([TOTALS_KEY, HISTORY_KEY], (data) => {
      const totals = data[TOTALS_KEY] || {};
      const history = (data[HISTORY_KEY] || []).filter((entry) => entry?.date !== today);
      totals[today] = { tokens: 0, energyWh: 0, co2g: 0, waterMl: 0 };
      chrome.storage.sync.set({ [TOTALS_KEY]: totals, [HISTORY_KEY]: history }, () => {
        sendResponse({ ok: true });
      });
    });
    return true; // async
  }
  if (message?.type === 'ecoprompt:clearHistory') {
    chrome.storage.sync.set({ [TOTALS_KEY]: {}, [HISTORY_KEY]: [] }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }
  return undefined;
});
