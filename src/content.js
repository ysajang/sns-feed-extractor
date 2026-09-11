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

  // ── 오늘 답글 단 계정 기록 ────────────────────────────────────
  const REPLIED_PREFIX = 'sns_replied_';

  function todayKey() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${REPLIED_PREFIX}${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  async function getRepliedHandles() {
    try {
      const key = todayKey();
      const r = await chrome.storage.local.get(key);
      return Array.isArray(r[key]) ? r[key] : [];
    } catch {
      return [];
    }
  }

  async function addRepliedHandle(handle) {
    if (!handle) return;
    try {
      const key = todayKey();
      const list = await getRepliedHandles();
      const lower = handle.toLowerCase();
      if (list.some(h => h.toLowerCase() === lower)) return;
      list.push(handle);
      await chrome.storage.local.set({ [key]: list });
      // 어제 이전 기록 정리
      const all = await chrome.storage.local.get(null);
      const stale = Object.keys(all).filter(k => k.startsWith(REPLIED_PREFIX) && k !== key);
      if (stale.length) await chrome.storage.local.remove(stale);
    } catch { /* 기록 실패는 무시 */ }
  }

  /**
   * 답글 전송을 감지해 대상 핸들을 기록한다.
   * X의 답글 전송 버튼(tweetButton / tweetButtonInline) 클릭을 캡처 단계에서 관찰,
   * 같은 컨테이너 안의 원글 핸들을 찾아 저장한다.
   */
  function watchReplySubmissions() {
    document.addEventListener('click', (e) => {
      const btn = e.target?.closest?.(
        '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]'
      );
      if (!btn) return;

      // 답글 작성 맥락(모달 또는 상세 페이지) 안의 원글 article에서 핸들 추출
      const scope = btn.closest('[role="dialog"]') || document;
      const article = scope.querySelector('article[data-testid="tweet"]');
      if (!article) return;
      const link = article.querySelector('[data-testid="User-Name"] a[href^="/"]');
      const m = link?.getAttribute('href')?.match(/^\/([^/?#]+)/);
      if (m && m[1]) addRepliedHandle('@' + m[1]);
    }, true);
  }
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
  async function scrollAndCollect(parser, options, platformInfo, seedResults) {
    const maxCount = options.maxCount || 100;
    const repliedHandles = options.excludeReplied ? await getRepliedHandles() : [];
    const filters = buildFilters(options, repliedHandles);
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
      // 목표 수집량에 비례 (1000개 수집 시 200회로는 부족)
      const MAX_SCROLL_ATTEMPTS = Math.min(2000, Math.max(200, maxCount * 3));

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
      const hasFilters = hasAnyFilter(filters);
      // 스크롤 중 "더 보기" 펼치기 — X는 가상 스크롤로 지나간 글이 DOM에서 사라져
      // 마지막에 한 번만 펼치면 잘린 본문을 복구할 수 없다
      const expandWhileScrolling = !!parser.expandDuringScroll && !!parser.expandAllShowMore;
      let scrollPosition = window.scrollY; // 절대 위치 추적

      /**
       * 필터(키워드 + 최소 글자수) 적용 후 매칭 수 계산
       */
      function getMatchedCount() {
        if (!hasFilters) return allTweets.size;
        return applyFilters([...allTweets.values()], filters).length;
      }

      while (getMatchedCount() < maxCount && scrollAttempts < MAX_SCROLL_ATTEMPTS) {
        // 중지 요청 확인
        if (await shouldStop()) break;

        // 화면에 보이는 "더 보기"를 먼저 펼쳐 잘린 본문을 방지
        if (expandWhileScrolling) {
          const clicked = parser.expandAllShowMore();
          if (clicked > 0) await sleep(300);
        }

        // 현재 화면의 포스트 파싱
        const currentBatch = parser.parseFeed({
          ...options,
          maxCount: maxCount * (hasFilters ? 5 : 1)
        });

        let newCount = 0;
        for (const tweet of currentBatch) {
          const key = tweet.text.substring(0, 120);
          const prev = allTweets.get(key);
          if (!prev) {
            allTweets.set(key, tweet);
            newCount++;
          } else if ((tweet.text || '').length > (prev.text || '').length) {
            // 펼쳐진 전체 본문으로 교체 (새 글로는 세지 않음)
            allTweets.set(key, tweet);
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

        // 피드 끝 판정: 플랫폼별 재시도 횟수로 확인
        const currentHeight = document.documentElement.scrollHeight;
        const atBottom = (scrollPosition + window.innerHeight) >= currentHeight;
        
        if (atBottom && newCount === 0 && prevHeight === currentHeight) {
          // 느린 플랫폼일수록 더 많이 재시도
          const END_RETRIES = { x: 2, threads: 4, reddit: 3, quora: 4 };
          const maxRetries = END_RETRIES[platformId] || 3;
          let isRealEnd = true;
          
          for (let retry = 0; retry < maxRetries; retry++) {
            await sleep(timing.slow * bgMultiplier);
            // 스크롤 한번 더 시도 (로딩 트리거)
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
            await sleep(timing.fast * bgMultiplier);
            
            const retryHeight = document.documentElement.scrollHeight;
            if (retryHeight > currentHeight) {
              scrollPosition = retryHeight - window.innerHeight;
              isRealEnd = false;
              break;
            }
          }
          
          if (isRealEnd) break;
        }
        
        scrollAttempts++;
      }

      // 스크롤 수집 완료 후 Show more / (more) 펼치기 (최종 1회)
      if (parser.expandAllShowMore) {
        const clicked = parser.expandAllShowMore();
        if (clicked > 0) await sleep(500);
        // 펼친 후 다시 파싱하여 전체 텍스트 갱신
        const finalBatch = parser.parseFeed({ ...options, maxCount: maxCount * (hasFilters ? 5 : 1) });
        for (const tweet of finalBatch) {
          const key = tweet.text.substring(0, 120);
          const prev = allTweets.get(key);
          if (!prev || (tweet.text || '').length > (prev.text || '').length) {
            allTweets.set(key, tweet); // 펼쳐진 전체 텍스트로 교체
          }
        }
      }

      // 결과 저장 (키워드 + 최소 글자수 필터 적용)
      const allResults = [...allTweets.values()];
      const filtered = applyFilters(allResults, filters);
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
   * 최소 글자수 값 정규화
   * @returns {number} 0이면 필터 비활성
   */
  function normalizeMinLength(value) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(100000, n);
  }

  /**
   * 본문 글자수 계산 — 코드포인트 기준 (이모지 1자 처리)
   * 공백 정리 후 측정
   */
  function textLength(text) {
    if (!text) return 0;
    return Array.from(text.replace(/\s+/g, ' ').trim()).length;
  }

  /**
   * 최소 글자수 필터 — 본문이 minLength "이상"인 것만 통과
   * 인용문은 제외하고 본문만 측정
   */
  function filterByMinLength(tweets, minLength) {
    const min = normalizeMinLength(minLength);
    if (min === 0) return tweets;
    return tweets.filter(tweet => textLength(tweet.text) >= min);
  }

  /**
   * 답글 수 상한 필터 — 답글이 max "이상"이면 제외 (경쟁 과열 글 배제)
   * 답글 수를 판별 못한 글은 통과시킨다
   */
  function filterByMaxComments(tweets, maxComments) {
    const max = parseInt(maxComments, 10);
    if (!Number.isFinite(max) || max <= 0) return tweets;
    return tweets.filter(t => {
      const n = (typeof t.commentCount === 'number') ? t.commentCount : null;
      if (n === null) return true;
      return n < max;
    });
  }

  /**
   * 경과 시간 필터 — 게시 후 maxAgeHours "초과"면 제외
   * datetime(ISO)이 없는 플랫폼(Quora 등)의 글은 통과시킨다
   */
  function filterByAge(tweets, maxAgeHours, now = Date.now()) {
    const hours = parseFloat(maxAgeHours);
    if (!Number.isFinite(hours) || hours <= 0) return tweets;
    const limitMs = hours * 3600 * 1000;
    return tweets.filter(t => {
      if (!t.datetime) return true;
      const ts = Date.parse(t.datetime);
      if (!Number.isFinite(ts)) return true;
      return (now - ts) <= limitMs;
    });
  }

  /**
   * 오늘 이미 답글을 단 계정 제외 (핸들 기준, 대소문자 무시)
   */
  function filterByRepliedHandles(tweets, repliedHandles) {
    if (!repliedHandles || repliedHandles.length === 0) return tweets;
    const set = new Set(repliedHandles.map(h => String(h).toLowerCase()));
    return tweets.filter(t => !set.has(String(t.handle || '').toLowerCase()));
  }

  /**
   * AI 작성 신호 필터 — 점수가 threshold "이상"이면 제외
   * 본문만 채점한다. 인용문은 남의 글이라 작성자 판별 근거가 아니다.
   * threshold가 0이거나 채점 모듈이 없으면 전부 통과시킨다
   */
  function filterByAiScore(tweets, threshold) {
    const limit = parseInt(threshold, 10);
    if (!Number.isFinite(limit) || limit <= 0) return tweets;
    const scorer = window.__SNS_AI_SCORE__;
    if (!scorer || typeof scorer.scoreText !== 'function') return tweets;
    return tweets.filter(t => scorer.scoreText(t.text).score < limit);
  }

  /**
   * 모든 필터를 AND 조건으로 적용
   * @param {Object} f - { keywords, minLength, maxComments, maxAgeHours, repliedHandles, aiThreshold }
   */
  function applyFilters(tweets, f = {}) {
    let out = filterByKeywords(tweets, f.keywords || '');
    out = filterByMinLength(out, f.minLength);
    out = filterByMaxComments(out, f.maxComments);
    out = filterByAge(out, f.maxAgeHours);
    out = filterByRepliedHandles(out, f.repliedHandles);
    out = filterByAiScore(out, f.aiThreshold);
    return out;
  }

  /**
   * options에서 필터 조건만 뽑아낸다
   */
  function buildFilters(options, repliedHandles) {
    return {
      keywords: options.keywords || '',
      minLength: normalizeMinLength(options.minLength),
      maxComments: parseInt(options.maxComments, 10) || 0,
      maxAgeHours: parseFloat(options.maxAgeHours) || 0,
      repliedHandles: repliedHandles || [],
      aiThreshold: parseInt(options.aiThreshold, 10) || 0
    };
  }

  /**
   * 필터가 하나라도 켜져 있는지
   */
  function hasAnyFilter(f) {
    return !!(f.keywords.trim() || f.minLength > 0 || f.maxComments > 0 ||
              f.maxAgeHours > 0 || (f.repliedHandles && f.repliedHandles.length) ||
              f.aiThreshold > 0);
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
      const platformInfo = parser.getPlatformInfo();

      (async () => {
        try {
          const repliedHandles = options.excludeReplied ? await getRepliedHandles() : [];
          const filters = buildFilters(options, repliedHandles);
          const hasFilters = hasAnyFilter(filters);
          // Show more 펼치기
          if (parser.expandAllShowMore) {
            const clicked = parser.expandAllShowMore();
            if (clicked > 0) await sleep(500);
          }

          // 1차: 현재 DOM에서 즉시 추출
          const rawResults = parser.parseFeed({
            ...options,
            maxCount: maxCount * (hasFilters ? 5 : 1)
          });
          const instantResults = applyFilters(rawResults, filters).slice(0, maxCount);

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
            scrollAndCollect(parser, options, platformInfo, instantResults);
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

  // 필터 순수함수 노출 (자동 테스트용 — 런타임 동작에는 영향 없음)
  window.__SNS_EXTRACTOR_FILTERS__ = {
    normalizeMinLength, textLength, filterByKeywords, filterByMinLength,
    filterByMaxComments, filterByAge, filterByRepliedHandles, filterByAiScore,
    applyFilters, buildFilters, hasAnyFilter
  };

  watchReplySubmissions();

  console.log('[SNS Feed Extractor] Content script loaded on', window.location.hostname);
})();
