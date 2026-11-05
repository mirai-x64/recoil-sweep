// 依存ゼロのCDPスモークテスト。index.html を実際にヘッドレスChromeで動かし、
// 投げる→反動で動く→拾う→エアロックで収納→スコア加算、まで一通り確認する。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(__dirname, '..', 'index.html');

const port = 9300 + (process.pid % 600);
const profile = mkdtempSync(path.join(tmpdir(), 'rs-prof-'));

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function waitForEndpoint(url, tries){
  for (let i=0;i<tries;i++){
    try { const r = await fetch(url); if (r.ok) return; } catch (e) {}
    await sleep(200);
  }
  throw new Error('chrome did not come up: ' + url);
}

function connect(wsUrl){
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', reject);
  });
}

function makeClient(ws){
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)){
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      listeners.forEach(fn => fn(msg));
    }
  });
  function send(method, params){
    return new Promise((resolve) => {
      const myId = ++id;
      pending.set(myId, resolve);
      ws.send(JSON.stringify({id: myId, method, params: params || {}}));
    });
  }
  return { send, onEvent: (fn) => listeners.push(fn) };
}

let chrome;
try {
  chrome = spawn('google-chrome', [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    '--disable-gpu', '--window-size=460,480',
    'about:blank'
  ], { stdio: 'ignore' });

  await waitForEndpoint('http://127.0.0.1:' + port + '/json/version', 40);

  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const target = list.find(t => t.type === 'page');
  const ws = await connect(target.webSocketDebuggerUrl);
  const cdp = makeClient(ws);

  const consoleErrors = [];
  cdp.onEvent((msg) => {
    if (msg.method === 'Runtime.exceptionThrown'){
      consoleErrors.push(msg.params.exceptionDetails.text || JSON.stringify(msg.params));
    }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  await cdp.send('Page.navigate', { url: 'file://' + indexPath });
  await sleep(600);

  for (let i=0;i<30;i++){
    const r = await cdp.send('Runtime.evaluate', { expression: 'typeof window.__debug', returnByValue: true });
    if (r.result.result.value === 'object') break;
    await sleep(200);
  }

  async function getDebug(){
    const r = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__debug)', returnByValue: true });
    return JSON.parse(r.result.result.value);
  }
  async function evalJs(expr){
    return cdp.send('Runtime.evaluate', { expression: expr });
  }

  const d0 = await getDebug();
  console.log('initial:', d0);

  // --- 実入力(マウス+キーボード)での素朴な疎通チェック: 本物のCDP入力でも反応するか ---
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 280 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyC', key: 'c' });
  await sleep(1200);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyC', key: 'c' });
  const dReal = await getDebug();
  const realInputMoved = Math.abs(dReal.player.vx) > 1 || Math.abs(dReal.player.vy) > 1;
  console.log('real-input thrust test: vx=' + dReal.player.vx.toFixed(2) + ' vy=' + dReal.player.vy.toFixed(2), realInputMoved ? 'OK' : 'NG');

  // --- 決定的な口 __test を使って、拾う→運ぶ→納品(スコア加算)→投げる反動、を検証 ---
  const AIRLOCK_X = 60, AIRLOCK_Y = 210;
  let sawPickup = false, sawDeposit = false, sawThrowRecoil = false;
  let prevHeld = 0, prevScore = 0;

  // フェーズ1: 何も持っていなければ船体から遠ざかりつつ広く掃き、拾ったら即エアロックへ
  for (let i=0;i<200 && !sawDeposit;i++){ // 最大 200*150ms = 30s
    const d = await getDebug();
    let tx, ty;
    if (d.held === 0){
      const angle = (i * 0.31) % (Math.PI*2);
      tx = d.player.x + Math.cos(angle)*260;
      ty = d.player.y + Math.sin(angle)*260;
    } else {
      tx = AIRLOCK_X; ty = AIRLOCK_Y;
    }
    tx = Math.max(0, Math.min(459, tx));
    ty = Math.max(0, Math.min(419, ty));
    await evalJs(`window.__test.setAim(${tx},${ty})`);
    await evalJs('window.__test.setThrust(true)');
    if (d.held > prevHeld) sawPickup = true;
    if (d.score > prevScore) sawDeposit = true;
    prevHeld = d.held; prevScore = d.score;
    await sleep(150);
  }
  await evalJs('window.__test.setThrust(false)');

  const dMid = await getDebug();
  console.log('after phase1 (pickup->airlock):', dMid, 'sawPickup:', sawPickup, 'sawDeposit:', sawDeposit);

  // フェーズ2: 投げた瞬間の反動(運動量保存)を直接検証。拾って、エアロックと逆方向へ照準し投げる
  for (let i=0;i<200 && prevHeld === 0;i++){ // 拾うまで最大30s
    const d = await getDebug();
    const angle = (i * 0.31) % (Math.PI*2);
    const tx = Math.max(0, Math.min(459, d.player.x + Math.cos(angle)*160));
    const ty = Math.max(0, Math.min(419, d.player.y + Math.sin(angle)*160));
    await evalJs(`window.__test.setAim(${tx},${ty})`);
    await evalJs('window.__test.setThrust(true)');
    prevHeld = d.held;
    await sleep(150);
  }
  await evalJs('window.__test.setThrust(false)');

  const dBeforeThrow = await getDebug();
  if (dBeforeThrow.held > 0){
    // プレイヤーから見てエアロックの反対方向を照準して投げる -> 反動はエアロック方向のはず
    const awayX = dBeforeThrow.player.x + (dBeforeThrow.player.x - AIRLOCK_X);
    const awayY = dBeforeThrow.player.y + (dBeforeThrow.player.y - AIRLOCK_Y);
    await evalJs(`window.__test.setAim(${awayX},${awayY})`);
    const before = dBeforeThrow.player;
    await evalJs('window.__test.throwHeld()');
    await sleep(100);
    const after = await getDebug();
    const towardAirlockBefore = (AIRLOCK_X - before.x) * (after.player.vx - before.vx) >= 0;
    sawThrowRecoil = (after.player.vx !== before.vx || after.player.vy !== before.vy);
    console.log('throw recoil: before v=('+before.vx.toFixed(2)+','+before.vy.toFixed(2)+')'
      + ' after v=('+after.player.vx.toFixed(2)+','+after.player.vy.toFixed(2)+')'
      + ' heldBefore='+dBeforeThrow.held+' heldAfter='+after.held
      + ' velocityChanged='+sawThrowRecoil + ' recoilTowardAirlock=' + towardAirlockBefore);
  } else {
    console.log('フェーズ2: 30秒以内に拾えなかった (投げ検証スキップ)');
  }

  const dEnd = await getDebug();
  console.log('final:', dEnd);
  console.log('consoleErrors:', consoleErrors);

  await cdp.send('Page.captureScreenshot', {}).then(async (r) => {
    const fs = await import('node:fs');
    fs.mkdirSync(path.join(__dirname, '..', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', 'docs', 'screenshot.png'), Buffer.from(r.result.data, 'base64'));
  });

  const ok = consoleErrors.length === 0 && realInputMoved && sawPickup && sawDeposit && sawThrowRecoil;
  console.log(ok ? 'PASS' : 'CHECK NEEDED');

} finally {
  if (chrome) chrome.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
}
