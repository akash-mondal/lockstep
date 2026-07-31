/**
 * Pull representative frames out of a rendered video.
 *
 * Sampled across the whole duration rather than from the start, because the
 * defects worth catching cluster at the end: a frozen final second, a scene that
 * never resolves, an outro that renders empty. Three frames from the first two
 * seconds would miss all of them.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function duration(path) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path,
  ]);
  return Number(String(stdout).trim());
}

/** @returns {Promise<string[]>} base64 JPEGs, evenly spaced across the video */
export async function sample(path, count = 6) {
  const secs = await duration(path);
  const dir = mkdtempSync(join(tmpdir(), "lockstep-frames-"));
  try {
    for (let i = 0; i < count; i++) {
      // Offset inside the span rather than at its edges: a frame taken exactly
      // at a cut is not representative of either side of it.
      const at = (secs * (i + 0.5)) / count;
      await run("ffmpeg", [
        "-v", "error", "-ss", at.toFixed(3), "-i", path,
        "-frames:v", "1", "-q:v", "3", "-vf", "scale=768:-1",
        join(dir, `f${String(i).padStart(2, "0")}.jpg`),
      ]);
    }
    return readdirSync(dir).sort()
      .map((f) => readFileSync(join(dir, f)).toString("base64"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A small preview of something that was bought.
 *
 * The stream carries these so a watcher sees the actual asset arrive rather
 * than a line of text claiming it did. Deliberately small: a job buys five
 * images and takes six stills per critique, and a stream is not a place to move
 * full resolution media.
 *
 * @param {string} path      a file on disk
 * @param {number} width     longest edge, in pixels
 * @returns {Promise<string|null>} base64 JPEG, or null if it cannot be made
 */
export async function thumbnail(path, width = 400) {
  const dir = mkdtempSync(join(tmpdir(), "lockstep-thumb-"));
  try {
    const out = join(dir, "t.jpg");
    await run("ffmpeg", [
      "-v", "error", "-i", path,
      "-frames:v", "1", "-q:v", "6", "-vf", `scale=${width}:-1`, out,
    ]);
    return readFileSync(out).toString("base64");
  } catch {
    // Audio, JSON and anything else without a picture in it. Not an error.
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The shape of a waveform, for assets that have sound rather than a picture.
 *
 * Narration and a music bed are two of the things a job buys, and a watcher
 * should see them arrive as something other than a filename. This renders the
 * waveform as an image, which is the honest visual for audio.
 */
export async function waveform(path, width = 400, height = 80) {
  const dir = mkdtempSync(join(tmpdir(), "lockstep-wave-"));
  try {
    const out = join(dir, "w.png");
    await run("ffmpeg", [
      "-v", "error", "-i", path,
      "-filter_complex",
      `showwavespic=s=${width}x${height}:colors=#25b394:scale=lin`,
      "-frames:v", "1", out,
    ]);
    return readFileSync(out).toString("base64");
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Are these stills empty, or all the same picture?
 *
 * Written after a vision reviewer was handed six byte-identical black PNGs and
 * replied with callout lines, dotted indicators, rectangular data readouts and
 * small circular markers, none of which existed, along with a face in a brand
 * that contains no people. Withholding the plan from that prompt was not enough:
 * asked to describe frames, it describes frames, and empty input produces
 * confident fiction rather than an admission.
 *
 * So the question is settled before a model is asked, and for free. Identical
 * digests mean nothing moved. Near-black means nothing is lit. Either way there
 * is no point buying an opinion about it.
 *
 * @param {string[]} paths absolute paths to the stills
 */
export async function stillsAreBlank(paths) {
  if (!paths.length) return { blank: true, reason: "no stills were produced" };

  const digests = paths.map((p) => createHash("sha256").update(readFileSync(p)).digest("hex"));
  const distinct = new Set(digests).size;
  if (distinct === 1) {
    return { blank: true, distinct, reason: `all ${paths.length} stills are byte identical` };
  }

  let brightest = 0;
  for (const p of paths) {
    try {
      const { stdout } = await run("ffprobe", [
        "-v", "error", "-f", "lavfi",
        "-i", `movie=${p.replace(/([:\\'])/g, "\\$1")},signalstats`,
        "-show_entries", "frame_tags=lavfi.signalstats.YAVG",
        "-of", "csv=p=0",
      ]);
      brightest = Math.max(brightest, Number(String(stdout).trim().split("\n")[0]) || 0);
    } catch { /* an unreadable still is not evidence of blankness */ }
  }
  // PNG is full range, so black really is 0 here, unlike the limited-range MP4
  // the render produces. A composition with anything lit clears this easily.
  if (brightest > 0 && brightest < 6) {
    return { blank: true, distinct, brightest, reason: `every still is near black (brightest ${brightest.toFixed(2)} of 255)` };
  }
  return { blank: false, distinct, brightest };
}

/**
 * Prove the render actually contains something.
 *
 * This exists because the studio once delivered ten seconds of pure black and
 * charged for it. Every automated check passed: the scaffold is valid, so lint
 * and check were happy, and the vision reviewer was handed the title and scene
 * count alongside the frames and wrote a confident description of a video that
 * was never composed. Nothing in the pipeline was able to notice.
 *
 * So the question "is there anything on screen" is answered by measurement, not
 * by judgment. YAVG is average luma per frame and YDIF is how much a frame
 * differs from the one before it.
 *
 * The luma threshold is 20 rather than 0 because video black is Y=16, not Y=0:
 * MP4 carries limited-range luma where 16 is black and 235 is white. Testing
 * against zero is the obvious mistake and it lets a black render through, which
 * is exactly what happened the first time this was written.
 *
 * Both conditions are required. Dark is not the same as empty, and a
 * legitimately dark composition still moves; what proves nothing was composed is
 * a frame that is black *and* identical to every frame around it.
 */
const VIDEO_BLACK = 20;
// A render that composed nothing reports YDIF of exactly 0 on every frame, so
// this only has to separate "zero" from "anything at all". It is deliberately
// far below the motion of a real scene: the house style asks for slow and
// restrained work, and a quiet dark shot can sit near 0.2, which must not be
// mistaken for an empty one.
const NO_MOTION = 0.05;

/**
 * One labelled sheet of the whole piece, for the agent to look at in a single go.
 *
 * Every heuristic written for this problem has been beaten by the composition
 * itself. Average luma passed a film that was 60 percent empty because two good
 * scenes carried it. Contrast passed the same film because white HUD chrome on
 * black is high contrast whether or not anything else rendered. Each fix needed
 * another fix, and none of them can answer "does this scene say what it should".
 *
 * The agent can just look. It has vision, it reads an image with one tool call,
 * and when it hashed six stills itself it caught a black render that a bought
 * vision model had described in confident detail. So the whole timeline goes on
 * one sheet with a timestamp burnt into each cell, and it reviews the piece in
 * one pass rather than a call per frame.
 *
 * @param {string} video    the rendered file
 * @param {string} outPath  where to write the sheet
 * @param {number} every    seconds between samples
 */
export async function contactSheet(video, outPath, every = 5) {
  const secs = await duration(video);
  const count = Math.max(1, Math.ceil(secs / every));
  const cols = Math.min(4, count);
  const rows = Math.ceil(count / cols);

  await run("ffmpeg", [
    "-v", "error", "-i", video,
    "-vf",
    // The timestamp is burnt in because a grid of stills is useless if the
    // reviewer cannot say which second is broken.
    `fps=1/${every},scale=480:-1,` +
    `drawtext=text='%{eif\\\\:n*${every}\\\\:d}s':x=10:y=10:fontsize=26:fontcolor=white:` +
    `box=1:boxcolor=black@0.75:boxborderw=6,` +
    `tile=${cols}x${rows}:margin=8:padding=6:color=#111111`,
    "-frames:v", "1", "-q:v", "4", outPath,
  ]);
  return { path: outPath, count, every, seconds: secs };
}

/**
 * Find the empty stretches, not just the empty videos.
 *
 * A delivered film ran for 32 seconds and about 60 percent of it, everything
 * past the 14 second mark, was bare chrome on black: scenes three, four and
 * five never rendered. contentStats passed it, because the two scenes that did
 * work carried enough light and motion to clear a whole-video threshold. An
 * average is exactly the wrong statistic for this question.
 *
 * So the video is cut into windows and each one is judged on its own. One
 * sample every few seconds is plenty to catch a dead scene, and the whole set
 * is measured in a single pass rather than a call per frame.
 *
 * @param {string} path
 * @param {number} every seconds between samples
 */
export async function deadSegments(path, every = 5) {
  const secs = await duration(path);
  if (!Number.isFinite(secs) || secs <= 0) return { ok: false, reason: "unreadable duration" };

  const dir = mkdtempSync(join(tmpdir(), "lockstep-seg-"));
  try {
    // One ffmpeg pass writes every sample. A call per frame on a 32 second
    // video is a dozen process launches for information one filter graph
    // already has.
    await run("ffmpeg", [
      "-v", "error", "-i", path,
      "-vf", `fps=1/${every},scale=480:-1`,
      "-q:v", "5", join(dir, "s%03d.jpg"),
    ]);
    const files = readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
    if (!files.length) return { ok: false, reason: "no samples could be taken" };

    const segments = [];
    for (const [i, f] of files.entries()) {
      const at = i * every;
      const full = join(dir, f);
      let luma = 0;
      let range = 0;
      try {
        // Parsed by tag name, never by column position. ffprobe emits these in
        // its own order, not the order they were requested in, and reading them
        // positionally produced a negative contrast on every sample and marked
        // a working video entirely dead.
        const { stdout } = await run("ffprobe", [
          "-v", "error", "-f", "lavfi",
          "-i", `movie=${full.replace(/([:\\'])/g, "\\$1")},signalstats`,
          "-show_entries", "frame_tags=lavfi.signalstats.YAVG,lavfi.signalstats.YMAX,lavfi.signalstats.YMIN",
          "-of", "default=nw=0",
        ]);
        const tag = (name) => {
          const m = new RegExp(`lavfi\\.signalstats\\.${name}=([-\\d.]+)`).exec(stdout);
          return m ? Number(m[1]) : null;
        };
        luma = tag("YAVG") ?? 0;
        // Contrast, not brightness. A frame holding only faint chrome on black
        // is dark and almost flat; a real scene has something bright in it.
        range = (tag("YMAX") ?? 0) - (tag("YMIN") ?? 0);
      } catch { /* an unreadable sample is not evidence */ }
      segments.push({ at, luma: Number(luma.toFixed(2)), range: Number(range.toFixed(2)), dead: range < 40 });
    }

    const dead = segments.filter((x) => x.dead);
    return {
      ok: dead.length === 0,
      every,
      segments,
      deadCount: dead.length,
      total: segments.length,
      deadAt: dead.map((x) => x.at),
      reason: dead.length
        ? `${dead.length} of ${segments.length} sampled seconds are empty: ` +
          `nothing but background at ${dead.map((x) => `${x.at}s`).join(", ")}`
        : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function contentStats(path, count = 12) {
  const { stdout, stderr } = await run("ffprobe", [
    "-v", "error", "-f", "lavfi",
    "-i", `movie=${path.replace(/([:\\'])/g, "\\$1")},signalstats`,
    "-show_entries", "frame_tags=lavfi.signalstats.YAVG,lavfi.signalstats.YDIF",
    "-of", "csv=p=0",
  ], { maxBuffer: 32 * 1024 * 1024 });

  const rows = String(stdout + stderr).trim().split("\n")
    .map((line) => line.split(",").map(Number))
    .filter((cols) => cols.length >= 2 && cols.every((n) => Number.isFinite(n)));
  if (rows.length === 0) return { frames: 0, maxLuma: 0, maxDelta: 0, blank: true };

  const maxLuma = Math.max(...rows.map((r) => r[0]));
  const maxDelta = Math.max(...rows.map((r) => r[1]));
  const dark = maxLuma <= VIDEO_BLACK;
  const still = maxDelta < NO_MOTION;
  return { frames: rows.length, maxLuma, maxDelta, dark, still, blank: dark && still };
}
