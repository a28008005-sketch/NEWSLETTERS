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
  const add = (url) => {
    if (url && AUDIO_EXT.test(url) && !found.includes(url)) {
      found.push(url);
      log(`음원 발견: ${url}`);
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

    let sessionId = null;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);

      if (msg.method === 'Target.attachedToTarget') {
        sessionId = msg.params.sessionId;
        send('Network.enable', {}, sessionId);
        send('Page.enable', {}, sessionId);
        send('Page.navigate', { url: pageUrl }, sessionId);
        return;
      }
      const p = msg.params || {};
      if (msg.method === 'Network.requestWillBeSent') add(p.request?.url);
      if (msg.method === 'Network.responseReceived') {
        if (AUDIO_MIME.test(p.response?.mimeType || '')) add(p.response.url);
        else add(p.response?.url);
      }
    };

    send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    send('Target.createTarget', { url: 'about:blank' });

    await sleep(waitMs);

    // 재생 버튼을 눌러야 파일을 받아오는 경우가 있다. 있으면 눌러 본다.
    if (sessionId) {
      send('Runtime.evaluate', {
        expression: `(() => {
          const hit = [];
          for (const el of document.querySelectorAll('button, a, [role=button], [class*=listen i], [class*=audio i], [class*=play i]')) {
            const label = ((el.textContent || '') + ' ' + (el.className || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
            if (/listen|audio|play/.test(label)) { try { el.click(); hit.push(label.trim().slice(0, 40)); } catch (e) {} }
          }
          for (const a of document.querySelectorAll('audio, audio source')) { if (a.src) hit.push('SRC:' + a.src); }
          return hit.slice(0, 12).join(' | ');
        })()`,
        returnByValue: true,
      }, sessionId);
      await sleep(6000);
    }
  } finally {
    try { ws?.close(); } catch {}
    proc.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  }

  return found;
}
