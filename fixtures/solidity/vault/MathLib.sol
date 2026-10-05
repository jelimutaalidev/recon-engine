// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

library MathLib {
    function mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256) {
        if (denominator == 0) return 0;
        return (a * b) / denominator;
    }
}
