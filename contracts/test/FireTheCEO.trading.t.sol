// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {FireTheCEO} from "../src/FireTheCEO.sol";
import {PlayUSD} from "../src/PlayUSD.sol";

contract FireTheCEOTradingTest is Test {
    event Trade(
        uint256 indexed companyId,
        uint8 indexed kind,
        address indexed trader,
        bool isBuy,
        bool longSide,
        uint256 shares,
        uint256 amount
    );

    PlayUSD internal pusd;
    FireTheCEO internal exchange;
    address internal trader = makeAddr("trader");
    uint64 internal horizon;
    uint256 internal companyId;

    function setUp() public {
        pusd = new PlayUSD();
        exchange = new FireTheCEO(address(pusd));
        horizon = uint64(block.timestamp + 30 days);

        pusd.mint(address(this), 100_000e18);
        pusd.approve(address(exchange), type(uint256).max);
        companyId = exchange.listCompany(
            "ACME", "Acme Corp", "Ada Lovelace", 40_000, horizon, horizon + 30 days, 5_000e18, 2_000e18, 0.05e18
        );

        pusd.mint(trader, 1_000_000e18);
        vm.prank(trader);
        pusd.approve(address(exchange), type(uint256).max);
    }

    function test_BuyMovesPriceUpAndChargesQuote() public {
        uint256 shares = 100e18;
        uint256 quote = exchange.quoteBuy(companyId, FireTheCEO.MarketKind.Out, true, shares);
        uint256 beforeBalance = pusd.balanceOf(trader);

        vm.prank(trader);
        uint256 cost = exchange.buy(companyId, FireTheCEO.MarketKind.Out, true, shares, quote);
        (uint256[] memory midOut,,,) = exchange.getAllPrices();

        assertEq(cost, quote);
        assertEq(beforeBalance - pusd.balanceOf(trader), quote);
        assertGt(midOut[companyId], 0.5e18);
        (uint128 sharesL, uint128 sharesS, uint128 paidIn, uint128 escrow) =
            exchange.positions(companyId, uint8(FireTheCEO.MarketKind.Out), trader);
        assertEq(sharesL, shares);
        assertEq(sharesS, 0);
        assertEq(paidIn, quote);
        assertEq(escrow, 0);
    }

    function test_BuyRevertsOverMaxCost() public {
        uint256 quote = exchange.quoteBuy(companyId, FireTheCEO.MarketKind.Out, true, 100e18);
        vm.prank(trader);
        vm.expectRevert(FireTheCEO.SlippageExceeded.selector);
        exchange.buy(companyId, FireTheCEO.MarketKind.Out, true, 100e18, quote - 1);
    }

    function test_SellEscrowsNoTransfer() public {
        _buy(200e18);
        uint256 beforeBalance = pusd.balanceOf(trader);
        uint256 quote = exchange.quoteSell(companyId, FireTheCEO.MarketKind.Out, true, 50e18);

        vm.prank(trader);
        uint256 proceeds = exchange.sell(companyId, FireTheCEO.MarketKind.Out, true, 50e18, quote);
        (,,, uint128 escrow) = exchange.positions(companyId, uint8(FireTheCEO.MarketKind.Out), trader);

        assertEq(proceeds, quote);
        assertEq(pusd.balanceOf(trader), beforeBalance);
        assertEq(escrow, quote);
    }

    function test_SellMoreThanHeldReverts() public {
        _buy(100e18);
        vm.prank(trader);
        vm.expectRevert(FireTheCEO.InsufficientShares.selector);
        exchange.sell(companyId, FireTheCEO.MarketKind.Out, true, 101e18, 0);
    }

    function test_BuyAfterHorizonReverts() public {
        vm.warp(horizon);
        vm.prank(trader);
        vm.expectRevert(FireTheCEO.TradingClosed.selector);
        exchange.buy(companyId, FireTheCEO.MarketKind.Out, true, 100e18, type(uint256).max);
    }

    function test_RoundTripCostsAtLeastTwoDust() public {
        _buy(100e18);
        uint256 quote = exchange.quoteSell(companyId, FireTheCEO.MarketKind.Out, true, 100e18);
        vm.prank(trader);
        exchange.sell(companyId, FireTheCEO.MarketKind.Out, true, 100e18, quote);
        (,, uint128 paidIn, uint128 escrow) = exchange.positions(companyId, uint8(FireTheCEO.MarketKind.Out), trader);

        assertGe(uint256(paidIn) - uint256(escrow), 2 * exchange.DUST());
    }

    function test_ShareCapEnforced() public {
        vm.prank(trader);
        vm.expectRevert(FireTheCEO.ShareCapExceeded.selector);
        exchange.buy(companyId, FireTheCEO.MarketKind.Out, true, 1e27 + 1, type(uint256).max);
    }

    function test_TradeEventEmitted() public {
        uint256 shares = 100e18;
        uint256 quote = exchange.quoteBuy(companyId, FireTheCEO.MarketKind.Out, true, shares);
        vm.expectEmit(true, true, true, true, address(exchange));
        emit Trade(companyId, uint8(FireTheCEO.MarketKind.Out), trader, true, true, shares, quote);

        vm.prank(trader);
        exchange.buy(companyId, FireTheCEO.MarketKind.Out, true, shares, quote);
    }

    function _buy(uint256 shares) internal {
        uint256 quote = exchange.quoteBuy(companyId, FireTheCEO.MarketKind.Out, true, shares);
        vm.prank(trader);
        exchange.buy(companyId, FireTheCEO.MarketKind.Out, true, shares, quote);
    }
}
