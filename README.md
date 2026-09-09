# 영자신문 워크시트 자동화

워크시트 내용을 JSON 으로 한 번 적으면 **원문 · 워크시트 · 정답지 PDF 세 개**가 만들어지고,
Notion 의 `영자신문 워크시트 마스터 목록` 데이터베이스 해당 행에 자동으로 첨부됩니다.

드래그해서 넣거나, 브라우저 창을 띄워 클릭할 필요가 없습니다.

---

## 왜 이렇게 만들었나

처음 시도는 Chrome 창을 띄워 Notion 화면을 직접 조작하는 방식이었습니다. 이 방식은 계속 실패했는데,
근본 원인은 도구가 잠깐 막힌 게 아니라 **접근 방법 자체가 취약**했기 때문입니다.
화면 자동화는 Notion 이 버튼 위치를 조금만 바꿔도 깨지고, 로그인 세션이 풀리면 멈춥니다.

Notion 은 파일 업로드용 공식 API 를 제공합니다. 화면을 거치지 않고 파일을 바로 올릴 수 있습니다.
그래서 이 저장소는 화면 자동화를 걷어내고 두 가지만 씁니다.

- **Chrome 은 인쇄 엔진으로만** — 창을 띄우지 않는 헤드리스 모드로 HTML 을 PDF 로 뽑습니다.
- **Notion 은 API 로만** — 공식 File Upload API 로 올리고 파일 속성에 겁니다.

클릭할 화면이 없으니 깨질 일도 없습니다.

---

## 전체 흐름

```
data/worksheets/moon-mission.json      ← 여기만 작성하면 됩니다
              │
              ├─ HTML 3종 (A4 인쇄용 레이아웃)
              │
              ├─ 헤드리스 Chrome 인쇄 → PDF 3종
              │
              └─ Notion File Upload API
                        │
                        ├─ 원문     → 원문 속성
                        ├─ 워크시트 → 워크시트 속성
                        └─ 정답지   → 정답지 속성
```

---

## 처음 쓰신다면

[docs/SETUP.md](docs/SETUP.md) 를 먼저 봐주세요. Notion 토큰 발급까지 15분이면 끝납니다.

---

## 사용법

```bash
# 환경이 제대로 갖춰졌는지 확인 (제일 먼저 실행해 보세요)
node src/cli.js doctor

# PDF 만 만들기 — Notion 토큰 없이도 됩니다. 결과는 out/ 에 쌓입니다
node src/cli.js build data/worksheets/moon-mission.json
node src/cli.js build all

# PDF 만들고 Notion 에 첨부까지
node src/cli.js publish data/worksheets/moon-mission.json
node src/cli.js publish all
```

`publish` 는 JSON 의 `title` 과 같은 제목을 가진 Notion 행을 찾아 붙입니다.
행이 없으면 기본적으로 멈추는데, 없으면 새로 만들고 싶으시면 `CREATE_MISSING_ROWS=1` 을 함께 주세요.

---

## 워크시트 JSON 쓰는 법

`data/worksheets/sample-template.json` 을 복사해서 고쳐 쓰시는 게 가장 빠릅니다.

```jsonc
{
  "id": "moon-mission",              // 파일 이름에 쓰입니다 (영문·하이픈)
  "title": "Moon Mission",           // Notion 행 제목과 글자 하나까지 같아야 합니다
  "level": "G2",                     // K1 / G2 / G3-4 / G5-6
  "topic": "Space",                  // Notion 의 주제 선택지 중 하나
  "date": "2026-09-09",
  "sourceUrl": "https://www.timeforkids.com/g2/moon-mission-g2/",
  "note": "Artemis II 달 탐사 임무",

  "article": {
    "paragraphs": ["첫 문단.", "둘째 문단."],   // 문단 하나가 문자열 하나
    "credit": "출처 표기"
  },

  "vocabulary": [
    { "word": "mission", "meaning": "임무" }
  ],

  "questions": [
    { "type": "mc",    "q": "질문", "choices": ["A", "B", "C"], "answer": 1 },
    { "type": "short", "q": "질문", "lines": 2, "answer": "정답", "note": "채점 참고" }
  ],

  "writing": {
    "prompt": "쓰기 과제 안내문",
    "lines": 4,
    "sample": "채점 기준"
  }
}
```

객관식 `answer` 는 **0부터 세는 번호**입니다. 첫 번째 보기가 정답이면 `0`, 두 번째면 `1` 입니다.
`vocabulary`, `questions`, `writing` 은 없으면 그 항목만 빠지고 나머지는 정상 출력됩니다.

`doctor` 가 JSON 형식도 함께 검사하니, 작성 후 한 번 돌려보시면 오타를 미리 잡을 수 있습니다.

---

## GitHub 에 올리면 자동으로 발행됩니다

`data/worksheets/` 에 JSON 을 추가해 `main` 에 push 하면
GitHub Actions 가 PDF 를 만들고 Notion 에 첨부합니다. 컴퓨터를 켜둘 필요가 없습니다.

설정은 [docs/SETUP.md](docs/SETUP.md) 4단계를 참고해 주세요.

---

## 구성

| 경로 | 하는 일 |
| --- | --- |
| `src/cli.js` | 명령어 진입점 (`doctor` / `build` / `publish`) |
| `src/render.js` | JSON → 인쇄용 HTML 3종 |
| `src/pdf.js` | HTML → PDF (헤드리스 Chrome) |
| `src/chrome.js` | Mac·Windows·Linux 에서 Chrome 찾기 |
| `src/notion.js` | Notion 업로드·첨부 API |
| `templates/worksheet.css` | A4 인쇄 스타일 |
| `data/worksheets/` | 워크시트 원본 JSON |
| `out/` | 생성된 HTML·PDF (git 에 올라가지 않습니다) |
