/**
 * The Claude agent, confined to one session's workspace.
 *
 * The division of labour matters more than anything else in this file:
 * deterministic code owns money, job state and delivery; the agent owns
 * judgment. It plans a video, writes a composition, and looks at the frames it
 * produced. It never holds a key, never decides a price that becomes a charge,
 * and never sees another session's directory.
 *
 * Confinement is by `cwd`, not by asking nicely. The agent is started inside
 * `sessions/<jobId>` and every tool it has resolves relative to there.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { dirOf } from "./sessions.mjs";

/**
 * Run one turn of agent work in a session and return what it said.
 *
 * `bypassPermissions` is deliberate and is the reason the workspace boundary
 * carries the weight it does: nothing will stop a bad tool call to confirm it,
 * so the only real protection is that there is nothing valuable inside the
 * directory it is confined to.
 */
export async function agentTurn({
  sessionId,
  prompt,
  allowedTools = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  maxTurns = 40,
  onText = null,
  onTool = null,
}) {
  const cwd = dirOf(sessionId);
  const said = [];
  const tools = [];
  let result = null;

  for await (const msg of query({
    prompt,
    options: { cwd, permissionMode: "bypassPermissions", allowedTools, maxTurns },
  })) {
    if (msg.type === "assistant") {
      for (const block of msg.message?.content ?? []) {
        if (block.type === "text") {
          said.push(block.text);
          onText?.(block.text);
        }
        if (block.type === "tool_use") {
          tools.push(block.name);
          onTool?.(block.name, block.input);
        }
      }
    }
    if (msg.type === "result") result = msg;
  }

  return {
    text: said.join(""),
    tools,
    ok: result?.subtype === "success",
    subtype: result?.subtype ?? "unknown",
    costUsd: result?.total_cost_usd ?? null,
    ms: result?.duration_ms ?? null,
  };
}

/**
 * Ask for JSON and actually get JSON.
 *
 * Models wrap objects in prose and fences however firmly they are told not to,
 * so the fence is stripped and the outermost braces are taken rather than
 * trusting the whole reply to parse. A retry costs a few cents; a crash costs
 * the job.
 */
export async function agentJson({ sessionId, prompt, schemaHint, attempts = 2, ...rest }) {
  const ask =
    `${prompt}\n\nReply with JSON only, matching this shape:\n${schemaHint}\n` +
    `No commentary, no code fence.`;
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const turn = await agentTurn({ sessionId, prompt: ask, ...rest });
    last = turn;
    const parsed = extractJson(turn.text);
    if (parsed) return { ...turn, json: parsed };
  }
  return { ...last, json: null };
}

export function extractJson(text) {
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}
