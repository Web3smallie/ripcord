import { encodeAbiParameters, type Address, type Hex } from 'viem';

export type PoolKey = {
  currency0: Address;
  currency1: Address;
  hooks: Address;
  poolManager: Address;
  fee: number;
  parameters: Hex;
};

const swapStruct = {
  type: 'tuple',
  components: [
    {
      name: 'poolKey',
      type: 'tuple',
      components: [
        { name: 'currency0', type: 'address' },
        { name: 'currency1', type: 'address' },
        { name: 'hooks', type: 'address' },
        { name: 'poolManager', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'parameters', type: 'bytes32' },
      ],
    },
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' },
    { name: 'hookData', type: 'bytes' },
  ],
} as const;

/**
 * The input for Ascend's UniversalRouter command 0x10: swap exact-in on one pool, pay the input token,
 * and send the output to `recipient`. Same layout Ascend's own app sends.
 */
export function buildSwapInputs(a: {
  key: PoolKey;
  zeroForOne: boolean;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minOut: bigint;
  recipient: Address;
}): Hex[] {
  const swap = encodeAbiParameters([swapStruct], [
    { poolKey: a.key, zeroForOne: a.zeroForOne, amountIn: a.amountIn, amountOutMinimum: a.minOut, hookData: '0x' },
  ]);
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [a.tokenIn, a.amountIn]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [a.tokenOut, a.recipient, 0n]);
  return [encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ['0x060c0e', [swap, settle, take]])];
}
