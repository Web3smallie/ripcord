// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {RipcordExecutor} from "../src/RipcordExecutor.sol";

interface IERC20T {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

interface IPermit2T {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IRouterT {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

struct DumpSwap {
    RipcordExecutor.PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    bytes hookData;
}

/// @dev Stands in for "the market": sells a lot of the token to push the pool price down.
contract DumpProbe {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address immutable ROUTER;

    constructor(address router_) {
        ROUTER = router_;
    }

    function swap(RipcordExecutor.PoolKey calldata key, bool zeroForOne, uint128 amountIn) external {
        address tokenIn = zeroForOne ? key.currency0 : key.currency1;
        address tokenOut = zeroForOne ? key.currency1 : key.currency0;

        require(IERC20T(tokenIn).transferFrom(msg.sender, address(this), amountIn), "pull failed");
        IERC20T(tokenIn).approve(PERMIT2, type(uint256).max);
        IPermit2T(PERMIT2).approve(tokenIn, ROUTER, uint160(amountIn), uint48(block.timestamp + 1 hours));

        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            DumpSwap({poolKey: key, zeroForOne: zeroForOne, amountIn: amountIn, amountOutMinimum: 0, hookData: ""})
        );
        params[1] = abi.encode(tokenIn, uint256(amountIn));
        params[2] = abi.encode(tokenOut, msg.sender, uint256(0));

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(hex"060c0e", params);
        IRouterT(ROUTER).execute(hex"10", inputs, block.timestamp + 300);
    }
}

contract RipcordExecutorForkTest is Test {
    address constant HOOK = 0xE2f6254508DEB93Da081837F545e0bAF7b00d8E9;
    address constant POOL_MANAGER = 0x12E84206cB53aE0df055482ebc4658635096E1aA;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant USDC = 0x4b4fb5C5794F0c821464956374cC5872D5F0f140;
    address constant VALEN = 0xDed3d969bAa0550351d90937De030F647B73Fe46;
    address constant ROUTER = address(bytes20(hex"90332b0ecbb2c9517f405627b0dd5d5265246563"));
    address constant HOLDER = address(bytes20(hex"1c6402accaa38386ce7ebc6dfa82ed2deafc7544")); // creator of VALEN
    bytes32 constant POOL_PARAMS = 0x0000000000000000000000000000000000000000000000000000000000c80445;
    bytes32 constant VALEN_POOL_ID = 0xde4629efbb55a2098dfbe04f918ac46fc4333eec0d880e6f34ce6faf7cea17a6;

    RipcordExecutor ex;
    DumpProbe dumper;
    address user;
    address keeper;
    address treasury;

    function setUp() public {
        treasury = makeAddr("treasury");
        user = makeAddr("user");
        keeper = makeAddr("keeper");

        ex = new RipcordExecutor(HOOK, ROUTER, PERMIT2, POOL_MANAGER, 8388608, POOL_PARAMS, treasury, 30, 1_000e6);
        dumper = new DumpProbe(ROUTER);

        deal(USDC, user, 200e6);
    }

    // ------------------------------------------------------------------ helpers

    function _params(uint16 stopBps, uint16 creatorSellBps) internal view returns (RipcordExecutor.ProtectParams memory) {
        return RipcordExecutor.ProtectParams({
            token: VALEN,
            stopBps: stopBps,
            creatorSellBps: creatorSellBps,
            holdersSellBps: 0,
            slippageBps: 2000,
            expiry: uint40(block.timestamp + 7 days)
        });
    }

    /// @dev user buys VALEN with USDC through the executor and approves it to sell the tokens later.
    function _buy(uint128 usdcIn, RipcordExecutor.ProtectParams memory p) internal returns (uint256 id) {
        vm.startPrank(user);
        IERC20T(USDC).approve(address(ex), usdcIn);
        id = ex.buyAndProtect(p, usdcIn, 1, new address[](0));
        IERC20T(VALEN).approve(address(ex), type(uint256).max);
        vm.stopPrank();
    }

    function _buyWatch(uint128 usdcIn, RipcordExecutor.ProtectParams memory p, address[] memory watch)
        internal
        returns (uint256 id)
    {
        vm.startPrank(user);
        IERC20T(USDC).approve(address(ex), usdcIn);
        id = ex.buyAndProtect(p, usdcIn, 1, watch);
        IERC20T(VALEN).approve(address(ex), type(uint256).max);
        vm.stopPrank();
    }

    function _paramsHolders(uint16 bps) internal view returns (RipcordExecutor.ProtectParams memory p) {
        p = _params(0, 0);
        p.holdersSellBps = bps;
    }

    function _sorted(address a, address b, address c) internal pure returns (address[] memory arr) {
        arr = new address[](3);
        arr[0] = a;
        arr[1] = b;
        arr[2] = c;
        for (uint256 i = 0; i < 3; i++) {
            for (uint256 j = i + 1; j < 3; j++) {
                if (arr[j] < arr[i]) (arr[i], arr[j]) = (arr[j], arr[i]);
            }
        }
    }

    /// @dev three ordinary wallets that each hold 1,000,000 VALEN, returned in ascending order
    function _holders() internal returns (address[] memory) {
        address h1 = makeAddr("holder1");
        address h2 = makeAddr("holder2");
        address h3 = makeAddr("holder3");
        deal(VALEN, h1, 1_000_000 ether);
        deal(VALEN, h2, 1_000_000 ether);
        deal(VALEN, h3, 1_000_000 ether);
        return _sorted(h1, h2, h3);
    }

    function _status(uint256 id) internal view returns (RipcordExecutor.Status st) {
        (,,,,,,,,,, st) = ex.orders(id);
    }

    /// @dev Ascend pools cannot trade below the launch price, so a stop-loss only has room once the token
    ///      has pumped. This buys VALEN with a lot of USDC until its price is `multipleX` times higher.
    function _pumpTo(uint256 multipleX) internal {
        (RipcordExecutor.PoolKey memory key,) = ex.poolFor(VALEN);
        bool valenIs0 = VALEN < USDC;
        (uint256 base,) = ex.previewValue(VALEN, 1_000_000 ether);
        for (uint256 i = 0; i < 40; i++) {
            (uint256 current,) = ex.previewValue(VALEN, 1_000_000 ether);
            if (current >= base * multipleX) return;
            deal(USDC, address(this), 50_000e6);
            IERC20T(USDC).approve(address(dumper), 50_000e6);
            dumper.swap(key, !valenIs0, 50_000e6); // spend USDC, receive VALEN
        }
        revert("could not pump the price");
    }

    /// @dev The same market participant sells everything it bought in the pump, which drops the price back.
    function _crash(uint256 id) internal {
        (RipcordExecutor.PoolKey memory key,) = ex.poolFor(VALEN);
        bool valenIs0 = VALEN < USDC;
        uint256 bal = IERC20T(VALEN).balanceOf(address(this));
        IERC20T(VALEN).approve(address(dumper), bal);
        dumper.swap(key, valenIs0, uint128(bal));
        (, bool stopHit,,,) = ex.checkOrder(id);
        require(stopHit, "stop not hit after the crash");
    }

    // ------------------------------------------------------------------ tests

    function test_poolKeyMatchesAscendPoolId() public view {
        (, bytes32 poolId) = ex.poolFor(VALEN);
        assertEq(poolId, VALEN_POOL_ID);
    }

    function test_buyAndProtect_tokensGoToUser_executorHoldsNothing() public {
        uint256 id = _buy(10e6, _params(2500, 0));

        assertGt(IERC20T(VALEN).balanceOf(user), 0, "user got tokens");
        assertEq(IERC20T(VALEN).balanceOf(address(ex)), 0, "executor holds no tokens");
        assertEq(IERC20T(USDC).balanceOf(address(ex)), 0, "executor holds no usdc");
        assertEq(IERC20T(USDC).balanceOf(user), 190e6, "user spent exactly 10 usdc");
        assertTrue(_status(id) == RipcordExecutor.Status.Active);
    }

    function test_stopLoss_needsConfirmDelay_thenExits() public {
        _pumpTo(4); // the token has pumped 4x before the user buys
        uint256 id = _buy(10e6, _params(2500, 0));
        uint256 tokens = IERC20T(VALEN).balanceOf(user);

        _crash(id); // then the market sells off and the price falls back toward the launch price

        // not armed yet: must not fire
        vm.prank(keeper);
        vm.expectRevert(RipcordExecutor.NotTriggered.selector);
        ex.execute(id);

        vm.prank(keeper);
        ex.arm(id);

        // cannot re-arm while the arming is live (griefing guard)
        vm.prank(keeper);
        vm.expectRevert(RipcordExecutor.NotArmable.selector);
        ex.arm(id);

        // armed but the confirm delay has not passed: must not fire
        vm.prank(keeper);
        vm.expectRevert(RipcordExecutor.NotTriggered.selector);
        ex.execute(id);

        vm.warp(block.timestamp + 3);

        vm.prank(keeper);
        uint256 got = ex.execute(id);

        uint256 fee = (got * 30) / 10000;
        console.log("tokens sold:", tokens);
        console.log("usdc received (before fee):", got);
        assertGt(got, 0);
        assertEq(IERC20T(VALEN).balanceOf(user), 0, "all tokens sold");
        assertEq(IERC20T(USDC).balanceOf(user), 190e6 + got - fee, "proceeds went to the owner");
        assertEq(IERC20T(USDC).balanceOf(treasury), fee, "fee went to treasury");
        assertEq(IERC20T(USDC).balanceOf(address(ex)), 0, "executor holds no usdc");
        assertTrue(_status(id) == RipcordExecutor.Status.Executed);
    }

    function test_creatorGuard_exitsImmediately() public {
        // stop-loss off, creator guard on: exit if the creator's balance falls by 50%
        uint256 id = _buy(10e6, _params(0, 5000));

        (, , bool trippedBefore,,) = ex.checkOrder(id);
        assertFalse(trippedBefore, "guard quiet at first");

        uint256 creatorBal = IERC20T(VALEN).balanceOf(HOLDER);
        vm.prank(HOLDER);
        IERC20T(VALEN).transfer(makeAddr("elsewhere"), (creatorBal * 6) / 10);

        (, , bool tripped,,) = ex.checkOrder(id);
        assertTrue(tripped, "guard tripped");

        vm.prank(keeper);
        uint256 got = ex.execute(id); // no arm and no wait needed
        assertGt(got, 0);
        assertEq(IERC20T(VALEN).balanceOf(user), 0);
        assertTrue(_status(id) == RipcordExecutor.Status.Executed);
    }

    function test_cannotExecuteWhenNothingTriggered() public {
        uint256 id = _buy(10e6, _params(2500, 5000));
        vm.prank(keeper);
        vm.expectRevert(RipcordExecutor.NotTriggered.selector);
        ex.execute(id);
    }

    function test_cancel_onlyOwner_andStopsExecution() public {
        uint256 id = _buy(10e6, _params(2500, 0));

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(RipcordExecutor.NotOwner.selector);
        ex.cancel(id);

        vm.prank(user);
        ex.cancel(id);
        assertTrue(_status(id) == RipcordExecutor.Status.Cancelled);

        vm.prank(keeper);
        vm.expectRevert(RipcordExecutor.NotActive.selector);
        ex.execute(id);
    }

    function test_pause_blocksNewOrders_butNotCancel() public {
        uint256 id = _buy(10e6, _params(2500, 0));

        ex.setPaused(true); // this test contract is the owner

        vm.startPrank(user);
        IERC20T(USDC).approve(address(ex), 10e6);
        RipcordExecutor.ProtectParams memory p = _params(2500, 0);
        vm.expectRevert(RipcordExecutor.Paused.selector);
        ex.buyAndProtect(p, 10e6, 1, new address[](0));

        ex.cancel(id); // still works while paused
        vm.stopPrank();
        assertTrue(_status(id) == RipcordExecutor.Status.Cancelled);
    }

    function test_expiredOrderCannotExecute() public {
        uint256 id = _buy(10e6, _params(2500, 5000));
        vm.warp(block.timestamp + 8 days);
        vm.prank(keeper);
        vm.expectRevert(RipcordExecutor.Expired.selector);
        ex.execute(id);
    }

    function test_orderSizeCap() public {
        RipcordExecutor.ProtectParams memory p = _params(2500, 0);
        vm.prank(user);
        vm.expectRevert(RipcordExecutor.OrderTooLarge.selector);
        ex.buyAndProtect(p, 2_000e6, 1, new address[](0));
    }

    function test_unknownTokenRejected() public {
        RipcordExecutor.ProtectParams memory p = _params(2500, 0);
        p.token = address(0xdead);
        vm.prank(user);
        vm.expectRevert(RipcordExecutor.UnknownPool.selector);
        ex.protect(p, 1, new address[](0));
    }

    function test_protectExistingHoldings() public {
        vm.startPrank(HOLDER);
        IERC20T(VALEN).approve(address(ex), type(uint256).max);
        uint256 id = ex.protect(_params(2500, 0), 100_000 ether, new address[](0));
        vm.stopPrank();
        assertTrue(_status(id) == RipcordExecutor.Status.Active);
    }

    function test_holderWatch_exitsWhenWatchedHoldersSell() public {
        address[] memory list = _holders(); // 3 wallets x 1,000,000 VALEN = 3,000,000 watched
        uint256 id = _buyWatch(10e6, _paramsHolders(3000), list); // exit if the group falls 30% (to 2,100,000)

        // moving tokens between two watched wallets is not selling
        vm.prank(list[0]);
        IERC20T(VALEN).transfer(list[1], 400_000 ether);
        (,,,, bool t0) = ex.checkOrder(id);
        assertFalse(t0, "internal move ignored");

        // 750,000 leave the group: 2,250,000 left, still above the 2,100,000 floor
        address outside = makeAddr("outside");
        vm.prank(list[2]);
        IERC20T(VALEN).transfer(outside, 750_000 ether);
        (,,,, bool t1) = ex.checkOrder(id);
        assertFalse(t1, "not enough selling yet");

        // 200,000 more leave: 2,050,000 left, below the floor
        vm.prank(list[0]);
        IERC20T(VALEN).transfer(outside, 200_000 ether);
        (,,,, bool t2) = ex.checkOrder(id);
        assertTrue(t2, "watchlist tripped");

        vm.prank(keeper);
        uint256 got = ex.execute(id); // no arm and no wait needed
        assertGt(got, 0);
        assertEq(IERC20T(VALEN).balanceOf(user), 0);
        assertTrue(_status(id) == RipcordExecutor.Status.Executed);
        assertEq(ex.getWatchlist(id).length, 3);
    }

    function test_holderWatch_rejectsBadLists() public {
        address[] memory good = _holders();
        RipcordExecutor.ProtectParams memory p = _paramsHolders(3000);

        vm.startPrank(user);
        IERC20T(USDC).approve(address(ex), 100e6);

        // not ascending
        address[] memory rev = new address[](3);
        rev[0] = good[2];
        rev[1] = good[1];
        rev[2] = good[0];
        vm.expectRevert(RipcordExecutor.BadParams.selector);
        ex.buyAndProtect(p, 10e6, 1, rev);

        // duplicate
        address[] memory dup = new address[](2);
        dup[0] = good[0];
        dup[1] = good[0];
        vm.expectRevert(RipcordExecutor.BadParams.selector);
        ex.buyAndProtect(p, 10e6, 1, dup);

        // contains a contract (the pool manager)
        address[] memory withContract = new address[](1);
        withContract[0] = POOL_MANAGER;
        vm.expectRevert(RipcordExecutor.BadParams.selector);
        ex.buyAndProtect(p, 10e6, 1, withContract);

        // contains the order owner
        address[] memory withOwner = new address[](1);
        withOwner[0] = user;
        vm.expectRevert(RipcordExecutor.BadParams.selector);
        ex.buyAndProtect(p, 10e6, 1, withOwner);

        // empty list while the holder guard is on
        vm.expectRevert(RipcordExecutor.BadParams.selector);
        ex.buyAndProtect(p, 10e6, 1, new address[](0));

        // 51 wallets is one too many
        address[] memory big = new address[](51);
        for (uint256 i = 0; i < 51; i++) {
            big[i] = address(uint160(1000 + i));
        }
        vm.expectRevert(RipcordExecutor.BadParams.selector);
        ex.buyAndProtect(p, 10e6, 1, big);

        // a list supplied while the holder guard is off
        vm.expectRevert(RipcordExecutor.BadParams.selector);
        ex.buyAndProtect(_params(2500, 0), 10e6, 1, good);

        vm.stopPrank();
    }

    function test_holderWatch_fiftyWallets() public {
        address[] memory list = new address[](50);
        for (uint256 i = 0; i < 50; i++) {
            list[i] = address(uint160(0x10000 + i)); // ascending, no code
            deal(VALEN, list[i], 100_000 ether);
        }
        uint256 id = _buyWatch(10e6, _paramsHolders(2000), list);
        assertEq(ex.getWatchlist(id).length, 50);
        (,,,, bool tripped) = ex.checkOrder(id);
        assertFalse(tripped);
    }
}
