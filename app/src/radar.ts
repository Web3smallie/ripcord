import type { Address } from 'viem';
import { transferEvent } from './abi';
import { publicClient } from './data';

/** One ERC-20 Transfer, reduced to what the balance maths needs. */
export type TransferLog = { from: Address; to: Address; value: bigint };

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export type Reconstruction = {
  /** lower-case address -> balance, from replaying every transfer. The zero address is left out. */
  balances: Map<string, bigint>;
  /** Sum of all balances (minted minus burned). Equals totalSupply() only if no log is missing or doubled. */
  supply: bigint;
  /** Addresses whose replayed balance is below zero. Only possible if a log is missing. */
  negative: string[];
};

/** Replays every Transfer to rebuild who holds what. Order does not matter, only the final sums. */
export function reconstructBalances(logs: TransferLog[]): Reconstruction {
  const balances = new Map<string, bigint>();
  const add = (addr: string, delta: bigint) => {
    const key = addr.toLowerCase();
    if (key === ZERO_ADDRESS) return;
    balances.set(key, (balances.get(key) ?? 0n) + delta);
  };
  for (const t of logs) {
    add(t.from, -t.value);
    add(t.to, t.value);
  }
  let supply = 0n;
  const negative: string[] = [];
  for (const [addr, bal] of balances) {
    supply += bal;
    if (bal < 0n) negative.push(addr);
  }
  return { balances, supply, negative };
}

/** A Transfer log as the chain returns it, with the fields needed to spot duplicates. */
export type RawTransfer = TransferLog & { transactionHash: string | null; logIndex: number | null; removed?: boolean };

/** Reads the Transfer logs of one token between two blocks (inclusive). */
export type RangeFetcher = (token: Address, from: bigint, to: bigint) => Promise<RawTransfer[]>;

export const chainFetcher: RangeFetcher = async (token, from, to) => {
  const logs = await publicClient.getLogs({ address: token, event: transferEvent, fromBlock: from, toBlock: to });
  return logs.map((l) => ({
    from: l.args.from!,
    to: l.args.to!,
    value: l.args.value!,
    transactionHash: l.transactionHash,
    logIndex: l.logIndex,
    removed: l.removed,
  }));
};

const START_SPAN = 2_000_000n; // the RPC returned 3.4M blocks of RIPC transfers in one call, so start generous
const MIN_SPAN = 25_000n;

/**
 * Every Transfer of `token` from `fromBlock` to `toBlock`, read in consecutive block ranges that never overlap.
 * If the RPC refuses a range, it is halved and retried. If it still fails at the smallest range, this throws,
 * so the caller can show "Data incomplete" instead of numbers built on missing history.
 */
export async function fetchTransfers(
  token: Address,
  fromBlock: bigint,
  toBlock: bigint,
  fetchRange: RangeFetcher = chainFetcher,
  opts: { startSpan?: bigint; minSpan?: bigint } = {}
): Promise<TransferLog[]> {
  const minSpan = opts.minSpan ?? MIN_SPAN;
  let span = opts.startSpan ?? START_SPAN;
  const seen = new Set<string>();
  const out: TransferLog[] = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = start + span - 1n > toBlock ? toBlock : start + span - 1n;
    let logs: RawTransfer[];
    try {
      logs = await fetchRange(token, start, end);
    } catch (e) {
      if (span <= minSpan) throw e;
      span = span / 2n < minSpan ? minSpan : span / 2n;
      continue; // same start, smaller range
    }
    for (const l of logs) {
      if (l.removed) continue;
      const key = `${l.transactionHash}:${l.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from: l.from, to: l.to, value: l.value });
    }
    start = end + 1n;
  }
  return out;
}