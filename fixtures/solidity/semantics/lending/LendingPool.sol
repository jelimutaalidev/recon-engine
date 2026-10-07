// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract LendingPool {
    uint256 public totalDebt;
    uint256 public totalCollateral;
    uint256 public protocolFees;
    uint256 public userRebates;
    uint256 public feeBps;
    address public pauser;
    bool public paused;

    mapping(address => uint256) public debtOf;
    mapping(address => uint256) public collateralOf;

    event CollateralDeposited(address indexed account, uint256 amount);
    event Borrowed(address indexed account, uint256 amount);
    event FeesAccrued(uint256 protocolShare, uint256 userShare);

    modifier onlyPauser() {
        require(msg.sender == pauser, "not pauser");
        _;
    }

    constructor(address initialPauser, uint256 initialFeeBps) {
        pauser = initialPauser;
        feeBps = initialFeeBps;
    }

    function depositCollateral(uint256 amount) external {
        require(!paused, "paused");
        collateralOf[msg.sender] += amount;
        totalCollateral += amount;
        emit CollateralDeposited(msg.sender, amount);
    }

    function withdrawCollateral(uint256 amount) external {
        require(!paused, "paused");
        collateralOf[msg.sender] -= amount;
        totalCollateral -= amount;
    }

    function borrow(uint256 amount) external {
        require(!paused, "paused");
        require(collateralOf[msg.sender] >= amount, "insufficient collateral");
        debtOf[msg.sender] += amount;
        totalDebt += amount;
        emit Borrowed(msg.sender, amount);
    }

    function repay(uint256 amount) external {
        debtOf[msg.sender] -= amount;
        totalDebt -= amount;
    }

    function accrueFees(uint256 principal) external returns (uint256 fee) {
        fee = (principal * feeBps) / 10_000;
        uint256 protocolShare = (fee * 70) / 100;
        uint256 userShare = fee - protocolShare;
        protocolFees += protocolShare;
        userRebates += userShare;
        emit FeesAccrued(protocolShare, userShare);
        return fee;
    }

    function setPaused(bool value) external onlyPauser {
        paused = value;
    }
}
