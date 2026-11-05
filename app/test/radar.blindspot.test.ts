// Regression test for the Radar missing-transfer blind spot.
// Deterministic and network-free: every Radar dependency is injected through RadarDeps,
// so this never touches an RPC, the chain, or the real clock.
//
// Scenario (an 8M-token Transfer X -> Y missing from history):
//   X: true 1M,  replayed 9M   (missing outgoing inflates X, but not into the top 60)
//   Y: true 15M, replayed 7M   (missing incoming deflates a true top holder out of the top 60)
//   top-60 cutoff ~= 10M, so neither X nor Y is chain-verified, yet replayed supply still
//   matches totalSupply because a pure transfer is balance-neutral. See `checkIntegrity`
//   and `loadRadar` in ../src/radar.ts.
//
// The coverage gate must report this as `incomplete`: with X and Y outside the verified
// set, the ranking is untrustworthy. (Pre-fix, this wrongly returned `ok`.)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Address } from 'viem';
import { loadRadar, type ChainFacts, type RadarDeps, type TransferLog } from '../src/radar';

const TOKEN = '0x1111111111111111111111111111111111111111' as Address;
const VAULT = '0x2222222222222222222222222222222222222222' as Address;
const CREATOR = '0x3333333333333333333333333333333333333333' as Address;
const X = '0x4444444444444444444444444444444444444444' as Address;
const Y = '0x5555555555555555555555555555555555555555' as Address;
const MINT_FROM = '0x0000000000000000000000000000000000000000' as Address;

const M = (millions: number): bigint => BigInt(millions) * 1_000_000n * 10n ** 18n;
const BLOCK = 100n;

// 60 filler holders replayed at 10M+1 .. 10M+60 whole tokens: every one ranks above
// X (9M replayed) and Y (7M replayed), fixing the top-60 cutoff at ~10M.
const FILLERS: Address[] = Array.from(
  { length: 60 },
  (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}` as Address
);
const fillerReplayed = (i: number): bigint => M(10) + BigInt(i + 1) * 10n ** 18n;

// Replayed history, as the RPC would return it with the X -> Y transfer missing.
// (Mints from 0x0; the zero address is excluded from reconstruction by design.)
function replayedTransfers(): TransferLog[] {
  const logs: TransferLog[] = [
    { from: MINT_FROM, to: VAULT, value: M(600) },
    { from: MINT_FROM, to: CREATOR, value: M(20) },
    { from: MINT_FROM, to: X, value: M(9) }, // true 1M; inflated by the missing 8M send
    { from: MINT_FROM, to: Y, value: M(7) }, // true 15M; deflated by the missing 8M receipt
  ];
  FILLERS.forEach((f, i) => logs.push({ from: MINT_FROM, to: f, value: fillerReplayed(i) }));
  return logs;
}

const REPLAYED_SUPPLY = replayedTransfers().reduce((s, l) => s + l.value, 0n);

// True on-chain balances. X and Y differ from replayed; everything else matches.
const TRUE_BALANCES = new Map<string, bigint>([
  [VAULT.toLowerCase(), M(600)],
  [CREATOR.toLowerCase(), M(20)],
  [X.toLowerCase(), M(1)],
  [Y.toLowerCase(), M(15)],
  ...FILLERS.map((f, i): [string, bigint] => [f.toLowerCase(), fillerReplayed(i)]),
]);

describe('radar missing-transfer blind spot', () => {
  it('does not report ok when a true top holder falls outside the verified set', async () => {
    const verified: string[] = []; // every address Radar asks the chain about, lowercased
    const deps: RadarDeps = {
      latestBlock: async () => BLOCK,
      transfers: async () => replayedTransfers(),
      facts: async (_token, block, holders): Promise<ChainFacts> => {
        for (const h of holders) verified.push(h.toLowerCase());
        const balances = new Map<string, bigint>();
        for (const h of [VAULT, ...holders]) {
          const bal = TRUE_BALANCES.get(h.toLowerCase());
          assert.ok(bal !== undefined, `mock has no true balance for ${h}`);
          balances.set(h.toLowerCase(), bal);
        }
        return { block, totalSupply: REPLAYED_SUPPLY, vault: VAULT, balances };
      },
      flags: async (addrs) => new Map(addrs.map((a) => [a.toLowerCase(), false])),
    };

    const result = await loadRadar({ token: TOKEN, creator: CREATOR, block: 90n, devBuyTokens: M(5) }, deps);

    // The scenario holds only if both gap addresses escape chain verification.
    assert.ok(!verified.includes(X.toLowerCase()), 'precondition: X must fall outside the top-60 verified set');
    assert.ok(!verified.includes(Y.toLowerCase()), 'precondition: Y must fall outside the top-60 verified set');

    // The regression assertion: an untrustworthy ranking must be reported as incomplete,
    // with the unverified gap addresses identified.
    assert.equal(result.status, 'incomplete');
    if (result.status === 'incomplete') {
      const mentionsGap = result.problems.some(
        (p) => p.includes(X.toLowerCase()) || p.includes(Y.toLowerCase())
      );
      assert.ok(mentionsGap, `expected problems to identify X or Y, got: ${result.problems.join('; ')}`);
    }
  });
});

describe('radar coverage gate', () => {
  const A = `0x${'aa'.repeat(20)}` as Address;
  const B = `0x${'bb'.repeat(20)}` as Address;
  const C = `0x${'cc'.repeat(20)}` as Address;

  // Facts mock with an exact true-balance map; totalSupply always equals replayed supply.
  function mockDeps(logs: TransferLog[], truths: Map<string, bigint>): RadarDeps {
    const supply = logs.reduce((s, l) => s + l.value, 0n);
    return {
      latestBlock: async () => BLOCK,
      transfers: async () => logs,
      facts: async (_token, block, holders): Promise<ChainFacts> => {
        const balances = new Map<string, bigint>();
        for (const h of [VAULT, ...holders]) {
          const bal = truths.get(h.toLowerCase());
          assert.ok(bal !== undefined, `mock has no true balance for ${h}`);
          balances.set(h.toLowerCase(), bal);
        }
        return { block, totalSupply: supply, vault: VAULT, balances };
      },
      flags: async (addrs) => new Map(addrs.map((a) => [a.toLowerCase(), false])),
    };
  }

  const launch = { token: TOKEN, creator: CREATOR, block: 90n, devBuyTokens: M(5) };

  it('reports ok when every positive holder is chain-verified', async () => {
    const logs: TransferLog[] = [
      { from: MINT_FROM, to: VAULT, value: M(600) },
      { from: MINT_FROM, to: CREATOR, value: M(20) },
      { from: MINT_FROM, to: A, value: M(30) },
      { from: MINT_FROM, to: B, value: M(5) },
      { from: MINT_FROM, to: C, value: M(2) },
    ];
    const truths = new Map<string, bigint>(logs.map((l): [string, bigint] => [l.to.toLowerCase(), l.value]));
    const result = await loadRadar(launch, mockDeps(logs, truths));
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') {
      assert.equal(result.totalSupply, M(657));
      assert.equal(result.holders.length, 3);
      assert.equal(result.holders[0].address.toLowerCase(), A.toLowerCase());
      assert.equal(result.holders[0].balance, M(30));
      assert.equal(result.moreHolders, 0);
    }
  });

  it('reports incomplete when positive holders exceed the verified set', async () => {
    // 67 positive holders, all balances correct: vault + creator + 65 small holders.
    const small: Address[] = Array.from(
      { length: 65 },
      (_, i) => `0x${(0x100 + i).toString(16).padStart(40, '0')}` as Address
    );
    const logs: TransferLog[] = [
      { from: MINT_FROM, to: VAULT, value: M(600) },
      { from: MINT_FROM, to: CREATOR, value: M(20) },
      ...small.map((s, i): TransferLog => ({ from: MINT_FROM, to: s, value: M(1) + BigInt(i) * (10n ** 18n) })),
    ];
    const truths = new Map<string, bigint>(logs.map((l): [string, bigint] => [l.to.toLowerCase(), l.value]));
    const result = await loadRadar(launch, mockDeps(logs, truths));
    assert.equal(result.status, 'incomplete');
    if (result.status === 'incomplete') {
      assert.ok(
        result.problems.some((p) => p.includes('was not chain-verified')),
        `expected coverage problems, got: ${result.problems.join('; ')}`
      );
    }
  });
});
