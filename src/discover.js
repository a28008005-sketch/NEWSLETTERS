// 어떤 레벨의 기사 목록을 받아, 아직 만들지 않은 것을 골라 준다.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const SITE = 'https://www.timeforkids.com';

// 노션의 레벨 이름과 사이트의 주소 조각을 잇는다.
export const LEVEL_PATHS = {
  K1: ['k1'],
  G2: ['g2'],
  'G3-4': ['g34', 'g3'],
  'G5-6': ['g56', 'g5'],
};

/** 문장에서 레벨을 읽어낸다. "K레벨", "케이", "G2" 같은 표현을 받아 준다. */
export function levelFromText(text = '') {
  const t = String(text).toUpperCase().replace(/\s/g, '');
  if (/G5|G6|5-6|5~6/.test(t)) return 'G5-6';
  if (/G3|G4|3-4|3~4/.test(t)) return 'G3-4';
  if (/G2|지투/.test(t)) return 'G2';
  if (/K1|K레벨|케이레벨|K\b|유치|KINDER/.test(t) || /K/.test(t)) return 'K1';
  return null;
}

/** 목록 페이지에서 기사 주소를 뽑는다. */
function articleLinks(html, seg) {
  const re = new RegExp(`href=["'](?:${SITE})?(/${seg}/[a-z0-9-]+/?)["']`, 'gi');
  const out = new Set();
  for (const m of html.matchAll(re)) {
    const path = m[1].endsWith('/') ? m[1] : `${m[1]}/`;
    // 목록 자체나 분류 페이지는 건너뛴다.
    const slug = path.split('/').filter(Boolean)[1];
    if (!slug || slug.length < 4) continue;
    out.add(SITE + path);
  }
  return [...out];
}

/**
 * 해당 레벨에서 아직 쓰지 않은 기사 주소를 찾는다.
 * exclude 에는 이미 만든 기사 주소를 넣는다.
 */
export async function findUnusedArticles(level, exclude = [], { log = () => {} } = {}) {
  const segs = LEVEL_PATHS[level];
  if (!segs) throw new Error(`모르는 레벨입니다: ${level}`);

  const used = new Set(exclude.map((u) => String(u).replace(/\/+$/, '') + '/'));
  const found = [];

  for (const seg of segs) {
    const indexUrl = `${SITE}/${seg}/`;
    let html;
    try {
      const res = await fetch(indexUrl, { headers: { 'user-agent': UA, accept: 'text/html' } });
      if (!res.ok) {
        log(`목록을 받지 못했습니다 (${res.status}): ${indexUrl}`);
        continue;
      }
      html = await res.text();
    } catch (e) {
      log(`목록 요청 실패: ${indexUrl} (${e.message})`);
      continue;
    }

    const links = articleLinks(html, seg);
    log(`${indexUrl} 에서 기사 ${links.length}개 확인`);
    for (const url of links) {
      if (!used.has(url) && !found.includes(url)) found.push(url);
    }
    if (found.length) break;
  }

  return found;
}
