import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planToneDelta } from '../src/app/tone-diff.js';
import { SparkClient } from '../src/spark/client.js';
import { MockSparkTransport } from '../src/spark/transport-mock.js';

const tone = () => ({
  uuid: 'example', name: 'A/B comparison', version: '0.7',
  description: '', icon: 'icon.png', bpm: 120,
  pedals: [
    { name: 'bias.noisegate', isOn: true, params: [0.2, 0.3, 0] },
    { name: 'LA2AComp', isOn: false, params: [0.5, 0.4, 0.3] },
    { name: 'Booster', isOn: false, params: [0.5] },
    { name: 'ODS50CN', isOn: true, params: [0.5, 0.4, 0.5, 0.5, 0.6] },
  ],
});

test('single Gain undo is one direct 01 04 write, not a full preset', () => {
  const old = tone(), next = structuredClone(old);
  next.pedals[3].params[0] = 0.72;
  assert.deepEqual(planToneDelta(old, next), [
    { kind: 'param', effect: 'ODS50CN', index: 0, value: 0.72 },
  ]);
});

test('same-model A/B can restore multiple params and footswitches together', () => {
  const old = tone(), next = structuredClone(old);
  next.pedals[3].params[0] = 0.72;
  next.pedals[3].params[1] = 0.32;
  next.pedals[2].isOn = true;
  assert.deepEqual(planToneDelta(old, next), [
    { kind: 'toggle', effect: 'Booster', on: true },
    { kind: 'param', effect: 'ODS50CN', index: 0, value: 0.72 },
    { kind: 'param', effect: 'ODS50CN', index: 1, value: 0.32 },
  ]);
});

test('unchanged variant requires no Bluetooth commands', () => {
  const old = tone(), next = structuredClone(old);
  next.slot = 0x7f;
  next.checksumOk = true;
  assert.deepEqual(planToneDelta(old, next), []);
});

test('model swaps, reordered chains, changed BPM, parameter shape and large edits retain the full-preset path', () => {
  const old = tone(), changed = structuredClone(old);
  changed.pedals[3].name = 'Deluxe65';
  assert.equal(planToneDelta(old, changed), null);
  const reordered = structuredClone(old);
  [reordered.pedals[0], reordered.pedals[1]] = [reordered.pedals[1], reordered.pedals[0]];
  assert.equal(planToneDelta(old, reordered), null);
  const bpm = structuredClone(old);
  bpm.bpm = 122;
  assert.equal(planToneDelta(old, bpm), null);
  const params = structuredClone(old);
  params.pedals[3].params.push(0.5);
  assert.equal(planToneDelta(old, params), null);
  const many = structuredClone(old);
  many.pedals[3].params = [0.9, 0.9, 0.9, 0.9, 0.9];
  assert.equal(planToneDelta(old, many, { maxCommands: 2 }), null);
  const invalid = structuredClone(old);
  invalid.pedals[3].params[0] = Infinity;
  assert.equal(planToneDelta(old, invalid), null);
});

test('float32 roundoff does not trigger unnecessary parameter sends', () => {
  const old = tone(), next = structuredClone(old);
  next.pedals[3].params[0] = Math.fround(0.5);
  assert.deepEqual(planToneDelta(old, next), []);
});

test('direct writes change simulated Spark 2 live sound without uploading or overwriting hardware slots', async () => {
  const transport = new MockSparkTransport({ name: 'Spark 2', latencyMs: 1 });
  const client = new SparkClient(transport, { timeoutMs: 500 });
  await client.connect();
  const old = await client.getPreset('current');
  const target = structuredClone(old);
  target.pedals[3].params[0] = 0.75;
  target.pedals[2].isOn = !target.pedals[2].isOn;
  const before = structuredClone(transport.presets[0]);
  const sent = [];
  client.addEventListener('sent', (e) => sent.push([e.detail.cmd, e.detail.sub]));
  const steps = planToneDelta(old, target);
  assert.equal(steps.length, 2);
  for (const step of steps) {
    if (step.kind === 'param') await client.setParam(step.effect, step.index, step.value);
    else await client.setEffectOnOff(step.effect, step.on);
  }
  const live = await client.getPreset('current');
  assert.ok(Math.abs(live.pedals[3].params[0] - 0.75) < 1e-5);
  assert.equal(live.pedals[2].isOn, target.pedals[2].isOn);
  assert.equal(transport.slot, 0, 'the playing hardware slot remains selected');
  assert.deepEqual(transport.presets[0], before, 'stored hardware preset was not touched');
  assert.equal(sent.some(([cmd, sub]) => cmd === 1 && sub === 1), false, 'no full preset upload');
});
