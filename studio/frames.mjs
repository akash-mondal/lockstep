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
  const dir = mkdtempSync(join(tmpdir(), "prism-frames-"));
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
