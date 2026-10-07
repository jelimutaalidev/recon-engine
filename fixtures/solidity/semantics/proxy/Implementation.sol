// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Implementation {
    uint256 public value;
    address public admin;
    bool private initialized;

    function initialize(address initialAdmin) external {
        require(!initialized, "already initialized");
        initialized = true;
        admin = initialAdmin;
    }

    function setValue(uint256 newValue) external {
        value = newValue;
    }
}
