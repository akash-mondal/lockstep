/**
 * Paid job in, finished video out.
 *
 * The split is the whole design. Deterministic code owns money, the workspace
 * boundary, and the judgement of whether anything real came back. The agent owns
 * making the video, entirely, in one turn.
 *
 * It used to own much less. This drove it step by step: compose, gate, buy a
 * critique, revise, gate again, render, review. Every step handed over a
 * fragment of the problem and a fragment of the state, and every quality check
 * written for that loop was beaten by the composition itself. Mean luma passed a
 * film that was sixty percent empty because two good scenes carried the average.
 * Contrast passed the same film, because white chrome on black is high contrast
 * whether or not anything else rendered. A bought vision reviewer, handed six
 * identical black frames, described callout lines and data readouts that were
 * not there.
 *
 * The agent has Bash, the same lint, check, snapshot and render commands, and
 * eyes. Given the goal and the tools it can render, look at every frame, find
 * the dead stretch and fix it, which is what the orchestration was clumsily
 * trying to do on its behalf. So it gets the job, and this file keeps only what
 * an agent should never be trusted with: the keys, the budget, and the question
 * of whether the thing it says it finished actually exists.
 */
import { execFile } from "node:child_process";
import { cpus } from "node:os";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import "dotenv/config";
import * as sessions from "./sessions.mjs";
import { buy, remaining, settlement, BudgetExceeded } from "./purchase.mjs";
import { agentTurn, agentJson } from "./harness.mjs";
import { houseStyle } from "./house-style.mjs";
import { contentStats, thumbnail, waveform } from "./frames.mjs";
import { refund } from "./refund.mjs";

const run = promisify(execFile);
const HF = { env: { ...process.env, HYPERFRAMES_SKIP_SKILLS: "1" }, maxBuffer: 32 * 1024 * 1024 };

/**
 * How much of a job each phase is worth, measured rather than guessed.
 *
 * A percentage that moves in equal steps per phase is a lie: on a timed run,
 * buying took 54 seconds and composing took over twenty minutes. These weights
 * come from that measurement, so a bar at 50% means roughly half the wall clock
 * is gone rather than half the phases.
 */
const WEIGHTS = { buying: 12, composing: 42, gate: 4, critique: 12, rendering: 25, delivering: 5 };
const PHASES = Object.keys(WEIGHTS);

/** Percent complete at the start of a phase, plus progress within it. */
function percentAt(phase, within = 0) {
  const before = PHASES.slice(0, PHASES.indexOf(phase)).reduce((n, k) => n + WEIGHTS[k], 0);
  return Math.min(99, Math.round(before + WEIGHTS[phase] * Math.max(0, Math.min(1, within))));
}

/**
 * Record a step and publish it.
 *
 * The session file is the record and the stream is the view, so both are
 * updated here rather than leaving a caller to remember one of them.
 */
function note(id, progress, phase, within = 0) {
  const percent = phase ? percentAt(phase, within) : undefined;
  sessions.update(id, (s) => {
    s.progress = progress;
    if (percent !== undefined) s.percent = percent;
    return s;
  });
  sessions.publish(id, { type: "progress", progress, phase, percent });
}

/**
 * Put a bought asset on the stream, with something to look at.
 *
 * A watcher should see the image appear, not read that it did. Images get a
 * thumbnail, audio gets its waveform drawn, and anything else goes on as a
 * described file rather than being silently skipped.
 */
async function publishAsset(id, rel, role, absPath) {
  let preview = null;
  let kind = "file";
  if (/\.(jpe?g|png)$/i.test(rel)) {
    kind = "image";
    preview = await thumbnail(absPath);
  } else if (/\.(wav|mp3|m4a)$/i.test(rel)) {
    kind = "audio";
    preview = await waveform(absPath);
  }
  let bytes = null;
  try { bytes = readFileSync(absPath).length; } catch { /* gone is not fatal */ }
  sessions.publish(id, { type: "asset", rel, role, kind, bytes, preview });
}

/** Buy every asset the plan calls for, inside the job's budget. */
async function buyAssets(id, plan) {
  const s = () => sessions.read(id);
  const dir = (f) => sessions.pathIn(id, "assets", f);
  const bought = [];

  for (const scene of plan.scenes) {
    note(id, `buying image ${scene.id} of ${plan.scenes.length}`, "buying", scene.id / (plan.scenes.length + 3));
    const r = await buy(id, "image", `scene ${scene.id} image`, {
      prompt: scene.imagePrompt,
      // Seeded so a re-run of the same plan costs nothing new and renders
      // identically, which is also what the framework wants.
      seed: 1000 + scene.id,
      aspect: "16:9",
    });
    const file = `scene-${String(scene.id).padStart(2, "0")}.jpg`;
    writeFileSync(dir(file), Buffer.from(r.data, "base64"));
    bought.push({ rel: `assets/${file}`, role: `scene ${scene.id} image` });
    await publishAsset(id, `assets/${file}`, `scene ${scene.id} image`, dir(file));
  }

  let narrationSeconds = 0;
  if (plan.narration?.length) {
    note(id, "buying narration", "buying", 0.7);
    const text = plan.narration.join(" ");
    const r = await buy(id, "speech", "narration", { text, voice: "Kore" });
    writeFileSync(dir("narration.wav"), Buffer.from(r.data, "base64"));
    narrationSeconds = r.seconds ?? 0;
    bought.push({ rel: "assets/narration.wav", role: "narration", seconds: narrationSeconds });
    await publishAsset(id, "assets/narration.wav", "narration", dir("narration.wav"));

    // Word timings, so captions land on the spoken word rather than a guess.
    if (remaining(s()) > 0n) {
      note(id, "buying word timings", "buying", 0.85);
      const t = await buy(id, "transcribe", "word timings", {
        data: readFileSync(dir("narration.wav")).toString("base64"),
        filename: "narration.wav",
      });
      writeFileSync(dir("transcript.json"), JSON.stringify(t.words, null, 2));
      bought.push({ rel: "assets/transcript.json", role: "word timings" });
      sessions.publish(id, {
        type: "asset", rel: "assets/transcript.json", role: "word timings",
        kind: "timings", words: (t.words ?? []).length,
        sample: (t.words ?? []).slice(0, 12),
      });
    }
  }

  if (plan.music !== false && remaining(s()) > 0n) {
    note(id, "buying the music bed", "buying", 0.95);
    const r = await buy(id, "music", "music bed", { prompt: plan.music });
    writeFileSync(dir("bed.mp3"), Buffer.from(r.data, "base64"));
    bought.push({ rel: "assets/bed.mp3", role: "music bed" });
    await publishAsset(id, "assets/bed.mp3", "music bed", dir("bed.mp3"));
  }

  return { bought, narrationSeconds };
}

/**
 * Everything about this machine and these files, measured once.
 *
 * Timed a real compose turn and 13 of its first 18 minutes went on rediscovery:
 * 181 seconds grepping the skill tree to find out which fonts exist, 233 seconds
 * probing asset durations in a shell loop, then reading five JPEGs to learn what
 * it had already been told in the storyboard. None of that is about the job. It
 * is the same answer every run, and the agent pays for it again every run.
 *
 * So it is measured here, in milliseconds, and handed over as fact. `fc-list`
 * takes six thousandths of a second; the agent spent three minutes not running
 * it.
 */
async function measure(sessionDir, bought) {
  const probe = async (file) => {
    try {
      const { stdout } = await run("ffprobe", [
        "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", join(sessionDir, file),
      ]);
      return Number(String(stdout).trim());
    } catch { return null; }
  };
  const dims = async (file) => {
    try {
      const { stdout } = await run("ffprobe", [
        "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
        "-of", "csv=p=0", join(sessionDir, file),
      ]);
      return String(stdout).trim();
    } catch { return null; }
  };

  const media = [];
  for (const b of bought) {
    if (/\.(wav|mp3|m4a)$/i.test(b.rel)) {
      const secs = await probe(b.rel);
      media.push(`  ${b.rel}   ${b.role}   ${secs ? `${secs.toFixed(2)}s` : "unknown length"}`);
    } else if (/\.(jpe?g|png)$/i.test(b.rel)) {
      const wh = await dims(b.rel);
      media.push(`  ${b.rel}   ${b.role}   ${wh ?? "unknown size"}`);
    } else {
      media.push(`  ${b.rel}   ${b.role}`);
    }
  }

  let fonts = [];
  try {
    const { stdout } = await run("bash", ["-lc", "fc-list : family 2>/dev/null | tr ',' '\\n' | sort -u"]);
    fonts = String(stdout).split("\n").map((f) => f.trim()).filter(Boolean);
  } catch { fonts = []; }

  return { media, fonts };
}

/**
 * One tool call, described for a watcher.
 *
 * A Write or an Edit is the moment the composition actually changes, so those
 * carry the file's new size: a UI can show the piece being built rather than a
 * list of identical "Edit index.html" lines.
 */
function onAgentTool(id, projectDir, name, input) {
  const target = String(input?.file_path ?? input?.command ?? input?.skill ?? input?.pattern ?? "");
  const event = { type: "tool", tool: name, detail: target.slice(0, 200) };

  if (name === "Write" || name === "Edit") {
    const file = join(projectDir, "index.html");
    try {
      const text = readFileSync(file, "utf8");
      event.composition = { bytes: text.length, lines: text.split("\n").length };
    } catch { /* not written yet */ }
  }
  sessions.publish(id, event);
}

/** Scaffold a HyperFrames project the agent will author into. */
async function scaffold(id) {
  const workDir = sessions.pathIn(id, "work");
  await run("npx", ["hyperframes", "init", "video", "--example", "blank", "--non-interactive"],
    { ...HF, cwd: workDir });
  return join(workDir, "video");
}






export async function runJob(id) {
  const session = sessions.read(id);
  const plan = session.plan;

  try {
    // The storyboard up front, so a watcher has the shape of the whole job
    // before the first payment rather than assembling it from progress lines.
    sessions.publish(id, {
      type: "plan",
      title: plan.title,
      angle: plan.angle ?? null,
      look: plan.look ?? null,
      continuity: plan.continuity ?? null,
      spectacle: plan.spectacle ?? null,
      scenes: (plan.scenes ?? []).map((sc) => ({
        id: sc.id, beat: sc.beat ?? null, imagePrompt: sc.imagePrompt ?? null,
      })),
      narration: plan.narration ?? [],
      quoteHbar: Number(plan.pricing?.quoteTinybar ?? 0) / 1e8,
      budgetHbar: Number(plan.budgetTinybar ?? 0) / 1e8,
    });

    sessions.setState(id, "buying");
    const { bought, narrationSeconds } = await buyAssets(id, plan);

    sessions.setState(id, "composing");
    note(id, "scaffolding the project", "composing", 0.02);
    const projectDir = await scaffold(id);

    // The storyboard and the standing direction go on disk, because that is how
    // the framework's own skills expect to find them.
    const facts = await measure(sessions.dirOf(id), bought);
    const direction = houseStyle({
      brief: plan.title,
      assets: bought.map((b) => ({ path: `../../${b.rel}`, role: b.role, seconds: b.seconds })),
      narrationSeconds,
      media: facts.media,
      fonts: facts.fonts,
    });
    writeFileSync(join(projectDir, "DIRECTION.md"), direction);
    writeFileSync(join(projectDir, "STORYBOARD.md"), storyboardMd(plan, narrationSeconds));

    // One goal, one turn. The pipeline used to drive this: compose, then gate,
    // then buy a critique, then revise, then gate again, then render, each step
    // handing the agent a fragment of the problem and a fragment of the state.
    // Every quality check I wrote for that loop was beaten by the composition
    // itself, and the bought reviewer confabulated detail on frames that were
    // solid black.
    //
    // The agent has Bash, it has the same lint, check, snapshot and render
    // commands, and it can look at its own frames. So it gets the whole job and
    // the tools to finish it, and this code keeps only what it must own: the
    // money, the workspace boundary, and whether what came back is real.
    note(id, "making the video", "composing", 0.05);
    const turn = await agentTurn({
      sessionId: id,
      prompt: makeVideoPrompt(projectDir, narrationSeconds),
      allowedTools: ["Skill", "Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      maxTurns: Number(process.env.STUDIO_MAX_TURNS ?? 200),
      timeoutMs: Number(process.env.STUDIO_TURN_TIMEOUT_MS ?? 1_800_000),
      onTool: (name, input) => onAgentTool(id, projectDir, name, input),
      onText: (text) => sessions.publish(id, { type: "thought", text: text.slice(0, 1200) }),
      onResult: (text, isError) => sessions.publish(id, {
        type: "result", ok: !isError, text: String(text).slice(0, 900),
      }),
    });

    note(id, "checking what came back", "rendering", 0.9);

    // Trust nothing about the outcome. The agent says it is finished; this
    // decides whether anything was actually produced, because a turn that ends
    // for any reason still ends claiming to be done.
    const renders = join(projectDir, "renders");
    const mp4 = existsSync(renders)
      ? readdirSync(renders).filter((f) => f.endsWith(".mp4")).sort().pop()
      : null;
    if (!mp4) {
      throw new Error(
        `no video was produced (turn ended: ${turn.subtype}). ` +
        String(turn.text ?? "").slice(-400),
      );
    }
    const finished = join(renders, mp4);

    const stats = await contentStats(finished);
    if (stats.blank) {
      throw new Error(
        `the render is blank: brightest frame ${stats.maxLuma.toFixed(2)} of 255 ` +
        `with no frame-to-frame change across ${stats.frames} frames`,
      );
    }

    const bytes = readFileSync(finished);
    const name = `${plan.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 48)}.mp4`;
    const rel = `out/${name}`;
    writeFileSync(sessions.pathIn(id, "out", name), bytes);
    sessions.addArtifact(id, {
      name, rel, bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });

    sessions.update(id, (s) => {
      s.state = "delivered";
      s.settlement = settlement(s);
      s.progress = "done";
      s.percent = 100;
      return s;
    });
    sessions.publish(id, {
      type: "done", state: "delivered", percent: 100,
      artifact: name, bytes: bytes.length,
    });
    return sessions.read(id);
  } catch (err) {
    const failed = err instanceof BudgetExceeded ? "budget" : "failed";
    sessions.setState(id, failed, { error: String(err.message ?? err) });
    sessions.publish(id, {
      type: "done", state: failed, percent: 100, error: String(err.message ?? err),
    });
    // The buyer paid before any of this ran, so a job that ends here has taken
    // money and produced nothing. Send it back without being asked: a refund the
    // buyer has to request is a refund most buyers never get.
    await refund(id, String(err.message ?? err));
    throw err;
  }
}

function storyboardMd(plan, seconds) {
  const per = plan.scenes.length ? (seconds / plan.scenes.length) : 0;
  const L = [`# ${plan.title}`, ``, `**Angle.** ${plan.angle}`, `**Look.** ${plan.look ?? "—"}`,
    `**Continuity device.** ${plan.continuity ?? "—"}`,
    `**Spectacle beat.** ${plan.spectacle ?? "—"}`,
    ``, `Narration runs ${seconds.toFixed(2)}s. Time the composition to it.`, ``];
  plan.scenes.forEach((s, i) => {
    const start = (i * per).toFixed(2), end = ((i + 1) * per).toFixed(2);
    L.push(`## Scene ${s.id} (${start}s - ${end}s)`, ``,
      `- narration: "${plan.narration[i] ?? ""}"`,
      `- idea: ${s.idea}`,
      `- image: \`../../assets/scene-${String(s.id).padStart(2, "0")}.jpg\``,
      s.onScreen ? `- on screen, quoted exactly: "${s.onScreen}"` : `- no on-screen copy`,
      s.motion ? `- motion: ${s.motion}` : ``, ``);
  });
  return L.filter((l) => l !== undefined).join("\n");
}

/**
 * The whole job, handed over once.
 *
 * Written as a goal rather than a procedure. Everything this asks for, the
 * agent can already do: it has the commands, it can read its own frames, and it
 * knows when a thing looks wrong. What it needed was the finish line stated
 * plainly and permission to iterate until it got there.
 */
const makeVideoPrompt = (dir, seconds) => `
Make the video. You are finished when an mp4 exists in ${dir}/renders that you
would put your name on.

Everything you need is in ${dir}: DIRECTION.md is the standing direction and the
measured facts about this machine, STORYBOARD.md is the agreed plan, and the
assets are bought and on disk. Read those two files first. Load the
\`hyperframes\` skill once for the framework's rules and do not read its
reference tree by hand.

The piece runs ${seconds.toFixed(2)} seconds, timed to the narration file.

How you get there is yours, but these are the tools and none of them are
optional:

    HYPERFRAMES_SKIP_SKILLS=1 npx hyperframes lint
    HYPERFRAMES_SKIP_SKILLS=1 npx hyperframes check
    HYPERFRAMES_SKIP_SKILLS=1 npx hyperframes snapshot --at 2,7,12,17,22,27
    HYPERFRAMES_SKIP_SKILLS=1 npx hyperframes render -q draft -w 3

Look at your own work. Snapshots are seconds and a render is minutes, so use
them freely while building. After you render, take one frame every five seconds
across the whole piece, put them in a single contact sheet, and read that one
image:

    ffmpeg -i renders/<file>.mp4 -vf "fps=1/5,scale=480:-1,tile=4x2:margin=8:padding=6" -frames:v 1 sheet.jpg

Then judge every cell of it at once, in order, and be specific about which
second is wrong. The failure this pipeline keeps producing is a film whose first
two scenes are finished and whose remaining twenty seconds are bare background:
it passes lint, it passes check, and only looking catches it. If any stretch is
empty, or holds still, or shows nothing but the frame furniture, that is a bug
in the composition and you fix it and render again.

You are not done because it renders. You are done when every second of it is
carrying something, the captions track the narration, and the last frame is as
considered as the first.
`.trim();
