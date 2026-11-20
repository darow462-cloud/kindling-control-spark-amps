// Full local library backups. Everything here is local JSON and never travels
// to the Spark amplifier. Planning and validation are separate from mutations.

import { presetToJson, presetFromJson, randomUuid } from '../spark/messages.js';
import { normalizePresetMeta } from './library.js';
import { normalizeGuitarProfile } from './guitar-profiles.js';

export const BACKUP_FORMAT = 'kindling-control-library';
export const BACKUP_VERSION = 1;
const MAX_PRESETS = 1000;
const MAX_GUITARS = 200;

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const profileKey = (g) => JSON.stringify([g.name, g.tuning, g.pickups, g.voice, g.notes]);

function idFrom(used, generator) {
  for (let n = 0; n < 50; n++) {
    const id = generator();
    if (typeof id === 'string' && id && !used.has(id)) {
      used.add(id);
      return id;
    }
  }
  throw new Error('could not generate a unique ID for the imported item');
}

function sameTone(a, b) {
  const normalize = (tone) => {
    const json = presetToJson(tone);
    delete json.PresetNumber; // library tones are not hardware slot assignments
    return json;
  };
  return equal(normalize(a), normalize(b));
}

export function exportLibraryBackup(library, guitars, exportedAt = new Date().toISOString()) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt,
    guitars: guitars.list().map((g) => ({ ...g })),
    presets: library.list().map((p) => ({
      preset: presetToJson(p),
      metadata: normalizePresetMeta(p.metadata),
      savedAt: p.savedAt ?? null,
    })),
  };
}

/**
 * Validate the full file before planning any changes.
 * A malformed/incompatible file must never partially alter local storage.
 */
export function parseLibraryBackup(input) {
  const doc = typeof input === 'string' ? JSON.parse(input) : input;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) ||
      doc.format !== BACKUP_FORMAT || doc.version !== BACKUP_VERSION) {
    throw new Error('not a supported KindlingControl library backup (version 1)');
  }
  if (!Array.isArray(doc.presets) || !Array.isArray(doc.guitars) ||
      doc.presets.length > MAX_PRESETS || doc.guitars.length > MAX_GUITARS) {
    throw new Error('backup item lists are missing or too large');
  }

  const guitarIds = new Set();
  const guitars = doc.guitars.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid guitar profile');
    const g = normalizeGuitarProfile(raw);
    if (!g.id || !g.name || guitarIds.has(g.id)) throw new Error('duplicate or invalid guitar profile ID');
    guitarIds.add(g.id);
    return g;
  });

  const presetIds = new Set();
  const presets = doc.presets.map((entry) => {
    if (!entry || typeof entry !== 'object' || !entry.preset || typeof entry.preset !== 'object') {
      throw new Error('invalid preset backup entry');
    }
    const raw = entry.preset;
    if (typeof raw.UUID !== 'string' || !raw.UUID.trim() || presetIds.has(raw.UUID) ||
        typeof raw.Name !== 'string' || !Array.isArray(raw.Pedals) ||
        raw.Pedals.length < 1 || raw.Pedals.length > 16 ||
        raw.Pedals.some((fx) => !fx || typeof fx.Name !== 'string' || !fx.Name ||
          !Array.isArray(fx.Parameters) || fx.Parameters.length > 64 ||
          fx.Parameters.some((v) => !Number.isFinite(v) || v < 0 || v > 1))) {
      throw new Error('invalid or duplicate preset in backup');
    }
    presetIds.add(raw.UUID);
    const preset = presetFromJson(raw);
    const savedAt = Number.isFinite(entry.savedAt) && entry.savedAt > 0 ? entry.savedAt : Date.now();
    return { preset, metadata: normalizePresetMeta(entry.metadata), savedAt };
  });
  return { guitars, presets };
}

/**
 * Plan a non-destructive import. Exact existing items are reused/skipped;
 * conflicting IDs are re-created with fresh IDs instead of overwriting.
 * This plan is side-effect-free until applyLibraryBackupPlan() is called.
 */
export function planLibraryBackupImport(input, library, guitars, generateId = randomUuid) {
  const doc = parseLibraryBackup(input);
  const usedGuitarIds = new Set(guitars.list().map((g) => g.id));
  const usedPresetIds = new Set(library.list().map((p) => p.uuid));
  const allGuitars = guitars.list();
  const newGuitars = [];
  const guitarMap = new Map();
  let reusedGuitars = 0;

  for (const g of doc.guitars) {
    const existing = [...allGuitars, ...newGuitars].find((v) => profileKey(v) === profileKey(g));
    if (existing) {
      guitarMap.set(g.id, existing.id);
      reusedGuitars++;
      continue;
    }
    const id = usedGuitarIds.has(g.id) ? idFrom(usedGuitarIds, generateId) : g.id;
    usedGuitarIds.add(id);
    const newProfile = { ...g, id };
    newGuitars.push(newProfile);
    guitarMap.set(g.id, id);
  }

  const newPresets = [];
  let copiedPresets = 0;
  let skippedPresets = 0;
  for (const entry of doc.presets) {
    const { preset, savedAt } = entry;
    const metadata = { ...entry.metadata };
    const linkedId = guitarMap.get(metadata.guitarProfileId) ?? metadata.guitarProfileId;
    metadata.guitarProfileId = usedGuitarIds.has(linkedId) ? linkedId : '';
    const existing = library.get(preset.uuid);
    if (existing && sameTone(existing, preset) && equal(library.metadata(preset.uuid), metadata)) {
      skippedPresets++;
      continue;
    }
    let uuid = preset.uuid;
    if (usedPresetIds.has(uuid)) {
      uuid = idFrom(usedPresetIds, generateId);
      copiedPresets++;
    }
    usedPresetIds.add(uuid);
    newPresets.push({ preset: { ...preset, uuid }, metadata, savedAt });
  }

  return {
    newGuitars,
    newPresets,
    summary: {
      guitarProfilesToAdd: newGuitars.length,
      existingProfilesReused: reusedGuitars,
      presetsToAdd: newPresets.length,
      conflictsKeptAsCopies: copiedPresets,
      identicalPresetsSkipped: skippedPresets,
    },
  };
}

export function applyLibraryBackupPlan(plan, library, guitars) {
  for (const g of plan.newGuitars) guitars.save(g);
  for (const { preset, metadata, savedAt } of plan.newPresets) {
    library.save(preset, metadata, { savedAt });
  }
  return plan.summary;
}
