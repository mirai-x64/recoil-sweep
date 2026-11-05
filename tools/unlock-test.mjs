// スキル解放ループ(容量2 / スラスタ / マグネット)が閾値どおりに発火するかを検証。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(__dirname, '..', 'index.html');
const port = 9300 + ((process.pid + 7) % 600);
const profile = mkdtempSync(path.join(tmpdir(), 'rs-prof2-'));

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
    '--window-size=900,620', 'about:blank'
  ], { stdio: 'ignore' });
  await waitForEndpoint('http://127.0.0.1:'+port+'/json/version', 40);
  const list = await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  const target = list.find(t => t.type === 'page');
  const cdp = makeClient(await connect(target.webSocketDebuggerUrl));
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: 'file://'+indexPath });
  await sleep(600);

  async function evalJs(expr){ const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.result.result.value; }

  for (const [score, label] of [[4,'4(未解放)'],[5,'5(容量2)'],[11,'11(未だthruster前)'],[12,'12(thruster)'],[21,'21(magnet前)'],[22,'22(magnet)']]){
    await evalJs(`window.__test.forceScore(${score})`);
    await sleep(50);
    const d = JSON.parse(await evalJs('JSON.stringify(window.__debug)'));
    console.log(label, '-> capacity='+d.capacity, 'unlocks='+JSON.stringify(d.unlocks), 'fuel='+d.fuel);
  }
} finally {
  if (chrome) chrome.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
}
