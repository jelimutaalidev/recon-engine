// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IGovernance.sol";

contract Governance is IGovernance {
    mapping(bytes32 => bool) public submitted;
    mapping(bytes32 => bool) public executed;

    event ProposalSubmitted(bytes32 indexed proposalId);
    event ProposalExecuted(bytes32 indexed proposalId);

    modifier onlySubmitted(bytes32 proposalId) {
        require(submitted[proposalId], "not submitted");
        _;
    }

    function submitProposal(bytes32 proposalId) external {
        submitted[proposalId] = true;
        emit ProposalSubmitted(proposalId);
    }

    function executeProposal(bytes32 proposalId) external onlySubmitted(proposalId) {
        executed[proposalId] = true;
        emit ProposalExecuted(proposalId);
    }
}
