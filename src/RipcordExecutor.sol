// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RipcordExecutor
/// @notice Non-custodial exit protection for Ascend-launched tokens on Elysium.
///         Users keep their tokens; the executor pulls them only at the moment an exit fires,
///         sells through Ascend's UniversalRouter, and sends the proceeds to the owner.
///         Exits can be triggered by: a stop-loss on the pool price, the token creator selling, or the combined
///         balance of a watchlist of up to 50 large holders falling.
///         UNAUDITED. Order size is capped. The owner can pause NEW orders only; the owner can
///         never block an exit or a cancel and has no function that moves user funds.

interface IAscendHook {
    function poolLaunchedAt(bytes32 poolId) external view returns (uint40);
    function poolCreator(bytes32 poolId) external view returns (address);
    function baseQuote() external view returns (address);
}

interface ICLPoolManagerLite {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
}

interface IPermit2Lite {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IUniversalRouterLite {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IERC20Lite {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

contract RipcordExecutor {
    // ------------------------------------------------------------------ types

    struct PoolKey {
        address currency0;
        address currency1;
        address hooks;
        address poolManager;
        uint24 fee;
        bytes32 parameters;
    }

    struct SwapExactInSingle {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    enum Status {
        None,
        Active,
        Executed,
        Cancelled
    }

    struct Order {
        address owner;
        address token;
        uint128 amount; // tokens the order may sell (capped by balance and allowance at exit time)
        uint160 stopSqrt; // pool sqrt price that counts as "stopped out"; 0 = stop-loss disabled
        address creator; // creator wallet being watched; 0 = creator guard disabled
        uint128 creatorFloor; // exit if the creator's token balance falls below this
        uint128 watchFloor; // exit if the watchlist's combined token balance falls below this
        uint40 expiry;
        uint40 armedAt; // when a keeper first saw the stop condition (0 = not armed)
        uint16 slippageBps; // allowed shortfall versus spot-implied output at exit time
        Status status;
    }

    /// @dev User-chosen protection settings, shared by protect() and buyAndProtect().
    struct ProtectParams {
        address token;
        uint16 stopBps; // 0 = off; otherwise exit when price is this many bps below entry (100..9000)
        uint16 creatorSellBps; // 0 = off; otherwise exit when the creator's balance drops this many bps (1..9500)
        uint16 holdersSellBps; // 0 = off; otherwise exit when the watchlist's COMBINED balance drops this many bps (1..9500)
        uint16 slippageBps; // 0..5000
        uint40 expiry; // unix timestamp, at most 30 days ahead
    }

    // ------------------------------------------------------------------ constants / immutables

    address public immutable HOOK;
    address public immutable ROUTER;
    address public immutable PERMIT2;
    address public immutable POOL_MANAGER;
    address public immutable QUOTE; // USDC, read from the hook
    uint24 public immutable POOL_FEE;
    bytes32 public immutable POOL_PARAMS;
    uint16 public immutable FEE_BPS; // exit fee, charged on proceeds, capped at 1%

    uint256 public constant CONFIRM_DELAY = 2; // seconds the stop condition must persist
    uint256 public constant ARM_WINDOW = 10; // seconds an armed order stays executable
    uint256 public constant MAX_EXPIRY = 30 days;
    uint256 public constant MAX_WATCH = 50;

    // ------------------------------------------------------------------ state

    address public owner;
    address public treasury;
    bool public paused; // blocks NEW orders only
    uint128 public maxOrderQuote; // max order size, measured in quote-token units (USDC, 6 decimals)
    uint256 public nextId = 1;
    mapping(uint256 => Order) public orders;
    mapping(uint256 => address[]) internal watchlist; // fixed at order creation, ascending order, EOAs only
    uint256 private _lock = 1;

    // ------------------------------------------------------------------ events / errors

    event OrderCreated(
        uint256 indexed id,
        address indexed owner,
        address indexed token,
        uint128 amount,
        uint160 entrySqrt,
        uint160 stopSqrt,
        address creator,
        uint128 creatorFloor,
        uint40 expiry,
        uint16 slippageBps
    );
    event WatchSet(uint256 indexed id, uint256 holders, uint256 baselineBalance, uint256 floorBalance);
    event Bought(address indexed owner, address indexed token, uint256 quoteIn, uint256 tokensOut);
    event Armed(uint256 indexed id, uint40 armedAtTime);
    event Executed(
        uint256 indexed id,
        address indexed owner,
        uint8 trigger, // 1 = stop-loss, 2 = creator guard, 3 = holder watchlist
        uint256 tokensSold,
        uint256 quoteReceived,
        uint256 feePaid,
        uint160 sqrtPriceAtExit
    );
    event Cancelled(uint256 indexed id);

    error NotOwner();
    error Paused();
    error Reentrant();
    error UnknownPool();
    error BadParams();
    error OrderTooLarge();
    error NotActive();
    error Expired();
    error NotTriggered();
    error NothingToSell();
    error NotArmable();
    error SlippageExceeded();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrant();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(
        address hook_,
        address router_,
        address permit2_,
        address poolManager_,
        uint24 poolFee_,
        bytes32 poolParams_,
        address treasury_,
        uint16 feeBps_,
        uint128 maxOrderQuote_
    ) {
        if (feeBps_ > 100 || treasury_ == address(0)) revert BadParams();
        HOOK = hook_;
        ROUTER = router_;
        PERMIT2 = permit2_;
        POOL_MANAGER = poolManager_;
        POOL_FEE = poolFee_;
        POOL_PARAMS = poolParams_;
        QUOTE = IAscendHook(hook_).baseQuote();
        FEE_BPS = feeBps_;
        treasury = treasury_;
        maxOrderQuote = maxOrderQuote_;
        owner = msg.sender;
    }

    // ------------------------------------------------------------------ user actions

    /// @notice Protect tokens you already hold. Entry price = the pool's current price.
    ///         Requires: you have approved this contract to spend `amount` of the token (needed at exit time).
    function protect(ProtectParams calldata p, uint128 amount, address[] calldata watch) external returns (uint256 id) {
        if (paused) revert Paused();
        (, bytes32 poolId) = _key(p.token);
        if (_bal(p.token, msg.sender) < amount) revert BadParams();
        id = _createOrder(p, amount, poolId, watch);
    }

    /// @notice Buy with USDC and protect in one transaction. Tokens go straight to your wallet.
    ///         Requires: you approved this contract to spend `quoteIn` USDC. For the exit to work you also
    ///         need to approve this contract to spend the bought tokens (can be done before or after).
    function buyAndProtect(ProtectParams calldata p, uint128 quoteIn, uint128 minTokensOut, address[] calldata watch)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (paused) revert Paused();
        if (quoteIn == 0 || quoteIn > maxOrderQuote) revert OrderTooLarge();
        (PoolKey memory key, bytes32 poolId) = _key(p.token);
        bool tokenIs0 = p.token < QUOTE;

        _pull(QUOTE, msg.sender, quoteIn);
        // buying the token: if the token is currency0 we spend currency1 (quote) => zeroForOne = false
        uint256 got = _swapExactIn(key, !tokenIs0, QUOTE, p.token, quoteIn, minTokensOut);
        _push(p.token, msg.sender, got);
        emit Bought(msg.sender, p.token, quoteIn, got);

        if (got > type(uint128).max) revert BadParams();
        id = _createOrder(p, uint128(got), poolId, watch);
    }

    /// @notice Anyone (a keeper) may call this when the stop condition is first seen. It starts the confirm timer.
    function arm(uint256 id) external {
        Order storage o = orders[id];
        if (o.status != Status.Active) revert NotActive();
        if (block.timestamp > o.expiry) revert Expired();
        if (o.stopSqrt == 0) revert NotArmable();
        (, bytes32 poolId) = _key(o.token);
        (uint160 sqrtP,,,) = ICLPoolManagerLite(POOL_MANAGER).getSlot0(poolId);
        if (!_stopHit(o.stopSqrt, sqrtP, o.token < QUOTE)) revert NotArmable();
        // cannot re-arm while a previous arming is still live (prevents timer-reset griefing)
        if (o.armedAt != 0 && block.timestamp <= uint256(o.armedAt) + ARM_WINDOW) revert NotArmable();
        o.armedAt = uint40(block.timestamp);
        emit Armed(id, o.armedAt);
    }

    /// @notice Anyone may execute a triggered order. Proceeds always go to the order's owner.
    function execute(uint256 id) external nonReentrant returns (uint256 received) {
        Order storage o = orders[id];
        if (o.status != Status.Active) revert NotActive();
        if (block.timestamp > o.expiry) revert Expired();

        (PoolKey memory key, bytes32 poolId) = _key(o.token);
        bool tokenIs0 = o.token < QUOTE;
        (uint160 sqrtP,,,) = ICLPoolManagerLite(POOL_MANAGER).getSlot0(poolId);

        uint8 trigger;
        if (o.creator != address(0) && IERC20Lite(o.token).balanceOf(o.creator) < o.creatorFloor) {
            trigger = 2; // a balance drop is a hard fact, so no confirm delay
        } else if (_watchTripped(id, o)) {
            trigger = 3; // also a balance drop, so no confirm delay
        } else if (o.stopSqrt != 0 && _armedAndHit(o, sqrtP, tokenIs0)) {
            trigger = 1;
        } else {
            revert NotTriggered();
        }

        uint256 sellAmt = _min(o.amount, _min(_bal(o.token, o.owner), IERC20Lite(o.token).allowance(o.owner, address(this))));
        if (sellAmt == 0) revert NothingToSell();

        o.status = Status.Executed; // effects before interactions

        uint256 minOut = (_quoteForTokens(sellAmt, sqrtP, tokenIs0) * (10000 - o.slippageBps)) / 10000;

        _pull(o.token, o.owner, sellAmt);
        // selling the token: if the token is currency0 we spend currency0 => zeroForOne = true
        received = _swapExactIn(key, tokenIs0, o.token, QUOTE, sellAmt, minOut);
        if (received < minOut) revert SlippageExceeded();

        uint256 fee = (received * FEE_BPS) / 10000;
        if (fee > 0) _push(QUOTE, treasury, fee);
        _push(QUOTE, o.owner, received - fee);

        emit Executed(id, o.owner, trigger, sellAmt, received, fee, sqrtP);
    }

    /// @notice Owner of an order can cancel at any time, including while paused.
    function cancel(uint256 id) external {
        Order storage o = orders[id];
        if (o.owner != msg.sender) revert NotOwner();
        if (o.status != Status.Active) revert NotActive();
        o.status = Status.Cancelled;
        emit Cancelled(id);
    }

    // ------------------------------------------------------------------ views (for the keeper and the app)

    /// @return active whether the order can still execute
    /// @return stopHit stop-loss price condition true right now
    /// @return creatorTripped creator guard condition true right now
    /// @return armedReady stop condition confirmed (armed long enough, inside the arm window)
    /// @return holdersTripped the watchlist's combined balance is below its floor
    function checkOrder(uint256 id)
        external
        view
        returns (bool active, bool stopHit, bool creatorTripped, bool armedReady, bool holdersTripped)
    {
        Order storage o = orders[id];
        active = o.status == Status.Active && block.timestamp <= o.expiry;
        if (!active) return (false, false, false, false, false);
        (, bytes32 poolId) = _key(o.token);
        (uint160 sqrtP,,,) = ICLPoolManagerLite(POOL_MANAGER).getSlot0(poolId);
        if (o.stopSqrt != 0) {
            stopHit = _stopHit(o.stopSqrt, sqrtP, o.token < QUOTE);
            armedReady = stopHit && _armedOk(o);
        }
        if (o.creator != address(0)) {
            creatorTripped = IERC20Lite(o.token).balanceOf(o.creator) < o.creatorFloor;
        }
        holdersTripped = _watchTripped(id, o);
    }

    /// @notice The wallets this order watches (ascending order).
    function getWatchlist(uint256 id) external view returns (address[] memory) {
        return watchlist[id];
    }

    /// @notice Spot-implied USDC value of `amount` tokens (no price impact), plus the raw pool sqrt price.
    function previewValue(address token, uint256 amount) external view returns (uint256 quoteValue, uint160 sqrtP) {
        (, bytes32 poolId) = _key(token);
        (sqrtP,,,) = ICLPoolManagerLite(POOL_MANAGER).getSlot0(poolId);
        quoteValue = _quoteForTokens(amount, sqrtP, token < QUOTE);
    }

    /// @notice The Ascend pool key and id for a token (reverts if the token was not launched by the hook).
    function poolFor(address token) external view returns (PoolKey memory key, bytes32 poolId) {
        return _key(token);
    }

    // ------------------------------------------------------------------ admin (new orders only; no user-fund access)

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
    }

    function setMaxOrderQuote(uint128 v) external onlyOwner {
        maxOrderQuote = v;
    }

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert BadParams();
        treasury = t;
    }

    function transferOwnership(address o_) external onlyOwner {
        if (o_ == address(0)) revert BadParams();
        owner = o_;
    }

    // ------------------------------------------------------------------ internals: orders

    function _createOrder(ProtectParams calldata p, uint128 amount, bytes32 poolId, address[] calldata watch)
        internal
        returns (uint256 id)
    {
        _validate(p, amount, watch.length);

        bool tokenIs0 = p.token < QUOTE;
        (uint160 entrySqrt,,,) = ICLPoolManagerLite(POOL_MANAGER).getSlot0(poolId);
        if (_quoteForTokens(amount, entrySqrt, tokenIs0) > maxOrderQuote) revert OrderTooLarge();

        id = nextId++;
        Order storage o = orders[id];
        o.owner = msg.sender;
        o.token = p.token;
        o.amount = amount;
        o.expiry = p.expiry;
        o.slippageBps = p.slippageBps;
        o.status = Status.Active;

        if (p.stopBps != 0) o.stopSqrt = _stopSqrt(entrySqrt, p.stopBps, tokenIs0);
        if (p.creatorSellBps != 0) _setCreatorGuard(o, p, poolId);
        if (p.holdersSellBps != 0) _setHolderWatch(id, o, p, watch);

        // refuse an order where no protection ended up active, rather than pretend
        if (o.stopSqrt == 0 && o.creator == address(0) && watchlist[id].length == 0) revert BadParams();

        _emitCreated(id, entrySqrt);
    }

    function _validate(ProtectParams calldata p, uint128 amount, uint256 watchLen) internal view {
        if (amount == 0) revert BadParams();
        if (p.stopBps == 0 && p.creatorSellBps == 0 && p.holdersSellBps == 0) revert BadParams();
        if (p.stopBps != 0 && (p.stopBps < 100 || p.stopBps > 9000)) revert BadParams();
        if (p.creatorSellBps > 9500 || p.holdersSellBps > 9500) revert BadParams();
        if (p.slippageBps > 5000) revert BadParams();
        if (p.expiry <= block.timestamp || p.expiry > block.timestamp + MAX_EXPIRY) revert BadParams();
        if (p.holdersSellBps == 0) {
            if (watchLen != 0) revert BadParams();
        } else if (watchLen == 0 || watchLen > MAX_WATCH) {
            revert BadParams();
        }
    }

    function _setCreatorGuard(Order storage o, ProtectParams calldata p, bytes32 poolId) internal {
        address c = IAscendHook(HOOK).poolCreator(poolId);
        uint256 baseline = c == address(0) ? 0 : IERC20Lite(p.token).balanceOf(c);
        if (baseline != 0) {
            o.creator = c;
            o.creatorFloor = uint128((baseline * (10000 - p.creatorSellBps)) / 10000);
        }
    }

    /// @dev The list must be strictly ascending (so no duplicates and no zero address), contain only wallets
    ///      without code (so pools, vaults and routers cannot be watched), and must not include the order owner.
    ///      The list itself comes from the caller; a bad list only weakens the caller's own protection.
    function _setHolderWatch(uint256 id, Order storage o, ProtectParams calldata p, address[] calldata watch)
        internal
    {
        address[] storage list = watchlist[id];
        address prev;
        uint256 sum;
        for (uint256 i = 0; i < watch.length; i++) {
            address a = watch[i];
            if (a <= prev || a == msg.sender || a.code.length != 0) revert BadParams();
            prev = a;
            sum += IERC20Lite(p.token).balanceOf(a);
            list.push(a);
        }
        if (sum == 0) revert BadParams();
        uint256 floor = (sum * (10000 - p.holdersSellBps)) / 10000;
        if (floor > type(uint128).max) revert BadParams();
        o.watchFloor = uint128(floor);
        emit WatchSet(id, watch.length, sum, floor);
    }

    /// @dev Combined balance of the watchlist. Moving tokens between two watched wallets changes nothing.
    function _watchTripped(uint256 id, Order storage o) internal view returns (bool) {
        address[] storage list = watchlist[id];
        uint256 n = list.length;
        if (n == 0) return false;
        address tok = o.token;
        uint256 sum;
        for (uint256 i = 0; i < n; i++) {
            sum += IERC20Lite(tok).balanceOf(list[i]);
        }
        return sum < o.watchFloor;
    }

    function _emitCreated(uint256 id, uint160 entrySqrt) internal {
        Order memory o = orders[id];
        emit OrderCreated(
            id, o.owner, o.token, o.amount, entrySqrt, o.stopSqrt, o.creator, o.creatorFloor, o.expiry, o.slippageBps
        );
    }

    function _armedOk(Order storage o) internal view returns (bool) {
        uint256 a = o.armedAt;
        return a != 0 && block.timestamp >= a + CONFIRM_DELAY && block.timestamp <= a + ARM_WINDOW;
    }

    function _armedAndHit(Order storage o, uint160 sqrtP, bool tokenIs0) internal view returns (bool) {
        return _armedOk(o) && _stopHit(o.stopSqrt, sqrtP, tokenIs0);
    }

    /// @dev price <= stop. If the token is currency0, price rises with sqrtP; if currency1, price falls as sqrtP rises.
    function _stopHit(uint160 stopSqrt, uint160 sqrtP, bool tokenIs0) internal pure returns (bool) {
        return tokenIs0 ? sqrtP <= stopSqrt : sqrtP >= stopSqrt;
    }

    // ------------------------------------------------------------------ internals: pool and price math

    function _key(address token) internal view returns (PoolKey memory key, bytes32 poolId) {
        address q = QUOTE;
        if (token == q) revert UnknownPool();
        (address c0, address c1) = token < q ? (token, q) : (q, token);
        key = PoolKey(c0, c1, HOOK, POOL_MANAGER, POOL_FEE, POOL_PARAMS);
        poolId = keccak256(abi.encode(key));
        if (IAscendHook(HOOK).poolLaunchedAt(poolId) == 0) revert UnknownPool();
    }

    /// @dev stop trigger in sqrt-price space, using sqrt(ratio) so no 512-bit math is needed.
    ///      ratio = (10000 - stopBps) / 10000; f = sqrt(ratio) * 1e9.
    function _stopSqrt(uint160 entry, uint16 stopBps, bool tokenIs0) internal pure returns (uint160) {
        uint256 f = _isqrt(uint256(10000 - stopBps) * 1e14);
        if (f == 0) revert BadParams();
        uint256 t = tokenIs0 ? (uint256(entry) * f) / 1e9 : (uint256(entry) * 1e9) / f;
        if (t == 0 || t > type(uint160).max) revert BadParams();
        return uint160(t);
    }

    /// @dev quote-token value of `amount` tokens at pool sqrt price `sqrtP` (spot, ignores price impact).
    function _quoteForTokens(uint256 amount, uint160 sqrtP, bool tokenIs0) internal pure returns (uint256) {
        if (tokenIs0) {
            // token = currency0, price(quote per token) = sqrtP^2 / 2^192
            return (((amount * sqrtP) >> 96) * sqrtP) >> 96;
        }
        // token = currency1, price(token per quote) = sqrtP^2 / 2^192
        return ((((amount << 96) / sqrtP) << 96) / sqrtP);
    }

    function _isqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x;
        uint256 y = (x + 1) / 2;
        while (y < z) {
            z = y;
            y = (x / y + y) / 2;
        }
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    // ------------------------------------------------------------------ internals: swap and token transfers

    /// @dev Spends `amountIn` of tokenIn already held by this contract; output stays here; returns the amount received.
    function _swapExactIn(
        PoolKey memory key,
        bool zeroForOne,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut
    ) internal returns (uint256 got) {
        if (amountIn > type(uint128).max || minOut > type(uint128).max) revert BadParams();
        uint256 before_ = _bal(tokenOut, address(this));

        if (IERC20Lite(tokenIn).allowance(address(this), PERMIT2) < amountIn) {
            _approve(tokenIn, PERMIT2, type(uint256).max);
        }
        IPermit2Lite(PERMIT2).approve(tokenIn, ROUTER, uint160(amountIn), uint48(block.timestamp + 300));

        // Infinity swap command with three actions: swap exact-in single, settle input, take output
        bytes memory actions = hex"060c0e";
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            SwapExactInSingle({
                poolKey: key,
                zeroForOne: zeroForOne,
                amountIn: uint128(amountIn),
                amountOutMinimum: uint128(minOut),
                hookData: ""
            })
        );
        params[1] = abi.encode(tokenIn, amountIn);
        params[2] = abi.encode(tokenOut, address(this), uint256(0));

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        IUniversalRouterLite(ROUTER).execute(hex"10", inputs, block.timestamp + 300);

        got = _bal(tokenOut, address(this)) - before_;
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return IERC20Lite(token).balanceOf(who);
    }

    function _approve(address token, address spender, uint256 amount) internal {
        _call(token, abi.encodeCall(IERC20Lite.approve, (spender, amount)));
    }

    function _pull(address token, address from, uint256 amount) internal {
        _call(token, abi.encodeCall(IERC20Lite.transferFrom, (from, address(this), amount)));
    }

    function _push(address token, address to, uint256 amount) internal {
        _call(token, abi.encodeCall(IERC20Lite.transfer, (to, amount)));
    }

    /// @dev handles tokens that return nothing or return a bool
    function _call(address token, bytes memory data) internal {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
