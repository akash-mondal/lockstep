/**
 * The pipeline: paid job in, finished video out.
 *
 * Deterministic code owns money, files and delivery. The agent owns judgment:
 * it writes the storyboard, authors the composition, and looks at the frames it
 * produced. It never holds a key and never decides an amount.
 *
 * The order is chosen so the cheapest check runs first. `lint` and `check` load
 * the composition in a headless browser and name overflow, collisions, runtime
 * errors and contrast failures in seconds; a render takes minutes and will
 * happily contain a defect they would have caught. So nothing renders until both
 * pass, and only then does anyone look at pixels.
 */
import { execFile, spawn } from "node:child_process";
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
import { sample, contentStats, stillsAreBlank, thumbnail, waveform } from "./frames.mjs";
import { refund } from "./refund.mjs";

const run = promisify(execFile);
const HF = { env: { ...process.env, HYPERFRAMES_SKIP_SKILLS: "1" }, maxBuffer: 32 * 1024 * 1024 };
const MAX_FIX_PASSES = Number(process.env.STUDIO_FIX_PASSES ?? 2);
// How many times the piece is looked at and revised before it is rendered.
// Each pass is one vision call and one agent turn, which is the cost of the
// studio spending longer on the work rather than shipping its first attempt.
const DESIGN_PASSES = Number(process.env.STUDIO_DESIGN_PASSES ?? 1);

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

/** lint then check. Both must pass before anything renders. */
async function gate(projectDir, id = null) {
  const out = [];
  for (const cmd of ["lint", "check"]) {
    try {
      const { stdout, stderr } = await run("npx", ["hyperframes", cmd], { ...HF, cwd: projectDir });
      const text = stdout + stderr;
      out.push({ cmd, ok: true, output: text.slice(-3000) });
      if (id) {
        sessions.publish(id, {
          type: "gate", cmd, ok: true,
          // The counts are what a UI wants to show; the text is for a human who
          // clicks through.
          errors: 0,
          warnings: Number(/(\d+)\s+warning/.exec(text)?.[1] ?? 0),
          output: text.slice(-1200),
        });
      }
    } catch (err) {
      const text = String(err.stdout ?? "") + String(err.stderr ?? err.message);
      if (id) {
        sessions.publish(id, {
          type: "gate", cmd, ok: false,
          errors: Number(/(\d+)\s+error/.exec(text)?.[1] ?? 0),
          warnings: Number(/(\d+)\s+warning/.exec(text)?.[1] ?? 0),
          // Each failing assertion on its own line, so a UI can list them.
          findings: text.split("\n").filter((l) => /✗|error/i.test(l)).slice(0, 25).map((l) => l.trim()),
          output: text.slice(-1200),
        });
      }
      return { ok: false, failed: cmd, output: text };
    }
  }
  return { ok: true, passes: out };
}

/**
 * Render, reporting frames as they are captured.
 *
 * hyperframes emits structured trace lines carrying totalFrames and
 * framesCompleted, and buffering them until the process exits throws away the
 * only fine-grained progress in the whole pipeline. Rendering is a quarter of a
 * job's wall clock, so this is exactly the stretch a watcher should not be left
 * staring at a spinner through.
 */
async function render(id, projectDir) {
  // Workers are set explicitly. `auto` resolved to 1 on a four core box and
  // rendered 977 frames single threaded in 333 seconds, which was most of the
  // job. Each worker is a Chrome process at roughly 256 MB, and this machine has
  // 15 GB, so the constraint is cores rather than memory.
  const workers = process.env.STUDIO_RENDER_WORKERS ?? String(Math.max(1, cpus().length - 1));
  const args = ["hyperframes", "render", "-q", process.env.STUDIO_RENDER_QUALITY ?? "draft",
                "-w", workers];

  await new Promise((resolve, reject) => {
    const child = spawn("npx", args, { ...HF, cwd: projectDir });
    let tail = "";
    let lastPct = -1;

    const scan = (chunk) => {
      tail = (tail + chunk).slice(-16_000);
      for (const line of String(chunk).split("\n")) {
        const m = /"totalFrames":(\d+),"framesCompleted":(\d+)/.exec(line)
          ?? /"framesCompleted":(\d+).*?"totalFrames":(\d+)/.exec(line);
        if (!m) continue;
        const [total, done] = /"totalFrames":(\d+),"framesCompleted":/.test(line)
          ? [Number(m[1]), Number(m[2])]
          : [Number(m[2]), Number(m[1])];
        if (!total) continue;
        const pct = Math.round((done / total) * 100);
        // Only on change, or a 977 frame render becomes a thousand messages.
        if (pct === lastPct) continue;
        lastPct = pct;
        sessions.publish(id, { type: "render", framesCompleted: done, totalFrames: total, framePercent: pct });
        note(id, `rendering frame ${done} of ${total}`, "rendering", done / total);
      }
    };

    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`render exited ${code}:\n${tail.slice(-800)}`));
    });
  });

  const dir = join(projectDir, "renders");
  if (!existsSync(dir)) throw new Error("render produced no output directory");
  const mp4 = readdirSync(dir).filter((f) => f.endsWith(".mp4")).sort().pop();
  if (!mp4) throw new Error("render produced no mp4");
  return join(dir, mp4);
}

/**
 * Snapshot the composition without rendering it.
 *
 * A render of half a minute at 1080p takes minutes and produces a file nobody
 * needs if the design is wrong. `snapshot` seeks the same composition in the
 * same headless browser and writes stills in seconds, which makes it affordable
 * to look, revise and look again before committing to a render.
 */
async function snapshot(projectDir, times) {
  const dir = join(projectDir, "snapshots");

  // Clear first. The agent takes its own snapshots while composing, at whatever
  // times it chose, and every pass of the design loop leaves its frames behind.
  // Reading the directory without emptying it returns those together with the
  // fresh ones, so a critique would judge the version it had just asked to be
  // changed and the loop could never converge.
  rmSync(dir, { recursive: true, force: true });

  const at = times.map((t) => t.toFixed(2)).join(",");
  await run("npx", ["hyperframes", "snapshot", "--at", at], { ...HF, cwd: projectDir });
  if (!existsSync(dir)) return [];

  // Sorted by the time in the filename rather than lexically: frame-10 sorts
  // before frame-2 as a string, which would hand the reviewer the piece out of
  // order and invite it to report a continuity problem that does not exist.
  const files = readdirSync(dir)
    .filter((f) => /^frame-.*\.png$/.test(f))
    .map((f) => ({ f, at: Number(/at-([\d.]+)s/.exec(f)?.[1] ?? 0) }))
    .sort((a, b) => a.at - b.at)
    .map(({ f }) => join(dir, f));
  return { paths: files, frames: files.map((f) => readFileSync(f).toString("base64")) };
}

/**
 * Look at the design and decide whether it is finished.
 *
 * This is the loop the pipeline was missing. Composing once and rendering
 * whatever came out means the only quality signal arrives after the money has
 * been spent, and the review that did exist was recorded and never acted on, so
 * nothing in the system could improve its own work.
 *
 * The checklist is concrete on purpose. Asking a model whether a frame "looks
 * good" gets agreement; asking it to count captions and name drawn elements gets
 * an answer that can fail.
 */
async function critique(id, projectDir, seconds, pass) {
  const n = 6;
  const times = Array.from({ length: n }, (_, i) => (seconds * (i + 0.5)) / n);
  const { paths, frames } = await snapshot(projectDir, times);
  // The actual stills, so a watcher sees what the studio is judging rather than
  // only the judgement. These are already small.
  sessions.publish(id, {
    type: "snapshot", pass, at: times.map((t) => Number(t.toFixed(2))), stills: frames,
  });
  if (!frames.length) {
    return { ok: false, notes: "The composition produced no stills at all.", frames: 0 };
  }

  // Settle this without a model. A vision reviewer handed six identical black
  // PNGs described callout lines, data readouts and a face, none of which were
  // there. Empty input does not produce an admission, it produces fiction, and
  // paying 0.08 HBAR for it twice is worse than not asking.
  const empty = await stillsAreBlank(paths);
  if (empty.blank) {
    return {
      ok: false,
      frames: frames.length,
      notes:
        `The composition is not rendering: ${empty.reason}. This was measured ` +
        `from the stills, not judged.\n\n` +
        `Nothing is on screen, so there is no design to review. Find out why ` +
        `index.html renders empty before changing anything about the look. The ` +
        `usual causes are a timeline that was never registered on ` +
        `window.__timelines, clips whose data-start and data-duration put every ` +
        `element outside the seek window, or a fromTo whose from-state hides ` +
        `everything at every earlier time.`,
    };
  }

  const r = await buy(id, "vision", `design review, pass ${pass}`, {
    frames,
    question:
      `These are ${frames.length} stills from one motion graphics piece, in time ` +
      `order. It has spoken narration throughout and word timings were bought ` +
      `for captions.\n\n` +
      `Count, do not judge:\n` +
      `1. How many of these frames carry a caption or subtitle?\n` +
      `2. How many distinct text sizes or weights appear across the set?\n` +
      `3. Name every graphic element drawn over the photography: rules, ticks, ` +
      `callout lines, brackets, readouts, dividers. Say none if there are none.\n` +
      `4. In how many frames is the photograph full bleed, filling the entire ` +
      `frame as a background, rather than placed as a shaped or framed element ` +
      `with ground visible around it?\n` +
      `5. Is the framing varied across the set, or is every shot at the same ` +
      `distance?\n\n` +
      `This piece fails if captions are missing, if there is one text size, if ` +
      `nothing is drawn over the image, or if every frame is a full bleed ` +
      `photograph with a small label. Those are the specific defects.\n\n` +
      `End your reply with exactly one line, either:\n` +
      `VERDICT: PASS\n` +
      `VERDICT: REVISE followed by the numbered changes that would fix it.`,
  });

  const text = String(r.text ?? "");
  const ok = /VERDICT:\s*PASS/i.test(text);
  sessions.publish(id, { type: "critique", pass, ok, notes: text.slice(0, 2000) });
  return { ok, notes: text, frames: frames.length };
}

/**
 * Look at what was rendered.
 *
 * `check` can prove an element is inside its region and legible; it cannot say
 * the video is dull, that a scene contradicts its narration, or that the
 * composition is ugly. That judgment needs eyes, which is why this runs last and
 * only on something that already passed.
 */
async function review(id, mp4, plan) {
  try {
    const frames = await sample(mp4, 6);
    // The title and the scene list are deliberately withheld. When they were in
    // this prompt the reviewer wrote a fluent description of the storyboard it
    // had been shown rather than the frames it had been sent, and certified a
    // completely black video as finished work. Ask only what is on screen.
    const r = await buy(id, "vision", "reviewing the render", {
      frames,
      question:
        `These are ${frames.length} frames sampled evenly across one video. ` +
        `Describe only what is actually visible in each frame. If a frame is ` +
        `empty, black, or contains nothing at all, say exactly that and do not ` +
        `infer what it was meant to contain.\n\n` +
        `Then answer each of these about the set, counting what you can see:\n` +
        `1. How many frames carry a caption or subtitle line? This film has ` +
        `spoken narration throughout, so a frame without one is a defect.\n` +
        `2. How many distinct sizes or weights of text appear? One size ` +
        `everywhere means no hierarchy.\n` +
        `3. What graphic elements are drawn over the photography: rules, tick ` +
        `marks, callout lines, brackets, readouts? Name them, or say none.\n` +
        `4. Is the subject shown whole and centred with empty margin around it, ` +
        `or is the framing tight and cropped?\n\n` +
        `Finally list what is wrong: text cut off or overlapping, a dead frame, ` +
        `a bare photograph with a single small label, a composition that reads ` +
        `as unfinished. Name the frame number for each problem. A frame that is ` +
        `just a photograph with one label in the corner is the failure I am ` +
        `looking for. Do not reassure me.`,
    });
    return { text: r.text, frames: frames.length };
  } catch (err) {
    // A failed review must not lose a finished video; it is reported instead.
    return { text: null, error: String(err.message ?? err) };
  }
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

    let attempt = 0;
    let mp4 = null;
    let lastGate = null;

    while (attempt <= MAX_FIX_PASSES) {
      const first = attempt === 0;
      note(id, first ? "authoring the composition" : `fixing, pass ${attempt}`, "composing", first ? 0.1 : 0.6);
      await agentTurn({
        sessionId: id,
        prompt: first ? composePrompt(projectDir) : fixPrompt(projectDir, lastGate),
        // Skill is what lets it load the framework's conventions in one call
        // instead of reading the skill tree by hand.
        allowedTools: ["Skill", "Read", "Write", "Edit", "Bash", "Glob", "Grep"],
        // Publish what the agent is doing as it does it. A job that takes
        // minutes and spends money throughout should never be a blank wait.
        onTool: (name, input) => onAgentTool(id, projectDir, name, input),
        onText: (text) => sessions.publish(id, { type: "thought", text: text.slice(0, 1200) }),
        onResult: (text, isError) => sessions.publish(id, {
          type: "result", ok: !isError, text: String(text).slice(0, 900),
        }),
        maxTurns: Number(process.env.STUDIO_MAX_TURNS ?? 90),
        timeoutMs: Number(process.env.STUDIO_TURN_TIMEOUT_MS ?? 720_000),
      });

      note(id, "running lint and check", "gate", 0.5);
      lastGate = await gate(projectDir, id);
      if (!lastGate.ok) { attempt++; continue; }

      // The design loop. Snapshots are cheap and a render is not, so the piece
      // is looked at and revised here, before anything commits to minutes of
      // rendering. Each pass costs one vision call, which is why it is bounded.
      for (let pass = 1; pass <= DESIGN_PASSES; pass++) {
        note(id, `design review, pass ${pass} of ${DESIGN_PASSES}`, "critique", (pass - 0.5) / DESIGN_PASSES);
        let verdict;
        try {
          verdict = await critique(id, projectDir, narrationSeconds, pass);
        } catch (err) {
          if (err instanceof BudgetExceeded) break;
          throw err;
        }
        sessions.update(id, (s) => {
          s.critiques = [...(s.critiques ?? []), { pass, ok: verdict.ok, notes: verdict.notes }];
          return s;
        });
        if (verdict.ok) break;

        note(id, `revising the design, pass ${pass}`, "critique", pass / DESIGN_PASSES);
        await agentTurn({
          sessionId: id,
          prompt: revisePrompt(projectDir, verdict.notes),
          allowedTools: ["Skill", "Read", "Write", "Edit", "Bash", "Glob", "Grep"],
          onTool: (name, input) => onAgentTool(id, projectDir, name, input),
          onText: (text) => sessions.publish(id, { type: "thought", text: text.slice(0, 1200) }),
          onResult: (text, isError) => sessions.publish(id, {
            type: "result", ok: !isError, text: String(text).slice(0, 900),
          }),
          maxTurns: Number(process.env.STUDIO_REVISE_TURNS ?? 60),
          timeoutMs: Number(process.env.STUDIO_REVISE_TIMEOUT_MS ?? 240_000),
        });

        const regate = await gate(projectDir, id);
        if (!regate.ok) {
          // A revision that breaks the gate is worse than the version it
          // replaced, so it goes back through the ordinary fix path.
          lastGate = regate;
          break;
        }
        lastGate = regate;
      }
      if (!lastGate.ok) { attempt++; continue; }

      note(id, "rendering", "rendering", 0.05);
      const candidate = await render(id, projectDir);

      // Rendering successfully is not the same as having composed anything. An
      // untouched scaffold renders perfectly well and produces pure black, and
      // every other check in this pipeline passes on it, so the only thing that
      // catches it is measuring the pixels.
      const stats = await contentStats(candidate);
      if (stats.blank) {
        lastGate = {
          ok: false,
          output:
            `The render is blank. ${stats.frames} frames were measured and the ` +
            `brightest was ${stats.maxLuma.toFixed(2)} out of 255, with a maximum ` +
            `frame-to-frame difference of ${stats.maxDelta.toFixed(2)}. Nothing is ` +
            `on screen. index.html is almost certainly still the scaffold: it is ` +
            `the composition that is missing, not the render settings.`,
        };
        note(id, "the render came out blank", "rendering", 0.1);
        attempt++;
        continue;
      }

      mp4 = candidate;
      break;
    }

    if (!mp4) throw new Error(`the gate never passed: ${String(lastGate?.output).slice(-600)}`);

    sessions.setState(id, "reviewing");
    const verdict = await review(id, mp4, plan);
    sessions.update(id, (s) => { s.review = verdict; return s; });

    const bytes = readFileSync(mp4);
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

const composePrompt = (dir) => `
Read DIRECTION.md and STORYBOARD.md in ${dir}, then build the composition.

The deliverable is index.html and nothing else. It arrives as an empty scaffold
and it is your job to replace it. Do not rewrite STORYBOARD.md, DIRECTION.md or
any other document: the storyboard is already decided and writing prose about it
is not progress. If index.html is still the scaffold, you have not started.

Start by loading the framework's own rules with the \`/hyperframes\` skill. Do not
guess at HTML video conventions; the skill exists because the defaults are wrong.
Load it with the Skill tool; do not read the skill directories by hand.

Work in ${dir}. The assets are already bought and sit in ../../assets relative to
that directory. Reference each by path. Generate nothing.

When you believe it is right, run:
    HYPERFRAMES_SKIP_SKILLS=1 npx hyperframes lint
    HYPERFRAMES_SKIP_SKILLS=1 npx hyperframes check
and fix whatever they report. Do not render; that happens outside this turn.
`.trim();

const revisePrompt = (dir, notes) => `
A design review of ${dir} came back with changes. These are counted observations
of the stills, not opinions, and the piece is not finished until they are gone.

${notes}

Revise index.html. Do not start over and do not restate the plan; change what was
named. Re-read DIRECTION.md if you need the standing rules, then run:
    HYPERFRAMES_SKIP_SKILLS=1 npx hyperframes lint
    HYPERFRAMES_SKIP_SKILLS=1 npx hyperframes check
You can look at your own work without rendering:
    HYPERFRAMES_SKIP_SKILLS=1 npx hyperframes snapshot --at 2,8,16,24
Do not render. That happens outside this turn.
`.trim();

const fixPrompt = (dir, gate) => `
The gate failed in ${dir}. This is what it said:

${String(gate?.output ?? "").slice(-2500)}

Fix the composition so both lint and check pass. Do not start over and do not
remove content to make a check pass; the report names a real defect, so correct
that defect. Re-run both when you are done.
`.trim();
