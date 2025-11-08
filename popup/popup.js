const SETTINGS_KEY = 'ecoprompt_settings';
const TOTALS_KEY = 'ecoprompt_totals';
const HISTORY_KEY = 'ecoprompt_history';
const DEFAULT_SETTINGS = {
  mode: 'balanced',
  theme: 'sage',
  gridIntensity: 400
};
const MODE_MULTIPLIER = {
  small: 0.4,
  balanced: 1,
  large: 2
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  totalsByDay: {},
  history: []
};

let energyReference = null;

document.addEventListener('DOMContentLoaded', async () => {
  wireTabs();
  bindControls();
  try {
    await loadEnergyReference();
  } catch (err) {
    console.error('Failed to load energy reference', err);
    setStatus('Could not load energy profile.');
  }
  refresh();
});

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(keys, resolve);
  });
}

function storageSet(payload) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(payload, resolve);
  });
}

async function refresh() {
  const data = await storageGet([SETTINGS_KEY, TOTALS_KEY, HISTORY_KEY]);
  state.settings = { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
  state.totalsByDay = data[TOTALS_KEY] || {};
  state.history = data[HISTORY_KEY] || [];
  syncUI();
}

function wireTabs() {
  const buttons = Array.from(document.querySelectorAll('.tabs button'));
  const panels = Array.from(document.querySelectorAll('section[data-panel]'));
  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      buttons.forEach((btn) => {
        btn.classList.remove('active');
        btn.setAttribute('aria-selected', 'false');
      });
      panels.forEach((panel) => panel.classList.remove('active'));
      button.classList.add('active');
      button.setAttribute('aria-selected', 'true');
      const panel = document.querySelector(`section[data-panel="${button.dataset.tab}"]`);
      panel?.classList.add('active');
    });
  });
}

function bindControls() {
  document.querySelectorAll('input[name="mode"]').forEach((input) => {
    input.addEventListener('change', () => updateSettings({ mode: input.value }));
  });

  document.querySelectorAll('input[name="theme"]').forEach((input) => {
    input.addEventListener('change', () => updateSettings({ theme: input.value }));
  });

  const gridSelect = document.getElementById('grid-select');
  gridSelect?.addEventListener('change', () => updateSettings({ gridIntensity: Number(gridSelect.value) }));

  document.getElementById('export-json')?.addEventListener('click', () => exportData('json'));
  document.getElementById('export-csv')?.addEventListener('click', () => exportData('csv'));
  document.getElementById('reset-today')?.addEventListener('click', () => resetToday());
  document.getElementById('clear-history')?.addEventListener('click', () => clearHistory());

  bindManualEntry();
}

function bindManualEntry() {
  const modalitySelect = document.getElementById('manual-modality');
  const unitsInput = document.getElementById('manual-units');
  const logButton = document.getElementById('manual-log');
  const hint = document.getElementById('manual-hint');
  if (!modalitySelect || !unitsInput || !logButton) return;

  const updateHint = () => {
    const modality = modalitySelect.value;
    const hints = {
      text: 'Tokens processed (approx.). Example: 25,000-token CSV summary.',
      pdf: 'Tokens processed (approx.).',
      image: 'Number of images rendered (default assumes 512×512).',
      audio: 'Minutes of audio processed.',
      video: 'Seconds of video diffusion (experimental).'
    };
    if (hint) {
      hint.textContent = hints[modality] || 'Units processed.';
    }
    const placeholders = {
      text: 'Tokens processed',
      pdf: 'Tokens processed',
      image: 'Images generated',
      audio: 'Minutes processed',
      video: 'Seconds processed'
    };
    unitsInput.placeholder = placeholders[modality] || 'Units';
  };

  modalitySelect.addEventListener('change', updateHint);
  updateHint();

  logButton.addEventListener('click', async () => {
    const modality = modalitySelect.value;
    const units = Number(unitsInput.value);
    if (!units || units <= 0) {
      setStatus('Enter a positive number of units.');
      return;
    }
    await logManualEntry(modality, units);
    unitsInput.value = '';
  });
}

async function loadEnergyReference() {
  if (energyReference) return energyReference;
  const res = await fetch(chrome.runtime.getURL('data/energy_reference.json'));
  if (!res.ok) {
    throw new Error(`energy_reference.json fetch failed (${res.status})`);
  }
  energyReference = await res.json();
  return energyReference;
}

async function updateSettings(partial) {
  state.settings = { ...state.settings, ...partial };
  await storageSet({ [SETTINGS_KEY]: state.settings });
  setStatus('Settings updated.');
}

function syncUI() {
  document.querySelectorAll('input[name="mode"]').forEach((input) => {
    const selected = state.settings.mode === input.value;
    input.checked = selected;
    const parent = input.closest('label');
    if (parent) parent.dataset.selected = selected ? 'true' : 'false';
  });

  document.querySelectorAll('input[name="theme"]').forEach((input) => {
    const selected = state.settings.theme === input.value;
    input.checked = selected;
    const card = input.closest('.theme-card');
    if (card) card.dataset.selected = selected ? 'true' : 'false';
  });

  const gridSelect = document.getElementById('grid-select');
  if (gridSelect) {
    gridSelect.value = String(state.settings.gridIntensity || 400);
  }

  renderTotals();
}

function renderTotals() {
  const today = new Date().toISOString().slice(0, 10);
  const todayTotals = state.totalsByDay[today] || { tokens: 0, energyWh: 0, co2g: 0, waterMl: 0 };
  const grid = document.getElementById('totals-grid');
  grid.innerHTML = `
    <div><span>Tokens</span><strong>${formatNumber(todayTotals.tokens, 0)}</strong></div>
    <div><span>Energy</span><strong>${formatNumber(todayTotals.energyWh, 2)} Wh</strong></div>
    <div><span>CO₂</span><strong>${formatNumber(todayTotals.co2g, 2)} g</strong></div>
    <div><span>Water</span><strong>${formatNumber(todayTotals.waterMl, 1)} mL</strong></div>
  `;
}

async function logManualEntry(modality, units) {
  try {
    if (!energyReference) {
      await loadEnergyReference();
    }
  } catch (err) {
    console.error(err);
    setStatus('Could not load energy profile.');
    return;
  }
  const impact = computeManualImpact(modality, units);
  if (!impact) {
    setStatus('Unsupported task type.');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const totals = { ...state.totalsByDay };
  const todayTotals = { tokens: 0, energyWh: 0, co2g: 0, waterMl: 0, ...(totals[today] || {}) };
  todayTotals.tokens += impact.tokens || 0;
  todayTotals.energyWh += impact.energyWh;
  todayTotals.co2g += impact.co2g;
  todayTotals.waterMl += impact.waterMl;
  totals[today] = todayTotals;

  const history = [...state.history, {
    timestamp: Date.now(),
    date: today,
    modality,
    units,
    manual: true,
    tokens: impact.tokens || 0,
    energyWh: impact.energyWh,
    co2g: impact.co2g,
    waterMl: impact.waterMl
  }];
  while (history.length > 500) history.shift();

  await storageSet({ [TOTALS_KEY]: totals, [HISTORY_KEY]: history });
  state.totalsByDay = totals;
  state.history = history;
  renderTotals();
  setStatus('Manual entry logged.');
}

function computeManualImpact(modality, units) {
  if (!energyReference || !units) return null;
  const multiplier = MODE_MULTIPLIER[state.settings.mode] || 1;
  const grid = state.settings.gridIntensity || energyReference.grid_CO2_g_per_kWh;
  const waterPerKWh = energyReference.water_L_per_kWh;
  let energyWh = 0;
  let tokens = 0;
  switch (modality) {
    case 'image':
      energyWh = units * energyReference.modalities.image.Wh_per_image * multiplier;
      break;
    case 'audio':
      energyWh = units * energyReference.modalities.audio.Wh_per_min * multiplier;
      break;
    case 'pdf':
    case 'text':
    default:
      tokens = units;
      energyWh = (units / 1000) * energyReference.modalities.text.Wh_per_1k_tokens * multiplier;
      break;
  }
  const energyKWh = energyWh / 1000;
  const co2g = energyKWh * grid;
  const waterMl = energyKWh * waterPerKWh * 1000;
  return { energyWh, co2g, waterMl, tokens };
}

function buildDataset() {
  return Object.entries(state.totalsByDay).map(([date, totals]) => ({
    date,
    tokens: totals.tokens || 0,
    energyWh: totals.energyWh || 0,
    co2g: totals.co2g || 0,
    waterMl: totals.waterMl || 0
  })).sort((a, b) => a.date.localeCompare(b.date));
}

async function exportData(format) {
  const dataset = buildDataset();
  if (!dataset.length) {
    setStatus('No data to export yet.');
    return;
  }
  let blob;
  let filename;
  if (format === 'json') {
    blob = new Blob([JSON.stringify(dataset, null, 2)], { type: 'application/json' });
    filename = `ecoprompt-${Date.now()}.json`;
  } else {
    const header = 'date,total_tokens,total_Wh,total_CO2_g,total_water_mL';
    const rows = dataset.map((row) => `${row.date},${row.tokens},${row.energyWh},${row.co2g},${row.waterMl}`);
    blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' });
    filename = `ecoprompt-${Date.now()}.csv`;
  }
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (chrome.runtime.lastError) {
      setStatus('Download blocked: ' + chrome.runtime.lastError.message);
    } else {
      setStatus(`${format.toUpperCase()} export ready.`);
    }
  });
}

async function resetToday() {
  await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'ecoprompt:resetToday' }, resolve);
  });
  await refresh();
  setStatus('Today reset.');
}

async function clearHistory() {
  await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'ecoprompt:clearHistory' }, resolve);
  });
  await refresh();
  setStatus('History cleared.');
}

function formatNumber(value, digits) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '0';
  if (digits === 0) return Math.round(value).toLocaleString();
  return value.toFixed(digits);
}

function setStatus(message) {
  const el = document.getElementById('status');
  el.textContent = message || '';
  if (message) {
    setTimeout(() => {
      if (el.textContent === message) {
        el.textContent = '';
      }
    }, 3000);
  }
}
