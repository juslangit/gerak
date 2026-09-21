/* Inverse kinematics - working backwards from the hand.
 *
 * Forward kinematics is the plain way round: turn the shoulder, then the
 * elbow, and wherever the hand ends up is where it ends up. It is exact and
 * it is what every animation file stores, but it is a slow way to touch a
 * doorknob.
 *
 * Inverse kinematics is the other way. You say where the hand should BE, and
 * the shoulder and elbow angles are worked out to put it there. That is what
 * "turn IK on" means here.
 *
 * The important thing to understand, because it explains the whole design:
 * IK is only a way of posing. Nothing is stored as IK. When you drag a hand,
 * this file works out the shoulder and elbow rotations and writes those into
 * the bones - so the key that gets saved is ordinary rotations, and the .glb
 * that comes out has no constraints in it for Godot or Unreal to quietly
 * drop.
 */

import * as THREE from 'three';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _t = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _cb = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _at = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _bq = new THREE.Quaternion();

/** Turn a bone by some rotation expressed in world space. */
function rotateInWorld(bone, worldQuat) {
  bone.getWorldQuaternion(_bq);
  if (bone.parent) bone.parent.getWorldQuaternion(_pq); else _pq.identity();
  // new local = (parent world)⁻¹ · rotation · (bone world)
  bone.quaternion.copy(_pq.invert().multiply(worldQuat).multiply(_bq));
  bone.updateMatrixWorld(true);
}

const angleBetween = (u, v) =>
  Math.acos(THREE.MathUtils.clamp(u.dot(v) / (u.length() * v.length() || 1), -1, 1));

export class IKChain {
  /**
   * @param {THREE.Bone[]} bones  root → … → tip, at least two
   * @param {string} label        what to call it on screen
   */
  constructor(bones, label) {
    this.bones = bones;
    this.label = label;
    this.tip = bones[bones.length - 1];
    this.root = bones[0];
    this.enabled = false;
    this.pinned = false;
    this.target = new THREE.Vector3();     // world space
    this.pole = new THREE.Vector3();       // world space, the way the knee points
    this.capture();
  }

  get name() { return this.bones.map((b) => b.name).join('>'); }

  /** Take the target and the bend direction from wherever the limb is now. */
  capture() {
    this.tip.getWorldPosition(this.target);
    if (this.bones.length === 3) {
      // The pole is simply where the elbow currently is, pushed out a little.
      // Keeping it means an arm that was bending forwards goes on bending
      // forwards rather than snapping inside out on the first drag.
      this.bones[0].getWorldPosition(_a);
      this.bones[1].getWorldPosition(_b);
      this.bones[2].getWorldPosition(_c);
      _ac.subVectors(_c, _a);
      const along = _ac.clone().normalize().multiplyScalar(
        _b.clone().sub(_a).dot(_ac.clone().normalize()));
      const out = _b.clone().sub(_a).sub(along);
      this.pole.copy(_b).add(out.multiplyScalar(2));
    }
    return this;
  }

  /** How far the tip can possibly reach from the root. */
  reach() {
    let total = 0;
    for (let i = 0; i < this.bones.length - 1; i++) {
      this.bones[i].getWorldPosition(_a);
      this.bones[i + 1].getWorldPosition(_b);
      total += _a.distanceTo(_b);
    }
    return total;
  }

  solve(targetWorld = this.target) {
    this.target.copy(targetWorld);
    if (this.bones.length === 3) this._solveTwoBone();
    else this._solveCCD();
  }

  /**
   * Two bones - an arm or a leg - have an exact answer, so there is no need
   * to iterate towards one. It comes out in three steps, each of which can
   * be checked on its own:
   *
   *   1. bend the elbow until the hand is exactly as far from the shoulder
   *      as the target is. The triangle of shoulder, elbow and hand has
   *      three known sides, so the law of cosines gives the elbow angle
   *      outright.
   *   2. swing the whole limb from the shoulder so the hand points at the
   *      target. After step 1 the distance is already right, so pointing is
   *      enough to land on it.
   *   3. roll the limb around its own length until the elbow points the way
   *      the pole says. This does not move the hand at all, because the hand
   *      sits on the axis being rolled around.
   */
  _solveTwoBone() {
    const [root, mid, tip] = this.bones;
    root.getWorldPosition(_a);
    mid.getWorldPosition(_b);
    tip.getWorldPosition(_c);
    _t.copy(this.target);

    const lab = _a.distanceTo(_b);
    const lcb = _b.distanceTo(_c);
    if (lab < 1e-8 || lcb < 1e-8) return;

    // Never ask for a distance the limb cannot make, or the cosine falls
    // outside -1..1 and the joint flips inside out.
    // A hair short of dead straight, and a hair off dead folded. The cosine
    // is clamped below as well, so this is only there to keep the limb from
    // locking rigid at full stretch.
    const maxReach = (lab + lcb) * 0.99999;
    const minReach = Math.abs(lab - lcb) * 1.00001 + 1e-7;
    const lat = THREE.MathUtils.clamp(_a.distanceTo(_t), minReach, maxReach);

    // ── 1. the elbow ────────────────────────────────────────────────
    _ab.subVectors(_a, _b);          // elbow → shoulder
    _cb.subVectors(_c, _b);          // elbow → hand
    const elbowNow = angleBetween(_ab, _cb);
    const elbowWant = Math.acos(THREE.MathUtils.clamp(
      (lab * lab + lcb * lcb - lat * lat) / (2 * lab * lcb), -1, 1));

    // Turning the hand away from the shoulder about (shoulder × hand) opens
    // the joint, so that is the axis and the sign needs no guessing.
    _axis.copy(_ab).cross(_cb);
    if (_axis.lengthSq() < 1e-12) {
      // A perfectly straight limb has no plane of its own; borrow one from
      // the pole, which is what says which way a knee is meant to point.
      _axis.copy(_cb).cross(_t.clone().sub(_a));
      if (_axis.lengthSq() < 1e-12) _axis.copy(_cb).cross(this.pole.clone().sub(_a));
      if (_axis.lengthSq() < 1e-12) _axis.set(0, 0, 1);
    }
    _axis.normalize();
    rotateInWorld(mid, _q.setFromAxisAngle(_axis, elbowWant - elbowNow));

    // ── 2. point the limb at the target ─────────────────────────────
    root.getWorldPosition(_a);
    tip.getWorldPosition(_c);
    _ac.subVectors(_c, _a);
    _at.subVectors(_t, _a);
    if (_ac.lengthSq() > 1e-12 && _at.lengthSq() > 1e-12) {
      _axis.copy(_ac).cross(_at);
      if (_axis.lengthSq() > 1e-12) {
        rotateInWorld(root, _q.setFromAxisAngle(_axis.normalize(), angleBetween(_ac, _at)));
      }
    }

    // ── 3. roll the elbow round to face the pole ────────────────────
    if (this.pole.lengthSq() > 0) {
      root.getWorldPosition(_a);
      tip.getWorldPosition(_c);
      mid.getWorldPosition(_b);
      const along = _ac.subVectors(_c, _a);
      if (along.lengthSq() > 1e-12) {
        along.normalize();
        // Each of the elbow and the pole, with the part that lies along the
        // limb taken away - what is left is which way round each one sits.
        const elbowOut = _b.clone().sub(_a);
        elbowOut.sub(along.clone().multiplyScalar(elbowOut.dot(along)));
        const poleOut = this.pole.clone().sub(_a);
        poleOut.sub(along.clone().multiplyScalar(poleOut.dot(along)));

        if (elbowOut.lengthSq() > 1e-10 && poleOut.lengthSq() > 1e-10) {
          elbowOut.normalize();
          poleOut.normalize();
          const cos = THREE.MathUtils.clamp(elbowOut.dot(poleOut), -1, 1);
          const sign = Math.sign(elbowOut.clone().cross(poleOut).dot(along)) || 1;
          rotateInWorld(root, _q.setFromAxisAngle(along, Math.acos(cos) * sign));
        }
      }
    }
  }

  /**
   * Chains of any other length - a spine, a tail, a neck - are solved by
   * cyclic coordinate descent: walk from the tip back to the root, and at
   * each joint turn it so the tip points a little more at the target. A few
   * passes and it arrives. Slower and less exact than the two-bone answer,
   * but it works on a chain of any length.
   */
  _solveCCD(iterations = 12) {
    const tip = this.tip;
    for (let pass = 0; pass < iterations; pass++) {
      for (let i = this.bones.length - 2; i >= 0; i--) {
        const bone = this.bones[i];
        bone.getWorldPosition(_a);
        tip.getWorldPosition(_c);
        _ac.subVectors(_c, _a);
        _at.subVectors(this.target, _a);
        if (_ac.lengthSq() < 1e-12 || _at.lengthSq() < 1e-12) continue;
        _ac.normalize(); _at.normalize();
        _axis.copy(_ac).cross(_at);
        if (_axis.lengthSq() < 1e-12) continue;
        rotateInWorld(bone, _q.setFromAxisAngle(_axis.normalize(), angleBetween(_ac, _at)));
      }
      tip.getWorldPosition(_c);
      if (_c.distanceToSquared(this.target) < 1e-10) break;
    }
  }
}

/* ── finding the limbs ───────────────────────────────────────────────
 *
 * Rigs disagree about names. Meshy writes "mixamorigLeftHand_12", Blender
 * writes "hand.L", older exporters write "Bip01_L_Hand". They agree about
 * shape though: a hand or a foot is the end of a chain, with an elbow or a
 * knee above it and a shoulder or a hip above that. So the names are used to
 * find candidates, and the skeleton itself is used to build the chain.
 */

const ENDS = [
  { re: /hand|wrist/i, kind: 'arm' },
  { re: /foot|ankle|paw|hoof/i, kind: 'leg' },
];

/* Things that look like the end of a limb but are not: the bone past the
 * hand, and the fingers and toes hanging off it. Without this a template
 * with a "LeftHandTip" produces two left arms - one ending at the hand and
 * one ending at the tip - and both claim the same limb. */
const NOT_AN_END = /tip$|end$|_end|nub|toe|thumb|finger|index|middle|ring|pinky|digit/i;

const SIDE = [
  { re: /left/i, side: 'Left' },                       // mixamorigLeftHand
  { re: /right/i, side: 'Right' },
  { re: /[_.\- ]l([_.\- ]|\d*$)/i, side: 'Left' },     // hand.L, Bip01_L_Hand
  { re: /[_.\- ]r([_.\- ]|\d*$)/i, side: 'Right' },
];

function sideOf(name) {
  for (const { re, side } of SIDE) if (re.test(name)) return side;
  return '';
}

/**
 * A readable name for a limb, taken from the joint on the end of it.
 *
 * Naming limbs "arm" and "leg" is not enough for an animal: a dog has four
 * legs, and two of them are its front ones. So the label is built from the
 * end joint's own name instead - "Left hand", "Left hind paw" - which is
 * always distinct and always matches what you would call it.
 */
function limbLabel(tipName, side) {
  // Split the camel case FIRST, so "LeftFoot" becomes "Left Foot" and the
  // side can then be taken off as a word. The other way round leaves
  // "Left left foot", because "LeftFoot" has no word boundary in it.
  let word = tipName
    .replace(/^(mixamorig|Bip\d*|Armature)[:_|]?/i, '')
    .replace(/[_.]/g, ' ')
    .replace(/\d+$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')       // HindPaw -> Hind Paw
    .replace(/\b(left|right|l|r)\b/ig, '')
    .trim()
    .toLowerCase();
  if (!word) word = 'limb';
  return `${side} ${word}`.trim().replace(/\s+/g, ' ');
}

export function detectLimbs(bones) {
  const set = new Set(bones);
  const chains = [];
  const used = new Set();

  for (const bone of bones) {
    const end = ENDS.find((e) => e.re.test(bone.name));
    if (!end) continue;
    if (NOT_AN_END.test(bone.name)) continue;

    const mid = bone.parent;
    const root = mid && mid.parent;
    if (!mid || !root || !set.has(mid) || !set.has(root)) continue;

    // If this joint's own parent is also a hand or a foot, then this one is
    // the bone past the end, not the end.
    if (ENDS.some((e) => e.re.test(mid.name)) && !NOT_AN_END.test(mid.name)) continue;

    if (used.has(bone.name)) continue;
    used.add(bone.name);

    const side = sideOf(bone.name) || sideOf(mid.name) || sideOf(root.name);
    chains.push(new IKChain([root, mid, bone], limbLabel(bone.name, side)));
  }

  chains.sort((x, y) => x.label.localeCompare(y.label));
  return chains;
}

/* ── the other side of the body ──────────────────────────────────────
 *
 * Harder than it looks, for two reasons that only show up on real rigs.
 *
 * Meshy writes the side into the middle of a run-together name and hangs a
 * node number on the end — "mixamorigLeftArm_29" — and that number is
 * different for the joint on the other side, which is "mixamorigRightArm_14".
 * So swapping the word is not enough: the name that comes out does not exist,
 * and a straight lookup finds nothing.
 *
 * And a swap has to happen in one pass. Replacing Left with Right and then
 * Right with Left puts every name back exactly where it started.
 */

const INDEX_SUFFIX = /[_.]\d+$/;

/** The name this joint's opposite number would have, ignoring numbering. */
export function mirrorName(name) {
  // One pass over both words at once, keeping whatever capitalisation was
  // there, so "LeftArm" gives "RightArm" and "hand_left" gives "hand_right".
  const worded = name.replace(/left|right/gi, (found) => {
    const swap = found.toLowerCase() === 'left' ? 'right' : 'left';
    return found[0] === found[0].toUpperCase()
      ? swap[0].toUpperCase() + swap.slice(1)
      : swap;
  });
  if (worded !== name) return worded;

  // The other convention: a single letter on the end or between separators.
  const lettered = name.replace(/([_.\- ])([LlRr])(?=[_.\- ]|\d*$)/g, (whole, gap, side) => {
    const swap = { L: 'R', R: 'L', l: 'r', r: 'l' }[side];
    return gap + swap;
  });
  return lettered;
}

/**
 * The joint on the other side of the body, by name, out of the names a model
 * actually has.
 *
 * Tries the exact mirrored name first, then again ignoring a trailing node
 * number — which is what makes it work on the Meshy rigs that most of these
 * models are.
 */
export function findMirror(name, names) {
  const wanted = mirrorName(name);
  if (wanted === name) return null;
  if (names.has ? names.has(wanted) : names.includes(wanted)) return wanted;

  const bare = wanted.replace(INDEX_SUFFIX, '').toLowerCase();
  for (const other of names) {
    if (other !== name && other.replace(INDEX_SUFFIX, '').toLowerCase() === bare) return other;
  }
  return null;
}

/** Build a chain by hand: this joint, and the two above it. */
export function chainFrom(bone, bones, length = 3) {
  const set = new Set(bones);
  const chain = [bone];
  let cursor = bone;
  while (chain.length < length && cursor.parent && set.has(cursor.parent)) {
    cursor = cursor.parent;
    chain.unshift(cursor);
  }
  if (chain.length < 2) return null;
  return new IKChain(chain, `${bone.name} chain`);
}
