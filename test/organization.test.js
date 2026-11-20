import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PresetLibrary, normalizePresetMeta } from '../src/app/library.js';
import { GuitarProfileLibrary, normalizeGuitarProfile } from '../src/app/guitar-profiles.js';
import { filterOrganizedPresets } from '../src/app/library-search.js';
import { blankPreset } from '../src/spark/effects.js';
import { presetToJson } from '../src/spark/messages.js';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

test('existing v1 presets load with empty organizer metadata and unchanged Spark tone', () => {
  const store = memoryStorage();
  const old = new PresetLibrary(store);
  const sound = { ...blankPreset('Old Tone'), uuid: 'OLD-1' };
  old.save(sound);
  const raw = JSON.parse(store.getItem('kindling-control.presets.v1'));
  delete raw[0].metadata; // pre-0.4 library data
  store.setItem('kindling-control.presets.v1', JSON.stringify(raw));

  const lib = new PresetLibrary(store);
  assert.equal(lib.list()[0].metadata.artist, '');
  assert.equal(lib.list()[0].metadata.favorite, false);
  assert.deepEqual(lib.get('OLD-1').pedals, sound.pedals);
  assert.deepEqual(presetToJson(lib.get('OLD-1')).Pedals, presetToJson(sound).Pedals);
});

test('organizer metadata persists, normalizes tags and survives saving the same preset', () => {
  const store = memoryStorage();
  const lib = new PresetLibrary(store);
  const preset = { ...blankPreset('Rhythm'), uuid: 'ONE' };
  lib.save(preset);
  assert.equal(lib.updateMetadata('ONE', {
    artist: ' Children of Bodom ',
    song: ' Sixpounder ',
    favorite: true,
    tags: 'Rhythm, Drop C, Rhythm',
    guitarProfileId: 'g1',
  }), true);
  lib.save({ ...preset, name: 'Rhythm v2' });
  const item = new PresetLibrary(store).list()[0];
  assert.equal(item.name, 'Rhythm v2');
  assert.deepEqual(item.metadata, {
    artist: 'Children of Bodom',
    song: 'Sixpounder',
    favorite: true,
    tags: ['Rhythm', 'Drop C'],
    guitarProfileId: 'g1',
  });
  assert.equal(lib.updateMetadata('missing', { favorite: true }), false);
});

test('only approved organizer fields are retained; metadata never leaks into Spark preset JSON', () => {
  const m = normalizePresetMeta({ favorite: 'true', song: 'Song', customCommand: [1, 2, 3], tags: ['A', 'A', 'B'] });
  assert.equal(m.favorite, false);
  assert.equal(Object.hasOwn(m, 'customCommand'), false);
  const lib = new PresetLibrary(memoryStorage());
  lib.save({ ...blankPreset('Filtered'), uuid: 'abc' }, m);
  assert.equal(Object.hasOwn(presetToJson(lib.get('abc')), 'KindlingControl'), false);
  assert.equal(Object.hasOwn(lib.get('abc'), 'metadata'), false);
});

test('guitar profile can be created, updated, persisted, deleted and unlinked safely', () => {
  const store = memoryStorage();
  const guitars = new GuitarProfileLibrary(store);
  const created = guitars.save({
    name: 'Cort X700',
    tuning: 'Drop C',
    pickups: 'Fishman Fluence Open Core Modern',
    voice: 'Bridge / Voice 1',
    notes: 'High gain rhythm',
  });
  assert.ok(created.id);
  assert.equal(guitars.get(created.id).tuning, 'Drop C');
  guitars.save({ ...created, voice: 'Bridge / Voice 2' });
  const loaded = new GuitarProfileLibrary(store);
  assert.equal(loaded.list().length, 1);
  assert.equal(loaded.get(created.id).voice, 'Bridge / Voice 2');

  const lib = new PresetLibrary(store);
  lib.save({ ...blankPreset('Lead'), uuid: 'song-1' }, { guitarProfileId: created.id, song: 'Sixpounder' });
  loaded.remove(created.id);
  lib.unlinkGuitarProfile(created.id);
  assert.equal(lib.list()[0].metadata.guitarProfileId, '');
  assert.equal(lib.list()[0].metadata.song, 'Sixpounder');
  assert.equal(new GuitarProfileLibrary(store).get(created.id), null);
});

test('profiles and preset library remain usable when storage is unavailable', () => {
  const guitars = new GuitarProfileLibrary(null);
  const lib = new PresetLibrary(null);
  assert.equal(guitars.persistent, false);
  assert.throws(() => guitars.save({ name: '' }), /needs a name/);
  const profile = guitars.save({ name: 'Session guitar' });
  lib.save({ ...blankPreset('Temporary'), uuid: 'TEMP' }, { guitarProfileId: profile.id });
  assert.equal(guitars.list().length, 1);
  assert.equal(lib.list()[0].metadata.guitarProfileId, profile.id);
});

test('artist/song/tag search and favorites/guitar filters can combine', () => {
  const presets = [
    { name: 'Fast Rhythm', description: 'Heavy tone',
      metadata: { artist: 'Children of Bodom', song: 'Sixpounder', tags: ['Drop C'], favorite: true, guitarProfileId: 'g1' } },
    { name: 'Clean', description: 'Ambient',
      metadata: { artist: 'Other Band', song: 'Ballad', tags: ['Clean'], favorite: false, guitarProfileId: 'g2' } },
  ];
  const guitars = [{ id: 'g1', name: 'Cort X700' }, { id: 'g2', name: 'Other guitar' }];
  assert.equal(filterOrganizedPresets(presets, { query: 'sixpounder' }, guitars).length, 1);
  assert.equal(filterOrganizedPresets(presets, { query: 'cort' }, guitars).length, 1);
  assert.equal(filterOrganizedPresets(presets, { artist: 'Children of Bodom', favoritesOnly: true, guitarId: 'g1' }, guitars).length, 1);
  assert.equal(filterOrganizedPresets(presets, { artist: 'Children of Bodom', guitarId: 'g2' }, guitars).length, 0);
  assert.equal(filterOrganizedPresets(presets, { query: 'drop c' }, guitars).length, 1);
  assert.equal(filterOrganizedPresets(presets, {}, guitars).length, 2);
  assert.equal(normalizeGuitarProfile({ name: ' Guitar ', id: ' x ' }).name, 'Guitar');
});
