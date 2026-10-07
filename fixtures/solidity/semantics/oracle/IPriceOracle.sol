// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IPriceOracle {
    function latestPrice(address asset) external view returns (int256);

    function latestTimestamp(address asset) external view returns (uint256);
}
