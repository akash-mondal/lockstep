/**
 * One workspace per incoming request.
 *
 * Two agents working at once must not see each other's files. The obvious way
 * to get that wrong is a shared scratch directory with job-prefixed filenames,
 * which holds right up until an agent globs `*.jpg` and picks up somebody
 * else's scene. So isolation is a directory boundary, and the agent is launched
 * with its `cwd` set to that directory: it cannot reach a sibling without an
 * absolute path it was never given.
 *
 * The layout is fixed so both the agent and the deterministic code know where
 * things are without negotiating:
 *
 *   sessions/<jobId>/
 *     task.json      what was asked for, and by whom
 *     plan.json      the storyboard the agent produced
 *     assets/        everything bought over x402, one file per purchase
 *     work/          the HyperFrames project the agent authors
 *     out/           the finished video
 *     ledger.json    every payment made for this job
 *     receipt.json   the bill handed back to the requester
 */
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = process.env.SESSIONS_ROOT ?? "/home/azureuser/sessions";
const SUBDIRS = ["assets", "work", "out"];

/** Short, unguessable, and safe as a path segment. */
const newId = () => randomBytes(9).toString("base64url");

export function createSession({ task, requester = null } = {}) {
  const id = newId();
  const dir = join(ROOT, id);
  mkdirSync(dir, { recursive: true });
  for (const d of SUBDIRS) mkdirSync(join(dir, d), { recursive: true });

  // The download token is separate from the job id so that knowing a job
  // exists is not the same as being able to fetch what it produced.
  const record = {
    id,
    createdAt: Date.now(),
    state: "created",
    requester,
    task,
    downloadToken: randomBytes(24).toString("base64url"),
    plan: null,
    funding: null,
    ledger: [],
    artifacts: [],
    error: null,
  };
  write(id, record);
  return record;
}

const metaPath = (id) => join(ROOT, id, "session.json");

export function read(id) {
  const p = metaPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function write(id, record) {
  writeFileSync(metaPath(id), JSON.stringify(record, null, 2));
  return record;
}

/** Read, mutate, write. Callers never hold a stale copy across an await. */
export function update(id, fn) {
  const record = read(id);
  if (!record) throw new Error(`no session ${id}`);
  const next = fn(record) ?? record;
  next.updatedAt = Date.now();
  return write(id, next);
}

export const dirOf = (id) => join(ROOT, id);
export const pathIn = (id, ...parts) => join(ROOT, id, ...parts);

/**
 * Refuse a path that escapes the session.
 *
 * The agent proposes filenames, and a proposed name is untrusted input however
 * plausible it looks. `../../etc/passwd` and an absolute path both resolve
 * outside the workspace, so both are rejected here rather than trusted to be
 * well-intentioned.
 */
export function safePath(id, relative) {
  const base = resolve(dirOf(id));
  const full = resolve(base, relative);
  if (full !== base && !full.startsWith(base + "/")) {
    throw new Error(`path ${relative} escapes the session workspace`);
  }
  return full;
}

/** Record a payment. This is what the receipt is later built from. */
export function addPayment(id, entry) {
  return update(id, (s) => {
    s.ledger.push({ at: Date.now(), ...entry });
    return s;
  });
}

export function addArtifact(id, artifact) {
  return update(id, (s) => {
    s.artifacts.push({ at: Date.now(), ...artifact });
    return s;
  });
}

export function setState(id, state, extra = {}) {
  return update(id, (s) => Object.assign(s, { state }, extra));
}

export function list() {
  if (!existsSync(ROOT)) return [];
  return readdirSync(ROOT)
    .map((id) => read(id))
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Everything this job spent, in tinybar. */
export const spent = (record) =>
  record.ledger.reduce((sum, e) => sum + BigInt(e.tinybar ?? 0), 0n);

export function destroy(id) {
  const dir = dirOf(id);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/**
 * Live progress, for anyone watching a job they have paid for.
 *
 * A job takes minutes and spends the buyer's money the whole way through, so
 * "still working" is not an acceptable answer to what is happening. Every step
 * publishes here and the HTTP layer turns it into an event stream.
 *
 * Deliberately in memory and deliberately lossy. This is a view of a job in
 * flight, not a record of it: the receipt and the session file are the record,
 * and a dropped frame of progress must never mean a lost payment.
 */
const bus = new EventEmitter();
// One job can be watched by several clients and the default cap of 10 is easy
// to reach with a browser reconnecting.
bus.setMaxListeners(0);

export function publish(id, event) {
  bus.emit(id, { at: Date.now(), ...event });
}

export function subscribe(id, listener) {
  bus.on(id, listener);
  return () => bus.off(id, listener);
}

export { ROOT };
