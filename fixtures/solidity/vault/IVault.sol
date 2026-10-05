// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IVault {
    function deposit(uint256 assets) external returns (uint256 shares);

    function totalAssets() external view returns (uint256);
}
