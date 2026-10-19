import { useEffect, useState } from 'react';
import { parseEventLogs, type Address } from 'viem';
import { ADDR } from './config';
import { erc20Abi, executorAbi, executorWriteAbi, hookAbi } from './abi';
import { publicClient } from './data';
import { formatTokens, shortAddr } from './format';
import type { TokenRow } from './useTokens';
import type { useWallet } from './wallet';

type Wallet = ReturnType<typeof useWallet>;
type Step = 'idle' | 'approve-usdc' | 'buy' | 'approve-token' | 'done' | 'error';

const MAX_USDC = 1000;

function friendly(e: unknown): string {
  const any = e as { shortMessage?: string; message?: string; cause?: { data?: { errorName?: string } } };
  const name = any?.cause?.data?.errorName;
  if (name === 'OrderTooLarge') return 'That amount is above the 1,000 USDC test limit.';
  if (name === 'Paused') return 'New protections are paused right now.';
  const msg = any?.shortMessage ?? any?.message ?? 'Something went wrong';
  if (/insufficient funds|gas/i.test(msg)) return 'Not enough test HYPE for gas. Add a little from the faucet.';
  if (/rejected|denied/i.test(msg)) return 'The request was cancelled.';
  return msg.slice(0, 220);
}

export function BuyModal({
  token,
  w,
  usdc,
  hype,
  onClose,
}: {
  token: TokenRow;
  w: Wallet;
  usdc: number | null;
  hype: number | null;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState('10');
  const [stopOn, setStopOn] = useState(true);
  const [creatorOn, setCreatorOn] = useState(true);
  const [stopPct, setStopPct] = useState('25');
  const [creatorPct, setCreatorPct] = useState('50');
  const [maxDrop, setMaxDrop] = useState<number | null>(null); // how far this token can fall before it hits its launch price
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const [bought, setBought] = useState<bigint | null>(null);
  const [needsActivate, setNeedsActivate] = useState(false);

  // Ascend pools hold no liquidity below the launch price, so a token near its launch price cannot fall far.
  useEffect(() => {
    let alive = true;
    publicClient
      .readContract({ address: ADDR.hook, abi: hookAbi, functionName: 'poolStartTick', args: [token.poolId] })
      .then((tick) => {
        if (!alive || token.priceUsd === null || token.priceUsd <= 0) return;
        const launchUsd = Math.pow(1.0001, Number(tick)) * 1e12; // USDC has 6 decimals, tokens 18
        setMaxDrop(Math.max(0, (1 - launchUsd / token.priceUsd) * 100));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [token.poolId, token.priceUsd]);

  const stopNum = Number(stopPct);
  const creatorNum = Number(creatorPct);
  const stopBad = stopOn && !(stopNum >= 1 && stopNum <= 90);
  const creatorBad = creatorOn && !(creatorNum >= 1 && creatorNum <= 95);
  const stopUseless = stopOn && !stopBad && maxDrop !== null && stopNum > maxDrop;

  const amt = Number(amount);
  const busy = step === 'approve-usdc' || step === 'buy' || step === 'approve-token';
  const symbol = token.symbol ?? shortAddr(token.token);

  const problem =
    !w.address ? 'Log in first.'
    : !w.onElysium ? 'Switch to Elysium Testnet first.'
    : !(amt > 0) ? 'Enter an amount.'
    : amt > MAX_USDC ? `The test limit is ${MAX_USDC} USDC.`
    : usdc !== null && amt > usdc ? 'You do not have that much USDC.'
    : hype !== null && hype < 0.0005 ? 'You need a little test HYPE for gas.'
    : !stopOn && !creatorOn ? 'Turn on at least one protection.'
    : stopBad ? 'Price stop must be between 1% and 90%.'
    : creatorBad ? 'Creator guard must be between 1% and 95%.'
    : null;

  async function run() {
    setError(null);
    setNeedsActivate(false);
    try {
      const me = w.address as Address;
      const client = await w.getWalletClient();
      const quoteIn = BigInt(Math.round(amt * 1e6));

      // Work out the least we will accept: 85% of what the spot price implies.
      const [oneMillionValue] = await publicClient.readContract({
        address: ADDR.executor,
        abi: executorAbi,
        functionName: 'previewValue',
        args: [token.token, 1_000_000n * 10n ** 18n],
      });
      if (oneMillionValue === 0n) throw new Error('Could not read this token’s price.');
      const expected = (quoteIn * 10n ** 24n) / oneMillionValue;
      const minOut = (expected * 85n) / 100n;

      // 1. let the executor spend this much USDC, if it is not allowed already
      const allowance = await publicClient.readContract({
        address: ADDR.usdc,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [me, ADDR.executor],
      });
      if (allowance < quoteIn) {
        setStep('approve-usdc');
        const h = await client.writeContract({
          address: ADDR.usdc,
          abi: erc20Abi,
          functionName: 'approve',
          args: [ADDR.executor, quoteIn],
          gas: 120_000n,
        });
        await publicClient.waitForTransactionReceipt({ hash: h });
      }

      // 2. buy and create the protection in one transaction
      setStep('buy');
      const block = await publicClient.getBlock();
      const expiry = Number(block.timestamp) + 7 * 86400;
      const buyHash = await client.writeContract({
        address: ADDR.executor,
        abi: executorWriteAbi,
        functionName: 'buyAndProtect',
        args: [
          {
            token: token.token,
            stopBps: stopOn ? Math.round(stopNum * 100) : 0,
            creatorSellBps: creatorOn ? Math.round(creatorNum * 100) : 0,
            holdersSellBps: 0,
            slippageBps: 2000,
            expiry,
          },
          quoteIn,
          minOut,
          [],
        ],
        gas: 1_000_000n,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: buyHash });
      if (receipt.status !== 'success') throw new Error('The buy did not go through. The price may have moved. Try again.');
      const ev = parseEventLogs({ abi: executorWriteAbi, logs: receipt.logs, eventName: 'Bought' })[0];
      const tokensOut = ev?.args.tokensOut ?? 0n;
      setBought(tokensOut);

      // 3. let the executor sell exactly these tokens if a trigger fires
      setStep('approve-token');
      try {
        const h = await client.writeContract({
          address: token.token,
          abi: erc20Abi,
          functionName: 'approve',
          args: [ADDR.executor, tokensOut],
          gas: 120_000n,
        });
        await publicClient.waitForTransactionReceipt({ hash: h });
      } catch {
        setNeedsActivate(true); // the buy worked; protection just needs one more tap in My protections
      }
      setStep('done');
    } catch (e) {
      setError(friendly(e));
      setStep('error');
    }
  }

  return (
    <div className="overlay" onClick={() => !busy && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>
            Buy {symbol}
            {token.name ? <span className="muted"> · {token.name}</span> : null}
          </h3>
          <button className="btn btn-ghost btn-small" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>

        {step === 'done' ? (
          <div className="done">
            <p className="ok-text">
              Bought {bought !== null ? formatTokens(bought) : ''} {symbol}.
            </p>
            {needsActivate ? (
              <p className="warn">Protection needs one more tap. Open “My protections” and press Activate.</p>
            ) : (
              <p className="ok-text">Protection is on. Ripcord is watching it.</p>
            )}
            <button className="btn" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <>
            <label className="label">Amount (USDC)</label>
            <input
              className="search"
              inputMode="decimal"
              value={amount}
              disabled={busy}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            />
            <div className="muted small">Balance: {usdc === null ? '…' : usdc.toFixed(2)} USDC</div>

            <label className="label">Your exit rules</label>
            <div className="rule">
              <input type="checkbox" checked={stopOn} disabled={busy} onChange={(e) => setStopOn(e.target.checked)} />
              <span>Sell if the price falls</span>
              <input
                className="pct"
                inputMode="decimal"
                value={stopPct}
                disabled={busy || !stopOn}
                onChange={(e) => setStopPct(e.target.value.replace(/[^0-9.]/g, ''))}
              />
              <span>%</span>
            </div>
            {stopUseless && (
              <p className="warn small">
                This token trades only {maxDrop!.toFixed(1)}% above its launch price, and the price cannot fall below that. A{' '}
                {stopNum}% price stop would never trigger. Use a smaller number, or rely on the creator rule.
              </p>
            )}
            <div className="rule">
              <input type="checkbox" checked={creatorOn} disabled={busy} onChange={(e) => setCreatorOn(e.target.checked)} />
              <span>Sell if the creator sells</span>
              <input
                className="pct"
                inputMode="decimal"
                value={creatorPct}
                disabled={busy || !creatorOn}
                onChange={(e) => setCreatorPct(e.target.value.replace(/[^0-9.]/g, ''))}
              />
              <span>% of their tokens</span>
            </div>

            {busy && (
              <ol className="steps">
                <li className={step === 'approve-usdc' ? 'now' : 'past'}>Allow the USDC</li>
                <li className={step === 'buy' ? 'now' : step === 'approve-token' ? 'past' : ''}>Buy and set up protection</li>
                <li className={step === 'approve-token' ? 'now' : ''}>Switch protection on</li>
              </ol>
            )}
            {(error || problem) && <p className={error ? 'error' : 'warn small'}>{error ?? problem}</p>}

            <button className="btn btn-block" disabled={busy || !!problem} onClick={run}>
              {busy ? 'Working…' : 'Buy & Protect'}
            </button>
            <p className="muted small">Test tokens on Elysium testnet. Unaudited. Your tokens stay in your wallet.</p>
          </>
        )}
      </div>
    </div>
  );
}
