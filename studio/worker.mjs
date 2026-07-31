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
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import "dotenv/config";
import * as sessions from "./sessions.mjs";
import { buy, remaining, settlement, BudgetExceeded } from "./purchase.mjs";
import { agentTurn, agentJson } from "./harness.mjs";
import { houseStyle } from "./house-style.mjs";
import { sample, contentStats } from "./frames.mjs";
import { refund } from "./refund.mjs";

const run = promisify(execFile);
const HF = { env: { ...process.env, HYPERFRAMES_SKIP_SKILLS: "1" }, maxBuffer: 32 * 1024 * 1024 };
const MAX_FIX_PASSES = Number(process.env.STUDIO_FIX_PASSES ?? 2);

const note = (id, progress) => sessions.update(id, (s) => { s.progress = progress; return s; });

/** Buy every asset the plan calls for, inside the job's budget. */
async function buyAssets(id, plan) {
  const s = () => sessions.read(id);
  const dir = (f) => sessions.pathIn(id, "assets", f);
  const bought = [];

  for (const scene of plan.scenes) {
    note(id, `buying image ${scene.id} of ${plan.scenes.length}`);
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
  }

  let narrationSeconds = 0;
  if (plan.narration?.length) {
    note(id, "buying narration");
    const text = plan.narration.join(" ");
    const r = await buy(id, "speech", "narration", { text, voice: "Kore" });
    writeFileSync(dir("narration.wav"), Buffer.from(r.data, "base64"));
    narrationSeconds = r.seconds ?? 0;
    bought.push({ rel: "assets/narration.wav", role: "narration", seconds: narrationSeconds });

    // Word timings, so captions land on the spoken word rather than a guess.
    if (remaining(s()) > 0n) {
      note(id, "buying transcription");
      const t = await buy(id, "transcribe", "word timings", {
        data: readFileSync(dir("narration.wav")).toString("base64"),
        filename: "narration.wav",
      });
      writeFileSync(dir("transcript.json"), JSON.stringify(t.words, null, 2));
      bought.push({ rel: "assets/transcript.json", role: "word timings" });
    }
  }

  if (plan.music !== false && remaining(s()) > 0n) {
    note(id, "buying music");
    const r = await buy(id, "music", "music bed", { prompt: plan.music });
    writeFileSync(dir("bed.mp3"), Buffer.from(r.data, "base64"));
    bought.push({ rel: "assets/bed.mp3", role: "music bed" });
  }

  return { bought, narrationSeconds };
}

/** Scaffold a HyperFrames project the agent will author into. */
async function scaffold(id) {
  const workDir = sessions.pathIn(id, "work");
  await run("npx", ["hyperframes", "init", "video", "--example", "blank", "--non-interactive"],
    { ...HF, cwd: workDir });
  return join(workDir, "video");
}

/** lint then check. Both must pass before anything renders. */
async function gate(projectDir) {
  const out = [];
  for (const cmd of ["lint", "check"]) {
    try {
      const { stdout, stderr } = await run("npx", ["hyperframes", cmd], { ...HF, cwd: projectDir });
      out.push({ cmd, ok: true, output: (stdout + stderr).slice(-3000) });
    } catch (err) {
      return { ok: false, failed: cmd, output: String(err.stdout ?? "" ) + String(err.stderr ?? err.message) };
    }
  }
  return { ok: true, passes: out };
}

async function render(projectDir) {
  const { stdout, stderr } = await run("npx", ["hyperframes", "render"], { ...HF, cwd: projectDir });
  const all = stdout + stderr;
  const dir = join(projectDir, "renders");
  if (!existsSync(dir)) throw new Error(`render produced no output:\n${all.slice(-800)}`);
  const mp4 = readdirSync(dir).filter((f) => f.endsWith(".mp4")).sort().pop();
  if (!mp4) throw new Error(`render produced no mp4:\n${all.slice(-800)}`);
  return join(dir, mp4);
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
    sessions.setState(id, "buying");
    const { bought, narrationSeconds } = await buyAssets(id, plan);

    sessions.setState(id, "composing");
    note(id, "scaffolding the project");
    const projectDir = await scaffold(id);

    // The storyboard and the standing direction go on disk, because that is how
    // the framework's own skills expect to find them.
    const direction = houseStyle({
      brief: plan.title,
      assets: bought.map((b) => ({ path: `../../${b.rel}`, role: b.role, seconds: b.seconds })),
      narrationSeconds,
    });
    writeFileSync(join(projectDir, "DIRECTION.md"), direction);
    writeFileSync(join(projectDir, "STORYBOARD.md"), storyboardMd(plan, narrationSeconds));

    let attempt = 0;
    let mp4 = null;
    let lastGate = null;

    while (attempt <= MAX_FIX_PASSES) {
      const first = attempt === 0;
      note(id, first ? "authoring the composition" : `fixing, pass ${attempt}`);
      await agentTurn({
        sessionId: id,
        prompt: first ? composePrompt(projectDir) : fixPrompt(projectDir, lastGate),
        // Skill is what lets it load the framework's conventions in one call
        // instead of reading the skill tree by hand.
        allowedTools: ["Skill", "Read", "Write", "Edit", "Bash", "Glob", "Grep"],
        maxTurns: 60,
        timeoutMs: Number(process.env.STUDIO_TURN_TIMEOUT_MS ?? 1_500_000),
      });

      note(id, "running lint and check");
      lastGate = await gate(projectDir);
      if (!lastGate.ok) { attempt++; continue; }

      note(id, "rendering");
      const candidate = await render(projectDir);

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
        note(id, "the render came out blank");
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
      return s;
    });
    return sessions.read(id);
  } catch (err) {
    const failed = err instanceof BudgetExceeded ? "budget" : "failed";
    sessions.setState(id, failed, { error: String(err.message ?? err) });
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

const fixPrompt = (dir, gate) => `
The gate failed in ${dir}. This is what it said:

${String(gate?.output ?? "").slice(-2500)}

Fix the composition so both lint and check pass. Do not start over and do not
remove content to make a check pass; the report names a real defect, so correct
that defect. Re-run both when you are done.
`.trim();
