/**
 * Two agents, two workspaces, at the same time.
 *
 * The failure this guards against is a shared scratch directory: everything
 * looks fine until one agent globs and picks up the other's files. So each is
 * given a secret and asked to report every file it can see; if the boundary
 * holds, neither ever names the other's.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createSession, destroy, pathIn, safePath } from "./sessions.mjs";

const A = createSession({ task: "session A", requester: "agent-alpha" });
const B = createSession({ task: "session B", requester: "agent-beta" });
console.log(`A ${A.id}\nB ${B.id}\n`);

writeFileSync(pathIn(A.id, "assets", "alpha-secret.txt"), "ALPHA_ONLY_7731");
writeFileSync(pathIn(B.id, "assets", "beta-secret.txt"), "BETA_ONLY_9942");

const { agentTurn } = await import("./harness.mjs");
const ask = (label) =>
  `List every file under the current directory, recursively. Then state, in one ` +
  `line, whether you can see any file whose name contains "${label}". Do not ` +
  `create or modify anything.`;

const [ra, rb] = await Promise.all([
  agentTurn({ sessionId: A.id, prompt: ask("beta"), allowedTools: ["Bash", "Read", "Glob"], maxTurns: 8 }),
  agentTurn({ sessionId: B.id, prompt: ask("alpha"), allowedTools: ["Bash", "Read", "Glob"], maxTurns: 8 }),
]);

const leakedIntoA = /BETA_ONLY_9942|beta-secret/i.test(ra.text);
const leakedIntoB = /ALPHA_ONLY_7731|alpha-secret/i.test(rb.text);
const sawOwnA = /alpha-secret/i.test(ra.text);
const sawOwnB = /beta-secret/i.test(rb.text);

console.log("A said:", ra.text.trim().slice(0, 200).replace(/\n/g, " "));
console.log("B said:", rb.text.trim().slice(0, 200).replace(/\n/g, " "));
console.log();
console.log(`  A sees its own file      ${sawOwnA ? "yes" : "NO"}`);
console.log(`  B sees its own file      ${sawOwnB ? "yes" : "NO"}`);
console.log(`  A leaked B's secret      ${leakedIntoA ? "YES - FAIL" : "no"}`);
console.log(`  B leaked A's secret      ${leakedIntoB ? "YES - FAIL" : "no"}`);
console.log(`  cost                     $${((ra.costUsd ?? 0) + (rb.costUsd ?? 0)).toFixed(4)}`);

// the path guard is deterministic, so assert it directly rather than asking
let escaped = false;
for (const bad of ["../" + B.id + "/assets/beta-secret.txt", "/etc/passwd", "assets/../../" + B.id]) {
  try { safePath(A.id, bad); escaped = true; console.log(`  ESCAPED via ${bad}`); }
  catch { /* refused, as intended */ }
}
console.log(`  safePath blocks escapes  ${escaped ? "NO - FAIL" : "yes"}`);

const pass = sawOwnA && sawOwnB && !leakedIntoA && !leakedIntoB && !escaped;
console.log(`\n${pass ? "PASS" : "FAIL"}`);
destroy(A.id); destroy(B.id);
process.exit(pass ? 0 : 1);
