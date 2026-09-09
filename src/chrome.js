// Chrome/Chromium 실행 파일을 찾는다.
// UI 자동화(드래그·클릭)가 아니라 --headless --print-to-pdf 만 쓰기 때문에
// 사용자가 평소 쓰는 Chrome 이 그대로 인쇄 엔진이 된다.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ],
};

// Playwright 가 설치한 Chromium (CI·컨테이너에서 흔함)
function playwrightChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return null;
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith('chromium-'))
    .sort()
    .reverse();
  for (const d of dirs) {
    for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = join(root, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export function findChrome() {
  // 1순위: 사용자가 직접 지정한 경로
  if (process.env.CHROME_PATH) {
    if (!existsSync(process.env.CHROME_PATH)) {
      throw new Error(`CHROME_PATH 가 가리키는 파일이 없습니다: ${process.env.CHROME_PATH}`);
    }
    return process.env.CHROME_PATH;
  }
  const found = (CANDIDATES[process.platform] || CANDIDATES.linux).find((p) => existsSync(p));
  if (found) return found;

  const pw = playwrightChromium();
  if (pw) return pw;

  throw new Error(
    'Chrome 을 찾지 못했습니다. Chrome 을 설치했거나 다른 경로에 있다면 CHROME_PATH 환경변수로 알려주세요.\n' +
      '예) export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"'
  );
}
