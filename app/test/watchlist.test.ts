// Unit tests for holder-watchlist sorting and validation.
// Pure checks mirroring RipcordExecutor._setWatchlist: no RPC, no fixtures.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Address } from 'viem';
import { sortWatchlist, validateWatchlist, presetForToken, MAX_WATCH } from '../src/watchlist';

const A = (s: string): Address => s as Address;
const W = (n: number): Address => A(`0x${n.toString(16).padStart(40, '0')}`);
const BUYER = W(99);

describe('watchlist', () => {
  it('sorts ascending and drops case-insensitive duplicates', () => {
    assert.deepEqual(sortWatchlist([W(3), W(1), W(3), W(2)]), [W(1), W(2), W(3)]);
    assert.deepEqual(sortWatchlist([A('0xAB00000000000000000000000000000000000000'), A('0xab00000000000000000000000000000000000000')]), [
      A('0xAB00000000000000000000000000000000000000'),
    ]);
  });

  it('accepts a clean selection', () => {
    assert.deepEqual(validateWatchlist([W(1), W(2)], BUYER), []);
  });

  it('rejects empty, oversized, duplicate, zero, and self selections', () => {
    assert.match(validateWatchlist([], BUYER)[0], /at least one/);
    const big = Array.from({ length: MAX_WATCH + 1 }, (_, i) => W(i + 1));
    assert.match(validateWatchlist(big, BUYER)[0], /at most 50/);
    assert.match(validateWatchlist([W(1), W(1)], BUYER)[0], /uplicate/);
    assert.match(validateWatchlist([W(0)], BUYER)[0], /zero address/);
    assert.match(validateWatchlist([W(1), BUYER], BUYER)[0], /own wallet/);
  });

  it('returns a preset only for its own token', () => {
    const preset = { token: W(7), addrs: [W(1), W(2)] };
    assert.deepEqual(presetForToken(preset, W(7)), [W(1), W(2)]);
    assert.deepEqual(presetForToken(preset, W(8)), []);
    assert.deepEqual(presetForToken(null, W(7)), []);
    assert.deepEqual(presetForToken({ token: A('0xAB00000000000000000000000000000000000000'), addrs: [W(1)] }, '0xab00000000000000000000000000000000000000'), [W(1)]);
  });
});
