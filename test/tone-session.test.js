import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToneSession } from '../src/app/tone-session.js';
import { parseKnobValue } from '../src/app/controls.js';

const tone = (gain = 0.5) => ({
  name: 'Sixpounder',
  pedals: [{ name: 'ODS50CN', isOn: true, params: [gain, 0.4, 0.6, 0.5, 0.5] }],
});

test('precise knob input accepts decimal comma, clamps 0–10 and rejects invalid values', () => {
  assert.equal(parseKnobValue('5.75'), 0.575);
  assert.equal(parseKnobValue('5,75'), 0.575);
  assert.equal(parseKnobValue('10'), 1);
  assert.equal(parseKnobValue('-4'), 0);
  assert.equal(parseKnobValue('15'), 1);
  assert.equal(parseKnobValue('0.01'), 0.001);
  assert.equal(parseKnobValue(''), null);
  assert.equal(parseKnobValue('five'), null);
  assert.equal(parseKnobValue('Infinity'), null);
});

test('knob drags coalesce into one undo entry and redo restores the edit', () => {
  const h = new ToneSession({ coalesceMs: 450 });
  h.reset(tone());
  assert.equal(h.available, true);
  assert.equal(h.canUndo, false);
  assert.equal(h.record(tone(0.6), 'param:0:0', 1000), true);
  assert.equal(h.record(tone(0.7), 'param:0:0', 1100), true);
  assert.equal(h.canUndo, true);
  assert.equal(h.peekUndo().pedals[0].params[0], 0.5);

  h.commitUndo(tone(0.5));
  assert.equal(h.canUndo, false);
  assert.equal(h.canRedo, true);
  assert.equal(h.peekRedo().pedals[0].params[0], 0.7);
  h.commitRedo(tone(0.7));
  assert.equal(h.canUndo, true);
  assert.equal(h.canRedo, false);
});

test('separate edits produce separate history entries and new edits clear redo', () => {
  const h = new ToneSession();
  h.reset(tone());
  h.record(tone(0.6), 'param:0:0', 1000);
  h.record(tone(0.7), 'param:0:1', 1100);
  assert.equal(h.peekUndo().pedals[0].params[0], 0.6);
  h.commitUndo(tone(0.6));
  assert.equal(h.canRedo, true);
  h.record(tone(0.8), 'param:0:0', 1800);
  assert.equal(h.canRedo, false);
  assert.equal(h.peekUndo().pedals[0].params[0], 0.6);
});

test('A/B switching keeps independent tone snapshots and per-side history', () => {
  const h = new ToneSession();
  h.reset(tone());
  h.record(tone(0.6), 'param:0:0');
  assert.equal(h.snapshot('B').pedals[0].params[0], 0.5);
  h.activate('B', tone(0.6), tone(0.5));
  h.record(tone(0.9), 'param:0:0');
  assert.equal(h.snapshot('A').pedals[0].params[0], 0.6);
  assert.equal(h.peekUndo().pedals[0].params[0], 0.5);
  h.activate('A', tone(0.9), tone(0.6));
  assert.equal(h.active, 'A');
  assert.equal(h.peekUndo().pedals[0].params[0], 0.5);
  h.activate('B', tone(0.6), tone(0.9));
  assert.equal(h.peekUndo().pedals[0].params[0], 0.5);
});

test('failed switch or Undo does not change history until committed', () => {
  const h = new ToneSession();
  h.reset(tone());
  h.record(tone(0.8), 'param:0:0');
  const target = h.peekUndo();
  target.pedals[0].params[0] = 0;
  assert.equal(h.peekUndo().pedals[0].params[0], 0.5, 'returned target is defensive copy');
  assert.equal(h.active, 'A');
  assert.equal(h.snapshot('B').pedals[0].params[0], 0.5);
  assert.equal(h.canUndo, true);
  assert.equal(h.canRedo, false);
});

test('copy to other resets only the other variant and reset starts a fresh A/B session', () => {
  const h = new ToneSession();
  h.reset(tone());
  h.record(tone(0.7), 'param:0:0');
  const other = h.copyToOther(tone(0.7));
  assert.equal(other, 'B');
  assert.equal(h.snapshot('B').pedals[0].params[0], 0.7);
  h.activate('B', tone(0.7), tone(0.7));
  assert.equal(h.canUndo, false);
  h.reset(tone(0.3));
  assert.equal(h.active, 'A');
  assert.equal(h.canUndo, false);
  assert.equal(h.snapshot('B').pedals[0].params[0], 0.3);
});
