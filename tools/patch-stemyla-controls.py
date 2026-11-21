"""Apply a bounded, reviewable KindlingControl bridge to pinned Stemyla source.

The original source checkout and model/WASM dependency versions stay pinned.
Only the web-facing app crate gains a narrow command/status shim. The patch
fails if the upstream application layout changes.
"""
from pathlib import Path
import sys

RUST_BRIDGE = r'''
// KindlingControl user-initiated commands for the pinned embedded WebGPU app.
// This bridge is a thin adapter around Stemyla's own existing Rust methods.
// No synthetic egui clicks, direct WebGPU API, or automatic model download.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(inline_js = r#"
export function kc_available() {
  return !!globalThis.__kindlingControl?.available;
}
export function kc_next() {
  return globalThis.__kindlingControl?.take?.() ?? null;
}
export function kc_ack(nonce, ok, message) {
  globalThis.__kindlingControl?.ack?.(nonce, ok, message);
}
export function kc_completed(nonce, session) {
  globalThis.__kindlingControl?.completed?.(nonce, session);
}
export function kc_report(modelReady, modelLoading, downloadDone, downloadTotal,
    separating, progressDone, progressTotal, songLoaded, canSeparate, stopped, text) {
  globalThis.__kindlingControl?.report?.(modelReady, modelLoading,
    downloadDone, downloadTotal, separating, progressDone, progressTotal,
    songLoaded, canSeparate, stopped, text);
}
"#)]
extern "C" {
    fn kc_available() -> bool;
    fn kc_next() -> wasm_bindgen::JsValue;
    fn kc_ack(nonce: &str, ok: bool, message: &str);
    fn kc_completed(nonce: &str, session: &str);
    fn kc_report(
        model_ready: bool,
        model_loading: bool,
        download_done: f64,
        download_total: f64,
        separating: bool,
        progress_done: u32,
        progress_total: u32,
        song_loaded: bool,
        can_separate: bool,
        stopped: bool,
        text: &str,
    );
}

#[cfg(target_arch = "wasm32")]
impl StemApp {
    fn kindling_poll(&mut self, ctx: &egui::Context) {
        use wasm_bindgen::JsCast;
        if !kc_available() {
            return;
        }
        let command = kc_next();
        if !command.is_null() && !command.is_undefined() {
            let field = |name: &str| {
                js_sys::Reflect::get(&command, &wasm_bindgen::JsValue::from_str(name)).ok()
            };
            let nonce = field("nonce")
                .and_then(|s| s.as_string())
                .unwrap_or_default();
            let action = field("action").and_then(|s| s.as_string());
            let mut accepted = false;
            let result: String = match action.as_deref() {
                Some("open_song") => {
                    let chosen = field("file")
                        .and_then(|file| file.dyn_into::<web_sys::File>().ok());
                    if let Some(file) = chosen {
                        let name = file.name();
                        self.open_files(vec![(name, file)], ctx);
                        accepted = true;
                        "Song is opening in the Stemyla decoder.".into()
                    } else {
                        "No valid local song File received.".into()
                    }
                }
                Some("download_model") => {
                    match self.separator.as_mut() {
                        Some(sep) if !sep.model_ready && !sep.model_loading
                            && sep.download.is_none() && sep.stopped.is_none() =>
                        {
                            sep.download_model();
                            accepted = true;
                            "Stemyla is downloading the model after your explicit click.".into()
                        }
                        _ => "RoFormer model is already loaded or busy.".into(),
                    }
                }
                Some("separate") => {
                    let ready = self.separator.as_ref().is_some_and(|sep| {
                        sep.model_ready && !sep.model_loading && !sep.running
                            && sep.stopped.is_none()
                    });
                    if ready && self.song.is_some()
                        && self.opening.is_none()
                        && !self.shown_session_decoding()
                        && !self.reading_stems && !self.classic_running()
                        && self.separating.is_none()
                    {
                        self.start_separation(ctx);
                        accepted = self.separating.is_some();
                        if accepted {
                            if let Some(session) = self.session.clone() {
                                self.kindling_run = Some((nonce.clone(), session));
                            }
                        }
                        if accepted {
                            "Started Stemyla's native WebGPU separation.".into()
                        } else {
                            "RoFormer could not start separation.".into()
                        }
                    } else {
                        "RoFormer needs a loaded model and song, with no running job.".into()
                    }
                }
                _ => "Unsupported RoFormer command.".into(),
            };
            if !nonce.is_empty() {
                kc_ack(&nonce, accepted, &result);
            }
        }

        let (ready, loading, downloaded, total, running, progress_done,
            progress_total, stopped) = if let Some(sep) = &self.separator
        {
            let (done, total) = sep.download.unwrap_or((0.0, 0.0));
            (
                sep.model_ready, sep.model_loading, done, total,
                sep.running, sep.progress.0, sep.progress.1, sep.stopped.is_some(),
            )
        } else {
            (false, false, 0.0, 0.0, false, 0, 0, true)
        };
        let working = running || self.separating.is_some() || self.reading_stems;
        let song_loaded = self.song.is_some() && self.opening.is_none();
        let can_separate = ready && song_loaded && !working && !loading && !stopped
            && !self.shown_session_decoding() && !self.classic_running();
        kc_report(ready, loading, downloaded, total, working, progress_done,
            progress_total, song_loaded, can_separate, stopped, &self.status);
        // An external postMessage alone does not schedule an egui repaint;
        // keep this cheap control queue alive without synthetic DOM events.
        ctx.request_repaint_after(std::time::Duration::from_millis(250));
    }
}

'''

def replace_once(source: str, old: str, new: str) -> str:
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one patch anchor, got {count}: {old!r}")
    return source.replace(old, new, 1)

def patch(path: Path) -> None:
    original = path.read_text(encoding="utf-8")
    if "fn kindling_poll(&mut self" in original:
        raise RuntimeError("Refusing to patch Stemyla twice")
    changed = replace_once(
        original,
        "impl eframe::App for StemApp {",
        RUST_BRIDGE + "impl eframe::App for StemApp {",
    )
    # Associate a completion with the command nonce and the exact source
    # session. A normal Advanced Studio run clears this association first.
    changed = replace_once(
        changed,
        "    /// The song the running separation was started on.\n"
        "    #[cfg(target_arch = \"wasm32\")]\n"
        "    separating: Option<SeparationJob>,",
        "    /// The user-initiated Kindling run (nonce, source session).\n"
        "    #[cfg(target_arch = \"wasm32\")]\n"
        "    kindling_run: Option<(String, String)>,\n"
        "    /// The song the running separation was started on.\n"
        "    #[cfg(target_arch = \"wasm32\")]\n"
        "    separating: Option<SeparationJob>,",
    )
    changed = replace_once(
        changed,
        "            #[cfg(target_arch = \"wasm32\")]\n"
        "            separating: None,",
        "            #[cfg(target_arch = \"wasm32\")]\n"
        "            kindling_run: None,\n"
        "            #[cfg(target_arch = \"wasm32\")]\n"
        "            separating: None,",
    )
    changed = replace_once(
        changed,
        "    fn start_separation(&mut self, ctx: &egui::Context) {\n",
        "    fn start_separation(&mut self, ctx: &egui::Context) {\n"
        "        // Only a specifically accepted Kindling action can auto-import.\n"
        "        // A manual Stemyla run invalidates any earlier tag.\n"
        "        self.kindling_run = None;\n",
    )
    changed = replace_once(
        changed,
        "        let destination = job.destination(self.song_serial, self.session.as_deref());\n"
        "        let being_opened = self.opening.as_ref().is_some_and(|(_, o)| *o == id);\n"
        "        let read = destination == StemsGo::Show || being_opened;",
        "        let kindling_done = self.kindling_run.take()\n"
        "            .filter(|(_, expected)| expected == &id);\n"
        "        let destination = job.destination(self.song_serial, self.session.as_deref());\n"
        "        let being_opened = self.opening.as_ref().is_some_and(|(_, o)| *o == id);\n"
        "        let read = destination == StemsGo::Show || being_opened;",
    )
    changed = replace_once(
        changed,
        "            let kept = stored.kept.is_ok();\n"
        "            let not_kept = stored",
        "            let kept = stored.kept.is_ok();\n"
        "            // Signal only after the final WAVs AND meta have been\n"
        "            // committed by Stemyla (never on a worker 'done' alone).\n"
        "            if kept {\n"
        "                if let Some((nonce, _)) = kindling_done {\n"
        "                    kc_completed(&nonce, &id);\n"
        "                }\n"
        "            }\n"
        "            let not_kept = stored",
    )
    changed = replace_once(
        changed,
        "        if let Some(id) = job.session.clone().filter(|_| job.keeps_stems) {\n"
        "            let destination = job.destination(self.song_serial, self.session.as_deref());",
        "        if let Some(id) = job.session.clone().filter(|_| job.keeps_stems) {\n"
        "            let kindling_done = self.kindling_run.take()\n"
        "                .filter(|(_, expected)| expected == &id);\n"
        "            let destination = job.destination(self.song_serial, self.session.as_deref());",
    )
    changed = replace_once(
        changed,
        "                let status = match store::save_stems(&id, SEPARATION_RATE, &to_save).await {\n"
        "                    Ok(()) => kept,",
        "                let status = match store::save_stems(&id, SEPARATION_RATE, &to_save).await {\n"
        "                    Ok(()) => {\n"
        "                        if let Some((nonce, _)) = kindling_done {\n"
        "                            kc_completed(&nonce, &id);\n"
        "                        }\n"
        "                        kept\n"
        "                    },",
    )
    changed = replace_once(
        changed,
        "        self.apply_inbox(&ctx);\n",
        "        self.apply_inbox(&ctx);\n"
        "        #[cfg(target_arch = \"wasm32\")]\n"
        "        self.kindling_poll(&ctx);\n",
    )
    path.write_text(changed, encoding="utf-8")
    print(f"Installed KindlingControl Rust control bridge into {path}")

if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: patch-stemyla-controls.py <path/to/app/src/lib.rs>")
    patch(Path(sys.argv[1]))
