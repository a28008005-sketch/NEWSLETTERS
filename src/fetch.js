// 기사 URL -> 워크시트 JSON 초안.
// 본문 추출은 세 단계로 시도한다. 앞 단계가 실패하면 다음으로 넘어간다.
//   1) JSON-LD 의 articleBody (가장 정확하다)
//   2) <article> 또는 <main> 안의 <p>
//   3) 문서 전체의 <p> 중 길이가 충분한 것
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sniffAudio } from './audio.js';

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

// ---------- 사진 ----------
// 로고, 아이콘, 추적용 1px 이미지처럼 본문 사진이 아닌 것들을 걸러낸다.
const IMG_NOISE = /(logo|icon|sprite|avatar|placeholder|pixel|spacer|1x1|badge|favicon)/i;

/** srcset 이 있으면 가장 큰 후보를 고른다. 인쇄용이라 해상도가 높을수록 좋다. */
function bestFromSrcset(srcset) {
  const candidates = srcset
    .split(',')
    .map((part) => part.trim().split(/\s+/))
    .map(([url, size]) => ({ url, w: size && size.endsWith('w') ? parseInt(size) : 0 }))
    .filter((c) => c.url);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.w - a.w);
  return candidates[0].url;
}

/**
 * 본문이 끝나고 '다른 기사' 목록이 시작되는 지점을 찾는다.
 * 그 목록의 문단은 잘려서 말줄임표로 끝나므로, 첫 말줄임표 문단이 곧 경계다.
 * 문단을 걸러낼 때 이미 검증한 신호라 사진에도 그대로 쓸 수 있다.
 */
function bodyOnly(region) {
  for (const m of region.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = stripTags(m[1]);
    if (text.length >= 45 && /(…|\.\.\.)\s*$/.test(text)) {
      return region.slice(0, m.index);
    }
  }
  return region;
}

function imageRefs(html, baseUrl) {
  const scope = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const region = bodyOnly(scope ? scope[1] : html);

  const out = [];
  const seen = new Set();
  for (const [tag] of region.matchAll(/<img\b[^>]*>/gi)) {
    const srcset = tag.match(/\bsrcset=["']([^"']+)["']/i);
    const src = tag.match(/\bsrc=["']([^"']+)["']/i);
    const raw = (srcset && bestFromSrcset(srcset[1])) || (src && src[1]);
    if (!raw || raw.startsWith('data:')) continue;
    if (IMG_NOISE.test(raw)) continue;

    let abs;
    try {
      abs = new URL(raw, baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(abs)) continue;
    seen.add(abs);

    const alt = tag.match(/\balt=["']([^"']*)["']/i);
    out.push({ url: abs, alt: alt ? decode(alt[1]).trim() : '' });
  }
  return out;
}

/**
 * 이 사이트는 기사 사진을 한 번에 올리기 때문에 파일 이름 앞부분이 같다.
 * 예) K1_260501_cover_hero.jpg, K1_260501_many_kinds.jpg
 * 첫 사진과 앞부분이 다른 것은 다른 기사의 사진으로 보고 뺀다.
 * 완벽하지는 않아서, 초안을 사람이 한 번 보도록 되어 있다.
 */
function sameArticleOnly(refs) {
  if (refs.length < 2) return refs;
  const groupOf = (url) => {
    const base = decodeURIComponent(url.split('/').pop().split('?')[0]);
    const parts = base.split('_');
    return parts.length >= 2 ? `${parts[0]}_${parts[1]}` : base;
  };
  const first = groupOf(refs[0].url);
  return refs.filter((r) => groupOf(r.url) === first);
}

// ---------- 음원 ----------
// 기사 페이지의 '듣기' 음원을 찾는다. 못 찾으면 기사 주소를 그대로 쓴다.
// 기사 페이지에 듣기 버튼이 있으므로 그 편이 빈 QR 보다 낫다.
function audioUrl(html, baseUrl) {
  const patterns = [
    /<audio\b[^>]*\bsrc=["']([^"']+)["']/i,
    /<audio\b[^>]*>[\s\S]{0,400}?<source\b[^>]*\bsrc=["']([^"']+)["']/i,
    /["'](https?:\/\/[^"']+\.(?:mp3|m4a|aac|ogg))["']/i,
    /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>[^<]*(?:listen|audio|음원|듣기)/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      try {
        return { url: new URL(m[1], baseUrl).toString() };
      } catch {
        /* 다음 패턴으로 */
      }
    }
  }
  return null;
}

/**
 * 음원 주소를 찾는다.
 * HTML 에 적혀 있으면 그대로 쓰고, 없으면 페이지를 띄워 통신을 들여다본다.
 * 그래도 없으면 기사 주소로 돌아간다. 빈 QR 보다는 듣기 버튼이 있는 페이지가 낫다.
 */
async function resolveAudio(html, baseUrl, log = () => {}) {
  const inHtml = audioUrl(html, baseUrl);
  if (inHtml) return { url: inHtml.url, found: true, via: 'HTML' };

  try {
    const sniffed = await sniffAudio(baseUrl, { log });
    if (sniffed.length) return { url: sniffed[0], found: true, via: '브라우저 통신' };
  } catch (e) {
    log(`음원 탐색 실패: ${e.message}`);
  }
  return { url: baseUrl, found: false, via: '없음 (기사 주소로 대체)' };
}

const LEVEL_FROM_PATH = { k1: 'K1', g2: 'G2', g34: 'G3-4', g56: 'G5-6' };

export function slugOf(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const last = parts[parts.length - 1] || 'article';
  return last.replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').toLowerCase();
}

export async function fetchArticle(url, { log = () => {} } = {}) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`기사를 받지 못했습니다 (${res.status}) ${url}`);
  const html = await res.text();

  const found = fromJsonLd(html) || fromContainer(html) || { paragraphs: paragraphsIn(html), via: '문서 전체' };
  if (!found.paragraphs.length) {
    throw new Error(`본문 문단을 찾지 못했습니다. 페이지 구조가 예상과 다릅니다: ${url}`);
  }

  const level = LEVEL_FROM_PATH[new URL(url).pathname.split('/').filter(Boolean)[0]?.toLowerCase()] || null;
  const images = sameArticleOnly(imageRefs(html, url)).slice(0, 6);
  const audio = await resolveAudio(html, url, log);

  return {
    slug: slugOf(url),
    headline: found.headline || headlineOf(html),
    paragraphs: found.paragraphs,
    level,
    via: found.via,
    images,
    audio,
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
    audioUrl: article.audio.url,
    article: {
      paragraphs: article.paragraphs,
      images: article.images || [],
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
