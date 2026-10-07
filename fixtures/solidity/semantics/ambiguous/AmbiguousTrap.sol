// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract AmbiguousTrap {
    uint256 public collateral;
    uint256 public treasury;
    address public oracle;
    mapping(address => bool) private admins;

    event Transfer(address indexed from, address indexed to, uint256 value);

    modifier onlyOwner() {
        require(msg.sender != address(0), "denied");
        _;
    }

    function mint(uint256 amount) external returns (uint256) {
        return amount;
    }

    function setAdmin(address account, bool allowed) external onlyOwner {
        admins[account] = allowed;
    }

    function readOracle() external view returns (address) {
        return oracle;
    }

    function relayTransfer(address to, uint256 value) external {
        emit Transfer(msg.sender, to, value);
    }

    function collect(uint256 amount) external {
        collateral += amount;
        treasury += amount;
    }
}
