# Experimental BS-RoFormer SW WebGPU studio (KindlingControl 0.7.1 inline)

This is an **optional, independently implemented separator**, not a filter or
postprocessor on Demucs outputs. The goal is to give users a different neural
model for comparison when Demucs guitar is muffled or bleeds into other stems.

## Exact upstream source

- Rust/WebGPU studio: [lloydmeta/stemyla](https://github.com/lloydmeta/stemyla)
- Pinned commit: `b2a771808d36f9a8d2f333528805d0ee2c1040a8`
- Studio source: MIT or Apache-2.0; its `m4a/` ALAC code is Apache-2.0.
- The Windows CI builds the pinned WebAssembly app **from source** and includes
  its LICENSE-MIT, LICENSE-APACHE and THIRD-PARTY notices in the Portable.
- The trained BS-RoFormer SW **weights are not bundled**. Their original trainer
  and license grant are not clearly established. The upstream studio provides
  an explicit **Download model (~350 MB)** action, which obtains a copy from
  [lumabeat/bs-roformer-sw](https://huggingface.co/lumabeat/bs-roformer-sw),
  verifies its SHA-256, and stores it locally. Users must decide whether the
  weights' terms are acceptable for their use. Do not automatically download
  or silently include them in a redistributable executable.

## User workflow

1. Open **Stems → BS-RoFormer SW · guitar** in the experimental Windows Portable. The RoFormer workspace opens within the existing tab, without a new window.
2. Inside the embedded workspace, click **Download model** if you accept
   the checkpoint terms (internet required only for that initial download).
3. Open your source song. Separate into 6 stems.
4. Solo the guitar lane to compare with the Demucs output and listen for lost
   solos, unstable level, cymbal bleed and changes in treble/pick attack.
5. Save the guitar lane as WAV. In the original KindlingControl window, open
   **Analyze → Reference → Load audio file** to compare it with your
   own guitar recording. The original Demucs six-stem export remains unchanged.

No user audio is uploaded to a hosted inference service; inference runs in
WebGPU on the user's own device. First use does require an explicit weight
download. Stemyla runs as a self-contained UI embedded in the main Stems tab via a sandboxed cross-origin iframe with
its own secure `kindling-roformer://studio/` origin. It has **no Node
integration, Electron preload, Bluetooth access, or automatic model download**.
Only statically packaged files can be served by that scheme. Model and song
storage are owned by that isolated browser origin. The current integration
does not automatically share audio files or stems with the native app.

## Local A/B guitar comparison (0.7.2 experiment)

- Stems now has a **Compare guitar stems · A/B** panel, visible regardless
  of the selected separation engine. Native Demucs adds the most recently
  completed guitar WAV to **A** through its existing session-scoped, validated
  `kindling-stem://` read-only playback URL. A can also load a local WAV
  manually if comparing earlier runs.
- The embedded RoFormer workspace is intentionally isolated: to load **B**,
  export its guitar stem to a WAV and select the file explicitly. No bridge
  reads RoFormer's private storage or drives its controls behind the user's
  back. Audio remains local and is never uploaded.
- The comparison offers a single Play/Pause transport, Stop, a position
  scrubber and A/B switching that transfers the current position and continues
  playback. It does not resample, normalize, modify source WAVs, synchronize
  multiple outputs to sample accuracy or interfere with the native Demucs
  output folder. Browser Blob URLs for manually chosen files are revoked
  on replacement and page close.
- The feature is a **listening tool**: matching source songs and manually
  matching their perceived levels remain the user's responsibility.

## Shared six-track listening mixer (0.7.3 experimental)

- The new local Stems mixer offers six channels (drums, bass, vocals, guitar,
  piano, other) with per-channel playback volume, Mute/Solo, Play/Pause,
  Stop, a seek slider and a bank selector (Demucs versus RoFormer).
- A successful native Demucs run automatically loads its validated session
  URLs into the Demucs bank. The service, its peak-guarded WAV output and the
  original per-track preview remain unchanged.
- RoFormer still runs as a separately isolated, pinned WebGPU app inside the
  Stems tab. The mixer NEVER reads its origin storage, files or model weights
  without user action. Export individual WAVs from RoFormer, then choose them
  explicitly with the main mixer's multi-file selector or each channel's
  Choose WAV control. Names containing exactly one instrument label are
  assigned automatically; ambiguous filenames require manual assignment.
  Generated in-memory Blob URLs are revoked on replacement and on close.
- The mixer sends the selected guitar to Analyze: native Demucs uses the
  validated session URL; the RoFormer channel passes only the File selected
  by the user. Analyze reuses its existing local Web Audio decoder and 180 MB
  size cap. No new Electron IPC or subprocess capability is exposed.
- Playback uses independent HTML media players with timeline alignment and
  simple drift correction. It is NOT sample-accurate DAW synchronization,
  cannot guarantee phase-coherent summation and does not render/export a
  new mix. Volume/Mute/Solo do not alter WAV data, model inference or
  normalized output; play at moderate volume to prevent overload.
- The independent 0.7.2 guitar A/B listening panel remains available.

## Direct in-app OPFS stem transfer (0.7.4 experiment)

The bundled Stemyla source (pinned to commit
`b2a771808d36f9a8d2f333528805d0ee2c1040a8`) already stores
completed 16-bit WAV stems in its own private origin storage:
`sessions/current` names the current numeric session;
`sessions/<id>/meta` lists complete `stem` lines; and
`sessions/<id>/stems/<stem>.wav` contains the finished 16-bit WAV
files. The upstream app also has a separate memory-only fallback
when browser storage fails.

- The Windows packaging step `tools/install-roformer-transfer.js` adds
  `desktop/roformer-transfer-bridge.js` as a **KindlingControl-owned
  JavaScript companion** to the exact pinned Stemyla built assets. The
  pinned WASM files and their model/inference code are untouched. No model
  weights are bundled or downloaded automatically.
- The user clicks **Import directly from RoFormer** in Stems. The host
  `src/app/roformer-transfer.js` sends a one-time nonce to the exact
  loaded iframe. The child validates the embedding parent and reads
  **only** the current session's listed six stem WAVs. It validates
  completion and WAV headers, then replies with structured-cloned File
  objects (no network upload, native filesystem access, or browser download).
- The host requires the exact iframe window, matching nonce, a known
  RoFormer origin (or opaque custom-scheme origin), fixed stem names,
  Blob/File objects and bounded sizes (256 MB per file, 1 GB total).
  An invalid reply fails closed. The files enter the existing RoFormer
  mixer bank through explicit Blob URLs; no new Electron IPC, Bluetooth,
  subprocess or arbitrary path bridge is added.
- This is a **one-click local transfer after separation**, not a
  background model manager or an automatic RoFormer start. If the
  current session has no completed OPFS stems, direct transfer refuses
  and the existing manual WAV import remains available.
- Verify in the target Electron/Windows build that the custom scheme
  supports cross-origin `postMessage`, that OPFS File objects can be
  structured-cloned between frames, and that a real six-stem run loads
  all six WAVs. Unit tests cannot prove this GPU/browser integration.

## Native parent controls for pinned RoFormer (0.7.5 experimental)

0.7.5 introduces a **source-level** integration path, because the
Stemyla model download, file loading and separation buttons are implemented
by Rust/egui, not exposed as ordinary DOM controls:

- In a new, isolated WebAssembly job the pinned Stemyla commit
  `b2a771808d36f9a8d2f333528805d0ee2c1040a8` is fetched and verified.
  The anchored script `tools/patch-stemyla-controls.py` changes only
  its `app/src/lib.rs` to add a polling adapter. The original
  model/inference kernels, worker protocol and model weights remain pinned
  and unchanged. If the source layout is unexpected, the patch fails.
- After the rebuilt studio loads, a KindlingControl-owned companion
  `desktop/roformer-transfer-bridge.js` accepts only the three
  allowlisted user actions `open_song`, `download_model`,
  `separate` from the exact embedding parent origin. A bounded queue
  exposes them to the wasm app's normal egui event loop. The Rust adapter
  calls Stemyla's existing `open_files`, `sep.download_model` and
  `start_separation` after checking the app's own state and reports
  an acknowledgement, model/song availability and separation progress.
- The new `src/app/roformer-controls.js` makes user-visible controls
  available in the first-party Stems pane, with a 350 MB source-song
  limit and a distinct, explicit checkpoint download button. No weight
  download or GPU work begins on page load; no native or arbitrary
  filesystem IPC is added. The studio's own original controls remain
  visible as an advanced fallback.
- This does NOT yet automatically fetch WAVs from the studio after a
  run. Once separation completes, use the existing 0.7.4
  **Import directly from RoFormer** button for a local OPFS import.
  When OPFS fails, the legacy manual export/import remains available.
- Build and unit tests confirm compilation, basic command validation and
  packaging, but the first full Windows WebGPU/UI run is still required
  before promoting this branch to a stable release.

## Technical boundaries

- `desktop/main.js` exposes only `roformer:status` via a trusted main-app IPC, returning a fixed local URL and package availability. The renderer cannot supply file paths, CLI args, executable names or a process to launch, and no second BrowserWindow is created. `src/app/roformer-inline.js` lazy-loads the sandboxed iframe only when Stems is selected, delegates WebGPU through `allow=webgpu`, and preserves the same loaded iframe when switching back from Demucs.
- `desktop/roformer-studio.js` resolves each request against the real
  packaged resource folder and rejects symlink traversal, other hosts and
  missing files; it serves proper WASM and JavaScript MIME types.
- In production the resources are under
  `process.resourcesPath/roformer-studio`. The app/worker/decoder/writer
  WebAssembly modules are packaged together; **no model checkpoints**.
- The embedded studio can export its own WAVs through Chromium's file
  download capability. The existing KindlingControl Analyze tab accepts
  a user-selected WAV as reference.
- No modification to the accepted Spark BLE command path, Undo/Redo, A/B,
  existing normalized Demucs processing or the standard guitar preset system.

## Known limitations

- RoFormer SW has six output classes (drums, bass, vocals, guitar, piano,
  other), not a guarantee of isolating individual guitar overdubs or lead and
  rhythm guitars separately. It is a different architecture from HTDemucs,
  but **not** a dedicated guitar-only model; do not claim it always beats
  Demucs without listening comparisons.
- GPU WebGPU support, OPFS storage support and performance must be checked
  on the user's actual Windows GPU and Electron build. CI can compile and
  package WASM, but it cannot prove real-model inference works on a target GPU.
- The origin's first run may require downloading ~350 MB. The complete source
  and model can use significant video memory. Use a short 20–30s clip first.
- Unlike the native six-stem output, exported RoFormer WAVs are not yet
  automatically loaded into Analyze; import through its file picker.
- The embedded studio remains an independently built upstream UI within the Stems panel, not an original UI design
  or a silent bundled replacement. Both license credits and a source link
  must remain visible.

## Acceptance criteria before promotion

- Verify a 20–30s metal passage containing rhythm and solo guitar in both
  native Demucs and RoFormer SW.
- Confirm the new studio loads its model after the explicit download, preserves
  song chronology, and plays/exports six plausible stems.
- Check lead/solo retention, muffled passages, leakage, clipping and equal
  subjective playback volume using matching source and analysis windows.
- Confirm the Spark 2 editor still works as in stable 0.3 Fast.
- Promote only if the target Windows user prefers the output. Retain the
  old stable branch and optional native Demucs engine for rollback.
