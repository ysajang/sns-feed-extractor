/**
 * Content Script
 * 
 * 스크롤 수집 방식 변경:
 * popup -> "start scroll" 메시지 -> content script가 독립 실행
 * -> 완료 후 chrome.storage에 결과 저장
 * -> popup이 storage 변화를 감지하여 결과 표시
 * 
 * 이렇게 하면 popup이 닫혀도 수집이 중단되지 않음
 */

(() => {
  'use strict';

  // ── 중복 주입 방지 ────────────────────────────────────────────
  const GUARD_KEY = '__SNS_EXTRACTOR_' + chrome.runtime.id;
  if (window[GUARD_KEY]) return;
  window[GUARD_KEY] = true;

  const SCROLL_RESULT_KEY = 'sns_extractor_scroll_result';
  const SCROLL_STATUS_KEY = 'sns_extractor_scroll_status';
  const SCROLL_STOP_KEY = 'sns_extractor_scroll_stop';

  /**
   * 현재 페이지에 맞는 파서 반환
   */
  function getActiveParser() {
    const parsers = window.__SNS_PARSERS__ || {};
    
    for (const [, parser] of Object.entries(parsers)) {
      if (parser.isActive && parser.isActive()) {
        return parser;
      }
    }
    
    return null;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 스크롤 상태를 storage에 기록 (popup이 polling으로 읽음)
   */
  async function setScrollStatus(status, count) {
    try {
      await chrome.storage.local.set({
        [SCROLL_STATUS_KEY]: {
          status, // 'running' | 'done' | 'error'
          count,
          timestamp: Date.now()
        }
      });
    } catch {
      // 무시
    }
  }

  /**
   * 중지 플래그 확인
   */
  async function shouldStop() {
    try {
      const result = await chrome.storage.local.get(SCROLL_STOP_KEY);
      return !!result[SCROLL_STOP_KEY];
    } catch {
      return false;
    }
  }

  /**
   * 자동 스크롤하며 포스트 누적 수집
   * popup과 독립적으로 실행 — 결과를 storage에 저장
   * 중지 요청 시 수집한 부분까지 결과 저장
   */
  async function scrollAndCollect(parser, options, platformInfo) {
    const maxCount = options.maxCount || 100;
    const allTweets = new Map();

    try {
      // 중지 플래그 초기화
      await chrome.storage.local.remove(SCROLL_STOP_KEY);
      await setScrollStatus('running', 0);

      // 페이지 최상단으로 이동
      window.scrollTo({ top: 0, behavior: 'instant' });
      await sleep(500);

      let noNewCount = 0;
      const MAX_NO_NEW = 5;
      let scrollAttempts = 0;
      const MAX_SCROLL_ATTEMPTS = 80;

      while (allTweets.size < maxCount && noNewCount < MAX_NO_NEW && scrollAttempts < MAX_SCROLL_ATTEMPTS) {
        // 중지 요청 확인
        if (await shouldStop()) break;
        // Show more 버튼 클릭 (X 전용)
        if (parser.expandAllShowMore) {
          const clicked = parser.expandAllShowMore();
          if (clicked > 0) await sleep(300);
        }

        // 현재 화면의 포스트 파싱
        const currentBatch = parser.parseFeed({
          ...options,
          maxCount: maxCount
        });

        let newCount = 0;
        for (const tweet of currentBatch) {
          const key = tweet.text.substring(0, 120);
          if (!allTweets.has(key)) {
            allTweets.set(key, tweet);
            newCount++;
          }
        }

        if (newCount === 0) {
          noNewCount++;
        } else {
          noNewCount = 0;
        }

        // 진행 상태 업데이트
        await setScrollStatus('running', allTweets.size);

        // 목표 달성 시 종료
        if (allTweets.size >= maxCount) break;

        // 스크롤 — 화면 90% 높이로 빠르게 이동
        window.scrollBy({ top: window.innerHeight * 0.9, behavior: 'instant' });
        // 새 포스트 없으면 로딩 대기 길게 / 있으면 짧게
        await sleep(noNewCount > 0 ? 1000 : 600);
        scrollAttempts++;
      }

      // 결과 저장
      const tweets = [...allTweets.values()].slice(0, maxCount);
      const formatted = parser.formatOutput(tweets);

      await chrome.storage.local.set({
        [SCROLL_RESULT_KEY]: {
          success: true,
          data: {
            platform: platformInfo.name,
            platformId: platformInfo.id,
            count: tweets.length,
            formatted,
            raw: tweets
          },
          timestamp: Date.now()
        }
      });

      await setScrollStatus('done', tweets.length);

    } catch (err) {
      await chrome.storage.local.set({
        [SCROLL_RESULT_KEY]: {
          success: false,
          error: 'SCROLL_ERROR',
          message: `스크롤 수집 실패: ${err.message}`,
          timestamp: Date.now()
        }
      });

      await setScrollStatus('error', allTweets.size);
    }
  }

  /**
   * 메시지 핸들러
   */
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    
    // ── 즉시 추출 (현재 화면) ───────────────────────────────────
    if (request.action === 'extractFeed') {
      const parser = getActiveParser();
      
      if (!parser) {
        sendResponse({
          success: false,
          error: 'UNSUPPORTED_PLATFORM',
          message: '지원하지 않는 플랫폼입니다'
        });
        return true;
      }

      // Show more 버튼 클릭 후 DOM 업데이트 대기 -> 파싱
      (async () => {
        try {
          // expandAllShowMore가 있는 파서만 (X) 호출
          if (parser.expandAllShowMore) {
            const clicked = parser.expandAllShowMore();
            if (clicked > 0) {
              await sleep(500); // React DOM 업데이트 대기
            }
          }

          const options = request.options || {};
          const tweets = parser.parseFeed(options);
          const formatted = parser.formatOutput(tweets);
          const platformInfo = parser.getPlatformInfo();

          sendResponse({
            success: true,
            data: {
              platform: platformInfo.name,
              platformId: platformInfo.id,
              count: tweets.length,
              formatted,
              raw: tweets
            }
          });
        } catch (err) {
          sendResponse({
            success: false,
            error: 'PARSE_ERROR',
            message: `파싱 실패: ${err.message}`
          });
        }
      })();
      
      return true;
    }

    // ── 자동 스크롤 수집 시작 (fire & forget) ────────────────────
    if (request.action === 'extractWithScroll') {
      const parser = getActiveParser();
      
      if (!parser) {
        sendResponse({
          success: false,
          error: 'UNSUPPORTED_PLATFORM',
          message: '지원하지 않는 플랫폼입니다'
        });
        return true;
      }

      const options = request.options || {};
      const platformInfo = parser.getPlatformInfo();

      // 즉시 응답 — "수집 시작됨"
      sendResponse({
        success: true,
        data: { started: true }
      });

      // 백그라운드에서 독립 실행 (popup 닫혀도 계속)
      scrollAndCollect(parser, options, platformInfo);

      return true;
    }

    // ── 플랫폼 감지 ────────────────────────────────────────────
    if (request.action === 'getPlatformInfo') {
      const parser = getActiveParser();
      
      if (parser) {
        sendResponse({
          success: true,
          data: parser.getPlatformInfo()
        });
      } else {
        sendResponse({
          success: false,
          error: 'UNSUPPORTED_PLATFORM'
        });
      }
      
      return true;
    }
  });

  console.log('[SNS Feed Extractor] Content script loaded on', window.location.hostname);
})();
