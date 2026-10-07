// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IGovernance {
    function submitProposal(bytes32 proposalId) external;

    function executeProposal(bytes32 proposalId) external;
}
