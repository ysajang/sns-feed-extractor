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

  let activeTabId = null; // popup에서 전달받는 탭 ID
  function scrollResultKey() { return `sns_scroll_result_${activeTabId || 'unknown'}`; }
  function scrollStatusKey() { return `sns_scroll_status_${activeTabId || 'unknown'}`; }
  function scrollStopKey() { return `sns_scroll_stop_${activeTabId || 'unknown'}`; }

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
        [scrollStatusKey()]: {
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
      const result = await chrome.storage.local.get(scrollStopKey());
      return !!result[scrollStopKey()];
    } catch {
      return false;
    }
  }

  /**
   * 자동 스크롤하며 포스트 누적 수집
   * popup과 독립적으로 실행 — 결과를 storage에 저장
   * 중지 요청 시 수집한 부분까지 결과 저장
   */
  async function scrollAndCollect(parser, options, platformInfo, seedResults, keywordsStr) {
    const maxCount = options.maxCount || 100;
    const allTweets = new Map();

    // seed 데이터로 초기화 (즉시 추출 결과)
    if (seedResults && seedResults.length > 0) {
      for (const tweet of seedResults) {
        const key = tweet.text.substring(0, 120);
        allTweets.set(key, tweet);
      }
    }

    try {
      await chrome.storage.local.remove(scrollStopKey());
      await setScrollStatus('running', allTweets.size);

      // 플랫폼별 스크롤 속도 설정
      const platformId = platformInfo.id;
      const TIMING = {
        // X: 빠른 가상화 피드
        x:       { fast: 400,  slow: 1200, seed: 800 },
        // Threads: 중간
        threads: { fast: 600,  slow: 1500, seed: 800 },
        // Reddit: 느린 로딩
        reddit:  { fast: 800,  slow: 2000, seed: 1000 },
        // Quora: 가장 느림 — API rate limit 방지
        quora:   { fast: 1000, slow: 2500, seed: 1200 }
      };
      const timing = TIMING[platformId] || { fast: 600, slow: 1500, seed: 800 };

      let noNewCount = 0;
      let scrollAttempts = 0;
      const MAX_SCROLL_ATTEMPTS = 200;

      // 비활성 탭 감지 -> 더 관대한 설정
      const isBackgroundTab = document.hidden;
      const MAX_NO_NEW = isBackgroundTab ? 20 : 10;

      // seed가 있으면 현재 화면은 이미 수집됨 -> 먼저 아래로 큰 스크롤
      if (seedResults && seedResults.length > 0) {
        window.scrollBy({ top: window.innerHeight * 2, behavior: 'instant' });
        await sleep(timing.seed);
      }

      // 플랫폼별 스크롤 거리 배수 (Quora는 답변이 길어서 크게)
      const scrollMultiplier = (platformId === 'quora') ? 3 : 1;
      const hasKeywords = keywordsStr && keywordsStr.trim().length > 0;
      let scrollPosition = window.scrollY; // 절대 위치 추적

      /**
       * 키워드 필터 적용 후 매칭 수 계산
       */
      function getMatchedCount() {
        if (!hasKeywords) return allTweets.size;
        return filterByKeywords([...allTweets.values()], keywordsStr).length;
      }

      while (getMatchedCount() < maxCount && scrollAttempts < MAX_SCROLL_ATTEMPTS) {
        // 중지 요청 확인
        if (await shouldStop()) break;

        // 현재 화면의 포스트 파싱
        const currentBatch = parser.parseFeed({
          ...options,
          maxCount: maxCount * (hasKeywords ? 5 : 1)
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
        const matchedSoFar = getMatchedCount();
        await setScrollStatus('running', matchedSoFar);

        if (matchedSoFar >= maxCount) break;

        // 스크롤 — 절대 위치로 이동
        const prevHeight = document.documentElement.scrollHeight;
        scrollPosition += window.innerHeight * scrollMultiplier;
        window.scrollTo({ top: scrollPosition, behavior: 'instant' });

        // 비활성 탭이면 대기 시간 늘림
        const bgMultiplier = document.hidden ? 2 : 1;
        await sleep((noNewCount > 2 ? timing.slow : timing.fast) * bgMultiplier);

        // 피드 끝 판정: 페이지 높이가 안 늘어나고 + 새 포스트도 없으면 진짜 끝
        const currentHeight = document.documentElement.scrollHeight;
        const atBottom = (scrollPosition + window.innerHeight) >= currentHeight;
        
        if (atBottom && newCount === 0 && prevHeight === currentHeight) {
          // 진짜 끝에 도달 — 한번 더 기다려보고 확인
          await sleep(timing.slow * bgMultiplier);
          const finalHeight = document.documentElement.scrollHeight;
          if (finalHeight === currentHeight) {
            break; // 피드 진짜 끝
          }
        }
        
        scrollAttempts++;
      }

      // 스크롤 수집 완료 후 Show more / (more) 펼치기 (최종 1회)
      if (parser.expandAllShowMore) {
        const clicked = parser.expandAllShowMore();
        if (clicked > 0) await sleep(500);
        // 펼친 후 다시 파싱하여 전체 텍스트 갱신
        const finalBatch = parser.parseFeed({ ...options, maxCount: maxCount });
        for (const tweet of finalBatch) {
          const key = tweet.text.substring(0, 120);
          allTweets.set(key, tweet); // 기존 키 덮어쓰기 (펼쳐진 전체 텍스트로)
        }
      }

      // 결과 저장 (키워드 필터 적용)
      const allResults = [...allTweets.values()];
      const filtered = filterByKeywords(allResults, keywordsStr);
      const tweets = filtered.slice(0, maxCount);
      const formatted = parser.formatOutput(tweets);

      await chrome.storage.local.set({
        [scrollResultKey()]: {
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
        [scrollResultKey()]: {
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
   * 키워드 필터링 — OR 방식 / 대소문자 무시
   * @param {Array} tweets - [{handle, time, text}]
   * @param {string} keywordsStr - 쉼표 구분 키워드 문자열
   * @returns {Array} 필터링된 결과
   */
  function filterByKeywords(tweets, keywordsStr) {
    if (!keywordsStr || !keywordsStr.trim()) return tweets;
    
    const keywords = keywordsStr
      .split(',')
      .map(k => k.trim().toLowerCase())
      .filter(k => k.length > 0);
    
    if (keywords.length === 0) return tweets;
    
    return tweets.filter(tweet => {
      const text = (tweet.text || '').toLowerCase();
      const handle = (tweet.handle || '').toLowerCase();
      const combined = `${handle} ${text}`;
      return keywords.some(kw => combined.includes(kw));
    });
  }

  /**
   * 메시지 핸들러
   */
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    
    // 탭 ID 수신 (popup에서 전달)
    if (request.tabId) activeTabId = request.tabId;

    // ── 스마트 추출: 즉시 시도 -> 부족하면 스크롤 ─────────────────
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

      const options = request.options || {};
      const maxCount = options.maxCount || 50;
      const keywordsStr = options.keywords || '';
      const platformInfo = parser.getPlatformInfo();

      (async () => {
        try {
          // Show more 펼치기
          if (parser.expandAllShowMore) {
            const clicked = parser.expandAllShowMore();
            if (clicked > 0) await sleep(500);
          }

          // 1차: 현재 DOM에서 즉시 추출
          const rawResults = parser.parseFeed(options);
          const instantResults = filterByKeywords(rawResults, keywordsStr);

          if (instantResults.length >= maxCount) {
            // 충분 -> 즉시 반환
            const formatted = parser.formatOutput(instantResults);
            sendResponse({
              success: true,
              data: {
                platform: platformInfo.name,
                platformId: platformInfo.id,
                count: instantResults.length,
                formatted,
                raw: instantResults
              }
            });
          } else {
            // 부족 -> 스크롤 수집 시작 (즉시 결과를 seed로 전달)
            sendResponse({
              success: true,
              data: { started: true, instantCount: instantResults.length }
            });

            await chrome.storage.local.remove(scrollStopKey());
            scrollAndCollect(parser, options, platformInfo, instantResults, keywordsStr);
          }
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
