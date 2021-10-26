// SPDX-License-Identifier: MIT

pragma solidity 0.6.12;

interface IRedemptionPriceGetter {
    function snappedRedemptionPrice() external view returns (uint256);
}
