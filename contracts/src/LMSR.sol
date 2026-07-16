// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

library LMSR {
    int256 internal constant WAD = 1e18;

    function cost(int256 qL, int256 qS, int256 b) internal pure returns (int256) {
        int256 m = qL > qS ? qL : qS;
        int256 eL = FixedPointMathLib.expWad(((qL - m) * WAD) / b);
        int256 eS = FixedPointMathLib.expWad(((qS - m) * WAD) / b);
        return m + (b * FixedPointMathLib.lnWad(eL + eS)) / WAD;
    }

    function priceL(int256 qL, int256 qS, int256 b) internal pure returns (uint256) {
        int256 m = qL > qS ? qL : qS;
        int256 eL = FixedPointMathLib.expWad(((qL - m) * WAD) / b);
        int256 eS = FixedPointMathLib.expWad(((qS - m) * WAD) / b);
        return uint256((eL * WAD) / (eL + eS));
    }

    function buyCost(int256 qL, int256 qS, int256 b, int256 dq, bool onL) internal pure returns (int256) {
        int256 beforeCost = cost(qL, qS, b);
        int256 afterCost = onL ? cost(qL + dq, qS, b) : cost(qL, qS + dq, b);
        return afterCost - beforeCost;
    }

    function initialQ(int256 b, uint256 p0Wad) internal pure returns (int256 qL0) {
        int256 p = int256(p0Wad);
        qL0 = (b * (FixedPointMathLib.lnWad(p) - FixedPointMathLib.lnWad(WAD - p))) / WAD;
    }

    function worstCaseLoss(int256 qL, int256 qS, int256 b) internal pure returns (uint256) {
        int256 minQ = qL < qS ? qL : qS;
        return uint256(cost(qL, qS, b) - minQ);
    }
}
