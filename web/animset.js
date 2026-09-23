/* The animation set — every animation one character has, all editable.
 *
 * gerak used to hold exactly one clip. Opening a model that already had
 * animations in it asked you to pick one, and the rest were out of reach
 * until you opened the file again. That is fine for a model with a single
 * walk in it, and no use at all for `athlete_tall.glb`, which carries twelve
 * — argue, backhand, celebrate, forehand, idle, lunge, ready, run, serve,
 * smash, tired, walk — and is played by name from the game's own scripts.
 *
 * So the set holds them all. One is open and being edited; the others sit
 * waiting with whatever edits they have. Switching between them is just
 * putting one down and picking another up, and nothing reaches the disk
 * until you press a button.
 *
 * Two things are worth knowing about how it is built:
 *
 * An animation is only turned into keys when you first open it. Reading one
 * out of a file means sampling it frame by frame through a mixer (see
 * `Clip.fromAnimationClip`), and doing that twelve times over on open would
 * make every character slow to look at for the sake of eleven animations you
 * probably were not going to touch.
 *
 * The originals are never thrown away. `sources` keeps the file's own
 * animations by their original name, so undoing a merge or abandoning an
 * edit has something real to go back to.
 */

import { Clip } from '/web/clip.js';

export class AnimSet {
  constructor() {
    this.entries = [];       // { name, from, clip, dirty }
    this.sources = new Map(); // original name -> THREE.AnimationClip
    this.removed = [];       // names merged away, to delete from the file
    this.at = -1;            // which entry is open
    this.model = '';
    this.label = '';
  }

  /** Build the set from a freshly opened model. */
  static fromModel(item, sourceClips) {
    const set = new AnimSet();
    set.model = item.path;
    set.label = item.name.replace(/\.(glb|gltf|fbx)$/i, '');
    for (const source of sourceClips || []) {
      const name = source.name || 'animation';
      set.sources.set(name, source);
      set.entries.push({ name, from: name, clip: null, dirty: false });
    }
    /* A model with no animation in it still gets one entry to work in, so
     * posing a bare model is the same act as editing an existing walk rather
     * than a separate mode with its own rules. */
    if (!set.entries.length) set.entries.push(set.blank());
    return set;
  }

  get current() { return this.entries[this.at] || null; }

  get length() { return this.entries.length; }

  indexOf(name) { return this.entries.findIndex((e) => e.name === name); }

  names() { return this.entries.map((e) => e.name); }

  /** The entries that have been edited and not yet written anywhere. */
  edited() { return this.entries.filter((e) => e.dirty && e.clip); }

  get dirty() { return this.entries.some((e) => e.dirty) || this.removed.length > 0; }

  /**
   * Make the keys for one entry, if they do not exist yet.
   *
   * `make` is handed in rather than imported so this class never has to know
   * about the viewport or the mixer — it is given a way to turn one of the
   * file's animations into a clip, and that is all.
   */
  materialise(entry, make) {
    if (entry.clip) return entry.clip;
    const source = entry.from ? this.sources.get(entry.from) : null;
    entry.clip = source ? make(source) : new Clip({ name: entry.name, model: this.model });
    entry.clip.name = entry.name;
    entry.clip.model = this.model;
    entry.clip.dirty = false;
    entry.dirty = false;
    return entry.clip;
  }

  /** An empty animation named after the character, to work in. */
  blank() {
    return { name: this.label || 'untitled', from: null, clip: null, dirty: false };
  }

  /**
   * Delete animations outright.
   *
   * Nothing is averaged or kept: the entries go, and the names they had in
   * the file go into `removed` so that "Update the game" takes them out of
   * the .glb as well. Until that button is pressed the file still has them
   * and undo puts them straight back.
   *
   * Indices are spliced from the back so the earlier ones do not shift under
   * the loop, and `at` is carried along — deleting the animation above the
   * open one must not silently change which one is open.
   *
   * Hands back the names, and whether the open one was among them: the
   * caller has a live clip in its hand that no longer belongs to any entry,
   * and must not stash it onto whatever entry took its place.
   */
  remove(indices) {
    const doomed = [...new Set(indices)].filter((i) => this.entries[i])
      .sort((a, b) => b - a);
    if (!doomed.length) return null;

    const names = [];
    let lostOpen = false;
    for (const i of doomed) {
      const entry = this.entries[i];
      names.unshift(entry.name);
      if (entry.from) this.removed.push(entry.from);
      this.entries.splice(i, 1);
      if (this.at === i) { lostOpen = true; this.at = -1; }
      else if (this.at > i) this.at -= 1;
    }

    // A character always has somewhere to work, even with nothing left.
    if (!this.entries.length) {
      this.entries.push(this.blank());
      this.at = -1;
      lostOpen = true;
    }
    if (this.at < 0) this.at = Math.min(doomed[doomed.length - 1], this.entries.length - 1);

    return { names, lostOpen };
  }

  /**
   * Start a new animation on this character, from an empty timeline.
   *
   * This exists because the set took something away. gerak used to open a
   * model with an empty clip and *offer* to load one of the file's
   * animations; now it opens the first one straight away, which is what
   * "change the animation whenever I want" asks for — but that left no way
   * to pose a character that already has animations from scratch. This is
   * the way back to one.
   *
   * It has no `from`, so nothing in the file is replaced when it is pushed:
   * it is added to the game's .glb as a new animation under its own name.
   */
  add(name) {
    const taken = new Set(this.names());
    const wanted = name || 'new animation';
    let unique = wanted;
    for (let n = 2; taken.has(unique); n++) unique = `${wanted} ${n}`;
    this.entries.push({ name: unique, from: null, clip: null, dirty: false });
    return this.entries.length - 1;
  }

  /** Put the open clip down — it keeps whatever state it is in. */
  stash(clip) {
    const entry = this.current;
    if (!entry || !clip) return;
    entry.clip = clip;
    entry.name = clip.name || entry.name;
    if (clip.dirty) entry.dirty = true;
  }

  /** Pick one up. Hands back the clip; the caller puts it on screen. */
  open(i, make) {
    if (i < 0 || i >= this.entries.length) return null;
    this.at = i;
    return this.materialise(this.entries[i], make);
  }

  /**
   * Merge two animations into one.
   *
   * Luqman's case, in his own words: a character has two run animations for
   * two different occasions and he wants them to be the same. So a merge is
   * not a blend of the two motions — it is choosing which of them both
   * occasions will use. The keeper's keys are copied onto the loser's name
   * only in the sense that the loser stops existing; nothing is averaged,
   * because an average of two runs is a third run nobody asked for.
   *
   * The loser's name is remembered in `removed` so that "Update the game"
   * knows to take it out of the file as well. Until that button is pressed,
   * a merge has changed nothing on the disk and undo puts it straight back.
   */
  merge(keepIndex, dropIndex, make) {
    if (keepIndex === dropIndex) return null;
    const keep = this.entries[keepIndex];
    const drop = this.entries[dropIndex];
    if (!keep || !drop) return null;

    this.materialise(keep, make);
    if (drop.from) this.removed.push(drop.from);
    this.entries.splice(dropIndex, 1);

    // Keep pointing at whatever was open, unless it was the one deleted.
    if (this.at === dropIndex) this.at = this.entries.indexOf(keep);
    else if (this.at > dropIndex) this.at -= 1;

    keep.dirty = true;
    return { kept: keep.name, dropped: drop.name };
  }

  /** What "Update the game" sends: the edits, and the names to delete. */
  push() {
    return {
      clips: this.edited().map((e) => {
        const doc = e.clip.toJSON();
        doc.name = e.name;
        return doc;
      }),
      remove: [...new Set(this.removed)],
    };
  }

  /** Everything is now on the disk, so nothing is outstanding. */
  settled() {
    for (const entry of this.entries) {
      entry.dirty = false;
      if (entry.clip) entry.clip.dirty = false;
      if (!entry.from) entry.from = entry.name;
    }
    this.removed = [];
  }

  /* ── undo ──────────────────────────────────────────────────────────
   *
   * A photograph of the set, sharing nothing with it. `sources` is left out
   * on purpose: the file's own animations never change, so the live map is
   * still the right one when a photograph is put back.
   */

  toJSON() {
    return {
      model: this.model,
      label: this.label,
      at: this.at,
      removed: [...this.removed],
      entries: this.entries.map((e) => ({
        name: e.name,
        from: e.from,
        dirty: e.dirty,
        clip: e.clip ? e.clip.toJSON() : null,
      })),
    };
  }

  restore(doc) {
    if (!doc) return this;
    this.model = doc.model || this.model;
    this.label = doc.label || this.label;
    this.at = doc.at ?? -1;
    this.removed = [...(doc.removed || [])];
    this.entries = (doc.entries || []).map((e) => ({
      name: e.name,
      from: e.from,
      dirty: !!e.dirty,
      clip: e.clip ? Clip.fromJSON(e.clip) : null,
    }));
    for (const entry of this.entries) {
      if (entry.clip) entry.clip.dirty = entry.dirty;
    }
    return this;
  }
}
