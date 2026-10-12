// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

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

contract SwapProbe {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address immutable ROUTER;

    constructor(address router_) {
        ROUTER = router_;
    }

    // zeroForOne = true  -> spend currency0 (USDC), receive currency1 (token)  = BUY
    // zeroForOne = false -> spend currency1 (token), receive currency0 (USDC)  = SELL
    function swapExactIn(PoolKey calldata key, bool zeroForOne, uint128 amountIn, uint128 minOut, address recipient)
        external
    {
        address tokenIn = zeroForOne ? key.currency0 : key.currency1;
        address tokenOut = zeroForOne ? key.currency1 : key.currency0;

        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(tokenIn, ROUTER, uint160(amountIn), uint48(block.timestamp + 1 hours));

        bytes memory actions = hex"060c0e";
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            SwapExactInSingle({
                poolKey: key,
                zeroForOne: zeroForOne,
                amountIn: amountIn,
                amountOutMinimum: minOut,
                hookData: ""
            })
        );
        params[1] = abi.encode(tokenIn, uint256(amountIn));
        params[2] = abi.encode(tokenOut, recipient, uint256(0));

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        IUniversalRouter(ROUTER).execute(hex"10", inputs, block.timestamp + 300);
    }
}

contract ForkSwapTest is Test {
    address constant POOL_MANAGER = 0x12E84206cB53aE0df055482ebc4658635096E1aA;
    address constant HOOK = 0xE2f6254508DEB93Da081837F545e0bAF7b00d8E9;
    address constant USDC = 0x4b4fb5C5794F0c821464956374cC5872D5F0f140;
    address constant VALEN = 0xDed3d969bAa0550351d90937De030F647B73Fe46;

    function _router() internal pure returns (address) {
        return address(bytes20(hex"90332b0ecbb2c9517f405627b0dd5d5265246563"));
    }

    function _holder() internal pure returns (address) {
        return address(bytes20(hex"1c6402accaa38386ce7ebc6dfa82ed2deafc7544"));
    }

    function _key() internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: USDC,
            currency1: VALEN,
            hooks: HOOK,
            poolManager: POOL_MANAGER,
            fee: 8388608,
            parameters: 0x0000000000000000000000000000000000000000000000000000000000c80445
        });
    }

    function test_sell() public {
        SwapProbe probe = new SwapProbe(_router());
        uint128 amountIn = 100_000 ether;
        address recipient = makeAddr("recipient");

        vm.startPrank(_holder());
        IERC20(VALEN).approve(address(probe), amountIn);
        probe.swapExactIn(_key(), false, amountIn, 1, recipient);
        vm.stopPrank();

        uint256 usdcOut = IERC20(USDC).balanceOf(recipient);
        console.log("SELL: USDC received (6 decimals):", usdcOut);
        assertGt(usdcOut, 0);
    }

    function test_buy() public {
        SwapProbe probe = new SwapProbe(_router());
        uint128 amountIn = 10e6; // 10 USDC
        address recipient = makeAddr("recipient");

        assertGe(IERC20(USDC).balanceOf(_holder()), amountIn, "holder has less than 10 USDC");

        vm.startPrank(_holder());
        IERC20(USDC).approve(address(probe), amountIn);
        probe.swapExactIn(_key(), true, amountIn, 1, recipient);
        vm.stopPrank();

        uint256 valenOut = IERC20(VALEN).balanceOf(recipient);
        console.log("BUY: VALEN received (18 decimals):", valenOut);
        assertGt(valenOut, 0);
    }
}