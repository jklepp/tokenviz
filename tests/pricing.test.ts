import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { leastSquares, type Observation } from '../src/pricing/solve.ts';

describe('leastSquares', () => {
  test('recovers exact coefficients from noise-free observations', () => {
    // cost = 2*a + 10*b + 0.2*c
    const truth = [2, 10, 0.2];
    const obs: Observation[] = [
      [1, 0.5, 100],
      [3, 2, 250],
      [0.2, 4, 900],
      [7, 1, 40],
      [5, 3, 600],
    ].map((x) => ({ x, y: x.reduce((s, xi, i) => s + xi * truth[i]!, 0) }));

    const solved = leastSquares(obs, 3);
    assert.ok(solved);
    for (const [i, expected] of truth.entries()) {
      assert.ok(Math.abs(solved[i]! - expected) < 1e-9, `term ${i}: ${solved[i]} != ${expected}`);
    }
  });

  test('is robust to noise, returning coefficients close to the truth', () => {
    const truth = [3, 15];
    const obs: Observation[] = Array.from({ length: 200 }, (_, i) => {
      const x = [1 + (i % 17), 0.5 + (i % 7) / 3];
      const clean = x.reduce((s, xi, k) => s + xi * truth[k]!, 0);
      // Deterministic pseudo-noise, about a percent.
      return { x, y: clean * (1 + 0.01 * Math.sin(i)) };
    });

    const solved = leastSquares(obs, 2);
    assert.ok(solved);
    assert.ok(Math.abs(solved[0]! - 3) < 0.1, `input rate drifted: ${solved[0]}`);
    assert.ok(Math.abs(solved[1]! - 15) < 0.1, `output rate drifted: ${solved[1]}`);
  });

  test('returns null rather than a wrong answer when there are too few observations', () => {
    assert.equal(leastSquares([{ x: [1, 2, 3], y: 6 }], 3), null);
  });

  test('returns null when columns do not vary independently', () => {
    // The second column is always twice the first: the system is singular, and
    // this is the case that made haiku unsolvable against real data.
    const obs: Observation[] = [1, 2, 3, 4, 5, 6].map((v) => ({ x: [v, v * 2], y: v * 7 }));
    assert.equal(leastSquares(obs, 2), null);
  });
});
