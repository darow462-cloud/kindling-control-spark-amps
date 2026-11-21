#!/usr/bin/env python3
"""Patch pinned demucs-rs v0.3.5 to restore official Demucs global normalization.

The official Demucs API computes mean and standard deviation from the stereo
mid-channel of the WHOLE track, normalizes BOTH channels before inference,
then reverses the same gain/offset on each estimated stem. The pinned Rust
CLI currently feeds the model raw decoded samples. That discrepancy could
affect its amplitude-dependent inference and source allocation.

This patch deliberately fails if the pinned upstream source changes. The
patched Rust CLI must be compiled and tested; this is not time-varying
normalization, a compressor, a limiter, or a cure for all model artifacts.
"""
from __future__ import annotations

import pathlib
import sys


PRECONDITION = r'''
    // Match official Demucs API input conditioning (whole-track, never per
    // segment). ref[t] = 0.5 * (left[t] + right[t]); center = mean(ref);
    // scale = std(ref) + 1e-8. Reuse these SAME values for every chunk.
    // Small/near-silent signals are not amplified to avoid dividing by noise.
    let (mix_mean, mix_scale) = {
        if left.len() != right.len() || left.is_empty() {
            bail!("Expected aligned nonempty stereo audio");
        }
        let n = left.len();
        let mean = left
            .iter()
            .zip(&right)
            .map(|(&l, &r)| 0.5 * (l as f64 + r as f64))
            .sum::<f64>()
            / n as f64;
        let var = left
            .iter()
            .zip(&right)
            .map(|(&l, &r)| {
                let d = 0.5 * (l as f64 + r as f64) - mean;
                d * d
            })
            .sum::<f64>()
            / n.saturating_sub(1).max(1) as f64;
        if !mean.is_finite() || !var.is_finite() {
            bail!("Input audio contains invalid sample values");
        }
        let sd = var.sqrt();
        if sd > 1e-6 {
            (mean as f32, sd as f32 + 1e-8_f32)
        } else {
            (0.0_f32, 1.0_f32)
        }
    };
    for sample in left.iter_mut().chain(right.iter_mut()) {
        *sample = (*sample - mix_mean) / mix_scale;
    }
    reporter.status(&format!(
        "  Full-track Demucs input normalization: mean {:.6}, scale {:.6}",
        mix_mean, mix_scale
    ));

'''

REVERSE = r'''
    // Undo the SAME static normalization for all stems. Never normalize
    // chunks or stems independently: that causes gain jumps and loses the
    // original recording's overall loudness scale.
    for stem in &mut stems {
        for sample in stem.left.iter_mut().chain(stem.right.iter_mut()) {
            *sample = *sample * mix_scale + mix_mean;
        }
    }

'''

def replace_exact(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise ValueError(f"Unexpected pinned demucs-rs source ({label}): {count} matches")
    return source.replace(old, new, 1)


def patch(source: str) -> str:
    source = replace_exact(
        source,
        "    let (left, right, sample_rate) = audio::read_audio(&req.input)?;",
        "    let (mut left, mut right, sample_rate) = audio::read_audio(&req.input)?;",
        "decoded stereo samples",
    )
    source = replace_exact(
        source,
        "    load_model(cache, info, &selected, reporter)?;",
        PRECONDITION + "    load_model(cache, info, &selected, reporter)?;",
        "before model load",
    )
    source = replace_exact(
        source,
        """    let stems = pollster::block_on(model.separate_with_listener(
        &left,
        &right,
        sample_rate,
        &mut listener,
    ))?;""",
        """    let mut stems = pollster::block_on(model.separate_with_listener(
        &left,
        &right,
        sample_rate,
        &mut listener,
    ))?;""" + REVERSE,
        "restore original output amplitude",
    )
    return source


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-demucs-normalization.py PATH_TO_demucs-cli/src/separate.rs", file=sys.stderr)
        return 2
    path = pathlib.Path(sys.argv[1])
    original = path.read_text(encoding="utf-8")
    patched = patch(original)
    path.write_text(patched, encoding="utf-8")
    print(f"Patched pinned demucs-rs v0.3.5: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
