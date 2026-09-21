import * as THREE from 'three';

/* Skeleton templates.
 *
 * Most of your models have no skeleton at all - they are a bag of triangles,
 * and nothing in them says where an elbow is. Placing thirty joints by hand
 * on every one of them would be miserable, so instead a ready-made skeleton
 * of the right shape is dropped onto the model and then nudged.
 *
 * Every joint below is written in "box coordinates" - where it sits inside
 * the model's own bounding box, rather than in metres:
 *
 *     x   -0.5 … +0.5   across the model, 0 down the middle
 *     y    0 … 1        0 at the feet, 1 at the top of the head
 *     z   -0.5 … +0.5   -0.5 behind, +0.5 in front
 *
 * So the same template fits a 12 cm chess piece and a 2 m character without
 * anything being rescaled by hand, and the numbers stay readable: a human
 * hip really does sit a little above half-way up a standing body.
 *
 * The proportions are the standard figure-drawing ones - an eight-heads-tall
 * human, a dog with its shoulder higher than its hip - so what lands on the
 * model is close before you touch it.
 */

/** Write a joint once and get the left and right of it. */
function sides(prefix, spec) {
  const out = [];
  for (const side of ['Left', 'Right']) {
    const flip = side === 'Left' ? 1 : -1;
    for (const [name, parent, x, y, z] of spec) {
      out.push({
        name: `${side}${name}`,
        parent: parent === null ? prefix
          : parent.startsWith('!') ? parent.slice(1)   // ! means "not a side bone"
          : `${side}${parent}`,
        at: [x * flip, y, z],
      });
    }
  }
  return out;
}

const j = (name, parent, x, y, z) => ({ name, parent, at: [x, y, z] });

export const TEMPLATES = {

  // ── a person ──────────────────────────────────────────────────────
  biped: {
    label: 'Human',
    note: 'A standing person, facing forward.',
    forward: '+Z',
    joints: [
      j('Hips', null, 0, 0.530, 0),
      j('Spine', 'Hips', 0, 0.600, 0.005),
      j('Chest', 'Spine', 0, 0.680, 0.010),
      j('UpperChest', 'Chest', 0, 0.755, 0.005),
      j('Neck', 'UpperChest', 0, 0.825, -0.005),
      j('Head', 'Neck', 0, 0.875, 0),
      j('HeadTop', 'Head', 0, 0.985, 0.010),
      ...sides('Hips', [
        ['Shoulder', '!UpperChest', 0.045, 0.800, 0],
        ['Arm', 'Shoulder', 0.115, 0.790, 0],
        ['ForeArm', 'Arm', 0.115, 0.630, -0.005],
        ['Hand', 'ForeArm', 0.115, 0.475, 0],
        ['HandTip', 'Hand', 0.115, 0.410, 0.010],
        ['UpLeg', '!Hips', 0.052, 0.520, 0],
        ['Leg', 'UpLeg', 0.055, 0.285, 0.005],
        ['Foot', 'Leg', 0.055, 0.045, -0.010],
        ['Toe', 'Foot', 0.055, 0.015, 0.075],
      ]),
    ],
  },

  // ── a dog, a cat, a horse ─────────────────────────────────────────
  quadruped: {
    elongated: true,
    label: 'Four-legged animal',
    note: 'A dog, cat or horse standing on all fours, nose toward the front.',
    forward: '+Z',
    joints: [
      j('Hips', null, 0, 0.620, -0.290),
      j('Spine', 'Hips', 0, 0.640, -0.130),
      j('Spine1', 'Spine', 0, 0.650, 0.030),
      j('Chest', 'Spine1', 0, 0.660, 0.175),
      j('Neck', 'Chest', 0, 0.720, 0.290),
      j('Head', 'Neck', 0, 0.790, 0.395),
      j('Muzzle', 'Head', 0, 0.760, 0.490),
      j('Tail', 'Hips', 0, 0.615, -0.360),
      j('Tail1', 'Tail', 0, 0.580, -0.430),
      j('Tail2', 'Tail1', 0, 0.535, -0.490),
      ...sides('Hips', [
        ['Shoulder', '!Chest', 0.095, 0.640, 0.180],
        ['UpperArm', 'Shoulder', 0.105, 0.500, 0.165],
        ['ForeArm', 'UpperArm', 0.105, 0.290, 0.185],
        ['Paw', 'ForeArm', 0.105, 0.045, 0.195],
        ['PawTip', 'Paw', 0.105, 0.020, 0.250],
        ['Thigh', '!Hips', 0.105, 0.600, -0.280],
        ['Shin', 'Thigh', 0.110, 0.360, -0.245],
        ['Hock', 'Shin', 0.110, 0.180, -0.295],
        ['HindPaw', 'Hock', 0.110, 0.040, -0.265],
      ]),
    ],
  },

  // ── a bird ────────────────────────────────────────────────────────
  bird: {
    label: 'Bird',
    note: 'Wings folded along the body, standing.',
    forward: '+Z',
    joints: [
      j('Hips', null, 0, 0.480, -0.060),
      j('Spine', 'Hips', 0, 0.540, 0.020),
      j('Chest', 'Spine', 0, 0.590, 0.100),
      j('Neck', 'Chest', 0, 0.700, 0.150),
      j('Head', 'Neck', 0, 0.850, 0.190),
      j('Beak', 'Head', 0, 0.840, 0.300),
      j('Tail', 'Hips', 0, 0.470, -0.200),
      j('TailTip', 'Tail', 0, 0.440, -0.370),
      ...sides('Hips', [
        ['Wing', '!Chest', 0.070, 0.610, 0.080],
        ['WingArm', 'Wing', 0.115, 0.580, -0.010],
        ['WingHand', 'WingArm', 0.135, 0.545, -0.140],
        ['WingTip', 'WingHand', 0.140, 0.520, -0.290],
        ['Thigh', '!Hips', 0.070, 0.440, -0.030],
        ['Shank', 'Thigh', 0.075, 0.260, 0.010],
        ['BirdFoot', 'Shank', 0.075, 0.040, -0.010],
      ]),
    ],
  },

  // ── a fish ────────────────────────────────────────────────────────
  fish: {
    elongated: true,
    label: 'Fish',
    note: 'A spine from nose to tail, with fins.',
    forward: '+Z',
    joints: [
      j('Root', null, 0, 0.500, 0.100),
      j('Spine', 'Root', 0, 0.500, -0.050),
      j('Spine1', 'Spine', 0, 0.500, -0.180),
      j('Spine2', 'Spine1', 0, 0.500, -0.300),
      j('TailFin', 'Spine2', 0, 0.500, -0.440),
      j('Head', 'Root', 0, 0.510, 0.280),
      j('Jaw', 'Head', 0, 0.450, 0.420),
      j('DorsalFin', 'Spine', 0, 0.760, -0.080),
      ...sides('Root', [
        ['PectoralFin', '!Root', 0.130, 0.470, 0.090],
        ['PectoralTip', 'PectoralFin', 0.230, 0.430, -0.010],
        ['PelvicFin', '!Spine1', 0.080, 0.360, -0.150],
      ]),
    ],
  },

  // ── a snake, a tail, a rope, a tentacle ───────────────────────────
  serpent: {
    elongated: true,
    label: 'Snake or tail',
    note: 'One long chain, nose to tail. Also right for a rope or a tentacle.',
    forward: '+Z',
    joints: (() => {
      const out = [j('Head', null, 0, 0.500, 0.480)];
      for (let i = 1; i <= 11; i++) {
        out.push(j(`Spine${i}`, i === 1 ? 'Head' : `Spine${i - 1}`,
          0, 0.500, 0.480 - i * 0.087));
      }
      return out;
    })(),
  },
};

export const TEMPLATE_ORDER = ['biped', 'quadruped', 'bird', 'fish', 'serpent'];

/**
 * Which way round the model was built.
 *
 * A four-legged animal is longer than it is wide, so whichever horizontal
 * axis is longest is almost certainly its nose-to-tail axis. A standing
 * person is not - a human is a little wider than deep, and guessing from
 * that would lay every character on its side - so this only guesses for the
 * templates that are genuinely long, and only when the difference is clear.
 */
export function guessFacing(key, box) {
  const tpl = TEMPLATES[key];
  if (!tpl || !tpl.elongated) return 0;
  const x = box.max.x - box.min.x;
  const z = box.max.z - box.min.z;
  if (x > z * 1.25) return 90;
  return 0;
}

/**
 * Put a template's joints into the model's own space.
 *
 * `box` is the model's bounding box, so the same numbers fit a chess piece
 * and a two-metre character. `facing` turns the template about the upright
 * axis for a model built facing sideways or backwards, which is most of
 * them, because nothing agrees about which way is forwards.
 */
export function fitTemplate(key, box, facing = 0, flipSides = false) {
  const tpl = TEMPLATES[key];
  if (!tpl) throw new Error(`no template called ${key}`);

  const sx = box.max.x - box.min.x;
  const sy = box.max.y - box.min.y;
  const sz = box.max.z - box.min.z;
  const midX = (box.min.x + box.max.x) / 2;
  const midZ = (box.min.z + box.max.z) / 2;

  const turn = (facing * Math.PI) / 180;
  const cos = Math.cos(turn), sin = Math.sin(turn);

  return tpl.joints.map((joint) => {
    let [nx, ny, nz] = joint.at;
    if (flipSides) nx = -nx;

    // Turn about the upright axis, then stretch onto the box. Turning first
    // means a template laid across a long animal reaches its nose, rather
    // than being stretched sideways and then turned.
    const rx = nx * cos + nz * sin;
    const rz = -nx * sin + nz * cos;

    return {
      name: joint.name,
      parent: joint.parent,
      at: [midX + rx * sx, box.min.y + ny * sy, midZ + rz * sz],
    };
  });
}


/**
 * Turn placed joints into the heads and tails Blender wants.
 *
 * gerak thinks in joints - a point where the body bends. Blender thinks in
 * bones, which have a start and an end. The translation is simple: a bone
 * runs from its own joint to the next joint down the chain.
 *
 * A joint that forks - a hip with two legs, a chest with two arms - has its
 * bone end at the average of its children, which points it sensibly into the
 * body rather than off down one arm. A joint with nothing after it carries on
 * in the direction it was already going, so a fingertip bone points out of
 * the hand rather than being dropped for having no length.
 */
export function headsAndTails(placed) {
  const byName = new Map(placed.map((p) => [p.name, p]));
  const children = new Map();
  for (const p of placed) {
    if (!p.parent) continue;
    if (!children.has(p.parent)) children.set(p.parent, []);
    children.get(p.parent).push(p);
  }
  const V = (a) => new THREE.Vector3(...a);

  return placed.map((p) => {
    const head = V(p.at);
    const kids = children.get(p.name) || [];
    let tail;

    if (kids.length === 1) {
      tail = V(kids[0].at);
    } else if (kids.length > 1) {
      tail = kids.reduce((acc, k) => acc.add(V(k.at)), new THREE.Vector3())
        .divideScalar(kids.length);
    } else {
      const parent = byName.get(p.parent);
      const dir = parent ? head.clone().sub(V(parent.at)) : new THREE.Vector3(0, 1, 0);
      const length = dir.length();
      if (length < 1e-12) dir.set(0, 1, 0);
      tail = head.clone().add(dir.normalize().multiplyScalar(length * 0.4 || 0.02));
    }

    // Blender throws away a bone with no length, which would leave a hole in
    // the middle of a chain.
    if (tail.distanceTo(head) < 1e-6) {
      tail = head.clone().add(new THREE.Vector3(0, 0.01, 0));
    }

    return { name: p.name, parent: p.parent || null, head: head.toArray(), tail: tail.toArray() };
  });
}
