// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {V2TestBase} from "./V2TestBase.sol";
import {FireTheCEOv2} from "../../src/v2/FireTheCEOv2.sol";
import {LMSR} from "../../src/LMSR.sol";

contract FireTheCEOv2MechanismTest is V2TestBase {
    function test_EnumAndTokenIdEncodingAreLoadBearing() public view {
        assertEq(uint8(FireTheCEOv2.MarketKind.Out), 0);
        assertEq(uint8(FireTheCEOv2.MarketKind.Stay), 1);
        assertEq(uint8(FireTheCEOv2.MarketKind.Exit), 2);
        (uint256 id, FireTheCEOv2.MarketKind kind, bool longSide) = core.decodeTokenId(companyId * 6 + 5);
        assertEq(id, companyId); assertEq(uint8(kind), 2); assertFalse(longSide);
    }

    function test_ListCopiesV1BandsAndPullsExactSubsidy() public view {
        FireTheCEOv2.Company memory c = core.getCompany(companyId);
        assertEq(c.ticker, "ACME"); assertEq(c.floorCents, 10_000); assertEq(c.capCents, 70_000);
        uint256 expected = 2 * LMSR.worstCaseLoss(0, 0, 5_000e18) + LMSR.worstCaseLoss(LMSR.initialQ(2_000e18, 0.05e18), 0, 2_000e18) + 3 * core.DUST();
        assertEq(pusd.balanceOf(address(core)), expected);
    }

    function test_BuyMovesPriceAndTracksPaidIn() public {
        uint256 beforeBalance = pusd.balanceOf(alice); uint256 quote = _buy(alice, FireTheCEOv2.MarketKind.Out, true, 100e18);
        (uint256[] memory out,,,) = core.getAllPrices();
        (uint128 sharesL,, uint128 paidIn,) = core.positions(companyId, 0, alice);
        assertGt(out[companyId], 0.5e18); assertEq(sharesL, 100e18); assertEq(paidIn, quote);
        assertEq(beforeBalance - pusd.balanceOf(alice), quote);
    }

    function test_SellEscrowsAndDoesNotTransfer() public {
        _buy(alice, FireTheCEOv2.MarketKind.Out, true, 100e18);
        uint256 quote = core.quoteSell(companyId, FireTheCEOv2.MarketKind.Out, true, 40e18);
        uint256 beforeBalance = pusd.balanceOf(alice); vm.prank(alice); core.sell(companyId, FireTheCEOv2.MarketKind.Out, true, 40e18, quote);
        (uint128 held,,, uint128 escrow) = core.positions(companyId, 0, alice);
        assertEq(held, 60e18); assertEq(escrow, quote); assertEq(pusd.balanceOf(alice), beforeBalance);
    }

    function test_TradingClosesAtHorizon() public {
        vm.warp(horizon); vm.prank(alice); vm.expectRevert(FireTheCEOv2.TradingClosed.selector);
        core.buy(companyId, FireTheCEOv2.MarketKind.Out, true, 1e18, type(uint256).max);
    }

    function test_ShareCapAndPositionChecksRemain() public {
        vm.prank(alice); vm.expectRevert(FireTheCEOv2.ShareCapExceeded.selector);
        core.buy(companyId, FireTheCEOv2.MarketKind.Out, true, 1e27 + 1, type(uint256).max);
    }

    function test_ResolutionDisputeAndValidClaimCopyV1() public {
        _buy(alice, FireTheCEOv2.MarketKind.Out, true, 100e18);
        _buy(alice, FireTheCEOv2.MarketKind.Stay, true, 80e18);
        (,, uint128 voidPaidIn,) = core.positions(companyId, 1, alice);
        vm.warp(settleTime); core.resolveCompany(companyId, true, 40_000, "first");
        vm.warp(block.timestamp + 1 days); core.resolveCompany(companyId, true, 40_000, "final");
        vm.warp(settleTime + core.DISPUTE_WINDOW() + 1);
        assertEq(core.claimableAmount(companyId, alice), 50e18 + voidPaidIn);
        uint256 beforeBalance = pusd.balanceOf(alice); vm.prank(alice); core.claim(companyId);
        assertEq(pusd.balanceOf(alice) - beforeBalance, 50e18 + voidPaidIn);
    }

    function test_InvalidMarketVoidsToPaidInAndCancelsEscrow() public {
        _buy(alice, FireTheCEOv2.MarketKind.Out, true, 100e18);
        uint256 sellQuote = core.quoteSell(companyId, FireTheCEOv2.MarketKind.Out, true, 40e18);
        vm.prank(alice); core.sell(companyId, FireTheCEOv2.MarketKind.Out, true, 40e18, sellQuote);
        (,, uint128 paidIn, uint128 escrow) = core.positions(companyId, 0, alice);
        vm.warp(settleTime); core.resolveCompany(companyId, false, 40_000, "void");
        assertEq(core.claimableAmount(companyId, alice), paidIn); assertGt(escrow, 0);
    }
}
