// Plan the cheapest safe way to restore an edited tone on Spark hardware.
// A scalar change can be sent with 01 04 (no ACK) or 01 15 (on/off ACK).
// A model, chain, BPM or metadata change requires uploading the full preset.
//
// The plan is deliberately conservative: never invent or reorder blocks, and
// never assume a model change can be achieved through scalar parameter writes.

const METADATA = ['uuid', 'name', 'description', 'version', 'icon', 'bpm'];
const FLOAT_EPSILON = 1e-5;

export function planToneDelta(current, target, { maxCommands = 8 } = {}) {
  if (!Array.isArray(current?.pedals) || !Array.isArray(target?.pedals)) return null;
  if (current.pedals.length !== target.pedals.length) return null;
  if (METADATA.some((k) => current[k] !== target[k])) return null;

  const steps = [];
  for (let i = 0; i < current.pedals.length; i++) {
    const oldFx = current.pedals[i];
    const newFx = target.pedals[i];
    if (!oldFx || !newFx || typeof oldFx.name !== 'string' || typeof newFx.name !== 'string') return null;
    if (oldFx.name !== newFx.name) return null;
    if (!Array.isArray(oldFx.params) || !Array.isArray(newFx.params) || oldFx.params.length !== newFx.params.length) return null;

    for (let p = 0; p < oldFx.params.length; p++) {
      const from = oldFx.params[p];
      const to = newFx.params[p];
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < 0 || to > 1) return null;
      if (Math.abs(from - to) > FLOAT_EPSILON) {
        steps.push({ kind: 'param', effect: oldFx.name, index: p, value: to });
      }
    }

    if (!!oldFx.isOn !== !!newFx.isOn) {
      steps.push({ kind: 'toggle', effect: oldFx.name, on: !!newFx.isOn });
    }

    // A small number of direct writes is faster than a multi-chunk preset
    // upload; let large edits use the existing safe full-preset path.
    if (steps.length > maxCommands) return null;
  }
  return steps;
}
