/* Undo.
 *
 * There are two ways to build undo. You can make every action record how to
 * reverse itself — cheap, and wrong the first time somebody adds an action
 * and forgets the reverse. Or you can photograph the state before each
 * action and put the photograph back. The second is duller and much harder
 * to get wrong, and in gerak the state worth photographing is small: a clip
 * is a few hundred numbers and a pose is one rotation per joint.
 *
 * So that is what this is. `push` is called *before* anything changes, with
 * a name for what is about to happen; undo puts the last photograph back and
 * keeps the present one so redo can return to it.
 *
 * The only thing to be careful about is that `push` happens before the
 * change, not after. An undo stack built from photographs taken afterwards
 * is always one step behind, and the bug that causes looks like undo
 * "skipping" the first press.
 */

export class History {
  /**
   * @param {() => object} capture   photograph the present
   * @param {(state: object) => void} restore  put a photograph back
   * @param {number} limit           how many steps to keep
   */
  constructor(capture, restore, limit = 40) {
    this.capture = capture;
    this.restore = restore;
    this.limit = limit;
    this.past = [];
    this.future = [];
    this.onChange = () => {};
    this.restoring = false;
  }

  /**
   * Record where we are, because something is about to change it.
   *
   * Anything that happens during a restore is the restore's own doing, not a
   * new action, so it is ignored — otherwise undoing would push a step of its
   * own and you could never get back past it.
   */
  push(label) {
    if (this.restoring) return;
    this.past.push({ label, state: this.capture() });
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;          // a new action abandons the redo trail
    this.onChange();
  }

  /** Throw the lot away — called when a different model is opened. */
  clear() {
    this.past.length = 0;
    this.future.length = 0;
    this.onChange();
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  get undoLabel() { return this.canUndo ? this.past[this.past.length - 1].label : null; }
  get redoLabel() { return this.canRedo ? this.future[this.future.length - 1].label : null; }

  undo() {
    if (!this.canUndo) return null;
    const entry = this.past.pop();
    this.future.push({ label: entry.label, state: this.capture() });
    this._apply(entry.state);
    this.onChange();
    return entry.label;
  }

  redo() {
    if (!this.canRedo) return null;
    const entry = this.future.pop();
    this.past.push({ label: entry.label, state: this.capture() });
    this._apply(entry.state);
    this.onChange();
    return entry.label;
  }

  _apply(state) {
    this.restoring = true;
    try {
      this.restore(state);
    } finally {
      this.restoring = false;
    }
  }
}
