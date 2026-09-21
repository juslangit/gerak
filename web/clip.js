/* The clip - what an animation actually is in gerak.
 *
 * A clip is a list of joints, and for each joint a list of frames where you
 * said "this is the pose here". Nothing in between is stored. When the
 * playhead sits on frame 9 and the nearest keys are at 6 and 12, the pose on
 * screen is worked out on the spot, halfway-ish between the two.
 *
 * That is the whole of keyframe animation, and it is why you only pose the
 * moments that matter instead of every frame.
 *
 * Joints are keyed by NAME, not by the internal id three.js hands out, so a
 * clip saved today still finds its joints when the model is opened tomorrow.
 */

import * as THREE from 'three';

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

export class Clip {
  constructor(opts = {}) {
    this.name = opts.name || 'untitled';
    this.model = opts.model || '';
    this.fps = opts.fps || 24;
    this.frames = opts.frames || 48;
    this.interp = opts.interp || 'linear';    // 'linear' | 'ease'
    this.tracks = new Map();                  // bone name -> [{ f, q:[4], p:[3] }]
    this.dirty = false;
  }

  // ── keys ──────────────────────────────────────────────────────────

  setKey(name, frame, quat, pos) {
    frame = Math.round(frame);
    let track = this.tracks.get(name);
    if (!track) { track = []; this.tracks.set(name, track); }
    const key = {
      f: frame,
      q: [quat.x, quat.y, quat.z, quat.w],
      p: [pos.x, pos.y, pos.z],
    };
    const at = track.findIndex((k) => k.f === frame);
    if (at >= 0) track[at] = key;
    else {
      track.push(key);
      track.sort((a, b) => a.f - b.f);
    }
    this.dirty = true;
    return key;
  }

  removeKey(name, frame) {
    const track = this.tracks.get(name);
    if (!track) return false;
    const at = track.findIndex((k) => k.f === Math.round(frame));
    if (at < 0) return false;
    track.splice(at, 1);
    if (!track.length) this.tracks.delete(name);
    this.dirty = true;
    return true;
  }

  hasKey(name, frame) {
    const track = this.tracks.get(name);
    return !!track && track.some((k) => k.f === Math.round(frame));
  }

  keysOf(name) { return this.tracks.get(name) || []; }

  keyedNames() { return [...this.tracks.keys()]; }

  /** Every frame that carries a key on any joint, in order. */
  keyedFrames() {
    const set = new Set();
    for (const track of this.tracks.values()) for (const k of track) set.add(k.f);
    return [...set].sort((a, b) => a - b);
  }

  totalKeys() {
    let n = 0;
    for (const track of this.tracks.values()) n += track.length;
    return n;
  }

  isEmpty() { return this.tracks.size === 0; }

  /** Shift every key on a joint, or on the whole clip, by some frames. */
  shift(frames, name = null) {
    const tracks = name ? [this.tracks.get(name)].filter(Boolean)
                        : [...this.tracks.values()];
    for (const track of tracks) {
      for (const k of track) k.f = Math.max(0, k.f + frames);
      track.sort((a, b) => a.f - b.f);
    }
    this.dirty = true;
  }

  // ── working out the frames in between ─────────────────────────────

  /** The pose of one joint at any frame, or null if it was never keyed. */
  sample(name, frame, out = {}) {
    const track = this.tracks.get(name);
    if (!track || !track.length) return null;

    // Before the first key, or after the last, the pose simply holds.
    if (frame <= track[0].f) return this._hold(track[0], out);
    const last = track[track.length - 1];
    if (frame >= last.f) return this._hold(last, out);

    let i = 0;
    while (i < track.length - 1 && track[i + 1].f <= frame) i++;
    const a = track[i], b = track[i + 1];

    let t = (frame - a.f) / (b.f - a.f);
    if (this.interp === 'ease') t = t * t * (3 - 2 * t);   // smoothstep

    _qa.fromArray(a.q);
    _qb.fromArray(b.q);
    _qa.slerp(_qb, t);

    out.q = out.q || new THREE.Quaternion();
    out.p = out.p || new THREE.Vector3();
    out.q.copy(_qa);
    out.p.set(
      a.p[0] + (b.p[0] - a.p[0]) * t,
      a.p[1] + (b.p[1] - a.p[1]) * t,
      a.p[2] + (b.p[2] - a.p[2]) * t
    );
    return out;
  }

  _hold(key, out) {
    out.q = out.q || new THREE.Quaternion();
    out.p = out.p || new THREE.Vector3();
    out.q.fromArray(key.q);
    out.p.fromArray(key.p);
    return out;
  }

  /**
   * The whole pose at a frame: every joint this clip drives, and where it is.
   *
   * Sampled rather than read straight off the keys, so a frame with no key on
   * it still gives back the pose you can see — which is what copying a pose
   * has to mean, or copying would only work on frames that already had keys.
   */
  poseAt(frame) {
    const out = [];
    for (const name of this.tracks.keys()) {
      const posed = this.sample(name, frame);
      if (posed) out.push({ name, q: posed.q.toArray(), p: posed.p.toArray() });
    }
    return out;
  }

  /** Put a key back from plain numbers, the way a copied one is stored. */
  setKeyValues(name, frame, q, p) {
    frame = Math.round(frame);
    let track = this.tracks.get(name);
    if (!track) { track = []; this.tracks.set(name, track); }
    const key = { f: frame, q: q.slice(), p: p.slice() };
    const at = track.findIndex((k) => k.f === frame);
    if (at >= 0) track[at] = key;
    else { track.push(key); track.sort((a, b) => a.f - b.f); }
    this.dirty = true;
    return key;
  }

  /**
   * Put every bone where this clip says it should be at `frame`.
   * A bone with no keys goes back to the pose the file arrived in, so an arm
   * you never touched stays exactly as the model was built.
   */
  applyTo(bones, restPose, frame) {
    const out = { q: new THREE.Quaternion(), p: new THREE.Vector3() };
    for (const bone of bones) {
      const posed = this.sample(bone.name, frame, out);
      if (posed) {
        bone.quaternion.copy(posed.q);
        bone.position.copy(posed.p);
      } else {
        const rest = restPose.get(bone.name);
        if (rest) {
          bone.quaternion.copy(rest.q);
          bone.position.copy(rest.p);
        }
      }
    }
  }

  // ── saving, loading, exporting ────────────────────────────────────

  /**
   * A plain, independent copy of this clip.
   *
   * Independent matters. Handing back the live arrays is fine for writing a
   * file, because that is serialised on the spot — but undo photographs a
   * clip and keeps it, and a photograph that shares its arrays with the clip
   * changes whenever the clip does. Which makes undo restore the very state
   * it was meant to undo.
   */
  toJSON() {
    const tracks = {};
    for (const [name, track] of this.tracks) {
      tracks[name] = track.map((key) => ({ f: key.f, q: key.q.slice(), p: key.p.slice() }));
    }
    return {
      version: 1,
      name: this.name,
      model: this.model,
      fps: this.fps,
      frames: this.frames,
      interp: this.interp,
      tracks,
    };
  }

  /**
   * Build a clip from a plain object, sharing nothing with it.
   *
   * Copying the array alone is not enough: `shift` moves a key by editing its
   * frame number in place, so a clip that shared its key objects with the
   * document it was built from would drag that document along with it. Undo
   * builds clips from photographs, and a photograph that moves is no use.
   */
  static fromJSON(doc) {
    const clip = new Clip(doc);
    for (const [name, track] of Object.entries(doc.tracks || {})) {
      clip.tracks.set(name, track
        .map((key) => ({ f: key.f, q: key.q.slice(), p: key.p.slice() }))
        .sort((a, b) => a.f - b.f));
    }
    clip.dirty = false;
    return clip;
  }

  /**
   * Turn this into a three.js AnimationClip, which is the shape both the
   * player and the .glb exporter understand.
   *
   * Tracks are named by the bone's internal id rather than its name on
   * purpose: exported names get parsed, and a rig with a bone called
   * "mixamorig:Hips" or "arm.L" would be cut at the punctuation and lost.
   */
  toAnimationClip(bones) {
    const byName = new Map(bones.map((b) => [b.name, b]));
    const tracks = [];

    for (const [name, rawKeys] of this.tracks) {
      const bone = byName.get(name);
      if (!bone || !rawKeys.length) continue;

      /* A glTF file has no idea how long an animation is meant to be: its
       * length is simply the time of the last key in it. So a 48-frame clip
       * whose last pose is keyed at frame 36 would arrive in Godot as a
       * 36-frame animation, and every loop would be wrong.
       *
       * The timeline holds the last pose out to the end, so write that hold
       * down as a real key. What you see is then what the engine plays. */
      const keys = rawKeys.slice();
      const last = keys[keys.length - 1];
      if (last.f < this.frames) {
        keys.push({ f: this.frames, q: last.q.slice(), p: last.p.slice() });
      }

      const times = new Float32Array(keys.map((k) => k.f / this.fps));

      const quats = new Float32Array(keys.length * 4);
      keys.forEach((k, i) => quats.set(k.q, i * 4));
      tracks.push(new THREE.QuaternionKeyframeTrack(
        `${bone.uuid}.quaternion`, times, quats));

      // Only write a position track when the joint actually travels.
      // Every other joint keeps the offset the rig was built with, and the
      // exported file stays smaller and easier for an engine to retarget.
      const moves = keys.some((k) =>
        Math.abs(k.p[0] - keys[0].p[0]) > 1e-6 ||
        Math.abs(k.p[1] - keys[0].p[1]) > 1e-6 ||
        Math.abs(k.p[2] - keys[0].p[2]) > 1e-6);

      if (moves) {
        const pos = new Float32Array(keys.length * 3);
        keys.forEach((k, i) => pos.set(k.p, i * 3));
        tracks.push(new THREE.VectorKeyframeTrack(
          `${bone.uuid}.position`, times, pos));
      }
    }

    const clip = new THREE.AnimationClip(
      this.name, this.frames / this.fps, tracks);
    clip.resetDuration();
    clip.duration = this.frames / this.fps;
    return clip;
  }

  /**
   * Read an animation that was already inside the model file and write it out
   * as ordinary keys, one per frame, so it can be edited by hand.
   *
   * Sampling every frame is deliberate. The incoming curves may be smooth in
   * ways gerak's straight lines cannot reproduce, so it copies the result
   * rather than the recipe - what you see is what the file did.
   */
  static fromAnimationClip(source, bones, restPose, fps = 24) {
    const mixer = new THREE.AnimationMixer(
      bones[0] ? rootOf(bones[0]) : new THREE.Object3D());
    const action = mixer.clipAction(source);
    action.play();

    const frames = Math.max(1, Math.round(source.duration * fps));
    const clip = new Clip({
      name: source.name || 'imported',
      fps,
      frames,
      interp: 'linear',
    });

    let last = 0;
    for (let f = 0; f <= frames; f++) {
      const t = f / fps;
      mixer.update(t - last);
      last = t;
      for (const bone of bones) {
        clip.setKey(bone.name, f, bone.quaternion, bone.position);
      }
    }

    action.stop();
    mixer.uncacheClip(source);

    // Drop joints that never move: a 24-joint rig where only the legs walk
    // should not end up with 24 full tracks of identical keys.
    for (const [name, track] of [...clip.tracks]) {
      const first = track[0];
      const still = track.every((k) =>
        k.q.every((v, i) => Math.abs(v - first.q[i]) < 1e-5) &&
        k.p.every((v, i) => Math.abs(v - first.p[i]) < 1e-5));
      if (still) clip.tracks.delete(name);
    }

    // Put the model back where it was before the sampling moved it around.
    for (const bone of bones) {
      const rest = restPose.get(bone.name);
      if (rest) { bone.quaternion.copy(rest.q); bone.position.copy(rest.p); }
    }

    clip.dirty = true;
    return clip;
  }
}

function rootOf(object) {
  let o = object;
  while (o.parent) o = o.parent;
  return o;
}

/* ── the player ──────────────────────────────────────────────────────
 *
 * Playback is a clock, not a mixer. It advances a frame number in real time
 * and asks the clip for that frame; nothing else in the app has to know
 * whether we are playing or being scrubbed by hand.
 */

export class Player {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.playing = false;
    this.loop = true;
    this.frame = 0;
    this._raf = null;
    this._last = 0;
  }

  play(clip) {
    if (this.playing) return;
    this.clip = clip;
    this.playing = true;
    this._last = performance.now();
    const tick = (now) => {
      if (!this.playing) return;
      const advanced = ((now - this._last) / 1000) * this.clip.fps;
      this._last = now;
      let f = this.frame + advanced;
      if (f >= this.clip.frames) {
        if (this.loop) f = f % this.clip.frames;
        else { f = this.clip.frames; this.pause(); }
      }
      this.frame = f;
      this.onFrame(f);
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  pause() {
    this.playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this.frame = Math.round(this.frame);
    this.onFrame(this.frame);
  }

  toggle(clip) { this.playing ? this.pause() : this.play(clip); }

  goto(frame) {
    this.pause();
    this.frame = frame;
    this.onFrame(frame);
  }
}
