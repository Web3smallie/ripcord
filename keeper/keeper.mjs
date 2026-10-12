// Ripcord keeper: watches Ripcord orders and executes them the moment a trigger trips.
// Anyone can run this: the executor contract sends proceeds to the order owner, never to the keeper.
import 'dotenv/config';
import http from 'node:http';
import {
  createPublicClient,
  createWalletClient,
  http as viemHttp,
  defineChain,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  encodeFunctionData,
  parseGwei,
  formatEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { decideAction, backoffElapsed } from './decide.mjs';

// ------------------------------------------------------------------ config

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

const RPC_URL = process.env.RPC_URL || 'https://testnet-rpc.elysium.kinetiq.xyz';
const CHAIN_ID = Number(process.env.CHAIN_ID || 99801);
const EXECUTOR = need('EXECUTOR');
let PRIVATE_KEY = need('KEEPER_PRIVATE_KEY').trim();
if (!PRIVATE_KEY.startsWith('0x')) PRIVATE_KEY = `0x${PRIVATE_KEY}`;
const START_BLOCK = BigInt(process.env.START_BLOCK || '6000000');
const POLL_MS = Number(process.env.POLL_MS || 1000);
const SYNC_MS = Number(process.env.SYNC_MS || 4000);
const PRIORITY_GWEI = process.env.PRIORITY_GWEI || '1';
const PORT = Number(process.env.PORT || 8080);
// FAST mode skips the pre-flight simulation and fixes the gas limit, so an exit needs only two network
// round trips (read nonce, send). A transaction that would revert just costs a tiny amount of gas here.
const FAST = process.env.FAST !== 'false';
const GAS_LIMIT = BigInt(process.env.GAS_LIMIT || '1500000');
const RECEIPT_POLL_MS = Number(process.env.RECEIPT_POLL_MS || 200);

const ARM_COOLDOWN_MS = 11_000; // the contract's arm window is 10 s
const RETRY_MS = 15_000; // wait this long before retrying an order whose execution would revert
const LOG_KEEP = 300;
const LOG_CHUNK = 199_999n; // blocks per getLogs request
const REORG_BUFFER = 20n;
const LOW_BALANCE_HYPE = 0.002;

// ------------------------------------------------------------------ abi and clients

const orderCreatedEvent = parseAbiItem(
  'event OrderCreated(uint256 indexed id, address indexed owner, address indexed token, uint128 amount, uint160 entrySqrt, uint160 stopSqrt, address creator, uint128 creatorFloor, uint40 expiry, uint16 slippageBps)'
);

const abi = parseAbi([
  'event OrderCreated(uint256 indexed id, address indexed owner, address indexed token, uint128 amount, uint160 entrySqrt, uint160 stopSqrt, address creator, uint128 creatorFloor, uint40 expiry, uint16 slippageBps)',
  'event Executed(uint256 indexed id, address indexed owner, uint8 trigger, uint256 tokensSold, uint256 quoteReceived, uint256 feePaid, uint160 sqrtPriceAtExit)',
  'function checkOrder(uint256 id) view returns (bool active, bool stopHit, bool creatorTripped, bool armedReady, bool holdersTripped)',
  'function arm(uint256 id)',
  'function execute(uint256 id) returns (uint256 received)',
]);

const chain = defineChain({
  id: CHAIN_ID,
  name: 'Elysium',
  nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const account = privateKeyToAccount(PRIVATE_KEY);
const publicClient = createPublicClient({ chain, transport: viemHttp(RPC_URL) });
const walletClient = createWalletClient({ account, chain, transport: viemHttp(RPC_URL) });

// ------------------------------------------------------------------ logging

const recent = [];
function log(event, data = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...data }, (_, v) =>
    typeof v === 'bigint' ? v.toString() : v
  );
  console.log(line);
  recent.push(JSON.parse(line));
  if (recent.length > LOG_KEEP) recent.shift();
}

function why(e) {
  const name = e?.cause?.data?.errorName || e?.data?.errorName;
  const msg = name || e?.shortMessage || e?.message || String(e);
  return String(msg).slice(0, 300);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ state

const orders = new Map(); // id (bigint) -> { id, owner, token, lastArmMs, lastFailMs, inflight }
const closed = new Set(); // ids we already saw finish
let lastSynced = START_BLOCK - 1n;
let lastTickAt = 0;
let balanceHype = null;

// ------------------------------------------------------------------ finding orders

async function syncOrders() {
  const latest = await publicClient.getBlockNumber();
  let from = lastSynced + 1n > REORG_BUFFER ? lastSynced + 1n - REORG_BUFFER : lastSynced + 1n;
  if (from < START_BLOCK) from = START_BLOCK;

  while (from <= latest) {
    const to = from + LOG_CHUNK < latest ? from + LOG_CHUNK : latest;
    const logs = await publicClient.getLogs({
      address: EXECUTOR,
      event: orderCreatedEvent,
      fromBlock: from,
      toBlock: to,
    });
    for (const l of logs) {
      const id = l.args.id;
      if (closed.has(id) || orders.has(id)) continue;
      orders.set(id, {
        id,
        owner: l.args.owner,
        token: l.args.token,
        lastArmMs: 0,
        lastFailMs: 0,
        inflight: false,
      });
      log('order_tracked', { id, owner: l.args.owner, token: l.args.token, block: l.blockNumber });
    }
    lastSynced = to;
    from = to + 1n;
  }
}

// ------------------------------------------------------------------ sending transactions

async function submit(request) {
  const gasPrice = await publicClient.getGasPrice();
  const priority = parseGwei(PRIORITY_GWEI);
  return walletClient.writeContract({
    ...request,
    maxPriorityFeePerGas: priority,
    maxFeePerGas: gasPrice * 2n + priority,
  });
}

// ---- fast path: sign locally with a cached gas price and a tracked nonce, then send
let cachedGasPrice = 0n;
async function refreshGasPrice() {
  cachedGasPrice = await publicClient.getGasPrice();
}
async function gasPriceLoop() {
  for (;;) {
    await sleep(2000);
    try {
      await refreshGasPrice();
    } catch (e) {
      log('gas_price_error', { reason: why(e) });
    }
  }
}

let nextNonce; // undefined means "ask the chain"
let sendChain = Promise.resolve();
function locked(fn) {
  const run = sendChain.then(fn, fn);
  sendChain = run.catch(() => {});
  return run;
}

function sendFast(functionName, id) {
  return locked(async () => {
    const data = encodeFunctionData({ abi, functionName, args: [id] });
    const priority = parseGwei(PRIORITY_GWEI);
    const onChain = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const nonce = nextNonce !== undefined && nextNonce > onChain ? nextNonce : onChain;
    const signed = await account.signTransaction({
      type: 'eip1559',
      chainId: CHAIN_ID,
      to: EXECUTOR,
      data,
      value: 0n,
      nonce,
      gas: GAS_LIMIT,
      maxPriorityFeePerGas: priority,
      maxFeePerGas: cachedGasPrice * 2n + priority,
    });
    try {
      const hash = await publicClient.sendRawTransaction({ serializedTransaction: signed });
      nextNonce = nonce + 1;
      return hash;
    } catch (e) {
      nextNonce = undefined; // re-sync with the chain on the next attempt
      throw e;
    }
  });
}

// After a failure, find out why (runs off the critical path).
async function diagnose(functionName, id) {
  try {
    await publicClient.simulateContract({ address: EXECUTOR, abi, functionName, args: [id], account });
    log('diagnose', { id, functionName, result: 'would succeed now (probably lost a race or conditions changed)' });
  } catch (e) {
    log('diagnose', { id, functionName, result: why(e) });
  }
}

async function sendTx(functionName, o) {
  if (FAST) return sendFast(functionName, o.id);
  const { request } = await publicClient.simulateContract({
    address: EXECUTOR,
    abi,
    functionName,
    args: [o.id],
    account,
  });
  return submit(request);
}

async function sendArm(o, decision, detectedAt) {
  log('trigger_detected', { id: o.id, trigger: decision.trigger, next: 'arm' });
  try {
    o.lastArmMs = Date.now();
    const hash = await sendTx('arm', o);
    log('arm_sent', { id: o.id, hash, msSinceDetect: Date.now() - detectedAt });
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: 60_000,
      pollingInterval: RECEIPT_POLL_MS,
    });
    log(receipt.status === 'success' ? 'arm_confirmed' : 'arm_failed', {
      id: o.id,
      hash,
      msSinceDetect: Date.now() - detectedAt,
    });
    if (receipt.status !== 'success') diagnose('arm', o.id);
  } catch (e) {
    o.lastFailMs = Date.now();
    log('arm_error', { id: o.id, reason: why(e) });
    diagnose('arm', o.id);
  }
}

async function sendExecute(o, decision, detectedAt) {
  log('trigger_detected', { id: o.id, trigger: decision.trigger, next: 'execute' });
  try {
    const hash = await sendTx('execute', o);
    log('execute_sent', { id: o.id, trigger: decision.trigger, hash, msSinceDetect: Date.now() - detectedAt });

    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: 60_000,
      pollingInterval: RECEIPT_POLL_MS,
    });
    const msTotal = Date.now() - detectedAt;
    if (receipt.status !== 'success') {
      o.lastFailMs = Date.now();
      log('execute_failed', { id: o.id, hash, msSinceDetect: msTotal });
      diagnose('execute', o.id);
      return;
    }
    const ev = parseEventLogs({ abi, logs: receipt.logs, eventName: 'Executed' }).find((x) => x.args.id === o.id);
    log('executed', {
      id: o.id,
      hash,
      trigger: decision.trigger,
      tokensSold: ev?.args.tokensSold,
      quoteReceived: ev?.args.quoteReceived,
      feePaid: ev?.args.feePaid,
      msDetectToConfirmed: msTotal,
    });
  } catch (e) {
    // most often: someone else executed first, nothing to sell, or the exit would miss its minimum output
    o.lastFailMs = Date.now();
    log('execute_error', { id: o.id, trigger: decision.trigger, reason: why(e) });
    diagnose('execute', o.id);
  }
}

// ------------------------------------------------------------------ main loops

async function handleOrder(o) {
  if (!backoffElapsed(Date.now(), o.lastFailMs, RETRY_MS)) return;

  let status;
  try {
    const r = await publicClient.readContract({
      address: EXECUTOR,
      abi,
      functionName: 'checkOrder',
      args: [o.id],
    });
    status = {
      active: r[0],
      stopHit: r[1],
      creatorTripped: r[2],
      armedReady: r[3],
      holdersTripped: r[4],
    };
  } catch (e) {
    log('check_failed', { id: o.id, reason: why(e) });
    return;
  }

  const decision = decideAction(status, {
    nowMs: Date.now(),
    lastArmMs: o.lastArmMs,
    armCooldownMs: ARM_COOLDOWN_MS,
  });

  if (decision.action === 'remove') {
    orders.delete(o.id);
    closed.add(o.id);
    log('order_closed', { id: o.id });
    return;
  }
  if (decision.action === 'wait') return;

  o.inflight = true;
  const detectedAt = Date.now();
  try {
    if (decision.action === 'arm') await sendArm(o, decision, detectedAt);
    else await sendExecute(o, decision, detectedAt);
  } finally {
    o.inflight = false;
  }
}

async function pollLoop() {
  for (;;) {
    const t0 = Date.now();
    try {
      const work = [];
      for (const o of orders.values()) if (!o.inflight) work.push(handleOrder(o));
      await Promise.all(work);
      lastTickAt = Date.now();
    } catch (e) {
      log('tick_error', { reason: why(e) });
    }
    await sleep(Math.max(0, POLL_MS - (Date.now() - t0)));
  }
}

async function syncLoop() {
  for (;;) {
    try {
      await syncOrders();
    } catch (e) {
      log('sync_error', { reason: why(e) });
    }
    await sleep(SYNC_MS);
  }
}

async function balanceLoop() {
  for (;;) {
    try {
      const wei = await publicClient.getBalance({ address: account.address });
      balanceHype = Number(formatEther(wei));
      if (balanceHype < LOW_BALANCE_HYPE) log('low_balance', { hype: balanceHype, keeper: account.address });
    } catch (e) {
      log('balance_error', { reason: why(e) });
    }
    await sleep(60_000);
  }
}

// ------------------------------------------------------------------ tiny status server (read-only, public data only)

function startServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url && req.url.startsWith('/status')) {
      res.end(
        JSON.stringify({
          keeper: account.address,
          executor: EXECUTOR,
          chainId: CHAIN_ID,
          tracked: [...orders.keys()].map(String),
          lastTickAt,
          balanceHype,
          recent: recent.slice(-100),
        })
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  server.listen(PORT, () => log('status_server', { port: PORT }));
}

// ------------------------------------------------------------------ start

async function main() {
  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) {
    throw new Error(`RPC reports chain ${chainId} but CHAIN_ID is ${CHAIN_ID}. Check RPC_URL and CHAIN_ID.`);
  }
  log('keeper_start', {
    keeper: account.address,
    executor: EXECUTOR,
    chainId,
    pollMs: POLL_MS,
    priorityGwei: PRIORITY_GWEI,
    fast: FAST,
    startBlock: START_BLOCK,
  });
  await refreshGasPrice();
  startServer();
  await syncOrders().catch((e) => log('sync_error', { reason: why(e) }));
  log('initial_sync_done', { tracked: orders.size });
  syncLoop();
  balanceLoop();
  gasPriceLoop();
  pollLoop();
}

process.on('unhandledRejection', (e) => log('unhandled_rejection', { reason: why(e) }));

main().catch((e) => {
  console.error(`Keeper failed to start: ${e.message}`);
  process.exit(1);
});
