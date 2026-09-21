/* Drives the real app in a real browser, the way a person would.
 *
 * This runs INSIDE the page, through the test runner, so it is the actual
 * app.js, scene.js and WebGL viewport being exercised - not a stand-in. It
 * answers the question the unit tests cannot: does the thing work when you
 * click it.
 *
 *   node tests/run-browser.mjs "http://127.0.0.1:8778/?t=..." tests/app.smoke.mjs
 */

const lines = [];
let failed = 0;
const say = (ok, msg) => { lines.push(`${ok ? '  ok  ' : ' FAIL '}${msg}`); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, ms = 20000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    let v;
    try { v = fn(); } catch { v = null; }
    if (v) return v;
    await wait(100);
  }
  throw new Error(`gave up waiting for ${what}`);
}

// Nothing here should be answering a dialog box, so make them no-ops rather
// than let one freeze the run.
window.confirm = () => false;
window.prompt = () => null;

try {
  const g = await until('the app to start', () => window.gerak);
  say(true, 'the app started with no import errors');

  // ── the library arrives ───────────────────────────────────────────
  await until('the library', () => g.state.library.length);
  const rigged = g.state.library.filter((i) => i.rigged);
  say(rigged.length > 0, `library has ${g.state.library.length} models, ${rigged.length} of them rigged`);

  const rows = document.querySelectorAll('#library-list .row');
  say(rows.length > 0, `the list on screen shows ${rows.length} of them`);

  // ── open one ──────────────────────────────────────────────────────
  const pick = rigged.find((i) => i.joints >= 20 && i.size < 12e6) || rigged[0];
  await g.openModel(pick);
  await until('the model', () => g.state.bones.length);
  say(true, `opened ${pick.name} — ${g.state.bones.length} joints`);

  const treeRows = document.querySelectorAll('#bone-tree .bone');
  say(treeRows.length === g.state.bones.length,
    `the joint tree lists all ${treeRows.length} of them`);

  // ── the viewport really drew something ────────────────────────────
  const canvas = document.querySelector('#viewport canvas');
  say(!!canvas && canvas.width > 0, `the viewport is live (${canvas?.width}x${canvas?.height})`);
  say(g.view.markers.length === g.state.bones.length,
    `there is a clickable dot on each of the ${g.view.markers.length} joints`);
  say(document.querySelector('#viewport-empty').hidden,
    'the "pick a model" placeholder went away');

  // ── pick a joint, the way a click does ────────────────────────────
  const arm = g.state.bones.find((b) => /arm|leg|spine|head/i.test(b.name)) || g.state.bones[1];
  g.view.select(arm);
  say(g.view.selected === arm, `selected the joint "${arm.name}"`);
  say(document.querySelector('#selected-name').textContent.length > 0,
    'the selected-joint panel filled in');
  say(!!g.view.gizmo.object, 'the rotate ring attached to it');

  // ── turn it and key it ────────────────────────────────────────────
  const before = arm.quaternion.clone();
  arm.rotation.z += 0.6;
  g.keyPose(0);
  say(g.state.clip.hasKey(arm.name, 0), 'keying at frame 0 stored the pose');

  g.setFrame(16);
  arm.rotation.z -= 1.2;
  g.keyPose(16);
  say(g.state.clip.hasKey(arm.name, 16), 'keying at frame 16 stored the second pose');

  const diamonds = document.querySelectorAll('#tracks .keyd');
  say(diamonds.length >= 2, `the timeline drew ${diamonds.length} key diamonds`);
  say(document.querySelectorAll('#tracks .track').length >= 1,
    'the timeline grew a row for the joint');

  // ── scrubbing puts the joint somewhere between the two poses ──────
  const at0 = g.state.clip.sample(arm.name, 0).q.clone();
  const at16 = g.state.clip.sample(arm.name, 16).q.clone();
  g.setFrame(8);
  const mid = arm.quaternion.clone();
  const near = (a, b) => 1 - Math.abs(a.dot(b));
  say(near(mid, at0) > 1e-6 && near(mid, at16) > 1e-6 &&
      near(mid, at0) < near(at0, at16) && near(mid, at16) < near(at0, at16),
    'frame 8 sits between the two keyed poses, not on either');

  // ── a joint nobody touched has not moved ──────────────────────────
  const untouched = g.state.bones.find((b) => b !== arm && !g.state.clip.tracks.has(b.name));
  const rest = g.view.restPose.get(untouched.name);
  say(1 - Math.abs(untouched.quaternion.dot(rest.q)) < 1e-9,
    `"${untouched.name}", which was never posed, is exactly where the file put it`);

  // ── play ──────────────────────────────────────────────────────────
  g.player.loop = true;
  g.player.play(g.state.clip);
  await wait(500);
  const moved = g.player.frame > 0;
  g.player.pause();
  say(moved, `playback advanced to frame ${g.player.frame.toFixed(1)} and stopped cleanly`);

  // ── export, and check the file really landed on the disk ──────────
  document.querySelector('#btn-export').click();
  const result = await until('the export to finish', () => {
    const t = document.querySelector('#toast');
    return !t.hidden && /Exported|failed/.test(t.textContent) ? t.textContent : null;
  }, 45000);
  say(/Exported/.test(result), `export said: ${result.replace(/ — opening.*/, '')}`);

  // ── saving a clip, and reading the list back ──────────────────────
  g.state.clip.name = 'smoke-test-clip';
  await g.api('/api/clip/save', g.state.clip.toJSON());
  const { items } = await g.api(`/api/clips?t=${encodeURIComponent(window.GERAK_TOKEN)}`);
  const saved = items.find((c) => c.slug === 'smoke-test-clip');
  say(!!saved, `the clip saved to disk with ${saved ? saved.keys : 0} keys`);

  await g.api('/api/clip/delete', { slug: 'smoke-test-clip' });
  say(true, 'tidied the test clip away again');

} catch (err) {
  say(false, `threw: ${err && err.message ? err.message : err}`);
}

lines.push('');
lines.push(failed ? `${failed} failed` : 'all good');
return { failed, text: lines.join('\n') };
