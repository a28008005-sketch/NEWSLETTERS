// 워크시트 JSON -> 자체 완결형 HTML (CSS 를 안에 심어 파일 하나로 끝낸다)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { qrSvg } from './qr.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, '..', 'templates', 'worksheet.css'), 'utf8');

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const CHOICE_LABEL = ['A', 'B', 'C', 'D', 'E'];

export const KINDS = {
  article:   { key: '원문',   label: 'READING PASSAGE', suffix: 'article' },
  worksheet: { key: '워크시트', label: 'WORKSHEET',       suffix: 'worksheet' },
  answers:   { key: '정답지',  label: 'ANSWER KEY',       suffix: 'answers' },
};

/** 화면에 무엇을 보일지. 지정하지 않으면 지금까지처럼 모두 보인다. */
function show(ws) {
  return { date: true, credit: true, ...(ws.display || {}) };
}

function head(ws, kind) {
  const k = KINDS[kind];
  const d = show(ws);
  return `<header class="sheet-head">
  <div>
    <div class="kind">${k.label}</div>
    <h1>${esc(ws.title)}</h1>
  </div>
  <div class="meta">
    <span class="badge">${esc(ws.level)}</span> <span class="badge">${esc(ws.topic)}</span><br>
    ${d.date ? esc(ws.date || '') : ''}
  </div>
</header>`;
}

function nameBar() {
  return `<div class="namebar"><span><b>Name</b></span><span><b>Date</b></span><span><b>Score</b></span></div>`;
}

function foot(ws, kind) {
  const d = show(ws);
  return `<footer class="sheet-foot">
  <span>${esc(ws.title)} · ${esc(KINDS[kind].label)}</span>
  <span>${d.credit ? esc(ws.sourceUrl || '') : ''}</span>
</footer>`;
}

function page(ws, kind, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(ws.title)} - ${esc(KINDS[kind].key)}</title>
<style>${CSS}</style>
</head>
<body>
${head(ws, kind)}
${kind === 'article' ? '' : nameBar()}
${body}
${foot(ws, kind)}
</body>
</html>`;
}

// ---------- 원문 ----------
function figure(img, cls = 'shot') {
  const caption = img.alt ? `<figcaption>${esc(img.alt)}</figcaption>` : '';
  return `<figure class="${cls}"><img src="${img.dataUri}" alt="${esc(img.alt)}">${caption}</figure>`;
}

/** 음원 QR 띠. 아이가 휴대폰을 비추면 바로 들을 수 있게 기사 맨 위에 둔다. */
async function listenStrip(ws) {
  const target = ws.audioUrl || ws.sourceUrl;
  if (!target) return '';
  const svg = await qrSvg(target, { size: 108 });
  return `<div class="listen">
  <div class="qr">${svg}</div>
  <div class="listen-text">
    <b>음원 듣기 · Listen</b>
    <span class="how">휴대폰 카메라로 이 QR 을 비추면 기사를 읽어 주는 음원이 나옵니다.</span>
    ${show(ws).credit ? `<span class="addr">${esc(target)}</span>` : ''}
  </div>
</div>`;
}

/**
 * 소제목·문단·사진을 원문 순서대로 받아 잡지처럼 조판한다.
 * 첫 소제목 앞은 도입부와 표지 사진, 그 뒤는 소제목마다 한 덩어리.
 */
function renderBlocks(blocks) {
  const intro = [];
  const cards = [];
  let current = null;

  for (const b of blocks) {
    if (b.type === 'heading') {
      current = { heading: b.text, image: null, texts: [] };
      cards.push(current);
      continue;
    }
    if (!current) {
      intro.push(b);
    } else if (b.type === 'image' && !current.image) {
      current.image = b;
    } else if (b.type === 'text') {
      current.texts.push(b.text);
    }
  }

  const introText = intro.filter((b) => b.type === 'text').map((b) => `<p>${esc(b.text)}</p>`).join('\n');
  const cover = intro.find((b) => b.type === 'image');

  const html = [];
  if (introText) html.push(`<div class="lede">${introText}</div>`);
  if (cover) {
    html.push(`<figure class="cover"><img src="${cover.dataUri || cover.url}" alt="${esc(cover.alt)}">` +
      (cover.alt ? `<figcaption>${esc(cover.alt)}</figcaption>` : '') + `</figure>`);
  }
  if (cards.length) {
    const cells = cards.map((c) => {
      const img = c.image ? `<img src="${c.image.dataUri || c.image.url}" alt="${esc(c.image.alt)}">` : '';
      const body = c.texts.map((t) => `<p>${esc(t)}</p>`).join('\n');
      return `<div class="card"><h3>${esc(c.heading)}</h3>${img}${body}</div>`;
    });
    html.push(`<div class="sections">${cells.join('\n')}</div>`);
  }
  return html.join('\n');
}

async function renderArticle(ws) {
  const a = ws.article || {};

  // 소제목까지 있는 새 방식. 없으면 예전 방식 그대로 그린다.
  if (a.blocks?.length) {
    const credit = show(ws).credit && a.credit ? `<p class="credit">${esc(a.credit)}</p>` : '';
    return page(ws, 'article', (await listenStrip(ws)) +
      `<section class="article">\n${renderBlocks(a.blocks)}\n${credit}\n</section>`);
  }

  const paragraphs = a.paragraphs || [];
  const images = a.images || [];

  // 첫 문단은 도입부, 첫 사진은 표지 사진이라 각각 전체 너비로 둔다.
  // 그 뒤 문단들은 사진 설명이므로 글과 사진을 나란히 놓아야 읽힌다.
  const blocks = [];
  if (paragraphs[0]) blocks.push(`<p class="lead">${esc(paragraphs[0])}</p>`);
  if (images[0]) blocks.push(figure(images[0], 'shot hero'));

  for (let i = 1; i < paragraphs.length; i++) {
    const para = `<p>${esc(paragraphs[i])}</p>`;
    blocks.push(images[i] ? `<div class="pair">${para}${figure(images[i])}</div>` : para);
  }

  const leftover = images.slice(Math.max(paragraphs.length, 1));
  if (leftover.length) {
    blocks.push(`<div class="shot-grid">${leftover.map((im) => figure(im)).join('')}</div>`);
  }

  const credit = show(ws).credit && a.credit ? `<p class="credit">${esc(a.credit)}</p>` : '';
  return page(ws, 'article', (await listenStrip(ws)) + `<section class="article">
${blocks.join('\n')}
${credit}
</section>`);
}

// ---------- 문항 공통 ----------
function renderQuestion(q, withAnswer) {
  const text = `<div class="q-text">${esc(q.q)}</div>`;
  if (q.type === 'mc') {
    const list = q.choices || [];
    const choices = list
      .map((c, i) => {
        const chosen = withAnswer && i === q.answer;
        return `<li${chosen ? ' class="answer"' : ''}>${CHOICE_LABEL[i]}. ${esc(c)}${chosen ? ' &nbsp;&#10004;' : ''}</li>`;
      })
      .join('\n');
    // 보기가 모두 짧을 때만 한 줄로. 길면 줄바꿈이 지저분해진다.
    const inline = list.every((c) => String(c).length <= 20);
    return `${text}<ul class="choices${inline ? ' inline' : ''}">\n${choices}\n</ul>`;
  }
  // 서술형·단답형
  const lines = q.lines || 2;
  if (withAnswer) {
    return `${text}<div class="answer">${esc(q.answer)}</div>` +
      (q.note ? `<div class="answer-note">${esc(q.note)}</div>` : '');
  }
  return text + Array.from({ length: lines }, () => '<div class="answer-line"></div>').join('\n');
}

function questionSections(ws, withAnswer) {
  const out = [];

  const vocab = ws.vocabulary || [];
  if (vocab.length) {
    const rows = vocab
      .map((v) =>
        `<tr><td class="word">${esc(v.word)}</td><td class="${withAnswer ? '' : 'blank'}">${
          withAnswer ? `<span class="answer">${esc(v.meaning)}</span>` : ''
        }</td></tr>`
      )
      .join('\n');
    out.push(`<section>
  <h2>Vocabulary <small>낱말의 뜻을 적어 보세요</small></h2>
  <table class="vocab">
    <tr><th>Word</th><th>Meaning</th></tr>
${rows}
  </table>
</section>`);
  }

  const qs = ws.questions || [];
  if (qs.length) {
    const items = qs.map((q) => `<li>${renderQuestion(q, withAnswer)}</li>`).join('\n');
    out.push(`<section>
  <h2>Comprehension <small>기사를 읽고 답해 보세요</small></h2>
  <ol class="questions">
${items}
  </ol>
</section>`);
  }

  const w = ws.writing;
  if (w) {
    const body = withAnswer
      ? `<div class="q-text">${esc(w.prompt)}</div><div class="answer-note">${esc(
          w.sample || '학생마다 답이 다를 수 있습니다. 기사 내용을 근거로 썼는지 확인해 주세요.'
        )}</div>`
      : `<div class="q-text">${esc(w.prompt)}</div><div class="writing-lines">` +
        Array.from({ length: w.lines || 4 }, () => '<div class="answer-line"></div>').join('\n') +
        '</div>';
    out.push(`<section>
  <h2>Writing <small>내 생각을 문장으로 써 보세요</small></h2>
  ${body}
</section>`);
  }

  return out.join('\n');
}

function renderWorksheet(ws) {
  return page(ws, 'worksheet', questionSections(ws, false));
}

function renderAnswers(ws) {
  const banner = `<div class="key-banner">교사·학부모용 정답지입니다. 학생용 워크시트와 문항 순서가 같습니다.</div>`;
  return page(ws, 'answers', banner + questionSections(ws, true));
}

export async function render(ws, kind) {
  if (kind === 'article') return renderArticle(ws);
  if (kind === 'worksheet') return renderWorksheet(ws);
  if (kind === 'answers') return renderAnswers(ws);
  throw new Error(`알 수 없는 문서 종류: ${kind}`);
}
