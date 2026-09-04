# AI 요약 → Notion 자동 저장 설정 가이드

회의록 앱에 "AI 요약 → Notion" 버튼이 추가되었습니다. 이 버튼을 누르면:

1. 화면의 회의 스크립트가 Cloudflare Worker(작은 서버)로 전송되고
2. Worker가 Claude API로 회의를 요약(제목/요약/주요 논의사항/액션 아이템)하고
3. 그 결과를 Notion 데이터베이스에 새 페이지로 저장합니다.

API 키는 절대 웹페이지(script.js)에 넣지 않습니다. GitHub Pages는 누구나 소스 코드를 볼 수 있는 공개 사이트라서, 키를 거기 넣으면 그대로 유출됩니다. 그래서 키는 중간에 있는 Cloudflare Worker에만 저장하고, 웹페이지는 그 Worker의 주소만 압니다.

아래 순서대로 진행하시면 됩니다. 예상 소요 시간 15~20분.

---

## 1단계. Anthropic API 키 발급 (Claude 요약용)

1. https://console.anthropic.com 접속 후 로그인/가입
2. 좌측 메뉴에서 **API Keys** → **Create Key**
3. 생성된 키(`sk-ant-...`로 시작)를 복사해서 안전한 곳에 잠시 보관

> 참고: claude.ai 구독(Pro 등)과는 별개로, API 사용량만큼 별도 과금됩니다. 회의록 몇 건 요약하는 정도는 비용이 매우 적습니다(월 몇백 원~몇천 원 수준). 콘솔에서 "Billing"에 소액 크레딧을 충전해야 키가 실제로 동작합니다.

---

## 2단계. Notion 연동(Integration) 만들기

1. https://www.notion.so/my-integrations 접속
2. **New integration** 클릭 → 이름은 자유롭게(예: "회의록 요약봇") → 워크스페이스 선택 → 제출
3. **Internal Integration Secret**(`ntn_...` 또는 `secret_...`로 시작)을 복사해서 보관
4. Notion 앱으로 이동해서, 회의록을 저장할 **데이터베이스**를 하나 만들거나 기존 것을 선택
   - 반드시 아래 두 속성이 있어야 합니다 (이름이 정확히 일치해야 합니다):
     - **이름** — 제목(Title) 타입 (Notion 데이터베이스에 기본으로 있는 제목 속성의 이름을 "이름"으로 두면 됩니다)
     - **날짜** — 날짜(Date) 타입 (새로 추가)
   - 속성 이름을 다르게 쓰고 싶다면, 나중에 Worker 설정에서 `NOTION_TITLE_PROPERTY` / `NOTION_DATE_PROPERTY` 값을 원하는 이름으로 바꾸면 됩니다.
5. 그 데이터베이스 페이지 우측 상단 **"···"** 메뉴 → **연결(Connections)** → 2단계에서 만든 연동을 검색해서 추가 (이 단계를 빠뜨리면 "권한 없음" 에러가 납니다)
6. 데이터베이스 페이지의 URL을 복사합니다. 예:
   `https://www.notion.so/내워크스페이스/1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d?v=...`
   → `?` 앞부분, 32자리(하이픈 없는) 문자열이 **Database ID**입니다. 위 예시라면 `1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d`

---

## 3단계. Cloudflare Worker 배포 (무료)

1. https://dash.cloudflare.com 에서 계정 생성(무료) 후 로그인
2. 좌측 메뉴 **Workers & Pages** → **Create** → **Create Worker**
3. 이름을 정하고(예: `meeting-notion-summary`) 생성 → **Edit code** 클릭
4. 에디터에 기본으로 들어있는 코드를 전부 지우고, 함께 전달드린 **`notion-worker.js`** 파일 내용을 그대로 붙여넣기
5. 우측 상단 **Deploy** 클릭 → 배포되면 `https://meeting-notion-summary.내계정.workers.dev` 형태의 주소가 생깁니다. 이 주소를 복사해두세요 (5단계에서 필요합니다).
6. Worker 페이지에서 **Settings** → **Variables and Secrets** (버전에 따라 "Environment Variables")로 이동해서, 아래 값들을 하나씩 추가합니다. 전부 **Secret(암호화)** 타입으로 추가하는 걸 권장합니다.

   | 이름 | 값 | 필수 |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | 1단계에서 복사한 `sk-ant-...` 키 | 필수 |
   | `NOTION_TOKEN` | 2단계에서 복사한 `secret_...`/`ntn_...` 키 | 필수 |
   | `NOTION_DATABASE_ID` | 2단계에서 얻은 32자리 Database ID | 필수 |
   | `ALLOWED_ORIGIN` | `https://daewpark.github.io` | 권장 (다른 사이트에서 이 Worker를 함부로 호출하지 못하게 제한) |
   | `CLIENT_SECRET` | 아무 문자열이나 직접 정해서 입력 (예: 임의의 긴 문자열) | 권장 (아래 4단계와 값이 같아야 함) |
   | `NOTION_TITLE_PROPERTY` | `이름` (Notion 속성 이름을 다르게 만들었다면 그 이름) | 선택 |
   | `NOTION_DATE_PROPERTY` | `날짜` (다르게 만들었다면 그 이름) | 선택 |

   값 입력 후 저장하면 Worker가 자동으로 재배포됩니다.

---

## 4단계. 회의록 앱(script.js)에 Worker 주소 연결

1. `script.js` 맨 위쪽의 아래 줄을 찾습니다.
   ```js
   const NOTION_WORKER_URL = 'https://REPLACE_ME.workers.dev';
   ```
2. `REPLACE_ME.workers.dev` 부분을 3단계 5번에서 복사한 실제 Worker 주소로 바꿉니다.
3. (3단계에서 `CLIENT_SECRET`을 설정했다면) fetch 요청에 헤더를 하나 추가해야 합니다. `script.js`의 `notionBtn` 클릭 핸들러 안, `fetch(NOTION_WORKER_URL, {...})` 부분의 `headers`에 아래 줄을 추가해주세요.
   ```js
   'X-Client-Secret': '3단계에서 정한 CLIENT_SECRET 값',
   ```
4. 수정한 `script.js`를 GitHub 저장소에 커밋 & 푸시하면 GitHub Pages가 자동으로 반영됩니다.

---

## 5단계. 테스트

1. https://daewpark.github.io/ai_meeting/ 접속
2. 짧게 아무 말이나 녹음해서 텍스트가 쌓이게 한 뒤 "녹음 중지"
3. "AI 요약 → Notion" 버튼 클릭
4. 몇 초 뒤 "저장 완료!"로 바뀌고, 화면 상단에 Notion 페이지 링크가 표시되면 성공입니다.
5. 만약 실패 메시지가 뜨면, 메시지에 포함된 에러 내용을 보고 아래를 점검해주세요.
   - `AI 요약 요청이 실패했습니다` → `ANTHROPIC_API_KEY` 오타 또는 크레딧 부족
   - `Notion 저장이 실패했습니다` → 데이터베이스에 연동을 "연결(Connections)"하지 않았거나, 속성 이름(`이름`/`날짜`)이 실제 데이터베이스와 다름
   - `인증되지 않은 요청입니다` → `CLIENT_SECRET`을 설정했는데 script.js에 `X-Client-Secret` 헤더를 안 넣었거나 값이 다름

---

## 참고: 왜 이렇게 복잡한가요?

지금 회의록 앱은 서버 없이 GitHub Pages에 올라간 순수 HTML/JS 페이지라서, "AI 요약 + Notion 저장"처럼 비밀키가 필요한 작업을 페이지 안에서 직접 할 수 없습니다(키를 넣는 순간 누구나 볼 수 있음). Cloudflare Worker는 이 비밀키를 안전하게 보관하면서 대신 API를 호출해주는 아주 작은 무료 서버 역할을 합니다. 한 번만 설정해두면, 이후로는 버튼 클릭 한 번으로 계속 동작합니다.
