/* Take a picture of gerak.
 *
 * Opens the app in a headless browser at a proper desk-sized window, drives
 * it into whatever state is worth looking at, waits for the viewport to
 * settle, and saves a PNG into screenshots/.
 *
 * The pictures are for the project record, and for checking by eye what no
 * test can check: whether the thing actually looks right.
 *
 *   node tools/shot.mjs <token> [port]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, '..', 'screenshots');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const token = process.argv[2];
const port = process.argv[3] || '8778';
if (!token) { console.error('usage: node tools/shot.mjs <token> [port]'); process.exit(2); }

const W = 1600, H = 1000;
const debugPort = 9500 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(join(tmpdir(), 'gerak-shot-'));

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`,
  '--hide-scrollbars',
  '--force-device-scale-factor=2',
  '--no-first-run', '--no-default-browser-check',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  'about:blank',
], { stdio: 'ignore' });

const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForChrome() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error('Chrome never opened its debugging port');
}

function talk(ws) {
  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const { ok, no } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? no(new Error(msg.error.message)) : ok(msg.result);
    }
  });
  return (method, params = {}) => new Promise((ok, no) => {
    const n = ++id;
    waiting.set(n, { ok, no });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
}

/* Each shot is a name and a piece of code run inside the page. */
const SHOTS_TO_TAKE = [
  {
    name: '1-library',
    setup: `
      const g = window.gerak;
      for (let i = 0; i < 200 && !g.state.library.length; i++) await new Promise(r => setTimeout(r, 100));
      // Scan afresh: the cached list can still name files that have gone.
      await g.loadLibrary(true);
      document.querySelector('#library-search').value = 'player';
      document.querySelector('#library-search').dispatchEvent(new Event('input'));
    `,
  },
  {
    name: '2-posing',
    setup: `
      const g = window.gerak;
      const pick = g.state.library.find(i => i.rigged && i.joints >= 20 && i.size < 12e6
        && !i.path.includes('/exports/'));
      await g.openModel(pick);
      await new Promise(r => setTimeout(r, 500));
      const arm = g.state.bones.find(b => /LeftArm|LeftUpLeg/.test(b.name)) || g.state.bones[2];
      g.view.select(arm);
      arm.rotation.z += 0.5; g.keyPose(0);
      g.setFrame(14);
      arm.rotation.z -= 1.1;
      const other = g.state.bones.find(b => /RightArm|Spine/.test(b.name));
      if (other) other.rotation.x += 0.4;
      g.keyPose(14);
      g.setFrame(30);
      arm.rotation.z += 0.7; g.keyPose(30);
      g.setFrame(22);
      document.querySelector('#toggle-ground').click();
    `,
  },
  {
    name: '3-ik',
    setup: `
      const g = window.gerak;
      const limb = g.state.chains.find(c => /hand/i.test(c.label));
      const foot = g.state.chains.find(c => /foot/i.test(c.label));
      if (limb) g.setChainMode(limb, 'ik');
      if (foot) { g.setChainMode(foot, 'ik'); g.togglePin(foot); }
      if (limb) {
        const hip = new (limb.target.constructor)();
        limb.root.getWorldPosition(hip);
        g.view.onHandleMoved(limb, limb.target.clone().lerp(hip, 0.28));
        g.view.selectHandle(limb.handle);
      }
      g.view.scene.updateMatrixWorld(true);
    `,
  },
  {
    name: '4-rigging',
    setup: `
      const g = window.gerak;
      const bare = g.state.library.find(i => i.ext === 'glb' && !i.rigged && i.meshes > 0
        && /crowd_a_stand/.test(i.name))
        || g.state.library.find(i => i.ext === 'glb' && !i.rigged && i.meshes > 0
          && i.size > 20000 && i.size < 4e6);
      await g.openModel(bare);
      await new Promise(r => setTimeout(r, 400));
      g.placeSkeleton();
      const hand = g.state.bones.find(b => /LeftForeArm/.test(b.name));
      if (hand) g.view.select(hand);
      await new Promise(r => setTimeout(r, 200));
    `,
  },
];

try {
  mkdirSync(SHOTS, { recursive: true });
  await waitForChrome();

  const tab = await (await fetch(
    `http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((ok, no) => {
    ws.addEventListener('open', ok);
    ws.addEventListener('error', () => no(new Error('could not attach')));
  });
  const send = talk(ws);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride',
    { width: W, height: H, deviceScaleFactor: 2, mobile: false });

  const loaded = new Promise((ok) => {
    ws.addEventListener('message', (ev) => {
      if (JSON.parse(ev.data).method === 'Page.loadEventFired') ok();
    });
  });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?t=${encodeURIComponent(token)}` });
  await loaded;
  await sleep(1200);

  // The dialogs the app opens on its own would sit in front of a screenshot.
  await send('Runtime.evaluate', {
    expression: 'window.confirm = () => true; window.prompt = () => null; true',
  });

  for (const shot of SHOTS_TO_TAKE) {
    const res = await send('Runtime.evaluate', {
      expression: `(async () => {\n${shot.setup}\n return true; })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      console.error(`  ${shot.name}: ${res.exceptionDetails.exception?.description?.split('\n')[0]}`);
      continue;
    }
    // Let the viewport render a few frames and any toast fade.
    await sleep(2800);
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const file = join(SHOTS, `${shot.name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`  saved ${shot.name}.png`);
  }
  console.log(`\nscreenshots are in ${SHOTS}`);
} catch (err) {
  console.error('shot failed:', err.message);
  process.exit(1);
}
