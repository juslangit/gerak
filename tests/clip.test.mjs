/* Tests for the animation maths.
 *
 * Everything you can see on screen is easy to check by looking at it. The
 * part you cannot check by looking is whether frame 9 really sits between
 * the keys at 6 and 12, whether a joint you never touched stays exactly
 * where the model was built, and whether the file that comes out says the
 * same thing as the timeline that went in. That is what is tested here.
 *
 *   node --import ./tests/register.mjs tests/clip.test.mjs
 */

import * as THREE from 'three';
import { Clip } from '../web/clip.js';

let passed = 0, failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push(`  ok   ${name}`);
  } catch (err) {
    failed++;
    results.push(`  FAIL ${name}\n         ${err.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function close(a, b, eps = 1e-5, msg = '') {
  assert(Math.abs(a - b) < eps, `${msg} expected ${b}, got ${a}`);
}
function quatClose(q, expected, eps = 1e-4, msg = '') {
  // A quaternion and its negation are the same rotation, so compare the
  // angle between them rather than the four numbers.
  const dot = Math.abs(q.x * expected.x + q.y * expected.y + q.z * expected.z + q.w * expected.w);
  assert(dot > 1 - eps, `${msg} rotations differ (dot ${dot.toFixed(6)})`);
}

/** A small three-bone chain, the shape of an arm. */
function makeRig() {
  const root = new THREE.Bone(); root.name = 'Hips';
  const upper = new THREE.Bone(); upper.name = 'LeftArm'; upper.position.set(0, 1, 0);
  const lower = new THREE.Bone(); lower.name = 'LeftForeArm'; lower.position.set(0, 1, 0);
  root.add(upper); upper.add(lower);
  const bones = [root, upper, lower];
  const rest = new Map(bones.map((b) => [b.name, {
    q: b.quaternion.clone(), p: b.position.clone(), s: b.scale.clone(),
  }]));
  return { bones, rest, root };
}

const qz = (deg) => new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(deg));

// ── keys ────────────────────────────────────────────────────────────

test('a key can be set, found and removed', () => {
  const clip = new Clip();
  const v = new THREE.Vector3(0, 1, 0);
  clip.setKey('LeftArm', 6, qz(40), v);
  assert(clip.hasKey('LeftArm', 6), 'key not found after being set');
  assert(!clip.hasKey('LeftArm', 7), 'found a key on a frame that has none');
  assert(clip.totalKeys() === 1, 'wrong key count');
  assert(clip.removeKey('LeftArm', 6), 'remove reported failure');
  assert(clip.isEmpty(), 'clip should be empty again');
});

test('keying the same frame twice replaces rather than duplicates', () => {
  const clip = new Clip();
  const v = new THREE.Vector3();
  clip.setKey('LeftArm', 6, qz(10), v);
  clip.setKey('LeftArm', 6, qz(80), v);
  assert(clip.keysOf('LeftArm').length === 1, 'duplicate key at one frame');
  quatClose(new THREE.Quaternion().fromArray(clip.keysOf('LeftArm')[0].q), qz(80),
    1e-4, 'the second key did not win.');
});

test('keys stay in frame order however they are added', () => {
  const clip = new Clip();
  const v = new THREE.Vector3();
  for (const f of [24, 0, 12, 6]) clip.setKey('LeftArm', f, qz(f), v);
  const frames = clip.keysOf('LeftArm').map((k) => k.f);
  assert(JSON.stringify(frames) === JSON.stringify([0, 6, 12, 24]),
    `out of order: ${frames}`);
});

// ── the frames in between ───────────────────────────────────────────

test('halfway between two keys is halfway between two rotations', () => {
  const clip = new Clip();
  const v = new THREE.Vector3();
  clip.setKey('LeftArm', 0, qz(0), v);
  clip.setKey('LeftArm', 10, qz(90), v);
  const at5 = clip.sample('LeftArm', 5);
  quatClose(at5.q, qz(45), 1e-4, 'frame 5 of a 0-to-90 swing');
});

test('a quarter of the way is a quarter of the rotation', () => {
  const clip = new Clip();
  const v = new THREE.Vector3();
  clip.setKey('Hips', 0, qz(0), v);
  clip.setKey('Hips', 12, qz(60), v);
  quatClose(clip.sample('Hips', 3).q, qz(15), 1e-4, 'frame 3 of 12');
  quatClose(clip.sample('Hips', 9).q, qz(45), 1e-4, 'frame 9 of 12');
});

test('positions travel in a straight line between keys', () => {
  const clip = new Clip();
  clip.setKey('Hips', 0, qz(0), new THREE.Vector3(0, 0, 0));
  clip.setKey('Hips', 8, qz(0), new THREE.Vector3(4, 2, -8));
  const p = clip.sample('Hips', 6).p;
  close(p.x, 3, 1e-5, 'x at three quarters:');
  close(p.y, 1.5, 1e-5, 'y at three quarters:');
  close(p.z, -6, 1e-5, 'z at three quarters:');
});

test('the pose holds before the first key and after the last', () => {
  const clip = new Clip();
  const v = new THREE.Vector3();
  clip.setKey('LeftArm', 10, qz(30), v);
  clip.setKey('LeftArm', 20, qz(70), v);
  quatClose(clip.sample('LeftArm', 0).q, qz(30), 1e-4, 'before the first key');
  quatClose(clip.sample('LeftArm', 99).q, qz(70), 1e-4, 'after the last key');
});

test('a joint that was never keyed reports nothing', () => {
  const clip = new Clip();
  clip.setKey('LeftArm', 0, qz(0), new THREE.Vector3());
  assert(clip.sample('RightArm', 0) === null, 'an unkeyed joint returned a pose');
});

test('easing starts and ends slower than the straight-line version', () => {
  const v = new THREE.Vector3();
  const linear = new Clip({ interp: 'linear' });
  const eased = new Clip({ interp: 'ease' });
  for (const clip of [linear, eased]) {
    clip.setKey('Hips', 0, qz(0), v);
    clip.setKey('Hips', 10, qz(90), v);
  }
  const angle = (q) => 2 * Math.acos(Math.min(1, Math.abs(q.w)));
  assert(angle(eased.sample('Hips', 1).q) < angle(linear.sample('Hips', 1).q),
    'eased motion should lag at the start');
  assert(angle(eased.sample('Hips', 9).q) > angle(linear.sample('Hips', 9).q),
    'eased motion should lead at the end');
  quatClose(eased.sample('Hips', 5).q, linear.sample('Hips', 5).q, 1e-4,
    'both should agree exactly in the middle');
});

// ── applying a clip to a real skeleton ──────────────────────────────

test('applying a clip poses the keyed joints', () => {
  const { bones, rest } = makeRig();
  const clip = new Clip();
  clip.setKey('LeftArm', 0, qz(0), new THREE.Vector3(0, 1, 0));
  clip.setKey('LeftArm', 10, qz(90), new THREE.Vector3(0, 1, 0));
  clip.applyTo(bones, rest, 5);
  quatClose(bones[1].quaternion, qz(45), 1e-4, 'LeftArm at frame 5');
});

test('a joint you never touched stays exactly as the model was built', () => {
  const { bones, rest } = makeRig();
  bones[2].quaternion.copy(qz(80));          // someone left the forearm bent
  const clip = new Clip();
  clip.setKey('LeftArm', 0, qz(45), new THREE.Vector3(0, 1, 0));
  clip.applyTo(bones, rest, 0);
  quatClose(bones[2].quaternion, rest.get('LeftForeArm').q, 1e-6,
    'the unkeyed forearm should have snapped back to its rest pose.');
});

test('applying frame by frame gives the same answer every time', () => {
  const { bones, rest } = makeRig();
  const clip = new Clip();
  clip.setKey('LeftArm', 0, qz(0), new THREE.Vector3(0, 1, 0));
  clip.setKey('LeftArm', 24, qz(120), new THREE.Vector3(0, 1, 0));
  clip.applyTo(bones, rest, 12);
  const first = bones[1].quaternion.clone();
  for (const f of [0, 24, 3, 19, 12]) clip.applyTo(bones, rest, f);
  quatClose(bones[1].quaternion, first, 1e-9, 'scrubbing around and back');
});

// ── what gets written into the file ─────────────────────────────────

test('export writes one rotation track per keyed joint, at the right times', () => {
  const { bones } = makeRig();
  const clip = new Clip({ fps: 24, frames: 24 });
  const v = new THREE.Vector3(0, 1, 0);
  clip.setKey('LeftArm', 0, qz(0), v);
  clip.setKey('LeftArm', 12, qz(90), v);
  clip.setKey('LeftForeArm', 6, qz(20), v);

  const out = clip.toAnimationClip(bones);
  const rot = out.tracks.filter((t) => t.name.endsWith('.quaternion'));
  assert(rot.length === 2, `expected 2 rotation tracks, got ${rot.length}`);

  const arm = rot.find((t) => t.name.startsWith(bones[1].uuid));
  assert(arm, 'the arm track is not named after the arm bone');
  close(arm.times[0], 0, 1e-6, 'first key time:');
  close(arm.times[1], 0.5, 1e-6, 'a key on frame 12 at 24fps is half a second:');
  close(out.duration, 1, 1e-6, '24 frames at 24fps is one second:');
});

test('export leaves out a position track for a joint that only rotates', () => {
  const { bones } = makeRig();
  const clip = new Clip();
  const v = new THREE.Vector3(0, 1, 0);
  clip.setKey('LeftArm', 0, qz(0), v);
  clip.setKey('LeftArm', 12, qz(90), v);
  assert(!clip.toAnimationClip(bones).tracks.some((t) => t.name.endsWith('.position')),
    'wrote a position track for a joint that never moved');
});

test('export writes a position track for a joint that does travel', () => {
  const { bones } = makeRig();
  const clip = new Clip();
  clip.setKey('Hips', 0, qz(0), new THREE.Vector3(0, 0, 0));
  clip.setKey('Hips', 12, qz(0), new THREE.Vector3(0, 0, 3));
  assert(clip.toAnimationClip(bones).tracks.some((t) => t.name.endsWith('.position')),
    'a travelling root lost its position track');
});

test('export stretches the last pose out to the end of the clip', () => {
  const { bones } = makeRig();
  const clip = new Clip({ fps: 24, frames: 48 });
  const v = new THREE.Vector3(0, 1, 0);
  clip.setKey('LeftArm', 0, qz(0), v);
  clip.setKey('LeftArm', 24, qz(90), v);      // last key is halfway along

  const out = clip.toAnimationClip(bones);
  close(out.duration, 2, 1e-6, '48 frames at 24fps:');
  const track = out.tracks.find((t) => t.name.endsWith('.quaternion'));
  close(track.times[track.times.length - 1], 2, 1e-6,
    'the final written key should sit at the end of the clip:');
  assert(clip.keysOf('LeftArm').length === 2,
    'the timeline itself must not gain a key from being exported');
});

test('export adds no padding key when the clip already ends on one', () => {
  const { bones } = makeRig();
  const clip = new Clip({ fps: 24, frames: 24 });
  const v = new THREE.Vector3(0, 1, 0);
  clip.setKey('LeftArm', 0, qz(0), v);
  clip.setKey('LeftArm', 24, qz(90), v);
  const track = clip.toAnimationClip(bones).tracks.find((t) => t.name.endsWith('.quaternion'));
  assert(track.times.length === 2, `expected 2 keys, got ${track.times.length}`);
});

test('export names tracks by bone id, so punctuated bone names survive', () => {
  const root = new THREE.Bone(); root.name = 'mixamorig:Hips';
  const arm = new THREE.Bone(); arm.name = 'arm.L';
  root.add(arm);
  const bones = [root, arm];
  const clip = new Clip();
  clip.setKey('arm.L', 0, qz(10), new THREE.Vector3());
  const track = clip.toAnimationClip(bones).tracks[0];
  const nodeName = track.name.split('.')[0];
  assert(nodeName === arm.uuid,
    `track should be named after the bone's id, got "${track.name}"`);
});

// ── reading an animation back out of a model file ───────────────────

test('an animation already in the file becomes editable keys', () => {
  const { bones, rest, root } = makeRig();
  const source = new THREE.AnimationClip('walk', 1, [
    new THREE.QuaternionKeyframeTrack(
      `${bones[1].uuid}.quaternion`,
      new Float32Array([0, 0.5, 1]),
      new Float32Array([
        ...qz(0).toArray(), ...qz(60).toArray(), ...qz(0).toArray(),
      ])),
  ]);

  const imported = Clip.fromAnimationClip(source, bones, rest, 24);
  assert(imported.tracks.has('LeftArm'), 'the moving joint was not imported');
  assert(!imported.tracks.has('LeftForeArm'),
    'a joint that never moves should not get 25 identical keys');

  quatClose(imported.sample('LeftArm', 12).q, qz(60), 2e-2,
    'halfway through the imported walk');
  quatClose(imported.sample('LeftArm', 0).q, qz(0), 2e-2, 'the start of it');

  quatClose(bones[1].quaternion, rest.get('LeftArm').q, 1e-6,
    'the model was left mid-animation after importing.');
});

// ── saving and re-opening ───────────────────────────────────────────

test('a clip saved and re-opened is the same clip', () => {
  const clip = new Clip({ name: 'kick', fps: 30, frames: 40, interp: 'ease' });
  clip.setKey('Hips', 0, qz(5), new THREE.Vector3(0, 1, 0));
  clip.setKey('Hips', 20, qz(55), new THREE.Vector3(0, 1.4, 0.3));
  clip.setKey('LeftArm', 10, qz(15), new THREE.Vector3());

  const back = Clip.fromJSON(JSON.parse(JSON.stringify(clip.toJSON())));
  assert(back.name === 'kick' && back.fps === 30 && back.frames === 40, 'header lost');
  assert(back.interp === 'ease', 'easing setting lost');
  assert(back.totalKeys() === clip.totalKeys(), 'key count changed');
  quatClose(back.sample('Hips', 10).q, clip.sample('Hips', 10).q, 1e-6,
    'the pose halfway through changed across a save');
  assert(!back.dirty, 'a freshly opened clip should not be marked unsaved');
});

test('a saved copy does not change when the clip afterwards does', () => {
  const clip = new Clip();
  const v = new THREE.Vector3(0, 1, 0);
  clip.setKey('Hips', 0, qz(10), v);
  clip.setKey('Hips', 12, qz(50), v);

  const copy = clip.toJSON();
  const keysAtSave = copy.tracks.Hips.length;
  const firstAtSave = copy.tracks.Hips[0].q.slice();

  // Everything that can change a clip, after the copy was taken.
  clip.setKey('Hips', 24, qz(90), v);
  clip.setKey('Hips', 0, qz(80), v);
  clip.shift(5);
  clip.setKey('LeftArm', 3, qz(20), v);

  assert(copy.tracks.Hips.length === keysAtSave,
    `the copy grew from ${keysAtSave} to ${copy.tracks.Hips.length} keys`);
  assert(!copy.tracks.LeftArm, 'a joint keyed later turned up in the copy');
  assert(copy.tracks.Hips[0].f === 0, `the copy's first key moved to frame ${copy.tracks.Hips[0].f}`);
  assert(copy.tracks.Hips[0].q.every((v, i) => v === firstAtSave[i]),
    'the copy\'s first rotation changed underneath it');
});

test('a clip built from a copy shares nothing with it either', () => {
  const clip = new Clip();
  clip.setKey('Hips', 0, qz(10), new THREE.Vector3());
  const copy = clip.toJSON();
  const rebuilt = Clip.fromJSON(copy);

  rebuilt.setKey('Hips', 6, qz(40), new THREE.Vector3());
  rebuilt.shift(3);

  assert(copy.tracks.Hips.length === 1,
    `the copy grew to ${copy.tracks.Hips.length} keys when the rebuilt clip was edited`);
  assert(copy.tracks.Hips[0].f === 0,
    `the copy's key moved to frame ${copy.tracks.Hips[0].f}`);
});

test('the keyed-frames list is every frame that carries a key, in order', () => {
  const clip = new Clip();
  const v = new THREE.Vector3();
  clip.setKey('Hips', 12, qz(0), v);
  clip.setKey('LeftArm', 0, qz(0), v);
  clip.setKey('LeftArm', 12, qz(0), v);      // same frame, different joint
  clip.setKey('LeftForeArm', 30, qz(0), v);
  assert(JSON.stringify(clip.keyedFrames()) === JSON.stringify([0, 12, 30]),
    `got ${clip.keyedFrames()}`);
});

test('shifting a clip moves every key and never goes below zero', () => {
  const clip = new Clip();
  const v = new THREE.Vector3();
  clip.setKey('Hips', 0, qz(0), v);
  clip.setKey('Hips', 10, qz(0), v);
  clip.shift(5);
  assert(JSON.stringify(clip.keysOf('Hips').map((k) => k.f)) === '[5,15]', 'shift forward');
  clip.shift(-20);
  assert(JSON.stringify(clip.keysOf('Hips').map((k) => k.f)) === '[0,0]', 'clamped at zero');
});

// ── report ──────────────────────────────────────────────────────────

console.log('\ngerak — animation maths\n');
console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
