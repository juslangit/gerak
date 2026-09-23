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

const W = Number(process.argv[4]) || 1600, H = Number(process.argv[5]) || 1000;
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

/* Chrome must die whatever happens to this script. 'exit' alone is not
 * enough: it does not run on SIGINT or SIGTERM, so a Ctrl-C or a kill used to
 * leave a headless Chrome and its four helper processes running. Three of
 * those were found still going twenty-five hours later, between them holding
 * five and a half of this machine's eight cores. */
let cleanedUp = false;
const cleanup = () => {
  if (cleanedUp) return;
  cleanedUp = true;
  try { chrome.kill('SIGKILL'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { cleanup(); process.exit(130); });
}
process.on('uncaughtException', (err) => {
  console.error('shot failed:', err.message);
  cleanup();
  process.exit(1);
});

/* Nothing in here may wait forever. Every await below has a deadline, and the
 * whole run has one too, because the failure that actually happened was not a
 * crash - it was a promise that simply never settled, with no error, no
 * output, and no end. */
const DEADLINE_MS = Number(process.env.GERAK_SHOT_DEADLINE || 6 * 60 * 1000);
const overall = setTimeout(() => {
  console.error(`shot failed: gave up after ${Math.round(DEADLINE_MS / 1000)}s`);
  cleanup();
  process.exit(1);
}, DEADLINE_MS);
overall.unref();

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, no) => {
      timer = setTimeout(() => no(new Error(`${what} did not answer in ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

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
  return (method, params = {}, ms = 60000) => withTimeout(
    new Promise((ok, no) => {
      const n = ++id;
      waiting.set(n, { ok, no });
      ws.send(JSON.stringify({ id: n, method, params }));
    }), ms, method);
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
    // The panel of everything one character can do, with one of them open on
    // the timeline, one edited and two ticked ready to be merged.
    name: '9-animations',
    setup: `
      const g = window.gerak;
      const many = g.state.library
        .filter(i => i.anims >= 6 && i.rigged && !i.path.includes('/exports/'))
        .sort((a, b) => b.anims - a.anims)[0];
      await g.openModel(many);
      await new Promise(r => setTimeout(r, 600));
      g.showTab('anims');
      g.openAnim(Math.min(3, g.state.set.length - 1));
      await new Promise(r => setTimeout(r, 400));
      const joint = g.state.bones.find(b => /arm|hand|spine/i.test(b.name)) || g.state.bones[2];
      g.view.select(joint);
      g.setFrame(8);
      joint.rotation.z += 0.45;
      g.keyPose(8);
      const ticks = [...document.querySelectorAll('.anim-pick')];
      for (const i of [1, 2]) {
        if (!ticks[i]) continue;
        ticks[i].checked = true;
        ticks[i].dispatchEvent(new Event('change'));
      }
      g.setFrame(8);
    `,
  },
  {
    // The question a merge asks, with the warning about what in the game is
    // still calling the name that is about to go.
    name: '10-merge',
    setup: `
      const g = window.gerak;
      g.mergeAnims();
      for (let i = 0; i < 100 && document.querySelector('#sheet').hidden; i++) {
        await new Promise(r => setTimeout(r, 100));
      }
      await new Promise(r => setTimeout(r, 300));
    `,
  },
  {
    name: '4-rigging',
    setup: `
      document.querySelector('#sheet').hidden = true;
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
  // A page that holds a connection open can take its time firing load, or
  // never fire it at all. Wait, but carry on rather than stop for ever - by
  // this point the app is usually up and the shots below will say if it is not.
  await withTimeout(loaded, 30000, 'the page load event')
    .catch((err) => console.error(`  ${err.message} - carrying on anyway`));
  await sleep(1200);

  // The dialogs the app opens on its own would sit in front of a screenshot.
  await send('Runtime.evaluate', {
    expression: 'window.confirm = () => true; window.prompt = () => null; true',
  });

  for (const shot of SHOTS_TO_TAKE) {
    // awaitPromise means this call does not return until the page's own
    // promise settles, and the setup code awaits things like a full library
    // rescan. Give it a generous window and then move to the next shot.
    let res;
    try {
      res = await send('Runtime.evaluate', {
        expression: `(async () => {\n${shot.setup}\n return true; })()`,
        awaitPromise: true,
        returnByValue: true,
      }, 120000);
    } catch (err) {
      console.error(`  ${shot.name}: ${err.message}`);
      continue;
    }
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
  clearTimeout(overall);
  cleanup();
  process.exit(0);
} catch (err) {
  console.error('shot failed:', err.message);
  cleanup();
  process.exit(1);
}
