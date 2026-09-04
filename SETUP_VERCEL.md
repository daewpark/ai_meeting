# AI 요약 → Notion 자동 저장 설정 가이드 (Vercel 단일 배포 버전)

이 버전은 회의록 앱(`index.html`/`script.js`)과 AI 요약/Notion 저장용 백엔드(`api/summarize.js`)를
**Vercel 한 곳에서 함께 배포**합니다. GitHub Pages + Cloudflare Worker 조합과 달리 별도 서비스를
추가로 만들 필요가 없고, 계정도 Vercel 하나만 있으면 됩니다.

API 키는 절대 웹페이지(`script.js`)에 넣지 않습니다. 공개 소스 코드에 키를 넣으면 그대로
유출되기 때문에, 키는 Vercel 프로젝트의 서버 쪽 환경변수에만 저장하고 `api/summarize.js`가
그 안에서만 사용합니다.

예상 소요 시간 15~20분.

---

## 1단계. Anthropic API 키 발급 (Claude 요약용)

1. https://console.anthropic.com 접속 후 로그인/가입
2. 좌측 메뉴에서 **API Keys** → **Create Key**
3. 생성된 키(`sk-ant-...`로 시작)를 복사해서 안전한 곳에 잠시 보관

> 참고: claude.ai 구독과는 별개로 API 사용량만큼 과금됩니다. 콘솔의 "Billing"에서 결제수단을
> 등록하거나 소액 크레딧을 충전해야 키가 실제로 동작합니다. 월 20~30건 회의록 요약 정도는
> 비용이 매우 적습니다(월 1,000~4,000원 수준).

---

## 2단계. Notion 연동(Integration) 만들기

1. https://www.notion.so/my-integrations 접속
2. **New integration** 클릭 → 이름은 자유롭게(예: "회의록 요약봇") → 워크스페이스 선택 → 제출
3. **Internal Integration Secret**(`ntn_...` 또는 `secret_...`로 시작)을 복사해서 보관
4. Notion 앱에서 회의록을 저장할 **데이터베이스**를 하나 만들거나 기존 것을 선택
   - 반드시 아래 두 속성이 정확한 이름으로 있어야 합니다.
     - **이름** — 제목(Title) 타입 (데이터베이스에 기본으로 있는 제목 속성 이름을 "이름"으로)
     - **날짜** — 날짜(Date) 타입 (새로 추가)
   - 다른 이름을 쓰고 싶다면, 5단계에서 `NOTION_TITLE_PROPERTY` / `NOTION_DATE_PROPERTY`
     환경변수 값을 원하는 이름으로 설정하면 됩니다.
5. 데이터베이스 페이지 우측 상단 **"···"** 메뉴 → **연결(Connections)** → 2단계에서 만든 연동을
   검색해서 추가 (빠뜨리면 "권한 없음" 에러가 납니다)
6. 데이터베이스 페이지의 URL을 복사합니다. 예:
   `https://www.notion.so/내워크스페이스/1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d?v=...`
   → `?` 앞의 32자리(하이픈 없는) 문자열이 **Database ID**입니다.

---

## 3단계. GitHub 저장소 준비

전달드린 파일들(`index.html`, `script.js`, `api/summarize.js`, `package.json`)을 지금 GitHub
Pages로 쓰고 계신 저장소(`ai_meeting`)에 그대로 올려주세요. 폴더 구조는 아래와 같아야 합니다.

```
저장소 루트/
├── index.html
├── script.js
├── package.json
└── api/
    └── summarize.js
```

기존에 있던 `notion-worker.js`, `SETUP_NOTION.md`(Cloudflare 버전 참고 파일)는 그대로 두셔도
무방합니다 — Vercel 배포에는 영향을 주지 않습니다.

---

## 4단계. Vercel 프로젝트 만들기

1. https://vercel.com 접속 → GitHub 계정으로 가입/로그인
2. **Add New** → **Project** 클릭
3. 3단계에서 올린 GitHub 저장소(`ai_meeting`)를 선택 → **Import**
4. Framework Preset은 특별히 손댈 필요 없이 **"Other"**(자동 감지)로 두고, Root Directory도
   기본값(저장소 루트) 그대로 두면 됩니다. 빌드 명령어도 비워두면 됩니다(정적 파일 + API
   함수라 별도 빌드가 필요 없습니다).
5. **Deploy** 클릭 → 1분 내로 배포가 끝나고 `https://ai-meeting-아무개.vercel.app` 같은 주소가
   생성됩니다. 이 주소를 기록해두세요.

---

## 5단계. 환경변수 설정

1. 방금 만든 Vercel 프로젝트 → **Settings** → **Environment Variables**로 이동
2. 아래 값들을 하나씩 추가합니다. **Environment**는 Production/Preview/Development 전부
   체크해두는 게 편합니다.

   | 이름 | 값 | 필수 |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | 1단계에서 복사한 `sk-ant-...` 키 | 필수 |
   | `NOTION_TOKEN` | 2단계에서 복사한 `secret_...`/`ntn_...` 키 | 필수 |
   | `NOTION_DATABASE_ID` | 2단계에서 얻은 32자리 Database ID | 필수 |
   | `CLIENT_SECRET` | 아무 문자열이나 직접 정해서 입력 (예: 임의의 긴 문자열) | 권장 |
   | `NOTION_TITLE_PROPERTY` | `이름` (다르게 만들었다면 그 이름) | 선택 |
   | `NOTION_DATE_PROPERTY` | `날짜` (다르게 만들었다면 그 이름) | 선택 |

3. 저장 후, 상단 **Deployments** 탭에서 최신 배포 옆 "···" → **Redeploy**를 눌러서 환경변수가
   반영된 새 배포를 한 번 만들어주세요 (환경변수는 재배포해야 함수에 적용됩니다).

> `CLIENT_SECRET`을 설정하셨다면, `script.js` 상단의 `NOTION_CLIENT_SECRET = ''` 부분에도
> 똑같은 값을 넣고 다시 저장소에 올려주셔야 합니다. (Vercel과 script.js 양쪽 값이 같아야
> 인증이 통과됩니다.)

---

## 6단계. 테스트 및 링크 교체

1. `https://ai-meeting-아무개.vercel.app` (4단계에서 받은 주소)로 접속
2. 짧게 아무 말이나 녹음해서 텍스트가 쌓이게 한 뒤 "녹음 중지"
3. "AI 요약 → Notion" 버튼 클릭 → 몇 초 뒤 "저장 완료!"로 바뀌고 Notion 페이지 링크가
   표시되면 성공입니다.
4. 정상 동작을 확인하셨으면, Edge 사이드바나 아이폰 홈 화면 등 기존에 등록해둔
   `daewpark.github.io/ai_meeting` 링크를 새 Vercel 주소로 바꿔주세요. 기존 GitHub Pages는
   그대로 켜둬도 되지만(정적 페이지만 보여줌), 거기서는 "AI 요약 → Notion" 버튼이 작동하지
   않습니다 — `/api/summarize`가 GitHub Pages에는 없기 때문입니다. 혼동을 피하려면 GitHub
   Pages는 꺼두시는 걸 추천드립니다 (저장소 Settings → Pages → Build and deployment를 "None"으로).
5. 실패 메시지가 뜨면:
   - `AI 요약 요청이 실패했습니다` → `ANTHROPIC_API_KEY` 오타 또는 크레딧 부족
   - `Notion 저장이 실패했습니다` → 데이터베이스에 연동을 "연결(Connections)"하지 않았거나,
     속성 이름(`이름`/`날짜`)이 실제 데이터베이스와 다름
   - `인증되지 않은 요청입니다` → `CLIENT_SECRET`을 Vercel에는 설정했는데 `script.js`의
     `NOTION_CLIENT_SECRET`을 안 넣었거나 값이 다름

---

## (선택) 커스텀 도메인

Vercel이 기본으로 주는 `...vercel.app` 주소 대신, 갖고 계신 도메인을 연결하고 싶으시면
프로젝트 **Settings → Domains**에서 추가할 수 있습니다. 필수는 아닙니다.

## 참고: Cloudflare 버전과의 차이

이전에 드린 Cloudflare Worker 버전과 기능은 동일하지만, 이 Vercel 버전은 정적 사이트와
백엔드가 같은 프로젝트/같은 도메인에서 배포되기 때문에 (1) 별도 Cloudflare 계정이 필요
없고, (2) `script.js`가 절대주소 대신 `/api/summarize` 상대경로만 호출하면 되어 CORS 설정도
필요 없습니다. 두 버전 중 하나만 실제로 사용하시면 되고, 안 쓰는 쪽 파일은 그냥 두셔도
동작에 영향을 주지 않습니다.
