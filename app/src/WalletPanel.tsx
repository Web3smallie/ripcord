import { useMemo, useState } from 'react';
import { isAddress, parseEther, parseUnits, formatUnits, type Address } from 'viem';
import { ADDR } from './config';
import { erc20Abi } from './abi';
import { publicClient } from './data';
import { formatTokens, shortAddr } from './format';
import { SellModal } from './SellModal';
import type { Holding } from './useHoldings';
import type { useWallet } from './wallet';

type Wallet = ReturnType<typeof useWallet>;

type Asset = { key: string; label: string; kind: 'hype' | 'erc20'; token?: Address; decimals: number; balance: bigint };

function friendly(e: unknown): string {
  const any = e as { shortMessage?: string; message?: string };
  const msg = any?.shortMessage ?? any?.message ?? 'Something went wrong';
  if (/insufficient funds|gas/i.test(msg)) return 'Not enough test HYPE for gas.';
  if (/rejected|denied/i.test(msg)) return 'The request was cancelled.';
  return msg.slice(0, 200);
}

export function WalletPanel({
  w,
  hype,
  usdc,
  holdings,
  loading,
  refreshHoldings,
}: {
  w: Wallet;
  hype: number | null;
  usdc: number | null;
  holdings: Holding[];
  loading: boolean;
  refreshHoldings: () => void;
}) {
  const [selling, setSelling] = useState<Holding | null>(null);
  const [assetKey, setAssetKey] = useState('usdc');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const assets: Asset[] = useMemo(() => {
    const list: Asset[] = [
      { key: 'usdc', label: 'USDC', kind: 'erc20', token: ADDR.usdc, decimals: 6, balance: BigInt(Math.round((usdc ?? 0) * 1e6)) },
      { key: 'hype', label: 'HYPE (gas)', kind: 'hype', decimals: 18, balance: BigInt(Math.round((hype ?? 0) * 1e9)) * 10n ** 9n },
    ];
    for (const h of holdings) {
      list.push({ key: h.token, label: h.symbol, kind: 'erc20', token: h.token, decimals: 18, balance: h.balance });
    }
    return list;
  }, [usdc, hype, holdings]);

  const asset = assets.find((a) => a.key === assetKey) ?? assets[0];

  if (!w.authenticated || !w.address) {
    return (
      <p className="muted">
        Log in to see your wallet.{' '}
        <button className="btn btn-small" onClick={w.login}>
          Log in
        </button>
      </p>
    );
  }

  const reserve = asset.kind === 'hype' ? parseEther('0.001') : 0n; // keep a little for gas
  const maxAmount = asset.balance > reserve ? asset.balance - reserve : 0n;

  const toValid = isAddress(to.trim(), { strict: false });
  const amountOk = /^\d*\.?\d+$/.test(amount) && Number(amount) > 0;
  let amountWei = 0n;
  if (amountOk) {
    try {
      amountWei = parseUnits(amount, asset.decimals);
    } catch {
      amountWei = 0n;
    }
  }
  const problem = !toValid
    ? 'Paste the address to send to.'
    : to.trim().toLowerCase() === w.address.toLowerCase()
      ? 'That is your own address.'
      : !amountOk || amountWei === 0n
        ? 'Enter an amount.'
        : amountWei > asset.balance
          ? 'You do not have that much.'
          : null;

  async function send() {
    setBusy(true);
    setMsg(null);
    try {
      const client = await w.getWalletClient();
      const dest = to.trim() as Address;
      const hash =
        asset.kind === 'hype'
          ? await client.sendTransaction({ to: dest, value: amountWei })
          : await client.writeContract({
              address: asset.token as Address,
              abi: erc20Abi,
              functionName: 'transfer',
              args: [dest, amountWei],
              gas: 120_000n,
            });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('The transfer did not go through.');
      setMsg({ kind: 'ok', text: `Sent ${amount} ${asset.label} to ${shortAddr(dest)}.` });
      setAmount('');
      setConfirm(false);
      refreshHoldings();
    } catch (e) {
      setMsg({ kind: 'bad', text: friendly(e) });
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wallet-panel">
      <div className="card">
        <div className="muted small">Your wallet</div>
        <div className="addr">{w.address}</div>
        <button
          className="btn btn-ghost btn-small"
          onClick={() => {
            void navigator.clipboard.writeText(w.address as string);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied' : 'Copy address'}
        </button>
        <div className="bals">
          <div>
            <div className="muted small">USDC</div>
            <div className="big">{usdc === null ? '…' : usdc.toFixed(2)}</div>
          </div>
          <div>
            <div className="muted small">HYPE (gas)</div>
            <div className="big">{hype === null ? '…' : hype.toFixed(4)}</div>
          </div>
        </div>
      </div>

      <h2>Your tokens</h2>
      {loading && holdings.length === 0 && <p className="muted">Checking your tokens…</p>}
      {!loading && holdings.length === 0 && <p className="muted">You do not hold any Ascend tokens yet.</p>}
      <div className="list">
        {holdings.map((h) => (
          <div className="card prot" key={h.token}>
            <div className="prot-main">
              <div>
                <div className="symbol">{h.symbol}</div>
                <div className="muted small">
                  {formatTokens(h.balance)} tokens
                  {h.valueUsd !== null ? ` · about ${h.valueUsd.toFixed(2)} USDC` : ''}
                </div>
              </div>
              <button className="btn btn-small" onClick={() => setSelling(h)}>
                Sell
              </button>
            </div>
          </div>
        ))}
      </div>

      <h2>Withdraw</h2>
      <div className="card form">
        <label className="label">What to send</label>
        <select
          className="search"
          value={asset.key}
          disabled={busy}
          onChange={(e) => {
            setAssetKey(e.target.value);
            setAmount('');
            setConfirm(false);
          }}
        >
          {assets.map((a) => (
            <option key={a.key} value={a.key}>
              {a.label} · {Number(formatUnits(a.balance, a.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })}
            </option>
          ))}
        </select>

        <label className="label">To this address</label>
        <input
          className="search"
          placeholder="0x…"
          value={to}
          disabled={busy}
          spellCheck={false}
          onChange={(e) => {
            setTo(e.target.value);
            setConfirm(false);
          }}
        />

        <label className="label">Amount</label>
        <div className="row">
          <input
            className="search"
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            disabled={busy}
            onChange={(e) => {
              setAmount(e.target.value.replace(/[^0-9.]/g, ''));
              setConfirm(false);
            }}
          />
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => {
              setAmount(formatUnits(maxAmount, asset.decimals));
              setConfirm(false);
            }}
          >
            Max
          </button>
        </div>
        {asset.kind === 'hype' && <p className="muted small">Max keeps a little HYPE in the wallet for gas.</p>}

        {confirm && !problem ? (
          <div className="confirm">
            <p>
              Send <b>{amount} {asset.label}</b> to
              <br />
              <span className="addr">{to.trim()}</span>
            </p>
            <p className="warn small">Check the address. Sends cannot be undone.</p>
            <div className="row">
              <button className="btn" disabled={busy} onClick={send}>
                {busy ? 'Sending…' : 'Confirm and send'}
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirm(false)}>
                Back
              </button>
            </div>
          </div>
        ) : (
          <>
            {problem && (to || amount) && <p className="warn small">{problem}</p>}
            <button className="btn btn-block" disabled={!!problem || busy} onClick={() => setConfirm(true)}>
              Withdraw
            </button>
          </>
        )}
        {msg && <p className={msg.kind === 'ok' ? 'ok-text' : 'error'}>{msg.text}</p>}
      </div>

      {selling && (
        <SellModal
          h={selling}
          w={w}
          onClose={() => setSelling(null)}
          onDone={() => {
            refreshHoldings();
          }}
        />
      )}
    </div>
  );
}
