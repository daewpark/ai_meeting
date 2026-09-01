// ============================================================================
// notion-worker.js — Cloudflare Worker
//
// 회의록 앱의 "AI 요약 → Notion" 버튼이 호출하는 백엔드입니다.
// 브라우저(script.js)는 API 키를 절대 갖고 있지 않고, 이 Worker만 갖고 있습니다.
// 역할: 회의 스크립트를 받아서 → Claude로 요약(JSON) → Notion 페이지 생성 → 결과 반환.
//
// 배포 방법은 SETUP_NOTION.md를 참고하세요.
// ============================================================================

// 사용할 Claude 모델. 요약 품질을 더 높이고 싶으면 claude-opus-4-8 등으로 바꿔도 됩니다.
// (Anthropic 문서: https://platform.claude.com/docs/en/about-claude/models/overview 에서 최신 모델명 확인 가능)
const CLAUDE_MODEL = 'claude-sonnet-4-6';

function corsHeaders(origin, allowedOrigin) {
  const allow = allowedOrigin && origin === allowedOrigin ? origin : (allowedOrigin || '*');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// Notion의 rich_text 한 블록은 2000자 제한이 있어서, 긴 원문은 여러 조각으로 나눕니다.
function chunkText(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function paragraphBlock(text) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function heading2Block(text) {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function bulletBlock(text) {
  return {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function todoBlock(text) {
  return {
    object: 'block',
    type: 'to_do',
    to_do: { rich_text: [{ type: 'text', text: { content: text } }], checked: false },
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'POST 요청만 지원합니다.' }, 405, headers);
    }

    // (선택) 아무나 이 주소를 알아내 호출해서 API 사용량을 소모하지 못하도록 하는 간단한 안전장치.
    // CLIENT_SECRET을 설정한 경우에만 검사합니다. 완벽한 보안은 아니지만 무단 호출을 줄여줍니다.
    if (env.CLIENT_SECRET) {
      const provided = request.headers.get('X-Client-Secret');
      if (provided !== env.CLIENT_SECRET) {
        return jsonResponse({ error: '인증되지 않은 요청입니다.' }, 401, headers);
      }
    }

    let transcript;
    try {
      const body = await request.json();
      transcript = (body.transcript || '').trim();
    } catch (e) {
      return jsonResponse({ error: '요청 본문을 읽을 수 없습니다.' }, 400, headers);
    }

    if (!transcript) {
      return jsonResponse({ error: '회의 내용이 비어 있습니다.' }, 400, headers);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return jsonResponse({ error: 'ANTHROPIC_API_KEY가 설정되지 않았습니다.' }, 500, headers);
    }
    if (!env.NOTION_TOKEN || !env.NOTION_DATABASE_ID) {
      return jsonResponse({ error: 'NOTION_TOKEN 또는 NOTION_DATABASE_ID가 설정되지 않았습니다.' }, 500, headers);
    }

    // ---- 1) Claude로 요약 요청 (JSON 형식으로만 답하도록 지시) ----
    const summaryPrompt = `다음은 회의를 음성인식으로 받아쓴 스크립트입니다. 오탈자나 띄어쓰기 오류가 있을 수 있으니 문맥으로 이해해서 요약하세요.
반드시 아래 JSON 형식으로만 답하세요. 그 외 설명, 인사말, 코드블록 표시(\`\`\`) 등은 절대 포함하지 마세요.

{
  "title": "회의 제목 (핵심 주제 기반, 15자 내외)",
  "summary": "회의 전체 내용을 2~3문장으로 요약",
  "key_points": ["주요 논의사항 1", "주요 논의사항 2"],
  "action_items": ["실행할 일 (담당자/기한이 언급됐다면 포함)"]
}

회의 스크립트:
"""
${transcript}
"""`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        messages: [{ role: 'user', content: summaryPrompt }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return jsonResponse({ error: 'AI 요약 요청이 실패했습니다.', detail: errText }, 502, headers);
    }

    const claudeData = await claudeRes.json();
    const rawText = (claudeData.content && claudeData.content[0] && claudeData.content[0].text) || '{}';

    let parsed;
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
    } catch (e) {
      // JSON 파싱에 실패해도 최소한 텍스트는 저장되도록 fallback 처리
      parsed = { title: '회의록 요약', summary: rawText, key_points: [], action_items: [] };
    }

    const title = parsed.title || '회의록 요약';
    const summary = parsed.summary || '';
    const keyPoints = Array.isArray(parsed.key_points) ? parsed.key_points : [];
    const actionItems = Array.isArray(parsed.action_items) ? parsed.action_items : [];

    // ---- 2) Notion 페이지 생성 ----
    const today = new Date().toISOString().slice(0, 10);

    const children = [];
    children.push(heading2Block('요약'));
    children.push(paragraphBlock(summary || '(요약 없음)'));

    if (keyPoints.length) {
      children.push(heading2Block('주요 논의사항'));
      keyPoints.forEach((p) => children.push(bulletBlock(p)));
    }

    if (actionItems.length) {
      children.push(heading2Block('액션 아이템'));
      actionItems.forEach((a) => children.push(todoBlock(a)));
    }

    children.push(heading2Block('원문 전체'));
    chunkText(transcript, 1900).forEach((c) => children.push(paragraphBlock(c)));

    // Notion 데이터베이스의 제목/날짜 속성 이름. 데이터베이스에서 이 이름과
    // 정확히 일치하는 속성을 만들어야 합니다 (SETUP_NOTION.md 참고).
    const titleProp = env.NOTION_TITLE_PROPERTY || '이름';
    const dateProp = env.NOTION_DATE_PROPERTY || '날짜';

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
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({
        parent: { database_id: env.NOTION_DATABASE_ID },
        properties,
        children,
      }),
    });

    if (!notionRes.ok) {
      const errText = await notionRes.text();
      return jsonResponse({ error: 'Notion 저장이 실패했습니다.', detail: errText }, 502, headers);
    }

    const notionData = await notionRes.json();
    return jsonResponse({ ok: true, title, url: notionData.url }, 200, headers);
  },
};
