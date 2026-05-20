/**
 * Quora Platform Parser
 * 
 * DOM 구조 (2026-05-20 실제 HTML 분석):
 * - 포스트 컨테이너: div.dom_annotate_multifeed_bundle_AnswersBundle
 * - 유저명: a.puppeteer_test_link[href*="/profile/"] 내부 span > span
 * - 시간: a.answer_timestamp 텍스트 ("Updated 9mo", "4y" 등)
 * - 질문 제목: .puppeteer_test_question_title 내부 span
 * - 본문: .puppeteer_test_answer_content 내부 텍스트
 * - 엔게이지먼트: button[aria-label*="Upvote|comment|shares"] 내부 숫자
 * 
 * 출력 포맷:
 * @유저명 · 시간
 * [질문] 질문 제목
 * 본문 텍스트
 */

const QuoraParser = (() => {
  'use strict';

  // ── 셀렉터 정의 ──────────────────────────────────────────────
  const SELECTORS = {
    // 포스트 컨테이너 — Quora 피드의 각 답변 카드
    post: 'div.dom_annotate_multifeed_bundle_AnswersBundle',
    // 유저 프로필 링크
    profileLink: 'a.puppeteer_test_link[href*="/profile/"]',
    // 질문 제목
    questionTitle: '.puppeteer_test_question_title',
    // 답변 본문
    answerContent: '.puppeteer_test_answer_content',
    // 타임스탬프
    timestamp: 'a.answer_timestamp'
  };

  // ── 유틸리티 ──────────────────────────────────────────────────

  /**
   * 프로필 링크에서 유저명 추출
   * href="/profile/Vincent-6902" -> "Vincent"
   * href="/profile/Mary-Richard-70" -> "Mary Richard"
   * 
   * 실제 표시 이름은 링크 내부 span에서 가져옴
   */
  function extractUsername(postEl) {
    const profileLinks = postEl.querySelectorAll(SELECTORS.profileLink);

    for (const link of profileLinks) {
      // 표시 이름 추출 (span > span 구조)
      const nameSpans = link.querySelectorAll('span span');
      for (const span of nameSpans) {
        const name = span.textContent?.trim();
        if (name && name.length > 1 && !name.includes('Profile photo')) {
          return name;
        }
      }
    }

    // fallback: href에서 추출
    const firstLink = postEl.querySelector(SELECTORS.profileLink);
    if (firstLink) {
      const href = firstLink.getAttribute('href') || '';
      const match = href.match(/\/profile\/([^/?]+)/);
      if (match) {
        // "Mary-Richard-70" -> "Mary Richard"
        return match[1]
          .replace(/-\d+$/, '')    // 끝에 숫자 제거
          .replace(/-/g, ' ');     // 하이픈 -> 공백
      }
    }

    return 'Unknown';
  }

  /**
   * 타임스탬프 추출
   * "Updated 9mo", "4y", "1d" 등
   */
  function extractTime(postEl) {
    const timeLink = postEl.querySelector(SELECTORS.timestamp);
    if (timeLink) {
      return timeLink.textContent?.trim() || '';
    }
    return '';
  }

  /**
   * 질문 제목 추출
   */
  function extractQuestion(postEl) {
    const titleEl = postEl.querySelector(SELECTORS.questionTitle);
    if (titleEl) {
      return titleEl.textContent?.trim() || '';
    }
    return '';
  }

  /**
   * 답변 본문 추출
   * - (more) 링크 텍스트 제거
   * - UI 텍스트 제거
   * - 링크 텍스트는 유지 (본문 일부)
   */
  function extractAnswer(postEl, options = {}) {
    const contentEl = postEl.querySelector(SELECTORS.answerContent);
    if (!contentEl) return '';

    // innerText로 가져오면 숨겨진 요소 제외 + 줄바꿈 유지
    let text = contentEl.innerText?.trim() || '';

    // "(more)" 제거
    text = text.replace(/\(more\)\s*$/i, '').trim();

    // "Continue Reading" 제거
    text = text.replace(/Continue Reading\s*$/i, '').trim();

    // t.co 및 기타 링크 제거 (옵션)
    if (options.removeLinks) {
      text = text.replace(/https?:\/\/\S+/g, '').trim();
    }

    // 연속 줄바꿈 정리
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    // 말줄임표로 끝나는 truncated 텍스트 정리
    text = text.replace(/…\s*$/, '…');

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

      // 광고/프로모션 필터 (Quora의 "Promoted" 답변)
      if (!includePromoted) {
        const promoted = post.querySelector('.dom_annotate_ad_row, [class*="promoted"]');
        if (promoted) continue;
      }

      const username = extractUsername(post);
      const time = extractTime(post);
      const question = extractQuestion(post);
      const answer = extractAnswer(post, { removeLinks });

      // 최소한 질문이나 답변이 있어야 함
      if (!question && !answer) continue;

      // 중복 체크 (질문 기준)
      const dedupeKey = (question + answer).substring(0, 120);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      // 텍스트 조합
      const parts = [];
      if (question) parts.push(`[Q] ${question}`);
      if (answer) parts.push(answer);
      const text = parts.join('\n');

      if (text) {
        results.push({
          handle: `@${username}`,
          time,
          text
        });
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
    return h === 'www.quora.com'
      || h === 'quora.com'
      || h.endsWith('.quora.com');
  }

  function getPlatformInfo() {
    return {
      name: 'Quora',
      id: 'quora',
      icon: 'Q',
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
  window.__SNS_PARSERS__.quora = QuoraParser;
}
