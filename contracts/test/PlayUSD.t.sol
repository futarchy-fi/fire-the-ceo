// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {PlayUSD} from "../src/PlayUSD.sol";

contract PlayUSDTest is Test {
    PlayUSD internal pusd;
    address internal user = makeAddr("user");

    function setUp() public {
        pusd = new PlayUSD();
    }

    function test_FaucetMints10k() public {
        vm.prank(user);
        pusd.faucet();

        assertEq(pusd.balanceOf(user), 10_000e18);
    }

    function test_FaucetRevertsWithin24h() public {
        vm.startPrank(user);
        pusd.faucet();
        vm.expectRevert(PlayUSD.CooldownActive.selector);
        pusd.faucet();
        vm.stopPrank();
    }

    function test_FaucetAgainAfter24h() public {
        vm.prank(user);
        pusd.faucet();
        vm.warp(block.timestamp + 24 hours);
        vm.prank(user);
        pusd.faucet();

        assertEq(pusd.balanceOf(user), 20_000e18);
    }

    function test_OwnerMint() public {
        pusd.mint(user, 123e18);

        assertEq(pusd.balanceOf(user), 123e18);
    }

    function test_MintNotOwnerReverts() public {
        vm.prank(user);
        vm.expectRevert(Ownable.Unauthorized.selector);
        pusd.mint(user, 1e18);
    }
}
