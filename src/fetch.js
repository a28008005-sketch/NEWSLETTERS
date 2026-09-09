// 기사 URL -> 워크시트 JSON 초안.
// 본문 추출은 세 단계로 시도한다. 앞 단계가 실패하면 다음으로 넘어간다.
//   1) JSON-LD 의 articleBody (가장 정확하다)
//   2) <article> 또는 <main> 안의 <p>
//   3) 문서 전체의 <p> 중 길이가 충분한 것
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const decode = (s) =>
  String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

const stripTags = (html) =>
  decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();

/** 페이지에서 광고·안내문처럼 본문이 아닌 문단을 걸러낸다. */
const NOISE = /^(share|advertisement|subscribe|sign up|log in|related|more from|photo|credit:|illustration)/i;

function usable(text) {
  if (text.length < 45) return false;
  if (NOISE.test(text)) return false;
  // 페이지 아래쪽 '다른 기사' 카드는 본문을 잘라서 말줄임표로 끝난다.
  // 본문 문단은 이렇게 끝나지 않으므로 이것만으로 충분히 걸러진다.
  if (/(…|\.\.\.)\s*$/.test(text)) return false;
  return /[.!?]/.test(text);
}

function fromJsonLd(html) {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, raw] of blocks) {
    let data;
    try {
      data = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    const nodes = [];
    const walk = (n) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (n && typeof n === 'object') {
        nodes.push(n);
        if (n['@graph']) walk(n['@graph']);
      }
    };
    walk(data);
    for (const n of nodes) {
      if (typeof n.articleBody === 'string' && n.articleBody.trim().length > 120) {
        const paragraphs = decode(n.articleBody)
          .split(/\n{2,}|\r\n{2,}/)
          .map((p) => p.replace(/\s+/g, ' ').trim())
          .filter(usable);
        if (paragraphs.length) {
          return { headline: decode(n.headline || n.name || ''), paragraphs, via: 'JSON-LD' };
        }
      }
    }
  }
  return null;
}

function paragraphsIn(html) {
  return [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(([, inner]) => stripTags(inner))
    .filter(usable);
}

function fromContainer(html) {
  for (const re of [/<article\b[^>]*>([\s\S]*?)<\/article>/i, /<main\b[^>]*>([\s\S]*?)<\/main>/i]) {
    const m = html.match(re);
    if (!m) continue;
    const paragraphs = paragraphsIn(m[1]);
    if (paragraphs.length >= 2) return { paragraphs, via: re.source.includes('article') ? '<article>' : '<main>' };
  }
  return null;
}

function headlineOf(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return decode(og[1]).trim();
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return stripTags(h1[1]);
  const t = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return t ? stripTags(t[1]).replace(/\s*[|\-–]\s*[^|\-–]*$/, '').trim() : '';
}

const LEVEL_FROM_PATH = { k1: 'K1', g2: 'G2', g34: 'G3-4', g56: 'G5-6' };

export function slugOf(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const last = parts[parts.length - 1] || 'article';
  return last.replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').toLowerCase();
}

export async function fetchArticle(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`기사를 받지 못했습니다 (${res.status}) ${url}`);
  const html = await res.text();

  const found = fromJsonLd(html) || fromContainer(html) || { paragraphs: paragraphsIn(html), via: '문서 전체' };
  if (!found.paragraphs.length) {
    throw new Error(`본문 문단을 찾지 못했습니다. 페이지 구조가 예상과 다릅니다: ${url}`);
  }

  const level = LEVEL_FROM_PATH[new URL(url).pathname.split('/').filter(Boolean)[0]?.toLowerCase()] || null;

  return {
    slug: slugOf(url),
    headline: found.headline || headlineOf(html),
    paragraphs: found.paragraphs,
    level,
    via: found.via,
    url,
  };
}

/** 초안 JSON 을 만든다. 문항은 비워 두고 사람이 채운다. */
export function draftFrom(article) {
  return {
    id: article.slug,
    title: article.headline,
    level: article.level || 'K1',
    topic: 'Science',
    date: new Date().toISOString().slice(0, 10),
    status: '진행중',
    sourceUrl: article.url,
    note: '',
    article: {
      paragraphs: article.paragraphs,
      credit: `출처: ${article.url}`,
    },
    vocabulary: [],
    questions: [],
    writing: null,
  };
}

export function writeDraft(article, dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${article.slug}.json`);
  writeFileSync(path, JSON.stringify(draftFrom(article), null, 2) + '\n', 'utf8');
  return path;
}
