// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IPriceOracle.sol";

contract PriceConsumer {
    IPriceOracle public oracle;
    address public updater;

    mapping(address => int256) public pushedPrice;
    mapping(address => uint256) public pushedAt;

    event PricePushed(address indexed asset, int256 price, uint256 updatedAt);

    modifier onlyUpdater() {
        require(msg.sender == updater, "not updater");
        _;
    }

    constructor(IPriceOracle _oracle, address _updater) {
        oracle = _oracle;
        updater = _updater;
    }

    function readPrice(address asset) external view returns (int256 price) {
        price = oracle.latestPrice(asset);
        return price;
    }

    function readFreshness(address asset) external view returns (uint256 updatedAt) {
        updatedAt = oracle.latestTimestamp(asset);
        return updatedAt;
    }

    function pushPrice(address asset, int256 price, uint256 updatedAt) external onlyUpdater {
        pushedPrice[asset] = price;
        pushedAt[asset] = updatedAt;
        emit PricePushed(asset, price, updatedAt);
    }
}
