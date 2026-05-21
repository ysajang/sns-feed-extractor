/**
 * Popup Script
 * 
 * 스크롤 수집: content script가 독립 실행 -> storage에 결과 저장
 * popup은 storage를 polling하여 진행 상태/결과 표시
 * popup이 닫혔다 열어도 마지막 결과가 복원됨
 */

(() => {
  'use strict';

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
    optAutoScroll:  document.getElementById('opt-auto-scroll')
  };

  // ── Storage Keys ──────────────────────────────────────────────
  const STORAGE_KEY = 'sns_extractor_options';
  const RESULT_KEY = 'sns_extractor_last_result';
  const SCROLL_RESULT_KEY = 'sns_extractor_scroll_result';
  const SCROLL_STATUS_KEY = 'sns_extractor_scroll_status';
  const SCROLL_STOP_KEY = 'sns_extractor_scroll_stop';

  let pollInterval = null;

  // ── 설정 저장/복원 ───────────────────────────────────────────
  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      const saved = result[STORAGE_KEY];
      if (saved) {
        if (typeof saved.removeLinks === 'boolean') {
          els.optRemoveLinks.checked = saved.removeLinks;
        }
        if (typeof saved.includeAds === 'boolean') {
          els.optIncludeAds.checked = saved.includeAds;
        }
        if (saved.maxCount) {
          els.optMaxCount.value = String(saved.maxCount);
        }
        if (typeof saved.autoScroll === 'boolean') {
          els.optAutoScroll.checked = saved.autoScroll;
        }
      }
    } catch {
      // 기본값 유지
    }
  }

  async function saveSettings() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          removeLinks: els.optRemoveLinks.checked,
          includeAds: els.optIncludeAds.checked,
          maxCount: parseInt(els.optMaxCount.value, 10),
          autoScroll: els.optAutoScroll.checked
        }
      });
    } catch {
      // 무시
    }
  }

  // ── 결과 저장/복원 ───────────────────────────────────────────
  async function saveResult(platform, count, formatted) {
    try {
      await chrome.storage.local.set({
        [RESULT_KEY]: {
          platform,
          count,
          formatted,
          timestamp: Date.now()
        }
      });
    } catch {
      // 무시
    }
  }

  async function loadLastResult() {
    try {
      const result = await chrome.storage.local.get(RESULT_KEY);
      const saved = result[RESULT_KEY];
      if (saved && saved.formatted) {
        const oneHour = 60 * 60 * 1000;
        if (Date.now() - saved.timestamp < oneHour) {
          els.resultText.value = saved.formatted;
          els.resultCount.textContent = `${saved.platform} · ${saved.count}개 (저장됨)`;
          els.resultArea.classList.remove('hidden');
        }
      }
    } catch {
      // 무시
    }
  }

  // ── 상태 표시 ─────────────────────────────────────────────────
  function showStatus(type, icon, message) {
    els.statusBar.className = `status-bar status-${type}`;
    els.statusBar.classList.remove('hidden');
    els.statusIcon.textContent = icon;
    els.statusMessage.textContent = message;

    if (type === 'success') {
      setTimeout(() => {
        els.statusBar.classList.add('hidden');
      }, 3000);
    }
  }

  function hideStatus() {
    els.statusBar.classList.add('hidden');
  }

  // ── 플랫폼 감지 ──────────────────────────────────────────────
  async function detectPlatform() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab?.id || !tab.url) {
        setPlatformState(false, '—', '탭 없음');
        return;
      }

      if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
        setPlatformState(false, '—', '지원 불가');
        return;
      }

      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getPlatformInfo' });
      
      if (response?.success) {
        const { name, icon } = response.data;
        setPlatformState(true, icon, name);
      } else {
        setPlatformState(false, '—', '미지원 사이트');
      }
    } catch {
      setPlatformState(false, '—', '미지원 사이트');
    }
  }

  function setPlatformState(active, icon, name) {
    els.platformBadge.className = `badge ${active ? 'badge-active' : 'badge-inactive'}`;
    els.platformIcon.textContent = icon;
    els.platformName.textContent = name;
    els.btnExtract.disabled = !active;
  }

  // ── 스크롤 수집 polling ───────────────────────────────────────
  function startPolling() {
    if (pollInterval) clearInterval(pollInterval);

    pollInterval = setInterval(async () => {
      try {
        const result = await chrome.storage.local.get([SCROLL_STATUS_KEY, SCROLL_RESULT_KEY]);
        const status = result[SCROLL_STATUS_KEY];

        if (!status || Date.now() - status.timestamp > 120000) {
          // 2분 이상 오래된 상태 -> polling 중단
          stopPolling();
          return;
        }

        if (status.status === 'running') {
          showStatus('info', '🔄', `스크롤 수집 중... ${status.count}개`);
        }

        if (status.status === 'done') {
          stopPolling();
          const scrollResult = result[SCROLL_RESULT_KEY];

          if (scrollResult?.success) {
            const { count, formatted, platform } = scrollResult.data;
            els.resultText.value = formatted;
            els.resultCount.textContent = `${platform} · ${count}개 추출`;
            els.resultArea.classList.remove('hidden');
            showStatus('success', '✅', `${count}개 텍스트 추출 완료`);
            saveResult(platform, count, formatted);
          } else {
            showStatus('error', '❌', scrollResult?.message || '수집 실패');
          }

          els.btnExtract.classList.remove('btn-loading');
          els.btnExtract.disabled = false;
          els.btnStop.classList.add('hidden');

          // 사용한 scroll 데이터 정리
          chrome.storage.local.remove([SCROLL_STATUS_KEY, SCROLL_RESULT_KEY, SCROLL_STOP_KEY]);
        }

        if (status.status === 'error') {
          stopPolling();
          showStatus('error', '❌', '스크롤 수집 중 오류 발생');
          els.btnExtract.classList.remove('btn-loading');
          els.btnExtract.disabled = false;
          els.btnStop.classList.add('hidden');
          chrome.storage.local.remove([SCROLL_STATUS_KEY, SCROLL_RESULT_KEY, SCROLL_STOP_KEY]);
        }

      } catch {
        // polling 에러 무시
      }
    }, 500);
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  // ── 추출 실행 ─────────────────────────────────────────────────
  async function handleExtract() {
    const btn = els.btnExtract;
    const useAutoScroll = els.optAutoScroll.checked;
    
    btn.classList.add('btn-loading');
    btn.disabled = true;
    hideStatus();

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab?.id) {
        showStatus('error', '❌', '활성 탭을 찾을 수 없습니다');
        btn.classList.remove('btn-loading');
        btn.disabled = false;
        return;
      }

      const options = {
        removeLinks: els.optRemoveLinks.checked,
        includePromoted: els.optIncludeAds.checked,
        maxCount: parseInt(els.optMaxCount.value, 10)
      };

      saveSettings();

      if (useAutoScroll) {
        // ── 스크롤 수집: fire & forget + polling ──────────────
        showStatus('info', '🔄', '스크롤 수집 시작...');

        // 이전 결과 + 중지 플래그 정리
        await chrome.storage.local.remove([SCROLL_STATUS_KEY, SCROLL_RESULT_KEY, SCROLL_STOP_KEY]);

        // 중지 버튼 표시
        els.btnStop.classList.remove('hidden');

        const response = await chrome.tabs.sendMessage(tab.id, {
          action: 'extractWithScroll',
          options
        });

        if (response?.success) {
          // 수집 시작됨 -> polling 시작
          startPolling();
        } else {
          showStatus('error', '❌', response?.message || '수집 시작 실패');
          btn.classList.remove('btn-loading');
          btn.disabled = false;
        }

      } else {
        // ── 즉시 추출 ─────────────────────────────────────────
        const response = await chrome.tabs.sendMessage(tab.id, {
          action: 'extractFeed',
          options
        });

        if (!response?.success) {
          showStatus('error', '❌', response?.message || '추출 실패');
          btn.classList.remove('btn-loading');
          btn.disabled = false;
          return;
        }

        const { count, formatted, platform } = response.data;

        if (count === 0) {
          showStatus('info', 'ℹ️', '추출할 텍스트가 없습니다');
          btn.classList.remove('btn-loading');
          btn.disabled = false;
          return;
        }

        els.resultText.value = formatted;
        els.resultCount.textContent = `${platform} · ${count}개 추출`;
        els.resultArea.classList.remove('hidden');
        showStatus('success', '✅', `${count}개 텍스트 추출 완료`);
        saveResult(platform, count, formatted);

        btn.classList.remove('btn-loading');
        btn.disabled = false;
      }

    } catch (err) {
      showStatus('error', '❌', `오류: ${err.message}`);
      btn.classList.remove('btn-loading');
      btn.disabled = false;
    }
  }

  // ── 클립보드 복사 ─────────────────────────────────────────────
  async function handleCopy() {
    const text = els.resultText.value;
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      
      els.btnCopy.classList.add('btn-copied');
      els.btnCopy.textContent = '✅ 복사됨';
      
      setTimeout(() => {
        els.btnCopy.classList.remove('btn-copied');
        els.btnCopy.textContent = '📋 복사';
      }, 1500);

    } catch {
      els.resultText.select();
      document.execCommand('copy');
      
      els.btnCopy.textContent = '✅ 복사됨';
      setTimeout(() => {
        els.btnCopy.textContent = '📋 복사';
      }, 1500);
    }
  }

  // ── 스크롤 중지 ────────────────────────────────────────────────
  async function handleStop() {
    try {
      await chrome.storage.local.set({ [SCROLL_STOP_KEY]: true });
      showStatus('info', '⏹', '중지 요청됨... 수집된 부분까지 저장 중');
    } catch {
      // 무시
    }
  }

  // ── 이벤트 바인딩 ─────────────────────────────────────────────
  els.btnExtract.addEventListener('click', handleExtract);
  els.btnStop.addEventListener('click', handleStop);
  els.btnCopy.addEventListener('click', handleCopy);

  els.optRemoveLinks.addEventListener('change', saveSettings);
  els.optIncludeAds.addEventListener('change', saveSettings);
  els.optMaxCount.addEventListener('change', saveSettings);
  els.optAutoScroll.addEventListener('change', saveSettings);

  // Get Updates -> welcome page
  const linkUpdates = document.getElementById('link-updates');
  if (linkUpdates) {
    linkUpdates.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') });
    });
  }

  // ── 초기화 ────────────────────────────────────────────────────
  async function init() {
    await loadSettings();
    await loadLastResult();
    await detectPlatform();

    // 열었을 때 진행 중인 스크롤 수집이 있는지 확인
    try {
      const result = await chrome.storage.local.get(SCROLL_STATUS_KEY);
      const status = result[SCROLL_STATUS_KEY];
      if (status && status.status === 'running' && Date.now() - status.timestamp < 120000) {
        // 진행 중 -> polling 재개
        els.btnExtract.classList.add('btn-loading');
        els.btnExtract.disabled = true;
        showStatus('info', '🔄', `스크롤 수집 중... ${status.count}개`);
        startPolling();
      }
    } catch {
      // 무시
    }
  }

  init();
})();
