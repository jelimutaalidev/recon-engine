// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Proxy {
    address public implementation;
    address public upgrader;

    event Upgraded(address indexed implementation);

    modifier onlyUpgrader() {
        require(msg.sender == upgrader, "not upgrader");
        _;
    }

    constructor(address initialImplementation) {
        implementation = initialImplementation;
        upgrader = msg.sender;
    }

    function upgradeTo(address newImplementation) external onlyUpgrader {
        implementation = newImplementation;
        emit Upgraded(newImplementation);
    }

    function execute(bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory result) = implementation.delegatecall(data);
        require(ok, "delegatecall failed");
        return result;
    }

    receive() external payable {}
}
