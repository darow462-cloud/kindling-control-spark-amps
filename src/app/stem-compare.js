// Local guitar-stem comparison in KindlingControl (no audio uploads or model calls).
// The Demucs guitar comes from its trusted session-only WAV URL; users select
// a RoFormer WAV explicitly because the WebGPU studio has a separate origin.
// Only one of the two audio players runs at a time. A/B switching transfers the
// playback position; it does not pretend to be sample-accurate multitrack sync.
export function formatStemTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

export function isLocalWav(file) {
  return !!file && typeof file.name === 'string' &&
    /\.wav$/i.test(file.name) && Number.isFinite(file.size) && file.size > 0;
}

export function initStemCompare({
  root = document.getElementById('stem-compare'),
  documentRef = document,
  urlApi = URL,
  onPlay = () => {},
} = {}) {
  if (!root) return null;
  const $ = (id) => root.querySelector('#' + id);
  const players = {
    a: documentRef.createElement('audio'),
    b: documentRef.createElement('audio'),
  };
  const sources = { a: null, b: null };
  const names = { a: $('stem-compare-a-name'), b: $('stem-compare-b-name') };
  const buttons = { a: $('stem-compare-a'), b: $('stem-compare-b') };
  const seek = $('stem-compare-seek');
  const play = $('stem-compare-play');
  const stop = $('stem-compare-stop');
  const clock = $('stem-compare-clock');
  const status = $('stem-compare-status');
  let active = 'a';
  let disposed = false;
  let swapSerial = 0;

  function say(message, kind = '') {
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function refresh() {
    if (disposed) return;
    for (const side of ['a', 'b']) {
      buttons[side].disabled = !sources[side];
      buttons[side].setAttribute('aria-pressed', String(active === side && !!sources[side]));
      names[side].textContent = sources[side]?.name ?? 'No WAV selected';
    }
    const player = players[active];
    const ready = !!sources[active];
    const duration = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : 0;
    play.disabled = !ready;
    stop.disabled = !ready;
    play.textContent = ready && !player.paused ? 'Pause' : 'Play';
    seek.disabled = !ready || !duration;
    seek.value = duration ? String(Math.min(1000, Math.round(1000 * player.currentTime / duration))) : '0';
    clock.textContent = formatStemTime(player.currentTime) + ' / ' + formatStemTime(duration);
  }

  function playback(player) {
    onPlay(); // Pause any separate Demucs preview player.
    try {
      Promise.resolve(player.play()).catch((error) => {
        if (!disposed) say('Audio playback failed: ' + error.message, 'error');
      });
    } catch (error) {
      say('Audio playback failed: ' + error.message, 'error');
    }
  }

  function swapTo(side) {
    if (disposed || !sources[side] || active === side) return;
    const previous = players[active];
    const position = Number.isFinite(previous.currentTime) ? previous.currentTime : 0;
    const keepPlaying = !previous.paused;
    previous.pause();
    const serial = ++swapSerial;
    active = side;
    const next = players[side];
    const resume = () => {
      if (disposed || serial !== swapSerial || active !== side) return;
      const duration = Number.isFinite(next.duration) && next.duration > 0 ? next.duration : position;
      next.currentTime = Math.min(position, Math.max(0, duration - 0.01));
      if (keepPlaying) playback(next);
      refresh();
    };
    if (next.readyState >= 1) resume();
    else next.addEventListener('loadedmetadata', resume, { once: true });
    refresh();
  }

  function setSource(side, url, name, owned = false) {
    if (disposed || !['a', 'b'].includes(side)) return;
    const current = sources[side];
    ++swapSerial; // Invalidate delayed A/B swaps waiting on stale metadata.
    players[side].pause();
    players[side].removeAttribute('src');
    if (current?.owned) urlApi.revokeObjectURL(current.url);
    sources[side] = { url, name, owned };
    players[side].src = url;
    players[side].load();
    if (!sources[active]) active = side;
    say((side === 'a' ? 'Demucs' : 'RoFormer') + ' guitar ready. Press Play or switch A/B.');
    refresh();
  }

  function pickFile(side) {
    const input = $(side === 'a' ? 'stem-compare-a-file' : 'stem-compare-b-file');
    const file = input.files?.[0];
    if (!file) return;
    if (!isLocalWav(file)) {
      say('Choose a non-empty WAV file. No audio was imported.', 'error');
      input.value = '';
      return;
    }
    const url = urlApi.createObjectURL(file);
    setSource(side, url, file.name, true);
  }

  function togglePlayback() {
    if (!sources[active]) return;
    const player = players[active];
    if (player.paused) playback(player);
    else player.pause();
    refresh();
  }

  function stopPlayback() {
    ++swapSerial;
    for (const player of Object.values(players)) {
      player.pause();
      player.currentTime = 0;
    }
    refresh();
  }

  for (const side of ['a', 'b']) {
    const player = players[side];
    player.preload = 'metadata';
    for (const type of ['loadedmetadata', 'timeupdate', 'play', 'pause', 'ended']) {
      player.addEventListener(type, refresh);
    }
    player.addEventListener('error', () => {
      if (!disposed && sources[side]) say('Unable to read the ' + (side === 'a' ? 'Demucs' : 'RoFormer') + ' WAV file.', 'error');
    });
    buttons[side].addEventListener('click', () => swapTo(side));
    $(side === 'a' ? 'stem-compare-a-file' : 'stem-compare-b-file')
      .addEventListener('change', () => pickFile(side));
  }

  play.addEventListener('click', togglePlayback);
  stop.addEventListener('click', stopPlayback);
  seek.addEventListener('input', () => {
    if (!sources[active]) return;
    const player = players[active];
    if (!Number.isFinite(player.duration) || player.duration <= 0) return;
    player.currentTime = player.duration * Number(seek.value) / 1000;
    refresh();
  });
  refresh();
  return {
    setDemucs(stem) {
      if (!stem || stem.name !== 'guitar' ||
          typeof stem.url !== 'string' ||
          !/^kindling-stem:\/\/[a-f0-9-]+\/guitar\.wav$/i.test(stem.url)) return false;
      setSource('a', stem.url, 'Guitar (latest Demucs)', false);
      return true;
    },
    pause() {
      for (const player of Object.values(players)) player.pause();
      refresh();
    },
    getActive: () => active,
    dispose() {
      if (disposed) return;
      disposed = true;
      ++swapSerial;
      for (const side of ['a', 'b']) {
        const player = players[side];
        player.pause();
        player.removeAttribute('src');
        player.load();
        if (sources[side]?.owned) urlApi.revokeObjectURL(sources[side].url);
      }
    },
  };
}
