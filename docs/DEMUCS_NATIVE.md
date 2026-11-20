# Windows native stem separation: implementation and constraints

## Why this engine

The Windows-only experimental **Stems** tab uses the native Rust [demucs-rs](https://github.com/nikhilunni/demucs-rs) CLI. The `htdemucs_6s` model performs real machine-learning source separation into six WAV outputs:

- `drums.wav`
- `bass.wav`
- `vocals.wav`
- `guitar.wav`
- `piano.wav`
- `other.wav`

The original mix is not split into distinct players or individual guitar overdubs. Distorted guitars, bass, keyboards and cymbals overlap spectrally, so source leakage is expected. This is primarily a listening/practice aid and a source for the existing Analyze tab. It is not a clean multitrack reconstruction of the original recording.

## Build provenance and licenses

- Source repository: `https://github.com/nikhilunni/demucs-rs`
- Pinned tag: **v0.3.5**, SHA **805d6f72ede20282832ac78c634e8767716c0b21**.
- Upstream CLI package: `demucs-cli` (`cargo build --release --locked -p demucs-cli`), with Vulkan/wgpu inference on Windows.
- Upstream source: Apache License 2.0. The native Windows build ships the upstream license in `resources/demucs/LICENSE.txt`.
- Model weights: `htdemucs_6s.safetensors`, approximately **84 MB**, fetched by demucs-rs at first use from `https://huggingface.co/set-soft/audio_separation/resolve/main/Demucs/` and cached locally by the upstream engine. Model weights are not included in this repository or distributed in the executable. Check the source and model terms separately.
- The GUI is based on KindlingControl (GPL-3.0-or-later). These components remain independent; retain the original authors' notices and source links.

The native engine is **not** installed via Python, pip or a shell script on the user's Windows PC. The preferred workflow, `.github/workflows/stems-portable-prebuilt.yml`, downloads the official Windows CLI artifact from the upstream release Actions run **39365873521**, artifact **12239537640**, for the pinned `v0.3.5` source commit. It verifies the SHA-256 of `demucs.exe` before bundling:
`ec32ec6f00c9677bbed44a91fad453a9abf65a1dea520be0d32959a8ed937b02`.

The official source-release workflow completed its Windows CLI build successfully even though its overall Release run failed on an unrelated macOS plugin job. The **manual fallback** `.github/workflows/stems-portable.yml` compiles the same pinned Rust revision directly with Vulkan SDK. Source compilation is expensive and is not run on every development push. The upstream Actions artifact may expire; in that case use the manual source-build workflow. Either workflow places the fixed native executable in Electron `extraResources` with the upstream Apache-2.0 license.

## Security and user data

1. Users choose an audio input **through a native file picker** and an output location **through a native folder picker**.
2. The renderer invokes only the fixed actions `stem:choose-input`, `stem:choose-output`, `stem:start`, `stem:cancel`, and `stem:open-output`. Main checks that the caller is the trusted app window. The renderer cannot supply a command, executable path or arbitrary filesystem path.
3. The main process spawns exactly the packaged `demucs.exe`, with `shell: false` and fixed `--model htdemucs_6s` arguments.
4. Each run writes its six WAVs into a new unique subfolder under the user-chosen output directory. A failed or canceled run removes **only** that temporary folder.
5. Only the **latest completed run's** six fixed filenames can be fetched by the private `kindling-stem://` protocol. The app does not serve other local files.
6. WAV stems are played directly from local files and can be imported into Analyze as the reference. The audio is not sent to a hosted API, to Spark over Bluetooth or to error reporting.
7. The model's first-run download requires internet. Later inference is local. There is no cloud stem processing.

## Known limitations

- A GPU/driver supporting Vulkan and enough RAM/VRAM are needed. Native inference may fail with unsupported or insufficient GPU resources. The app reports the native error and does not silently substitute a spectrum/EQ filter.
- The first inference can take longer due to weight download and GPU shader compilation. The progress status is text-based; the app does **not** claim a precise percentage.
- Long songs create large stereo WAV files. Input files are limited to 350 MB; loading the generated guitar stem into Analyze has an independent 180 MB limit to protect memory.
- The interface has **separate audio players** for each stem; it does not yet offer sample-accurate synchronized six-track mixing or editing. A DAW can align the WAV files from the same run.
- CI tests the IPC-independent process manager with a mocked CLI, but cannot prove the model actually separates music on the user's PC. Verify a real metal song and the GPU backend on Windows before promoting this feature.

## Manual Windows test

1. Launch the dedicated Windows Portable build and open **Stems**.
2. Choose a short WAV or MP3 song and an empty destination folder.
3. Start separation and allow the one-time ~84 MB model download.
4. Verify six nonempty WAVs appear, each can be played and has the same timeline.
5. Check that the Guitar WAV has guitar content and that drums, bass and vocals are broadly separated. Expect residual bleed.
6. Click **Analyze guitar stem** and confirm the Analyze tab receives it as the reference.
7. Test cancellation on another input and confirm only the incomplete run folder is removed.
8. Confirm the Spark 2 tone editor, Undo/Redo and A/B still work as before.

Do not merge this into the accepted Spark 2 stable branch until the engine and real audio path have been exercised on the target Windows PC.
