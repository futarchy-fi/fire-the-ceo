// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {V2TestBase} from "./V2TestBase.sol";
import {FireTheCEOv2} from "../../src/v2/FireTheCEOv2.sol";

contract FireTheCEOv2ObservationsDocketTest is V2TestBase {
    function test_ObservationCumulativeAndTwapMatchAnalyticPrices() public {
        uint256 start = vm.getBlockTimestamp();
        vm.warp(start + 100);
        _buy(alice, FireTheCEOv2.MarketKind.Out, true, 100e18);
        (uint256[] memory prices,,,) = core.getAllPrices();
        vm.warp(start + 200);
        uint32[] memory secondsAgos = new uint32[](3);
        secondsAgos[0] = 0; secondsAgos[1] = 100; secondsAgos[2] = 200;
        uint256[] memory cumulatives = core.observe(companyId * 3, secondsAgos);
        assertEq(cumulatives[2], 0);
        assertEq(cumulatives[1], 50e18);
        assertEq(cumulatives[0], 50e18 + prices[companyId] * 100);
        uint256 twap = (cumulatives[0] - cumulatives[2]) / 200;
        assertEq(twap, (0.5e18 + prices[companyId]) / 2);
    }

    function test_ObserveInterpolatesBetweenWrites() public {
        uint256 start = vm.getBlockTimestamp();
        vm.warp(start + 100); _buy(alice, FireTheCEOv2.MarketKind.Out, true, 100e18);
        vm.warp(start + 200); _buy(alice, FireTheCEOv2.MarketKind.Out, true, 100e18);
        uint32[] memory secondsAgos = new uint32[](1); secondsAgos[0] = 150;
        uint256[] memory cumulative = core.observe(companyId * 3, secondsAgos);
        assertEq(cumulative[0], 25e18);
    }

    function test_ObservationRingHasFixed4096CapacityAndOverwritesOldest() public {
        uint256 start = vm.getBlockTimestamp();
        for (uint256 i = 1; i <= 4097; ++i) {
            vm.warp(start + i); _buy(alice, FireTheCEOv2.MarketKind.Out, true, 1e9);
        }
        (, uint16 cardinality) = core.observationStates(companyId * 3);
        assertEq(cardinality, core.OBSERVATION_BUFFER_SIZE());
        uint32[] memory available = new uint32[](1); available[0] = 4095;
        core.observe(companyId * 3, available);
        uint32[] memory overwritten = new uint32[](1); overwritten[0] = 4096;
        vm.expectRevert(FireTheCEOv2.ObservationTooOld.selector); core.observe(companyId * 3, overwritten);
    }

    function test_TimeAveragePremiumUsesOutMinusStayBuffers() public {
        uint256 start = vm.getBlockTimestamp();
        vm.warp(start + 12 hours); _buy(alice, FireTheCEOv2.MarketKind.Out, true, 500e18);
        (uint256[] memory out,,,) = core.getAllPrices();
        vm.warp(start + 24 hours);
        int256 expected = int256((0.5e18 + out[companyId]) / 2) - int256(0.5e18);
        assertEq(core.timeAvgPremium(companyId, 24 hours), expected);
    }

    function test_DocketRejectsBoostThatDoesNotConsumeNinetyPercentOfTranche() public {
        uint128[3] memory unchanged = [uint128(5_000e18), uint128(5_000e18), uint128(2_000e18)];
        vm.prank(alice); vm.expectRevert(FireTheCEOv2.InvalidBoost.selector); core.proposeBoost(companyId, 100e18, unchanged);
    }

    function test_DocketSplitBaselineRewardCapAndRollover() public {
        uint256 second = core.listCompany("BETA", "Beta", "Grace Hopper", 20_000, horizon, settleTime, 5_000e18, 2_000e18, 0.05e18);
        uint128[3] memory smallBoost = [uint128(5_055e18), uint128(5_055e18), uint128(2_000e18)];
        uint128[3] memory largeBoost = [uint128(10_500e18), uint128(10_500e18), uint128(2_000e18)];
        uint256 aliceBefore = pusd.balanceOf(alice);
        vm.prank(alice); core.proposeBoost(companyId, 100e18, smallBoost);
        FireTheCEOv2.BoostProposal memory small = core.getBoostProposal(horizon, 0);
        assertEq(small.baselinePremium, 0);
        assertGe(small.payment, 92e18); assertLe(small.payment, 100e18);
        (uint256 pool,) = core.docketCycles(horizon); assertEq(pool, 20e18);

        vm.prank(bob); core.proposeBoost(second, 10_000e18, largeBoost);
        (pool,) = core.docketCycles(horizon); assertEq(pool, 2_020e18);

        vm.warp(horizon - 7 days);
        _buy(alice, FireTheCEOv2.MarketKind.Out, true, 1_000e18);
        uint256 aliceBeforeReward = pusd.balanceOf(alice);
        vm.warp(settleTime); core.resolveCompany(companyId, true, 40_000, "source"); core.resolveCompany(second, true, 20_000, "source");
        uint256 paid = core.settleDocket(horizon);
        small = core.getBoostProposal(horizon, 0);
        assertEq(paid, small.reward); assertEq(small.reward, small.payment * 3);
        assertEq(core.pendingDocketRollover(), 2_020e18 - paid);
        assertLt(aliceBeforeReward, aliceBefore - small.payment);
        assertEq(pusd.balanceOf(alice), aliceBeforeReward + small.reward);
    }

    function test_NewTickerPaymentHeldThenRefundedByOwner() public {
        uint256 beforeBalance = pusd.balanceOf(alice);
        vm.prank(alice); uint256 id = core.proposeListing("NEW", 50e18);
        assertEq(pusd.balanceOf(alice), beforeBalance - 50e18);
        FireTheCEOv2.ListingProposal memory proposal = core.getListingProposal(id);
        assertEq(proposal.ticker, "NEW"); assertFalse(proposal.resolved);
        core.resolveListingProposal(id, true);
        assertEq(pusd.balanceOf(alice), beforeBalance);
    }
}
