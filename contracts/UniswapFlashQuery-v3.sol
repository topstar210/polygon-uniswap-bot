// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

interface IERC20 {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function totalSupply() external view returns (uint256);

    function balanceOf(address account) external view returns (uint256);

    function transfer(address to, uint256 amount) external returns (bool);

    function allowance(address owner, address spender) external view returns (uint256);

    function approve(address spender, uint256 amount) external returns (bool);

    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    function decimals() external view returns (uint8);
}


interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function allPools(uint256 i) external view returns (address pool);
    function allPoolsLength() external view returns (uint256);
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function slot0() external view returns (uint160 sqrtPriceX96, uint32 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked);
    function observe(uint32[] calldata secondsAgos) external view returns (uint256[] memory);
}

contract FlashBotsUniswapQuery {
    IUniswapV3Factory public factory;

    constructor(address _factory) {
        factory = IUniswapV3Factory(_factory);
    }

    function getPoolsByIndexRange(uint256 _start, uint256 _stop, uint24 fee) external view returns (address[2][] memory) {
        uint256 allPoolsLength = factory.allPoolsLength();
        if (_stop > allPoolsLength) {
            _stop = allPoolsLength;
        }
        require(_stop >= _start, "start cannot be higher than stop");
        uint256 qty = _stop - _start;
        address[2][] memory result = new address[2][](qty);
        for (uint i = 0; i < qty; i++) {
            address poolAddress = factory.getPool(IUniswapV3Pool(factory.allPools(_start + i)).token0(), IUniswapV3Pool(factory.allPools(_start + i)).token1(), fee);
            result[i][0] = IUniswapV3Pool(poolAddress).token0();
            result[i][1] = IUniswapV3Pool(poolAddress).token1();
        }
        return result;
    }

    function getReserves(IUniswapV3Pool pool) external view returns (uint256[2] memory) {
        (uint160 sqrtPriceX96, uint32 tick, , , , , ) = pool.slot0();
        uint256 priceX96 = uint256(sqrtPriceX96)**2;
        uint32[] memory secondsAgos = new uint32[](2);
        if (tick < 0) {
            secondsAgos[0] = uint32(tick);
            secondsAgos[1] = 0;
        } else {
            secondsAgos[0] = 0;
            secondsAgos[1] = uint32(tick);
        }
        uint256[] memory observations = pool.observe(secondsAgos);
        uint256 reserve0;
        uint256 reserve1;
        if (tick < 0) {
            reserve1 = uint256(observations[0]);
            reserve0 = uint256(observations[1]);
        } else {
            reserve0 = uint256(observations[0]);
            reserve1 = uint256(observations[1]);
        }
        uint256 decimals0 = IERC20(pool.token0()).decimals();
        uint256 decimals1 = IERC20(pool.token1()).decimals();
        return [(reserve0 * priceX96) >> 96 / 10**(18 - decimals0), (reserve1 * priceX96) >> 96 / 10**(18 - decimals1)];
    }

    // function getReserves(IUniswapV3Pool pool) external view returns (uint256[2] memory) {
    //     (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();
    //     uint256 token0Decimals = 10 ** 18; // hardcoded value for 18 decimals
    //     uint256 token1Decimals = 10 ** 18; // hardcoded value for 18 decimals
    //     uint256 reserve0 = IERC20(pool.token0()).balanceOf(address(pool)) * sqrtPriceX96 / (2**96) / token0Decimals;
    //     uint256 reserve1 = IERC20(pool.token1()).balanceOf(address(pool)) * sqrtPriceX96 * (2**32) / (2**96) / token1Decimals;
    //     return [reserve0, reserve1];
    // }

}
