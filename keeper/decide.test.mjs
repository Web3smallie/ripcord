import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideAction,
  backoffElapsed,
  extractErrorName,
  classifyFailure,
  unfillableBackoffMs,
  recordFailure,
  clearedSendState,
  readBackoffMs,
  sendGated,
  readGated,
  TRANSIENT_BACKOFF_MS,
} from './decide.mjs';

const base = { active: true, stopHit: false, creatorTripped: false, armedReady: false, holdersTripped: false };
const ctx = (over = {}) => ({ nowMs: 100_000, lastArmMs: 0, armCooldownMs: 11_000, ...over });

test('inactive orders are dropped', () => {
  assert.deepEqual(decideAction({ ...base, active: false }, ctx()), { action: 'remove' });
});

test('nothing tripped means wait', () => {
  assert.deepEqual(decideAction(base, ctx()), { action: 'wait' });
});

test('creator guard executes immediately, no arming', () => {
  assert.deepEqual(decideAction({ ...base, creatorTripped: true }, ctx()), { action: 'execute', trigger: 'creator' });
});

test('holder watchlist executes immediately, no arming', () => {
  assert.deepEqual(decideAction({ ...base, holdersTripped: true }, ctx()), { action: 'execute', trigger: 'holders' });
});

test('creator guard wins over a stop that is also hit', () => {
  const s = { ...base, creatorTripped: true, stopHit: true, armedReady: true };
  assert.equal(decideAction(s, ctx()).trigger, 'creator');
});

test('stop hit but not armed: arm first', () => {
  assert.deepEqual(decideAction({ ...base, stopHit: true }, ctx()), { action: 'arm', trigger: 'stop' });
});

test('stop hit, armed and confirmed: execute', () => {
  assert.deepEqual(
    decideAction({ ...base, stopHit: true, armedReady: true }, ctx()),
    { action: 'execute', trigger: 'stop' }
  );
});

test('stop hit, we armed a moment ago and it is not confirmed yet: wait', () => {
  assert.deepEqual(decideAction({ ...base, stopHit: true }, ctx({ lastArmMs: 95_000 })), { action: 'wait' });
});

test('stop hit, our last arming has expired: arm again', () => {
  assert.deepEqual(decideAction({ ...base, stopHit: true }, ctx({ lastArmMs: 80_000 })), { action: 'arm', trigger: 'stop' });
});

test('price recovered: wait, never execute', () => {
  assert.deepEqual(decideAction({ ...base, stopHit: false, armedReady: false }, ctx()), { action: 'wait' });
});

test('backoff', () => {
  assert.equal(backoffElapsed(10_000, 5_000, 30_000), false);
  assert.equal(backoffElapsed(40_000, 5_000, 30_000), true);
});

test('extractErrorName finds decoded names wherever viem nested them', () => {
  assert.equal(extractErrorName({ errorName: 'NothingToSell' }), 'NothingToSell');
  assert.equal(extractErrorName({ data: { errorName: 'SlippageExceeded' } }), 'SlippageExceeded');
  assert.equal(extractErrorName({ cause: { errorName: 'NotTriggered' } }), 'NotTriggered');
  assert.equal(extractErrorName({ cause: { data: { errorName: 'Expired' } } }), 'Expired');
  assert.equal(extractErrorName({ cause: { cause: { errorName: 'Deep' } } }), 'Deep');
});

test('extractErrorName returns null without a decoded name', () => {
  assert.equal(extractErrorName(null), null);
  assert.equal(extractErrorName(undefined), null);
  assert.equal(extractErrorName('boom'), null);
  assert.equal(extractErrorName(42), null);
  assert.equal(extractErrorName({}), null);
  assert.equal(extractErrorName({ shortMessage: 'HTTP request failed', status: 429 }), null);
  assert.equal(extractErrorName({ data: {} }), null);
  const cycle = {};
  cycle.cause = cycle;
  assert.equal(extractErrorName(cycle), null); // cycles terminate via the depth cap
});

test('recognized unfillable errors escalate', () => {
  assert.equal(classifyFailure('NothingToSell'), 'unfillable');
  assert.equal(classifyFailure('SlippageExceeded'), 'unfillable');
});

test('everything else is transient, never escalates', () => {
  for (const name of ['NotTriggered', 'NotActive', 'Expired', 'NotArmable', 'Paused', 'BadParams', 'Reentrant']) {
    assert.equal(classifyFailure(name), 'transient');
  }
  assert.equal(classifyFailure(null), 'transient');
  assert.equal(classifyFailure(undefined), 'transient');
  assert.equal(classifyFailure(''), 'transient');
  assert.equal(classifyFailure('bogus'), 'transient');
  assert.equal(classifyFailure('nothingtosell'), 'transient'); // case-sensitive: no fuzzy match
  assert.equal(classifyFailure(42), 'transient');
});

test('unknown diagnosis shapes never escalate', () => {
  const timeout = { name: 'WaitForTransactionReceiptTimeoutError', shortMessage: 'timed out' };
  const rpcDown = { shortMessage: 'HTTP request failed', status: 503 };
  assert.equal(classifyFailure(extractErrorName(timeout)), 'transient');
  assert.equal(classifyFailure(extractErrorName(rpcDown)), 'transient');
});

test('unfillable backoff tiers escalate then cap at one hour', () => {
  assert.equal(unfillableBackoffMs(1), 15_000);
  assert.equal(unfillableBackoffMs(2), 15_000);
  assert.equal(unfillableBackoffMs(3), 300_000);
  assert.equal(unfillableBackoffMs(4), 3_600_000);
  assert.equal(unfillableBackoffMs(100), 3_600_000);
});

test('recordFailure escalates unfillable streaks and gates sends', () => {
  assert.deepEqual(recordFailure(0, 'unfillable'), { streak: 1, backoffMs: 15_000, lastClass: 'unfillable', simGate: true });
  assert.deepEqual(recordFailure(2, 'unfillable'), { streak: 3, backoffMs: 300_000, lastClass: 'unfillable', simGate: true });
  assert.deepEqual(recordFailure(9, 'unfillable'), { streak: 10, backoffMs: 3_600_000, lastClass: 'unfillable', simGate: true });
});

test('recordFailure keeps transient at 15s and preserves the streak', () => {
  assert.deepEqual(recordFailure(0, 'transient'), { streak: 0, backoffMs: 15_000, lastClass: 'transient', simGate: true });
  assert.deepEqual(recordFailure(2, 'transient'), { streak: 2, backoffMs: 15_000, lastClass: 'transient', simGate: true });
  assert.deepEqual(recordFailure(1, 'bogus'), { streak: 1, backoffMs: 15_000, lastClass: 'transient', simGate: true });
});

test('clearedSendState resets everything', () => {
  assert.deepEqual(clearedSendState(), { streak: 0, backoffMs: 0, lastClass: null, simGate: false });
});

test('transient backoff keeps the historical 15 seconds', () => {
  assert.equal(TRANSIENT_BACKOFF_MS, 15_000);
});

test('read backoff starts at 2s, doubles, caps at a minute', () => {
  assert.equal(readBackoffMs(0), 2_000);
  assert.equal(readBackoffMs(undefined), 2_000);
  assert.equal(readBackoffMs(2_000), 4_000);
  assert.equal(readBackoffMs(30_000), 60_000);
  assert.equal(readBackoffMs(60_000), 60_000);
  assert.equal(readBackoffMs(10 ** 9), 60_000);
});

test('fresh orders are ungated: no backoff before the first failure', () => {
  assert.equal(sendGated(100_000, 0, 0), false);
  assert.equal(readGated(100_000, 0, 0), false);
});

test('gates open again once the delay elapses', () => {
  assert.equal(sendGated(100_000, 100_000, 15_000), true);
  assert.equal(sendGated(115_001, 100_000, 15_000), false);
  assert.equal(readGated(100_000, 100_000, 2_000), true);
  assert.equal(readGated(102_001, 100_000, 2_000), false);
});

test('send backoff never blocks the read: gates are independent', () => {
  // an order deep in unfillable backoff is still re-read every poll
  assert.equal(sendGated(100_000, 100_000, 3_600_000), true);
  assert.equal(readGated(100_000, 0, 0), false);
  // and read trouble never blocks a send once the read succeeds
  assert.equal(readGated(100_000, 100_000, 60_000), true);
  assert.equal(sendGated(100_000, 0, 0), false);
});
