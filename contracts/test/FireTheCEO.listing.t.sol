// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {FireTheCEO} from "../src/FireTheCEO.sol";
import {LMSR} from "../src/LMSR.sol";
import {PlayUSD} from "../src/PlayUSD.sol";

contract FireTheCEOListingTest is Test {
    PlayUSD internal pusd;
    FireTheCEO internal exchange;

    uint64 internal horizon;
    uint64 internal settleTime;
    uint128 internal constant B_SCALAR = 5_000e18;
    uint128 internal constant B_EXIT = 2_000e18;

    function setUp() public {
        pusd = new PlayUSD();
        exchange = new FireTheCEO(address(pusd));
        horizon = uint64(block.timestamp + 30 days);
        settleTime = uint64(block.timestamp + 60 days);
        pusd.mint(address(this), 100_000e18);
        pusd.approve(address(exchange), type(uint256).max);
    }

    function test_EnumOrderIsLoadBearing() public pure {
        assertEq(uint8(FireTheCEO.MarketKind.Out), 0);
        assertEq(uint8(FireTheCEO.MarketKind.Stay), 1);
        assertEq(uint8(FireTheCEO.MarketKind.Exit), 2);
    }

    function test_ListStoresCompanyAndBands() public {
        uint256 id = _list(0.05e18);
        FireTheCEO.Company memory company = exchange.getCompany(id);

        assertEq(company.ticker, "ACME");
        assertEq(company.name, "Acme Corp");
        assertEq(company.ceo, "Ada Lovelace");
        assertEq(company.spotCents, 40_000);
        assertEq(company.floorCents, 10_000);
        assertEq(company.capCents, 70_000);
        assertEq(company.horizon, horizon);
        assertEq(company.settleTime, settleTime);
        assertEq(exchange.companyCount(), 1);
        assertEq(exchange.oracle(), address(this));
    }

    function test_ListPullsExactSubsidy() public {
        _list(0.5e18);
        uint256 expected = 2 * LMSR.worstCaseLoss(0, 0, int256(uint256(B_SCALAR)))
            + LMSR.worstCaseLoss(0, 0, int256(uint256(B_EXIT))) + 3 * exchange.DUST();
        assertEq(pusd.balanceOf(address(exchange)), expected);

        // python3 (2 * Decimal(5000) + Decimal(2000)) * Decimal(10)**18 * Decimal(2).ln()
        uint256 expectedReference = 8_317_766_166_719_343_713_006;
        assertApproxEqRel(expected - 3 * exchange.DUST(), expectedReference, 1e9);
    }

    function test_ListSkewedPriorSubsidyHigher() public {
        _list(0.05e18);
        uint256 scalarLoss = 2 * LMSR.worstCaseLoss(0, 0, int256(uint256(B_SCALAR)));
        uint256 exitLoss = pusd.balanceOf(address(exchange)) - scalarLoss - 3 * exchange.DUST();

        // python3 Decimal(2000) * Decimal(10)**18 * (Decimal(1) / Decimal('.05')).ln()
        uint256 expectedReference = 5_991_464_547_107_981_986_870;
        assertApproxEqRel(exitLoss, expectedReference, 1e9);
        assertGt(exitLoss, LMSR.worstCaseLoss(0, 0, int256(uint256(B_EXIT))));
    }

    function test_ExitOpensAtPrior() public {
        uint256 id = _list(0.05e18);
        (,, uint256[] memory pExit,) = exchange.getAllPrices();

        assertApproxEqRel(pExit[id], 0.05e18, 1e9);
    }

    function test_ScalarsOpenAtHalf() public {
        uint256 id = _list(0.05e18);
        (uint256[] memory midOut, uint256[] memory midStay,, uint8[] memory state) = exchange.getAllPrices();

        assertEq(midOut[id], 0.5e18);
        assertEq(midStay[id], 0.5e18);
        assertEq(state[id], 0);
    }

    function test_ListNotOwnerReverts() public {
        vm.prank(makeAddr("not-owner"));
        vm.expectRevert(Ownable.Unauthorized.selector);
        exchange.listCompany(
            "ACME", "Acme Corp", "Ada Lovelace", 40_000, horizon, settleTime, B_SCALAR, B_EXIT, 0.05e18
        );
    }

    function test_QuoteBuyMatchesLMSR() public {
        uint256 id = _list(0.05e18);
        uint256 shares = 100e18;
        uint256 expected =
            uint256(LMSR.buyCost(0, 0, int256(uint256(B_SCALAR)), int256(shares), true)) + exchange.DUST();

        assertEq(exchange.quoteBuy(id, FireTheCEO.MarketKind.Out, true, shares), expected);
    }

    function _list(uint256 prior) internal returns (uint256) {
        return
            exchange.listCompany(
                "ACME", "Acme Corp", "Ada Lovelace", 40_000, horizon, settleTime, B_SCALAR, B_EXIT, prior
            );
    }
}
