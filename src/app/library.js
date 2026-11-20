// "My presets" are stored separately from the amp's hardware banks.
// The existing v1 localStorage key and Ignitron-compatible preset JSON are
// unchanged; organizer metadata lives alongside the preset, never in BLE data.

import { presetToJson, presetFromJson } from '../spark/messages.js';

const KEY = 'kindling-control.presets.v1';
const LEGACY_KEYS = ['spark-control.presets.v1'];

const text = (value, max = 80) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function normalizePresetMeta(value = {}) {
  const m = value && typeof value === 'object' ? value : {};
  const rawTags = Array.isArray(m.tags) ? m.tags : (typeof m.tags === 'string' ? m.tags.split(',') : []);
  const tags = [...new Set(rawTags.map((tag) => text(tag, 32)).filter(Boolean))].slice(0, 12);
  return {
    artist: text(m.artist),
    song: text(m.song),
    tags,
    favorite: m.favorite === true,
    guitarProfileId: text(m.guitarProfileId, 80),
  };
}

export class PresetLibrary extends EventTarget {
  constructor(storage = safeStorage()) {
    super();
    this.storage = storage;
    this.items = this._load();
  }

  /** Most-recently-saved first; each item has a copy of its organizer metadata. */
  list() {
    return [...this.items]
      .sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0))
      .map((i) => ({
        ...presetFromJson(i.json),
        savedAt: i.savedAt,
        metadata: normalizePresetMeta(i.metadata),
      }));
  }

  /** Return only a Spark-compatible preset. Organizer data never reaches BLE. */
  get(uuid) {
    const entry = this.items.find((x) => x.json.UUID === uuid);
    return entry ? presetFromJson(entry.json) : null;
  }

  metadata(uuid) {
    const entry = this.items.find((x) => x.json.UUID === uuid);
    return entry ? normalizePresetMeta(entry.metadata) : null;
  }

  /** Add/replace a tone while retaining its metadata unless explicitly supplied. */
  save(preset, metadata = undefined, { savedAt = Date.now() } = {}) {
    if (!preset.uuid) throw new Error('preset needs a uuid');
    const json = presetToJson({ ...preset, slot: null });
    delete json.PresetNumber;
    const i = this.items.findIndex((x) => x.json.UUID === preset.uuid);
    const old = i >= 0 ? this.items[i] : null;
    const entry = {
      json,
      savedAt: Number.isFinite(savedAt) && savedAt > 0 ? savedAt : Date.now(),
      metadata: normalizePresetMeta(metadata === undefined ? old?.metadata : metadata),
    };
    if (i >= 0) this.items[i] = entry;
    else this.items.push(entry);
    this._persist();
  }

  updateMetadata(uuid, patch) {
    const item = this.items.find((x) => x.json.UUID === uuid);
    if (!item) return false;
    item.metadata = normalizePresetMeta({ ...normalizePresetMeta(item.metadata), ...patch });
    this._persist();
    return true;
  }

  /** Remove dangling guitar associations when a guitar profile is deleted. */
  unlinkGuitarProfile(profileId) {
    let changed = false;
    for (const item of this.items) {
      if (item.metadata?.guitarProfileId !== profileId) continue;
      item.metadata = normalizePresetMeta({ ...item.metadata, guitarProfileId: '' });
      changed = true;
    }
    if (changed) this._persist();
  }

  remove(uuid) {
    this.items = this.items.filter((x) => x.json.UUID !== uuid);
    this._persist();
  }

  get persistent() {
    return !!this.storage;
  }

  _load() {
    try {
      this._migrateLegacy();
      const raw = this.storage?.getItem(KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr)
        ? arr.filter((x) => x?.json?.UUID && Array.isArray(x.json.Pedals))
          .map((x) => ({ ...x, metadata: normalizePresetMeta(x.metadata) }))
        : [];
    } catch {
      return [];
    }
  }

  _migrateLegacy() {
    if (!this.storage || this.storage.getItem(KEY) !== null) return;
    for (const old of LEGACY_KEYS) {
      const raw = this.storage.getItem(old);
      if (raw === null) continue;
      this.storage.setItem(KEY, raw);
      this.storage.removeItem(old);
      return;
    }
  }

  _persist() {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.items));
    } catch {
      // storage is blocked or full; keep working in memory
    }
    this.dispatchEvent(new Event('change'));
  }
}

function safeStorage() {
  try {
    const s = globalThis.localStorage;
    const probe = '__spark_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}
