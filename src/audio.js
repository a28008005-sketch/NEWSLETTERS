// 기사 페이지의 음원 파일 주소를 찾아낸다.
//
// 이 사이트는 음원을 HTML 에 적어두지 않고 자바스크립트로 나중에 불러온다.
// 그래서 헤드리스 Chrome 으로 페이지를 실제로 띄우고, 오가는 통신을 들여다본다.
// 재생 버튼을 눌러야 비로소 파일을 받아오는 경우가 많아 버튼도 눌러 본다.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome } from './chrome.js';

const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|opus|wav)(\?|$)/i;
const AUDIO_MIME = /^audio\//i;

/** Chrome 이 stderr 에 찍는 DevTools 주소를 기다린다. */
function waitForDevtools(proc, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome DevTools 주소를 받지 못했습니다.')), timeoutMs);
    proc.stderr.on('data', (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome 이 먼저 종료됐습니다 (code ${code})`));
    });
  });
}

/**
 * 페이지를 띄워 음원 주소를 수집한다.
 * 찾은 주소들을 발견 순서대로 돌려준다. 없으면 빈 배열.
 */
export async function sniffAudio(pageUrl, { waitMs = 9000, log = () => {} } = {}) {
  const chrome = findChrome();
  const profile = mkdtempSync(join(tmpdir(), 'ws-sniff-'));
  const proc = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    'about:blank',
  ]);

  const found = [];
  const seen = new Set();
  const keep = (url, why) => {
    if (!url || found.includes(url)) return;
    found.push(url);
    log(`음원 발견 (${why}): ${url}`);
  };
  // 확장자로 알아보는 경우
  const addByExt = (url) => {
    if (url && AUDIO_EXT.test(url)) keep(url, '확장자');
  };
  // 확장자가 없는 스트리밍 주소는 응답 종류로만 알 수 있다
  const addByMime = (url, mime) => {
    if (url && AUDIO_MIME.test(mime || '')) keep(url, `형식 ${mime}`);
  };
  // 못 찾았을 때 무엇이 오갔는지 볼 수 있도록 후보를 모아 둔다
  const candidates = [];
  const note = (url) => {
    if (url && !seen.has(url) && /audio|listen|speech|voice|tts|media|\.mp3|\.m4a/i.test(url)) {
      seen.add(url);
      candidates.push(url);
    }
  };

  let ws;
  try {
    const wsUrl = await waitForDevtools(proc);
    ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('DevTools 연결 실패'));
    });

    let id = 0;
    const send = (method, params = {}, sessionId) =>
      ws.send(JSON.stringify({ id: ++id, method, params, ...(sessionId ? { sessionId } : {}) }));

    // 재생기가 iframe 안에 있는 경우가 있어 붙는 세션을 모두 들고 있어야 한다.
    const sessions = new Set();
    let pageSession = null;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);

      if (msg.method === 'Target.attachedToTarget') {
        const sid = msg.params.sessionId;
        sessions.add(sid);
        send('Network.enable', {}, sid);
        send('Page.enable', {}, sid);
        if (!pageSession) {
          pageSession = sid;
          send('Page.navigate', { url: pageUrl }, sid);
        } else {
          log(`하위 프레임 감지: ${msg.params.targetInfo?.url || '(주소 없음)'}`);
        }
        return;
      }
      const p = msg.params || {};
      if (msg.method === 'Network.requestWillBeSent') {
        addByExt(p.request?.url);
        note(p.request?.url);
      }
      if (msg.method === 'Network.responseReceived') {
        addByExt(p.response?.url);
        addByMime(p.response?.url, p.response?.mimeType);
        note(p.response?.url);
      }
      // 버튼을 눌러 본 결과를 그대로 남긴다. 아무것도 못 찾았다는 사실도 단서다.
      if (msg.result?.result && 'value' in msg.result.result) {
        log(`프레임 조사 결과: ${msg.result.result.value || '(해당 요소 없음)'}`);
      }
    };

    send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    send('Target.createTarget', { url: 'about:blank' });

    await sleep(waitMs);

    // 재생 버튼을 눌러야 파일을 받아오는 경우가 있다.
    // 최상위 문서와 모든 하위 프레임에서 눌러 본다.
    for (const sid of sessions) {
      send('Runtime.evaluate', {
        expression: `(() => {
          const hit = [];
          for (const el of document.querySelectorAll('button, a, [role=button], [class*=listen i], [class*=audio i], [class*=play i]')) {
            const label = ((el.textContent || '') + ' ' + (el.className || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
            if (/listen|audio|play/.test(label)) { try { el.click(); hit.push(label.trim().slice(0, 40)); } catch (e) {} }
          }
          for (const a of document.querySelectorAll('audio, audio source')) { if (a.src) hit.push('SRC:' + a.src); }
          for (const f of document.querySelectorAll('iframe')) { if (f.src) hit.push('IFRAME:' + f.src); }
          return hit.slice(0, 12).join(' | ');
        })()`,
        returnByValue: true,
      }, sid);
    }
    await sleep(9000);
  } finally {
    try { ws?.close(); } catch {}
    proc.kill('SIGKILL');
    // Chrome 이 프로필에 쓰던 파일을 놓을 시간을 준다.
    // 여기서 나는 오류 때문에 애써 찾은 결과를 버리면 안 된다.
    await sleep(600);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* 임시 폴더는 남아도 상관없다 */
    }
  }

  if (!found.length && candidates.length) {
    log(`음원을 못 찾았습니다. 오간 주소 중 비슷한 것들:`);
    candidates.slice(0, 15).forEach((c) => log(`  ? ${c}`));
  }
  return found;
}
