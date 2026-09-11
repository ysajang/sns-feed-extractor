/**
 * AI 작성 신호 점수
 *
 * 생성형 도구로 찍어낸 글은 사람 글과 표면 형태가 다르다.
 * 단일 규칙은 오탐이 크므로 여러 신호를 합산해 점수로 다룬다.
 * 점수가 임계값 이상이면 수집에서 제외한다.
 *
 * 점수는 판정이 아니라 우선순위다. 임계값을 0으로 두면 필터는 꺼진다.
 */

const AiScore = (() => {
  'use strict';

  // 신호별 가중치 — 합산 점수가 임계값 이상이면 제외
  const WEIGHTS = {
    capsHeadings: 2,   // 전부 대문자 섹션 제목
    arrowLines: 2,     // 화살표로 시작하는 줄 나열
    bulletsNoFirst: 3, // 불릿 다수 + 1인칭 없음
    hashtags: 1,       // 해시태그 과다
    longNoFirst: 2,    // 장문 + 1인칭 없음
    colonHeadings: 1,  // 콜론으로 끝나는 헤더 줄 다수
    shortLineWall: 2,  // 한 줄 문단 연속 나열
    noFirstPerson: 1   // 짧지 않은 글인데 1인칭이 하나도 없음
  };

  // 신호 발동 기준치
  const T = {
    capsHeadings: 2,
    arrowLines: 4,
    bullets: 5,
    hashtags: 3,
    longChars: 1200,
    colonHeadings: 3,
    shortLineCount: 10,
    shortLineChars: 40,
    shortLineRatio: 0.7,
    // 이보다 짧은 글은 1인칭이 없어도 자연스러우므로 신호로 세지 않는다
    firstPersonMinChars: 200
  };

  // 1인칭 표지 — 영어 우선, 한국어 보조
  const FIRST_PERSON = /\b(i|i'm|im|i've|i'd|i'll|me|my|mine|myself|we|we're|we've|our|ours)\b|내가|제가|저는|나는|우리(가|는)?/i;

  // 불릿 기호로 시작하는 줄
  const BULLET_LINE = /^\s*[•·◦▪▫‣⁃*\-–]\s+\S/;

  // 화살표로 시작하는 줄 — 인용 표기(>)는 사람 글에도 흔해 제외
  const ARROW_LINE = /^\s*(→|->|⇒|=>|▸|➜|➡)\s*\S/;

  function lines(text) {
    return String(text || '')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);
  }

  function charCount(text) {
    return Array.from(String(text || '').replace(/\s+/g, ' ').trim()).length;
  }

  function hasFirstPerson(text) {
    return FIRST_PERSON.test(String(text || ''));
  }

  /**
   * 전부 대문자인 섹션 제목 줄 수
   * 글자가 4자 이상이고 알파벳이 모두 대문자인 짧은 줄만 센다
   */
  function countCapsHeadings(ls) {
    return ls.filter(l => {
      if (l.length < 4 || l.length > 60) return false;
      const letters = l.replace(/[^A-Za-z]/g, '');
      if (letters.length < 4) return false;
      return letters === letters.toUpperCase();
    }).length;
  }

  /**
   * 화살표 나열 정도
   * 줄 시작 화살표만 세면 "Build -> Launch -> Ship"처럼 한 줄에 몰아쓴 형태를 놓친다.
   * 줄 시작 개수와 본문 전체 개수 중 큰 값을 쓴다.
   */
  function countArrowLines(ls, text) {
    const atLineStart = ls.filter(l => ARROW_LINE.test(l)).length;
    const anywhere = (String(text || '').match(/(→|->|⇒|=>|▸|➜|➡)/g) || []).length;
    return Math.max(atLineStart, anywhere);
  }

  function countBulletLines(ls) {
    return ls.filter(l => BULLET_LINE.test(l)).length;
  }

  function countHashtags(text) {
    const m = String(text || '').match(/#[^\s#]{2,}/g);
    return m ? m.length : 0;
  }

  /**
   * 콜론으로 끝나는 헤더성 줄 수 — 80자 이하만
   */
  function countColonHeadings(ls) {
    return ls.filter(l => l.length <= 80 && /:$/.test(l)).length;
  }

  /**
   * 한 줄 문단이 벽처럼 이어지는 형태인지
   * 짧은 줄이 일정 수 이상이면서 전체의 대부분을 차지할 때만 발동
   */
  function isShortLineWall(ls) {
    if (ls.length < T.shortLineCount) return false;
    const short = ls.filter(l => charCount(l) < T.shortLineChars).length;
    if (short < T.shortLineCount) return false;
    return (short / ls.length) >= T.shortLineRatio;
  }

  /**
   * 본문의 AI 작성 신호 점수와 발동한 신호 목록을 반환
   * @param {string} text
   * @returns {{score: number, signals: string[]}}
   */
  function scoreText(text) {
    const body = String(text || '');
    if (!body.trim()) return { score: 0, signals: [] };

    const ls = lines(body);
    const firstPerson = hasFirstPerson(body);
    const signals = [];
    let score = 0;

    function hit(name) {
      score += WEIGHTS[name];
      signals.push(name);
    }

    const len = charCount(body);

    if (countCapsHeadings(ls) >= T.capsHeadings) hit('capsHeadings');
    if (countArrowLines(ls, body) >= T.arrowLines) hit('arrowLines');
    if (!firstPerson && countBulletLines(ls) >= T.bullets) hit('bulletsNoFirst');
    if (countHashtags(body) >= T.hashtags) hit('hashtags');
    if (!firstPerson && len >= T.longChars) hit('longNoFirst');
    if (countColonHeadings(ls) >= T.colonHeadings) hit('colonHeadings');
    if (isShortLineWall(ls)) hit('shortLineWall');
    if (!firstPerson && len >= T.firstPersonMinChars) hit('noFirstPerson');

    if (score < 0) score = 0;
    return { score, signals };
  }

  return {
    scoreText,
    WEIGHTS,
    THRESHOLDS: T,
    // 단위 검증용 내부 함수
    _internals: {
      lines, charCount, hasFirstPerson, countCapsHeadings, countArrowLines,
      countBulletLines, countHashtags, countColonHeadings, isShortLineWall
    }
  };
})();

if (typeof window !== 'undefined') {
  window.__SNS_AI_SCORE__ = AiScore;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AiScore;
}
