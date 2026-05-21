/**
 * Popup Script — i18n enabled
 */

(() => {
  'use strict';

  // ── i18n helper ───────────────────────────────────────────────
  function t(key, ...subs) {
    return chrome.i18n.getMessage(key, subs) || key;
  }

  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
  }

  applyI18n();

  // ── DOM References ────────────────────────────────────────────
  const els = {
    platformBadge:  document.getElementById('platform-badge'),
    platformIcon:   document.getElementById('platform-icon'),
    platformName:   document.getElementById('platform-name'),
    btnExtract:     document.getElementById('btn-extract'),
    btnStop:        document.getElementById('btn-stop'),
    btnCopy:        document.getElementById('btn-copy'),
    resultArea:     document.getElementById('result-area'),
    resultCount:    document.getElementById('result-count'),
    resultText:     document.getElementById('result-text'),
    statusBar:      document.getElementById('status-bar'),
    statusIcon:     document.getElementById('status-icon'),
    statusMessage:  document.getElementById('status-message'),
    optRemoveLinks: document.getElementById('opt-remove-links'),
    optIncludeAds:  document.getElementById('opt-include-ads'),
    optMaxCount:    document.getElementById('opt-max-count'),
    optMaxDown:     document.getElementById('opt-max-down'),
    optMaxUp:       document.getElementById('opt-max-up')
  };

  // ── Storage Keys ──────────────────────────────────────────────
  const STORAGE_KEY = 'sns_extractor_options';
  const RESULT_KEY = 'sns_extractor_last_result';
  const SCROLL_RESULT_KEY = 'sns_extractor_scroll_result';
  const SCROLL_STATUS_KEY = 'sns_extractor_scroll_status';
  const SCROLL_STOP_KEY = 'sns_extractor_scroll_stop';

  let pollInterval = null;

  // ── Settings ──────────────────────────────────────────────────
  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      const saved = result[STORAGE_KEY];
      if (saved) {
        if (typeof saved.removeLinks === 'boolean') els.optRemoveLinks.checked = saved.removeLinks;
        if (typeof saved.includeAds === 'boolean') els.optIncludeAds.checked = saved.includeAds;
        if (saved.maxCount) els.optMaxCount.value = String(saved.maxCount);
      }
    } catch { /* default */ }
  }

  async function saveSettings() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          removeLinks: els.optRemoveLinks.checked,
          includeAds: els.optIncludeAds.checked,
          maxCount: parseInt(els.optMaxCount.value, 10)
        }
      });
    } catch { /* ignore */ }
  }

  // ── Result persistence ────────────────────────────────────────
  async function saveResult(platform, count, formatted) {
    try {
      await chrome.storage.local.set({
        [RESULT_KEY]: { platform, count, formatted, timestamp: Date.now() }
      });
    } catch { /* ignore */ }
  }

  async function loadLastResult() {
    try {
      const result = await chrome.storage.local.get(RESULT_KEY);
      const saved = result[RESULT_KEY];
      if (saved && saved.formatted) {
        const oneHour = 60 * 60 * 1000;
        if (Date.now() - saved.timestamp < oneHour) {
          els.resultText.value = saved.formatted;
          els.resultCount.textContent = `${saved.platform} · ${t('postsExtracted', String(saved.count))} (${t('saved')})`;
          els.resultArea.classList.remove('hidden');
        }
      }
    } catch { /* ignore */ }
  }

  // ── Status bar ────────────────────────────────────────────────
  function showStatus(type, icon, message) {
    els.statusBar.className = `status-bar status-${type}`;
    els.statusBar.classList.remove('hidden');
    els.statusIcon.textContent = icon;
    els.statusMessage.textContent = message;
    if (type === 'success') setTimeout(() => els.statusBar.classList.add('hidden'), 3000);
  }

  function hideStatus() { els.statusBar.classList.add('hidden'); }

  // ── Platform detection ────────────────────────────────────────
  async function detectPlatform() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url) { setPlatformState(false, '—', t('noTab')); return; }
      if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
        setPlatformState(false, '—', t('notAvailable')); return;
      }
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getPlatformInfo' });
      if (response?.success) {
        setPlatformState(true, response.data.icon, response.data.name);
      } else {
        setPlatformState(false, '—', t('unsupported'));
      }
    } catch { setPlatformState(false, '—', t('unsupported')); }
  }

  function setPlatformState(active, icon, name) {
    els.platformBadge.className = `badge ${active ? 'badge-active' : 'badge-inactive'}`;
    els.platformIcon.textContent = icon;
    els.platformName.textContent = name;
    els.btnExtract.disabled = !active;
  }

  // ── Scroll polling ────────────────────────────────────────────
  function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(async () => {
      try {
        const result = await chrome.storage.local.get([SCROLL_STATUS_KEY, SCROLL_RESULT_KEY]);
        const status = result[SCROLL_STATUS_KEY];
        if (!status || Date.now() - status.timestamp > 120000) { stopPolling(); return; }

        if (status.status === 'running') {
          showStatus('info', '🔄', t('scrollStart', String(status.count)));
        }
        if (status.status === 'done') {
          stopPolling();
          const sr = result[SCROLL_RESULT_KEY];
          if (sr?.success) {
            const { count, formatted, platform } = sr.data;
            els.resultText.value = formatted;
            els.resultCount.textContent = `${platform} · ${t('postsExtracted', String(count))}`;
            els.resultArea.classList.remove('hidden');
            showStatus('success', '✅', t('extractDone', String(count)));
            saveResult(platform, count, formatted);
          } else {
            showStatus('error', '❌', sr?.message || t('extractFail'));
          }
          els.btnExtract.classList.remove('btn-loading');
          els.btnExtract.disabled = false;
          els.btnStop.classList.add('hidden');
          chrome.storage.local.remove([SCROLL_STATUS_KEY, SCROLL_RESULT_KEY, SCROLL_STOP_KEY]);
        }
        if (status.status === 'error') {
          stopPolling();
          showStatus('error', '❌', t('scrollError'));
          els.btnExtract.classList.remove('btn-loading');
          els.btnExtract.disabled = false;
          els.btnStop.classList.add('hidden');
          chrome.storage.local.remove([SCROLL_STATUS_KEY, SCROLL_RESULT_KEY, SCROLL_STOP_KEY]);
        }
      } catch { /* ignore */ }
    }, 500);
  }

  function stopPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  }

  // ── Extract handler ───────────────────────────────────────────
  async function handleExtract() {
    const btn = els.btnExtract;
    btn.classList.add('btn-loading');
    btn.disabled = true;
    hideStatus();

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        showStatus('error', '❌', t('noTab'));
        btn.classList.remove('btn-loading'); btn.disabled = false; return;
      }

      const rawMax = parseInt(els.optMaxCount.value, 10) || 50;
      const options = {
        removeLinks: els.optRemoveLinks.checked,
        includePromoted: els.optIncludeAds.checked,
        maxCount: Math.min(200, Math.max(1, rawMax))
      };
      saveSettings();
      await chrome.storage.local.remove([SCROLL_STATUS_KEY, SCROLL_RESULT_KEY, SCROLL_STOP_KEY]);

      const response = await chrome.tabs.sendMessage(tab.id, { action: 'extractFeed', options });

      if (!response?.success) {
        showStatus('error', '❌', response?.message || t('extractFail'));
        btn.classList.remove('btn-loading'); btn.disabled = false; return;
      }

      if (response.data.count && response.data.formatted) {
        const { count, formatted, platform } = response.data;
        if (count === 0) {
          showStatus('info', 'ℹ️', t('noText'));
          btn.classList.remove('btn-loading'); btn.disabled = false; return;
        }
        els.resultText.value = formatted;
        els.resultCount.textContent = `${platform} · ${t('postsExtracted', String(count))}`;
        els.resultArea.classList.remove('hidden');
        showStatus('success', '✅', t('extractDone', String(count)));
        saveResult(platform, count, formatted);
        btn.classList.remove('btn-loading'); btn.disabled = false;

      } else if (response.data.started) {
        showStatus('info', '🔄', t('scrollStart', String(response.data.instantCount || 0)));
        els.btnStop.classList.remove('hidden');
        startPolling();
      }
    } catch (err) {
      showStatus('error', '❌', `${t('extractFail')}: ${err.message}`);
      btn.classList.remove('btn-loading'); btn.disabled = false;
    }
  }

  // ── Copy ──────────────────────────────────────────────────────
  async function handleCopy() {
    const text = els.resultText.value;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      els.btnCopy.classList.add('btn-copied');
      els.btnCopy.textContent = '✅ ' + t('copied');
      setTimeout(() => { els.btnCopy.classList.remove('btn-copied'); els.btnCopy.textContent = '📋 ' + t('copy'); }, 1500);
    } catch {
      els.resultText.select();
      document.execCommand('copy');
      els.btnCopy.textContent = '✅ ' + t('copied');
      setTimeout(() => { els.btnCopy.textContent = '📋 ' + t('copy'); }, 1500);
    }
  }

  // ── Stop scroll ───────────────────────────────────────────────
  async function handleStop() {
    try {
      await chrome.storage.local.set({ [SCROLL_STOP_KEY]: true });
      showStatus('info', '⏹', t('stopRequested'));
    } catch { /* ignore */ }
  }

  // ── Event binding ─────────────────────────────────────────────
  els.btnExtract.addEventListener('click', handleExtract);
  els.btnStop.addEventListener('click', handleStop);
  els.btnCopy.addEventListener('click', handleCopy);

  els.optRemoveLinks.addEventListener('change', saveSettings);
  els.optIncludeAds.addEventListener('change', saveSettings);
  els.optMaxCount.addEventListener('change', () => {
    let val = parseInt(els.optMaxCount.value, 10);
    if (isNaN(val) || val < 1) val = 1;
    if (val > 200) val = 200;
    els.optMaxCount.value = val;
    saveSettings();
  });

  function stepMaxCount(delta) {
    let val = parseInt(els.optMaxCount.value, 10) || 50;
    val = Math.min(200, Math.max(1, val + delta));
    els.optMaxCount.value = val;
    saveSettings();
  }
  els.optMaxDown.addEventListener('click', (e) => { e.preventDefault(); stepMaxCount(-10); });
  els.optMaxUp.addEventListener('click', (e) => { e.preventDefault(); stepMaxCount(10); });

  const linkUpdates = document.getElementById('link-updates');
  if (linkUpdates) {
    linkUpdates.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') });
    });
  }

  // ── Init ──────────────────────────────────────────────────────
  async function init() {
    await loadSettings();
    await loadLastResult();
    await detectPlatform();
    try {
      const result = await chrome.storage.local.get(SCROLL_STATUS_KEY);
      const status = result[SCROLL_STATUS_KEY];
      if (status && status.status === 'running' && Date.now() - status.timestamp < 120000) {
        els.btnExtract.classList.add('btn-loading');
        els.btnExtract.disabled = true;
        els.btnStop.classList.remove('hidden');
        showStatus('info', '🔄', t('scrollStart', String(status.count)));
        startPolling();
      }
    } catch { /* ignore */ }
  }

  init();
})();
