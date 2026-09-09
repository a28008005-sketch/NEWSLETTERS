# 처음 한 번만 하는 설정

전체 15분 정도 걸립니다. 한 번 해두면 그 뒤로는 손댈 일이 없습니다.

---

## 1. Notion 통합(Integration) 만들기 — 약 5분

Notion 에 파일을 자동으로 올리려면 "이 프로그램이 내 Notion 을 만져도 된다"는 열쇠가 필요합니다.
그 열쇠를 통합 토큰이라고 부릅니다.

1. https://www.notion.so/profile/integrations 에 접속합니다.
2. **New integration** 을 누릅니다.
3. 아래처럼 채웁니다.
   - Name: `워크시트 자동화`
   - Associated workspace: `희진의 Notion`
   - Type: **Internal**
4. 만들고 나면 **Internal Integration Secret** 이 보입니다.
   `ntn_` 으로 시작하는 긴 문자열입니다. 이걸 복사해 둡니다.

> 이 값은 비밀번호와 같습니다. 카카오톡이나 메모장에 그대로 두지 마시고,
> 아래 3단계처럼 환경변수나 GitHub Secret 에만 넣어주세요.

---

## 2. 데이터베이스에 통합 연결하기 — 약 2분

토큰을 만들었다고 바로 접근되는 건 아닙니다. 어떤 페이지를 만져도 되는지 따로 허락해야 합니다.

1. Notion 에서 **영자신문 워크시트 마스터 목록** 데이터베이스를 엽니다.
2. 오른쪽 위 **···** → **연결(Connections)** → **연결 추가**
3. 방금 만든 `워크시트 자동화` 를 고릅니다.

이 단계를 빠뜨리면 `데이터베이스에 접근할 수 없습니다` 오류가 납니다.
오류가 나면 대부분 이 단계입니다.

---

## 3. 내 컴퓨터에서 쓰기

Node.js 18 이상과 Chrome 이 필요합니다. Chrome 은 이미 쓰고 계실 테니 Node 만 확인하시면 됩니다.
(없으면 https://nodejs.org 에서 LTS 버전을 받으세요.)

### Mac / Linux

```bash
git clone https://github.com/a28008005-sketch/NEWSLETTERS.git
cd NEWSLETTERS

export NOTION_TOKEN="ntn_여기에_붙여넣기"

node src/cli.js doctor
```

### Windows (PowerShell)

```powershell
git clone https://github.com/a28008005-sketch/NEWSLETTERS.git
cd NEWSLETTERS

$env:NOTION_TOKEN = "ntn_여기에_붙여넣기"

node src\cli.js doctor
```

`doctor` 가 전부 ✅ 로 나오면 준비 끝입니다.

터미널을 닫으면 `NOTION_TOKEN` 이 사라집니다.
매번 넣기 번거로우시면 Mac 은 `~/.zshrc` 에, Windows 는 시스템 환경변수에 등록해 두세요.

---

## 4. GitHub 에서 자동으로 돌리기 — 약 3분

이걸 해두면 워크시트 JSON 을 GitHub 에 올리기만 해도 PDF 가 만들어지고
Notion 에 알아서 첨부됩니다. 컴퓨터를 켜둘 필요도 없습니다.

1. https://github.com/a28008005-sketch/NEWSLETTERS/settings/secrets/actions 로 갑니다.
2. **New repository secret** 을 누릅니다.
   - Name: `NOTION_TOKEN`
   - Secret: 1단계에서 복사한 `ntn_...` 값
3. 저장합니다.

이제 `data/worksheets/` 에 JSON 을 추가해서 push 하면 자동으로 발행됩니다.
직접 돌려보고 싶으시면 저장소의 **Actions** 탭 → **워크시트 Notion 발행** → **Run workflow** 를 누르시면 됩니다.

---

## 자주 겪는 문제

| 증상 | 원인과 해결 |
| --- | --- |
| `NOTION_TOKEN 이 없습니다` | 환경변수를 넣지 않았거나 터미널을 새로 열었습니다. 3단계를 다시 실행하세요. |
| `데이터베이스에 접근할 수 없습니다` | 2단계(연결 추가)를 빠뜨렸습니다. |
| `Chrome 을 찾지 못했습니다` | Chrome 을 다른 경로에 설치하셨습니다. `CHROME_PATH` 로 실행 파일 경로를 알려주세요. |
| `"제목"의 행을 찾지 못했습니다` | JSON 의 `title` 과 Notion 행 제목이 글자 하나까지 같아야 합니다. 앞뒤 공백도 확인해 보세요. |
| PDF 에서 한글이 네모로 나옴 | 한글 글꼴이 없는 환경입니다. Linux 라면 `sudo apt-get install fonts-nanum` 을 실행하세요. |
