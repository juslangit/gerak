/* The rigging flow, driven inside the real app.
 *
 * Open a model with no skeleton, drop a template on it, move a joint, bind,
 * and then animate the thing that comes back. That last step is the point:
 * a rig is not finished because Blender said so, it is finished when you can
 * click one of its joints and turn it.
 *
 *   node tests/run-browser.mjs "http://127.0.0.1:8778/?t=..." tests/rigflow.smoke.mjs
 */

const lines = [];
let failed = 0;
const say = (ok, msg) => { lines.push(`${ok ? '  ok  ' : ' FAIL '}${msg}`); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, ms = 30000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    let v;
    try { v = fn(); } catch { v = null; }
    if (v) return v;
    await wait(100);
  }
  throw new Error(`gave up waiting for ${what}`);
}

window.confirm = () => true;
window.prompt = () => null;

try {
  const g = await until('the app to start', () => window.gerak);
  await until('the library', () => g.state.library.length);

  // ── a model with no skeleton at all ───────────────────────────────
  const bare = g.state.library.find((i) =>
    i.ext === 'glb' && !i.rigged && i.meshes > 0 && i.size > 20000 && i.size < 4e6
    && /crowd_a_stand/.test(i.name))
    || g.state.library.find((i) => i.ext === 'glb' && !i.rigged && i.meshes > 0
      && i.size > 20000 && i.size < 4e6);
  say(!!bare, `picked ${bare?.name} — ${bare?.meshes} meshes, no skeleton`);

  await g.openModel(bare);
  await wait(300);
  say(g.state.bones.length === 0, 'it opened with no joints, as expected');
  say(!document.querySelector('#rig-box').hidden, 'the rigging panel appeared');
  say(document.querySelector('#limbs-box').hidden, 'the limbs panel stayed away');
  say(document.querySelector('[data-gizmo="translate"]').classList.contains('is-on'),
    'the tool switched to Move, which is what placing joints needs');

  // ── drop a human skeleton on it ───────────────────────────────────
  document.querySelector('#rig-template').value = 'biped';
  document.querySelector('#btn-place').click();

  const placedCount = g.state.bones.length;
  say(placedCount > 20, `placed a human skeleton — ${placedCount} joints`);
  say(g.view.markers.length === placedCount, 'every placed joint got a dot to drag');
  say(document.querySelectorAll('#bone-tree .bone').length === placedCount,
    'and a row in the joint tree');
  say(!document.querySelector('#btn-bind').hidden, 'the Bind button appeared');

  // Every joint should be inside the model, or the template was fitted wrong.
  const box = g.view.modelBox();
  const outside = g.state.bones.filter((b) => {
    const p = new (box.min.constructor)();
    b.getWorldPosition(p);
    return !box.containsPoint(p);
  });
  say(outside.length === 0,
    outside.length ? `${outside.length} joints landed outside the model`
                   : 'every joint landed inside the model');

  // ── moving a parent carries its children ──────────────────────────
  const shoulder = g.state.bones.find((b) => /LeftArm$/.test(b.name))
    || g.state.bones.find((b) => b.children.length);
  const hand = g.state.bones.find((b) => /LeftHand$/.test(b.name));
  const V3 = box.min.constructor;
  if (shoulder && hand) {
    const handBefore = new V3();
    hand.getWorldPosition(handBefore);
    shoulder.position.x += 0.05;
    g.view.scene.updateMatrixWorld(true);
    const handAfter = new V3();
    hand.getWorldPosition(handAfter);
    say(Math.abs(handAfter.x - handBefore.x - 0.05) < 1e-6,
      'moving the shoulder carried the hand with it, as a chain should');
    shoulder.position.x -= 0.05;
    g.view.scene.updateMatrixWorld(true);
  }

  // ── bind ──────────────────────────────────────────────────────────
  const askedFor = g.state.bones.map((b) => b.name);
  document.querySelector('#btn-bind').click();

  const status = await until('Blender to finish binding', () => {
    const el = document.querySelector('#rig-status');
    return /Bound with|Could not bind/.test(el.textContent) ? el : null;
  }, 180000);
  say(status.classList.contains('is-good'), status.textContent.split('\n')[0]);
  if (!status.classList.contains('is-good')) throw new Error('binding failed');

  /* ── what came back is a real, animatable rig ──────────────────────
   *
   * Wait for the skin, not for the bones. The status line is written before
   * the rigged file is opened, and until that finishes the bones still
   * belong to the draft skeleton - which has exactly the same 25 names, so
   * every name check passes while nothing has actually been loaded. */
  await until('the rigged model to open', () => g.view.skinned.length > 0, 60000);
  say(g.view.skinned.length > 0,
    `the rigged model came back with ${g.view.skinned.length} skinned mesh(es)`);
  say(!g.view.hasDraft, 'and the draft skeleton was put away');

  const gotNames = new Set(g.state.bones.map((b) => b.name));
  const missing = askedFor.filter((n) => !gotNames.has(n));
  say(missing.length === 0,
    missing.length ? `${missing.length} joints did not survive: ${missing.slice(0, 4)}`
                   : `all ${askedFor.length} joints came back under their own names`);

  say(!document.querySelector('#limbs-box').hidden, 'the limbs panel appeared for the new rig');
  say(g.state.chains.length === 4,
    `and found ${g.state.chains.length} limbs on it: ${g.state.chains.map((c) => c.label).join(', ')}`);

  // ── and it can actually be posed ──────────────────────────────────
  const arm = g.state.bones.find((b) => /LeftForeArm/.test(b.name)) || g.state.bones[2];
  g.view.select(arm);
  say(g.view.selected === arm, `selected "${arm.name}" on the new rig`);

  const skin = g.view.skinned[0];
  const probe = skin.skeleton.bones.indexOf(arm);
  say(probe >= 0, 'the joint is one the skin is actually bound to');

  arm.rotation.z += 0.5;
  g.keyPose(0);
  g.setFrame(20);
  arm.rotation.z -= 1.0;
  g.keyPose(20);
  say(g.state.clip.hasKey(arm.name, 0) && g.state.clip.hasKey(arm.name, 20),
    'posed and keyed it at two frames');
  say(document.querySelectorAll('#tracks .keyd').length >= 2,
    'the timeline shows the keys');

  // IK on a rig that did not exist five seconds ago.
  const limb = g.state.chains.find((c) => /hand/i.test(c.label));
  if (limb) {
    g.setChainMode(limb, 'ik');
    const hipAt = new V3();
    limb.root.getWorldPosition(hipAt);
    const goal = limb.target.clone().lerp(hipAt, 0.2);
    g.view.onHandleMoved(limb, goal);
    g.view.scene.updateMatrixWorld(true);
    const landed = new V3();
    limb.tip.getWorldPosition(landed);
    say(landed.distanceTo(goal) < limb.reach() * 1e-4,
      `IK works on the new rig — the hand landed ${landed.distanceTo(goal).toExponential(1)} from the target`);
  }

} catch (err) {
  say(false, `threw: ${err && err.message ? err.message : err}`);
}

lines.push('');
lines.push(failed ? `${failed} failed` : 'all good');
return { failed, text: lines.join('\n') };
