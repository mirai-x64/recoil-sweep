// 壁キック(X)が「壁に触れている時だけ無料で反動が付く」ことを検証する。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(__dirname, '..', 'index.html');
const port = 9300 + ((process.pid + 13) % 600);
const profile = mkdtempSync(path.join(tmpdir(), 'rs-prof3-'));

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
async function waitForEndpoint(url, tries){
  for (let i=0;i<tries;i++){ try { const r = await fetch(url); if (r.ok) return; } catch(e){} await sleep(200); }
  throw new Error('chrome did not come up');
}
function connect(wsUrl){
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', reject);
  });
}
function makeClient(ws){
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)){ pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  return { send(method, params){ return new Promise((resolve) => { const myId = ++id; pending.set(myId, resolve); ws.send(JSON.stringify({id: myId, method, params: params||{}})); }); } };
}

let chrome;
try {
  chrome = spawn('google-chrome', [
    '--headless=new', '--remote-debugging-port='+port, '--user-data-dir='+profile,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-gpu',
    '--window-size=460,480', 'about:blank'
  ], { stdio: 'ignore' });
  await waitForEndpoint('http://127.0.0.1:'+port+'/json/version', 40);
  const list = await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  const target = list.find(t => t.type === 'page');
  const cdp = makeClient(await connect(target.webSocketDebuggerUrl));
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: 'file://'+indexPath });
  await sleep(600);

  async function evalJs(expr){ const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.result.result.value; }
  async function getDebug(){ return JSON.parse(await evalJs('JSON.stringify(window.__debug)')); }

  const d0 = await getDebug();
  console.log('initial:', d0);
  const startsTouchingWall = d0.touchingWall === true;
  const startsAtZeroVel = d0.player.vx === 0 && d0.player.vy === 0;
  console.log('spawn is wall-adjacent:', startsTouchingWall);

  // 壁に触れた状態で、船内方向(壁から離れる向き)を照準して X で蹴る
  await evalJs(`window.__test.setAim(${d0.player.x + 200}, ${d0.player.y})`);
  await evalJs('window.__test.wallKick()');
  await sleep(50);
  const afterKick = await getDebug();
  console.log('after wall-kick while touching:', afterKick.player);
  const kickMovedAwayFromWall = afterKick.player.vx > 1;

  // 連打してもクールダウン中は追加の力積が入らないことを確認(同一フレーム直後の二連打)
  const vxAfterFirst = afterKick.player.vx;
  await evalJs('window.__test.wallKick()');
  await sleep(16);
  const afterSecondImmediate = await getDebug();
  const cooldownHeld = Math.abs(afterSecondImmediate.player.vx - vxAfterFirst) < 5;
  console.log('cooldown blocks immediate re-kick:', cooldownHeld, 'vx now:', afterSecondImmediate.player.vx);

  // 壁から離れた状態(船内中央付近)では X が効かないことを確認
  await evalJs(`window.__test.setThrust(true)`);
  await evalJs(`window.__test.setAim(${d0.player.x + 10}, ${d0.player.y})`);
  await sleep(1500);
  await evalJs(`window.__test.setThrust(false)`);
  const dMid = await getDebug();
  console.log('mid-room:', dMid.player, 'touchingWall:', dMid.touchingWall);
  const vxBeforeFarKick = dMid.player.vx, vyBeforeFarKick = dMid.player.vy;
  await evalJs('window.__test.wallKick()');
  await sleep(50);
  const afterFarKick = await getDebug();
  const farKickNoEffect = !dMid.touchingWall &&
    Math.abs(afterFarKick.player.vx - vxBeforeFarKick) < 0.5 &&
    Math.abs(afterFarKick.player.vy - vyBeforeFarKick) < 0.5;
  console.log('wall-kick no-op away from wall:', farKickNoEffect, afterFarKick.player);

  const ok = startsTouchingWall && startsAtZeroVel && kickMovedAwayFromWall && cooldownHeld && farKickNoEffect;
  console.log(ok ? 'PASS' : 'CHECK NEEDED');
} finally {
  if (chrome) chrome.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
}
