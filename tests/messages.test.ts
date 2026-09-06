import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  parseDispatchOutcome,
  parseDispatches,
  parsePeerReceive,
  parsePeerSends,
  parseSendOutcome,
} from '../src/sources/messages.ts';
import { parseEvent } from '../src/sources/transcripts.ts';

/**
 * Fixtures here are synthetic but shaped exactly as the corpus writes them,
 * because every field these parsers read is one Claude Code chose rather than
 * one this repo controls. A fixture that drifts from the real shape would let
 * a parser pass here and read nothing in production.
 */

const line = (o: unknown): string => JSON.stringify(o);

const assistant = (blocks: unknown[], extra: Record<string, unknown> = {}) =>
  line({
    type: 'assistant',
    uuid: 'u1',
    timestamp: '2026-09-02T04:16:12.166Z',
    sessionId: 's1',
    attributionSkill: 'ceo',
    message: { content: blocks, usage: { input_tokens: 12, output_tokens: 3 } },
    ...extra,
  });

const result = (toolUseId: string, toolUseResult: unknown) =>
  line({
    type: 'user',
    uuid: 'u2',
    timestamp: '2026-09-02T04:16:14.207Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [] }] },
    toolUseResult,
  });

const sendBlock = (input: Record<string, unknown>, id = 'toolu_1') => ({
  type: 'tool_use',
  id,
  name: 'SendMessage',
  input,
});

describe('peer sends', () => {
  test('a SendMessage call yields its recipient, summary and full body', () => {
    const sends = parsePeerSends(
      assistant([sendBlock({ to: 'agenta-ff', summary: '/finish - PR #280 landed', message: 'Retire the branch.' })]),
    );
    assert.equal(sends.length, 1);
    assert.equal(sends[0]!.toolUseId, 'toolu_1');
    assert.equal(sends[0]!.toName, 'agenta-ff');
    assert.equal(sends[0]!.summary, '/finish - PR #280 landed');
    assert.equal(sends[0]!.body, 'Retire the branch.');
    assert.equal(sends[0]!.skill, 'ceo');
  });

  test('the truncated recipient/content echo is only a fallback', () => {
    // Claude Code writes `recipient` and `content` beside `to` and `message`,
    // with `content` cut short. Preferring them would silently store a body
    // with its tail replaced by an ellipsis.
    const sends = parsePeerSends(
      assistant([
        sendBlock({
          to: 'ceo-cc',
          message: 'The whole message, every word of it.',
          recipient: 'ceo-cc',
          content: 'The whole message, every w…',
        }),
      ]),
    );
    assert.equal(sends[0]!.body, 'The whole message, every word of it.');
  });

  test('several sends on one line are all returned', () => {
    const sends = parsePeerSends(
      assistant([
        sendBlock({ to: 'agenta-ff', message: 'one' }, 'toolu_a'),
        sendBlock({ to: 'agentb-cd', message: 'two' }, 'toolu_b'),
      ]),
    );
    assert.deepEqual(
      sends.map((s) => [s.toolUseId, s.toName]),
      [
        ['toolu_a', 'agenta-ff'],
        ['toolu_b', 'agentb-cd'],
      ],
    );
  });

  test('lines that are not sends are declined without parsing', () => {
    assert.deepEqual(parsePeerSends(assistant([{ type: 'text', text: 'thinking about SendMessage' }])), []);
    assert.deepEqual(parsePeerSends('not json at all'), []);
    assert.deepEqual(parsePeerSends(line({ type: 'user', message: { content: 'SendMessage' } })), []);
  });
});

describe('send outcomes', () => {
  test('a delivered send yields the msg_id that identifies it everywhere else', () => {
    const outcome = parseSendOutcome(
      result('toolu_1', { success: true, message: 'sent', msg_id: '4bf3e010-7898-4266-9009-8c398239ab65' }),
    );
    assert.equal(outcome?.toolUseId, 'toolu_1');
    assert.equal(outcome?.msgId, '4bf3e010-7898-4266-9009-8c398239ab65');
    assert.equal(outcome?.delivered, true);
    assert.equal(outcome?.error, null);
  });

  test('a failed send is recorded as a failure, not dropped', () => {
    // An agent that believes it handed off work and did not is the whole
    // reason this row exists. Losing it would make the fleet look healthier
    // than it was.
    const outcome = parseSendOutcome(
      result('toolu_2', { success: false, message: 'Failed to send to uds:...: ENOINBOX: no-key' }),
    );
    assert.equal(outcome?.delivered, false);
    assert.equal(outcome?.msgId, null);
    assert.match(outcome?.error ?? '', /ENOINBOX/);
  });

  test('an unrelated tool result is not mistaken for a send outcome', () => {
    assert.equal(parseSendOutcome(result('toolu_3', { stdout: 'ok' })), null);
  });
});

describe('dispatches', () => {
  const dispatchBlock = (input: Record<string, unknown>, name = 'Agent') => ({
    type: 'tool_use',
    id: 'toolu_d',
    name,
    input,
  });

  test('a subagent spawn yields its type and the prompt it was given', () => {
    const [d] = parseDispatches(
      assistant([
        dispatchBlock({
          subagent_type: 'security-reviewer',
          description: 'Review PR #248',
          prompt: 'Review the diff for injection risk.',
        }),
      ]),
    );
    assert.equal(d?.subagentType, 'security-reviewer');
    assert.equal(d?.description, 'Review PR #248');
    assert.equal(d?.prompt, 'Review the diff for injection risk.');
  });

  test('both names the spawning tool has had are read', () => {
    // The tool was `Task` and is now `Agent`. A corpus spans the rename, so
    // reading only the current name would blank out the older half of it.
    for (const name of ['Agent', 'Task']) {
      const [d] = parseDispatches(assistant([dispatchBlock({ subagent_type: 'spec-reviewer', prompt: 'p' }, name)]));
      assert.equal(d?.subagentType, 'spec-reviewer', `tool named ${name}`);
    }
  });

  test('the outcome names the nested transcript the subagent wrote', () => {
    const outcome = parseDispatchOutcome(
      result('toolu_d', {
        isAsync: true,
        status: 'async_launched',
        agentId: 'a542009aa21a6b29e',
        resolvedModel: 'claude-opus-5[1m]',
      }),
    );
    assert.equal(outcome?.agentId, 'a542009aa21a6b29e');
    assert.equal(outcome?.model, 'claude-opus-5[1m]');
    assert.equal(outcome?.status, 'async_launched');
  });
});

describe('peer receives', () => {
  const inbound = (origin: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    line({
      type: 'user',
      uuid: 'r1',
      timestamp: '2026-09-02T04:16:13.979Z',
      isMeta: true,
      promptSource: 'system',
      gitBranch: 'agent/a/redesign-the-login-hero',
      message: { role: 'user', content: 'Another Claude session sent a message:\n<cross-session-message ...>' },
      origin,
      ...extra,
    });

  test('the structured origin block is read, not the advisory prose around it', () => {
    // The prose wrapper is Claude Code's own guidance to the recipient and its
    // wording is not ours to depend on. The origin block is.
    const r = parsePeerReceive(
      inbound({
        kind: 'peer',
        from: 'uds:\\\\.\\pipe\\LOCAL\\cc-msg-66b1',
        msg_id: '4bf3e010-7898-4266-9009-8c398239ab65',
        name: 'ceo-cc',
        fromMode: 'prompting',
        body: '/finish\n\nYour task has landed.',
      }),
    );
    assert.equal(r?.msgId, '4bf3e010-7898-4266-9009-8c398239ab65');
    assert.equal(r?.fromName, 'ceo-cc');
    assert.equal(r?.fromMode, 'prompting');
    assert.equal(r?.body, '/finish\n\nYour task has landed.');
    assert.equal(r?.gitBranch, 'agent/a/redesign-the-login-hero');
  });

  test('an origin that is not a peer is not a peer message', () => {
    assert.equal(parsePeerReceive(inbound({ kind: 'hook', msg_id: 'x', body: 'y' })), null);
  });

  test('an inbound peer message is never counted as a human takeover', () => {
    // These lines are long, user-role, and typed by nobody. Before `isMeta`
    // was honoured, machine-written user lines put a Takeover on almost every
    // Task; a peer message must not reopen that hole.
    const raw = inbound({
      kind: 'peer',
      msg_id: 'm1',
      name: 'ceo-cc',
      body: 'x'.repeat(500),
    });
    assert.equal(parseEvent(raw), null);
    assert.ok(parsePeerReceive(raw));
  });
});
