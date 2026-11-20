import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PresetLibrary } from '../src/app/library.js';
import { GuitarProfileLibrary } from '../src/app/guitar-profiles.js';
import {
  exportLibraryBackup, parseLibraryBackup, planLibraryBackupImport,
  applyLibraryBackupPlan, BACKUP_FORMAT,
} from '../src/app/library-backup.js';
import { blankPreset } from '../src/spark/effects.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}
function setup() {
  const storage = memoryStorage();
  return { library: new PresetLibrary(storage), guitars: new GuitarProfileLibrary(storage), storage };
}

function makeTone(name, uuid, gain = 0.5) {
  const p = { ...blankPreset(name), uuid };
  p.pedals[3].params[0] = gain;
  return p;
}

test('backup restores tones, metadata, guitar links and original save dates without Bluetooth', () => {
  const src = setup();
  src.guitars.save({ id: 'g-1', name: 'Cort X700', tuning: 'Drop C', voice: 'Bridge Voice 1' });
  src.library.save(makeTone('Sixpounder', 'preset-1'), {
    artist: 'Children of Bodom', song: 'Sixpounder',
    favorite: true, tags: ['Rhythm', 'Drop C'], guitarProfileId: 'g-1',
  }, { savedAt: 1720000000000 });
  const backup = exportLibraryBackup(src.library, src.guitars, '2026-11-20T12:00:00Z');
  assert.equal(backup.format, BACKUP_FORMAT);
  assert.equal(backup.presets.length, 1);
  assert.equal(backup.guitars.length, 1);
  const dest = setup();
  const plan = planLibraryBackupImport(JSON.stringify(backup), dest.library, dest.guitars);
  assert.deepEqual(plan.summary, {
    guitarProfilesToAdd: 1, existingProfilesReused: 0,
    presetsToAdd: 1, conflictsKeptAsCopies: 0, identicalPresetsSkipped: 0,
  });
  applyLibraryBackupPlan(plan, dest.library, dest.guitars);
  const restored = dest.library.list()[0];
  assert.equal(restored.name, 'Sixpounder');
  assert.equal(restored.savedAt, 1720000000000);
  assert.equal(restored.metadata.artist, 'Children of Bodom');
  assert.equal(restored.metadata.song, 'Sixpounder');
  assert.equal(restored.metadata.favorite, true);
  assert.deepEqual(restored.metadata.tags, ['Rhythm', 'Drop C']);
  assert.equal(dest.guitars.get(restored.metadata.guitarProfileId).name, 'Cort X700');
  assert.equal(dest.library.get(restored.uuid).pedals[3].params[0], 0.5);
  assert.equal(Object.hasOwn(dest.library.get(restored.uuid), 'metadata'), false, 'local organizer must not reach Spark BLE');
  const reopened = new PresetLibrary(dest.storage);
  assert.deepEqual(reopened.list()[0].metadata, restored.metadata);
});

test('restoring the same backup twice is idempotent', () => {
  const src = setup();
  src.guitars.save({ id: 'g', name: 'Main guitar', tuning: 'E Standard' });
  src.library.save(makeTone('Tone', 'tone'), { guitarProfileId: 'g', favorite: true });
  const backup = exportLibraryBackup(src.library, src.guitars);
  const dest = setup();
  applyLibraryBackupPlan(planLibraryBackupImport(backup, dest.library, dest.guitars), dest.library, dest.guitars);
  const plan2 = planLibraryBackupImport(backup, dest.library, dest.guitars);
  assert.equal(plan2.summary.presetsToAdd, 0);
  assert.equal(plan2.summary.guitarProfilesToAdd, 0);
  assert.equal(plan2.summary.identicalPresetsSkipped, 1);
});

test('UUID conflicts produce separate copies, never replace local tones or guitars', () => {
  const dest = setup();
  dest.guitars.save({ id: 'g-1', name: 'Existing guitar', tuning: 'E' });
  dest.library.save(makeTone('My sound', 'preset-1', 0.3), { favorite: false });
  const oldTone = dest.library.get('preset-1');
  const oldGuitar = dest.guitars.get('g-1');

  const source = setup();
  source.guitars.save({ id: 'g-1', name: 'Imported guitar', tuning: 'Drop C' });
  source.library.save(makeTone('Different sound', 'preset-1', 0.8), {
    guitarProfileId: 'g-1', favorite: true, artist: 'Children of Bodom',
  });
  const backup = exportLibraryBackup(source.library, source.guitars);
  let seq = 0;
  const plan = planLibraryBackupImport(backup, dest.library, dest.guitars, () => 'copy-' + (++seq));
  assert.equal(plan.summary.guitarProfilesToAdd, 1);
  assert.equal(plan.summary.presetsToAdd, 1);
  assert.equal(plan.summary.conflictsKeptAsCopies, 1);
  applyLibraryBackupPlan(plan, dest.library, dest.guitars);

  assert.deepEqual(dest.library.get('preset-1'), oldTone);
  assert.deepEqual(dest.guitars.get('g-1'), oldGuitar);
  assert.equal(dest.library.list().length, 2);
  const added = dest.library.list().find((p) => p.uuid !== 'preset-1');
  assert.equal(added.pedals[3].params[0], 0.8);
  assert.equal(added.metadata.favorite, true);
  assert.equal(dest.guitars.get(added.metadata.guitarProfileId).name, 'Imported guitar');

  const second = planLibraryBackupImport(backup, dest.library, dest.guitars);
  assert.equal(second.summary.presetsToAdd, 0, 'reimport must not create another duplicate copy');
});

test('same guitar with a different ID is reused, not imported twice', () => {
  const source = setup();
  source.guitars.save({ id: 'old-id', name: 'Cort X700', tuning: 'Drop C', voice: 'Bridge' });
  source.library.save(makeTone('Lead', 'p-1'), { guitarProfileId: 'old-id' });
  const target = setup();
  target.guitars.save({ id: 'new-id', name: 'Cort X700', tuning: 'Drop C', voice: 'Bridge' });
  const plan = planLibraryBackupImport(exportLibraryBackup(source.library, source.guitars), target.library, target.guitars);
  assert.equal(plan.summary.guitarProfilesToAdd, 0);
  assert.equal(plan.summary.existingProfilesReused, 1);
  applyLibraryBackupPlan(plan, target.library, target.guitars);
  assert.equal(target.library.list()[0].metadata.guitarProfileId, 'new-id');
});

test('invalid backups never mutate the existing library', () => {
  const target = setup();
  target.library.save(makeTone('Safe', 'safe'));
  const cases = [
    { version: 1, presets: [], guitars: [] },
    { format: BACKUP_FORMAT, version: 999, presets: [], guitars: [] },
    { format: BACKUP_FORMAT, version: 1, presets: {}, guitars: [] },
    { format: BACKUP_FORMAT, version: 1, presets: [{ preset: { UUID: 'x', Name: 'Broken', Pedals: [] } }], guitars: [] },
    { format: BACKUP_FORMAT, version: 1, presets: [], guitars: [{ id: 'dup', name: 'A' }, { id: 'dup', name: 'B' }] },
    '{not json',
  ];
  for (const input of cases) {
    assert.throws(() => planLibraryBackupImport(input, target.library, target.guitars));
  }
  assert.deepEqual(target.library.list().map((p) => p.name), ['Safe']);
  assert.deepEqual(target.guitars.list(), []);
  assert.equal(parseLibraryBackup({ format: BACKUP_FORMAT, version: 1, presets: [], guitars: [] }).presets.length, 0);
});

test('backups work even when browser storage is unavailable', () => {
  const library = new PresetLibrary(null);
  const guitars = new GuitarProfileLibrary(null);
  library.save(makeTone('Only in memory', 'ram'));
  const backup = exportLibraryBackup(library, guitars);
  const target = new PresetLibrary(null);
  const profiles = new GuitarProfileLibrary(null);
  applyLibraryBackupPlan(planLibraryBackupImport(backup, target, profiles), target, profiles);
  assert.equal(target.get('ram').name, 'Only in memory');
});
