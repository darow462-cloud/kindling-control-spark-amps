import {
  SparkClient,
  WebBluetoothTransport,
  CapacitorBleTransport,
  MockSparkTransport,
  EFFECTS,
  findEffect,
  decode,
  decodeBtsnoop,
  presetToJson,
  presetFromJson,
  toHex,
  fromHex,
  TEMP_SLOT,
  PRESETS_PER_BANK,
  blankPreset,
  defaultParams,
  randomUuid,
} from '../spark/index.js';
import { PresetLibrary, normalizePresetMeta } from './library.js';
import { GuitarProfileLibrary } from './guitar-profiles.js';
import { filterOrganizedPresets } from './library-search.js';
import { exportLibraryBackup, planLibraryBackupImport, applyLibraryBackupPlan } from './library-backup.js';
import { createRig } from './rig.js';
import { ToneSession } from './tone-session.js';
import { initAudioPanel } from './audio-panel.js';
import { planToneDelta } from './tone-diff.js';
import { createReporter, detectApp, scrubLog } from './telemetry.js';
import { VERSION } from '../version.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// The Console can be popped out into another window (another document), so its
// elements are looked up once here rather than with $() later.
const consoleEls = {
  body: $('#console-body'),
  log: $('#log'),
  hideParams: $('#hide-params'),
  rawInput: $('#raw-input'),
  rawSend: $('#raw-send'),
};

const params = new URLSearchParams(location.search);
const useMock = params.has('mock');

// Anonymous error reports (see telemetry.js and docs/TELEMETRY.md): released builds only,
// never with the simulated amp, and only after the user opts in (first-run question below,
// then Settings). ?errors=on sends from a dev build, to test the Worker.
const errors = createReporter({
  version: VERSION,
  ...detectApp(window),
  storage: safeLocalStorage(),
  force: params.get('errors') === 'on',
});
if (!useMock) errors.install(window);
/** Report an error anonymously (the caller logs it to the Console). */
function reportError(where, err) {
  if (!useMock) errors.report(err, { where });
}

const state = {
  client: null,
  connected: false,
  preset: null, // current live state
  slot: null,
  bank: 0, // which bank of four the preset buttons show
  lastIndex: 0, // position (0-3) within the bank of the last hardware preset
  unsaved: false, // live tone came from New and hasn't been saved yet
  library: new PresetLibrary(),
  guitars: new GuitarProfileLibrary(),
  presetSlots: 4, // 8 on Spark 2
  mock: null,
};

// A and B each have independent, in-memory edit history. Nothing stored on the
// amp changes until the user explicitly chooses a hardware slot in Save….
const toneSession = new ToneSession();
let toneBusy = false;

function updateToneTools() {
  const ready = !!state.preset && toneSession.available;
  const bar = $('#tone-tools');
  bar.hidden = !ready;
  $('#tone-undo').disabled = !ready || toneBusy || !toneSession.canUndo;
  $('#tone-redo').disabled = !ready || toneBusy || !toneSession.canRedo;
  for (const side of ['A', 'B']) {
    const b = $('#tone-' + side.toLowerCase());
    b.disabled = !ready || toneBusy;
    b.setAttribute('aria-pressed', String(toneSession.active === side));
  }
  $('#tone-copy').disabled = !ready || toneBusy;
  $('#tone-copy').textContent = `Copy ${toneSession.active} → ${toneSession.active === 'A' ? 'B' : 'A'}`;
  $('#new-preset').disabled = toneBusy;
  $('#save-preset').disabled = !state.preset || toneBusy;
  $('#refresh').disabled = !state.connected || toneBusy;
  $('#rig').inert = toneBusy;
}

function resetToneSession() {
  toneSession.reset(state.preset);
  updateToneTools();
}

function recordToneEdit(key) {
  if (!state.preset) return;
  toneSession.record(state.preset, key);
  state.unsaved = true;
  renderPresetHeader();
  updateToneTools();
}

/** Prevent trailing throttled parameter writes from altering the next live tone. */
async function flushToneWrites() {
  rig.flushPendingParams();
  if (state.connected) await state.client.queue;
}

/**
 * Restore an entire tone non-destructively: connected amps play the temporary
 * slot 0x7F; no hardware preset is overwritten. Return the actual readback.
 */
async function restoreTone(target) {
  if (toneBusy || !target || !state.preset) return null;
  toneBusy = true;
  updateToneTools();
  try {
    // Wait for any final parameter writes from the previous knob drag. Sending
    // a fast restore before those writes complete would restore an old value.
    await flushToneWrites();
    if (state.connected) {
      const steps = planToneDelta(state.preset, target);
      if (steps !== null) {
        // Fast path: 01 04 sends individual scalar parameters, 01 15 toggles
        // effect on/off. Both modify only the live tone, not stored presets.
        // 01 04 has no ACK; relying on its write completion is consistent with
        // ordinary knob editing. Refresh remains available to verify readback.
        for (const step of steps) {
          if (step.kind === 'param') {
            await state.client.setParam(step.effect, step.index, step.value);
          } else {
            await state.client.setEffectOnOff(step.effect, step.on);
          }
        }
        state.preset = structuredClone(target);
        logLine('info', `fast tone restore: ${steps.length} direct change(s)`);
      } else {
        // A model/chain/metadata change (or many changes) still needs a full
        // preset upload followed by a readback to verify what the amp kept.
        await state.client.loadPreset(target, TEMP_SLOT);
        state.preset = await state.client.getPreset('current');
        state.slot = TEMP_SLOT;
        highlightSlot();
        logLine('info', 'full tone restore: temporary preset');
      }
    } else {
      state.preset = structuredClone(target);
    }
    state.unsaved = true;
    renderPreset();
    return structuredClone(state.preset);
  } catch (err) {
    logLine('err', `could not restore tone: ${err.message}`);
    reportError('restore-tone', err);
    // A partially completed command sequence could have changed the amp.
    // Read back its actual state and invalidate stale Undo/Redo snapshots.
    if (state.connected) {
      try {
        state.preset = await state.client.getPreset('current');
        resetToneSession();
        renderPreset();
      } catch (readError) {
        logLine('err', `could not resync after failed tone restore: ${readError.message}`);
      }
    }
    toast(`Couldn't restore tone: ${err.message}. Press Refresh to resync if necessary.`, 'warn');
    return null;
  } finally {
    toneBusy = false;
    updateToneTools();
  }
}

// ---------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------

function makeTransport() {
  if (useMock) {
    state.mock = new MockSparkTransport({
      name: params.get('mock') || 'Spark 40',
      battery: params.get('mock') !== 'Spark 40' && !!params.get('mock'),
      fixedChain: !params.has('reorder'), // ?mock&reorder=1 simulates an amp that accepts reordered chains
      swap: params.get('swap') || 'ok', // ?mock&swap=ignore|silent simulates an amp that ignores / never acks 01 06
    });
    window.mockAmp = state.mock; // play with it from devtools: mockAmp.turnKnob(3, 0, 0.9)
    return state.mock;
  }
  if (CapacitorBleTransport.isAvailable()) return new CapacitorBleTransport(); // Android / iOS app
  return new WebBluetoothTransport(); // browsers and the Electron desktop app
}

if (!useMock && !CapacitorBleTransport.isAvailable() && !WebBluetoothTransport.isSupported()) $('#unsupported').hidden = false;
if (window.kindlingDesktop) setupDesktopDevicePicker(window.kindlingDesktop);

$('#connect').addEventListener('click', async () => {
  if (state.connected) {
    await state.client.disconnect();
    return;
  }
  setStatus('busy', 'Connecting…');
  const client = new SparkClient(makeTransport());
  state.client = client;
  wireClient(client);
  try {
    await client.connect();
    setStatus('busy', 'Handshake…');
    const info = await client.handshake();
    state.connected = true;
    showInfo(info);
    setStatus('connected', info.name);
    setConnectedUi(true);
    state.presetSlots = info.model?.presetSlots ?? 4;
    $('.banks').hidden = state.presetSlots <= PRESETS_PER_BANK;
    state.slot = info.presetNumber;
    highlightSlot();
    await refreshPreset();
    resetToneSession();
  } catch (err) {
    console.error(err);
    reportError('connect', err);
    if (err.name === 'NotFoundError') setStatus('idle', 'Not connected');
    else setStatus('error', "Couldn't connect");
    logLine('err', `connect failed: ${err.message}`);
    if (err.name !== 'NotFoundError') {
      toast(`Couldn't connect: ${err.message}`, 'warn', { label: 'Troubleshooting', run: () => openHelp('troubleshooting') });
    }
    try {
      await client.disconnect();
    } catch {}
  }
});

function wireClient(c) {
  c.addEventListener('disconnected', () => {
    state.connected = false;
    setStatus('idle', 'Disconnected');
    setConnectedUi(false);
  });
  c.addEventListener('message', (e) => logMessage('rx', e.detail));
  c.addEventListener('sent', (e) => logMessage('tx', { ...decode(e.detail), seq: e.detail.seq, raw: e.detail.blocks }));
  c.addEventListener('sentRaw', (e) => logLine('tx', `raw ${toHex(e.detail.bytes)}`));
  c.addEventListener('error', (e) => {
    logLine('err', e.detail.error.message);
    reportError('client', e.detail.error);
  });
  c.addEventListener('log', (e) => logLine('info', `bluetooth: ${e.detail.text}`));

  // amp-side events (knobs and buttons on the amp)
  c.addEventListener('param', (e) => {
    const { effect, index, value, solicited } = e.detail;
    if (solicited || !state.preset) return;
    const i = state.preset.pedals.findIndex((f) => f.name === effect);
    if (i < 0) return;
    state.preset.pedals[i].params[index] = value;
    rig.updateParam(i, index, value);
    rig.flash(i);
    if (!toneBusy) toneSession.capture(state.preset);
  });
  c.addEventListener('effectOnOff', (e) => {
    const { effect, on } = e.detail;
    const i = state.preset?.pedals.findIndex((f) => f.name === effect) ?? -1;
    if (i < 0) return;
    state.preset.pedals[i].isOn = on;
    rig.setOnOff(i, on);
    rig.flash(i);
    if (!toneBusy) toneSession.capture(state.preset);
  });
  c.addEventListener('effectChanged', () => {
    if (!toneBusy) refreshPreset();
  });
  c.addEventListener('presetSelected', (e) => {
    // Internal A/B and Undo operations select the temporary slot.
    if (e.detail.solicited || e.detail.slot === TEMP_SLOT) return;
    state.slot = e.detail.slot;
    state.unsaved = false; // the amp moved on; the unsaved tone is gone
    highlightSlot();
    refreshPreset().then(resetToneSession);
  });
  c.addEventListener('presetStored', (e) => logLine('rx', `amp stored current state to preset ${e.detail.slot + 1}`));
  c.addEventListener('tuner', (e) => showTuner(e.detail));
  c.addEventListener('tunerOnOff', (e) => ($('#tuner-on').checked = e.detail.on));
  c.addEventListener('ampStatus', (e) => showBattery(e.detail));
}

function setStatus(st, text) {
  // st: idle | busy | connected | error. Phones show only the coloured Bluetooth icon;
  // the text stays for screen readers and as the tooltip.
  const el = $('#status');
  el.dataset.state = st;
  $('.status-text', el).textContent = text;
  el.title = text;
}

function setConnectedUi(on) {
  $('#connect').textContent = on ? 'Disconnect' : 'Connect';
  $('#connect').classList.toggle('primary', !on);
  for (const el of [$('#refresh'), consoleEls.rawSend, $('#tuner-on')]) el.disabled = !on;
  $('#info').hidden = !on;
}

function showInfo(info) {
  $('#i-name').textContent = info.name ?? '–';
  $('#i-fw').textContent = info.firmware ?? '–';
  $('#i-serial').textContent = info.serial ?? '–';
  showBattery(info.status);
}

function showBattery(s) {
  $('#i-batt-wrap').hidden = !s;
  if (!s) return;
  const raw = s.batteryRaw != null ? ` · raw ${s.batteryRaw}` : '';
  $('#i-batt').textContent = `${s.batteryPowered ? 'battery' : 'mains'}, ${s.charging}${raw}`;
}

// ---------------------------------------------------------------------------
// presets
// ---------------------------------------------------------------------------

// Amp events (preset button, effect change) can ask for a refresh while one is still
// running. Instead of queueing one read per event, a refresh requested meanwhile makes the
// running one read once more when it finishes; every caller awaits that same, latest read.
let refreshing = null;
let refreshAgain = false;

function refreshPreset() {
  if (!state.client) return Promise.resolve();
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      if (!state.client) break;
      try {
        state.preset = await state.client.getPreset('current');
        if (toneSession.available && !toneBusy) toneSession.capture(state.preset);
        renderPreset();
      } catch (err) {
        logLine('err', `could not read current preset: ${err.message}`);
        reportError('read-preset', err);
      }
    } while (refreshAgain);
  })().finally(() => (refreshing = null));
  return refreshing;
}

$('#refresh').addEventListener('click', async () => {
  if (toneBusy) return;
  await flushToneWrites();
  await refreshPreset();
});

for (const b of $$('.banks button')) {
  // Switching bank selects the preset in the same position in the new bank
  // (preset 3 in bank 1 -> preset 3 in bank 2).
  b.addEventListener('click', async () => {
    const bank = Number(b.dataset.bank);
    if (!state.connected) {
      state.bank = bank;
      highlightSlot({ followSlot: false });
      return;
    }
    if (bank === state.bank && isHwSlot(state.slot)) return;
    await selectSlot(bank * PRESETS_PER_BANK + state.lastIndex);
  });
}

for (const b of $$('.preset-buttons button')) {
  b.addEventListener('click', async () => {
    if (!state.connected) return;
    await selectSlot(state.bank * PRESETS_PER_BANK + Number(b.dataset.index));
  });
}

async function selectSlot(slot) {
  if (toneBusy) return;
  if (state.unsaved && !confirm('Your new preset is not saved yet. Switch presets anyway?')) return;
  try {
    await flushToneWrites();
    await state.client.selectPreset(slot);
    state.slot = slot;
    state.unsaved = false;
    highlightSlot();
    await refreshPreset();
    resetToneSession();
  } catch (err) {
    logLine('err', err.message);
    reportError('select-preset', err);
  }
}

const isHwSlot = (slot) => Number.isInteger(slot) && slot < state.presetSlots;

/** Sync bank + preset buttons with state.slot. A slot in bank 2 (4-7) switches the view to bank 2. */
function highlightSlot({ followSlot = true } = {}) {
  const isHw = isHwSlot(state.slot);
  if (isHw) state.lastIndex = state.slot % PRESETS_PER_BANK;
  if (followSlot && isHw) state.bank = Math.floor(state.slot / PRESETS_PER_BANK);
  for (const b of $$('.banks button')) b.setAttribute('aria-pressed', String(Number(b.dataset.bank) === state.bank));
  for (const b of $$('.preset-buttons button')) {
    const slot = state.bank * PRESETS_PER_BANK + Number(b.dataset.index);
    b.setAttribute('aria-pressed', String(isHw && slot === state.slot));
    b.setAttribute('aria-label', state.presetSlots > PRESETS_PER_BANK ? `Bank ${state.bank + 1}, preset ${b.dataset.index * 1 + 1}` : `Preset ${b.dataset.index * 1 + 1}`);
  }
}

function download(name, data) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `${(name || 'preset').replace(/[^\w.-]+/g, '_')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Latest live tone: ask the amp when connected, otherwise what the UI holds. */
async function liveTone() {
  if (state.connected) {
    try {
      return await state.client.getPreset('current');
    } catch (err) {
      logLine('err', `could not read live tone, using the UI's copy: ${err.message}`);
    }
  }
  return structuredClone(state.preset);
}

async function makeLive(preset) {
  if (toneBusy) return;
  await flushToneWrites();
  if (state.connected) {
    await state.client.loadPreset(preset, TEMP_SLOT);
    state.slot = TEMP_SLOT;
    highlightSlot();
    await refreshPreset();
  } else {
    state.preset = structuredClone(preset);
    renderPreset();
  }
  resetToneSession();
}

// ---- New ------------------------------------------------------------------

$('#new-preset').addEventListener('click', () => {
  $('#new-name').value = 'New preset';
  $('input[name="new-from"][value="current"]').disabled = !state.preset;
  $(`input[name="new-from"][value="${state.preset ? 'current' : 'blank'}"]`).checked = true;
  $('#new-dialog').showModal();
  $('#new-name').select();
});

$('#new-dialog').addEventListener('close', async () => {
  if ($('#new-dialog').returnValue !== 'ok') return;
  const name = $('#new-name').value.trim() || 'New preset';
  const from = $('input[name="new-from"]:checked').value;
  try {
    await flushToneWrites();
    const base = from === 'current' && state.preset ? await liveTone() : blankPreset(name);
    const preset = { ...base, name, uuid: randomUuid(), description: from === 'current' ? base.description : '' };
    await makeLive(preset);
    state.unsaved = true;
    renderPresetHeader();
  } catch (err) {
    logLine('err', `could not create preset: ${err.message}`);
    reportError('new-preset', err);
    alert(`Could not create preset: ${err.message}`);
  }
});

// ---- Save -----------------------------------------------------------------

function slotLabel(slot) {
  const pos = (slot % PRESETS_PER_BANK) + 1;
  return state.presetSlots > PRESETS_PER_BANK ? `Bank ${Math.floor(slot / PRESETS_PER_BANK) + 1}, preset ${pos}` : `Preset ${pos}`;
}

$('#save-preset').addEventListener('click', () => {
  if (!state.preset) return;
  $('#save-name').value = state.preset.name || '';
  $('#save-desc').value = state.preset.description || '';
  $('#save-library').checked = true;
  const meta = state.library.metadata(state.preset.uuid) ?? normalizePresetMeta();
  $('#save-artist').value = meta.artist;
  $('#save-song').value = meta.song;
  $('#save-tags').value = meta.tags.join(', ');
  $('#save-favorite').checked = meta.favorite;
  renderGuitarOptions($('#save-guitar'));
  $('#save-guitar').value = state.guitars.get(meta.guitarProfileId) ? meta.guitarProfileId : '';
  $('#save-organizer').open = !!(meta.artist || meta.song || meta.tags.length || meta.favorite || meta.guitarProfileId);
  const sel = $('#save-slot');
  sel.replaceChildren(new Option("Don't store on the amp", ''));
  if (state.connected) {
    for (let s = 0; s < state.presetSlots; s++) sel.append(new Option(`${slotLabel(s)}${s === state.slot ? ' (current)' : ''}`, String(s)));
    // default: overwrite the slot it came from, if it came from one; else don't store
    sel.value = isHwSlot(state.slot) ? String(state.slot) : '';
  }
  sel.disabled = !state.connected;
  updateSaveWarning();
  $('#save-dialog').showModal();
});

function updateSaveWarning() {
  const v = $('#save-slot').value;
  const w = $('#save-warning');
  w.hidden = v === '';
  if (v !== '') w.textContent = `This replaces what is stored in ${slotLabel(Number(v))} on the amp.`;
}
$('#save-slot').addEventListener('change', updateSaveWarning);

$('#save-dialog').addEventListener('close', async () => {
  if ($('#save-dialog').returnValue !== 'ok') return;
  const toLibrary = $('#save-library').checked;
  const slotValue = $('#save-slot').value;
  if (!toLibrary && slotValue === '') return;
  try {
    await flushToneWrites();
    const tone = await liveTone();
    const preset = {
      ...tone,
      name: $('#save-name').value.trim() || tone.name || 'Untitled',
      description: $('#save-desc').value.trim(),
      uuid: state.preset.uuid || tone.uuid || randomUuid(),
    };
    if (toLibrary) {
      state.library.save(preset, {
        artist: $('#save-artist').value,
        song: $('#save-song').value,
        tags: $('#save-tags').value,
        favorite: $('#save-favorite').checked,
        guitarProfileId: $('#save-guitar').value,
      });
    }
    if (slotValue !== '') {
      const slot = Number(slotValue);
      await state.client.storePreset(preset, slot);
      state.slot = slot;
      highlightSlot();
      logLine('info', `stored "${preset.name}" in ${slotLabel(slot)}`);
    }
    state.unsaved = false;
    if (state.connected) await refreshPreset();
    else {
      state.preset = preset;
      renderPreset();
    }
    resetToneSession();
  } catch (err) {
    logLine('err', `save failed: ${err.message}`);
    reportError('save-preset', err);
    alert(`Save failed: ${err.message}`);
  }
});

// ---- Library tab / preset organization / guitar profiles --------------------

let organizerUuid = null;
const sortText = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });

function setOptions(select, entries, first) {
  const selected = select.value;
  select.replaceChildren(new Option(first, ''), ...entries.map(({ label, value }) => new Option(label, value)));
  select.value = entries.some((x) => x.value === selected) ? selected : '';
}

function renderGuitarOptions(select) {
  const items = state.guitars.list().map((p) => ({ label: p.name, value: p.id }));
  setOptions(select, items, ['organize-guitar', 'save-guitar'].includes(select.id) ? 'Not assigned' : 'All guitars');
}

function openPresetOrganizer(uuid) {
  const meta = state.library.metadata(uuid);
  if (!meta) return;
  organizerUuid = uuid;
  $('#organize-artist').value = meta.artist;
  $('#organize-song').value = meta.song;
  $('#organize-tags').value = meta.tags.join(', ');
  $('#organize-favorite').checked = meta.favorite;
  renderGuitarOptions($('#organize-guitar'));
  $('#organize-guitar').value = state.guitars.get(meta.guitarProfileId) ? meta.guitarProfileId : '';
  $('#organize-dialog').showModal();
  $('#organize-artist').focus();
}

$('#organize-dialog').addEventListener('close', () => {
  const uuid = organizerUuid;
  organizerUuid = null;
  if ($('#organize-dialog').returnValue !== 'ok' || !uuid) return;
  state.library.updateMetadata(uuid, {
    artist: $('#organize-artist').value,
    song: $('#organize-song').value,
    tags: $('#organize-tags').value,
    favorite: $('#organize-favorite').checked,
    guitarProfileId: $('#organize-guitar').value,
  });
});

function fillGuitarForm(profile = null) {
  $('#guitar-id').value = profile?.id ?? '';
  $('#guitar-name').value = profile?.name ?? '';
  $('#guitar-tuning').value = profile?.tuning ?? '';
  $('#guitar-pickups').value = profile?.pickups ?? '';
  $('#guitar-voice').value = profile?.voice ?? '';
  $('#guitar-notes').value = profile?.notes ?? '';
  $('#guitar-delete').disabled = !profile?.id;
}

function renderGuitarList() {
  const profiles = state.guitars.list();
  const list = $('#guitars-list');
  list.replaceChildren(...profiles.map((p) => {
    const li = document.createElement('li');
    const details = Object.assign(document.createElement('div'), {
      className: 'guitar-profile-info',
      textContent: [p.name, p.tuning, p.pickups, p.voice].filter(Boolean).join(' · '),
    });
    const edit = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Edit' });
    edit.addEventListener('click', () => fillGuitarForm(p));
    li.append(details, edit);
    return li;
  }));
  if (!profiles.length) list.append(Object.assign(document.createElement('li'), {
    className: 'library-note', textContent: 'No guitar profiles yet.',
  }));
}

$('#guitars-open').addEventListener('click', () => {
  fillGuitarForm();
  renderGuitarList();
  $('#guitars-dialog').showModal();
});
$('#guitars-close').addEventListener('click', () => $('#guitars-dialog').close());
$('#guitar-new').addEventListener('click', () => {
  fillGuitarForm();
  $('#guitar-name').focus();
});
$('#guitar-form').addEventListener('submit', (e) => {
  e.preventDefault();
  try {
    const saved = state.guitars.save({
      id: $('#guitar-id').value,
      name: $('#guitar-name').value,
      tuning: $('#guitar-tuning').value,
      pickups: $('#guitar-pickups').value,
      voice: $('#guitar-voice').value,
      notes: $('#guitar-notes').value,
    });
    fillGuitarForm(saved);
    renderGuitarList();
    toast(`Saved guitar profile: ${saved.name}`, 'ok');
  } catch (err) {
    toast(`Couldn't save guitar profile: ${err.message}`, 'warn');
  }
});
$('#guitar-delete').addEventListener('click', () => {
  const id = $('#guitar-id').value;
  const profile = state.guitars.get(id);
  if (!profile || !confirm(`Delete guitar profile "${profile.name}"? Presets will be kept, but their guitar association will be cleared.`)) return;
  state.guitars.remove(id);
  state.library.unlinkGuitarProfile(id);
  fillGuitarForm();
  renderGuitarList();
});
state.guitars.addEventListener('change', () => {
  renderLibrary();
  renderGuitarList();
});

function presetExportWithOrganizer(uuid) {
  const preset = state.library.get(uuid);
  const meta = state.library.metadata(uuid);
  const guitar = state.guitars.get(meta?.guitarProfileId);
  if (!preset) return null;
  // Extra key is optional; original Ignitron-compatible preset fields remain.
  return {
    ...presetToJson(preset),
    KindlingControl: {
      organizer: { ...meta, guitarProfileId: '' },
      guitar: guitar ? { ...guitar, id: '' } : null,
    },
  };
}

function importOrganizer(raw, uuid) {
  const organizer = raw?.KindlingControl?.organizer;
  if (!organizer || typeof organizer !== 'object') return;
  const meta = normalizePresetMeta(organizer);
  const exportedGuitar = raw.KindlingControl.guitar;
  if (exportedGuitar && typeof exportedGuitar === 'object' && typeof exportedGuitar.name === 'string' && exportedGuitar.name.trim()) {
    const profiles = state.guitars.list();
    let profile = profiles.find((p) =>
      [p.name, p.tuning, p.pickups, p.voice].every((v, i) =>
        v === [exportedGuitar.name, exportedGuitar.tuning ?? '', exportedGuitar.pickups ?? '', exportedGuitar.voice ?? ''][i]));
    if (!profile) profile = state.guitars.save({ ...exportedGuitar, id: '' });
    meta.guitarProfileId = profile.id;
  } else {
    meta.guitarProfileId = '';
  }
  state.library.updateMetadata(uuid, meta);
}

function renderLibrary() {
  const all = state.library.list();
  const filterArtist = $('#library-artist-filter');
  const artists = [...new Set(all.map((p) => p.metadata.artist).filter(Boolean))]
    .sort(sortText).map((artist) => ({ label: artist, value: artist }));
  setOptions(filterArtist, artists, 'All artists');
  renderGuitarOptions($('#library-guitar-filter'));

  const filtered = filterOrganizedPresets(all, {
    query: $('#library-search').value,
    artist: filterArtist.value,
    guitarId: $('#library-guitar-filter').value,
    favoritesOnly: $('#library-favorites-only').checked,
  }, state.guitars.list());
  $('#library-empty').hidden = all.length > 0;
  $('#library-storage-warning').hidden = state.library.persistent && state.guitars.persistent;
  $('#library-results').textContent = all.length ? `Showing ${filtered.length} of ${all.length} saved presets` : '';

  const list = $('#library');
  list.replaceChildren(...filtered.map((p) => {
    const li = document.createElement('li');
    li.classList.toggle('active', p.uuid === state.preset?.uuid);
    const header = document.createElement('div');
    header.className = 'lib-header';
    const name = Object.assign(document.createElement('div'), { className: 'lib-name', textContent: p.name });
    const star = Object.assign(document.createElement('button'), {
      type: 'button', className: 'lib-star',
      textContent: p.metadata.favorite ? '★' : '☆',
      title: p.metadata.favorite ? 'Remove from favorites' : 'Add to favorites',
    });
    star.setAttribute('aria-label', star.title);
    star.setAttribute('aria-pressed', String(p.metadata.favorite));
    star.addEventListener('click', () => state.library.updateMetadata(p.uuid, { favorite: !p.metadata.favorite }));
    header.append(name, star);
    const amp = p.pedals.find((f) => findEffect(f.name)?.slot === 'amp') ?? p.pedals[3];
    const guitar = state.guitars.get(p.metadata.guitarProfileId);
    const detail = Object.assign(document.createElement('div'), {
      className: 'lib-meta',
      textContent: [
        [p.metadata.artist, p.metadata.song].filter(Boolean).join(' — '),
        guitar ? `Guitar: ${guitar.name}` : '',
        p.metadata.tags.join(', '),
        findEffect(amp?.name)?.name ?? amp?.name,
        p.savedAt ? `saved ${new Date(p.savedAt).toLocaleDateString()}` : '',
      ].filter(Boolean).join(' · '),
    });
    const actions = document.createElement('div');
    actions.className = 'lib-actions';
    const btn = (label, fn, cls = '') => {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: label, className: cls });
      b.addEventListener('click', fn);
      actions.append(b);
      return b;
    };
    btn('Load', async () => {
      if (state.unsaved && !confirm('Your new preset is not saved yet. Load this one anyway?')) return;
      try {
        await makeLive(state.library.get(p.uuid));
        state.unsaved = false;
        renderPresetHeader();
        selectTab($('#tab-tone'));
      } catch (err) {
        logLine('err', `load failed: ${err.message}`);
        reportError('load-preset', err);
      }
    }, 'primary');
    btn('Details', () => openPresetOrganizer(p.uuid));
    btn('Export', () => download(p.name, presetExportWithOrganizer(p.uuid)));
    btn('Delete', () => {
      if (confirm(`Delete "${p.name}" from My presets? (Presets stored on the amp are not affected.)`)) state.library.remove(p.uuid);
    });
    li.append(header, detail, actions);
    return li;
  }));
}
state.library.addEventListener('change', renderLibrary);
for (const id of ['library-search', 'library-artist-filter', 'library-guitar-filter', 'library-favorites-only']) {
  $('#' + id).addEventListener(id === 'library-search' ? 'input' : 'change', renderLibrary);
}
renderLibrary();

// Full-library backups can migrate data across differently named Portable
// builds. They are generated/read entirely locally; no Bluetooth commands.
$('#backup-export').addEventListener('click', () => {
  const backup = exportLibraryBackup(state.library, state.guitars);
  const date = new Date().toISOString().slice(0, 10);
  download(`kindlingcontrol-library-backup-${date}`, backup);
  toast(`Library backup exported: ${backup.presets.length} presets, ${backup.guitars.length} guitar profiles.`, 'ok');
});

$('#backup-import').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    if (file.size > 16 * 1024 * 1024) throw new Error('backup file is too large (16 MB limit)');
    const plan = planLibraryBackupImport(await file.text(), state.library, state.guitars);
    const count = plan.summary;
    const text = [
      `Restore backup "${file.name}"?`,
      `Add ${count.presetsToAdd} presets and ${count.guitarProfilesToAdd} guitar profiles.`,
      `${count.identicalPresetsSkipped} identical presets will be skipped.`,
      `${count.conflictsKeptAsCopies} presets with conflicting IDs will be imported as copies.`,
      'Existing presets and guitar profiles will not be overwritten.',
      'This affects only the local library, not the amp.',
    ].join('\n');
    if (!confirm(text)) return;
    applyLibraryBackupPlan(plan, state.library, state.guitars);
    logLine('info', `backup imported: ${count.presetsToAdd} presets, ${count.guitarProfilesToAdd} guitars; ${count.identicalPresetsSkipped} skipped`);
    toast(`Backup restored: ${count.presetsToAdd} presets and ${count.guitarProfilesToAdd} guitar profiles added.`, 'ok');
  } catch (err) {
    logLine('err', `library backup restore failed: ${err.message}`);
    alert(`Could not restore library backup: ${err.message}`);
  }
});

$('#import').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  let ok = 0;
  let copies = 0;
  for (const file of files) {
    try {
      const raw = JSON.parse(await file.text());
      const preset = presetFromJson(raw);
      if (!Array.isArray(preset.pedals) || !preset.pedals.length) throw new Error('no effects in file');
      let uuid = preset.uuid || randomUuid();
      if (state.library.get(uuid)) {
        // Importing a preset must never silently replace an existing tone.
        do { uuid = randomUuid(); } while (state.library.get(uuid));
        copies++;
      }
      state.library.save({ ...preset, uuid });
      importOrganizer(raw, uuid);
      ok++;
    } catch (err) {
      logLine('err', `import of ${file.name} failed: ${err.message}`);
      alert(`Could not import ${file.name}: ${err.message}`);
    }
  }
  if (ok) {
    logLine('info', `imported ${ok} preset${ok > 1 ? 's' : ''} into My presets${copies ? ` (${copies} as new copies to avoid overwriting)` : ''}`);
    if (copies) toast(`${copies} existing preset ID(s) were preserved; imported files were added as copies.`);
  }
});

$('#export-current').addEventListener('click', async () => {
  if (!state.preset || toneBusy) return;
  await flushToneWrites();
  download(state.preset.name, presetToJson(await liveTone()));
});

// ---------------------------------------------------------------------------
// rig (chain strip, amp head, pedalboard) -- see rig.js
// ---------------------------------------------------------------------------

const rig = createRig({
  root: $('#rig'),
  state,
  actions: {
    isBusy: () => toneBusy,
    onEdit: recordToneEdit,
    setParam: (effect, p, v) => state.client?.setParam(effect, p, v).catch((e) => (logLine('err', e.message), reportError('set-param', e))),
    setOnOff: (effect, on) => state.client?.setEffectOnOff(effect, on).catch((e) => (logLine('err', e.message), reportError('set-on-off', e))),
    async changeEffect(from, to) {
      if (toneBusy) return false;
      if (!state.connected) {
        const fx = state.preset.pedals.find((f) => f.name === from);
        if (fx) Object.assign(fx, { name: to, params: defaultParams(to, fx.params.length) });
        recordToneEdit('model');
        renderPreset();
        return true;
      }
      toneBusy = true;
      updateToneTools();
      try {
        await flushToneWrites();
        const { method, preset } = await state.client.swapEffect(from, to);
        state.preset = preset;
        if (method === 'preset') {
          state.slot = TEMP_SLOT;
          highlightSlot();
          logLine('info', `swap ${from} → ${to}: amp did not apply 01 06; loaded the edited preset into the temporary slot`);
          toast('The amp did not apply the quick model change. The edited tone is now in the temporary slot; nothing stored changed. Use Save… to keep it.');
        }
        recordToneEdit('model');
        renderPreset();
        return true;
      } catch (err) {
        logLine('err', `could not change ${from} to ${to}: ${err.message}`);
        reportError('change-effect', err);
        toast(`Couldn't change the model: ${err.message}`, 'warn', { label: 'Troubleshooting', run: () => openHelp('troubleshooting') });
        return false;
      } finally {
        toneBusy = false;
        updateToneTools();
      }
    },
    async applyOrder(pedals) {
      if (toneBusy) return;
      if (!state.connected) {
        state.preset = { ...state.preset, pedals };
        recordToneEdit('chain');
        renderPreset();
        toast('Chain order changed. Connect to an amp to try it.');
        return;
      }
      toneBusy = true;
      updateToneTools();
      try {
        await flushToneWrites();
        toast('Trying the new order on the amp (temporary slot, nothing stored changes)…');
        const tone = await liveTone();
        const { accepted, preset } = await state.client.tryChainOrder({ ...tone, pedals: pedals.map((fx) => tone.pedals.find((t) => t.name === fx.name) ?? fx) });
        state.slot = TEMP_SLOT;
        highlightSlot();
        state.preset = preset;
        recordToneEdit('chain');
        renderPreset();
        logLine('info', `chain reorder ${accepted ? 'kept' : 'normalised'} by amp: ${preset.pedals.map((f) => f.name).join(' → ')}`);
        toast(
          accepted
            ? 'Your amp kept the new order. Listen to check it really processes it that way, then Save… if you like it.'
            : 'Your amp put the effects back in its fixed order (gate → comp → drive → amp → mod → delay → reverb). Its firmware doesn\'t support reordering. Nothing stored was changed.',
          accepted ? 'ok' : 'warn',
        );
      } catch (err) {
        logLine('err', `reorder failed: ${err.message}`);
        reportError('reorder', err);
        toast(`Reorder failed: ${err.message}`, 'warn');
      } finally {
        toneBusy = false;
        updateToneTools();
      }
    },
  },
});

// History operations only become final once the amp has loaded and returned the
// restored tone. A failed Bluetooth transfer leaves the Undo/Redo stacks intact.
async function replayTone(direction) {
  if (toneBusy || !state.preset) return;
  const target = direction === 'undo' ? toneSession.peekUndo() : toneSession.peekRedo();
  if (!target) return;
  const applied = await restoreTone(target);
  if (!applied) return;
  if (direction === 'undo') toneSession.commitUndo(applied);
  else toneSession.commitRedo(applied);
  updateToneTools();
}

async function switchToneVariant(which) {
  if (toneBusy || !state.preset || toneSession.active === which) return;
  const previous = structuredClone(state.preset);
  const target = toneSession.snapshot(which);
  const applied = await restoreTone(target);
  if (!applied) return;
  toneSession.activate(which, previous, applied);
  updateToneTools();
}

$('#tone-undo').addEventListener('click', () => replayTone('undo'));
$('#tone-redo').addEventListener('click', () => replayTone('redo'));
$('#tone-a').addEventListener('click', () => switchToneVariant('A'));
$('#tone-b').addEventListener('click', () => switchToneVariant('B'));
$('#tone-copy').addEventListener('click', () => {
  if (toneBusy || !state.preset) return;
  const other = toneSession.copyToOther(state.preset);
  updateToneTools();
  toast(`Copied tone ${toneSession.active} into ${other}; now select ${other} to compare.`);
});

// Keep native text-input Undo behaviour. Shortcuts apply only when focus is
// outside editable controls and do not affect the hardware's saved presets.
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.target.closest?.('textarea, select, [contenteditable="true"], input:not([type="range"]):not([type="checkbox"])')) return;
  const k = e.key.toLowerCase();
  if (toneBusy || !state.preset) return;
  const redo = k === 'y' || (k === 'z' && e.shiftKey);
  const undo = k === 'z' && !e.shiftKey;
  if (redo && toneSession.canRedo) {
    e.preventDefault();
    replayTone('redo');
  } else if (undo && toneSession.canUndo) {
    e.preventDefault();
    replayTone('undo');
  }
});

function renderPreset() {
  const p = state.preset;
  renderPresetHeader();
  $('#save-preset').disabled = !p;
  $('#export-current').disabled = !p;
  rig.render();
  renderLibrary();
  updateToneTools();
}

function renderPresetHeader() {
  const p = state.preset;
  const name = $('#preset-name');
  name.textContent = p?.name || (p ? 'Untitled' : 'No preset loaded');
  if (p && state.unsaved) name.append(Object.assign(document.createElement('span'), { className: 'unsaved', textContent: 'not saved' }));
  $('#preset-desc').textContent = p ? [p.description, p.bpm ? `${Math.round(p.bpm)} BPM` : ''].filter(Boolean).join(' · ') : '';
}

let toastTimer;
/** Show a short message. `action` = { label, run } adds a button (e.g. open help). */
function toast(text, kind = 'info', action = null) {
  const t = $('#toast');
  t.replaceChildren(Object.assign(document.createElement('span'), { textContent: text }));
  if (action) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'toast-action', textContent: action.label });
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      t.hidden = true;
      action.run();
    });
    t.append(b);
  }
  t.dataset.kind = kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === 'info' && !action ? 4000 : 10000);
}
$('#toast').addEventListener('click', () => ($('#toast').hidden = true));

// ---------------------------------------------------------------------------
// help: the user guide (src/guide/) in a panel, so the amp stays connected
// ---------------------------------------------------------------------------

/** Open the user guide, optionally at a section id (see src/guide/index.html). */
function openHelp(section = '') {
  const dialog = $('#help-dialog');
  const frame = $('#help-frame');
  const url = `guide/index.html${section ? `#${section}` : ''}`;
  $('#help-newtab').href = url;
  // open first: a closed dialog has no layout, so the guide couldn't scroll
  if (!dialog.open) dialog.showModal();
  const loaded = frame.getAttribute('src') && frame.contentDocument?.readyState === 'complete';
  if (!loaded) {
    frame.setAttribute('src', url); // the browser jumps to the #section on load
    return;
  }
  // already loaded: scroll to the section without reloading
  const doc = frame.contentDocument;
  const target = (section && doc.getElementById(section)) || doc.querySelector('main h1') || doc.body;
  target.scrollIntoView({ block: 'start' });
  frame.contentWindow.history.replaceState(null, '', url.split('/').pop());
}
function onHelpClick(e) {
  const b = e.target.closest('[data-help]');
  if (!b) return;
  e.preventDefault();
  window.focus(); // when clicked in the popped-out Console, Help opens here
  openHelp(b.dataset.help);
}
document.addEventListener('click', onHelpClick);
$('#help-close').addEventListener('click', () => $('#help-dialog').close());
// The native apps' web views can't open extra windows; keep the guide in the panel there.
if (CapacitorBleTransport.isAvailable()) $('#help-newtab').hidden = true;
// No donation link inside the store apps (app store payment rules); web and desktop only.
if (CapacitorBleTransport.isAvailable()) $('#coffee').hidden = true;

// ---------------------------------------------------------------------------
// settings + about, and the first-run question about error reports
// ---------------------------------------------------------------------------

const APP_LABEL = { desktop: 'Desktop', android: 'Android', ios: 'iPhone/iPad', web: 'Web' };

function explainReports(host) {
  host.replaceChildren($('#reports-explainer').content.cloneNode(true));
}

function openSettings() {
  const { app } = detectApp(window);
  $('#about-version').textContent = `${VERSION === 'dev' ? 'development build' : `version ${VERSION}`} · ${APP_LABEL[app] ?? app}`;
  const reports = errors.available && !useMock;
  $('#settings-reports').hidden = !reports;
  if (reports) {
    $('#error-reports-on').checked = errors.enabled;
    explainReports($('.settings-reports-body'));
  }
  $('#settings-log').hidden = !reports;
  $('#send-log-open').disabled = !errors.canSendLog;
  $('#settings-dialog').showModal();
}
$('#settings-open').addEventListener('click', openSettings);

// Send Console log: a one-off, previewed send that the user starts; independent of the
// error-report switch. The preview shows the scrubbed text, exactly as it is sent.
$('#send-log-open').addEventListener('click', () => {
  const text = scrubLog(consoleText());
  if (!text) return toast('The Console is empty. Connect and reproduce the problem first.');
  $('#settings-dialog').close();
  $('#log-preview').textContent = text;
  $('#log-lines').textContent = String(text.split('\n').length);
  $('#log-dialog').returnValue = '';
  $('#log-dialog').showModal();
});
$('#log-dialog').addEventListener('close', async () => {
  const dialog = $('#log-dialog');
  if (dialog.returnValue !== 'send') return;
  const issue = Number.parseInt($('#log-issue').value, 10);
  // the previewed text, not the Console as it is now: what was shown is what is sent
  const sent = await errors.sendLog($('#log-preview').textContent, { note: $('#log-note').value, issue: Number.isInteger(issue) ? issue : undefined });
  if (sent) {
    $('#log-note').value = '';
    $('#log-issue').value = '';
    toast(`Sent ${sent.lines} Console lines. Thank you!`, 'ok');
  } else toast('The log couldn\'t be sent (at most 3 per session).', 'warn');
});
$('#log-dialog').addEventListener('click', (e) => {
  if (e.target.closest('[data-help]')) $('#log-dialog').close();
});
$('#error-reports-on').addEventListener('change', (e) => (errors.enabled = e.target.checked));
// Help links inside these dialogs open the guide on top of them.
$('#settings-dialog').addEventListener('click', (e) => {
  if (e.target.closest('[data-help]')) $('#settings-dialog').close();
});

// First run: ask before sending anything. Until they answer, nothing is sent.
if (errors.needsConsent && !useMock) {
  const dialog = $('#consent-dialog');
  explainReports($('.consent-body', dialog));
  dialog.addEventListener('close', () => {
    // Escape / closing without choosing counts as "not now": ask again next launch.
    if (dialog.returnValue === 'on' || dialog.returnValue === 'off') errors.enabled = dialog.returnValue === 'on';
  });
  dialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-help]')) dialog.close();
  });
  dialog.showModal();
}

// ---------------------------------------------------------------------------
// tuner
// ---------------------------------------------------------------------------

$('#tuner-on').addEventListener('change', (e) => {
  state.client?.setTuner(e.target.checked).catch((err) => logLine('err', err.message));
  if (!e.target.checked) showTuner(null);
});

function showTuner(t) {
  const needle = $('#tuner-needle');
  if (!t) {
    $('#tuner-note').textContent = '–';
    $('#tuner-cents').textContent = '';
    needle.style.insetInlineStart = '';
    return;
  }
  // offset is 0..1 with 0.5 = in tune (≈ ±50 cents range)
  const cents = Math.round((t.offset - 0.5) * 100);
  $('#tuner-note').textContent = t.noteName;
  $('#tuner-cents').textContent = `${cents > 0 ? '+' : ''}${cents} cents`;
  needle.style.insetInlineStart = `calc(${Math.min(1, Math.max(0, t.offset)) * 100}% - 0.175rem)`;
  needle.classList.toggle('in-tune', Math.abs(cents) <= 3);
}

// ---------------------------------------------------------------------------
// console
// ---------------------------------------------------------------------------

const NOISY = new Set(['param', 'tuner']);

function logMessage(dir, m) {
  if (consoleEls.hideParams.checked && NOISY.has(m.type)) return;
  const li = document.createElement('li');
  li.className = `${dir}${m.type === 'unknown' || m.type === 'unparsed' ? ' unknown' : ''}`;
  li.append(formatMessage(dir, m));
  appendLog(consoleEls.log, li);
}

function formatMessage(dir, m) {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const arrow = dir === 'tx' ? '→' : '←';
  const fields = { ...m };
  for (const k of ['cmd', 'sub', 'key', 'type', 'raw', 'seq', 'checksumOk', 'direction', 'timeMs', 't', 'solicited']) delete fields[k];
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `${m.t != null ? `${m.t.toFixed(3)}s ` : ''}${arrow} [${m.key}] #${(m.seq ?? 0).toString(16)} `;
  summary.append(meta, `${m.type}${m.checksumOk === false ? ' (BAD CHECKSUM)' : ''} ${summarize(fields)}`);
  details.append(summary);
  const pre = document.createElement('code');
  pre.className = 'hex';
  pre.textContent = (m.raw ?? []).map((b) => toHex(b)).join('\n');
  details.append(pre);
  return details;
}

function summarize(fields) {
  if (fields.preset) {
    const p = fields.preset;
    return `"${p.name}" slot=${p.current ? 'current' : p.slot} ${p.pedals.map((f) => (f.isOn ? f.name : `(${f.name})`)).join(' → ')}`;
  }
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(4) : v}`)
    .join(' ');
}

function logLine(cls, text) {
  const li = document.createElement('li');
  li.className = cls;
  li.textContent = text;
  appendLog(consoleEls.log, li);
}

function appendLog(list, li) {
  list.prepend(li);
  while (list.children.length > 500) list.lastElementChild.remove();
}

// Console as plain text, oldest first (the list is newest first), with each message's raw bytes.
function consoleText() {
  return [...consoleEls.log.children]
    .reverse()
    .map((li) => {
      const summary = li.querySelector('summary');
      if (!summary) return li.textContent;
      const hex = li.querySelector('.hex')?.textContent.trim().split('\n').join(' ');
      return `${summary.textContent}${hex ? `\n    ${hex}` : ''}`;
    })
    .join('\n');
}

$('#copy-log').addEventListener('click', async () => {
  const text = consoleText();
  if (!text) return toast('The Console is empty.');
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${consoleEls.log.children.length} Console lines.`, 'ok');
  } catch {
    toast('Couldn\'t copy automatically. Select the lines in the Console and copy them by hand.', 'warn');
  }
});

$('#clear-log').addEventListener('click', () => consoleEls.log.replaceChildren());

$('#raw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.connected) return;
  const text = consoleEls.rawInput.value.trim();
  try {
    const bytes = fromHex(text);
    if (bytes[0] === 0x01 && bytes[1] === 0xfe) await state.client.sendRaw(bytes);
    else if (bytes.length >= 2) await state.client.send({ cmd: bytes[0], sub: bytes[1], data: bytes.subarray(2) });
    else throw new Error('need at least cmd and sub bytes');
  } catch (err) {
    logLine('err', err.message);
  }
});

// Pop-out: the live Console nodes move into console.html and back, keeping their
// listeners. The connection stays in this window, so closing it closes the pop-out.
let consoleWindow = null;

function popOutConsole() {
  if (consoleWindow && !consoleWindow.closed) return consoleWindow.focus();
  const win = window.open('console.html', 'kindling-console', 'popup,width=760,height=680');
  if (!win) return logLine('err', 'the browser blocked the Console window');
  consoleWindow = win;
  win.addEventListener('load', () => {
    win.document.getElementById('console-host').append(win.document.adoptNode(consoleEls.body));
    win.document.addEventListener('click', onHelpClick);
    $('#console-popout', win.document).hidden = true;
    $('#console-away').hidden = false;
    win.addEventListener('pagehide', returnConsole);
  });
}

function returnConsole() {
  if (consoleEls.body.ownerDocument !== document) $('#panel-console').append(document.adoptNode(consoleEls.body));
  $('#console-popout').hidden = false;
  $('#console-away').hidden = true;
  const win = consoleWindow;
  consoleWindow = null;
  if (win && !win.closed) win.close();
}

$('#console-popout').addEventListener('click', popOutConsole);
$('#console-return').addEventListener('click', returnConsole);
window.addEventListener('pagehide', () => consoleWindow?.close());
// The native apps' web views can't open extra windows.
if (CapacitorBleTransport.isAvailable()) $('#console-popout').hidden = true;

// ---------------------------------------------------------------------------
// capture decoder
// ---------------------------------------------------------------------------

let captureMessages = [];

$('#capture-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const { fragments, messages } = decodeBtsnoop(new Uint8Array(await file.arrayBuffer()));
    captureMessages = messages;
    const kinds = [...new Set(fragments.map((f) => f.transport))].join(', ') || 'none';
    const unknown = messages.filter((m) => m.type === 'unknown' || m.type === 'unparsed').length;
    $('#capture-summary').textContent = fragments.length
      ? `${messages.length} Spark messages (${unknown} not yet understood) from ${fragments.length} fragments over ${kinds}.`
      : 'No Spark traffic found in this capture. Was the official app connected while logging?';
    renderCapture();
  } catch (err) {
    $('#capture-summary').textContent = `Could not read capture: ${err.message}`;
  }
});
$('#capture-unknown').addEventListener('change', renderCapture);

function renderCapture() {
  const only = $('#capture-unknown').checked;
  const list = $('#capture-log');
  list.replaceChildren();
  for (const m of captureMessages) {
    if (only && m.type !== 'unknown' && m.type !== 'unparsed') continue;
    const li = document.createElement('li');
    const dir = m.direction === 'toAmp' ? 'tx' : 'rx';
    li.className = `${dir}${m.type === 'unknown' || m.type === 'unparsed' ? ' unknown' : ''}`;
    li.append(formatMessage(dir, m));
    list.append(li);
  }
}

// ---------------------------------------------------------------------------
// tabs (roving tabindex, arrow-key navigation)
// ---------------------------------------------------------------------------

const tabs = $$('[role="tab"]');
function selectTab(tab) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  }
}
tabs.forEach((t, i) => {
  t.addEventListener('click', () => selectTab(t));
  t.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!d) return;
    const next = tabs[(i + d + tabs.length) % tabs.length];
    selectTab(next);
    next.focus();
  });
});

// Independent, local audio-analysis tab; does not access the Spark transport.
initAudioPanel();

// ---------------------------------------------------------------------------
// Electron: Chromium has no built-in Bluetooth chooser there, so the main
// process forwards the scan results and we show our own picker.
// ---------------------------------------------------------------------------

function setupDesktopDevicePicker(desktop) {
  const dialog = $('#bt-picker');
  const list = $('#bt-list');
  let open = false;
  const choose = (id) => {
    desktop.selectBluetoothDevice(id);
    open = false;
    dialog.close();
  };
  desktop.onBluetoothDevices((devices) => {
    if (!open) {
      open = true;
      dialog.showModal();
    }
    list.replaceChildren(
      ...devices.map((d) => {
        const li = document.createElement('li');
        const b = Object.assign(document.createElement('button'), { type: 'button', textContent: d.name || d.id });
        b.addEventListener('click', () => choose(d.id));
        li.append(b);
        return li;
      }),
    );
    $('#bt-scanning').hidden = devices.length > 0;
  });
  $('#bt-cancel').addEventListener('click', () => choose(''));
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    choose('');
  });
}

if (useMock) setStatus('idle', 'Simulated amp');
// expose for poking around in devtools
window.spark = { state, EFFECTS };

function safeLocalStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
