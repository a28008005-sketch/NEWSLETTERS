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
  const made = {};
  for (const kind of Object.keys(KINDS)) {
    const htmlPath = join(OUT_DIR, `${ws.id}-${KINDS[kind].suffix}.html`);
    const pdfPath = join(OUT_DIR, `${ws.id}-${KINDS[kind].suffix}.pdf`);
    writeFileSync(htmlPath, render(ws, kind), 'utf8');
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

// ---------- 진입점 ----------
const [cmd, arg] = process.argv.slice(2);
const run = { doctor: cmdDoctor, build: cmdBuild, publish: cmdPublish }[cmd];
if (!run) {
  console.log(`사용법:
  node src/cli.js doctor              환경 점검 (Chrome·Notion 토큰·JSON 검사)
  node src/cli.js build   [경로|all]  PDF 3종 생성 (Notion 없이도 동작)
  node src/cli.js publish [경로|all]  생성 + Notion 파일 속성에 첨부`);
  process.exit(1);
}
run(arg).catch((e) => { console.error(`\n❌ ${e.message}\n`); process.exit(1); });
