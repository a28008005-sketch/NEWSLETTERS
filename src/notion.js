// Notion REST API 클라이언트.
// 브라우저 자동화 없이 공식 File Upload API 로 파일을 올리고
// 데이터베이스 행의 파일 속성(원문 / 워크시트 / 정답지)에 붙인다.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export const DEFAULT_DATABASE_ID = '3c8dc243-c7ea-4ebb-9956-508c1dc61c7c';

export class NotionError extends Error {}

function token() {
  const t = process.env.NOTION_TOKEN;
  if (!t) {
    throw new NotionError(
      'NOTION_TOKEN 이 없습니다. Notion 내부 통합(Internal Integration) 시크릿을 환경변수로 넣어주세요.\n' +
        '발급: https://www.notion.so/profile/integrations  (docs/SETUP.md 참고)'
    );
  }
  return t;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      'Notion-Version': NOTION_VERSION,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new NotionError(`Notion ${method} ${path} 실패 (${res.status}): ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

/** 통합이 연결됐는지, 어떤 봇인지 확인 */
export function whoami() {
  return api('/users/me');
}

/** 제목으로 데이터베이스 행을 찾는다. 정확히 일치하는 행 하나를 돌려준다. */
export async function findRowByTitle(databaseId, title) {
  const res = await api(`/databases/${databaseId}/query`, {
    method: 'POST',
    body: { filter: { property: 'Name', title: { equals: title } }, page_size: 5 },
  });
  if (!res.results?.length) {
    throw new NotionError(`"${title}" 제목의 행을 데이터베이스에서 찾지 못했습니다.`);
  }
  if (res.results.length > 1) {
    throw new NotionError(`"${title}" 제목의 행이 ${res.results.length}개입니다. 제목을 구분해 주세요.`);
  }
  return res.results[0];
}

/**
 * 파일 하나를 Notion 에 올린다.
 * 1) file_uploads 생성 -> 2) 받은 URL 로 실제 바이트 전송
 * 20MiB 이하 단일 업로드 기준.
 */
export async function uploadFile(filePath, contentType = 'application/pdf') {
  const filename = basename(filePath);
  const created = await api('/file_uploads', {
    method: 'POST',
    body: { filename, content_type: contentType },
  });

  const form = new FormData();
  form.append('file', new Blob([readFileSync(filePath)], { type: contentType }), filename);

  const sendUrl = created.upload_url || `${API}/file_uploads/${created.id}/send`;
  const res = await fetch(sendUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${token()}`, 'Notion-Version': NOTION_VERSION },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new NotionError(`파일 전송 실패 (${res.status}) ${filename}: ${text.slice(0, 500)}`);
  }
  const done = JSON.parse(text);
  if (done.status && done.status !== 'uploaded') {
    throw new NotionError(`업로드가 끝나지 않았습니다 (${done.status}): ${filename}`);
  }
  return { id: created.id, filename };
}

/**
 * 올린 파일들을 페이지의 파일 속성에 건다.
 * uploads: { '워크시트': {id, filename}, ... }
 */
export function attachFiles(pageId, uploads) {
  const properties = {};
  for (const [prop, up] of Object.entries(uploads)) {
    properties[prop] = {
      files: [{ type: 'file_upload', file_upload: { id: up.id }, name: up.filename }],
    };
  }
  return api(`/pages/${pageId}`, { method: 'PATCH', body: { properties } });
}

/** 메타데이터(레벨·주제·날짜·상태·메모·원문 URL)를 JSON 기준으로 맞춰 준다. */
export function syncMeta(pageId, ws) {
  const properties = {};
  if (ws.level) properties['레벨'] = { select: { name: ws.level } };
  if (ws.topic) properties['주제'] = { select: { name: ws.topic } };
  if (ws.date) properties['날짜'] = { date: { start: ws.date } };
  if (ws.note) properties['메모'] = { rich_text: [{ text: { content: ws.note } }] };
  if (ws.sourceUrl) properties['원문 URL'] = { url: ws.sourceUrl };
  properties['상태'] = { select: { name: ws.status || '완성' } };
  return api(`/pages/${pageId}`, { method: 'PATCH', body: { properties } });
}

/** 행이 없으면 새로 만든다. */
export async function createRow(databaseId, ws) {
  return api('/pages', {
    method: 'POST',
    body: {
      parent: { database_id: databaseId },
      properties: { Name: { title: [{ text: { content: ws.title } }] } },
    },
  });
}
