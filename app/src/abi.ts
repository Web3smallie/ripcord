import { parseAbi, parseAbiItem } from 'viem';

export const launchedEvent = parseAbiItem(
  'event Launched(bytes32 indexed poolId, address indexed token, address indexed creator, address quote, uint256 supplySeeded, uint256 devBuyTokens)'
);

export const erc20Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

export const executorAbi = parseAbi([
  'function previewValue(address token, uint256 amount) view returns (uint256 quoteValue, uint160 sqrtP)',
  'function poolFor(address token) view returns ((address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters) key, bytes32 poolId)',
]);

export const hookAbi = parseAbi([
  'function poolCreator(bytes32 poolId) view returns (address)',
  'function poolStartTick(bytes32 poolId) view returns (int24)',
]);

export const executorWriteAbi = parseAbi([
  'function buyAndProtect((address token, uint16 stopBps, uint16 creatorSellBps, uint16 holdersSellBps, uint16 slippageBps, uint40 expiry) p, uint128 quoteIn, uint128 minTokensOut, address[] watch) returns (uint256 id)',
  'function cancel(uint256 id)',
  'function orders(uint256) view returns (address owner, address token, uint128 amount, uint160 stopSqrt, address creator, uint128 creatorFloor, uint128 watchFloor, uint40 expiry, uint40 armedAt, uint16 slippageBps, uint8 status)',
  'event Bought(address indexed owner, address indexed token, uint256 quoteIn, uint256 tokensOut)',
]);

export const orderCreatedEvent = parseAbiItem(
  'event OrderCreated(uint256 indexed id, address indexed owner, address indexed token, uint128 amount, uint160 entrySqrt, uint160 stopSqrt, address creator, uint128 creatorFloor, uint40 expiry, uint16 slippageBps)'
);

export const executedEvent = parseAbiItem(
  'event Executed(uint256 indexed id, address indexed owner, uint8 trigger, uint256 tokensSold, uint256 quoteReceived, uint256 feePaid, uint160 sqrtPriceAtExit)'
);

export const permit2Abi = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

export const routerAbi = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);
