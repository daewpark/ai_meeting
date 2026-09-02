// ============================================================================
// api/summarize.js — Vercel Function (Node.js 런타임)
//
// 회의록 앱의 "AI 요약 → Notion" 버튼이 호출하는 백엔드입니다.
// 이 파일이 /api 폴더에 있으면 Vercel이 자동으로 https://내사이트.vercel.app/api/summarize
// 주소의 API로 배포해줍니다. 정적 사이트(index.html/script.js)와 같은 프로젝트,
// 같은 도메인에서 함께 배포되므로 Cloudflare 같은 별도 서비스가 필요 없습니다.
//
// 역할: 회의 스크립트를 받아서 → Claude로 요약(지정된 마크다운 리포트 형식) →
//       그 리포트를 Notion 블록으로 변환해 페이지 생성 → 결과 반환.
// API 키는 전부 Vercel 프로젝트의 환경변수(Settings → Environment Variables)에만
// 저장되고, 브라우저(script.js)는 절대 이 키들을 알지 못합니다.
//
// 배포 방법은 SETUP_VERCEL.md를 참고하세요.
//
// 2026-08-28: 원래 `runtime: 'edge'`로 배포했었는데, Vercel이 Edge Functions를
// 공식적으로 지원 중단(신규 프로젝트에 사용 비권장)했고, 스트리밍이 아닌 일반
// 요청·응답 방식은 사실상 25초 안팎으로 처리를 끝내야 하는 제약이 있었습니다.
// 이 함수는 Claude 요약 요청 → Notion 파일 업로드(2단계) → Notion 페이지 생성까지
// 순차적으로 네트워크 호출을 하기 때문에, 회의가 길어질수록 이 제약에 걸려
// 타임아웃으로 실패할 위험이 있었습니다. 기본 Node.js 런타임(Hobby 플랜 기준
// 기본 최대 300초)으로 옮겨서 이 위험을 크게 줄였습니다. `fetch`/`FormData`/`Blob`/
// `Request`/`Response` 등 여기서 쓰는 API는 Node.js 런타임에서도 동일하게
// 전역으로 제공되므로, 아래 로직은 Edge일 때와 완전히 동일합니다 — 바뀐 건
// export 방식(런타임에 함수를 등록하는 방법)뿐입니다.

// 사용할 Claude 모델. 더 저렴하게 하려면 claude-haiku-4-5, 더 고품질을 원하면
// claude-opus-4-8로 바꿀 수 있습니다.
// (최신 모델명은 https://platform.claude.com/docs/en/about-claude/models/overview 참고)
const CLAUDE_MODEL = 'claude-sonnet-4-6';

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// Notion의 rich_text 한 조각은 2000자 제한이 있어서, 긴 텍스트는 여러 조각으로 나눕니다.
function chunkText(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

// Notion rich_text 하나. **굵게** 표시는 bold 어노테이션으로 변환하고,
// 2000자 제한을 넘지 않도록 안전하게 자릅니다.
function richTextRun(content, bold) {
  const safeContent = content.length > 1900 ? content.slice(0, 1900) + '…' : content;
  const run = { type: 'text', text: { content: safeContent } };
  if (bold) run.annotations = { bold: true };
  return run;
}

// 한 줄의 텍스트 안에서 **굵게** 마크다운만 최소한으로 해석해서 rich_text 배열로 변환합니다.
function parseInlineRichText(text) {
  const parts = [];
  const regex = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(richTextRun(text.slice(lastIndex, match.index), false));
    parts.push(richTextRun(match[1], true));
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) parts.push(richTextRun(text.slice(lastIndex), false));
  if (parts.length === 0) parts.push(richTextRun('', false));
  return parts;
}

function paragraphBlock(text) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function paragraphBlockRich(text) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: parseInlineRichText(text) },
  };
}

function heading1Block(text) {
  return {
    object: 'block',
    type: 'heading_1',
    heading_1: { rich_text: parseInlineRichText(text) },
  };
}

function heading2Block(text) {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function heading3Block(text) {
  return {
    object: 'block',
    type: 'heading_3',
    heading_3: { rich_text: parseInlineRichText(text) },
  };
}

function bulletBlockRich(text) {
  return {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: parseInlineRichText(text) },
  };
}

// "| a | b |" 형태의 마크다운 표 줄들(구분선 "| :--- | :--- |" 제외)을 Notion table 블록으로 변환합니다.
function buildTableBlock(lines) {
  const dataLines = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^\|[\s\-:|]+\|$/.test(l));

  const rowsCells = dataLines.map((l) => {
    let inner = l;
    if (inner.startsWith('|')) inner = inner.slice(1);
    if (inner.endsWith('|')) inner = inner.slice(0, -1);
    return inner.split('|').map((c) => c.trim());
  });

  const width = rowsCells.reduce((max, r) => Math.max(max, r.length), 1);

  const tableRows = rowsCells.map((cells) => {
    const padded = cells.slice(0, width);
    while (padded.length < width) padded.push('');
    return {
      object: 'block',
      type: 'table_row',
      table_row: { cells: padded.map((c) => parseInlineRichText(c)) },
    };
  });

  return {
    object: 'block',
    type: 'table',
    table: {
      table_width: width,
      has_column_header: true,
      has_row_header: false,
      children: tableRows,
    },
  };
}

// AI가 돌려준 마크다운 리포트를 Notion 블록 배열로 변환합니다.
// (헤딩, **굵은 글씨** 섹션 제목, 불릿(1단계 중첩 포함), 표를 지원하고 그 외는 일반 문단으로 처리)
function markdownToBlocks(markdown) {
  // 혹시 모델이 코드블록으로 감싸서 응답한 경우를 방어적으로 제거합니다.
  const cleaned = markdown.replace(/^```(?:markdown)?\s*\n?/, '').replace(/```\s*$/, '').trim();
  const lines = cleaned.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (trimmed === '') { i++; continue; }

    if (trimmed === '---' || trimmed === '***') {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
      i++; continue;
    }

    // "### 제목" 형태의 마크다운 헤딩
    const hMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (hMatch) {
      blocks.push(hMatch[1].length === 1 ? heading1Block(hMatch[2]) : heading2Block(hMatch[2]));
      i++; continue;
    }

    // "**1. 회의 개요**" 처럼 한 줄 전체가 굵게 표시된 섹션 제목
    const boldHeaderMatch = trimmed.match(/^\*\*([^*]+)\*\*$/);
    if (boldHeaderMatch) {
      blocks.push(heading3Block(boldHeaderMatch[1]));
      i++; continue;
    }

    // 마크다운 표 (Action Items 표 등)
    if (trimmed.startsWith('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      blocks.push(buildTableBlock(tableLines));
      continue;
    }

    // 불릿 포인트. 들여쓰기가 4칸 이상이면 바로 위 불릿의 하위 항목으로 중첩합니다.
    const bulletMatch = rawLine.match(/^(\s*)[*-]\s+(.+)$/);
    if (bulletMatch) {
      const indent = bulletMatch[1].length;
      const content = bulletMatch[2].trim();
      const block = bulletBlockRich(content);
      const lastBlock = blocks[blocks.length - 1];
      if (indent >= 4 && lastBlock && lastBlock.type === 'bulleted_list_item') {
        lastBlock.bulleted_list_item.children = lastBlock.bulleted_list_item.children || [];
        lastBlock.bulleted_list_item.children.push(block);
      } else {
        blocks.push(block);
      }
      i++; continue;
    }

    // 그 외는 일반 문단으로 처리
    blocks.push(paragraphBlockRich(trimmed));
    i++;
  }

  return blocks;
}

// 리포트의 "**주요 주제:** ..." 줄에서 Notion 페이지 제목으로 쓸 짧은 문구를 뽑아냅니다.
function extractTitle(markdown) {
  const m = markdown.match(/\*\*\s*주요\s*주제\s*:?\s*\*\*\s*(.+)/);
  if (m) {
    const t = m[1].trim();
    if (t) return t.slice(0, 100);
  }
  return null;
}

// 파일 업로드 API는 2022-06-28보다 나중에 추가된 기능이라, 페이지/블록 생성과는
// 별도의 최신 Notion-Version이 필요합니다. (페이지 생성 쪽은 이미 검증된 2022-06-28을 그대로 둡니다.)
const NOTION_FILE_API_VERSION = '2026-03-11';

// 회의 원문을 .txt 파일로 Notion에 직접 업로드하고, 그 파일을 가리키는 file 블록을 돌려줍니다.
// 업로드가 조금이라도 실패하면 예외를 던지고, 호출한 쪽에서 텍스트 블록으로 대체합니다.
//
// 한글이 깨져 보이는 문제 방지: Content-Type에 charset=utf-8을 명시하고(브라우저가 인코딩을
// 잘못 추측해 한글을 깨진 문자로 표시하는 것을 방지), 파일 맨 앞에 UTF-8 BOM을 붙입니다
// (BOM이 없으면 Windows 메모장 등 일부 프로그램이 한글을 시스템 기본 인코딩(CP949)으로
// 잘못 해석해서 깨진 문자로 보여주는 경우가 있습니다 — BOM을 보면 UTF-8로 정확히 인식합니다).
const UTF8_BOM = '﻿';

async function uploadTranscriptAsFile(transcript, filename) {
  const createRes = await fetch('https://api.notion.com/v1/file_uploads', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_FILE_API_VERSION,
    },
    body: JSON.stringify({ mode: 'single_part', filename, content_type: 'text/plain;charset=utf-8' }),
  });
  if (!createRes.ok) {
    throw new Error(`file_upload 생성 실패: ${await createRes.text()}`);
  }
  const created = await createRes.json();

  const form = new FormData();
  form.append('file', new Blob([UTF8_BOM + transcript], { type: 'text/plain;charset=utf-8' }), filename);

  const sendRes = await fetch(`https://api.notion.com/v1/file_uploads/${created.id}/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_FILE_API_VERSION,
      // Content-Type은 FormData를 body로 넘기면 boundary 포함해서 자동으로 설정되므로 직접 지정하지 않습니다.
    },
    body: form,
  });
  if (!sendRes.ok) {
    throw new Error(`file_upload 전송 실패: ${await sendRes.text()}`);
  }

  return {
    object: 'block',
    type: 'file',
    file: { type: 'file_upload', file_upload: { id: created.id } },
  };
}

export default {
async fetch(request) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'POST 요청만 지원합니다.' }, 405);
  }

  // (선택) 아무나 이 주소를 알아내 호출해서 API 사용량을 소모하지 못하도록 하는 간단한 안전장치.
  // Vercel 환경변수에 CLIENT_SECRET을 설정한 경우에만 검사합니다.
  if (process.env.CLIENT_SECRET) {
    const provided = request.headers.get('X-Client-Secret');
    if (provided !== process.env.CLIENT_SECRET) {
      return jsonResponse({ error: '인증되지 않은 요청입니다.' }, 401);
    }
  }

  let transcript;
  try {
    const body = await request.json();
    transcript = (body.transcript || '').trim();
  } catch (e) {
    return jsonResponse({ error: '요청 본문을 읽을 수 없습니다.' }, 400);
  }

  if (!transcript) {
    return jsonResponse({ error: '회의 내용이 비어 있습니다.' }, 400);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: 'ANTHROPIC_API_KEY가 설정되지 않았습니다.' }, 500);
  }
  if (!process.env.NOTION_TOKEN || !process.env.NOTION_DATABASE_ID) {
    return jsonResponse({ error: 'NOTION_TOKEN 또는 NOTION_DATABASE_ID가 설정되지 않았습니다.' }, 500);
  }

  // ---- 1) Claude로 요약 요청 (지정된 '회의 요약 리포트' 마크다운 형식으로만 답하도록 지시) ----
  const summaryPrompt = `당신은 기업의 핵심 회의 내용을 완벽하게 정리하는 '수석 비서관 및 비즈니스 분석가'입니다.
사용자가 Web Speech API 등을 통해 실시간 음성 인식(STT)으로 녹취된 회의록 원문을 제공하면, 이를 분석하여 명확하고 구조화된 형태의 결과물로 요약 및 정리해야 합니다.

[핵심 지침]
1. STT 오류 보정 및 문맥 추론: 입력된 텍스트는 음성 인식의 한계로 인해 오탈자, 띄어쓰기 오류, 문장 구조의 붕괴가 있을 수 있습니다. 문맥을 깊이 파악하여 발언자의 원래 의도에 맞게 문장을 교정하여 이해하세요.
2. 핵심 용어 통일 (Inconsistency 해결): 고유명사, 프로젝트명, 전문 용어 등이 다르게 인식되었더라도(예: '제미나이', '재미나이', 'Gemini'), 문맥상 같은 의미라면 가장 정확하고 공식적인 단어로 통일하여 정리하세요.
3. 핵심 내용 요약: 구어체, 중복되는 말, 불필요한 감탄사나 잡담은 제거하고, 회의의 주요 안건과 결정 사항을 중심적으로 요약하세요.
4. Action Item 도출 (가장 중요): 회의 내용 중 누군가 실행해야 할 과제나 향후 계획이 언급되었다면 이를 반드시 포착하세요. 누가(Who), 무엇을(What), 언제까지(When) 해야 하는지 명확히 하여 별도의 섹션으로 분리해야 합니다.

[출력 형식]
결과물은 반드시 아래의 마크다운 형식만 그대로 사용해서 작성하세요. 괄호 안의 설명(예: "(안건이 여러 개일 경우 논리적으로 분류하여...)")은 작성 지침일 뿐이므로 실제 출력에는 절대 포함하지 마세요. 이 형식 이외의 인사말, 부연 설명, 코드블록 표시(\`\`\`) 등도 포함하지 마세요.

### 📝 회의 요약 리포트

**1. 회의 개요**
*   **주요 주제:** (회의의 핵심 주제를 1줄로 작성)
*   **회의 목적:** (이 회의를 진행한 주된 목적)

**2. 주요 논의 사항**
*   (주제 1)
    *   세부 내용 및 결정 사항 요약
*   (주제 2)
    *   세부 내용 및 결정 사항 요약

**3. 🚀 Action Items (실행 과제)**
| 담당자 (Who) | 실행 과제 (What) | 기한 (When) | 비고 |
| :--- | :--- | :--- | :--- |
| 담당자명(또는 미정) | 명확한 행동 지시어 사용 | 날짜 또는 '미정' | 관련 참고 사항 |

(표 형태로 깔끔하게 제공하며, 도출된 Action Item이 없다면 표 대신 "도출된 Action Item이 없습니다."라는 한 줄만 작성)

**4. 용어 및 맥락 보정 노트 (선택 사항)**
*   (STT 인식 오류가 심해 AI가 임의로 통일하거나 수정한 주요 키워드가 있다면 여기에 간략히 명시. 없다면 이 섹션 자체를 생략)

회의 스크립트:
"""
${transcript}
"""`;

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      // 회의가 길어서 안건/액션아이템이 많으면 리포트 자체가 길어질 수 있어 넉넉하게 잡습니다.
      // (한도일 뿐 실제 청구는 실제로 생성된 토큰만큼만 되므로, 짧은 회의의 비용에는 영향이 없습니다.)
      // 2026-09-02: 긴 회의에서 리포트가 4096 토큰을 넘어 중간에 잘리는 사례가 발생해
      // 16000으로 상향했습니다. 이 모델(claude-sonnet-4-6 계열)의 최대 출력은 64K 토큰이라
      // 16000은 충분히 안전한 여유치이며, 실제 과금은 여전히 생성된 토큰 수만큼만 됩니다.
      max_tokens: 16000,
      messages: [{ role: 'user', content: summaryPrompt }],
    }),
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    return jsonResponse({ error: 'AI 요약 요청이 실패했습니다.', detail: errText }, 502);
  }

  const claudeData = await claudeRes.json();

  // 응답이 max_tokens 한도에 걸려 중간에 잘린 경우, 잘린 마크다운으로 어설프게 Notion 페이지를
  // 만드는 대신(예: 표가 한 칸만 있는 상태로 저장됨) 명확한 실패로 처리합니다.
  if (claudeData.stop_reason === 'max_tokens') {
    return jsonResponse(
      {
        error: 'AI 응답이 너무 길어져 중간에 잘렸습니다.',
        detail: '회의 내용이 많아 요약 결과가 응답 길이 한도를 초과했습니다. 다시 시도해도 반복되면 관리자에게 문의해주세요.',
      },
      502
    );
  }

  const rawText = ((claudeData.content && claudeData.content[0] && claudeData.content[0].text) || '').trim();
  const reportMarkdown = rawText || '(AI 응답이 비어 있습니다.)';
  const title = extractTitle(reportMarkdown) || '회의록 요약';

  // ---- 2) 리포트 마크다운 → Notion 블록 변환 ----
  const today = new Date().toISOString().slice(0, 10);

  let children;
  try {
    children = markdownToBlocks(reportMarkdown);
    if (!children.length) throw new Error('빈 결과');
  } catch (e) {
    // 마크다운 → Notion 블록 변환에 실패해도 AI가 준 요약 내용 자체는 유실되지 않도록,
    // 받은 텍스트를 그대로 문단으로 나눠서 저장합니다.
    console.error('마크다운 변환 실패, 원문 텍스트로 대체합니다:', e);
    children = chunkText(reportMarkdown, 1900).map((c) => paragraphBlock(c));
  }

  // ---- 2-1) 회의 원문(STT 스크립트)은 텍스트 블록 대신 .txt 첨부파일로 붙입니다 ----
  const hh = String(new Date().getHours()).padStart(2, '0');
  const min = String(new Date().getMinutes()).padStart(2, '0');
  const filename = `회의록_${today.replace(/-/g, '')}_${hh}${min}.txt`;

  children.push(heading2Block('원문'));
  try {
    const fileBlock = await uploadTranscriptAsFile(transcript, filename);
    children.push(fileBlock);
  } catch (e) {
    // 파일 업로드가 실패해도 회의록 저장 자체는 계속 진행합니다.
    // 대신 원문을 텍스트로라도 남겨서 내용이 유실되지 않게 합니다.
    console.error('파일 업로드 실패, 텍스트로 대체합니다:', e);
    children.push(paragraphBlock('※ 원문 파일 첨부에 실패해 텍스트로 대신 표시합니다.'));
    chunkText(transcript, 1900).forEach((c) => children.push(paragraphBlock(c)));
  }

  // Notion 데이터베이스의 제목/날짜 속성 이름. 데이터베이스에서 이 이름과
  // 정확히 일치하는 속성을 만들어야 합니다 (SETUP_VERCEL.md 참고).
  const titleProp = process.env.NOTION_TITLE_PROPERTY || '이름';
  const dateProp = process.env.NOTION_DATE_PROPERTY || '날짜';

  const properties = {
    [titleProp]: { title: [{ text: { content: title } }] },
  };
  if (dateProp) {
    properties[dateProp] = { date: { start: today } };
  }

  const notionRes = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({
      parent: { database_id: process.env.NOTION_DATABASE_ID },
      properties,
      children,
    }),
  });

  if (!notionRes.ok) {
    const errText = await notionRes.text();
    return jsonResponse({ error: 'Notion 저장이 실패했습니다.', detail: errText }, 502);
  }

  const notionData = await notionRes.json();
  return jsonResponse({ ok: true, title, url: notionData.url }, 200);
},
};
