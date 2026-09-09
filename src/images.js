// 기사 사진을 내려받아 data URI 로 바꾼다.
// PDF 를 만드는 시점에 받아오므로 JSON 에는 주소만 남고 저장소가 가벼워진다.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const MIN_BYTES = 10 * 1024;   // 이보다 작으면 장식용 아이콘
const MAX_BYTES = 900 * 1024;  // 이보다 크면 인쇄물에 과하다

/**
 * refs: [{ url, alt }] -> [{ dataUri, alt, source }]
 * 받지 못한 사진은 조용히 빼되, 무엇을 못 받았는지는 돌려준다.
 */
export async function inlineImages(refs = [], { log = () => {} } = {}) {
  const kept = [];
  const failed = [];

  for (const ref of refs) {
    if (ref.dataUri) {
      // 이미 담겨 있는 사진도 원래 주소를 함께 돌려줘야
      // 호출한 쪽에서 어느 자리의 사진인지 찾을 수 있다.
      kept.push({ ...ref, source: ref.source || ref.url });
      continue;
    }
    try {
      const res = await fetch(ref.url, { headers: { 'user-agent': UA }, redirect: 'follow' });
      if (!res.ok) {
        failed.push(`${ref.url} (HTTP ${res.status})`);
        continue;
      }
      const type = (res.headers.get('content-type') || '').split(';')[0].trim();
      if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) {
        failed.push(`${ref.url} (이미지가 아님: ${type || '알 수 없음'})`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < MIN_BYTES || buf.length > MAX_BYTES) {
        failed.push(`${ref.url} (크기 ${Math.round(buf.length / 1024)}KB, 범위 밖)`);
        continue;
      }
      kept.push({ alt: ref.alt || '', dataUri: `data:${type};base64,${buf.toString('base64')}`, source: ref.url });
    } catch (e) {
      failed.push(`${ref.url} (${e.message})`);
    }
  }

  if (failed.length) {
    log(`사진 ${failed.length}장을 넣지 못했습니다:`);
    failed.forEach((f) => log(`  - ${f}`));
  }
  return kept;
}
