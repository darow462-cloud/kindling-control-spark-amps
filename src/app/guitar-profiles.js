// Optional local guitar profiles. These describe the player's instrument,
// tuning and pickup setup; they do not modify an amp tone or BLE messages.

import { randomUuid } from '../spark/messages.js';

const KEY = 'kindling-control.guitars.v1';
const clean = (v, limit = 100) => typeof v === 'string' ? v.trim().slice(0, limit) : '';

export function normalizeGuitarProfile(raw = {}) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    id: clean(p.id, 80),
    name: clean(p.name, 100),
    tuning: clean(p.tuning, 50),
    pickups: clean(p.pickups, 120),
    voice: clean(p.voice, 80),
    notes: clean(p.notes, 400),
  };
}

export class GuitarProfileLibrary extends EventTarget {
  constructor(storage = safeStorage()) {
    super();
    this.storage = storage;
    this.items = this._load();
  }

  list() {
    return this.items.map((p) => ({ ...p }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  get(id) {
    const p = this.items.find((x) => x.id === id);
    return p ? { ...p } : null;
  }

  save(raw) {
    const profile = normalizeGuitarProfile(raw);
    if (!profile.name) throw new Error('guitar profile needs a name');
    if (!profile.id) profile.id = randomUuid();
    const i = this.items.findIndex((x) => x.id === profile.id);
    if (i >= 0) this.items[i] = profile;
    else this.items.push(profile);
    this._persist();
    return { ...profile };
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((p) => p.id !== id);
    if (this.items.length !== before) this._persist();
  }

  get persistent() {
    return !!this.storage;
  }

  _load() {
    try {
      const raw = this.storage?.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed)
        ? parsed.map(normalizeGuitarProfile).filter((p) => p.id && p.name)
        : [];
    } catch {
      return [];
    }
  }

  _persist() {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.items));
    } catch {
      // blocked storage: continue for the current session
    }
    this.dispatchEvent(new Event('change'));
  }
}

function safeStorage() {
  try {
    const s = globalThis.localStorage;
    const probe = '__kindling_guitars_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}
