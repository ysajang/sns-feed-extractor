/**
 * Reddit Platform Parser
 * 
 * DOM 구조 (2026-05-21 실제 HTML 분석):
 * Reddit은 Web Components (shreddit-post) 기반
 * 데이터가 HTML 속성에 직접 존재하여 파싱이 단순
 * 
 * - 포스트 컨테이너: shreddit-post (article 내부)
 * - 유저명: [author] 속성
 * - 제목: [post-title] 속성
 * - 시간: [created-timestamp] 속성 (ISO 8601)
 * - 본문: [property="schema:articleBody"] 내부 텍스트
 * - 서브레딧: [subreddit-prefixed-name] 속성
 * - 점수: [score] 속성
 * - 댓글 수: [comment-count] 속성
 * 
 * 출력 포맷:
 * @유저명 · r/subreddit · 시간
 * [제목]
 * 본문 텍스트
 */

const RedditParser = (() => {
  'use strict';

  const SELECTORS = {
    post:        'shreddit-post',
    body:        '[property="schema:articleBody"]',
    timeTag:     'faceplate-timeago time'
  };

  // ── 유틸리티 ──────────────────────────────────────────────────

  /**
   * ISO 타임스탬프에서 상대 시간 포맷
   */
  function formatTime(isoString) {
    if (!isoString) return '';

    try {
      const date = new Date(isoString);
      const now = new Date();
      const diffMs = now - date;
      const diffMin = Math.floor(diffMs / 60000);
      const diffHour = Math.floor(diffMs / 3600000);
      const diffDay = Math.floor(diffMs / 86400000);

      if (diffMin < 1) return 'just now';
      if (diffMin < 60) return `${diffMin}m`;
      if (diffHour < 24) return `${diffHour}h`;
      if (diffDay < 30) return `${diffDay}d`;

      return date.toLocaleDateString('ko-KR', {
        month: 'short',
        day: 'numeric'
      });
    } catch {
      return '';
    }
  }

  /**
   * 본문 텍스트 추출 및 정제
   */
  function extractBody(postEl, options = {}) {
    const bodyEl = postEl.querySelector(SELECTORS.body);
    if (!bodyEl) return '';

    let text = bodyEl.innerText?.trim() || '';

    // 링크 제거 (옵션)
    if (options.removeLinks) {
      text = text.replace(/https?:\/\/\S+/g, '').trim();
    }

    // 연속 줄바꿈 정리
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    return text;
  }

  // ── 메인 파서 ─────────────────────────────────────────────────

  function parseFeed(options = {}) {
    const {
      removeLinks = true,
      includePromoted = false,
      maxCount = 100
    } = options;

    const posts = document.querySelectorAll(SELECTORS.post);
    const results = [];
    const seen = new Set();

    for (const post of posts) {
      if (results.length >= maxCount) break;

      // 광고 필터 — Reddit 프로모션 포스트
      if (!includePromoted) {
        const isAd = post.hasAttribute('is-promoted') ||
                     post.getAttribute('post-type') === 'promoted';
        if (isAd) continue;
      }

      // 속성에서 직접 추출
      const author = post.getAttribute('author');
      const title = post.getAttribute('post-title');
      const timestamp = post.getAttribute('created-timestamp');
      const subreddit = post.getAttribute('subreddit-prefixed-name');

      if (!author || !title) continue;

      // 본문 추출
      const body = extractBody(post, { removeLinks });

      // 시간 — faceplate-timeago에서 먼저 시도 후 속성 fallback
      const timeEl = post.querySelector(SELECTORS.timeTag);
      let time = timeEl?.textContent?.trim() || '';
      if (!time && timestamp) {
        time = formatTime(timestamp);
      }

      // 텍스트 조합
      const parts = [];
      parts.push(title);
      if (body) parts.push(body);
      const text = parts.join('\n');

      // 중복 체크
      const dedupeKey = (title + (body || '')).substring(0, 120);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      // 핸들 구성: @유저 · r/subreddit
      const handle = subreddit
        ? `@${author} · ${subreddit}`
        : `@${author}`;

      results.push({ handle, time, text });
    }

    return results;
  }

  function formatOutput(tweets) {
    if (!tweets || tweets.length === 0) return '';

    return tweets.map(t => {
      const header = t.time ? `${t.handle} · ${t.time}` : t.handle;
      return `${header}\n${t.text}`;
    }).join('\n\n');
  }

  function isActive() {
    const h = window.location.hostname;
    return h === 'www.reddit.com'
      || h === 'reddit.com'
      || h === 'old.reddit.com'
      || h === 'new.reddit.com';
  }

  function getPlatformInfo() {
    return {
      name: 'Reddit',
      id: 'reddit',
      icon: '🔴',
      selectors: { ...SELECTORS }
    };
  }

  return {
    parseFeed,
    formatOutput,
    isActive,
    getPlatformInfo,
    SELECTORS
  };
})();

if (typeof window !== 'undefined') {
  window.__SNS_PARSERS__ = window.__SNS_PARSERS__ || {};
  window.__SNS_PARSERS__.reddit = RedditParser;
}
