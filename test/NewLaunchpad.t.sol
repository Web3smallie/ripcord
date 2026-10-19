// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {RipcordExecutor} from "../src/RipcordExecutor.sol";

interface IERC20N {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

/// Checks that our executor works against Ascend's NEW launchpad, using the real RIPC token, before we deploy anything.
contract NewLaunchpadForkTest is Test {
    address constant HOOK = 0x6d01f6644bbf1b5074472D3e85aa1465B4d2bF3d; // new AscendLaunchpad
    address constant POOL_MANAGER = 0x12E84206cB53aE0df055482ebc4658635096E1aA;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant USDC = 0x84Cc00D13173f7016Bbab22A736dBf75A154cFE2; // new USDC
    address constant ROUTER = address(bytes20(hex"90332b0ecbb2c9517f405627b0dd5d5265246563"));
    address constant RIPC = address(bytes20(hex"e6a08fc110efb9e2af582aff1d2c3002eb6fabfb")); // your new token
    address constant HOLDER = address(bytes20(hex"1c6402accaa38386ce7ebc6dfa82ed2deafc7544")); // its creator
    bytes32 constant POOL_PARAMS = 0x0000000000000000000000000000000000000000000000000000000000c80445;

    RipcordExecutor ex;
    address user;
    address keeper;
    address treasury;

    function setUp() public {
        treasury = makeAddr("treasury");
        user = makeAddr("user");
        keeper = makeAddr("keeper");
        ex = new RipcordExecutor(HOOK, ROUTER, PERMIT2, POOL_MANAGER, 8388608, POOL_PARAMS, treasury, 30, 1_000e6);
        deal(USDC, user, 200e6);
    }

    function test_1_executorReadsTheNewUsdc() public view {
        assertEq(ex.QUOTE(), USDC);
    }

    function test_2_ripcPoolIsRecognised() public view {
        (, bytes32 poolId) = ex.poolFor(RIPC); // reverts if the pool settings changed
        console.logBytes32(poolId);
    }

    function test_3_priceIsReadable() public view {
        (uint256 value,) = ex.previewValue(RIPC, 1_000_000 ether);
        console.log("USDC value of 1,000,000 RIPC (6 decimals):", value);
        assertGt(value, 0);
    }

    function test_4_buyThenCreatorGuardExit() public {
        vm.startPrank(user);
        IERC20N(USDC).approve(address(ex), 10e6);
        uint256 id = ex.buyAndProtect(
            RipcordExecutor.ProtectParams({
                token: RIPC,
                stopBps: 2500,
                creatorSellBps: 5000,
                holdersSellBps: 0,
                slippageBps: 2000,
                expiry: uint40(block.timestamp + 7 days)
            }),
            10e6,
            1,
            new address[](0)
        );
        IERC20N(RIPC).approve(address(ex), type(uint256).max);
        vm.stopPrank();

        uint256 bought = IERC20N(RIPC).balanceOf(user);
        console.log("RIPC bought with 10 USDC:", bought);
        assertGt(bought, 0);

        // the creator moves most of their tokens away
        uint256 creatorBal = IERC20N(RIPC).balanceOf(HOLDER);
        vm.prank(HOLDER);
        IERC20N(RIPC).transfer(makeAddr("elsewhere"), (creatorBal * 6) / 10);

        (, , bool tripped,,) = ex.checkOrder(id);
        assertTrue(tripped, "creator guard should trip (is HOLDER really the creator of RIPC?)");

        vm.prank(keeper);
        uint256 got = ex.execute(id);
        console.log("USDC received on exit (6 decimals):", got);
        assertGt(got, 0);
        assertEq(IERC20N(RIPC).balanceOf(user), 0);
    }
}
