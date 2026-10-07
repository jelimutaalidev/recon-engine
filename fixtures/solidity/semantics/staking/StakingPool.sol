// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IERC20.sol";

contract StakingPool {
    IERC20 public stakingToken;
    IERC20 public rewardToken;
    address public keeper;
    address public relayer;

    uint256 public totalStaked;
    uint256 public totalReceipts;
    uint256 public totalRewards;

    mapping(address => uint256) public stakedOf;
    mapping(address => uint256) public receiptOf;
    mapping(address => uint256) public earnedOf;

    event Staked(address indexed account, uint256 amount, uint256 shares);
    event Withdrawn(address indexed account, uint256 amount, uint256 shares);
    event RewardClaimed(address indexed account, uint256 amount);

    modifier onlyKeeper() {
        require(msg.sender == keeper, "not keeper");
        _;
    }

    modifier onlyRelayer() {
        require(msg.sender == relayer, "not relayer");
        _;
    }

    constructor(IERC20 _stakingToken, IERC20 _rewardToken, address _keeper, address _relayer) {
        stakingToken = _stakingToken;
        rewardToken = _rewardToken;
        keeper = _keeper;
        relayer = _relayer;
    }

    function stake(uint256 amount) external returns (uint256 shares) {
        shares = amount;
        stakingToken.transferFrom(msg.sender, address(this), amount);
        stakedOf[msg.sender] += amount;
        receiptOf[msg.sender] += shares;
        totalStaked += amount;
        totalReceipts += shares;
        emit Staked(msg.sender, amount, shares);
        return shares;
    }

    function withdraw(uint256 amount) external returns (uint256 shares) {
        shares = amount;
        stakedOf[msg.sender] -= amount;
        receiptOf[msg.sender] -= shares;
        totalStaked -= amount;
        totalReceipts -= shares;
        stakingToken.transfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, shares);
        return shares;
    }

    function earned(address account) external view returns (uint256) {
        return earnedOf[account];
    }

    function claimRewards() external {
        uint256 reward = earnedOf[msg.sender];
        earnedOf[msg.sender] = 0;
        rewardToken.transfer(msg.sender, reward);
        emit RewardClaimed(msg.sender, reward);
    }

    function notifyRewardAmount(uint256 amount) external onlyKeeper {
        rewardToken.transferFrom(msg.sender, address(this), amount);
        totalRewards += amount;
    }

    function syncRewards(uint256 rewardAmount) external onlyRelayer {
        totalRewards += rewardAmount;
    }
}
