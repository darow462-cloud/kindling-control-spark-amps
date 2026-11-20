// In-memory, per-variant edit history. No writes to the amp are performed here.
// Each side (A/B) holds its own Undo/Redo stacks and a deep copy of the tone.

const copy = (preset) => (preset == null ? null : structuredClone(preset));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const side = (preset) => ({ present: copy(preset), undo: [], redo: [], lastKey: null, lastTime: 0 });

export class ToneSession {
  constructor({ limit = 80, coalesceMs = 450 } = {}) {
    this.limit = limit;
    this.coalesceMs = coalesceMs;
    this.reset(null);
  }

  reset(preset) {
    this.active = 'A';
    this.sides = { A: side(preset), B: side(preset) };
  }

  get available() {
    return this.sides[this.active].present != null;
  }

  get canUndo() {
    return this.sides[this.active].undo.length > 0;
  }

  get canRedo() {
    return this.sides[this.active].redo.length > 0;
  }

  /** Keep in sync with a refreshed tone without generating an Undo action. */
  capture(preset) {
    this.sides[this.active].present = copy(preset);
  }

  /** Record a successful user edit; group rapid changes to the same knob. */
  record(preset, key = null, now = Date.now()) {
    const s = this.sides[this.active];
    if (preset == null) return false;
    if (s.present == null) {
      s.present = copy(preset);
      return false;
    }
    if (same(s.present, preset)) return false;
    const group = key != null && s.lastKey === key && now - s.lastTime <= this.coalesceMs && s.undo.length > 0 && s.redo.length === 0;
    if (!group) {
      s.undo.push(copy(s.present));
      if (s.undo.length > this.limit) s.undo.shift();
    }
    s.present = copy(preset);
    s.redo.length = 0;
    s.lastKey = key;
    s.lastTime = now;
    return true;
  }

  peekUndo() {
    return copy(this.sides[this.active].undo.at(-1));
  }

  peekRedo() {
    return copy(this.sides[this.active].redo.at(-1));
  }

  /** Commit only after the controller has successfully applied the target tone. */
  commitUndo(applied) {
    const s = this.sides[this.active];
    if (!s.undo.length) return false;
    const previous = s.undo.pop();
    s.redo.push(copy(s.present));
    s.present = copy(applied ?? previous);
    s.lastKey = null;
    return true;
  }

  commitRedo(applied) {
    const s = this.sides[this.active];
    if (!s.redo.length) return false;
    const next = s.redo.pop();
    s.undo.push(copy(s.present));
    s.present = copy(applied ?? next);
    s.lastKey = null;
    return true;
  }

  snapshot(which) {
    if (which !== 'A' && which !== 'B') throw new RangeError('tone variant must be A or B');
    return copy(this.sides[which].present);
  }

  /** Complete a successful A/B switch; failed uploads leave the active side alone. */
  activate(which, previousTone, appliedTone) {
    if (which !== 'A' && which !== 'B') throw new RangeError('tone variant must be A or B');
    if (which === this.active) return;
    this.capture(previousTone);
    this.active = which;
    this.capture(appliedTone);
    this.sides[which].lastKey = null;
  }

  /** Copy the current tone into the other variant, resetting only its history. */
  copyToOther(preset) {
    this.capture(preset);
    const other = this.active === 'A' ? 'B' : 'A';
    this.sides[other] = side(preset);
    return other;
  }
}
