/* Tests for the animation set — the thing that lets one character have
 * twelve animations and lets you edit any of them whenever you like.
 *
 * What is worth testing here is not that a list holds things. It is that
 * switching away from an animation does not lose the edit you just made,
 * that merging deletes exactly one of the two and remembers which, and that
 * undo can put a merge back — because the merge is the one action here that
 * throws something away.
 *
 *   node --import ./tests/register.mjs tests/animset.test.mjs
 */

import * as THREE from 'three';
import { Clip } from '../web/clip.js';
import { AnimSet } from '../web/animset.js';

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

/** A stand-in for what the glTF loader hands over. */
const source = (name, seconds = 1) => ({ name, duration: seconds });

const item = { path: '/Users/x/game/assets/athlete.glb', name: 'athlete.glb' };

/** A stand-in for reading one of the file's animations into keys. */
let made = 0;
const make = (from) => {
  made++;
  const clip = new Clip({ name: from.name, frames: 24 });
  clip.setKey('hip', 0, new THREE.Quaternion(), new THREE.Vector3());
  clip.setKey('hip', 12, new THREE.Quaternion(0, 0, 0.3, 0.95), new THREE.Vector3());
  return clip;
};

const twelve = ['argue', 'backhand', 'celebrate', 'forehand', 'idle', 'lunge',
                'ready', 'run', 'serve', 'smash', 'tired', 'walk'].map((n) => source(n));

// ── what a character arrives with ────────────────────────────────────

test('a character with twelve animations has twelve entries', () => {
  const set = AnimSet.fromModel(item, twelve);
  assert(set.length === 12, `expected 12, got ${set.length}`);
  assert(set.names()[7] === 'run', 'run is where it was in the file');
});

test('a model with no animations still gets one entry to work in', () => {
  const set = AnimSet.fromModel(item, []);
  assert(set.length === 1, 'one empty entry');
  assert(set.entries[0].name === 'athlete', 'named after the model, without the extension');
  assert(set.entries[0].from === null, 'it came from no animation in the file');
});

test('nothing is read out of the file until it is opened', () => {
  made = 0;
  const set = AnimSet.fromModel(item, twelve);
  assert(set.entries.every((e) => e.clip === null), 'no keys yet');
  set.open(7, make);
  assert(made === 1, `only the one opened was sampled, not ${made}`);
  assert(set.entries[7].clip !== null, 'the one opened has keys');
  assert(set.entries[0].clip === null, 'the others still do not');
});

test('opening the same one twice does not sample it twice', () => {
  made = 0;
  const set = AnimSet.fromModel(item, twelve);
  set.open(3, make);
  set.open(3, make);
  assert(made === 1, `sampled ${made} times`);
});

// ── switching without losing work ────────────────────────────────────

test('an edit survives switching to another animation and back', () => {
  const set = AnimSet.fromModel(item, twelve);
  const run = set.open(7, make);
  run.setKey('hand', 6, new THREE.Quaternion(0, 0.5, 0, 0.866), new THREE.Vector3());
  set.stash(run);

  set.open(11, make);                    // off to the walk
  const back = set.open(7, make);        // and back to the run
  assert(back.hasKey('hand', 6), 'the key set on the run is still there');
  assert(set.entries[7].dirty, 'and the run is still marked as edited');
});

test('an animation nobody touched is not marked as edited', () => {
  const set = AnimSet.fromModel(item, twelve);
  const run = set.open(7, make);
  set.stash(run);
  assert(!set.entries[7].dirty, 'merely looking at it is not an edit');
  assert(!set.dirty, 'and the set as a whole has nothing outstanding');
});

test('the set knows which animations have been edited', () => {
  const set = AnimSet.fromModel(item, twelve);
  for (const i of [1, 7]) {
    const clip = set.open(i, make);
    clip.setKey('hip', 3, new THREE.Quaternion(), new THREE.Vector3());
    set.stash(clip);
  }
  const edited = set.edited().map((e) => e.name);
  assert(edited.length === 2, `expected 2 edited, got ${edited.length}`);
  assert(edited.includes('run') && edited.includes('backhand'), edited.join(', '));
});

// ── merging ──────────────────────────────────────────────────────────

test('merging keeps one and deletes the other', () => {
  const set = AnimSet.fromModel(item, [source('run1'), source('run2'), source('idle')]);
  const done = set.merge(0, 1, make);
  assert(done.kept === 'run1' && done.dropped === 'run2', JSON.stringify(done));
  assert(set.length === 2, 'two animations left');
  assert(!set.names().includes('run2'), 'run2 is gone from the list');
  assert(set.names().includes('idle'), 'and nothing else was disturbed');
});

test('the keeper carries the motion, and is marked as edited', () => {
  const set = AnimSet.fromModel(item, [source('run1'), source('run2')]);
  set.merge(0, 1, make);
  assert(set.entries[0].clip !== null, 'the keeper has real keys');
  assert(set.entries[0].dirty, 'and something now needs writing');
});

test('the deleted name is remembered, so the game file loses it too', () => {
  const set = AnimSet.fromModel(item, [source('run1'), source('run2')]);
  set.merge(0, 1, make);
  assert(set.removed.join() === 'run2', `removed: ${set.removed.join()}`);
  assert(set.push().remove.join() === 'run2', 'and it is in what gets pushed');
});

test('keeping the second one deletes the first', () => {
  const set = AnimSet.fromModel(item, [source('run1'), source('run2')]);
  const done = set.merge(1, 0, make);
  assert(done.kept === 'run2', done.kept);
  assert(set.names().join() === 'run2', set.names().join());
});

test('merging away the animation that is open leaves the keeper open', () => {
  const set = AnimSet.fromModel(item, [source('a'), source('b'), source('c')]);
  set.open(2, make);                  // c is open
  set.merge(0, 2, make);              // keep a, delete c
  assert(set.current.name === 'a', `left open: ${set.current.name}`);
});

test('merging something before the open one keeps the right one open', () => {
  const set = AnimSet.fromModel(item, [source('a'), source('b'), source('c')]);
  set.open(2, make);                  // c is open
  set.merge(1, 0, make);              // keep b, delete a
  assert(set.current.name === 'c', `left open: ${set.current.name}`);
});

test('a merge into itself does nothing', () => {
  const set = AnimSet.fromModel(item, [source('a'), source('b')]);
  assert(set.merge(1, 1, make) === null, 'refused');
  assert(set.length === 2, 'both still there');
});

// ── a new animation from nothing ─────────────────────────────────────

test('a new animation can be added to a character that already has twelve', () => {
  const set = AnimSet.fromModel(item, twelve);
  const at = set.add('celebrate harder');
  assert(set.length === 13, `expected 13, got ${set.length}`);
  assert(set.entries[at].from === null, 'it is not in the file yet');
  const clip = set.open(at, make);
  assert(clip.isEmpty(), 'and it opens as an empty timeline');
});

test('a new animation does not take a name the character already uses', () => {
  const set = AnimSet.fromModel(item, twelve);
  const at = set.add('run');
  assert(set.entries[at].name === 'run 2', set.entries[at].name);
  assert(set.names().filter((n) => n === 'run').length === 1, 'the real run is untouched');
});

test('a new animation is added to the file rather than replacing one', () => {
  const set = AnimSet.fromModel(item, twelve);
  const at = set.add('slide');
  const clip = set.open(at, make);
  clip.setKey('hip', 0, new THREE.Quaternion(), new THREE.Vector3());
  set.entries[at].dirty = true;
  set.stash(clip);
  const { clips, remove } = set.push();
  assert(clips.some((c) => c.name === 'slide'), 'it is in what gets pushed');
  assert(remove.length === 0, 'and nothing is deleted to make room for it');
});

// ── deleting ─────────────────────────────────────────────────────────

test('deleting takes the animation out and queues its name for the file', () => {
  const set = AnimSet.fromModel(item, twelve);
  const done = set.remove([7]);
  assert(done.names.join() === 'run', done.names.join());
  assert(set.length === 11, `expected 11, got ${set.length}`);
  assert(!set.names().includes('run'), 'gone from the list');
  assert(set.removed.join() === 'run', 'and queued for the .glb');
});

test('deleting several at once removes exactly those', () => {
  const set = AnimSet.fromModel(item, twelve);
  const done = set.remove([0, 4, 11]);
  assert(done.names.join() === 'argue,idle,walk', done.names.join());
  assert(set.length === 9, `expected 9, got ${set.length}`);
  for (const n of ['argue', 'idle', 'walk']) assert(!set.names().includes(n), n);
  assert(set.names().includes('run'), 'and left the rest alone');
});

test('deleting above the open one does not change which is open', () => {
  const set = AnimSet.fromModel(item, twelve);
  set.open(7, make);                    // run
  const done = set.remove([1]);         // backhand, above it
  assert(!done.lostOpen, 'the open one survived');
  assert(set.current.name === 'run', `open: ${set.current.name}`);
});

test('deleting the open one says so, so its clip is not put down elsewhere', () => {
  const set = AnimSet.fromModel(item, twelve);
  set.open(7, make);
  const done = set.remove([7]);
  assert(done.lostOpen, 'the caller is told');
  assert(set.current && set.current.name !== 'run', `open: ${set.current.name}`);
});

test('deleting every animation leaves an empty one to work in', () => {
  const set = AnimSet.fromModel(item, twelve);
  set.remove(twelve.map((_, i) => i));
  assert(set.length === 1, `expected 1, got ${set.length}`);
  assert(set.entries[0].name === 'athlete', set.entries[0].name);
  assert(set.entries[0].from === null, 'it is not in the file');
  assert(set.removed.length === 12, `all 12 queued, got ${set.removed.length}`);
});

test('a never-saved animation leaves nothing behind when deleted', () => {
  const set = AnimSet.fromModel(item, twelve);
  const at = set.add('sketch');
  set.remove([at]);
  assert(set.length === 12, 'back to twelve');
  assert(set.removed.length === 0, 'nothing to delete from the file, it was never in it');
});

test('undo brings a deleted animation back', () => {
  const set = AnimSet.fromModel(item, twelve);
  const shot = set.toJSON();
  set.remove([7]);
  set.restore(shot);
  assert(set.length === 12, `expected 12, got ${set.length}`);
  assert(set.names().includes('run'), 'run is back');
  assert(set.removed.length === 0, 'and is no longer queued for deletion');
});

test('deleting nothing is refused rather than half-done', () => {
  const set = AnimSet.fromModel(item, twelve);
  assert(set.remove([]) === null, 'empty');
  assert(set.remove([99]) === null, 'out of range');
  assert(set.length === 12, 'untouched');
});

// ── undo ─────────────────────────────────────────────────────────────

test('a photograph of the set shares nothing with it', () => {
  const set = AnimSet.fromModel(item, twelve);
  const clip = set.open(7, make);
  set.stash(clip);
  const shot = set.toJSON();
  clip.setKey('hip', 20, new THREE.Quaternion(), new THREE.Vector3());
  set.merge(0, 1, make);

  const keys = shot.entries[7].clip.tracks.hip.length;
  assert(keys === 2, `the photograph grew to ${keys} keys along with the clip`);
  assert(shot.entries.length === 12, 'and lost an entry along with the set');
});

test('undoing a merge brings the animation back', () => {
  const set = AnimSet.fromModel(item, [source('run1'), source('run2'), source('idle')]);
  const before = set.toJSON();
  set.merge(0, 1, make);
  assert(set.length === 2, 'merged');

  set.restore(before);
  assert(set.length === 3, 'and back again');
  assert(set.names().includes('run2'), 'run2 is in the list once more');
  assert(set.removed.length === 0, 'and nothing is queued for deletion any more');
  assert(set.sources.get('run2'), "the file's own copy of it was never thrown away");
});

test('restoring keeps the keys that were made, not the file`s', () => {
  const set = AnimSet.fromModel(item, twelve);
  const clip = set.open(7, make);
  clip.setKey('hand', 9, new THREE.Quaternion(), new THREE.Vector3());
  set.stash(clip);
  const shot = set.toJSON();

  clip.removeKey('hand', 9);
  set.restore(shot);
  assert(set.entries[7].clip.hasKey('hand', 9), 'the key came back');
  assert(set.entries[7].dirty, 'and it is still an edit');
});

// ── what leaves gerak ────────────────────────────────────────────────

test('only the edited animations are pushed', () => {
  const set = AnimSet.fromModel(item, twelve);
  const clip = set.open(9, make);         // smash
  clip.setKey('hip', 4, new THREE.Quaternion(), new THREE.Vector3());
  set.stash(clip);
  set.open(0, make);                      // looked at, not edited

  const { clips } = set.push();
  assert(clips.length === 1, `pushing ${clips.length} animations`);
  assert(clips[0].name === 'smash', clips[0].name);
});

test('a pushed clip carries the name the game plays it by', () => {
  const set = AnimSet.fromModel(item, twelve);
  const clip = set.open(7, make);
  clip.name = 'something else entirely';
  clip.dirty = true;
  set.entries[7].name = 'run';            // the list still says run
  set.stash(clip);
  assert(set.push().clips[0].name === 'something else entirely',
         'renaming through the clip renames the entry');
});

test('once everything is written down, nothing is outstanding', () => {
  const set = AnimSet.fromModel(item, [source('run1'), source('run2')]);
  set.merge(0, 1, make);
  assert(set.dirty, 'something to do');
  set.settled();
  assert(!set.dirty, 'and now nothing');
  assert(set.push().clips.length === 0 && set.push().remove.length === 0,
         'a second push would write nothing');
});

test('a brand new animation counts as part of the file after it is pushed', () => {
  const set = AnimSet.fromModel(item, []);
  const clip = set.open(0, make);
  clip.setKey('hip', 0, new THREE.Quaternion(), new THREE.Vector3());
  set.stash(clip);
  assert(set.entries[0].from === null, 'it is not in the file yet');
  set.settled();
  assert(set.entries[0].from === 'athlete', 'and now it is, under its own name');
});

console.log('\n── the animation set ────────────────────────────────────');
results.forEach((line) => console.log(line));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
