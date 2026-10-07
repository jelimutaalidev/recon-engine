// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IAdmin.sol";

contract AdminVault is IAdmin {
    address private owner;
    mapping(address => bool) private admins;
    mapping(address => uint256) public deposited;

    event AdminSet(address indexed account, bool allowed);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address initialOwner) {
        owner = initialOwner;
    }

    function setAdmin(address account, bool allowed) external onlyOwner {
        admins[account] = allowed;
        emit AdminSet(account, allowed);
    }

    function isAdmin(address account) external view returns (bool) {
        return admins[account];
    }

    function depositFor(address account, uint256 amount) external onlyOwner {
        deposited[account] += amount;
    }
}
