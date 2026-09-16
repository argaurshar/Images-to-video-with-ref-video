"""Final render (spec Part 12): normalise, concatenate, title cards, stamp,
disclaimer, fades, ambience bed, loudness, verification, crop-only variants."""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from ... import config
from ...models import Branding, Clip, Project

RES = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080), "4:5": (1080, 1350)}
FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
]


def ffmpeg() -> str:
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def run(cmd: list[str], timeout: int = 900) -> str:
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg failed: " + r.stderr[-1500:])
    return r.stderr


def _font(size: int) -> ImageFont.ImageFont:
    for f in FONT_CANDIDATES:
        if Path(f).exists():
            return ImageFont.truetype(f, size)
    return ImageFont.load_default(size=size)


def _spaced(s: str) -> str:
    return " ".join(s.upper()) if s and len(s) < 40 else s


def normalise_clip(src: Path, dst: Path, aspect: str) -> None:
    w, h = RES[aspect]
    # scale up to cover, then crop to the frame: never pad, never outpaint
    vf = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},fps={config.OUTPUT_FPS},format=yuv420p"
    run([ffmpeg(), "-y", "-loglevel", "error", "-i", str(src), "-vf", vf, "-an",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", str(dst)])


def concat(parts: list[Path], dst: Path) -> None:
    lst = dst.with_suffix(".txt")
    lst.write_text("".join(f"file '{p.resolve()}'\n" for p in parts))
    run([ffmpeg(), "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(dst)])


def title_card_png(b: Branding, aspect: str, out: Path, which: str = "start") -> Path:
    w, h = RES[aspect]
    scale = w / 1080 if aspect != "16:9" else h / 1080
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if b.style == "card":
        d.rectangle([0, 0, w, h], fill=(14, 14, 16, 255))
    white = (255, 255, 255, 235)
    dim = (255, 255, 255, 150)
    title = b.project_name or "Untitled project"
    f_title, f_sub, f_small = _font(int(88 * scale)), _font(int(34 * scale)), _font(int(26 * scale))
    if b.style == "lower_third":
        y = h - int(220 * scale)
        d.text((int(64 * scale), y), _spaced(title), font=f_title, fill=white)
        if b.practice_name:
            d.text((int(64 * scale), y + int(110 * scale)), b.practice_name, font=f_sub, fill=dim)
    else:
        cy = h // 2
        if b.subtitle:
            tw = d.textlength(b.subtitle, font=f_sub)
            d.text(((w - tw) // 2, cy - int(110 * scale)), b.subtitle, font=f_sub, fill=dim)
        tw = d.textlength(_spaced(title), font=f_title)
        d.text(((w - tw) // 2, cy - int(50 * scale)), _spaced(title), font=f_title, fill=white)
        if b.location_line:
            tw = d.textlength(_spaced(b.location_line), font=f_small)
            d.text(((w - tw) // 2, h - int(140 * scale)), _spaced(b.location_line), font=f_small, fill=dim)
    if b.practice_name and b.style != "lower_third":
        d.text((int(48 * scale), int(48 * scale)), b.practice_name, font=f_small, fill=dim)
    if b.year:
        tw = d.textlength(b.year, font=f_small)
        d.text((w - tw - int(48 * scale), int(48 * scale)), b.year, font=f_small, fill=dim)
    if b.stage_stamp:
        f_stamp = _font(int(28 * scale))
        tw = d.textlength(b.stage_stamp.upper(), font=f_stamp)
        d.rectangle([w - tw - int(80 * scale), h - int(90 * scale), w - int(40 * scale), h - int(40 * scale)],
                    outline=(255, 255, 255, 180), width=max(2, int(2 * scale)))
        d.text((w - tw - int(60 * scale), h - int(82 * scale)), b.stage_stamp.upper(), font=f_stamp, fill=white)
    if which == "end" and b.logo_path and Path(b.logo_path).exists():
        try:
            logo = Image.open(b.logo_path).convert("RGBA")
            lw = int(w * 0.18)
            logo = logo.resize((lw, int(logo.height * lw / logo.width)))
            img.alpha_composite(logo, ((w - lw) // 2, h // 2 + int(80 * scale)))
        except Exception:
            pass
    img.save(out)
    return out


def disclaimer_png(b: Branding, aspect: str, out: Path) -> Path:
    w, h = RES[aspect]
    scale = w / 1080 if aspect != "16:9" else h / 1080
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    f = _font(int(22 * scale))
    d.text((int(40 * scale), h - int(52 * scale)), b.disclaimer, font=f, fill=(255, 255, 255, 128))
    img.save(out)
    return out


def ambience_bed(clips: list[Clip], out: Path, beds: dict[str, str], seconds_each: float) -> None:
    """One audio segment per clip (room tone for interiors, outdoor bed for
    exteriors), short fades so cuts do not click, then a score mixed low if
    one was uploaded. Synthetic beds are placeholders: upload real ones."""
    segs = []
    tmpdir = out.parent / "audio_tmp"
    tmpdir.mkdir(exist_ok=True)
    for i, c in enumerate(clips):
        seg = tmpdir / f"seg_{i:03d}.wav"
        src = beds.get(c.cls)
        d = seconds_each
        if src and Path(src).exists():
            inp = ["-stream_loop", "-1", "-i", src]
            af = f"atrim=0:{d},afade=t=in:d=0.3,afade=t=out:st={d-0.3}:d=0.3"
        else:
            colour, amp, lp = ("brown", 0.35, 900) if c.cls == "exterior" else ("pink", 0.18, 500)
            inp = ["-f", "lavfi", "-i", f"anoisesrc=c={colour}:r=48000:a={amp}:d={d}"]
            af = f"lowpass=f={lp},afade=t=in:d=0.3,afade=t=out:st={d-0.3}:d=0.3"
        run([ffmpeg(), "-y", "-loglevel", "error", *inp, "-t", f"{d}", "-af", af, "-ar", "48000", "-ac", "2", str(seg)])
        segs.append(seg)
    lst = tmpdir / "list.txt"
    lst.write_text("".join(f"file '{s.resolve()}'\n" for s in segs))
    bed = tmpdir / "bed.wav"
    run([ffmpeg(), "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(bed)])
    total = seconds_each * len(clips)
    score = beds.get("score")
    if score and Path(score).exists():
        run([ffmpeg(), "-y", "-loglevel", "error", "-i", str(bed), "-stream_loop", "-1", "-i", score, "-t", f"{total}",
             "-filter_complex", "[1:a]volume=0.32,afade=t=out:st=%s:d=3[s];[0:a][s]amix=inputs=2:duration=first:normalize=0[a]" % (total - 3),
             "-map", "[a]", "-ar", "48000", str(out)])
    else:
        run([ffmpeg(), "-y", "-loglevel", "error", "-i", str(bed), "-af", f"afade=t=out:st={max(0, total-3)}:d=3", str(out)])


def _loudnorm_stats(path: Path) -> dict:
    err = subprocess.run([ffmpeg(), "-i", str(path), "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
                         capture_output=True, text=True, timeout=600).stderr
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", err, re.S)
    if not m:
        return {}
    try:
        return json.loads(m.group(0))
    except Exception:
        return {}


def measure_loudness(path: Path) -> dict:
    j = _loudnorm_stats(path)
    if not j:
        return {}
    return {"integrated_lufs": float(j.get("input_i", 0)), "true_peak_db": float(j.get("input_tp", 0))}


def loudnorm_filter(bed: Path) -> str:
    """Second pass of loudnorm with the first pass's measurements, which is
    what lands the mix on -16 LUFS rather than near it."""
    j = _loudnorm_stats(bed)
    base = "loudnorm=I=-16:TP=-1.5:LRA=11"
    if not j:
        return base
    try:
        return (f"{base}:measured_I={float(j['input_i'])}:measured_TP={float(j['input_tp'])}:measured_LRA={float(j['input_lra'])}"
                f":measured_thresh={float(j['input_thresh'])}:offset={float(j.get('target_offset', 0))}:linear=true")
    except (KeyError, ValueError):
        return base


def final_render(p: Project, clips: list[Clip], out_dir: Path) -> tuple[Path, dict]:
    aspect = p.intake.aspect
    w, h = RES[aspect]
    out_dir.mkdir(parents=True, exist_ok=True)
    from ...store import abs_path
    norm = []
    for i, c in enumerate(clips):
        dst = out_dir / f"norm_{i:03d}.mp4"
        normalise_clip(abs_path(c.path), dst, aspect)
        norm.append(dst)
    video = out_dir / "film_video.mp4"
    concat(norm, video)
    total = config.CLIP_SECONDS * len(clips)

    audio = out_dir / "film_audio.wav"
    ambience_bed(clips, audio, {k: str(abs_path(v)) for k, v in p.audio_beds.items()}, config.CLIP_SECONDS)

    b = p.branding
    inputs = ["-i", str(video), "-i", str(audio)]
    fc = [f"[0:v]fade=t=in:d=1.2,fade=t=out:st={max(0, total-3.0)}:d=3.0[v0]"]
    cur = "v0"
    idx = 2
    if b.title_position in ("start", "both") and b.style != "card":
        card = title_card_png(b, aspect, out_dir / "card_start.png", "start")
        inputs += ["-loop", "1", "-t", "4.5", "-i", str(card)]
        fc.append(f"[{idx}:v]format=rgba,fade=t=in:st=0.6:d=0.5:alpha=1,fade=t=out:st=3.5:d=0.5:alpha=1[c{idx}]")
        fc.append(f"[{cur}][c{idx}]overlay=0:0:enable='between(t,0,4.5)'[v{idx}]")
        cur = f"v{idx}"; idx += 1
    if b.title_position in ("end", "both") and b.style != "card":
        card = title_card_png(b, aspect, out_dir / "card_end.png", "end")
        st = max(0, total - 4.5)
        inputs += ["-loop", "1", "-t", f"{total}", "-i", str(card)]
        fc.append(f"[{idx}:v]format=rgba,fade=t=in:st={st+0.3}:d=0.5:alpha=1[c{idx}]")
        fc.append(f"[{cur}][c{idx}]overlay=0:0:enable='gte(t,{st})'[v{idx}]")
        cur = f"v{idx}"; idx += 1
    if b.disclaimer and (b.disclaimer_every_frame or p.intake.end_use == "planning_consultation"):
        disc = disclaimer_png(b, aspect, out_dir / "disclaimer.png")
        inputs += ["-loop", "1", "-t", f"{total}", "-i", str(disc)]
        fc.append(f"[{idx}:v]format=rgba[d{idx}]")
        fc.append(f"[{cur}][d{idx}]overlay=0:0[v{idx}]")
        cur = f"v{idx}"; idx += 1
    fc.append(f"[1:a]{loudnorm_filter(audio)}[a]")
    film = out_dir / "film.mp4"
    run([ffmpeg(), "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(fc),
         "-map", f"[{cur}]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", str(film)])
    if b.style == "card" and b.title_position != "none":
        film = _wrap_with_cards(p, film, out_dir, aspect, total)

    cap = cv2.VideoCapture(str(film))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    fps = cap.get(cv2.CAP_PROP_FPS) or 0
    ver = {"duration_s": round(n / fps, 2) if fps else 0, "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
           "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)), "fps": round(fps, 2)}
    cap.release()
    ver.update(measure_loudness(film))
    ver["brightness_arc"] = [round(c.mean_brightness, 3) for c in clips]
    ver["expected_duration_s"] = total + (6.0 if (b.style == "card" and b.title_position == "both") else 3.0 if (b.style == "card" and b.title_position != "none") else 0)
    return film, ver


def _wrap_with_cards(p: Project, film: Path, out_dir: Path, aspect: str, total: float) -> Path:
    """Solid card style: a 3 s card clip before and/or after the film."""
    b = p.branding
    parts = []
    w, h = RES[aspect]
    for which in ("start", "end"):
        if b.title_position in (which, "both"):
            png = title_card_png(b, aspect, out_dir / f"card_{which}.png", which)
            mp4 = out_dir / f"card_{which}.mp4"
            run([ffmpeg(), "-y", "-loglevel", "error", "-loop", "1", "-i", str(png), "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                 "-t", "3", "-vf", f"format=yuv420p,fade=t=in:d=0.6,fade=t=out:st=2.4:d=0.6", "-r", str(config.OUTPUT_FPS),
                 "-c:v", "libx264", "-crf", "18", "-c:a", "aac", "-shortest", str(mp4)])
            parts.append((which, mp4))
    seq = [m for w_, m in parts if w_ == "start"] + [film] + [m for w_, m in parts if w_ == "end"]
    out = out_dir / "film_cards.mp4"
    lst = out_dir / "cards_list.txt"
    lst.write_text("".join(f"file '{x.resolve()}'\n" for x in seq))
    run([ffmpeg(), "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst), "-c:v", "libx264", "-crf", "18",
         "-c:a", "aac", "-movflags", "+faststart", str(out)])
    return out


def crop_variant(film: Path, aspect: str, out: Path) -> None:
    w, h = RES[aspect]
    vf = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},format=yuv420p"
    run([ffmpeg(), "-y", "-loglevel", "error", "-i", str(film), "-vf", vf, "-c:v", "libx264", "-crf", "18",
         "-c:a", "copy", "-movflags", "+faststart", str(out)])
