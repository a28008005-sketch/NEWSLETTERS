// HTML 파일 -> PDF. 헤드리스 Chrome 의 인쇄 엔진을 그대로 쓴다.
import { execFile } from 'node:child_process';
import { mkdtempSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { findChrome } from './chrome.js';

const run = promisify(execFile);

export async function htmlToPdf(htmlPath, pdfPath, { chromePath } = {}) {
  const chrome = chromePath || findChrome();
  const profile = mkdtempSync(join(tmpdir(), 'ws-chrome-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    `--user-data-dir=${profile}`,
    // 폰트·이미지 로딩과 레이아웃이 끝난 뒤 인쇄되도록 가상 시간을 준다
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=10000',
    '--no-pdf-header-footer',
    `--print-to-pdf=${resolve(pdfPath)}`,
    `file://${resolve(htmlPath)}`,
  ];

  try {
    await run(chrome, args, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    // Chrome 은 정상 인쇄 후에도 D-Bus 경고 등으로 0 이 아닌 코드를 낼 때가 있다.
    // 실제 성공 여부는 파일이 생겼는지로 판단한다.
    if (!existsSync(resolve(pdfPath))) {
      rmSync(profile, { recursive: true, force: true });
      throw new Error(`PDF 생성 실패 (${htmlPath}): ${err.stderr || err.message}`);
    }
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }

  const out = resolve(pdfPath);
  if (!existsSync(out) || statSync(out).size === 0) {
    throw new Error(`PDF 가 비어 있습니다: ${out}`);
  }
  return out;
}
