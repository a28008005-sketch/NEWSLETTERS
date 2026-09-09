#!/usr/bin/env node
// 영자신문 워크시트 파이프라인 CLI
//   node src/cli.js doctor
//   node src/cli.js build   [경로|all]
//   node src/cli.js publish [경로|all]
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { render, KINDS } from './render.js';
import { htmlToPdf } from './pdf.js';
import { findChrome } from './chrome.js';
import * as notion from './notion.js';
import { fetchArticle, writeDraft } from './fetch.js';
import { inlineImages } from './images.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data', 'worksheets');
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : join(ROOT, 'out');

const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => console.log(`  ❌ ${m}`);
const info = (m) => console.log(`  ·  ${m}`);

// ---------- 입력 검증 ----------
const LEVELS = ['K1', 'G2', 'G3-4', 'G5-6'];
const TOPICS = ['Space', 'Science', 'History', 'Animals', 'Environment', 'Sports',
                'Arts', 'Entertainment', 'Government', 'Business', 'Culture', 'Technology'];

function loadWorksheet(path) {
  const ws = JSON.parse(readFileSync(path, 'utf8'));
  const errs = [];
  if (!ws.id) errs.push('id 가 없습니다 (파일 이름에 쓰입니다)');
  if (!ws.title) errs.push('title 이 없습니다 (Notion 행 제목과 정확히 같아야 합니다)');
  if (ws.level && !LEVELS.includes(ws.level)) errs.push(`level 은 ${LEVELS.join(' / ')} 중 하나여야 합니다`);
  if (ws.topic && !TOPICS.includes(ws.topic)) errs.push(`topic 이 Notion 선택지에 없습니다: ${ws.topic}`);
  if (!ws.article?.paragraphs?.length) errs.push('article.paragraphs 가 비어 있습니다');
  (ws.questions || []).forEach((q, i) => {
    if (q.type === 'mc' && (q.answer == null || !q.choices?.[q.answer])) {
      errs.push(`questions[${i}] 객관식의 answer 가 choices 범위를 벗어납니다`);
    }
  });
  if (errs.length) {
    throw new Error(`${basename(path)} 형식 오류:\n    - ${errs.join('\n    - ')}`);
  }
  return ws;
}

function targets(arg) {
  if (!arg || arg === 'all') {
    if (!existsSync(DATA_DIR)) return [];
    return readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).map((f) => join(DATA_DIR, f)).sort();
  }
  const p = resolve(arg);
  if (!existsSync(p)) throw new Error(`파일을 찾을 수 없습니다: ${p}`);
  return statSync(p).isDirectory()
    ? readdirSync(p).filter((f) => f.endsWith('.json')).map((f) => join(p, f)).sort()
    : [p];
}

// ---------- build ----------
async function buildOne(path) {
  const ws = loadWorksheet(path);
  mkdirSync(OUT_DIR, { recursive: true });

  // 사진은 만들 때 받아온다. 못 받으면 그 사진만 빠지고 나머지는 그대로 나온다.
  const refs = ws.article?.images || [];
  if (refs.length) {
    const resolved = await inlineImages(refs, { log: (m) => info(m) });
    ws.article.images = resolved;
    info(`사진 ${resolved.length}/${refs.length}장 포함`);
  }

  const made = {};
  for (const kind of Object.keys(KINDS)) {
    const htmlPath = join(OUT_DIR, `${ws.id}-${KINDS[kind].suffix}.html`);
    const pdfPath = join(OUT_DIR, `${ws.id}-${KINDS[kind].suffix}.pdf`);
    writeFileSync(htmlPath, await render(ws, kind), 'utf8');
    await htmlToPdf(htmlPath, pdfPath);
    made[KINDS[kind].key] = pdfPath;
    info(`${basename(pdfPath)}  (${(statSync(pdfPath).size / 1024).toFixed(0)} KB)`);
  }
  return { ws, made };
}

async function cmdBuild(arg) {
  const files = targets(arg);
  if (!files.length) return console.log('만들 워크시트 JSON 이 없습니다. data/worksheets/ 에 파일을 넣어주세요.');
  for (const f of files) {
    console.log(`\n📄 ${basename(f)}`);
    const { ws } = await buildOne(f);
    ok(`${ws.title} — PDF 3종 생성 완료`);
  }
  console.log(`\n결과물: ${OUT_DIR}`);
}

// ---------- publish ----------
async function cmdPublish(arg) {
  const dbId = process.env.NOTION_DATABASE_ID || notion.DEFAULT_DATABASE_ID;
  const files = targets(arg);
  if (!files.length) return console.log('올릴 워크시트 JSON 이 없습니다.');

  for (const f of files) {
    console.log(`\n📄 ${basename(f)}`);
    const { ws, made } = await buildOne(f);

    let row;
    try {
      row = await notion.findRowByTitle(dbId, ws.title);
    } catch (e) {
      if (process.env.CREATE_MISSING_ROWS === '1') {
        info(`행이 없어 새로 만듭니다: ${ws.title}`);
        row = await notion.createRow(dbId, ws);
      } else {
        throw e;
      }
    }

    const uploads = {};
    for (const [prop, pdfPath] of Object.entries(made)) {
      uploads[prop] = await notion.uploadFile(pdfPath);
      info(`업로드 · ${prop} ← ${basename(pdfPath)}`);
    }
    await notion.attachFiles(row.id, uploads);
    await notion.syncMeta(row.id, ws);
    ok(`${ws.title} — Notion 첨부 완료  ${row.url || ''}`);
  }
}

// ---------- doctor ----------
async function cmdDoctor() {
  let fail = 0;
  console.log('\n🔎 환경 점검\n');

  const major = Number(process.versions.node.split('.')[0]);
  major >= 18 ? ok(`Node ${process.versions.node}`) : (bad(`Node 18 이상이 필요합니다 (현재 ${process.versions.node})`), fail++);

  try { ok(`Chrome: ${findChrome()}`); } catch (e) { bad(e.message); fail++; }

  console.log('');
  if (!process.env.NOTION_TOKEN) {
    bad('NOTION_TOKEN 없음 — build 는 되지만 publish 는 안 됩니다 (docs/SETUP.md)');
    fail++;
  } else {
    try {
      const me = await notion.whoami();
      ok(`Notion 연결: ${me.name || me.bot?.owner?.type || me.id}`);
      const dbId = process.env.NOTION_DATABASE_ID || notion.DEFAULT_DATABASE_ID;
      const probe = await notion.findRowByTitle(dbId, '__존재하지_않는_행__').catch((e) => e);
      if (probe instanceof notion.NotionError && probe.message.includes('찾지 못했습니다')) {
        ok(`데이터베이스 접근 가능: ${dbId}`);
      } else if (probe instanceof Error) {
        bad(`데이터베이스에 접근할 수 없습니다. 통합을 DB 에 연결했는지 확인하세요.\n     ${probe.message}`);
        fail++;
      }
    } catch (e) { bad(e.message); fail++; }
  }

  console.log('');
  const files = targets('all');
  if (!files.length) info('data/worksheets/ 에 JSON 이 없습니다.');
  for (const f of files) {
    try { const ws = loadWorksheet(f); ok(`${basename(f)} → "${ws.title}" (${ws.level}/${ws.topic})`); }
    catch (e) { bad(e.message); fail++; }
  }

  console.log(fail === 0 ? '\n문제 없습니다. publish 를 바로 돌려도 됩니다.\n' : `\n${fail}건을 먼저 해결해 주세요.\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

// ---------- fetch ----------
// 기사 URL 에서 본문을 받아 초안 JSON 을 만든다.
// 문항은 사람이 채워야 하므로 drafts/ 에 두고, build/publish 대상에는 넣지 않는다.
async function cmdFetch(url) {
  if (!url) throw new Error('기사 URL 을 함께 적어주세요. 예) node src/cli.js fetch https://...');

  const article = await fetchArticle(url, { log: (m) => info(m) });
  const draftDir = join(ROOT, 'drafts');
  const path = writeDraft(article, draftDir);

  ok(`본문을 받았습니다 · 문단 ${article.paragraphs.length}개 (추출 경로: ${article.via})`);
  info(`제목: ${article.headline}`);
  info(`레벨 추정: ${article.level || '알 수 없음 (직접 지정 필요)'}`);
  info(`음원: ${article.audio.url}  [${article.audio.via}]`);
  info(`초안 파일: ${path}`);

  // 추출이 제대로 됐는지 사람이 눈으로 확인할 수 있도록 그대로 출력한다.
  console.log('\n───────── 받아온 본문 ─────────');
  console.log(article.headline);
  console.log('');
  article.paragraphs.forEach((para, i) => console.log(`[${i + 1}] ${para}\n`));
  console.log('──────────────────────────────');
  console.log('\n본문이 이상하면 초안을 고쳐 주세요. 문항과 단어를 채운 뒤');
  console.log('data/worksheets/ 로 옮기면 publish 대상이 됩니다.\n');
}

// ---------- verify ----------
// 노션 쪽 연결을 끝까지 확인한다.
// 업로드까지 실제로 해보되, 어디에도 붙이지 않는다.
// 붙이지 않은 업로드는 노션이 알아서 만료시키므로 작업 공간이 더러워지지 않는다.
async function cmdVerify() {
  const dbId = process.env.NOTION_DATABASE_ID || notion.DEFAULT_DATABASE_ID;
  let fail = 0;
  console.log('\n🔎 Notion 연결 확인\n');

  try {
    const me = await notion.whoami();
    ok(`토큰 유효 · 통합 이름: ${me.name || me.id}`);
  } catch (e) {
    bad(e.message);
    console.log('\n토큰이 잘못됐거나 만료됐습니다. docs/SETUP.md 1단계를 확인해 주세요.\n');
    process.exitCode = 1;
    return;
  }

  let rows = [];
  try {
    rows = await notion.listRows(dbId);
    ok(`데이터베이스 접근 성공 · 행 ${rows.length}개`);
  } catch (e) {
    bad(`데이터베이스에 접근할 수 없습니다: ${e.message}`);
    console.log('\n대부분 통합을 데이터베이스에 연결하지 않아서 생깁니다. docs/SETUP.md 2단계를 확인해 주세요.\n');
    process.exitCode = 1;
    return;
  }

  if (rows.length) {
    console.log('\n  현재 첨부 상태');
    for (const r of rows) {
      const marks = ['원문', '워크시트', '정답지'].map((k) => `${k}:${r.files[k] ? '있음' : '없음'}`);
      console.log(`    · ${r.title.padEnd(24)} ${marks.join('  ')}`);
    }
  }

  console.log('');
  try {
    const files = targets('all');
    if (!files.length) {
      info('업로드 시험에 쓸 JSON 이 없어 건너뜁니다.');
    } else {
      const ws = loadWorksheet(files[0]);
      mkdirSync(OUT_DIR, { recursive: true });
      const htmlPath = join(OUT_DIR, `${ws.id}-verify.html`);
      const pdfPath = join(OUT_DIR, `${ws.id}-verify.pdf`);
      writeFileSync(htmlPath, await render(ws, 'worksheet'), 'utf8');
      await htmlToPdf(htmlPath, pdfPath);
      const up = await notion.uploadFile(pdfPath);
      ok(`파일 업로드 성공 · ${up.filename} (id ${up.id})`);
      info('이 파일은 어디에도 붙이지 않았습니다. 노션이 만료 처리하니 지우실 필요 없습니다.');
    }
  } catch (e) {
    bad(`업로드 실패: ${e.message}`);
    fail++;
  }

  console.log(
    fail === 0
      ? '\n연결과 업로드 모두 정상입니다. publish 를 돌리면 실제로 첨부됩니다.\n'
      : `\n${fail}건을 해결해야 합니다.\n`
  );
  process.exitCode = fail === 0 ? 0 : 1;
}

// ---------- 진입점 ----------
const [cmd, arg] = process.argv.slice(2);
const run = { doctor: cmdDoctor, verify: cmdVerify, fetch: cmdFetch, build: cmdBuild, publish: cmdPublish }[cmd];
if (!run) {
  console.log(`사용법:
  node src/cli.js doctor              환경 점검 (Chrome·Notion 토큰·JSON 검사)\n  node src/cli.js verify              Notion 연결과 업로드까지 실제로 확인 (아무것도 첨부하지 않음)
  node src/cli.js fetch   <기사 URL>  기사 본문을 받아 초안 JSON 생성 (drafts/)\n  node src/cli.js build   [경로|all]  PDF 3종 생성 (Notion 없이도 동작)
  node src/cli.js publish [경로|all]  생성 + Notion 파일 속성에 첨부`);
  process.exit(1);
}
run(arg).catch((e) => { console.error(`\n❌ ${e.message}\n`); process.exit(1); });
