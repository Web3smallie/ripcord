import { parseAbi, type Address } from 'viem';
import { executorAbi, transferEvent } from './abi';
import { ADDR } from './config';
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

/** What the chain itself says at one block, to compare against the replayed history. */
export type ChainFacts = {
  /** The block every value below was read at. Must be the last block the history scan covered. */
  block: bigint;
  /** totalSupply() of the token. */
  totalSupply: bigint;
  /** The pool manager's vault, which holds the pool's unsold tokens. */
  vault: Address;
  /** balanceOf at `block` for every address that will be shown, including the vault. */
  balances: Map<string, bigint>;
};

export type Integrity = { ok: boolean; problems: string[] };

/**
 * Decides whether the replayed history can be trusted. Any problem means the Radar must show
 * "Data incomplete" and hide every figure, because a number built on missing history looks
 * exactly as confident as a correct one.
 */
export function checkIntegrity(rec: Reconstruction, facts: ChainFacts, scannedTo: bigint): Integrity {
  const problems: string[] = [];
  if (facts.block !== scannedTo) {
    problems.push(`chain values were read at block ${facts.block} but history ends at block ${scannedTo}`);
  }
  if (rec.negative.length > 0) {
    problems.push(`${rec.negative.length} address(es) replay below zero, so some history is missing`);
  }
  if (rec.supply !== facts.totalSupply) {
    problems.push(`replayed supply ${rec.supply} does not equal totalSupply() ${facts.totalSupply}`);
  }
  const onChain = new Map<string, bigint>();
  for (const [addr, bal] of facts.balances) onChain.set(addr.toLowerCase(), bal);
  if (!onChain.has(facts.vault.toLowerCase())) {
    problems.push('the pool vault balance was not read');
  }
  for (const [addr, bal] of onChain) {
    const replayed = rec.balances.get(addr) ?? 0n;
    if (replayed !== bal) problems.push(`${addr}: replayed ${replayed} but balanceOf is ${bal}`);
  }
  return { ok: problems.length === 0, problems };
}

const radarAbi = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);
const vaultAbi = parseAbi(['function vault() view returns (address)']);

/**
 * Reads, at one fixed block: the token's totalSupply, the pool vault, and balanceOf for the vault and every
 * address in `holders`. Throws if any read fails, so a partial answer is never mistaken for a complete one.
 */
export async function readChainFacts(
  token: Address,
  block: bigint,
  holders: Address[],
  client: typeof publicClient = publicClient
): Promise<ChainFacts> {
  const [key] = await client.readContract({
    address: ADDR.executor,
    abi: executorAbi,
    functionName: 'poolFor',
    args: [token],
    blockNumber: block,
  });
  const vault = await client.readContract({
    address: key.poolManager,
    abi: vaultAbi,
    functionName: 'vault',
    blockNumber: block,
  });
  const totalSupply = await client.readContract({
    address: token,
    abi: radarAbi,
    functionName: 'totalSupply',
    blockNumber: block,
  });
  const wanted = [...new Set([vault, ...holders].map((a) => a.toLowerCase()))] as Address[];
  const results = await client.multicall({
    allowFailure: false,
    blockNumber: block,
    contracts: wanted.map((a) => ({ address: token, abi: radarAbi, functionName: 'balanceOf' as const, args: [a] as const })),
  });
  const balances = new Map<string, bigint>();
  wanted.forEach((a, i) => balances.set(a, results[i]));
  return { block, totalSupply, vault, balances };
}

/** For each address: true if it has code (a contract), false if it is a plain wallet. Throws on any failed read. */
export async function readContractFlags(
  addrs: Address[],
  block: bigint,
  client: typeof publicClient = publicClient
): Promise<Map<string, boolean>> {
  const codes = await Promise.all(addrs.map((a) => client.getCode({ address: a, blockNumber: block })));
  const out = new Map<string, boolean>();
  addrs.forEach((a, i) => out.set(a.toLowerCase(), codes[i] !== undefined && codes[i] !== '0x'));
  return out;
}