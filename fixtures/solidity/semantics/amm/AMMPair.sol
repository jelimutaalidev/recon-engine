// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IERC20.sol";
import "./router/IRouter.sol";

contract AMMPair {
    IERC20 public token0;
    IERC20 public token1;
    IRouter public router;
    address public aggregator;

    uint256 public reserve0;
    uint256 public reserve1;
    uint256 public totalLiquidity;
    mapping(address => uint256) public liquidityOf;

    event LiquidityAdded(address indexed provider, uint256 amount0, uint256 amount1, uint256 shares);
    event LiquidityRemoved(address indexed provider, uint256 amount0, uint256 amount1, uint256 shares);

    constructor(IERC20 _token0, IERC20 _token1, IRouter _router, address _aggregator) {
        token0 = _token0;
        token1 = _token1;
        router = _router;
        aggregator = _aggregator;
    }

    function addLiquidity(uint256 amount0, uint256 amount1) external returns (uint256 shares) {
        token0.transferFrom(msg.sender, address(this), amount0);
        token1.transferFrom(msg.sender, address(this), amount1);
        reserve0 += amount0;
        reserve1 += amount1;
        shares = amount0 + amount1;
        liquidityOf[msg.sender] += shares;
        totalLiquidity += shares;
        emit LiquidityAdded(msg.sender, amount0, amount1, shares);
        return shares;
    }

    function removeLiquidity(uint256 shares) external returns (uint256 amount0, uint256 amount1) {
        amount0 = (reserve0 * shares) / totalLiquidity;
        amount1 = (reserve1 * shares) / totalLiquidity;
        liquidityOf[msg.sender] -= shares;
        totalLiquidity -= shares;
        reserve0 -= amount0;
        reserve1 -= amount1;
        token0.transfer(msg.sender, amount0);
        token1.transfer(msg.sender, amount1);
        emit LiquidityRemoved(msg.sender, amount0, amount1, shares);
        return (amount0, amount1);
    }

    function swapThroughRouter(uint256 amountIn, uint256 amountOutMin, address to)
        external
        returns (uint256 amountOut)
    {
        address[] memory path = new address[](2);
        path[0] = address(token0);
        path[1] = address(token1);
        amountOut = router.swapExactTokensForTokens(amountIn, amountOutMin, path, to, block.timestamp);
        return amountOut;
    }

    function swapThroughAggregator(bytes calldata data) external returns (bool success) {
        (success, ) = aggregator.call(data);
        return success;
    }
}
