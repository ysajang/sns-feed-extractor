/**
 * X (Twitter) Platform Parser
 * 
 * DOM 셀렉터 기반 트윗 텍스트 추출
 * data-testid 속성은 React 컴포넌트명에 바인딩되어 CSS 클래스보다 안정적
 * 
 * 참고: https://alterlab.io/blog/how-to-scrape-twitter-x-complete-guide-for-2026
 * 최종 검증: 2026-05-16
 */

const XParser = (() => {
  'use strict';

  // ── 셀렉터 정의 (변경 시 여기만 수정) ──────────────────────────
  const SELECTORS = {
    tweet:       'article[data-testid="tweet"]',
    tweetText:   '[data-testid="tweetText"]',
    userName:    '[data-testid="User-Name"]',
    time:        'time[datetime]',
    // 광고/프로모션 필터링용
    adIndicator: '[data-testid="placementTracking"]',
    promotedIcon: 'svg[data-testid="icon-promoted"]',
    // 피드 컨테이너 (MutationObserver 대상)
    feedContainers: [
      'div[aria-label="Timeline: Your Home Timeline"]',
      'div[aria-label="Home timeline"]',
      'div[aria-label*="Timeline: Search"]',
      'div[data-testid="primaryColumn"]',
      'main[role="main"]'
    ],
    // "Show more" 버튼 (잘린 트윗 펼치기)
    showMore: '[data-testid="tweet-text-show-more-link"]'
  };

  // ── 유틸리티 ──────────────────────────────────────────────────
  
  /**
   * 상대시간 문자열을 그대로 사용하되
   * datetime 속성이 있으면 로컬 시간으로 변환
   */
  function formatTime(timeEl) {
    if (!timeEl) return '';
    
    const datetime = timeEl.getAttribute('datetime');
    if (datetime) {
      try {
        const date = new Date(datetime);
        const now = new Date();
        const diffMs = now - date;
        const diffMin = Math.floor(diffMs / 60000);
        const diffHour = Math.floor(diffMs / 3600000);
        const diffDay = Math.floor(diffMs / 86400000);

        if (diffMin < 1) return 'just now';
        if (diffMin < 60) return `${diffMin}m`;
        if (diffHour < 24) return `${diffHour}h`;
        if (diffDay < 7) return `${diffDay}d`;
        
        // 7일 이상이면 날짜 표시
        return date.toLocaleDateString('ko-KR', {
          month: 'short',
          day: 'numeric'
        });
      } catch {
        // datetime 파싱 실패 시 표시 텍스트 사용
      }
    }
    
    return timeEl.textContent?.trim() || '';
  }

  /**
   * User-Name 영역에서 @handle 추출
   * DOM 구조: [data-testid="User-Name"] 내부에 여러 span이 있고
   * @로 시작하는 텍스트를 가진 span이 핸들
   * 
   * fallback: /status/ 링크에서 username 파싱
   */
  function extractHandle(tweetEl) {
    // 방법 1: User-Name 내 @ 텍스트
    const userNameEl = tweetEl.querySelector(SELECTORS.userName);
    if (userNameEl) {
      const spans = userNameEl.querySelectorAll('span');
      for (const span of spans) {
        const text = span.textContent?.trim();
        if (text && text.startsWith('@')) {
          return text;
        }
      }
    }

    // 방법 2: /status/ 링크에서 추출
    const links = tweetEl.querySelectorAll('a[href*="/status/"]');
    for (const link of links) {
      const href = link.getAttribute('href');
      if (href) {
        const match = href.match(/^\/([^/]+)\/status\//);
        if (match && match[1]) {
          return `@${match[1]}`;
        }
      }
    }

    // 방법 3: User-Name 전체 텍스트에서 @ 패턴 추출
    if (userNameEl) {
      const fullText = userNameEl.textContent || '';
      const match = fullText.match(/@[\w]+/);
      if (match) return match[0];
    }

    return '@unknown';
  }

  /**
   * 트윗이 광고/프로모션인지 판별
   */
  function isPromoted(tweetEl) {
    if (tweetEl.querySelector(SELECTORS.adIndicator)) return true;
    if (tweetEl.querySelector(SELECTORS.promotedIcon)) return true;
    
    // "Ad" 또는 "프로모션" 텍스트 체크 (하위 span에서)
    const spans = tweetEl.querySelectorAll('span');
    for (const span of spans) {
      const text = span.textContent?.trim().toLowerCase();
      if (text === 'ad' || text === 'promoted' || text === '프로모션') {
        return true;
      }
    }
    
    return false;
  }

  /**
   * 본문 텍스트 정제
   * - 이모지는 유지
   * - t.co 링크 제거 (선택적)
   * - 앞뒤 공백 정리
   */
  function cleanText(text, options = {}) {
    if (!text) return '';
    
    let cleaned = text;
    
    // t.co 축약 링크 제거 (옵션)
    if (options.removeLinks) {
      cleaned = cleaned.replace(/https?:\/\/t\.co\/\S+/g, '').trim();
    }
    
    // 연속 줄바꿈 정리 (최대 2개)
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    
    // 앞뒤 공백
    cleaned = cleaned.trim();
    
    return cleaned;
  }

  // ── 메인 파서 ─────────────────────────────────────────────────

  /**
   * 현재 DOM 내 모든 "Show more" 버튼을 클릭하여 잘린 트윗을 펼침
   * content script는 격리된 world에서 실행되므로
   * 실제 마우스 이벤트를 dispatch해야 React 핸들러가 반응
   */
  function expandAllShowMore() {
    const buttons = document.querySelectorAll(SELECTORS.showMore);
    let clicked = 0;

    for (const btn of buttons) {
      try {
        // React 이벤트 시스템이 반응하는 네이티브 이벤트 시퀀스
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        clicked++;
      } catch {
        // 클릭 실패 무시
      }
    }

    return clicked;
  }

  /**
   * 현재 뷰포트에 보이는 트윗들을 파싱하여 구조화된 배열로 반환
   * 
   * @param {Object} options
   * @param {boolean} options.removeLinks - t.co 링크 제거 여부 (default: true)
   * @param {boolean} options.includePromoted - 광고 포함 여부 (default: false)
   * @param {number} options.maxCount - 최대 추출 수 (default: 100)
   * @returns {Array<{handle: string, time: string, text: string}>}
   */
  function parseFeed(options = {}) {
    // Show more 버튼 클릭하여 잘린 트윗 펼치기
    expandAllShowMore();
    const {
      removeLinks = true,
      includePromoted = false,
      maxCount = 100
    } = options;

    const articles = document.querySelectorAll(SELECTORS.tweet);
    const results = [];
    const seen = new Set(); // 중복 방지 (리트윗 등)

    for (const article of articles) {
      if (results.length >= maxCount) break;

      // 광고 필터
      if (!includePromoted && isPromoted(article)) continue;

      // 본문 텍스트 추출
      const textEl = article.querySelector(SELECTORS.tweetText);
      if (!textEl) continue; // 텍스트 없는 트윗 (미디어 온리 등) 스킵

      const rawText = textEl.innerText;
      const text = cleanText(rawText, { removeLinks });
      if (!text) continue;

      // 중복 체크 (본문 앞 100자 기준)
      const dedupeKey = text.substring(0, 100);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      // 핸들 + 시간
      const handle = extractHandle(article);
      const timeEl = article.querySelector(SELECTORS.time);
      const time = formatTime(timeEl);

      results.push({ handle, time, text });
    }

    return results;
  }

  /**
   * 파싱 결과를 지정 포맷 문자열로 변환
   * 
   * @param {Array} tweets - parseFeed() 결과
   * @returns {string} 포맷된 텍스트
   */
  function formatOutput(tweets) {
    if (!tweets || tweets.length === 0) {
      return '';
    }

    return tweets.map(t => {
      const header = t.time ? `${t.handle} · ${t.time}` : t.handle;
      return `${header}\n${t.text}`;
    }).join('\n\n');
  }

  /**
   * 현재 플랫폼이 X인지 확인
   */
  function isActive() {
    const hostname = window.location.hostname;
    return hostname === 'x.com' || hostname === 'twitter.com';
  }

  /**
   * 플랫폼 정보
   */
  function getPlatformInfo() {
    return {
      name: 'X (Twitter)',
      id: 'x',
      icon: '𝕏',
      selectors: { ...SELECTORS }
    };
  }

  // ── Public API ────────────────────────────────────────────────
  return {
    parseFeed,
    formatOutput,
    isActive,
    getPlatformInfo,
    SELECTORS
  };
})();

// content.js에서 접근할 수 있도록 window에 등록
if (typeof window !== 'undefined') {
  window.__SNS_PARSERS__ = window.__SNS_PARSERS__ || {};
  window.__SNS_PARSERS__.x = XParser;
}
