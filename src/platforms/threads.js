/**
 * Threads Platform Parser
 * 
 * DOM 구조 (2026-05-19 실제 HTML 분석):
 * - 포스트 컨테이너: div[data-pressable-container]
 * - 유저 링크: a[href^="/@"] (첫 번째가 작성자 프로필)
 * - 시간: time[datetime]
 * - 본문 영역:
 *     포스트 내부에 div.xat24cr > span[dir="auto"] > span 구조
 *     본문 span들이 여러 개일 수 있음 (멀티 파트 포스트)
 * - 엔게이지먼트: svg[aria-label="Like|Reply|Repost|Share"] 옆 span에 숫자
 * - 태그 링크: a[href*="/search?q="] 내부 텍스트 (예: "Astrology")
 * - 페이지네이션: 본문 끝에 "1/3" 형태의 별도 div
 * - 클래스명: 해시화 (x1n2onr6 등) -> 셀렉터로 사용 불가
 */

const ThreadsParser = (() => {
  'use strict';

  // ── 셀렉터 정의 ──────────────────────────────────────────────
  const SELECTORS = {
    post:         'div[data-pressable-container]',
    userLink:     'a[href^="/@"]',
    time:         'time[datetime]',
    textSpan:     'span[dir="auto"]'
  };

  // ── 엔게이지먼트 수치 패턴 ────────────────────────────────────
  const ENGAGEMENT_PATTERN = /^[\d,.]+[KkMm]?$/;

  // UI 텍스트 (제외 대상) — 소문자로 매칭
  const UI_TEXTS = new Set([
    'for you', 'following', 'liked', 'followed',
    'translate', 'see translation', 'reply', 'replies',
    'share', 'more', 'less', 'see more', 'repost',
    '번역 보기', '답글', '공유', '더 보기', '좋아요',
    'verified', 'follow', 'like',
    'more'
  ]);

  // ── 유틸리티 ──────────────────────────────────────────────────

  /**
   * time[datetime]에서 시간 포맷
   */
  function formatTime(timeEl) {
    if (!timeEl) return '';

    const displayText = timeEl.textContent?.trim();
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

        return date.toLocaleDateString('ko-KR', {
          month: 'short',
          day: 'numeric'
        });
      } catch {
        // fallback
      }
    }

    return displayText || '';
  }

  /**
   * 유저 링크에서 핸들 추출
   * href="/@username" (프로필 링크만 우선 — /post/ 제외)
   */
  function extractHandle(postEl) {
    const links = postEl.querySelectorAll(SELECTORS.userLink);

    // 1차: 프로필 직접 링크 (/@username 만)
    for (const link of links) {
      const href = link.getAttribute('href');
      if (href) {
        const match = href.match(/^\/@([^/]+)$/);
        if (match && match[1]) {
          return `@${match[1]}`;
        }
      }
    }

    // 2차 fallback: /post/ 포함 링크에서도 추출
    for (const link of links) {
      const href = link.getAttribute('href');
      if (href) {
        const match = href.match(/^\/@([^/]+)/);
        if (match && match[1]) {
          return `@${match[1]}`;
        }
      }
    }

    return '@unknown';
  }

  /**
   * 특정 span이 엔게이지먼트 영역 내부에 있는지 확인
   * 
   * 전략: span의 직계 부모(최대 3단계)가 엔게이지먼트 SVG를
   * **직접 자식**으로 갖고 있을 때만 필터링
   * 깊이 8까지 querySelector로 탐색하면 포스트 전체가 매칭되므로
   * 직접 자식(children) + 형제(siblings)만 체크
   */
  function isInsideEngagement(span) {
    let el = span.parentElement;
    let depth = 0;

    while (el && depth < 4) {
      // 현재 el의 직접 자식 중에 엔게이지먼트 SVG가 있는지
      const children = el.children;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        // SVG 자체인 경우
        if (child.tagName === 'svg' || child.tagName === 'SVG') {
          const label = child.getAttribute('aria-label');
          if (label === 'Like' || label === 'Reply' || label === 'Repost' || label === 'Share') {
            return true;
          }
        }
        // 한 단계 아래에 SVG가 있는 경우 (div > svg 구조)
        if (child !== span && child.children) {
          for (let j = 0; j < child.children.length; j++) {
            const grandchild = child.children[j];
            if (grandchild.tagName === 'svg' || grandchild.tagName === 'SVG') {
              const label = grandchild.getAttribute('aria-label');
              if (label === 'Like' || label === 'Reply' || label === 'Repost' || label === 'Share') {
                return true;
              }
            }
          }
        }
      }

      el = el.parentElement;
      depth++;
    }

    return false;
  }

  /**
   * 특정 span이 태그/검색 링크 내부에 있는지 확인
   * 직계 부모 체인만 확인 (a 태그는 보통 1-2단계 위)
   */
  function isInsideTagLink(span) {
    let el = span.parentElement;
    let depth = 0;

    while (el && depth < 4) {
      if (el.tagName === 'A' && el.getAttribute('href')?.includes('/search?q=')) {
        return true;
      }
      el = el.parentElement;
      depth++;
    }

    return false;
  }

  /**
   * 특정 span이 Follow 버튼 영역 내부인지 확인
   * Follow SVG는 버튼 바로 안에 있으므로 2단계면 충분
   */
  function isInsideFollowButton(span) {
    let el = span.parentElement;
    let depth = 0;

    while (el && depth < 3) {
      // 직접 자식 중 Follow SVG가 있는지
      const children = el.children;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if ((child.tagName === 'svg' || child.tagName === 'SVG') &&
            child.getAttribute('aria-label') === 'Follow') {
          return true;
        }
      }
      el = el.parentElement;
      depth++;
    }

    return false;
  }

  /**
   * 텍스트가 UI/메타데이터인지 판별
   */
  function isFilteredText(text, handle) {
    if (!text) return true;

    const trimmed = text.trim();
    if (trimmed.length === 0) return true;

    // 순수 숫자/엔게이지먼트
    if (ENGAGEMENT_PATTERN.test(trimmed)) return true;

    // UI 텍스트
    if (UI_TEXTS.has(trimmed.toLowerCase())) return true;

    // "Translate" 단독
    if (/^translate$/i.test(trimmed) || trimmed === '번역') return true;

    // 유저명과 동일
    const handleClean = handle.replace('@', '');
    if (trimmed === handleClean) return true;

    // 시간 패턴 ("9h", "16h", "2d", "1w", "04/05/25" 등)
    if (/^\d+[mhdsw]$/.test(trimmed)) return true;
    if (/^\d{2}\/\d{2}\/\d{2}$/.test(trimmed)) return true;

    // 미디어 카운터 단독 ("1/2", "2/3")
    if (/^\d+\/\d+$/.test(trimmed)) return true;

    // 단일 문자 ("/" 등 페이지네이션 조각)
    if (trimmed === '/') return true;

    return false;
  }

  /**
   * 포스트에서 본문 텍스트 추출
   * 
   * 전략:
   * 1. 모든 span[dir="auto"] 수집
   * 2. 엔게이지먼트 영역 / 태그 링크 / Follow 버튼 내부 span 제외
   * 3. 유저명 / 시간 / 숫자 / UI텍스트 필터링
   * 4. 중복 제거 (부모-자식 span 겹침 -> 가장 긴 버전 유지)
   */
  function extractPostText(postEl, handle) {
    const spans = postEl.querySelectorAll(SELECTORS.textSpan);
    const textParts = [];

    for (const span of spans) {
      // 구조적 제외: 엔게이지먼트 / 태그 / Follow 내부
      if (isInsideEngagement(span)) continue;
      if (isInsideTagLink(span)) continue;
      if (isInsideFollowButton(span)) continue;

      const text = span.textContent?.trim();

      if (isFilteredText(text, handle)) continue;

      // "Translate" 접미사 제거
      let cleaned = text.replace(/\s*Translate\s*$/i, '').trim();

      // 끝에 붙은 페이지네이션 제거 ("...1/3" -> "...")
      cleaned = cleaned.replace(/\s*\d+\/\d+\s*$/, '').trim();

      // nbsp 정리
      cleaned = cleaned.replace(/\u00a0/g, ' ').trim();

      if (cleaned.length > 2) {
        textParts.push(cleaned);
      }
    }

    // 중복 제거: 부모 span이 자식 span 텍스트를 포함하는 경우
    // 가장 긴 버전만 유지
    const unique = [];
    for (const part of textParts) {
      const existingIdx = unique.findIndex(u =>
        u.includes(part) || part.includes(u)
      );

      if (existingIdx === -1) {
        unique.push(part);
      } else if (part.length > unique[existingIdx].length) {
        unique[existingIdx] = part;
      }
    }

    return unique.join('\n').trim();
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

      const handle = extractHandle(post);
      if (handle === '@unknown') continue;

      const text = extractPostText(post, handle);
      if (!text) continue;

      // 중복 체크
      const dedupeKey = text.substring(0, 100);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const timeEl = post.querySelector(SELECTORS.time);
      const time = formatTime(timeEl);

      let finalText = text;
      if (removeLinks) {
        finalText = finalText.replace(/https?:\/\/\S+/g, '').trim();
      }

      if (finalText) {
        results.push({ handle, time, text: finalText });
      }
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
    return h === 'www.threads.net'
      || h === 'threads.net'
      || h === 'www.threads.com'
      || h === 'threads.com';
  }

  function getPlatformInfo() {
    return {
      name: 'Threads',
      id: 'threads',
      icon: '🧵',
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
  window.__SNS_PARSERS__.threads = ThreadsParser;
}
