# 개발 문서

SNS Feed Text Extractor 작업 기준. 코드보다 이 문서를 먼저 읽는다.

## 스택

- Chrome Extension Manifest V3
- 빌드 도구 없음. 순수 JS/HTML/CSS를 그대로 로드한다
- 패키지 매니저 없음. `package.json`, `node_modules` 모두 없다
- 외부 런타임 의존성 없음

## 로드와 실행

```
chrome://extensions -> 개발자 모드 켜기 -> "압축해제된 확장 프로그램을 로드" -> 리포 루트 선택
```

코드를 고친 뒤에는 확장 카드의 새로고침 버튼을 누르고, 대상 탭도 새로고침해야 content script가 다시 주입된다.

로컬 경로: `C:\Users\Administrator\project_win\extension\sns-feed-extractor`

## 검증

자동 테스트 러너는 없다. 푸시 전 최소 아래를 통과시킨다.

```bash
# JS 문법
for f in src/*.js src/platforms/*.js; do node --check "$f" || echo "FAIL $f"; done

# JSON 유효성 (manifest + 전 로케일)
for f in _locales/*/messages.json manifest.json; do
  python3 -c "import json;json.load(open('$f'))" || echo "FAIL $f"
done
```

순수 함수는 노드에서 직접 검증할 수 있다. 두 모듈이 테스트용으로 내부를 노출한다.

- `src/ai-score.js` — CommonJS `module.exports`를 함께 내보내므로 `require()`로 바로 쓴다
- `src/content.js` — IIFE라 직접 require할 수 없다. `vm.createContext`로 `chrome`, `window`, `document`, `window.location` 스텁을 만든 뒤 `runInContext`로 실행하면 `window.__SNS_EXTRACTOR_FILTERS__`에 필터 순수 함수가 노출된다

UI와 DOM 파싱은 수동 확인한다. 셀렉터 변경은 실제 피드에서 돌려봐야 한다.

## 구조

```
manifest.json          권한, content script 주입 순서, 버전
src/ai-score.js        AI 작성 신호 점수 (순수 함수)
src/content.js         필터 체인, 스크롤 수집, 메시지 핸들러
src/popup.js/html/css  옵션 UI, 결과 표시
src/platforms/*.js     플랫폼별 파서 (x, threads, reddit, quora)
_locales/*/            19개 언어 UI 문자열
```

content script 주입 순서가 중요하다. `ai-score.js`와 각 파서가 `content.js`보다 먼저 로드되어야 `window.__SNS_AI_SCORE__`, `window.__SNS_PARSERS__`를 참조할 수 있다. `manifest.json`의 `js` 배열 순서를 바꾸지 않는다.

## 파서 계약

각 파서는 `window.__SNS_PARSERS__.<id>`에 아래를 등록한다.

| 항목 | 필수 | 설명 |
|------|------|------|
| `parseFeed(options)` | 필수 | 현재 DOM에서 글 배열 반환 |
| `formatOutput(posts)` | 필수 | 클립보드용 문자열 |
| `isActive()` | 필수 | 현재 호스트가 이 플랫폼인지 |
| `getPlatformInfo()` | 필수 | `{name, id, icon}` |
| `expandAllShowMore()` | 선택 | "더 보기" 펼치기, 클릭 수 반환 |
| `expandDuringScroll` | 선택 | 스크롤 중에도 펼칠지 |

글 객체 필드: `handle`, `time`, `datetime`(ISO 원본), `text`, `comments`, `commentCount`, `url`, `quote`.

`datetime`과 `commentCount`는 플랫폼에 따라 없을 수 있다. 없는 값으로 거르는 필터는 **통과시킨다**. 판별 못 한 글을 버리면 수집량이 조용히 줄어든다.

## 필터

`content.js`의 `applyFilters`가 모든 필터를 AND로 적용한다. 순서는 값싼 것부터다.

키워드 -> 최소 글자수 -> 답글 수 상한 -> 경과 시간 -> 오늘 답글 단 계정 -> AI 작성 점수

필터를 추가할 때 손대야 하는 곳은 다섯 군데다.

1. `content.js` — 필터 함수 작성, `applyFilters` 체인에 추가
2. `content.js` — `buildFilters`에 옵션 추출, `hasAnyFilter`에 조건 추가
3. `popup.html` — 설정 행 추가
4. `popup.js` — `els` 등록, 상한 상수, `loadSettings`, `saveSettings`, 옵션 조립, `bindNumber`
5. `_locales` 19개 — 라벨 문자열

`hasAnyFilter`를 빠뜨리면 스크롤 수집이 목표 개수를 잘못 계산한다. 필터가 켜져 있으면 파싱을 5배로 늘려 잡기 때문이다.

숫자 옵션은 `0`을 "끔"으로 통일한다. 새 토글 체크박스를 만들지 않는다. 1.11.0에서 토글을 없애고 0으로 통일한 마이그레이션 코드가 `loadSettings`에 남아 있다.

## AI 작성 점수

`src/ai-score.js`. 신호를 합산해 임계값 이상이면 제외한다. 단일 규칙 판정은 오탐이 커서 쓰지 않는다.

가중치와 기준치는 파일 상단 `WEIGHTS`, `T` 상수에 모아 두었다. 조정은 여기서만 한다.

본문만 채점한다. 인용문은 남의 글이라 작성자 판별 근거가 아니다.

현재 가중치는 실사용 수집본 12건으로 잡은 값이다(임계 3에서 사람 글 오탐 0). 표본이 작으므로 배치를 더 돌려 조정할 여지가 있다.

## 건드리지 않는 것

- `privacy.html` — 스토어 심사용. 데이터 취급 방식이 실제로 바뀔 때만 고친다
- `_locales/en` 키 이름 — `data-i18n` 속성이 참조한다. 키를 지우면 라벨이 빈칸이 된다
- `manifest.json`의 `permissions` — 늘리면 스토어 심사 범위가 바뀐다
- `src/welcome.js`의 이메일 수집 엔드포인트 — Supabase 연동

## 버전

기능 추가는 minor, 버그 수정은 patch를 올린다. `manifest.json`의 `version`과 `README.md`의 Changelog를 같은 커밋에서 함께 갱신한다.

## 미확인

- Chrome Web Store 미배포 상태다. 심사 통과 여부에 대한 정보 없음
- `popup.css`의 클래스 의존 관계를 전수 확인하지 않았다. 새 설정 행은 기존 `.setting-row` / `.stepper` 구조를 그대로 복사해 쓴다
