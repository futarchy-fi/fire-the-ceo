// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {LMSR} from "../src/LMSR.sol";

contract LMSRHarness {
    function cost(int256 qL, int256 qS, int256 b) external pure returns (int256) {
        return LMSR.cost(qL, qS, b);
    }

    function priceL(int256 qL, int256 qS, int256 b) external pure returns (uint256) {
        return LMSR.priceL(qL, qS, b);
    }

    function buyCost(int256 qL, int256 qS, int256 b, int256 dq, bool onL) external pure returns (int256) {
        return LMSR.buyCost(qL, qS, b, dq, onL);
    }

    function initialQ(int256 b, uint256 p0Wad) external pure returns (int256) {
        return LMSR.initialQ(b, p0Wad);
    }

    function worstCaseLoss(int256 qL, int256 qS, int256 b) external pure returns (uint256) {
        return LMSR.worstCaseLoss(qL, qS, b);
    }
}

contract LMSRTest is Test {
    int256 internal constant WAD = 1e18;
    int256 internal constant B = 5_000e18;
    LMSRHarness internal lmsr;

    function setUp() public {
        lmsr = new LMSRHarness();
    }

    function test_CostSymmetricZero() public view {
        // python3 Decimal(5000) * Decimal(10)**18 * Decimal(2).ln()
        int256 expected = 3_465_735_902_799_726_547_086;
        assertApproxEqRel(uint256(lmsr.cost(0, 0, B)), uint256(expected), 1e9);
    }

    function test_PriceHalfAtZero() public view {
        assertEq(lmsr.priceL(0, 0, B), 0.5e18);
    }

    function test_PriceMatchesSigmoid() public view {
        // python3 Decimal(10)**18 / (1 + Decimal('-0.6').exp())
        uint256 expected = 645_656_306_225_795_452;
        assertApproxEqRel(lmsr.priceL(2_000e18, -1_000e18, B), expected, 1e9);
    }

    function test_BuyCostPositive_SellNegative() public view {
        assertGt(lmsr.buyCost(0, 0, B, 100e18, true), 0);
        assertLt(lmsr.buyCost(0, 0, B, -100e18, true), 0);
    }

    function test_InitialQGivesP0() public view {
        int256 qL = lmsr.initialQ(2_000e18, 0.05e18);
        assertApproxEqRel(lmsr.priceL(qL, 0, 2_000e18), 0.05e18, 1e9);
    }

    function test_WorstCaseLoss_EvenPrior() public view {
        // python3 Decimal(5000) * Decimal(10)**18 * Decimal(2).ln()
        uint256 expected = 3_465_735_902_799_726_547_086;
        assertApproxEqRel(lmsr.worstCaseLoss(0, 0, B), expected, 1e9);
    }

    function test_WorstCaseLoss_SkewedPrior() public view {
        int256 qL = lmsr.initialQ(2_000e18, 0.05e18);
        // python3 Decimal(2000) * Decimal(10)**18 * (Decimal(1) / Decimal('.05')).ln()
        uint256 expected = 5_991_464_547_107_981_986_870;
        assertApproxEqRel(lmsr.worstCaseLoss(qL, 0, 2_000e18), expected, 1e9);
    }

    function testFuzz_CostMonotoneInQ(int256 qLRaw, int256 qSRaw, uint256 dqRaw, bool onL) public view {
        int256 qL = bound(qLRaw, -1e27, 1e27);
        int256 qS = bound(qSRaw, -1e27, 1e27);
        int256 room = onL ? int256(1e27) - qL : int256(1e27) - qS;
        int256 dq = int256(bound(dqRaw, 0, uint256(room)));

        int256 beforeCost = lmsr.cost(qL, qS, B);
        int256 afterCost = onL ? lmsr.cost(qL + dq, qS, B) : lmsr.cost(qL, qS + dq, B);
        assertGe(afterCost, beforeCost);
    }

    function testFuzz_DomainNoRevert(int256 qLRaw, int256 qSRaw, uint256 bRaw) public view {
        int256 qL = bound(qLRaw, -1e27, 1e27);
        int256 qS = bound(qSRaw, -1e27, 1e27);
        int256 b = int256(bound(bRaw, 1e18, 1e24));

        lmsr.cost(qL, qS, b);
        lmsr.priceL(qL, qS, b);
        lmsr.worstCaseLoss(qL, qS, b);
    }
}
