(() => {
  const SETTINGS_KEY = 'ecoprompt_settings';
  const TOTALS_KEY = 'ecoprompt_totals';
  const HISTORY_KEY = 'ecoprompt_history';
  const DEFAULT_SETTINGS = {
    mode: 'balanced',
    theme: 'sage',
    gridIntensity: 400
  };
  const MODE_MULTIPLIER = {
    small: 0.4, // 0.2 Wh / 0.5 Wh baseline
    balanced: 1,
    large: 2
  };
  const TIP_THRESHOLD_TOKENS = 1500;
  const ENERGY_GOAL_WH = 10;
  const IMAGE_KEYWORDS = /\\b(image|images|draw|photo|render|picture|diffusion|dalle|dream|visual)\\b/;
  const RESPONSE_SELECTORS = [
    '[data-message-author-role=\"assistant\"]',
    '[data-testid=\"conversation-turn\"]',
    'article [data-message-author-role=\"assistant\"]',
    '.assistant, .assistant-message, .model-response, .ai-response',
    'cib-serp .response'
  ];
  const PROMPT_INPUT_SELECTORS = ['textarea', 'div[contenteditable=\"true\"]', '[role=\"textbox\"]'];
  const EMBEDDING_LABELS = ['text', 'image', 'audio'];
  const WORD_EMBEDDINGS = {
    summarize: [1, 0, 0],
    summary: [1, 0, 0],
    essay: [1, 0, 0],
    paragraph: [1, 0, 0],
    outline: [1, 0, 0],
    report: [1, 0, 0],
    draw: [0, 1, 0],
    image: [0, 1, 0],
    images: [0, 1, 0],
    illustration: [0, 1, 0],
    render: [0, 1, 0],
    picture: [0, 1, 0],
    dalle: [0, 1, 0],
    diffusion: [0, 1, 0],
    photo: [0, 1, 0],
    sketch: [0, 1, 0],
    concept: [0, 1, 0],
    mosaic: [0, 1, 0],
    audio: [0, 0, 1],
    speech: [0, 0, 1],
    podcast: [0, 0, 1],
    transcribe: [0, 0, 1],
    transcription: [0, 0, 1],
    voice: [0, 0, 1],
    minutes: [0, 0, 1]
  };
  const processedNodes = new WeakSet();
  let energyReference;
  let state = {
    settings: DEFAULT_SETTINGS,
    lastMode: DEFAULT_SETTINGS.mode,
    todayTotals: { tokens: 0, energyWh: 0, co2g: 0, waterMl: 0 },
    todayKey: new Date().toISOString().slice(0, 10),
    themeClass: 'ecoprompt-theme-sage'
  };
  let widgetElements = {};
  const promptOverlays = new WeakMap();

  init().catch((err) => {
    console.error('EcoPrompt init failed', err);
  });

  async function init() {
    energyReference = await loadEnergyReference();
    await hydrateSettings();
    await hydrateTotals();
    injectWidget();
    scanExistingResponses();
    setUpObservers();
    initPromptEstimator();
    chrome.storage.onChanged.addListener(handleStorageChange);
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      chrome.storage.sync.get([key], (data) => resolve(data[key]));
    });
  }

  function storageSet(payload) {
    return new Promise((resolve) => {
      chrome.storage.sync.set(payload, resolve);
    });
  }

  async function hydrateSettings() {
    const stored = await storageGet(SETTINGS_KEY);
    state.settings = { ...DEFAULT_SETTINGS, ...(stored || {}) };
    state.lastMode = state.settings.mode;
    state.themeClass = `ecoprompt-theme-${state.settings.theme || 'sage'}`;
    document.documentElement.classList.add(state.themeClass);
  }

  async function hydrateTotals() {
    const totals = (await storageGet(TOTALS_KEY)) || {};
    state.todayKey = new Date().toISOString().slice(0, 10);
    state.todayTotals = totals[state.todayKey] || { tokens: 0, energyWh: 0, co2g: 0, waterMl: 0 };
  }

  async function loadEnergyReference() {
    const res = await fetch(chrome.runtime.getURL('data/energy_reference.json'));
    return res.json();
  }

  function scanExistingResponses() {
    RESPONSE_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => scheduleProcess(node));
    });
  }

  function setUpObservers() {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          if (RESPONSE_SELECTORS.some((selector) => node.matches?.(selector))) {
            scheduleProcess(node);
          } else {
            const candidate = node.querySelector?.(RESPONSE_SELECTORS.join(', '));
            if (candidate) {
              scheduleProcess(candidate);
            }
          }
        });
      });
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function scheduleProcess(node) {
    if (processedNodes.has(node)) return;
    processedNodes.add(node);
    setTimeout(() => processResponseNode(node), 500); // handle streaming delay
  }

  async function processResponseNode(node) {
    if (!node || !document.contains(node)) return;
    const text = extractResponseText(node);
    const textLength = text.trim().length;
    const hasRichMedia = !!node.querySelector('img, canvas, video, audio');

    if (textLength < 20 && !hasRichMedia) return;

    const modalityInfo = detectModality(text, node);
    const tokens = modalityInfo.modality === 'image'
      ? 0
      : estimateTokensFromText(text);
    const units = estimateUnits(modalityInfo.modality, node, tokens, textLength, modalityInfo.estimatedMinutes);
    const impact = await computeImpact(modalityInfo.modality, units, tokens);

    if (!impact) {
      injectLabel(node, null, modalityInfo);
      return;
    }

    impact.tokens = tokens;
    await updateTotalsInStorage(impact);
    injectLabel(node, impact, modalityInfo);
    maybeShowGreenerTip(impact, tokens, modalityInfo.modality);
  }

  function extractResponseText(node) {
    if (!node) return '';
    const clone = node.cloneNode(true);
    clone.querySelectorAll('script, style').forEach((el) => el.remove());
    return clone.textContent || '';
  }

  function detectModality(text, node) {
    const normalized = (text || '').toLowerCase();
    const modality = (() => {
      const hasImageMedia = !!node.querySelector('img,canvas,figure,picture,svg[data-image]');
      const hasMarkdownImage = /!\[.*\]\(.+\)/.test(normalized);
      if (hasImageMedia || hasMarkdownImage) return 'image';
      if (IMAGE_KEYWORDS.test(normalized)) return 'image';
      if (node.querySelector('audio, video[audio]')) return 'audio';
      if (/\\b(transcribe|audio|recording|speech)\\b/.test(normalized)) return 'audio';
      if (/\\b(pdf|document|report|paper)\\b/.test(normalized)) return 'pdf';
      if (/\\b(unknown|unsupported)\\b/.test(normalized) && !normalized.trim()) return 'unknown';
      return 'text';
    })();

    let estimatedMinutes = 1;
    if (modality === 'audio') {
      const minuteMatch = normalized.match(/(\\d+(?:\\.\\d+)?)\\s?(min|minute)/);
      estimatedMinutes = minuteMatch ? parseFloat(minuteMatch[1]) : Math.max(1, Math.ceil((text.length || 0) / 900));
    }
    return { modality, estimatedMinutes };
  }

  function estimateUnits(modality, node, tokens, textLength, estimatedMinutes = 1) {
    switch (modality) {
      case 'image': {
        const count = node.querySelectorAll('img,canvas,svg').length;
        return Math.max(1, count);
      }
      case 'audio':
        return Math.max(1, estimatedMinutes);
      case 'pdf':
      case 'text':
      default:
        return Math.max(1, tokens || Math.ceil(textLength / 4));
    }
  }

  async function computeImpact(modality, units, tokens) {
    if (!energyReference) return null;
    const multiplier = MODE_MULTIPLIER[state.settings.mode] || 1;
    const grid = state.settings.gridIntensity || energyReference.grid_CO2_g_per_kWh;
    const waterPerKWh = energyReference.water_L_per_kWh;

    let energyWh = 0;
    switch (modality) {
      case 'image':
        energyWh = units * energyReference.modalities.image.Wh_per_image * multiplier;
        break;
      case 'audio':
        energyWh = units * energyReference.modalities.audio.Wh_per_min * multiplier;
        break;
      case 'pdf':
      case 'text':
        energyWh = (units / 1000) * energyReference.modalities.text.Wh_per_1k_tokens * multiplier;
        break;
      default:
        return null;
    }

    const energyKWh = energyWh / 1000;
    const co2g = energyKWh * grid;
    const waterMl = energyKWh * waterPerKWh * 1000;

    return {
      modality,
      units,
      energyWh,
      co2g,
      waterMl,
      tokens
    };
  }

  async function updateTotalsInStorage(impact) {
    const todayKey = new Date().toISOString().slice(0, 10);
    const totals = (await storageGet(TOTALS_KEY)) || {};
    const todayTotals = totals[todayKey] || { tokens: 0, energyWh: 0, co2g: 0, waterMl: 0 };
    todayTotals.tokens += impact.tokens || 0;
    todayTotals.energyWh += impact.energyWh;
    todayTotals.co2g += impact.co2g;
    todayTotals.waterMl += impact.waterMl;
    totals[todayKey] = todayTotals;
    state.todayTotals = todayTotals;
    state.todayKey = todayKey;

    const history = (await storageGet(HISTORY_KEY)) || [];
    history.push({
      timestamp: Date.now(),
      date: todayKey,
      modality: impact.modality,
      tokens: impact.tokens,
      units: impact.units,
      energyWh: impact.energyWh,
      co2g: impact.co2g,
      waterMl: impact.waterMl
    });
    while (history.length > 500) history.shift();
    await storageSet({ [TOTALS_KEY]: totals, [HISTORY_KEY]: history });
    updateWidgetTotals();
  }

  function injectLabel(node, impact, modalityInfo) {
    if (!node || !document.contains(node)) return;
    let anchor = node.querySelector('.ecoprompt-impact-label');
    if (anchor) {
      anchor.remove();
    }

    const label = document.createElement('div');
    label.className = `ecoprompt-impact-label ${state.themeClass}`;
    label.setAttribute('role', 'note');

    if (!impact) {
      label.textContent = 'EcoPrompt: Impact unknown — unsupported content.';
      node.appendChild(label);
      return;
    }

    const summary = document.createElement('div');
    summary.className = 'ecoprompt-impact-summary';
    summary.innerHTML = `♻️ Estimated impact:&nbsp;<strong>⚡ ${formatNumber(impact.energyWh, 2)} Wh • 🌍 ${formatNumber(impact.co2g, 2)} g CO₂ • 💧 ${formatNumber(impact.waterMl, 1)} mL water</strong>`;
    label.appendChild(summary);

    const detailButton = document.createElement('button');
    detailButton.className = 'ecoprompt-detail-toggle';
    detailButton.textContent = 'Click for details';
    const details = buildDetailPanel(impact, modalityInfo.modality);
    detailButton.addEventListener('click', () => {
      details.toggleAttribute('data-open');
    });
    label.appendChild(detailButton);
    label.appendChild(details);
    node.appendChild(label);
  }

  function buildDetailPanel(impact, modality) {
    const container = document.createElement('div');
    container.className = 'ecoprompt-detail-panel';
    const rows = [
      { label: 'Modality', value: modality },
      { label: 'Tokens analyzed', value: impact.tokens },
      { label: 'Energy coeff.', value: describeMode() },
      { label: 'Grid intensity', value: `${state.settings.gridIntensity || energyReference.grid_CO2_g_per_kWh} g CO₂/kWh` }
    ];
    rows.forEach((row) => {
      const line = document.createElement('div');
      line.className = 'ecoprompt-detail-row';
      line.innerHTML = `<span>${row.label}</span><span>${row.value}</span>`;
      container.appendChild(line);
    });

    const methodology = document.createElement('p');
    methodology.className = 'ecoprompt-methodology';
    methodology.innerHTML = 'Based on Stanford CRFM 2024, Poddar et al. 2023, CodeCarbon 2023. Calculated locally — no data leaves this tab. <a href=\"https://crfm.stanford.edu/2024\" target=\"_blank\" rel=\"noreferrer\">Learn more →</a>';
    container.appendChild(methodology);
    return container;
  }

  function describeMode() {
    switch (state.settings.mode) {
      case 'small':
        return 'Small model (0.2 Wh / 1k tokens)';
      case 'large':
        return 'Large model (1.0 Wh / 1k tokens)';
      default:
        return 'Balanced model (0.5 Wh / 1k tokens)';
    }
  }

  function maybeShowGreenerTip(impact, tokens, modality) {
    if (tokens > TIP_THRESHOLD_TOKENS || modality === 'image') {
      showTip(`💡 Tip: You could cut energy use by ~40% with a shorter prompt or smaller model. This turn used ${formatNumber(impact.energyWh, 2)} Wh.`);
    }
  }

  function showTip(message) {
    const existing = document.querySelector('.ecoprompt-tip');
    if (existing) existing.remove();
    const tip = document.createElement('div');
    tip.className = 'ecoprompt-tip';
    tip.textContent = message;
    document.body.appendChild(tip);
    requestAnimationFrame(() => tip.setAttribute('data-visible', 'true'));
    setTimeout(() => {
      tip.removeAttribute('data-visible');
      setTimeout(() => tip.remove(), 400);
    }, 4000);
  }

  function injectWidget() {
    if (document.querySelector('.ecoprompt-widget')) return;
    const widget = document.createElement('div');
    widget.className = `ecoprompt-widget collapsed ${state.themeClass}`;

    const header = document.createElement('button');
    header.className = 'ecoprompt-widget-header';
    header.innerHTML = '<div>Today’s AI Footprint</div><div class=\"ecoprompt-widget-values\"></div>';
    header.addEventListener('click', () => widget.classList.toggle('collapsed'));

    const progress = document.createElement('div');
    progress.className = 'ecoprompt-progress';
    progress.innerHTML = '<div class=\"ecoprompt-progress-bar\"></div>';

    const totals = document.createElement('div');
    totals.className = 'ecoprompt-widget-totals';

    const actions = document.createElement('div');
    actions.className = 'ecoprompt-widget-actions';
    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Reset today';
    resetBtn.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'ecoprompt:resetToday' }));
    const openPopup = document.createElement('button');
    openPopup.textContent = 'Open settings';
    openPopup.addEventListener('click', () => {
      showTip('Open the EcoPrompt popup from the Chrome toolbar to change settings or export data.');
    });
    actions.append(resetBtn, openPopup);

    widget.append(header, progress, totals, actions);
    document.body.appendChild(widget);
    widgetElements = { widget, headerValues: header.querySelector('.ecoprompt-widget-values'), progressBar: progress.querySelector('.ecoprompt-progress-bar'), totals };
    updateWidgetTotals();
  }

  function updateWidgetTotals() {
    if (!widgetElements.widget) return;
    const totals = state.todayTotals;
    if (widgetElements.headerValues) {
      widgetElements.headerValues.textContent = `⚡ ${formatNumber(totals.energyWh, 2)} Wh · 🌍 ${formatNumber(totals.co2g, 2)} g · 💧 ${formatNumber(totals.waterMl, 1)} mL`;
    }
    if (widgetElements.progressBar) {
      const fill = Math.min(1, totals.energyWh / ENERGY_GOAL_WH);
      widgetElements.progressBar.style.width = `${fill * 100}%`;
    }
    if (widgetElements.totals) {
      widgetElements.totals.innerHTML = `
        <div><span>Tokens</span><strong>${formatNumber(totals.tokens, 0)}</strong></div>
        <div><span>Energy</span><strong>${formatNumber(totals.energyWh, 2)} Wh</strong></div>
        <div><span>CO₂</span><strong>${formatNumber(totals.co2g, 2)} g</strong></div>
        <div><span>Water</span><strong>${formatNumber(totals.waterMl, 1)} mL</strong></div>
      `;
    }
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== 'sync') return;
    if (changes[SETTINGS_KEY]) {
      const previousMode = state.settings.mode;
      state.settings = { ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) };
      document.documentElement.classList.remove(state.themeClass);
      state.themeClass = `ecoprompt-theme-${state.settings.theme || 'sage'}`;
      document.documentElement.classList.add(state.themeClass);
      if (MODE_MULTIPLIER[state.settings.mode] < MODE_MULTIPLIER[previousMode]) {
        triggerLeafAnimation();
      }
      state.lastMode = state.settings.mode;
    }
    if (changes[TOTALS_KEY]) {
      const todayKey = new Date().toISOString().slice(0, 10);
      const allTotals = changes[TOTALS_KEY].newValue || {};
      state.todayTotals = allTotals[todayKey] || { tokens: 0, energyWh: 0, co2g: 0, waterMl: 0 };
      updateWidgetTotals();
    }
  }

  function triggerLeafAnimation() {
    if (!widgetElements.widget) return;
    widgetElements.widget.classList.add('ecoprompt-leaf-boost');
    setTimeout(() => widgetElements.widget?.classList.remove('ecoprompt-leaf-boost'), 1200);
  }

  function formatNumber(value, digits = 2) {
    if (typeof value !== 'number' || Number.isNaN(value)) return '0';
    if (digits === 0) return Math.round(value).toLocaleString();
    if (value === 0) return '0';
    if (value < 0.1) return value.toFixed(Math.max(3, digits));
    return value.toFixed(digits);
  }

  function estimateTokensFromText(text) {
    if (!text || !text.trim()) return 0;
    const tokenLike = (text.match(/\b[\w\d'-]+\b/g) || []).length;
    const charEstimate = text.replace(/\s+/g, '').length / 4;
    const average = (tokenLike * 1.3 + charEstimate) / 2;
    return Math.max(1, Math.round(average));
  }

  function initPromptEstimator() {
    scanPromptInputs();
    const observer = new MutationObserver(() => scanPromptInputs());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function scanPromptInputs() {
    PROMPT_INPUT_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((input) => {
        if (!(input instanceof HTMLElement)) return;
        attachPromptOverlay(input);
      });
    });
  }

  function attachPromptOverlay(input) {
    if (promptOverlays.has(input)) return;
    const overlay = document.createElement('div');
    overlay.className = 'ecoprompt-prompt-estimate';
    overlay.textContent = 'Start typing to preview impact.';
    input.insertAdjacentElement('afterend', overlay);
    promptOverlays.set(input, overlay);
    const handler = () => updatePromptEstimate(input, overlay);
    input.addEventListener('input', handler);
    input.addEventListener('focus', handler);
    input.addEventListener('blur', () => overlay.classList.remove('visible'));
  }

  async function updatePromptEstimate(input, overlay) {
    if (!overlay) return;
    const text = readInputValue(input);
    if (!text.trim()) {
      overlay.textContent = 'Start typing to preview impact.';
      overlay.classList.remove('visible');
      return;
    }
    overlay.classList.add('visible');
    const intent = detectIntentWithEmbeddings(text);
    const guess = estimatePromptUnits(intent.modality, text);
    const tokens = intent.modality === 'image' ? 0 : estimateTokensFromText(text);
    const units = intent.modality === 'image' || intent.modality === 'audio' ? guess.units : tokens || guess.units;
    const impact = await computeImpact(intent.modality, units, tokens || guess.tokens || 0);
    if (!impact) {
      overlay.textContent = 'EcoPrompt: impact unknown for this prompt.';
      return;
    }
    const waterDigits = impact.waterMl < 1 ? 2 : 1;
    overlay.innerHTML = `🧠 Preview (${intent.modality}) — ⚡ ${formatNumber(impact.energyWh, 2)} Wh · 🌍 ${formatNumber(impact.co2g, 2)} g · 💧 ${formatNumber(impact.waterMl, waterDigits)} mL`;
  }

  function detectIntentWithEmbeddings(text) {
    const lower = text.toLowerCase();
    const words = lower.match(/\b[\w'-]+\b/g) || [];
    const vector = [0, 0, 0];
    words.forEach((word) => {
      const embedding = WORD_EMBEDDINGS[word];
      if (!embedding) return;
      embedding.forEach((value, idx) => {
        vector[idx] += value;
      });
    });
    let modality = 'text';
    let max = 0;
    vector.forEach((value, idx) => {
      if (value > max) {
        max = value;
        modality = EMBEDDING_LABELS[idx];
      }
    });
    if (IMAGE_KEYWORDS.test(lower)) modality = 'image';
    if (/\b(transcribe|audio|recording|speech|podcast)\b/.test(lower)) modality = 'audio';
    return { modality };
  }

  function estimatePromptUnits(modality, text) {
    const lower = text.toLowerCase();
    switch (modality) {
      case 'image': {
        const match = lower.match(/(\d+)\s?(?:images|pictures|renders|variations)/);
        const count = match ? parseInt(match[1], 10) : 1;
        return { units: Math.max(1, count) };
      }
      case 'audio': {
        const minuteMatch = lower.match(/(\d+(?:\.\d+)?)\s?(?:min|minute|minutes)/);
        const minutes = minuteMatch ? parseFloat(minuteMatch[1]) : Math.max(1, Math.ceil(lower.split(/\s+/).length / 150));
        return { units: minutes };
      }
      default:
        return { units: estimateTokensFromText(text), tokens: estimateTokensFromText(text) };
    }
  }

  function readInputValue(input) {
    if (!input) return '';
    if ('value' in input) return input.value || '';
    return input.textContent || '';
  }
})();
