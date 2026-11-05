// Unit tests for the Radar concentration summary.
// Pure derivation from an integrity-checked result: no RPC, no clock, no fixtures.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Address } from 'viem';
import { summarizeConcentration, PROVISIONAL_THRESHOLDS, type OkRadar } from '../src/concentration';

const T = (n: bigint): string => `0x${n.toString(16).padStart(40, '0')}` as string;
const A = (n: bigint): Address => T(n) as Address;

function holder(address: Address, balance: bigint, pctCirculating: number, pctTotal: number, isContract = false) {
  return { address, balance, pctCirculating, pctTotal, isContract };
}

// Concentrated: creator 500/800 circ (62.5%), pool 200/1000, three other holders.
function concentrated(): OkRadar {
  return {
    status: 'ok',
    token: A(9n),
    block: 123n,
    totalSupply: 1000n,
    poolBalance: 200n,
    poolPctTotal: 20,
    circulating: 800n,
    creator: holder(A(1n), 500n, 62.5, 50),
    creatorLaunchBuy: 600n,
    holders: [holder(A(2n), 200n, 25, 20), holder(A(3n), 50n, 6.25, 5, true), holder(A(4n), 20n, 2.5, 2)],
    moreHolders: 1,
    dust: { count: 2, balance: 10n },
    otherBalance: 30n,
    otherPctCirculating: 3.75,
  };
}

// Dispersed, creator empty: nothing breaches.
function dispersed(): OkRadar {
  return {
    status: 'ok',
    token: A(9n),
    block: 456n,
    totalSupply: 1000n,
    poolBalance: 100n,
    poolPctTotal: 10,
    circulating: 900n,
    creator: null,
    creatorLaunchBuy: 100n,
    holders: [holder(A(2n), 100n, 11.11, 10), holder(A(3n), 90n, 10, 9)],
    moreHolders: 0,
    dust: { count: 5, balance: 10n },
    otherBalance: 700n,
    otherPctCirculating: 77.78,
  };
}

describe('concentration summary', () => {
  it('ranks creator and holders together by balance', () => {
    const c = summarizeConcentration(concentrated());
    assert.deepEqual(
      c.ranked.map((r) => [r.rank, r.address, r.isCreator]),
      [
        [1, T(1n), true],
        [2, T(2n), false],
        [3, T(3n), false],
        [4, T(4n), false],
      ]
    );
    assert.equal(c.ranked[2].isContract, true);
  });

  it('sums top-5 and top-10 shares over whatever wallets exist', () => {
    const c = summarizeConcentration(concentrated());
    assert.equal(c.top5Pct, 62.5 + 25 + 6.25 + 2.5);
    assert.equal(c.top10Pct, 62.5 + 25 + 6.25 + 2.5);
    assert.equal(c.creatorPctCirculating, 62.5);
  });

  it('splits distribution into pool, creator, shown, further, and dust that sum to total', () => {
    const c = summarizeConcentration(concentrated());
    assert.deepEqual(c.distribution.map((d) => d.key), ['pool', 'creator', 'top', 'further', 'dust']);
    const sum = c.distribution.reduce((s, d) => s + d.balance, 0n);
    assert.equal(sum, 1000n);
    const further = c.distribution.find((d) => d.key === 'further')!;
    assert.equal(further.balance, 20n); // otherBalance minus dust
    assert.match(further.label, /\(1\)/);
  });

  it('fires provisional notes only when thresholds are crossed', () => {
    const hot = summarizeConcentration(concentrated());
    assert.deepEqual(
      hot.notes.map((n) => n.key),
      ['creator-high', 'top5-high', 'top10-high']
    );
    assert.ok(hot.notes.every((n) => n.breached));
    assert.ok(hot.notes[0].detail.includes(String(PROVISIONAL_THRESHOLDS.creatorHighPct)));

    const cool = summarizeConcentration(dispersed());
    assert.deepEqual(cool.notes.map((n) => n.key), ['creator-empty']);
    assert.equal(cool.notes[0].breached, false);
  });

  it('states its methodology with block and thresholds', () => {
    const c = summarizeConcentration(concentrated());
    assert.match(c.methodology, /block 123/);
    assert.match(c.methodology, /creator above 50%/);
  });
});
