/**
 * Popup Script — i18n enabled
 */

(() => {
  'use strict';

  // ── i18n helper ───────────────────────────────────────────────
  // UI 언어를 고정한다. null로 두면 브라우저 언어를 그대로 따른다.
  // (_locales의 다른 언어 파일은 그대로 유지 — 스토어 등록 시 재사용)
  const FORCE_LOCALE = 'en';

  let forcedMessages = null;

  async function loadForcedLocale() {
    if (!FORCE_LOCALE) return;
    try {
      const url = chrome.runtime.getURL(`_locales/${FORCE_LOCALE}/messages.json`);
      const res = await fetch(url);
      forcedMessages = await res.json();
    } catch {
      forcedMessages = null; // 실패 시 브라우저 언어로 폴백
    }
  }

  // chrome.i18n과 동일한 $1, $2 치환
  function substitute(template, subs) {
    return template.replace(/\$(\d+)/g, (m, i) => {
      const v = subs[Number(i) - 1];
      return v === undefined ? m : String(v);
    });
  }

  function t(key, ...subs) {
    const entry = forcedMessages && forcedMessages[key];
    if (entry && typeof entry.message === 'string') {
      return substitute(entry.message, subs);
    }
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

  // ── DOM References ────────────────────────────────────────────
  const els = {
    platformBadge:  document.getElementById('platform-badge'),
    platformIcon:   document.getElementById('platform-icon'),
    platformName:   document.getElementById('platform-name'),
    btnExtract:     document.getElementById('btn-extract'),
    btnStop:        document.getElementById('btn-stop'),
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
    optKeywords:    document.getElementById('opt-keywords'),
    optMinLength:   document.getElementById('opt-min-length'),
    optMaxComments: document.getElementById('opt-max-comments'),
    optCommentsDown:document.getElementById('opt-comments-down'),
    optCommentsUp:  document.getElementById('opt-comments-up'),
    optMaxAge:      document.getElementById('opt-max-age'),
    optAgeDown:     document.getElementById('opt-age-down'),
    optAgeUp:       document.getElementById('opt-age-up'),
    optAiThreshold: document.getElementById('opt-ai-threshold'),
    optAiDown:      document.getElementById('opt-ai-down'),
    optAiUp:        document.getElementById('opt-ai-up'),
    optExcludeReplied: document.getElementById('opt-exclude-replied'),
    optMinDown:     document.getElementById('opt-min-down'),
    optMinUp:       document.getElementById('opt-min-up'),
    copyBadge:      document.getElementById('copy-badge')
  };

  // ── 한계값 ────────────────────────────────────────────────────
  const MAX_COUNT_LIMIT = 1000;
  const MIN_LENGTH_LIMIT = 10000;
  const MAX_COMMENTS_LIMIT = 10000;
  const MAX_AGE_LIMIT = 720; // 시간 (30일)
  const AI_THRESHOLD_LIMIT = 10; // AI 작성 신호 점수 상한 (0이면 필터 끔)
  const STEP = 5; // +/- 버튼 증감 단위

  function clamp(val, min, max) {
    return Math.min(max, Math.max(min, val));
  }

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
    let migrated = false;
    try {
      const result = await chrome.storage.local.get([STORAGE_KEY, `sns_keywords_${currentTabId}`]);
      const saved = result[STORAGE_KEY];
      if (saved) {
        if (typeof saved.removeLinks === 'boolean') els.optRemoveLinks.checked = saved.removeLinks;
        if (typeof saved.includeAds === 'boolean') els.optIncludeAds.checked = saved.includeAds;
        if (saved.maxCount) els.optMaxCount.value = String(clamp(saved.maxCount, 1, MAX_COUNT_LIMIT));
        // v1.11.0 마이그레이션: 토글(minLengthOn)이 있던 시절의 설정 처리
        // 토글이 꺼져 있었다면 저장된 숫자는 사용하지 않았던 값 -> 0으로 복원
        const legacyOff = saved.minLengthOn === false;
        const savedMin = parseInt(saved.minLength, 10);
        if (legacyOff) {
          els.optMinLength.value = '0';
          migrated = true;
        } else if (Number.isFinite(savedMin)) {
          els.optMinLength.value = String(clamp(savedMin, 0, MIN_LENGTH_LIMIT));
          migrated = 'minLengthOn' in saved;
        }
      }
      // 키워드는 탭별
      const savedComments = parseInt(saved.maxComments, 10);
      if (Number.isFinite(savedComments)) {
        els.optMaxComments.value = String(clamp(savedComments, 0, MAX_COMMENTS_LIMIT));
      }
      const savedAge = parseInt(saved.maxAgeHours, 10);
      if (Number.isFinite(savedAge)) {
        els.optMaxAge.value = String(clamp(savedAge, 0, MAX_AGE_LIMIT));
      }
      const savedAi = parseInt(saved.aiThreshold, 10);
      if (Number.isFinite(savedAi)) {
        els.optAiThreshold.value = String(clamp(savedAi, 0, AI_THRESHOLD_LIMIT));
      }
      if (typeof saved.excludeReplied === 'boolean') {
        els.optExcludeReplied.checked = saved.excludeReplied;
      }

      const kw = result[`sns_keywords_${currentTabId}`];
      if (kw) els.optKeywords.value = kw;
    } catch { /* default */ }
    // 구버전 키(minLengthOn)를 제거한 형태로 다시 저장
    if (migrated) await saveSettings();
  }

  async function saveSettings() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          removeLinks: els.optRemoveLinks.checked,
          includeAds: els.optIncludeAds.checked,
          maxCount: parseInt(els.optMaxCount.value, 10),
          minLength: parseInt(els.optMinLength.value, 10) || 0,
          maxComments: parseInt(els.optMaxComments.value, 10) || 0,
          maxAgeHours: parseInt(els.optMaxAge.value, 10) || 0,
          aiThreshold: parseInt(els.optAiThreshold.value, 10) || 0,
          excludeReplied: els.optExcludeReplied.checked
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
        if (!status || Date.now() - status.timestamp > 300000) { stopPolling(); return; }

        if (status.status === 'running') {
          showStatus('info', '🔄', t('scrollStart', String(status.count)));
        }
        if (status.status === 'done') {
          stopPolling();
          const sr = result[scrollResultKey()];
          if (sr?.success) {
            const { count, formatted, platform } = sr.data;
            await showResult(platform, count, formatted);
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
      const rawMin = parseInt(els.optMinLength.value, 10) || 0;
      const options = {
        removeLinks: els.optRemoveLinks.checked,
        includePromoted: els.optIncludeAds.checked,
        maxCount: clamp(rawMax, 1, MAX_COUNT_LIMIT),
        keywords: els.optKeywords.value.trim(),
        // 0이면 content.js에서 해당 필터 미적용
        minLength: clamp(rawMin, 0, MIN_LENGTH_LIMIT),
        maxComments: clamp(parseInt(els.optMaxComments.value, 10) || 0, 0, MAX_COMMENTS_LIMIT),
        maxAgeHours: clamp(parseInt(els.optMaxAge.value, 10) || 0, 0, MAX_AGE_LIMIT),
        aiThreshold: clamp(parseInt(els.optAiThreshold.value, 10) || 0, 0, AI_THRESHOLD_LIMIT),
        excludeReplied: els.optExcludeReplied.checked
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
        await showResult(platform, count, formatted);
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

  // ── Auto copy ─────────────────────────────────────────────────
  /**
   * 추출 완료 시 클립보드에 자동 복사
   * navigator.clipboard 실패 시 textarea select + execCommand로 폴백
   * @returns {Promise<boolean>} 복사 성공 여부
   */
  async function autoCopy(text) {
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        els.resultText.removeAttribute('readonly');
        els.resultText.select();
        const ok = document.execCommand('copy');
        els.resultText.setAttribute('readonly', '');
        els.resultText.setSelectionRange(0, 0);
        return ok;
      } catch {
        return false;
      }
    }
  }

  /**
   * 결과 표시 + 자동 복사 (즉시 추출 / 스크롤 완료 공통)
   */
  async function showResult(platform, count, formatted) {
    els.resultText.value = formatted;
    els.resultCount.textContent = `${platform} · ${t('postsExtracted', String(count))}`;
    els.resultArea.classList.remove('hidden');
    saveResult(platform, count, formatted);

    const copied = await autoCopy(formatted);
    els.copyBadge.textContent = copied ? '✅ ' + t('copied') : '';
    els.copyBadge.classList.toggle('hidden', !copied);
    showStatus('success', '✅',
      copied ? `${t('extractDone', String(count))} · ${t('copied')}` : t('extractDone', String(count)));
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

  els.optRemoveLinks.addEventListener('change', saveSettings);
  els.optIncludeAds.addEventListener('change', saveSettings);
  els.optMaxCount.addEventListener('change', () => {
    let val = parseInt(els.optMaxCount.value, 10);
    if (isNaN(val)) val = 50;
    els.optMaxCount.value = clamp(val, 1, MAX_COUNT_LIMIT);
    saveSettings();
  });

  // 200 이상 구간은 50 단위로 이동 (1000까지 버튼 연타 부담 완화)
  function stepMaxCount(delta) {
    const val = parseInt(els.optMaxCount.value, 10) || 50;
    els.optMaxCount.value = clamp(val + delta, 1, MAX_COUNT_LIMIT);
    saveSettings();
  }
  els.optMaxDown.addEventListener('click', (e) => { e.preventDefault(); stepMaxCount(-STEP); });
  els.optMaxUp.addEventListener('click', (e) => { e.preventDefault(); stepMaxCount(STEP); });
  els.optKeywords.addEventListener('change', saveSettings);

  // ── 최소 글자수 필터 ──────────────────────────────────────────
  els.optMinLength.addEventListener('change', () => {
    let val = parseInt(els.optMinLength.value, 10);
    if (isNaN(val)) val = 0;
    els.optMinLength.value = clamp(val, 0, MIN_LENGTH_LIMIT);
    saveSettings();
  });
  function stepMinLength(delta) {
    const val = parseInt(els.optMinLength.value, 10) || 0;
    els.optMinLength.value = clamp(val + delta, 0, MIN_LENGTH_LIMIT);
    saveSettings();
  }
  els.optMinDown.addEventListener('click', (e) => { e.preventDefault(); stepMinLength(-STEP); });
  els.optMinUp.addEventListener('click', (e) => { e.preventDefault(); stepMinLength(STEP); });

  // ── 답글 수 상한 / 경과 시간 / 중복 제외 ──────────────────────
  function bindNumber(input, down, up, limit, step, fallback) {
    input.addEventListener('change', () => {
      let val = parseInt(input.value, 10);
      if (isNaN(val)) val = fallback;
      input.value = clamp(val, 0, limit);
      saveSettings();
    });
    const move = (delta) => {
      const val = parseInt(input.value, 10) || 0;
      input.value = clamp(val + delta, 0, limit);
      saveSettings();
    };
    down.addEventListener('click', (e) => { e.preventDefault(); move(-step); });
    up.addEventListener('click', (e) => { e.preventDefault(); move(step); });
  }
  bindNumber(els.optMaxComments, els.optCommentsDown, els.optCommentsUp, MAX_COMMENTS_LIMIT, STEP, 15);
  bindNumber(els.optMaxAge, els.optAgeDown, els.optAgeUp, MAX_AGE_LIMIT, 1, 24);
  bindNumber(els.optAiThreshold, els.optAiDown, els.optAiUp, AI_THRESHOLD_LIMIT, 1, 3);
  els.optExcludeReplied.addEventListener('change', saveSettings);

  const linkUpdates = document.getElementById('link-updates');
  if (linkUpdates) {
    linkUpdates.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') });
    });
  }

  // ── Init ──────────────────────────────────────────────────────
  async function init() {
    await loadForcedLocale();
    applyI18n();
    await resolveTabId();
    await loadSettings();
    await loadLastResult();
    await detectPlatform();
    try {
      const result = await chrome.storage.local.get([scrollStatusKey(), scrollResultKey()]);
      const status = result[scrollStatusKey()];
      
      if (status && Date.now() - status.timestamp < 300000) { // 5분 이내
        if (status.status === 'running') {
          // 진행 중 -> polling 재개
          els.btnExtract.classList.add('btn-loading');
          els.btnExtract.disabled = true;
          els.btnStop.classList.remove('hidden');
          showStatus('info', '🔄', t('scrollStart', String(status.count)));
          startPolling();
          
        } else if (status.status === 'done') {
          // popup 닫혀있는 동안 수집 완료됨 -> 결과 표시
          const sr = result[scrollResultKey()];
          if (sr?.success) {
            const { count, formatted, platform } = sr.data;
            await showResult(platform, count, formatted);
          }
          chrome.storage.local.remove([scrollStatusKey(), scrollResultKey(), scrollStopKey()]);
        }
      }
    } catch { /* ignore */ }
  }

  init();
})();
