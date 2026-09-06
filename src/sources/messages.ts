/**
 * Reading what agents say to each other.
 *
 * Two channels carry it, and they are different enough that conflating them
 * would lose the distinction that matters. A peer message is a conversation
 * between two long-lived Slots; a dispatch is a Slot spawning a short-lived
 * subagent to do one thing and report back.
 *
 * Both are recorded on both ends, so nothing here infers an edge. A peer
 * message carries a `msg_id` that the sender's tool result and the recipient's
 * inbound line both quote verbatim; a dispatch carries an `agentId` that names
 * the nested transcript the subagent wrote. Where a join fails, the message is
 * left unresolved rather than guessed at -- an undelivered send is a finding,
 * not a gap to paper over.
 *
 * Every parser here is a pure function of one line. The send body and its
 * `msg_id` arrive on two separate lines, which a resume boundary is free to
 * split, so they are stored against the tool-use id and reconciled by the
 * store rather than correlated in memory. That keeps incremental scanning
 * exactly as safe as it is for requests.
 */

/** Both names Claude Code has used for the subagent-spawning tool. */
const DISPATCH_TOOLS = new Set(['Agent', 'Task']);

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

type ToolUseBlock = { type?: unknown; id?: unknown; name?: unknown; input?: Record<string, unknown> };

type AssistantLine = {
  type?: unknown;
  uuid?: unknown;
  timestamp?: unknown;
  sessionId?: unknown;
  gitBranch?: unknown;
  attributionSkill?: unknown;
  message?: { content?: unknown };
};

function toolUses(line: string, marker: string): { entry: AssistantLine; blocks: ToolUseBlock[] } | null {
  if (!line.includes(marker)) return null;
  let entry: AssistantLine;
  try {
    entry = JSON.parse(line) as AssistantLine;
  } catch {
    return null;
  }
  if (entry.type !== 'assistant') return null;
  if (typeof entry.timestamp !== 'string') return null;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return null;
  const blocks = content.filter(
    (b): b is ToolUseBlock => typeof b === 'object' && b !== null && (b as ToolUseBlock).type === 'tool_use',
  );
  return blocks.length === 0 ? null : { entry, blocks };
}

export type PeerSend = {
  /** The tool-use id, which is what the delivery result is keyed by. */
  toolUseId: string;
  ts: string;
  /** The name the sender addressed, which is a session identity, not a Slot. */
  toName: string;
  summary: string | null;
  body: string;
  /** The skill that was driving when the message was sent, when recorded. */
  skill: string | null;
};

/**
 * A `SendMessage` call: the outbound half of a peer message.
 *
 * One assistant line can carry several, so this returns every send on it. The
 * recipient is taken from `to`, which is the name the sender typed -- it is a
 * per-session identity like `agenta-ff`, and sometimes a task name like
 * `public-commands-landing`, so it is stored as written and never parsed into
 * a Slot. Resolving it is the delivery join's job.
 */
export function parsePeerSends(line: string): PeerSend[] {
  const found = toolUses(line, '"SendMessage"');
  if (!found) return [];
  const { entry, blocks } = found;
  const sends: PeerSend[] = [];

  for (const block of blocks) {
    if (block.name !== 'SendMessage') continue;
    const id = str(block.id);
    const input = block.input ?? {};
    // `to`/`message` are the documented fields; `recipient`/`content` appear
    // beside them as a truncated echo, so they are only a fallback.
    const to = str(input['to']) ?? str(input['recipient']);
    const body = str(input['message']) ?? str(input['content']);
    if (!id || !to || !body) continue;
    sends.push({
      toolUseId: id,
      ts: entry.timestamp as string,
      toName: to,
      summary: str(input['summary']),
      body,
      skill: str(entry.attributionSkill),
    });
  }
  return sends;
}

export type Dispatch = {
  toolUseId: string;
  ts: string;
  subagentType: string;
  description: string | null;
  prompt: string;
  skill: string | null;
};

/**
 * An `Agent` call: a Slot spawning a subagent.
 *
 * The subagent type is the whole point of the row -- a `security-reviewer` run
 * is a review, an `Explore` run is a search -- so a spawn with no type is not
 * a dispatch worth recording.
 */
export function parseDispatches(line: string): Dispatch[] {
  const found = toolUses(line, '"subagent_type"');
  if (!found) return [];
  const { entry, blocks } = found;
  const out: Dispatch[] = [];

  for (const block of blocks) {
    if (typeof block.name !== 'string' || !DISPATCH_TOOLS.has(block.name)) continue;
    const id = str(block.id);
    const input = block.input ?? {};
    const type = str(input['subagent_type']);
    const prompt = str(input['prompt']);
    if (!id || !type || !prompt) continue;
    out.push({
      toolUseId: id,
      ts: entry.timestamp as string,
      subagentType: type,
      description: str(input['description']),
      prompt,
      skill: str(entry.attributionSkill),
    });
  }
  return out;
}

export type SendOutcome = {
  toolUseId: string;
  /** Null on a failed send: nothing was delivered, so nothing was identified. */
  msgId: string | null;
  delivered: boolean;
  /** The refusal or transport error, when there was one. */
  error: string | null;
};

export type DispatchOutcome = {
  toolUseId: string;
  /** Names the nested transcript the subagent writes: `agent-<agentId>.jsonl`. */
  agentId: string | null;
  model: string | null;
  status: string | null;
};

type ResultLine = {
  type?: unknown;
  toolUseResult?: Record<string, unknown>;
  message?: { content?: unknown };
};

/** The `tool_use_id` a result line answers, which is not stored at top level. */
function resultToolUseId(entry: ResultLine): string | null {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return null;
  for (const b of content) {
    if (typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tool_result') {
      return str((b as { tool_use_id?: unknown }).tool_use_id);
    }
  }
  return null;
}

/**
 * What came back from a send: the `msg_id` that identifies the message
 * everywhere else, or the reason it never left.
 *
 * A failure is as worth recording as a success. The one in the Commander
 * corpus is a peer that had restarted, leaving the sender addressing a stale
 * pipe -- an agent that believes it has handed off work and has not.
 */
export function parseSendOutcome(line: string): SendOutcome | null {
  if (!line.includes('"msg_id"') && !line.includes('"Failed to send')) return null;
  let entry: ResultLine;
  try {
    entry = JSON.parse(line) as ResultLine;
  } catch {
    return null;
  }
  if (entry.type !== 'user') return null;
  const result = entry.toolUseResult;
  if (!result || typeof result !== 'object') return null;
  if (!('msg_id' in result) && result['success'] !== false) return null;

  const id = resultToolUseId(entry);
  if (!id) return null;
  const delivered = result['success'] === true;
  return {
    toolUseId: id,
    msgId: str(result['msg_id']),
    delivered,
    error: delivered ? null : str(result['message']),
  };
}

/** What came back from a dispatch: which subagent ran, and under what model. */
export function parseDispatchOutcome(line: string): DispatchOutcome | null {
  if (!line.includes('"agentId"')) return null;
  let entry: ResultLine;
  try {
    entry = JSON.parse(line) as ResultLine;
  } catch {
    return null;
  }
  if (entry.type !== 'user') return null;
  const result = entry.toolUseResult;
  if (!result || typeof result !== 'object' || !('agentId' in result)) return null;

  const id = resultToolUseId(entry);
  if (!id) return null;
  return {
    toolUseId: id,
    agentId: str(result['agentId']),
    model: str(result['resolvedModel']),
    status: str(result['status']),
  };
}

export type PeerReceive = {
  /** The transcript line's own uuid, which is what makes re-reading idempotent. */
  uuid: string;
  ts: string;
  msgId: string;
  /** The sender's declared name, as it named itself. Not a Slot. */
  fromName: string | null;
  fromMode: string | null;
  body: string;
  /** The branch the recipient was on, which sometimes names the Task directly. */
  gitBranch: string | null;
};

/**
 * The inbound half of a peer message.
 *
 * Claude Code delivers this as a `user` line wrapped in a long advisory about
 * treating a peer's request with care, but it also attaches the message in a
 * structured `origin` block. Reading that, rather than unwrapping the prose,
 * is what keeps this from breaking when the advisory's wording changes.
 *
 * These lines are `isMeta`, so `parseEvent` already declines to count them as
 * a human typing. They are not Takeovers and must never become them.
 */
export function parsePeerReceive(line: string): PeerReceive | null {
  if (!line.includes('"peer"')) return null;
  let entry: {
    type?: unknown;
    uuid?: unknown;
    timestamp?: unknown;
    gitBranch?: unknown;
    origin?: Record<string, unknown>;
  };
  try {
    entry = JSON.parse(line) as typeof entry;
  } catch {
    return null;
  }
  if (entry.type !== 'user') return null;
  const origin = entry.origin;
  if (!origin || origin['kind'] !== 'peer') return null;

  const uuid = str(entry.uuid);
  const msgId = str(origin['msg_id']);
  const body = str(origin['body']);
  if (!uuid || !msgId || !body || typeof entry.timestamp !== 'string') return null;

  return {
    uuid,
    ts: entry.timestamp,
    msgId,
    fromName: str(origin['name']),
    fromMode: str(origin['fromMode']),
    body,
    gitBranch: str(entry.gitBranch),
  };
}
