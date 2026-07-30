/**
 * Prerequisite checks shared by the setup scripts.
 *
 * These run in order and each builds on the last, so a fresh clone that starts in
 * the middle should say *which step is missing* rather than throwing ENOENT from
 * somewhere inside fs. A setup that cannot be followed from a clean checkout is a
 * setup that does not exist.
 */
import { existsSync, readFileSync } from "node:fs";

const STATE_PATH = new URL("../.state.json", import.meta.url);

function die(lines) {
  console.error(`\n  ${lines.join("\n  ")}\n`);
  process.exit(1);
}

/** Operator credentials, produced by `npm run keygen` and funding the address. */
export function requireOperator() {
  const { OPERATOR_ID, OPERATOR_KEY } = process.env;
  if (!OPERATOR_KEY) {
    die([
      "No OPERATOR_KEY in .env.",
      "Run:  cp .env.example .env && npm run keygen",
    ]);
  }
  if (!OPERATOR_ID) {
    die([
      "OPERATOR_ID is empty — the operator account does not exist on-chain yet.",
      "Fund the EVM address in .env from https://portal.hedera.com/faucet,",
      "then run:  npm run whoami",
    ]);
  }
  return { OPERATOR_ID, OPERATOR_KEY };
}

/**
 * Load .state.json, asserting that the named steps have already run.
 *
 * @param {Array<[string, string, string]>} requirements  [stateKey, step, command]
 */
export function requireState(requirements = []) {
  if (!existsSync(STATE_PATH)) {
    die([
      "No .state.json — no setup step has run yet.",
      "Start with:  npm run gate1",
    ]);
  }
  const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  for (const [key, step, command] of requirements) {
    const present = key.split(".").reduce((o, k) => o?.[k], state);
    if (!present) {
      die([`${step} has not run yet (missing "${key}" in .state.json).`, `Run:  ${command}`]);
    }
  }
  return state;
}

/** The co-signer half of the agent key, written by gate2 into its own file. */
export function requirePolicyKey() {
  const path = new URL("../.policy.key", import.meta.url);
  if (!existsSync(path)) {
    die(["No .policy.key — the threshold agent has not been created.", "Run:  npm run gate2"]);
  }
  return readFileSync(path, "utf8").trim();
}
