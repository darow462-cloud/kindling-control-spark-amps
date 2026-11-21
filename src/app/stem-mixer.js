// Shared local six-stem listening mixer. Native Demucs uses trusted session WAV
// URLs; RoFormer remains an isolated WebGPU studio and its WAVs are explicitly
// selected by the user. No model control, filesystem bridge or audio upload.
import { formatStemTime, isLocalWav } from './stem-compare.js';
import { normalizedClip } from './stem-trim-utils.js';

export const MIX_STEMS = Object.freeze(['drums', 'bass', 'vocals', 'guitar', 'piano', 'other']);
export const MIX_LABELS = Object.freeze({
  drums: 'Drums', bass: 'Bass', vocals: 'Vocals', guitar: 'Guitars',
  piano: 'Piano / keys', other: 'Other instruments',
});
const ALIASES = Object.freeze({
  drum: 'drums', drums: 'drums', bass: 'bass',
  vocal: 'vocals', vocals: 'vocals', voice: 'vocals',
  guitar: 'guitar', guitars: 'guitar', piano: 'piano', keys: 'piano',
  other: 'other',
});

export function identifyStemFile(fileName) {
  if (typeof fileName !== 'string' || !/\.wav$/i.test(fileName)) return null;
  const words = fileName.slice(0, -4).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const matches = new Set(words.map((word) => ALIASES[word]).filter(Boolean));
  return matches.size === 1 ? [...matches][0] : null;
}

export function audibleVolume({ volume, mute, solo }, anySolo) {
  return mute || (anySolo && !solo) ? 0 : Math.max(0, Math.min(1, volume));
}

function trustedDemucsStem(stem) {
  return !!stem && MIX_STEMS.includes(stem.name) &&
    typeof stem.url === 'string' &&
    /^kindling-stem:\/\/[0-9a-f-]+\/(drums|bass|vocals|guitar|piano|other)\.wav$/i.test(stem.url) &&
    stem.url.toLowerCase().endsWith('/' + stem.name + '.wav');
}

export function initStemMixer({
  root = document.getElementById('stem-mixer'),
  documentRef = document,
  urlApi = URL,
  onPlay = () => {},
  onSourcesChanged = () => {},
  onAnalyzeDemucs = null,
  onAnalyzeRoFormer = null,
} = {}) {
  if (!root) return null;
  const $ = (id) => root.querySelector('#' + id);
  const banks = { demucs: new Map(), roformer: new Map() };
  const settings = Object.fromEntries(MIX_STEMS.map((name) => [
    name, { volume: 0.65, mute: false, solo: false },
  ]));
  const players = Object.fromEntries(MIX_STEMS.map((name) => [
    name, documentRef.createElement('audio'),
  ]));
  const rows = {};
  const tracks = $('stem-mixer-rows');
  const status = $('stem-mixer-status');
  const playButton = $('stem-mixer-play');
  const stopButton = $('stem-mixer-stop');
  const seek = $('stem-mixer-seek');
  const clock = $('stem-mixer-clock');
  const analyzeButton = $('stem-mixer-analyze-guitar');
  const modeButtons = {
    demucs: $('stem-mixer-demucs'),
    roformer: $('stem-mixer-roformer'),
  };
  let active = 'demucs';
  let playing = false;
  let disposed = false;
  let generation = 0;
  let requestedPosition = 0;
  let previewEnd = null;
  const transportListeners = new Set();
  function notifyTransport() {
    if (disposed) return;
    const snapshot = {
      time: position(), duration: duration(), playing, mode: active,
    };
    for (const callback of transportListeners) {
      try { callback(snapshot); } catch { /* listener must not interrupt playback */ }
    }
  }

  function say(message, kind = '') {
    if (disposed) return;
    status.textContent = message;
    status.dataset.kind = kind;
  }
  function selected() { return banks[active]; }
  function activeSources() {
    return MIX_STEMS.filter((name) => selected().has(name))
      .map((name) => ({ name, url: selected().get(name).url }));
  }
  function firstPlayer() {
    const name = MIX_STEMS.find((n) => selected().has(n));
    return name ? players[name] : null;
  }
  function duration() {
    const lengths = MIX_STEMS
      .filter((n) => selected().has(n))
      .map((n) => players[n].duration)
      .filter((n) => Number.isFinite(n) && n > 0);
    return lengths.length ? Math.min(...lengths) : 0;
  }
  function position() {
    const player = firstPlayer();
    return player && Number.isFinite(player.currentTime) ? player.currentTime : requestedPosition;
  }
  function refresh() {
    if (disposed) return;
    const anySolo = MIX_STEMS.some((n) => selected().has(n) && settings[n].solo);
    for (const name of MIX_STEMS) {
      const row = rows[name];
      const item = selected().get(name);
      const setting = settings[name];
      const level = audibleVolume(setting, anySolo);
      players[name].volume = level;
      players[name].muted = level === 0;
      row.name.textContent = item?.file?.name ?? item?.label ?? 'No WAV selected';
      row.mute.disabled = !item;
      row.solo.disabled = !item;
      row.mute.setAttribute('aria-pressed', String(setting.mute));
      row.solo.setAttribute('aria-pressed', String(setting.solo));
      row.mute.classList.toggle('active', setting.mute);
      row.solo.classList.toggle('active', setting.solo);
      row.volume.value = String(Math.round(setting.volume * 100));
      row.volume.disabled = !item;
      row.level.textContent = Math.round(setting.volume * 100) + '%';
      row.file.hidden = active !== 'roformer';
    }
    for (const mode of ['demucs', 'roformer']) {
      modeButtons[mode].setAttribute('aria-pressed', String(mode === active));
      modeButtons[mode].classList.toggle('active', mode === active);
    }
    const hasAny = selected().size > 0;
    const length = duration();
    const now = Math.min(position(), length || position());
    playButton.disabled = !hasAny;
    stopButton.disabled = !hasAny;
    analyzeButton.disabled = !selected().has('guitar');
    playButton.textContent = playing ? 'Pause mix' : 'Play mix';
    seek.disabled = !length;
    seek.value = length ? String(Math.max(0, Math.min(1000, Math.round(now / length * 1000)))) : '0';
    clock.textContent = formatStemTime(now) + ' / ' + formatStemTime(length);
    notifyTransport();
  }
  function pauseAll() {
    ++generation;
    playing = false;
    previewEnd = null;
    for (const player of Object.values(players)) player.pause();
    refresh();
  }
  function clearAudio() {
    for (const player of Object.values(players)) {
      player.pause();
      player.removeAttribute('src');
      player.load();
    }
  }
  function setPosition(seconds) {
    requestedPosition = Math.max(0, seconds);
    for (const name of MIX_STEMS) {
      if (!selected().has(name)) continue;
      const player = players[name];
      const limit = Number.isFinite(player.duration) && player.duration > 0
        ? Math.max(0, player.duration - 0.01)
        : requestedPosition;
      try { player.currentTime = Math.min(requestedPosition, limit); } catch { /* pending metadata */ }
    }
    refresh();
  }
  function bindBank(positionSeconds = 0) {
    clearAudio();
    for (const name of MIX_STEMS) {
      const item = selected().get(name);
      if (!item) continue;
      players[name].src = item.url;
      players[name].preload = 'metadata';
      players[name].load();
    }
    setPosition(positionSeconds);
    refresh();
    onSourcesChanged({ mode: active, sources: activeSources() });
  }
  function chooseBank(mode) {
    if (disposed || !banks[mode] || mode === active) return;
    const previousPosition = position();
    pauseAll();
    active = mode;
    // Keep chosen location when alternating engines, without mixing engines.
    bindBank(previousPosition);
    say(mode === 'demucs' ? 'Demucs mix selected.' : 'RoFormer mix selected. Load exported WAV files below.');
  }
  function stop() {
    pauseAll();
    setPosition(0);
  }
  async function togglePlayback(keepPreviewRange = false) {
    if (disposed || !selected().size) return;
    if (playing) { pauseAll(); return; }
    if (!keepPreviewRange) previewEnd = null;
    const items = MIX_STEMS.filter((name) => selected().has(name));
    if (!items.length) return;
    const now = position();
    if (duration() && now >= duration() - 0.05) setPosition(0);
    const token = ++generation;
    playing = true;
    onPlay();
    refresh();
    const results = await Promise.allSettled(items.map((name) => {
      try { return Promise.resolve(players[name].play()); }
      catch (error) { return Promise.reject(error); }
    }));
    if (disposed || token !== generation) return;
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) {
      pauseAll();
      say('Could not play one or more WAVs: ' + (failed.reason?.message ?? 'audio error'), 'error');
    }
  }
  function releaseBank(mode) {
    for (const source of banks[mode].values()) {
      if (source.owned) urlApi.revokeObjectURL(source.url);
    }
    banks[mode].clear();
  }
  function putFile(name, file) {
    if (!MIX_STEMS.includes(name) || !isLocalWav(file)) return false;
    const previous = banks.roformer.get(name);
    const url = urlApi.createObjectURL(file);
    banks.roformer.set(name, { name, file, url, owned: true });
    if (previous?.owned) urlApi.revokeObjectURL(previous.url);
    return true;
  }
  function loadFileFor(name, file) {
    if (disposed || !MIX_STEMS.includes(name) || !isLocalWav(file)) {
      say('Choose a non-empty WAV file for this stem.', 'error');
      return false;
    }
    pauseAll();
    putFile(name, file);
    active = 'roformer';
    bindBank(0);
    say('Loaded RoFormer ' + name + ' WAV locally. ' + banks.roformer.size + '/6 tracks available.');
    return true;
  }
  function loadFiles(files) {
    if (disposed) return 0;
    const found = new Map();
    let ignored = 0;
    for (const file of Array.from(files ?? [])) {
      const name = identifyStemFile(file?.name);
      if (!name || !isLocalWav(file) || found.has(name)) { ignored++; continue; }
      found.set(name, file);
    }
    if (!found.size) {
      say('No uniquely named WAV stems found. Use each track’s Choose WAV control instead.', 'error');
      return 0;
    }
    pauseAll();
    for (const [name, file] of found) putFile(name, file);
    active = 'roformer';
    bindBank(0);
    say('Imported ' + found.size + ' WAV track(s). ' + ignored +
      ' skipped; names must include a unique instrument name.');
    return found.size;
  }

  for (const name of MIX_STEMS) {
    const row = documentRef.createElement('div');
    row.className = 'stem-mixer-row';
    const title = documentRef.createElement('strong');
    title.textContent = MIX_LABELS[name];
    const file = documentRef.createElement('input');
    file.type = 'file';
    file.accept = '.wav,audio/wav';
    file.setAttribute('aria-label', 'Choose RoFormer WAV for ' + MIX_LABELS[name]);
    file.addEventListener('change', () => {
      const chosen = file.files?.[0];
      file.value = '';
      if (chosen) loadFileFor(name, chosen);
    });
    const fileName = documentRef.createElement('span');
    fileName.className = 'stem-mixer-filename';
    const mute = documentRef.createElement('button');
    mute.type = 'button';
    mute.textContent = 'Mute';
    mute.addEventListener('click', () => {
      settings[name].mute = !settings[name].mute;
      refresh();
    });
    const solo = documentRef.createElement('button');
    solo.type = 'button';
    solo.textContent = 'Solo';
    solo.addEventListener('click', () => {
      settings[name].solo = !settings[name].solo;
      refresh();
    });
    const volume = documentRef.createElement('input');
    volume.type = 'range';
    volume.min = '0'; volume.max = '100'; volume.step = '1';
    volume.setAttribute('aria-label', MIX_LABELS[name] + ' volume');
    volume.addEventListener('input', () => {
      settings[name].volume = Number(volume.value) / 100;
      refresh();
    });
    const level = documentRef.createElement('span');
    level.className = 'stem-mixer-level';
    row.append(title, fileName, file, mute, solo, volume, level);
    tracks.append(row);
    rows[name] = { root: row, name: fileName, file, mute, solo, volume, level };
    const player = players[name];
    player.preload = 'metadata';
    player.addEventListener('loadedmetadata', () => {
      if (!disposed && selected().has(name)) setPosition(requestedPosition);
    });
    player.addEventListener('timeupdate', () => {
      if (disposed || !selected().has(name)) return;
      const master = firstPlayer();
      if (playing && master === player) {
        requestedPosition = position();
        if (previewEnd !== null && master.currentTime >= previewEnd - 0.025) {
          const stoppedAt = previewEnd;
          pauseAll();
          setPosition(stoppedAt);
          return;
        }
        for (const otherName of MIX_STEMS) {
          if (name === otherName || !selected().has(otherName)) continue;
          const other = players[otherName];
          if (other.readyState >= 1 && Math.abs(other.currentTime - master.currentTime) > 0.18) {
            const maxTime = Number.isFinite(other.duration) && other.duration > 0
              ? Math.max(0, other.duration - 0.01) : master.currentTime;
            other.currentTime = Math.min(master.currentTime, maxTime);
          }
        }
      }
      if (master === player) refresh();
    });
    player.addEventListener('ended', () => {
      if (!disposed && playing && firstPlayer() === player) pauseAll();
    });
    player.addEventListener('error', () => {
      if (!disposed && selected().has(name)) {
        pauseAll();
        say('Cannot read ' + name + ' WAV. Check that it is a supported audio file.', 'error');
      }
    });
  }

  modeButtons.demucs.addEventListener('click', () => chooseBank('demucs'));
  modeButtons.roformer.addEventListener('click', () => chooseBank('roformer'));
  playButton.addEventListener('click', () => { void togglePlayback(); });
  stopButton.addEventListener('click', stop);
  seek.addEventListener('input', () => {
    if (duration()) setPosition(duration() * Number(seek.value) / 1000);
  });
  $('stem-mixer-import').addEventListener('change', (event) => {
    loadFiles(event.target.files);
    event.target.value = '';
  });
  analyzeButton.addEventListener('click', async () => {
    const guitar = selected().get('guitar');
    if (!guitar) return;
    try {
      pauseAll();
      if (active === 'roformer') {
        if (!guitar.file || typeof onAnalyzeRoFormer !== 'function') {
          throw new Error('RoFormer guitar WAV not selected.');
        }
        await onAnalyzeRoFormer(guitar.file);
      } else {
        if (typeof onAnalyzeDemucs !== 'function') throw new Error('Analyze unavailable.');
        await onAnalyzeDemucs({ name: 'guitar', url: guitar.url });
      }
      say('Guitar reference loaded into Analyze.', 'success');
    } catch (error) {
      say('Cannot import guitar into Analyze: ' + error.message, 'error');
    }
  });

  refresh();
  return {
    loadDemucs(stems) {
      if (disposed || !Array.isArray(stems)) return 0;
      const valid = stems.filter(trustedDemucsStem);
      if (!valid.length) return 0;
      pauseAll();
      releaseBank('demucs');
      for (const stem of valid) banks.demucs.set(stem.name, {
        name: stem.name, label: stem.label || MIX_LABELS[stem.name],
        url: stem.url, owned: false,
      });
      active = 'demucs';
      bindBank(0);
      say('Loaded ' + banks.demucs.size + ' native Demucs tracks.');
      return banks.demucs.size;
    },
    loadRoFormerFiles: loadFiles,
    getActive: () => active,
    getLoadedNames: (mode = active) => [...(banks[mode]?.keys() ?? [])],
    getActiveSources: activeSources,
    getDuration: duration,
    getMuted: (name) => players[name]?.muted,
    previewRange(start, end, from = start) {
      const max = duration();
      if (!selected().size || !max) return false;
      try {
        const range = normalizedClip(start, end, max);
        const playFrom = Number.isFinite(from) && from >= range.start && from < range.end - 0.015
          ? from : range.start;
        pauseAll();
        setPosition(playFrom);
        previewEnd = range.end;
        void togglePlayback(true);
        return true;
      } catch { return false; }
    },
    getPosition: position,
    isPlaying: () => playing,
    seekTo(seconds) {
      const length = duration();
      if (disposed || !Number.isFinite(seconds) || length <= 0) return false;
      const target = Math.max(0, Math.min(length, seconds));
      if (playing && previewEnd !== null && target >= previewEnd - 0.015) {
        pauseAll();
      }
      setPosition(target);
      return true;
    },
    subscribeTransport(callback) {
      if (disposed || typeof callback !== 'function') return () => {};
      transportListeners.add(callback);
      callback({ time: position(), duration: duration(), playing, mode: active });
      return () => transportListeners.delete(callback);
    },
    pause: pauseAll,
    dispose() {
      if (disposed) return;
      pauseAll();
      disposed = true;
      clearAudio();
      releaseBank('demucs');
      releaseBank('roformer');
      transportListeners.clear();
    },
  };
}
