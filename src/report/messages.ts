import type { DatabaseSync } from 'node:sqlite';
import type { Project } from '../store/projects.ts';
import { reconstructTasks, roleOf, type Role } from '../adapters/commander/tasks.ts';

/**
 * What the fleet said to itself.
 *
 * Two channels feed this. A peer message is one Slot addressing another and is
 * recorded twice -- once as the sender's `SendMessage`, once as the
 * recipient's inbound line, joined on a `msg_id` both quote. A dispatch is a
 * Slot spawning a subagent, recorded once, with the subagent's whole
 * transcript nested under the parent session.
 *
 * The send is the primary record, not the join. Claude Code compacts long
 * sessions, and an inbound peer line is among the first things it drops: in
 * the Commander corpus, 20% of provably delivered messages have no surviving
 * receive. Building the view on the edge rather than the send would silently
 * lose one message in five, all of them real.
 */

/** How confidently a message's recipient is known. Never hidden from the reader. */
export type Rung = 'confirmed' | 'attributed' | 'subagent' | 'unresolved';

export const RUNG_NOTE: Record<Rung, string> = {
  confirmed: 'Both halves observed, joined on the message id.',
  attributed: 'Delivered, but the recipient’s copy was compacted away. Slot resolved by name.',
  subagent: 'Addressed to a running subagent by its agent id.',
  unresolved: 'Delivered to a name never seen receiving. Recipient unknown.',
};

/** A destination column: another Slot, or a kind of subagent. */
export type Target = { key: string; label: string; kind: 'slot' | 'subagent' | 'unknown' };

export type Message = {
  id: string;
  ts: string;
  fromSlot: string;
  fromRole: Role;
  /** The sender's session identity, as it named itself. Changes on restart. */
  fromName: string | null;
  /** The name the sender addressed, verbatim. */
  toName: string;
  target: Target;
  rung: Rung;
  channel: 'peer' | 'dispatch';
  summary: string | null;
  body: string;
  /** Null until the delivery result was seen; false only on a real failure. */
  delivered: boolean | null;
  error: string | null;
  skill: string | null;
  /** The subagent's own transcript, for a dispatch that got that far. */
  agentId: string | null;
  prNumber: number | null;
  taskSlug: string | null;
  /**
   * How the Task was arrived at. `window` is the same evidence request
   * attribution uses; `mentioned` is the message naming a PR in its own text,
   * which is weaker and is labelled as such wherever it is shown.
   */
  taskSource: 'window' | 'mentioned' | null;
};

export type Cell = { from: string; to: string; count: number; rungs: Record<Rung, number> };

export type MessagesView = {
  project: Project;
  /** Sender rows, in fleet order rather than alphabetical. */
  senders: { slot: string; role: Role; sent: number }[];
  /** Peer columns, then subagent columns. Rendered as two groups. */
  peerTargets: Target[];
  agentTargets: Target[];
  cells: Map<string, Cell>;
  total: number;
  peers: number;
  dispatches: number;
  failures: number;
  unresolved: number;
  compacted: number;
  /** The selected cell's messages, newest first, when a cell is selected. */
  selected: { from: string; target: Target } | null;
  messages: Message[];
  /** How many the selection has in total, when more were found than shown. */
  selectedTotal: number;
};

export const cellKey = (from: string, to: string): string => `${from}\u0000${to}`;

/** Coder, then Integrator, then CEO, then anything else -- work before oversight. */
const ROLE_ORDER: Record<Role, number> = { Coder: 0, Integrator: 1, CEO: 2, Owner: 3 };

/** A send as the grid needs it: everything but the body. */
type SendRow = {
  tool_use_id: string;
  slot: string;
  ts: string;
  to_name: string;
  summary: string | null;
  skill: string | null;
  msg_id: string | null;
  delivered: number | null;
  error: string | null;
};

/** A dispatch as the grid needs it: everything but the prompt. */
type DispatchRow = {
  tool_use_id: string;
  slot: string;
  ts: string;
  subagent_type: string;
  description: string | null;
  skill: string | null;
  agent_id: string | null;
  status: string | null;
};

/**
 * The name-to-Slot dictionary, learned only from messages whose delivery was
 * observed on both ends.
 *
 * A peer name is a session identity, not a Slot: `agenta-ff` and `agenta-c9`
 * are the same worktree across a restart, and some agents name themselves
 * after their task instead. Deriving the Slot by pattern-matching the name
 * would guess wrong on exactly those. Learning it from confirmed deliveries
 * cannot: the Slot on that side is the directory the message actually landed
 * in. A name seen resolving to two different Slots is dropped rather than
 * decided between -- in the Commander corpus none ever has.
 */
export function learnNames(db: DatabaseSync, project: Project): Map<string, string> {
  return dictionaryFrom(loadSends(db, project), loadReceives(db, project));
}

/** The recipient side, keyed by the message id the sender also recorded. */
type ReceiveRow = { msg_id: string; slot: string; from_name: string | null };

function loadReceives(db: DatabaseSync, project: Project): Map<string, ReceiveRow> {
  const rows = db
    .prepare('SELECT msg_id, slot, from_name FROM agent_receive WHERE project_id = ?')
    .all(project.id) as unknown as ReceiveRow[];
  return new Map(rows.map((r) => [r.msg_id, r]));
}

/**
 * Sends and receives are joined here rather than in SQL.
 *
 * The obvious `LEFT JOIN ... ON r.msg_id = s.msg_id` reads well and is a trap:
 * SQLite declines the index on `msg_id` and re-scans every receive row for
 * every send, materialising each row's body as it goes. That is 2.2M wide-row
 * reads and about four seconds on the Commander corpus, on every page load.
 * Two indexed scans and a Map are milliseconds, and stop the page depending on
 * a query planner's choice.
 */
function dictionaryFrom(sends: SendRow[], receives: Map<string, ReceiveRow>): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const s of sends) {
    const r = s.msg_id === null ? undefined : receives.get(s.msg_id);
    if (!r) continue;
    const set = seen.get(s.to_name) ?? new Set<string>();
    set.add(r.slot);
    seen.set(s.to_name, set);
  }
  const dict = new Map<string, string>();
  for (const [name, slots] of seen) {
    if (slots.size === 1) dict.set(name, [...slots][0]!);
  }
  return dict;
}

/**
 * Every send, without its body.
 *
 * The grid needs one row per message and none of their text; the bodies are
 * 2.9MB and are fetched only for the handful a reader has actually selected.
 */
function loadSends(db: DatabaseSync, project: Project): SendRow[] {
  return db
    .prepare(
      `SELECT tool_use_id, slot, ts, to_name, summary, skill, msg_id, delivered, error
         FROM agent_send WHERE project_id = ? ORDER BY ts`,
    )
    .all(project.id) as unknown as SendRow[];
}

/**
 * Which Task a message belongs to.
 *
 * Attribution is by time window, exactly as request attribution is: a Slot
 * owns its Task from the previous one's close until its own. The recipient is
 * tried before the sender because most traffic is an instruction about the
 * recipient's Task -- a CEO has no Task window of its own, so a CEO->Coder
 * brief would otherwise land nowhere.
 */
function taskIndex(db: DatabaseSync, project: Project) {
  const bySlot = new Map<string, { start: number; end: number; pr: number; slug: string }[]>();
  if (project.adapter !== 'commander') return bySlot;

  for (const t of reconstructTasks(db, project)) {
    const list = bySlot.get(t.slot) ?? [];
    list.push({
      start: t.windowStart ? Date.parse(t.windowStart) : -Infinity,
      end: Date.parse(t.windowEnd),
      pr: t.prNumber,
      slug: t.taskSlug,
    });
    bySlot.set(t.slot, list);
  }
  return bySlot;
}

/** Every pull request number this project actually has, and what it was called. */
function knownPulls(db: DatabaseSync, project: Project): Map<number, string | null> {
  const rows = db
    .prepare('SELECT number, task_slug FROM pull_request WHERE project_id = ?')
    .all(project.id) as unknown as { number: number; task_slug: string | null }[];
  return new Map(rows.map((r) => [r.number, r.task_slug]));
}

const PR_MENTION = /(?:\bPR\s*#?|#)(\d{1,6})\b/gi;

/**
 * The pull request a message names in its own text.
 *
 * This exists because the Slot the fleet talks to most has almost no Task
 * windows of its own: an Integrator's work is promotions, so 394 CEO-to-
 * integrator messages fall outside every window while saying "Integrate PR
 * 385" in as many words. Only numbers this project actually has are accepted,
 * so a bare "#3" in prose cannot invent a Task -- and the result is always
 * labelled as a mention rather than passed off as a window.
 */
function mentionedPull(text: string, pulls: Map<number, string | null>): number | null {
  PR_MENTION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PR_MENTION.exec(text)) !== null) {
    const n = Number(m[1]);
    if (pulls.has(n)) return n;
  }
  return null;
}

function lookupTask(
  index: ReturnType<typeof taskIndex>,
  slot: string | null,
  at: number,
): { pr: number; slug: string } | null {
  if (!slot) return null;
  for (const w of index.get(slot) ?? []) {
    if (at >= w.start && at <= w.end) return { pr: w.pr, slug: w.slug };
  }
  return null;
}

/**
 * Every message the fleet sent, resolved as far as the evidence allows.
 *
 * `select` narrows the returned list to one cell of the grid; the grid itself
 * is always counted over everything, so selecting never changes the totals a
 * reader is looking at.
 */
export function buildMessages(
  db: DatabaseSync,
  project: Project,
  select?: { from: string; to: string } | null,
  limit = 200,
): MessagesView {
  const tasks = taskIndex(db, project);
  const pulls = knownPulls(db, project);

  // A window is the stronger evidence, so it is tried first and a mention is
  // only ever a fallback -- never an override.
  const attribute = (slots: (string | null)[], at: number, text: string) => {
    for (const slot of slots) {
      const w = lookupTask(tasks, slot, at);
      if (w) return { pr: w.pr, slug: w.slug, source: 'window' as const };
    }
    const pr = mentionedPull(text, pulls);
    return pr === null ? null : { pr, slug: pulls.get(pr) ?? null, source: 'mentioned' as const };
  };

  // Which subagent kind an agent id was: how a message addressed to a running
  // subagent finds its column.
  const agentKind = new Map<string, string>();
  const dispatchRows = db
    .prepare(
      `SELECT tool_use_id, slot, ts, subagent_type, description, skill, agent_id, status
         FROM agent_dispatch WHERE project_id = ? ORDER BY ts`,
    )
    .all(project.id) as unknown as DispatchRow[];
  for (const d of dispatchRows) if (d.agent_id) agentKind.set(d.agent_id, d.subagent_type);

  const sendRows = loadSends(db, project);
  const receives = loadReceives(db, project);
  const dict = dictionaryFrom(sendRows, receives);

  const messages: Message[] = [];

  for (const s of sendRows) {
    const received = s.msg_id === null ? undefined : receives.get(s.msg_id);
    let target: Target;
    let rung: Rung;
    if (received) {
      target = { key: received.slot, label: received.slot, kind: 'slot' };
      rung = 'confirmed';
    } else if (dict.has(s.to_name)) {
      const slot = dict.get(s.to_name)!;
      target = { key: slot, label: slot, kind: 'slot' };
      rung = 'attributed';
    } else if (agentKind.has(s.to_name)) {
      const kind = agentKind.get(s.to_name)!;
      target = { key: `agent:${kind}`, label: kind, kind: 'subagent' };
      rung = 'subagent';
    } else {
      target = { key: 'unknown', label: 'unresolved', kind: 'unknown' };
      rung = 'unresolved';
    }

    // Bodies are deliberately absent here and filled in for the selection
    // only, so the grid never pays for 4MB of text nobody asked to read.
    messages.push({
      id: s.tool_use_id,
      ts: s.ts,
      fromSlot: s.slot,
      fromRole: roleOf(s.slot),
      fromName: received?.from_name ?? null,
      toName: s.to_name,
      target,
      rung,
      channel: 'peer',
      summary: s.summary,
      body: '',
      delivered: s.delivered === null ? null : s.delivered === 1,
      error: s.error,
      skill: s.skill,
      agentId: null,
      prNumber: null,
      taskSlug: null,
      taskSource: null,
    });
  }

  for (const d of dispatchRows) {
    messages.push({
      id: d.tool_use_id,
      ts: d.ts,
      fromSlot: d.slot,
      fromRole: roleOf(d.slot),
      fromName: null,
      toName: d.agent_id ?? d.subagent_type,
      target: { key: `agent:${d.subagent_type}`, label: d.subagent_type, kind: 'subagent' },
      rung: 'subagent',
      channel: 'dispatch',
      summary: d.description,
      body: '',
      // A dispatch has no delivery handshake: it either launched or the tool
      // call errored, and an errored one never reaches this table.
      delivered: d.status === null ? null : true,
      error: null,
      skill: d.skill,
      agentId: d.agent_id,
      prNumber: null,
      taskSlug: null,
      taskSource: null,
    });
  }

  const cells = new Map<string, Cell>();
  const senders = new Map<string, number>();
  const peerKeys = new Set<string>();
  const agentKeys = new Map<string, string>();
  let failures = 0;
  let unresolved = 0;
  let compacted = 0;

  for (const m of messages) {
    senders.set(m.fromSlot, (senders.get(m.fromSlot) ?? 0) + 1);
    const key = cellKey(m.fromSlot, m.target.key);
    const cell =
      cells.get(key) ??
      { from: m.fromSlot, to: m.target.key, count: 0, rungs: { confirmed: 0, attributed: 0, subagent: 0, unresolved: 0 } };
    cell.count += 1;
    cell.rungs[m.rung] += 1;
    cells.set(key, cell);

    if (m.target.kind === 'subagent') agentKeys.set(m.target.key, m.target.label);
    else peerKeys.add(m.target.key);

    if (m.delivered === false) failures += 1;
    if (m.rung === 'unresolved') unresolved += 1;
    if (m.rung === 'attributed') compacted += 1;
  }

  // Columns carry every Slot that appears at either end, so a Slot that only
  // ever received still gets a column and its silence is visible.
  for (const slot of senders.keys()) peerKeys.add(slot);

  const orderSlot = (a: string, b: string) =>
    ROLE_ORDER[roleOf(a)] - ROLE_ORDER[roleOf(b)] || a.localeCompare(b);

  // Unresolved recipients are their own column at the end of the group, not a
  // Slot among the Slots: nothing was ever observed arriving there.
  peerKeys.delete('unknown');
  const peerTargets: Target[] = [...peerKeys]
    .sort(orderSlot)
    .map((k) => ({ key: k, label: k, kind: 'slot' as const }));
  if (unresolved > 0) peerTargets.push({ key: 'unknown', label: 'unresolved', kind: 'unknown' });
  const agentTargets: Target[] = [...agentKeys]
    .map(([key, label]) => ({ key, label, kind: 'subagent' as const }))
    .sort((a, b) => count(cells, b) - count(cells, a) || a.label.localeCompare(b.label));

  const senderRows = [...senders]
    .map(([slot, sent]) => ({ slot, role: roleOf(slot), sent }))
    .sort((a, b) => orderSlot(a.slot, b.slot));

  let selected: MessagesView['selected'] = null;
  let shown: Message[] = [];
  let selectedTotal = 0;
  if (select) {
    const all = messages.filter((m) => m.fromSlot === select.from && m.target.key === select.to);
    selectedTotal = all.length;
    if (all.length > 0) {
      selected = { from: select.from, target: all[0]!.target };
      shown = all.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit);
      fillBodies(db, project, shown);
      for (const m of shown) {
        const task = attribute(
          [m.target.kind === 'slot' ? m.target.key : null, m.fromSlot],
          Date.parse(m.ts),
          `${m.summary ?? ''}\n${m.body}`,
        );
        m.prNumber = task?.pr ?? null;
        m.taskSlug = task?.slug ?? null;
        m.taskSource = task?.source ?? null;
      }
    } else {
      selected = {
        from: select.from,
        target: [...peerTargets, ...agentTargets].find((t) => t.key === select.to) ?? {
          key: select.to,
          label: select.to,
          kind: 'unknown',
        },
      };
    }
  }

  return {
    project,
    senders: senderRows,
    peerTargets,
    agentTargets,
    cells,
    total: messages.length,
    peers: messages.filter((m) => m.channel === 'peer').length,
    dispatches: dispatchRows.length,
    failures,
    unresolved,
    compacted,
    selected,
    messages: shown,
    selectedTotal,
  };
}

/** Total volume into a column, which is what orders the subagent group. */
function count(cells: Map<string, Cell>, t: Target): number {
  let n = 0;
  for (const c of cells.values()) if (c.to === t.key) n += c.count;
  return n;
}

/**
 * Load the text of the messages actually being shown.
 *
 * Two statements rather than one per row: a page of 200 is 200 round trips
 * otherwise, and the bodies are the largest thing in the store.
 */
function fillBodies(db: DatabaseSync, project: Project, shown: Message[]): void {
  const ids = shown.map((m) => m.id);
  if (ids.length === 0) return;
  const holes = ids.map(() => '?').join(',');

  const bodies = new Map<string, string>();
  for (const r of db
    .prepare(`SELECT tool_use_id, body FROM agent_send WHERE project_id = ? AND tool_use_id IN (${holes})`)
    .all(project.id, ...ids) as unknown as { tool_use_id: string; body: string }[]) {
    bodies.set(r.tool_use_id, r.body);
  }
  for (const r of db
    .prepare(`SELECT tool_use_id, prompt FROM agent_dispatch WHERE project_id = ? AND tool_use_id IN (${holes})`)
    .all(project.id, ...ids) as unknown as { tool_use_id: string; prompt: string }[]) {
    bodies.set(r.tool_use_id, r.prompt);
  }
  for (const m of shown) m.body = bodies.get(m.id) ?? '';
}
