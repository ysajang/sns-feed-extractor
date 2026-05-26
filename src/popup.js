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
    optMaxUp:       document.getElementById('opt-max-up'),
    optKeywords:    document.getElementById('opt-keywords')
  };

  // ── Storage Keys ──────────────────────────────────────────────
  const STORAGE_KEY = 'sns_extractor_options'; // 설정은 공유
  
  // 결과 + 스크롤 상태는 탭별 분리
  let currentTabId = null;
  function resultKey() { return `sns_result_${currentTabId}`; }
  function scrollResultKey() { return `sns_scroll_result_${currentTabId}`; }
  function scrollStatusKey() { return `sns_scroll_status_${currentTabId}`; }
  function scrollStopKey() { return `sns_scroll_stop_${currentTabId}`; }

  let pollInterval = null;

  async function resolveTabId() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      currentTabId = tab?.id || 'unknown';
    } catch {
      currentTabId = 'unknown';
    }
  }

  // ── Settings ──────────────────────────────────────────────────
  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get([STORAGE_KEY, `sns_keywords_${currentTabId}`]);
      const saved = result[STORAGE_KEY];
      if (saved) {
        if (typeof saved.removeLinks === 'boolean') els.optRemoveLinks.checked = saved.removeLinks;
        if (typeof saved.includeAds === 'boolean') els.optIncludeAds.checked = saved.includeAds;
        if (saved.maxCount) els.optMaxCount.value = String(saved.maxCount);
      }
      // 키워드는 탭별
      const kw = result[`sns_keywords_${currentTabId}`];
      if (kw) els.optKeywords.value = kw;
    } catch { /* default */ }
  }

  async function saveSettings() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          removeLinks: els.optRemoveLinks.checked,
          includeAds: els.optIncludeAds.checked,
          maxCount: parseInt(els.optMaxCount.value, 10)
        },
        [`sns_keywords_${currentTabId}`]: els.optKeywords.value.trim()
      });
    } catch { /* ignore */ }
  }

  // ── Result persistence ────────────────────────────────────────
  async function saveResult(platform, count, formatted) {
    try {
      await chrome.storage.local.set({
        [resultKey()]: { platform, count, formatted, timestamp: Date.now() }
      });
    } catch { /* ignore */ }
  }

  async function loadLastResult() {
    try {
      const result = await chrome.storage.local.get(resultKey());
      const saved = result[resultKey()];
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
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getPlatformInfo', tabId: tab.id });
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
        const result = await chrome.storage.local.get([scrollStatusKey(), scrollResultKey()]);
        const status = result[scrollStatusKey()];
        if (!status || Date.now() - status.timestamp > 120000) { stopPolling(); return; }

        if (status.status === 'running') {
          showStatus('info', '🔄', t('scrollStart', String(status.count)));
        }
        if (status.status === 'done') {
          stopPolling();
          const sr = result[scrollResultKey()];
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
          chrome.storage.local.remove([scrollStatusKey(), scrollResultKey(), scrollStopKey()]);
        }
        if (status.status === 'error') {
          stopPolling();
          showStatus('error', '❌', t('scrollError'));
          els.btnExtract.classList.remove('btn-loading');
          els.btnExtract.disabled = false;
          els.btnStop.classList.add('hidden');
          chrome.storage.local.remove([scrollStatusKey(), scrollResultKey(), scrollStopKey()]);
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
        maxCount: Math.min(200, Math.max(1, rawMax)),
        keywords: els.optKeywords.value.trim()
      };
      saveSettings();
      await chrome.storage.local.remove([scrollStatusKey(), scrollResultKey(), scrollStopKey()]);

      const response = await chrome.tabs.sendMessage(tab.id, { action: 'extractFeed', options, tabId: tab.id });

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
      await chrome.storage.local.set({ [scrollStopKey()]: true });
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
  els.optKeywords.addEventListener('change', saveSettings);

  const linkUpdates = document.getElementById('link-updates');
  if (linkUpdates) {
    linkUpdates.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') });
    });
  }

  // ── Init ──────────────────────────────────────────────────────
  async function init() {
    await resolveTabId();
    await loadSettings();
    await loadLastResult();
    await detectPlatform();
    try {
      const result = await chrome.storage.local.get(scrollStatusKey());
      const status = result[scrollStatusKey()];
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
