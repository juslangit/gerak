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
  // Not one of gerak's own exports: those come and go with the tests, and
  // which one sorts first changes whenever the library is rescanned.
  const pick = rigged.find((i) => i.joints >= 20 && i.size < 12e6
    && !i.path.includes('/exports/')) || rigged[0];
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
  say(!!g.view.transform.object, 'the rotate ring attached to it');

  // ── the floor and the axis widget ─────────────────────────────────
  say(g.view.grid.visible, 'the grid is on when you open a model, not hidden behind a button');
  const unit = g.view.grid.material.uniforms.uUnit.value;
  say(unit > 0 && unit < g.view.modelSize,
    `the grid spacing suits the model: ${unit} for a model ${g.view.modelSize.toFixed(2)} across`);
  say(g.view.gizmo.balls.length === 6,
    `the axis widget has ${g.view.gizmo.balls.length} balls — three axes, each way`);

  const widget = g.view.renderer.domElement.getBoundingClientRect();
  const box = g.view.gizmo.rect(widget.width, widget.height);
  say(g.view.gizmo.contains(box.left + 4, box.top + 4, widget.width, widget.height)
      && !g.view.gizmo.contains(10, 10, widget.width, widget.height),
    'it claims the pointer only in its own corner');

  /* The middle of the widget is usually empty - the balls sit out at the
   * ends of the axes - so the test asks where a ball actually lands on
   * screen and clicks there. That checks the whole mapping from a pointer on
   * the canvas to a ball in the widget's own little scene. */
  const wanted = g.view.gizmo.balls.find((b) => b.userData.axis === 'Y' && b.userData.sign === 1);
  const onScreen = wanted.position.clone().project(g.view.gizmo.camera);
  const ball = g.view.gizmo.hit(
    box.left + (onScreen.x * 0.5 + 0.5) * box.size,
    box.top + (-onScreen.y * 0.5 + 0.5) * box.size,
    widget.width, widget.height);
  say(ball === wanted,
    `clicking where the Y ball is drawn finds ${ball ? ball.userData.axis + (ball.userData.sign > 0 ? '+' : '-') : 'nothing'}`);

  const stood = g.view.camera.position.clone();
  const away = stood.distanceTo(g.view.orbit.target);
  g.view.gizmo.onPick(new (stood.constructor)(1, 0, 0));
  // Wait for the swing to land rather than for a stopwatch: a headless
  // window throttles requestAnimationFrame, so a fixed delay is a coin toss.
  await until('the camera to finish swinging', () => !g.view.swing.running, 8000);
  await wait(100);
  const swungTo = g.view.camera.position.clone();
  const facing = swungTo.clone().sub(g.view.orbit.target).normalize();
  say(facing.x > 0.999,
    `picking X swung the camera onto the X axis (${facing.x.toFixed(3)}, ${facing.y.toFixed(3)}, ${facing.z.toFixed(3)})`);
  say(Math.abs(swungTo.distanceTo(g.view.orbit.target) - away) < away * 0.02,
    'and kept its distance, so the model stays the same size');

  // ── turn it and key it ────────────────────────────────────────────
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

  // ── IK: the limbs, the handle, and the pin ────────────────────────
  const chains = g.state.chains;
  say(chains.length > 0, `found ${chains.length} limbs: ${chains.map((c) => c.label).join(', ')}`);
  say(document.querySelectorAll('#limb-list .limb-row').length === chains.length,
    'the limbs panel lists each of them with an FK/IK switch');

  const leg = chains.find((c) => /leg/i.test(c.label)) || chains[0];
  g.setChainMode(leg, 'ik');
  say(leg.enabled && g.view.handles.length === 1,
    `${leg.label} switched to IK and grew a draggable handle`);

  // Switching to IK must not move the model at all.
  const tipNow = new (leg.tip.position.constructor)();
  leg.tip.getWorldPosition(tipNow);
  say(tipNow.distanceTo(leg.target) < 1e-6,
    'turning IK on left the limb exactly where it was');

  /* Drag the handle, the way the gizmo does.
   *
   * A standing rig has its legs almost straight, so a target further from the
   * hip than the leg is long is simply unreachable - the honest answer there
   * is a straight leg pointing at it, not a foot that teleports. So the goal
   * is picked as a fraction of the limb's own reach, and both behaviours are
   * checked separately. */
  const V3 = leg.tip.position.constructor;
  const hipAt = new V3();
  leg.root.getWorldPosition(hipAt);
  const reach = leg.reach();
  const reachable = (p) => hipAt.distanceTo(p) < reach * 0.995;

  // Toward the hip and out to the side: a bend, comfortably within reach.
  const goal = leg.target.clone();
  goal.lerp(hipAt, 0.22);
  goal.x += reach * 0.12;
  say(reachable(goal), `the test target is inside the limb's reach (${reach.toFixed(3)})`);

  g.view.onHandleMoved(leg, goal);
  g.view.scene.updateMatrixWorld(true);
  const landed = new V3();
  leg.tip.getWorldPosition(landed);
  const miss = landed.distanceTo(goal);
  say(miss < reach * 1e-4,
    `dragging the handle put the foot ${miss.toExponential(1)} from the target (limb reach ${reach.toFixed(3)})`);

  // And a target it cannot possibly reach: the leg should go straight and
  // point at it rather than tear itself apart.
  const tooFar = hipAt.clone().add(new V3(0, -reach * 4, 0));
  g.view.onHandleMoved(leg, tooFar);
  g.view.scene.updateMatrixWorld(true);
  const stretched = new V3();
  leg.tip.getWorldPosition(stretched);
  const spanned = hipAt.distanceTo(stretched);
  say(spanned > reach * 0.999 && spanned <= reach * 1.001,
    `an out-of-reach target straightens the leg to its full ${spanned.toFixed(3)} of ${reach.toFixed(3)}`);
  say(Number.isFinite(spanned), 'and produces no NaN');

  // Back somewhere sensible before keying.
  g.view.onHandleMoved(leg, goal);

  // Dropping it keys the joints the solver moved.
  g.setFrame(24);
  g.view.onHandleMoved(leg, goal);
  g.view.onHandleDropped(leg);
  const keyedByIK = leg.bones.filter((b) => g.state.clip.hasKey(b.name, 24));
  say(keyedByIK.length === leg.bones.length,
    `letting go keyed all ${keyedByIK.length} joints the solver turned`);

  // Nothing about the chain should survive on the bones themselves - that is
  // what keeps the exported .glb free of constraints.
  say(leg.bones.every((b) => !b.userData.ik && !b.constraint),
    'IK left no machinery on the bones, only rotations');

  // ── pinning: move the body, the foot stays planted ────────────────
  g.togglePin(leg);
  say(leg.pinned, `${leg.label} is pinned`);

  const planted = leg.target.clone();
  const hips = g.state.bones.find((b) => /hips|pelvis/i.test(b.name)) || g.state.bones[0];
  g.view.select(hips);
  hips.rotation.x += 0.12;
  g.view.onDragEnd(hips);
  g.view.scene.updateMatrixWorld(true);

  const hipMoved = new V3();
  leg.root.getWorldPosition(hipMoved);
  const stillReachable = hipMoved.distanceTo(planted) < reach * 0.995;
  say(stillReachable, 'after tilting the body the planted spot is still within reach');

  const afterMove = new V3();
  leg.tip.getWorldPosition(afterMove);
  const slip = afterMove.distanceTo(planted);
  say(slip < reach * 1e-3,
    `the pinned foot slipped ${slip.toExponential(1)} while the body tilted — it stayed planted`);

  // And with the pin off, the same move should carry the foot along.
  g.togglePin(leg);
  const footWas = leg.target.clone();
  hips.rotation.x -= 0.36;
  g.view.onDragEnd(hips);
  g.view.scene.updateMatrixWorld(true);
  const carried = new (leg.tip.position.constructor)();
  leg.tip.getWorldPosition(carried);
  say(carried.distanceTo(footWas) > 1e-3,
    'with the pin off, the foot travels with the body as it should');

  g.setFrame(0);

  // ── undo ──────────────────────────────────────────────────────────
  const h = g.history;
  say(h.canUndo, `there is something to undo: ${h.undoLabel}`);

  // A pose that was never keyed is the one undo is most likely to be asked
  // for, and the one a clip-only history would silently throw away.
  const loose = g.state.bones.find((b) => !g.state.clip.tracks.has(b.name) && b !== arm);
  g.view.select(loose);
  const wasAt = loose.quaternion.clone();
  g.view.onDragStart(loose);
  loose.rotation.x += 0.4;
  say(1 - Math.abs(loose.quaternion.dot(wasAt)) > 1e-6, `turned "${loose.name}" without keying it`);
  g.undo();
  say(1 - Math.abs(loose.quaternion.dot(wasAt)) < 1e-9,
    'undo put a joint back that had been turned but never keyed');

  // And a key
  const keysBefore = g.state.clip.totalKeys();
  g.setFrame(33);
  arm.rotation.z += 0.3;
  g.keyPose(33);
  say(g.state.clip.totalKeys() > keysBefore,
    `keying added ${g.state.clip.totalKeys() - keysBefore} key(s)`);
  g.undo();
  say(g.state.clip.totalKeys() === keysBefore,
    `undo took them away again (${g.state.clip.totalKeys()} back to ${keysBefore})`);
  say(h.canRedo, `and redo is offered: ${h.redoLabel}`);
  g.redo();
  say(g.state.clip.totalKeys() > keysBefore, 'redo put them back');
  g.undo();

  // Pressing a key that changes nothing must not leave a step behind.
  g.setFrame(41);
  const depth = h.past.length;
  g.command('unkey');                       // no keys at frame 41
  say(h.past.length === depth,
    'removing a key where there is none leaves nothing on the undo stack');

  // The buttons say what they will do.
  say(!document.querySelector('#btn-undo').disabled, 'the undo button is live');
  say(/^Undo /.test(document.querySelector('#btn-undo').title),
    `and names it: "${document.querySelector('#btn-undo').title}"`);

  // Undo everything, then check the stack empties and the button greys out.
  let guard = 0;
  while (h.canUndo && guard++ < 60) h.undo();
  say(!h.canUndo, `undoing everything empties the stack (${guard} steps)`);
  say(document.querySelector('#btn-undo').disabled, 'and the button greys out');

  // Put the work back for the export test below.
  guard = 0;
  while (h.canRedo && guard++ < 60) h.redo();
  say(g.state.clip.totalKeys() > 0, `redoing it all brings the work back (${g.state.clip.totalKeys()} keys)`);

  // ── copy and paste ────────────────────────────────────────────────
  g.setFrame(0);
  const poseHere = g.state.clip.poseAt(0);
  say(poseHere.length > 0, `there is a pose at frame 0 across ${poseHere.length} joint(s)`);

  g.copyKeys();
  say(!!g.clipboard && g.clipboard.entries.length === poseHere.length,
    `copied ${g.clipboard ? g.clipboard.label : 'nothing'}`);
  say(!document.querySelector('#btn-paste').disabled, 'the Paste button woke up');

  // Paste it somewhere empty and check the pose really lands there.
  g.setFrame(44);
  const before44 = g.state.clip.totalKeys();
  g.pasteKeys();
  say(g.state.clip.totalKeys() > before44,
    `pasting at frame 44 added ${g.state.clip.totalKeys() - before44} key(s)`);

  const sourcePose = g.state.clip.sample(poseHere[0].name, 0);
  const pastedPose = g.state.clip.sample(poseHere[0].name, 44);
  say(1 - Math.abs(sourcePose.q.dot(pastedPose.q)) < 1e-9,
    'and frame 44 now holds exactly the pose that was at frame 0');

  // Undo has to reach a paste like anything else.
  g.undo();
  say(g.state.clip.totalKeys() === before44, 'undo took the pasted keys away again');
  g.redo();

  // ── pasting flipped: the thing walk cycles are made of ────────────
  /* Ask the app which joint is the opposite number rather than guessing by
   * swapping the word, because on a Meshy rig the two sides carry different
   * node numbers and a guessed name exists nowhere. */
  /* Find any joint that HAS an opposite number rather than guessing at a
   * naming pattern — the rigs in the library do not agree on one, and which
   * model the test opens changes whenever the library is rescanned. */
  const names = g.state.bones.map((b) => b.name);
  const pair = names
    .map((name) => [name, g.mirrorOf(name, names)])
    .find(([, other]) => !!other);
  const [leftName, rightName] = pair || [];
  say(!!rightName, pair
    ? `the opposite of ${leftName} is ${rightName}`
    : `no joint on ${pick.name} has an opposite number`);
  if (leftName && rightName) {
    g.setFrame(0);
    const leftJoint = g.state.bones.find((b) => b.name === leftName);
    g.view.onDragStart(leftJoint);
    leftJoint.rotation.z += 0.6;
    g.keyPose(0);
    g.copyKeys();

    g.setFrame(46);
    g.pasteKeys({ flipped: true });
    const source = g.state.clip.sample(leftName, 0);
    const landed = g.state.clip.sample(rightName, 46);
    say(!!landed, `a pose copied from ${leftName} landed on ${rightName} when pasted flipped`);
    if (landed) {
      // Flipping negates the y and z of the rotation; that is the whole trick.
      const want = [source.q.x, -source.q.y, -source.q.z, source.q.w];
      const dot = Math.abs(landed.q.x * want[0] + landed.q.y * want[1]
                         + landed.q.z * want[2] + landed.q.w * want[3]);
      say(dot > 0.9999, `and it arrived mirrored, not copied (match ${dot.toFixed(6)})`);
    }
  }

  // ── picking keys out on the timeline ──────────────────────────────
  g.setFrame(0);
  const trackName = g.state.clip.keyedNames()[0];
  const firstKey = g.state.clip.keysOf(trackName)[0];
  g.state.picked = [{ name: trackName, f: firstKey.f }];
  g.renderTracks();
  say(document.querySelectorAll('#tracks .keyd.is-on').length === 1,
    'a picked key is drawn differently from the rest');
  // The label stays put - a button that changes width pushes the row of
  // controls onto a second line in a narrow window - so what it will copy is
  // in the tooltip.
  say(/1 picked key/.test(document.querySelector('#btn-copy').title),
    `and the Copy button says what it will copy: "${document.querySelector('#btn-copy').title}"`);

  g.copyKeys();
  say(g.clipboard.entries.length === 1, 'copying with a key picked takes just that key');

  const pickedGone = g.state.clip.keysOf(trackName).length;
  g.state.picked = [{ name: trackName, f: firstKey.f }];
  g.command('unkey');
  say(g.state.clip.keysOf(trackName).length === pickedGone - 1,
    'and Delete removes the picked key rather than whatever is under the playhead');
  g.undo();

  // ── export: .glb here, the rest through Blender ───────────────────
  const caps = await g.api(`/api/capabilities?t=${encodeURIComponent(window.GERAK_TOKEN)}`);
  say(true, `Blender ${caps.blender ? 'found' : 'NOT found'} at ${caps.blenderPath}`);

  document.querySelector('#btn-export').click();
  say(!document.querySelector('#export-pop').hidden, 'the export panel opened');

  document.querySelector('#fmt-fbx').checked = caps.blender;
  document.querySelector('#fmt-blend').checked = caps.blender;
  // The video is the slowest and the most fragile of the four, so it is the
  // one most worth actually rendering in a test rather than assuming.
  document.querySelector('#fmt-mp4').checked = caps.blender;
  document.querySelector('#btn-export-go').click();

  const note = await until('the export to finish', () => {
    const el = document.querySelector('#export-note');
    const t = el.textContent;
    return t && !/Writing|working|rendering/i.test(t) ? t : null;
  }, 180000);

  const files = note.split('\n').filter((l) => /\.(glb|fbx|blend|mp4)\b/.test(l));
  say(files.some((l) => l.includes('.glb')), `wrote ${files.find((l) => l.includes('.glb'))?.trim()}`);
  if (caps.blender) {
    say(files.some((l) => l.includes('.fbx')), `wrote ${files.find((l) => l.includes('.fbx'))?.trim() || 'NO FBX'}`);
    say(files.some((l) => l.includes('.blend')), `wrote ${files.find((l) => l.includes('.blend'))?.trim() || 'NO BLEND'}`);
    say(files.some((l) => l.includes('.mp4')), `wrote ${files.find((l) => l.includes('.mp4'))?.trim() || 'NO VIDEO'}`);
  }
  say(!document.querySelector('#export-note').classList.contains('is-bad'),
    'the export reported no problems');

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
