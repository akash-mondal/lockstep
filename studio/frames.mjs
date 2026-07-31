/**
 * Pull representative frames out of a rendered video.
 *
 * Sampled across the whole duration rather than from the start, because the
 * defects worth catching cluster at the end: a frozen final second, a scene that
 * never resolves, an outro that renders empty. Three frames from the first two
 * seconds would miss all of them.
 */
import { execFile } from "node:child_process";
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
