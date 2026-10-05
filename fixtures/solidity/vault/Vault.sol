// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IVault.sol";
import "./IStrategy.sol";
import "./ERC4626Base.sol";
import "./MathLib.sol";

contract Vault is ERC4626Base, IVault {
    mapping(address => uint256) internal balances;
    address public strategy;

    event Deposit(address indexed receiver, uint256 assets, uint256 shares);
    error ZeroShares();

    constructor() {
        strategy = address(0);
    }

    function deposit(uint256 assets) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroShares();
        uint256 supply = _totalAssets + assets;
        shares = MathLib.mulDiv(assets, 1e18, supply);
        if (shares == 0) revert ZeroShares();
        balances[msg.sender] += shares;
        _totalAssets = supply;
        emit Deposit(msg.sender, assets, shares);
        return shares;
    }

    function totalAssets() external view returns (uint256) {
        return _totalAssets;
    }

    function previewDeposit(uint256 assets) public view returns (uint256) {
        return MathLib.mulDiv(assets, 1e18, _totalAssets + assets);
    }

    function echo(uint256 assets) external view returns (uint256) {
        return previewDeposit(assets) + this.previewDeposit(assets);
    }

    function echoViaThis(uint256 assets) external view returns (uint256) {
        return this.previewDeposit(assets);
    }

    function harvestViaInterface(IStrategy target) external {
        target.harvest();
    }

    function rebalance() external nonReentrant {
        (bool ok, ) = strategy.call{value: 0}("");
        if (!ok) revert ZeroShares();
        (ok, ) = strategy.delegatecall(abi.encodeWithSignature("harvest()"));
        if (!ok) revert ZeroShares();
        _touch();
    }

    function _touch() internal override returns (uint256) {
        return super._touch() + 1;
    }
}
