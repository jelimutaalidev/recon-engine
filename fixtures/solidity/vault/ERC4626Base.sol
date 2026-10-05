// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

abstract contract ERC4626Base {
    uint256 internal _totalAssets;
    bool private _locked;

    modifier nonReentrant() {
        require(!_locked, "reentrancy");
        _locked = true;
        _;
        _locked = false;
    }

    function _touch() internal virtual returns (uint256) {
        return _totalAssets;
    }
}
