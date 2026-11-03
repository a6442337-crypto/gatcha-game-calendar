# 서브컬처 게임 일정 달력

원신, 스타레일, 젠레스 존 제로, 블루 아카이브, 니케, 우마무스메, 명일방주, 엔드필드, 명조, 림버스 컴퍼니 10개 게임의 **한국 서버** **픽업** 중심 일정(미래시·테스트 서버 예상 포함)을
무료 검색(구글 뉴스 RSS · Bing · DuckDuckGo)과 AI(Gemini)로 하루 두 번 자동으로 모아서 달력 사이트와 캘린더 구독 피드(.ics)로 보여줍니다.

**운영 비용 0원**:
- 검색: 구글 뉴스 RSS · Bing RSS · DuckDuckGo (키 불필요)
- Gemini API 무료 등급 (검색 결과에서 일정 추출만 담당)
- GitHub Actions (공개 저장소 무료)
- GitHub Pages (무료 호스팅)

## 동작 방식

```
GitHub Actions (매일 06:17, 18:17 KST)
  └ scripts/collect.mjs
      1. 게임·서버별 검색어로 무료 검색 + 상위 기사/공지 본문에서 날짜 부분 발췌
      2. Gemini가 자료에 근거한 일정만 JSON 스키마로 추출 (자료에 없는 링크는 폐기)
      3. 검증: 날짜 형식, 지난 일정, 1년 이후 일정, 루머 여부, 공식 출처 여부
      4. 기존 일정과 중복 병합 (제목 유사도 + 날짜), 출처 합치기, 변경 이력 기록
      5. data/events.json 커밋
  └ scripts/build.mjs → 정적 사이트 + .ics 피드 → GitHub Pages 배포
```

확실성 등급 (0~100점, `certainty()` in `scripts/lib/events.mjs`):

| 등급 | 점수 | 표시 |
|---|---|---|
| **확정** | 80+ (공식 출처 90+, 일정 전문 사이트 80+) | 실선 막대 |
| **예상** | 55~79 (미래시) | 점선 막대, 기본 표시 |
| (비공개) | 55 미만 | 사이트·구독 피드에 내보내지 않음 |

점수 = 근거 가중치(공식 1.0 · 기사 0.8 · 미래시 0.78) × 100 × (0.5 + 0.5 × AI 신뢰도)
+ 서로 다른 출처 사이트당 8점(최대 16) + 3회 이상 반복 수집 시 5점. 미래시는 공식 발표 전까지 최대 79점.

화면:
- **픽업 타임라인**(기본): 게임별 줄에 픽업 기간 막대, 오늘선, 신규/복각, D-day
- **카드 목록**: 진행 중 / 예정 / 종료 카드 (모바일 기본)
- **달력**: 월간 달력
- 업데이트·점검 등은 오른쪽 목록, 큰 이벤트(주년·페스·콜라보)는 ★·금색 테두리

## 처음 설정 (한 번만)

1. **Gemini API 키 발급(무료, 카드 불필요)**: https://aistudio.google.com/apikey → *Create API key*
2. 이 저장소의 **Settings → Secrets and variables → Actions → New repository secret**에 이름 `GEMINI_API_KEY`, 값에 키를 넣습니다.
3. **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 바꿉니다.
4. **Actions** 탭에서 *일정 수집 및 배포* → *Run workflow*로 첫 수집을 실행합니다. 이후에는 자동으로 돕니다.
5. 사이트 주소: https://a6442337-crypto.github.io/gatcha-game-calendar/

## 미래시

- **블루 아카이브·우마무스메(일본 서버 선행), 명일방주(중국 서버 선행)** 만 미래시 예상 일정을 다룹니다 (`config/games.json`의 `futuresight`).
- 미래시 일정은 '예상'(점선 막대)으로 표시되고, 공식 공지가 나오면 같은 픽업으로 합쳐져 확정으로 바뀝니다.
- 디시 갤러리에서 미래시 캐릭터 이름이 얼마나 거론되는지 **코드로만** 세어 확실성 점수에 반영합니다 (AI에 보내지 않음).
- **유출·테스트 서버·찌라시 정보는 수집하지도 표시하지도 않습니다.**

## 운영

- **게임 추가·삭제**: `config/games.json`을 수정합니다. `officialDomains`에 공식 사이트를 적으면 정확도가 올라갑니다.
  - `servers[].queries`: 검색어, `servers[].fetchUrls`: 매번 직접 읽을 공지 페이지 주소
- **API 진단**: Run workflow에서 *API 키 진단만 실행*을 체크하면 쓸 수 있는 모델과 한도를 확인합니다.
- **Gemini 내장 Google 검색 사용**: 유료 등급이거나 무료 한도가 있다면 Variables에 `GEMINI_GROUNDING=1`
- **AI가 틀린 일정 고치기**: GitHub 웹에서 `data/overrides.json`을 수정합니다.
  - `hide`: 숨길 일정 id 목록
  - `patch`: `{ "일정id": { "title": "...", "end": "2026-11-20T10:59:00+09:00" } }`
  - `add`: 직접 추가할 일정
- **모델 변경**: Settings → Variables에 `GEMINI_MODEL`을 지정합니다(예: `gemini-2.5-flash`). 지정한 모델이 지원 종료되면 사용 가능한 최신 flash 모델로 자동 전환됩니다.
- **수집 로그**: `data/logs/last-run.json`
- **로컬 실행**:

  ```bash
  npm test                                   # 단위 테스트
  npm run collect:mock && npm run build      # API 없이 모의 데이터로 확인
  GEMINI_API_KEY=... npm run collect genshin # 실제 수집 (특정 게임만)
  npm run serve                              # _site 로컬 미리보기
  ```

## 주의

- AI 수집 결과는 틀릴 수 있습니다. 출처 링크와 공식 공지를 확인하세요.
- 게임 이미지 등 저작물은 저장하지 않고 출처 링크만 표시합니다.
- 무료 등급 한도를 넘지 않도록 요청 간격을 7초로 두었습니다. 게임 하나·서버 하나당 요청은 2회입니다.
- FullCalendar(MIT)는 `site/vendor/`에 포함되어 있습니다.
