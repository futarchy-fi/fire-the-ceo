// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {FireTheCEO} from "../src/FireTheCEO.sol";
import {PlayUSD} from "../src/PlayUSD.sol";

contract FireTheCEOResolutionTest is Test {
    PlayUSD internal pusd;
    FireTheCEO internal exchange;
    address internal trader = makeAddr("trader");
    uint64 internal horizon;
    uint64 internal settleTime;
    uint256 internal companyId;

    function setUp() public {
        pusd = new PlayUSD();
        exchange = new FireTheCEO(address(pusd));
        horizon = uint64(block.timestamp + 30 days);
        settleTime = uint64(block.timestamp + 60 days);

        pusd.mint(address(this), 1_000_000e18);
        pusd.approve(address(exchange), type(uint256).max);
        companyId = _list("ACME");

        pusd.mint(trader, 1_000_000e18);
        vm.prank(trader);
        pusd.approve(address(exchange), type(uint256).max);
    }

    function test_ResolveOnlyOracle() public {
        vm.warp(settleTime);
        vm.prank(trader);
        vm.expectRevert(FireTheCEO.OracleOnly.selector);
        exchange.resolveCompany(companyId, true, 40_000, "source");
    }

    function test_ResolveBeforeSettleReverts() public {
        vm.expectRevert(FireTheCEO.BeforeSettlement.selector);
        exchange.resolveCompany(companyId, true, 40_000, "source");
    }

    function test_ReResolveWithinWindow() public {
        vm.warp(settleTime);
        exchange.resolveCompany(companyId, false, 35_000, "first");
        uint64 firstResolvedAt = exchange.getCompany(companyId).resolvedAt;
        vm.warp(block.timestamp + 1 days);
        exchange.resolveCompany(companyId, true, 45_000, "second");
        FireTheCEO.Company memory company = exchange.getCompany(companyId);

        assertTrue(company.fired);
        assertEq(company.settledPriceCents, 45_000);
        assertEq(company.resolutionURI, "second");
        assertEq(company.resolvedAt, firstResolvedAt);
    }

    function test_ReResolveAfterWindowReverts() public {
        vm.warp(settleTime);
        exchange.resolveCompany(companyId, false, 40_000, "first");
        vm.warp(block.timestamp + exchange.DISPUTE_WINDOW() + 1);
        vm.expectRevert(FireTheCEO.DisputeWindowClosed.selector);
        exchange.resolveCompany(companyId, true, 40_000, "late");
    }

    function test_ClaimBeforeWindowEndsReverts() public {
        vm.warp(settleTime);
        exchange.resolveCompany(companyId, true, 40_000, "source");
        vm.prank(trader);
        vm.expectRevert(FireTheCEO.NotClaimable.selector);
        exchange.claim(companyId);
    }

    function test_ClaimFiredPath() public {
        _buy(companyId, FireTheCEO.MarketKind.Out, true, 100e18);
        _buy(companyId, FireTheCEO.MarketKind.Stay, true, 80e18);
        (,, uint128 stayPaidIn,) = exchange.positions(companyId, uint8(FireTheCEO.MarketKind.Stay), trader);
        _resolve(companyId, true, 40_000);

        uint256 expected = 50e18 + stayPaidIn;
        assertEq(exchange.claimableAmount(companyId, trader), expected);
        uint256 beforeBalance = pusd.balanceOf(trader);
        vm.prank(trader);
        assertEq(exchange.claim(companyId), expected);
        assertEq(pusd.balanceOf(trader) - beforeBalance, expected);
    }

    function test_ClaimRetainedPath() public {
        _buy(companyId, FireTheCEO.MarketKind.Out, true, 80e18);
        _buy(companyId, FireTheCEO.MarketKind.Stay, true, 100e18);
        (,, uint128 outPaidIn,) = exchange.positions(companyId, uint8(FireTheCEO.MarketKind.Out), trader);
        _resolve(companyId, false, 40_000);

        assertEq(exchange.claimableAmount(companyId, trader), uint256(outPaidIn) + 50e18);
    }

    function test_ClaimExitBinaryPayout() public {
        _buy(companyId, FireTheCEO.MarketKind.Exit, true, 100e18);
        _buy(companyId, FireTheCEO.MarketKind.Exit, false, 70e18);
        _resolve(companyId, true, 40_000);

        assertEq(exchange.claimableAmount(companyId, trader), 100e18);
    }

    function test_SellerEscrowPaidOnValid_CancelledOnVoid() public {
        uint256 voidId = _list("VOID");
        _buyThenSell(companyId, 100e18, 40e18);
        _buyThenSell(voidId, 100e18, 40e18);
        (,, uint128 voidPaidIn, uint128 voidEscrow) =
            exchange.positions(voidId, uint8(FireTheCEO.MarketKind.Out), trader);
        (uint128 validShares,,, uint128 validEscrow) =
            exchange.positions(companyId, uint8(FireTheCEO.MarketKind.Out), trader);

        vm.warp(settleTime);
        exchange.resolveCompany(companyId, true, 40_000, "valid");
        exchange.resolveCompany(voidId, false, 40_000, "void");

        assertEq(exchange.claimableAmount(companyId, trader), uint256(validEscrow) + uint256(validShares) / 2);
        assertEq(exchange.claimableAmount(voidId, trader), voidPaidIn);
        assertGt(voidEscrow, 0);
    }

    function test_ClaimTwiceZero() public {
        _buy(companyId, FireTheCEO.MarketKind.Exit, true, 100e18);
        _resolve(companyId, true, 40_000);
        vm.startPrank(trader);
        assertEq(exchange.claim(companyId), 100e18);
        assertEq(exchange.claim(companyId), 0);
        vm.stopPrank();
    }

    function test_SettlementClampsBelowFloorAboveCap() public {
        uint256 highId = _list("HIGH");
        _buy(companyId, FireTheCEO.MarketKind.Out, true, 100e18);
        _buy(companyId, FireTheCEO.MarketKind.Out, false, 80e18);
        _buy(highId, FireTheCEO.MarketKind.Out, true, 100e18);
        _buy(highId, FireTheCEO.MarketKind.Out, false, 80e18);

        vm.warp(settleTime);
        exchange.resolveCompany(companyId, true, 0, "below");
        exchange.resolveCompany(highId, true, 200_000, "above");

        assertEq(exchange.claimableAmount(companyId, trader), 80e18);
        assertEq(exchange.claimableAmount(highId, trader), 100e18);
    }

    function _list(string memory ticker) internal returns (uint256) {
        return exchange.listCompany(ticker, "Company", "CEO", 40_000, horizon, settleTime, 5_000e18, 2_000e18, 0.05e18);
    }

    function _buy(uint256 id, FireTheCEO.MarketKind kind, bool longSide, uint256 shares) internal {
        uint256 quote = exchange.quoteBuy(id, kind, longSide, shares);
        vm.prank(trader);
        exchange.buy(id, kind, longSide, shares, quote);
    }

    function _buyThenSell(uint256 id, uint256 bought, uint256 sold) internal {
        _buy(id, FireTheCEO.MarketKind.Out, true, bought);
        uint256 quote = exchange.quoteSell(id, FireTheCEO.MarketKind.Out, true, sold);
        vm.prank(trader);
        exchange.sell(id, FireTheCEO.MarketKind.Out, true, sold, quote);
    }

    function _resolve(uint256 id, bool fired, uint32 priceCents) internal {
        vm.warp(settleTime);
        exchange.resolveCompany(id, fired, priceCents, "source");
        vm.warp(block.timestamp + exchange.DISPUTE_WINDOW() + 1);
    }
}
