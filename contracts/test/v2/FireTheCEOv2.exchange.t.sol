// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "solady/auth/Ownable.sol";
import {V2TestBase, AlwaysValid1271, Reentrant1271} from "./V2TestBase.sol";
import {FireTheCEOv2, FireTheCEOExchangeV2} from "../../src/v2/FireTheCEOv2.sol";

contract FireTheCEOv2ExchangeTest is V2TestBase {
    uint256 internal constant LONG_OUT = 0;
    uint256 internal constant SHORT_OUT = 1;

    function test_TypehashByteExactAgainstReferenceOrderStructs() public view {
        bytes32 expected = keccak256("Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)");
        assertEq(exchange.ORDER_TYPEHASH(), expected);
    }

    function test_SignatureBytesAreExcludedFromHash() public {
        FireTheCEOExchangeV2.Order memory order = _signedOrder(ALICE_PK, LONG_OUT, FireTheCEOExchangeV2.Side.BUY, 40e18, 100e18);
        bytes32 beforeHash = exchange.hashOrder(order); order.signature = hex"deadbeef";
        assertEq(exchange.hashOrder(order), beforeHash);
    }

    function test_ForgedMakerEOAOrderMustRevert() public {
        FireTheCEOExchangeV2.Order memory order = _signedOrder(ALICE_PK, LONG_OUT, FireTheCEOExchangeV2.Side.BUY, 40e18, 100e18);
        order.maker = bob; bytes32 digest = exchange.hashOrder(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ALICE_PK, digest); order.signature = abi.encodePacked(r, s, v);
        _buy(carol, FireTheCEOv2.MarketKind.Out, true, 100e18);
        vm.prank(carol); vm.expectRevert(FireTheCEOExchangeV2.InvalidSignature.selector); exchange.fillOrder(order, 40e18);
    }

    function test_EIP1271SignatureTypeThreeWorks() public {
        AlwaysValid1271 wallet = new AlwaysValid1271(pusd, core); pusd.mint(address(wallet), 100e18);
        FireTheCEOExchangeV2.Order memory order = FireTheCEOExchangeV2.Order({
            salt: 1, maker: address(wallet), signer: address(wallet), taker: address(0), tokenId: LONG_OUT,
            makerAmount: 40e18, takerAmount: 100e18, expiration: horizon - 1, nonce: 0, feeRateBps: 0,
            side: FireTheCEOExchangeV2.Side.BUY, signatureType: FireTheCEOExchangeV2.SignatureType.EIP1271, signature: hex"01"
        });
        _buy(bob, FireTheCEOv2.MarketKind.Out, true, 100e18);
        vm.prank(bob); exchange.fillOrder(order, 40e18);
        (uint128 sharesL,, uint128 paidIn,) = core.positions(companyId, 0, address(wallet));
        assertEq(sharesL, 100e18); assertEq(paidIn, 40e18);
    }

    function test_ComplementaryFillAccountsBothSides() public {
        _buy(bob, FireTheCEOv2.MarketKind.Out, true, 100e18);
        FireTheCEOExchangeV2.Order memory buyOrder = _signedOrder(ALICE_PK, LONG_OUT, FireTheCEOExchangeV2.Side.BUY, 40e18, 100e18);
        vm.prank(bob); exchange.fillOrder(buyOrder, 40e18);
        (uint128 aliceShares,, uint128 alicePaid,) = core.positions(companyId, 0, alice);
        (uint128 bobShares,,, uint128 bobEscrow) = core.positions(companyId, 0, bob);
        FireTheCEOExchangeV2.OrderStatus memory status = exchange.getOrderStatus(exchange.hashOrder(buyOrder));
        assertEq(aliceShares, 100e18); assertEq(alicePaid, 40e18); assertEq(bobShares, 0); assertEq(bobEscrow, 40e18);
        assertTrue(status.isFilledOrCancelled); assertEq(status.remaining, 0);
    }

    function test_MatchComplementaryDecrementsBothOrderStatuses() public {
        _buy(bob, FireTheCEOv2.MarketKind.Out, true, 100e18);
        FireTheCEOExchangeV2.Order memory taker = _signedOrder(ALICE_PK, LONG_OUT, FireTheCEOExchangeV2.Side.BUY, 60e18, 100e18);
        FireTheCEOExchangeV2.Order memory maker = _signedOrder(BOB_PK, LONG_OUT, FireTheCEOExchangeV2.Side.SELL, 100e18, 55e18);
        FireTheCEOExchangeV2.Order[] memory makers = new FireTheCEOExchangeV2.Order[](1); makers[0] = maker;
        uint256[] memory fills = new uint256[](1); fills[0] = 100e18;
        vm.prank(carol); exchange.matchOrders(taker, makers, 60e18, fills);
        assertTrue(exchange.getOrderStatus(exchange.hashOrder(taker)).isFilledOrCancelled);
        assertTrue(exchange.getOrderStatus(exchange.hashOrder(maker)).isFilledOrCancelled);
        (uint128 aliceShares,, uint128 alicePaid,) = core.positions(companyId, 0, alice);
        assertEq(aliceShares, 100e18); assertEq(alicePaid, 55e18);
    }

    function test_MintCollectsExactlyOneAndCreditsComplementaryPair() public {
        FireTheCEOExchangeV2.Order memory longBuy = _signedOrder(ALICE_PK, LONG_OUT, FireTheCEOExchangeV2.Side.BUY, 60e18, 100e18);
        FireTheCEOExchangeV2.Order memory shortBuy = _signedOrder(BOB_PK, SHORT_OUT, FireTheCEOExchangeV2.Side.BUY, 40e18, 100e18);
        FireTheCEOExchangeV2.Order[] memory makers = new FireTheCEOExchangeV2.Order[](1); makers[0] = shortBuy;
        uint256[] memory fills = new uint256[](1); fills[0] = 40e18;
        uint256 beforeBalance = pusd.balanceOf(address(core)); vm.prank(carol); exchange.matchOrders(longBuy, makers, 60e18, fills);
        (uint128 longShares,, uint128 longPaid,) = core.positions(companyId, 0, alice);
        (,uint128 shortShares, uint128 shortPaid,) = core.positions(companyId, 0, bob);
        assertEq(longShares, 100e18); assertEq(shortShares, 100e18); assertEq(longPaid, 60e18); assertEq(shortPaid, 40e18);
        assertEq(pusd.balanceOf(address(core)) - beforeBalance, 100e18);
    }

    function test_MergeCreditsOneToEscrows() public {
        _buy(alice, FireTheCEOv2.MarketKind.Out, true, 100e18); _buy(bob, FireTheCEOv2.MarketKind.Out, false, 100e18);
        FireTheCEOExchangeV2.Order memory longSell = _signedOrder(ALICE_PK, LONG_OUT, FireTheCEOExchangeV2.Side.SELL, 100e18, 60e18);
        FireTheCEOExchangeV2.Order memory shortSell = _signedOrder(BOB_PK, SHORT_OUT, FireTheCEOExchangeV2.Side.SELL, 100e18, 40e18);
        FireTheCEOExchangeV2.Order[] memory makers = new FireTheCEOExchangeV2.Order[](1); makers[0] = shortSell;
        uint256[] memory fills = new uint256[](1); fills[0] = 100e18;
        vm.prank(carol); exchange.matchOrders(longSell, makers, 100e18, fills);
        (uint128 aShares,,, uint128 aEscrow) = core.positions(companyId, 0, alice);
        (,uint128 bShares,, uint128 bEscrow) = core.positions(companyId, 0, bob);
        assertEq(aShares, 0); assertEq(bShares, 0); assertEq(aEscrow, 60e18); assertEq(bEscrow, 40e18);
    }

    function test_PartialRatioRoundingFavorsMaker() public {
        _buy(alice, FireTheCEOv2.MarketKind.Out, true, 3);
        FireTheCEOExchangeV2.Order memory sellOrder = _signedOrder(ALICE_PK, LONG_OUT, FireTheCEOExchangeV2.Side.SELL, 3, 2);
        uint256 beforeBalance = pusd.balanceOf(bob); vm.prank(bob); exchange.fillOrder(sellOrder, 1);
        assertEq(beforeBalance - pusd.balanceOf(bob), 1);
        assertEq(exchange.getOrderStatus(exchange.hashOrder(sellOrder)).remaining, 2);
    }

    function test_ExpiredCancelledAndNonceBumpedFillsRevert() public {
        FireTheCEOExchangeV2.Order memory expired = _signedOrder(ALICE_PK, LONG_OUT, FireTheCEOExchangeV2.Side.BUY, 1e18, 2e18);
        vm.warp(horizon); vm.expectRevert(FireTheCEOExchangeV2.OrderExpired.selector); exchange.fillOrder(expired, 1e18);
        vm.warp(horizon - 10); FireTheCEOExchangeV2.Order memory cancelled = _signedOrder(ALICE_PK, LONG_OUT, FireTheCEOExchangeV2.Side.BUY, 1e18, 2e18);
        vm.prank(alice); exchange.cancelOrder(cancelled); vm.expectRevert(FireTheCEOExchangeV2.OrderFilledOrCancelled.selector); exchange.fillOrder(cancelled, 1e18);
        FireTheCEOExchangeV2.Order memory stale = _signedOrder(ALICE_PK, LONG_OUT, FireTheCEOExchangeV2.Side.BUY, 1e18, 2e18);
        vm.prank(alice); exchange.incrementNonce(); vm.expectRevert(FireTheCEOExchangeV2.InvalidNonce.selector); exchange.fillOrder(stale, 1e18);
    }

    function test_PauseOwnerOnlyAndGatesFills() public {
        vm.prank(alice); vm.expectRevert(Ownable.Unauthorized.selector); exchange.setPaused(true);
        exchange.setPaused(true); FireTheCEOExchangeV2.Order memory order = _signedOrder(ALICE_PK, LONG_OUT, FireTheCEOExchangeV2.Side.BUY, 1e18, 2e18);
        vm.expectRevert(FireTheCEOExchangeV2.Paused.selector); exchange.fillOrder(order, 1e18);
    }

    function test_FeeMaximumValidatedButChargeIsZero() public {
        _buy(bob, FireTheCEOv2.MarketKind.Out, true, 2e18);
        FireTheCEOExchangeV2.Order memory order = _signedOrder(ALICE_PK, LONG_OUT, FireTheCEOExchangeV2.Side.BUY, 1e18, 2e18);
        order.feeRateBps = exchange.MAX_FEE_RATE_BPS() + 1; bytes32 digest = exchange.hashOrder(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ALICE_PK, digest); order.signature = abi.encodePacked(r, s, v);
        vm.prank(bob); vm.expectRevert(FireTheCEOExchangeV2.FeeTooHigh.selector); exchange.fillOrder(order, 1e18);
    }

    function test_SignedMaximumFeeStillChargesZeroSymmetrically() public {
        _buy(bob, FireTheCEOv2.MarketKind.Out, true, 2e18);
        FireTheCEOExchangeV2.Order memory buyOrder = _signedOrder(ALICE_PK, LONG_OUT, FireTheCEOExchangeV2.Side.BUY, 1e18, 2e18);
        buyOrder.feeRateBps = exchange.MAX_FEE_RATE_BPS(); bytes32 digest = exchange.hashOrder(buyOrder);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ALICE_PK, digest); buyOrder.signature = abi.encodePacked(r, s, v);
        uint256 aliceBefore = pusd.balanceOf(alice); vm.prank(bob); exchange.fillOrder(buyOrder, 1e18);
        assertEq(aliceBefore - pusd.balanceOf(alice), 1e18);

        FireTheCEOExchangeV2.Order memory sellOrder = _signedOrder(ALICE_PK, LONG_OUT, FireTheCEOExchangeV2.Side.SELL, 1e18, 0.5e18);
        sellOrder.feeRateBps = exchange.MAX_FEE_RATE_BPS(); digest = exchange.hashOrder(sellOrder);
        (v, r, s) = vm.sign(ALICE_PK, digest); sellOrder.signature = abi.encodePacked(r, s, v);
        uint256 carolBefore = pusd.balanceOf(carol); vm.prank(carol); exchange.fillOrder(sellOrder, 1e18);
        assertEq(carolBefore - pusd.balanceOf(carol), 0.5e18);
    }

    function test_ReentrancyGuardIsSharedByEveryFillEntrypoint() public {
        Reentrant1271 wallet = new Reentrant1271(pusd, core, exchange); pusd.mint(address(wallet), 10e18);
        _buy(bob, FireTheCEOv2.MarketKind.Out, true, 6e18);
        for (uint256 i; i < 3; ++i) {
            FireTheCEOExchangeV2.Order memory order = FireTheCEOExchangeV2.Order({
                salt: i + 100, maker: address(wallet), signer: address(wallet), taker: address(0), tokenId: LONG_OUT,
                makerAmount: 1e18, takerAmount: 2e18, expiration: horizon - 1, nonce: 0, feeRateBps: 0,
                side: FireTheCEOExchangeV2.Side.BUY, signatureType: FireTheCEOExchangeV2.SignatureType.EIP1271, signature: hex"01"
            });
            FireTheCEOExchangeV2.Order[] memory noMakers = new FireTheCEOExchangeV2.Order[](0);
            uint256[] memory noFills = new uint256[](0);
            if (i == 0) wallet.setPayload(abi.encodeCall(exchange.fillOrder, (order, 1e18)));
            else if (i == 1) wallet.setPayload(abi.encodeCall(exchange.matchOrders, (order, noMakers, 1e18, noFills)));
            else wallet.setPayload(abi.encodeCall(exchange.fillWithAmm, (order, noMakers, 1e18, noFills, 2e18)));
            vm.prank(bob); exchange.fillOrder(order, 1e18);
        }
    }

    function test_MintCannotBypassShareCapOrPositionOverflowChecks() public {
        uint256 shares = 2e27 + 1; pusd.mint(alice, shares); pusd.mint(bob, shares);
        uint256 longCost = shares * 60 / 100; uint256 shortCost = shares - longCost;
        FireTheCEOExchangeV2.Order memory longBuy = _signedOrder(ALICE_PK, LONG_OUT, FireTheCEOExchangeV2.Side.BUY, longCost + 1, shares);
        FireTheCEOExchangeV2.Order memory shortBuy = _signedOrder(BOB_PK, SHORT_OUT, FireTheCEOExchangeV2.Side.BUY, shortCost, shares);
        FireTheCEOExchangeV2.Order[] memory makers = new FireTheCEOExchangeV2.Order[](1); makers[0] = shortBuy;
        uint256[] memory fills = new uint256[](1); fills[0] = shortCost;
        vm.expectRevert(FireTheCEOv2.ShareCapExceeded.selector); exchange.matchOrders(longBuy, makers, longCost + 1, fills);
    }

    function test_FillsCannotBypassHorizon() public {
        FireTheCEOExchangeV2.Order memory order = _signedOrder(ALICE_PK, LONG_OUT, FireTheCEOExchangeV2.Side.BUY, 1e18, 2e18);
        order.expiration = 0; bytes32 digest = exchange.hashOrder(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ALICE_PK, digest); order.signature = abi.encodePacked(r, s, v);
        vm.warp(horizon); vm.expectRevert(FireTheCEOv2.TradingClosed.selector); exchange.fillOrder(order, 1e18);
    }

    function test_FillWithAmmRoutesRemainderAndEnforcesBlendedLimit() public {
        _buy(bob, FireTheCEOv2.MarketKind.Out, true, 40e18);
        FireTheCEOExchangeV2.Order memory taker = _signedOrder(ALICE_PK, LONG_OUT, FireTheCEOExchangeV2.Side.BUY, 60e18, 100e18);
        FireTheCEOExchangeV2.Order memory maker = _signedOrder(BOB_PK, LONG_OUT, FireTheCEOExchangeV2.Side.SELL, 40e18, 22e18);
        FireTheCEOExchangeV2.Order[] memory makers = new FireTheCEOExchangeV2.Order[](1); makers[0] = maker;
        uint256[] memory fills = new uint256[](1); fills[0] = 40e18;
        vm.prank(carol); exchange.fillWithAmm(taker, makers, 60e18, fills, 60e18);
        (uint128 shares,, uint128 paid,) = core.positions(companyId, 0, alice);
        assertEq(shares, 100e18); assertLe(paid, 60e18);
    }
}
