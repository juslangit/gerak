/* Tests for the IK solver.
 *
 * The question an IK solver has to answer is simply "did the hand end up
 * where I put it". That is easy to measure and hard to fake, so most of what
 * follows is exactly that measurement, under the conditions that break naive
 * solvers: a target out of reach, a target on top of the shoulder, a limb
 * that is already perfectly straight, and a chain longer than two bones.
 *
 *   node --import ./tests/register.mjs tests/ik.test.mjs
 */

import * as THREE from 'three';
import { IKChain, detectLimbs, chainFrom, mirrorName, findMirror } from '../web/ik.js';

let passed = 0, failed = 0;
const results = [];

function test(name, fn) {
  try { fn(); passed++; results.push(`  ok   ${name}`); }
  catch (err) { failed++; results.push(`  FAIL ${name}\n         ${err.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

/**
 * An arm hanging down the -Y axis: shoulder at the top, elbow one unit
 * below, hand one unit below that. Everything is parented so the bones move
 * the way a real rig's do.
 */
function makeArm(names = ['LeftArm', 'LeftForeArm', 'LeftHand']) {
  const holder = new THREE.Object3D();
  const shoulder = new THREE.Bone(); shoulder.name = names[0];
  const elbow = new THREE.Bone(); elbow.name = names[1]; elbow.position.set(0, -1, 0);
  const hand = new THREE.Bone(); hand.name = names[2]; hand.position.set(0, -1, 0);
  holder.add(shoulder); shoulder.add(elbow); elbow.add(hand);

  // Start with a small bend, so the solver has a bend direction to keep.
  elbow.rotation.z = 0.25;
  holder.updateMatrixWorld(true);
  return { holder, shoulder, elbow, hand, bones: [shoulder, elbow, hand] };
}

function tipAt(chain) {
  const v = new THREE.Vector3();
  chain.tip.getWorldPosition(v);
  return v;
}

// ── two bones: the exact case ───────────────────────────────────────

test('the hand lands on a target it can reach', () => {
  const arm = makeArm();
  const chain = new IKChain(arm.bones, 'Left arm');
  const target = new THREE.Vector3(1.1, -1.2, 0.3);
  chain.solve(target);
  const off = tipAt(chain).distanceTo(target);
  assert(off < 1e-4, `the hand is ${off.toFixed(5)} away from where it was put`);
});

test('it lands on target after target, without drifting', () => {
  const arm = makeArm();
  const chain = new IKChain(arm.bones, 'Left arm');
  const targets = [
    new THREE.Vector3(1.4, -0.9, 0), new THREE.Vector3(-0.8, -1.5, 0.4),
    new THREE.Vector3(0.2, -1.9, -0.3), new THREE.Vector3(1.0, 0.4, 0.9),
    new THREE.Vector3(0, -2, 0),
  ];
  let worst = 0;
  for (const t of targets) {
    chain.solve(t);
    worst = Math.max(worst, tipAt(chain).distanceTo(t));
  }
  assert(worst < 1e-4, `worst miss over five drags was ${worst.toFixed(5)}`);
});

test('a target out of reach straightens the limb and points it there', () => {
  const arm = makeArm();
  const chain = new IKChain(arm.bones, 'Left arm');
  const far = new THREE.Vector3(0, -40, 0);
  chain.solve(far);

  const shoulder = new THREE.Vector3(), elbow = new THREE.Vector3(), hand = new THREE.Vector3();
  arm.shoulder.getWorldPosition(shoulder);
  arm.elbow.getWorldPosition(elbow);
  arm.hand.getWorldPosition(hand);

  const reach = shoulder.distanceTo(hand);
  assert(reach > 1.99 && reach < 2.001, `should be nearly straight, reach is ${reach.toFixed(4)}`);

  // and pointing at the target
  const wanted = far.clone().sub(shoulder).normalize();
  const actual = hand.clone().sub(shoulder).normalize();
  assert(actual.dot(wanted) > 0.9999, 'the straightened arm does not point at the target');
  assert(Number.isFinite(reach), 'the solver produced a NaN');
});

test('a target right on the shoulder does not blow up', () => {
  const arm = makeArm();
  const chain = new IKChain(arm.bones, 'Left arm');
  const shoulder = new THREE.Vector3();
  arm.shoulder.getWorldPosition(shoulder);
  chain.solve(shoulder.clone());
  const hand = tipAt(chain);
  assert(Number.isFinite(hand.x) && Number.isFinite(hand.y) && Number.isFinite(hand.z),
    'the solver produced a NaN when folded onto itself');
});

test('an already-straight limb can still be bent to a near target', () => {
  const arm = makeArm();
  arm.elbow.rotation.z = 0;                 // perfectly straight, the awkward case
  arm.holder.updateMatrixWorld(true);
  const chain = new IKChain(arm.bones, 'Left arm');
  const near = new THREE.Vector3(0.9, -0.9, 0);
  chain.solve(near);
  const off = tipAt(chain).distanceTo(near);
  assert(off < 1e-3, `missed by ${off.toFixed(5)} from a straight start`);
});

test('the elbow keeps bending the way it was already bending', () => {
  const arm = makeArm();
  arm.elbow.rotation.z = 0.5;               // bend one way
  arm.holder.updateMatrixWorld(true);
  const chain = new IKChain(arm.bones, 'Left arm');

  /* Which way a limb is bent is not the elbow's own position - turning an
   * elbow moves the hand, not the elbow. It is where the elbow sits relative
   * to the straight line from shoulder to hand. That offset is the thing a
   * pole target exists to preserve, and the thing that flips when a solver
   * gets its bend axis backwards. */
  const bendOffset = () => {
    const s = new THREE.Vector3(), e = new THREE.Vector3(), h = new THREE.Vector3();
    arm.shoulder.getWorldPosition(s);
    arm.elbow.getWorldPosition(e);
    arm.hand.getWorldPosition(h);
    const along = h.clone().sub(s).normalize();
    const out = e.clone().sub(s);
    return out.sub(along.multiplyScalar(out.dot(along)));
  };

  const before = bendOffset();
  assert(before.length() > 1e-3, 'the test arm is not actually bent');

  chain.solve(new THREE.Vector3(0.3, -1.7, 0));
  const after = bendOffset();

  assert(after.length() > 1e-3, 'the arm went dead straight instead of bending');
  assert(before.clone().normalize().dot(after.clone().normalize()) > 0.9,
    `the elbow flipped to the other side (${before.clone().normalize().dot(after.clone().normalize()).toFixed(3)})`);
});

test('the elbow flips when the pole is moved to the other side', () => {
  const arm = makeArm();
  arm.elbow.rotation.z = 0.5;
  arm.holder.updateMatrixWorld(true);
  const chain = new IKChain(arm.bones, 'Left arm');

  const elbowX = () => {
    const e = new THREE.Vector3();
    arm.elbow.getWorldPosition(e);
    return e.x;
  };

  chain.solve(new THREE.Vector3(0, -1.6, 0));
  const withDefaultPole = elbowX();

  // Put the pole firmly on the far side and solve the same target again.
  chain.pole.set(-withDefaultPole * 6 || -3, -0.8, 0);
  chain.solve(new THREE.Vector3(0, -1.6, 0));
  const withMovedPole = elbowX();

  assert(Math.sign(withMovedPole) !== Math.sign(withDefaultPole),
    `the pole did not steer the elbow (${withDefaultPole.toFixed(3)} then ${withMovedPole.toFixed(3)})`);
});

test('solving leaves ordinary bone rotations behind, not constraints', () => {
  const arm = makeArm();
  const chain = new IKChain(arm.bones, 'Left arm');
  chain.solve(new THREE.Vector3(1.2, -1.1, 0.2));
  for (const bone of arm.bones) {
    assert(bone.quaternion.isQuaternion, 'a bone lost its rotation');
    assert(Number.isFinite(bone.quaternion.w), 'a bone rotation went NaN');
  }
  // This is the property that makes the export clean: nothing about the
  // chain survives on the bones themselves.
  assert(!('constraint' in arm.shoulder) && !arm.shoulder.userData.ik,
    'the solver left machinery on the bone');
});

// ── longer chains ───────────────────────────────────────────────────

test('a five-bone chain reaches its target too', () => {
  const holder = new THREE.Object3D();
  const bones = [];
  let parent = holder;
  for (let i = 0; i < 5; i++) {
    const b = new THREE.Bone();
    b.name = `Spine${i}`;
    if (i) b.position.set(0, 1, 0);
    parent.add(b);
    bones.push(b);
    parent = b;
  }
  bones[1].rotation.z = 0.1;
  holder.updateMatrixWorld(true);

  const chain = new IKChain(bones, 'Spine');
  const target = new THREE.Vector3(1.5, 2.5, 0.5);
  chain.solve(target);
  const off = tipAt(chain).distanceTo(target);
  assert(off < 1e-3, `the chain tip missed by ${off.toFixed(5)}`);
});

// ── finding the limbs on a real-shaped skeleton ─────────────────────

function humanoid(naming) {
  const n = naming;
  const holder = new THREE.Object3D();
  const bone = (name, parent, y = 1) => {
    const b = new THREE.Bone(); b.name = name; b.position.set(0, y, 0);
    parent.add(b); return b;
  };
  const hips = bone(n('Hips'), holder, 0);
  const spine = bone(n('Spine'), hips);
  const bones = [hips, spine];
  for (const side of ['Left', 'Right']) {
    const up = bone(n(`${side}Arm`), spine);
    const fore = bone(n(`${side}ForeArm`), up);
    const hand = bone(n(`${side}Hand`), fore);
    const finger = bone(n(`${side}HandIndex1`), hand);
    const upLeg = bone(n(`${side}UpLeg`), hips, -1);
    const leg = bone(n(`${side}Leg`), upLeg, -1);
    const foot = bone(n(`${side}Foot`), leg, -1);
    const toe = bone(n(`${side}ToeBase`), foot, -1);
    bones.push(up, fore, hand, finger, upLeg, leg, foot, toe);
  }
  holder.updateMatrixWorld(true);
  return bones;
}

test('four limbs are found on a Meshy-style rig', () => {
  const bones = humanoid((s) => `mixamorig${s}_9`);
  const limbs = detectLimbs(bones);
  assert(limbs.length === 4, `expected 4 limbs, found ${limbs.length}: ${limbs.map((l) => l.label)}`);
  const labels = limbs.map((l) => l.label).sort();
  assert(JSON.stringify(labels) === JSON.stringify(['Left foot', 'Left hand', 'Right foot', 'Right hand']),
    `got ${labels}`);
});

test('four limbs are found on a Blender-style rig', () => {
  const bones = humanoid((s) => s
    .replace(/^Left/, '').replace(/^Right/, '')
    .concat(/^Left/.test(s) ? '.L' : /^Right/.test(s) ? '.R' : ''));
  const limbs = detectLimbs(bones);
  assert(limbs.length === 4, `expected 4 limbs, found ${limbs.length}: ${limbs.map((l) => l.label)}`);
});

test('a four-legged animal gets four distinct limbs, front and hind apart', () => {
  const holder = new THREE.Object3D();
  const bone = (name, parent, y) => {
    const b = new THREE.Bone(); b.name = name; b.position.set(0, y, 0);
    parent.add(b); return b;
  };
  const hips = bone('Hips', holder, 0);
  const chest = bone('Chest', hips, 0.2);
  const bones = [hips, chest];
  for (const side of ['Left', 'Right']) {
    const shoulder = bone(`${side}Shoulder`, chest, -0.1);
    const upper = bone(`${side}UpperArm`, shoulder, -0.4);
    const paw = bone(`${side}Paw`, upper, -0.4);
    const pawTip = bone(`${side}PawTip`, paw, -0.1);
    const thigh = bone(`${side}Thigh`, hips, -0.1);
    const shin = bone(`${side}Shin`, thigh, -0.4);
    const hock = bone(`${side}Hock`, shin, -0.3);
    const hind = bone(`${side}HindPaw`, hock, -0.2);
    bones.push(shoulder, upper, paw, pawTip, thigh, shin, hock, hind);
  }
  holder.updateMatrixWorld(true);

  const limbs = detectLimbs(bones);
  const labels = limbs.map((l) => l.label).sort();
  assert(limbs.length === 4, `expected 4 limbs, got ${limbs.length}: ${labels}`);
  assert(new Set(labels).size === 4, `two limbs share a name: ${labels}`);
  assert(labels.join('|') === 'Left hind paw|Left paw|Right hind paw|Right paw',
    `got ${labels}`);
});

test('the bone past the hand is not read as a second arm', () => {
  const bones = humanoid((s) => s);
  const holder = bones[0].parent;
  for (const side of ['Left', 'Right']) {
    const hand = bones.find((b) => b.name === `${side}Hand`);
    const tip = new THREE.Bone();
    tip.name = `${side}HandTip`;
    tip.position.set(0, 0.2, 0);
    hand.add(tip);
    bones.push(tip);
  }
  holder.updateMatrixWorld(true);
  const limbs = detectLimbs(bones);
  assert(limbs.length === 4,
    `a HandTip produced ${limbs.length} limbs instead of 4: ${limbs.map((l) => l.label)}`);
  assert(limbs.every((l) => !/tip/i.test(l.tip.name)),
    'a limb ends on a tip bone');
});

test('a finger is not mistaken for the end of an arm', () => {
  const bones = humanoid((s) => s);
  const limbs = detectLimbs(bones);
  for (const limb of limbs) {
    assert(!/Index|finger|Toe/i.test(limb.tip.name),
      `chain ends on "${limb.tip.name}", which is not a hand or a foot`);
  }
});

test('each found limb is three bones ending at the hand or foot', () => {
  const bones = humanoid((s) => `mixamorig${s}_9`);
  for (const limb of detectLimbs(bones)) {
    assert(limb.bones.length === 3, `${limb.label} has ${limb.bones.length} bones`);
    assert(/hand|foot/i.test(limb.tip.name), `${limb.label} ends at ${limb.tip.name}`);
    assert(limb.bones[0] === limb.bones[1].parent, `${limb.label} is not a real chain`);
  }
});

test('a chain can be built by hand from any joint', () => {
  const bones = humanoid((s) => s);
  const head = bones.find((b) => /Spine/.test(b.name));
  const chain = chainFrom(head, bones, 3);
  assert(chain, 'no chain was built');
  assert(chain.tip === head, 'the chain should end at the joint you picked');
  assert(chain.bones.length <= 3 && chain.bones.length >= 2, 'wrong chain length');
});

test('a limb reports how far it can reach', () => {
  const arm = makeArm();
  const chain = new IKChain(arm.bones, 'Left arm');
  const reach = chain.reach();
  assert(Math.abs(reach - 2) < 1e-6, `expected a reach of 2, got ${reach}`);
});

// ── finding the other side of the body ──────────────────────────────

test('a side word is swapped, keeping its capitalisation', () => {
  const cases = [
    ['LeftArm', 'RightArm'],
    ['RightArm', 'LeftArm'],
    ['mixamorigLeftHand_12', 'mixamorigRightHand_12'],
    ['hand_left', 'hand_right'],
    ['LeftUpLeg', 'RightUpLeg'],
  ];
  for (const [from, to] of cases) {
    const got = mirrorName(from);
    assert(got === to, `${from} should mirror to ${to}, got ${got}`);
  }
});

test('swapping happens in one pass, or a name would come back unchanged', () => {
  // Replace Left with Right and then Right with Left and you are back where
  // you started - which is the bug this is here to catch.
  assert(mirrorName('LeftHandRight') === 'RightHandLeft',
    `got ${mirrorName('LeftHandRight')}`);
});

test('the .L and _R conventions swap too', () => {
  assert(mirrorName('hand.L') === 'hand.R', `got ${mirrorName('hand.L')}`);
  assert(mirrorName('Bip01_R_Hand') === 'Bip01_L_Hand', `got ${mirrorName('Bip01_R_Hand')}`);
});

test('a joint with no side is left alone', () => {
  for (const name of ['Hips', 'Spine', 'Head', 'mixamorigSpine1_4']) {
    assert(mirrorName(name) === name, `${name} should not have a side`);
  }
});

test('the opposite joint is found even when the two carry different numbers', () => {
  /* This is the case that matters, and the one the old code could not do.
   * Meshy hangs a node index on every bone, and the index on the left arm is
   * not the index on the right arm - so a straight name swap produces a name
   * that does not exist anywhere on the model. */
  const names = ['mixamorigHips_34', 'mixamorigLeftArm_29', 'mixamorigRightArm_14',
                 'mixamorigLeftHand_12', 'mixamorigRightHand_7'];
  assert(findMirror('mixamorigLeftArm_29', names) === 'mixamorigRightArm_14',
    `got ${findMirror('mixamorigLeftArm_29', names)}`);
  assert(findMirror('mixamorigRightHand_7', names) === 'mixamorigLeftHand_12',
    `got ${findMirror('mixamorigRightHand_7', names)}`);
});

test('a joint with no opposite number reports none rather than itself', () => {
  const names = ['Hips', 'Spine', 'LeftArm'];
  assert(findMirror('Hips', names) === null, 'Hips should have no opposite');
  assert(findMirror('LeftArm', names) === null,
    'there is no RightArm on this model, so there is no opposite');
});

console.log('\ngerak — inverse kinematics\n');
console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
