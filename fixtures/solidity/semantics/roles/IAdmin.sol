// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IAdmin {
    function setAdmin(address account, bool allowed) external;

    function isAdmin(address account) external view returns (bool);
}
