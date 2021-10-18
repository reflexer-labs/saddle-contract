// SPDX-License-Identifier: MIT

pragma solidity 0.6.12;

interface ISnappedRedemptionPrice {
    // pool data view functions
    function snappedRedemptionPrice() external view returns (uint256);
}