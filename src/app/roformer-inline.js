// Embed the pinned BS-RoFormer WebGPU app directly in KindlingControl's
// Stems tab. Keep the existing Demucs panel available without spawning a
// second Electron window or exposing Node/amp privileges to the iframe.
//
// The iframe has its own secure kindling-roformer:// origin and an explicit
// WebGPU feature delegation. Stemyla keeps its own model cache and songs.
//
// The heavyweight WASM app is loaded only when Stems is first selected.
export const ROFORMER_INLINE_URL = 'kindling-roformer://studio/index.html';

export function initInlineRoformer({
  root,
  bridge,
  Observer = globalThis.MutationObserver,
} = {}) {
  if (!root) return null;
  const $ = (name) => root.querySelector('#' + name);
  const roformerButton = $('stem-engine-roformer');
  const demucsButton = $('stem-engine-demucs');
  const roformerPane = $('stem-roformer-pane');
  const demucsPane = $('stem-demucs-pane');
  const frame = $('stem-roformer-frame');
  const status = $('stem-roformer-status');
  const advancedToggle = $('stem-roformer-advanced-toggle');
  const advancedShell = $('stem-roformer-frame-shell');
  // Keep the GPU iframe mounted at its real rendering size even when its
  // visible region is collapsed. Never detach/reload it on toggle.
  function toggleAdvanced() {
    if (!advancedShell || !advancedToggle) return;
    const expanded = advancedShell.classList.toggle('expanded');
    advancedToggle.setAttribute('aria-expanded', String(expanded));
    advancedToggle.textContent = expanded ? 'Hide Advanced Studio' : 'Show Advanced Studio';
    frame.tabIndex = expanded ? 0 : -1;
  }
  advancedToggle?.addEventListener('click', toggleAdvanced);
  if (advancedShell && !advancedShell.classList.contains('expanded')) frame.tabIndex = -1;
  const supported = typeof bridge?.status === 'function';
  let active = supported ? 'roformer' : 'demucs';
  let mounted = false;
  let checking = false;
  let disposed = false;

  roformerButton.disabled = !supported;

  function say(message, type = '') {
    status.textContent = message;
    status.dataset.kind = type;
  }

  async function ensureMounted() {
    // Do not load a GPU-heavy WebAssembly app on the Tone/Analyze screens.
    if (disposed || mounted || checking || active !== 'roformer' ||
        root.hidden || roformerPane.hidden || !supported) return;
    checking = true;
    try {
      const result = await bridge.status();
      if (!result?.available || result.url !== ROFORMER_INLINE_URL) {
        throw new Error('RoFormer WebGPU assets are not bundled in this Portable.');
      }
      if (disposed || active !== 'roformer' || root.hidden || roformerPane.hidden) return;
      frame.addEventListener('load', () => {
        if (!disposed) say('RoFormer workspace loaded. Choose a song, then separate six tracks.');
      }, { once: true });
      frame.addEventListener('error', () => {
        if (!disposed) say('Could not load the local RoFormer workspace.', 'error');
      }, { once: true });
      frame.hidden = false;
      say('Loading local RoFormer WebGPU workspace…');
      frame.src = ROFORMER_INLINE_URL;
      mounted = true;
    } catch (error) {
      if (!disposed) say(`RoFormer unavailable: ${error.message}`, 'error');
    } finally {
      checking = false;
    }
  }

  function chooseEngine(engine) {
    active = engine === 'roformer' && supported ? 'roformer' : 'demucs';
    const roformer = active === 'roformer';
    roformerPane.hidden = !roformer;
    demucsPane.hidden = roformer;
    roformerButton.setAttribute('aria-pressed', String(roformer));
    demucsButton.setAttribute('aria-pressed', String(!roformer));
    roformerButton.classList.toggle('active', roformer);
    demucsButton.classList.toggle('active', !roformer);
    if (roformer) void ensureMounted();
  }

  roformerButton.addEventListener('click', () => chooseEngine('roformer'));
  demucsButton.addEventListener('click', () => chooseEngine('demucs'));

  // The application's outer tab navigation uses [hidden] on panel-stems.
  // Watch that attribute rather than adding a second set of role="tab"
  // buttons, which would conflict with the global tab controller.
  const observer = Observer ? new Observer(() => {
    if (!root.hidden && active === 'roformer') void ensureMounted();
  }) : null;
  observer?.observe(root, { attributes: true, attributeFilter: ['hidden'] });
  chooseEngine(active);
  if (!supported) {
    say('RoFormer requires the Windows Portable build; Demucs controls are shown instead.');
  }

  return {
    getEngine: () => active,
    getMounted: () => mounted,
    dispose() { disposed = true; observer?.disconnect(); },
  };
}
