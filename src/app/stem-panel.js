// Windows-only six-stem playback UI. All OS filesystem and subprocess actions
// go through the narrow kindlingDesktop.stems preload bridge.

const fmtSize = (size) => `${(size / (1024 * 1024)).toFixed(1)} MB`;

export function initStemPanel({ root = document.getElementById('panel-stems'), onAnalyzeGuitar } = {}) {
  if (!root) return null;
  const $ = (id) => root.querySelector('#' + id);
  const api = window.kindlingDesktop?.stems;
  const supported = !!api?.supported;
  const warn = $('stem-support-warning');
  warn.hidden = supported;
  const state = { file: null, output: null, running: false, stems: [], activeId: null };

  function status(text, kind = '') {
    const element = $('stem-status');
    element.textContent = text;
    element.dataset.kind = kind;
  }

  function updateButtons() {
    $('stem-select-file').disabled = !supported || state.running;
    $('stem-select-output').disabled = !supported || state.running;
    $('stem-start').disabled = !supported || state.running || !state.file || !state.output;
    $('stem-cancel').disabled = !supported || !state.running;
    $('stem-open-folder').disabled = !supported || !state.stems.length;
    $('stem-analyze-guitar').disabled = !state.stems.some((stem) => stem.name === 'guitar');
    $('stem-progress').hidden = !state.running;
  }

  async function choose(type) {
    try {
      const selected = type === 'file' ? await api.chooseInput() : await api.chooseOutput();
      if (!selected) return;
      if (type === 'file') {
        state.file = selected;
        $('stem-file-label').textContent = selected.name;
      } else {
        state.output = selected;
        $('stem-output-label').textContent = selected.path;
      }
      status('Ready to separate into six WAV tracks.');
    } catch (err) {
      status(`Selection failed: ${err.message}`, 'error');
    }
    updateButtons();
  }

  function clearPlayers() {
    for (const audio of $('stem-track-list').querySelectorAll('audio')) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    $('stem-track-list').replaceChildren();
  }

  function renderStems() {
    clearPlayers();
    const list = $('stem-track-list');
    for (const stem of state.stems) {
      const article = document.createElement('article');
      article.className = 'stem-track';
      const info = document.createElement('div');
      info.className = 'stem-track-title';
      const title = document.createElement('strong');
      title.textContent = stem.label;
      const size = document.createElement('span');
      size.textContent = fmtSize(stem.bytes);
      info.append(title, size);
      const player = document.createElement('audio');
      player.controls = true;
      player.preload = 'metadata';
      player.src = stem.url;
      player.setAttribute('aria-label', `Listen to ${stem.label}`);
      // Single-track audition: starting a player pauses the other instruments.
      player.addEventListener('play', () => {
        for (const other of list.querySelectorAll('audio')) {
          if (other !== player) other.pause();
        }
      });
      article.append(info, player);
      list.append(article);
    }
    $('stem-results').hidden = !state.stems.length;
    updateButtons();
  }

  async function start() {
    if (state.running) return;
    state.running = true;
    state.stems = [];
    clearPlayers();
    $('stem-results').hidden = true;
    status('Starting HTDemucs 6-stem. First use downloads the 84 MB model locally…');
    updateButtons();
    try {
      const result = await api.start();
      state.activeId = result.id;
      status('Separating… model setup and first-time GPU shaders may take a while.');
    } catch (err) {
      state.running = false;
      status(`Cannot start: ${err.message}`, 'error');
      updateButtons();
    }
  }

  function onEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'started') {
      state.activeId = event.id;
      state.running = true;
      status('Separation started. Working entirely on your computer…');
    } else if (event.id && event.id !== state.activeId) {
      return; // ignore stale finish/progress from a previous job
    } else if (event.type === 'progress') {
      status(event.text || 'Separating…');
    } else if (event.type === 'complete') {
      state.running = false;
      state.stems = Array.isArray(event.stems) ? event.stems : [];
      status(`Done. ${state.stems.length} WAV tracks saved to ${event.outputDir}`, 'success');
      renderStems();
    } else if (event.type === 'canceled') {
      state.running = false;
      status('Canceled. Incomplete WAVs from this run were discarded.');
    } else if (event.type === 'error') {
      state.running = false;
      status(event.message || 'Separation failed. Check the Vulkan GPU and the first-run model download.', 'error');
    }
    updateButtons();
  }

  $('stem-select-file').addEventListener('click', () => choose('file'));
  $('stem-select-output').addEventListener('click', () => choose('output'));
  $('stem-start').addEventListener('click', start);
  $('stem-cancel').addEventListener('click', async () => {
    if (!state.running) return;
    status('Canceling separation…');
    try { await api.cancel(); } catch (err) { status(`Cancel failed: ${err.message}`, 'error'); }
  });
  $('stem-open-folder').addEventListener('click', async () => {
    try {
      const err = await api.openOutput();
      if (err) status(`Could not open output folder: ${err}`, 'error');
    } catch (err) { status(`Could not open folder: ${err.message}`, 'error'); }
  });
  $('stem-analyze-guitar').addEventListener('click', async () => {
    const guitar = state.stems.find((stem) => stem.name === 'guitar');
    if (!guitar || typeof onAnalyzeGuitar !== 'function') return;
    try {
      await onAnalyzeGuitar(guitar);
    } catch (err) {
      status(`Could not load guitar in Analyze: ${err.message}`, 'error');
    }
  });
  const dispose = supported ? api.onEvent(onEvent) : () => {};
  window.addEventListener('pagehide', () => {
    dispose();
    clearPlayers();
  }, { once: true });
  updateButtons();
  return { getStatus: () => ({ ...state }) };
}
