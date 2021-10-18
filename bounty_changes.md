# Changes made to adapt Saddle's meta contracts to RAI.

## A. Created a sub folder contract/meta/metaRAI for the addapted files

## B. MetaSwapRAI.sol

### Addapted from MetaSwap.sol

### Main Changes:
1. Imports and uses the MetaSwapUtilsRAI library instead of the MetaSwapUtils library
2. Added redemptionPriceFeed and redemptionPricePrecisionDiff to the initializeMetaSwap function


## C. MetaSwapUtilsRAI

### Adapted from MetaSwapUtils.sol

### Main Changes:
1. Added RatesInfo struct with redemptionPrice and baseVirtualPrice
2. Added redemptionPriceFeed and redemptionPricePrecisionDiff to the MetaSwap struct
3. Added a RatesInfo field to the following structs: CalculateWithdrawOneTokenDYInfo, ManageLiquidityInfo, SwapUnderlyingInfo, CalculateSwapUnderlyingInfo (used to avoid stack too deep ptoblems)
4. Changed the name of BASE_VIRTUAL_PRICE_PRECISION contstant to RATES_PRECISION (as it represents precision of all rates now)
5. Added _getScaledRedemptionPrice function to get the redemption price from the feed and scale it based on the diff between its precision and the RATES_PRECISION (note the redemption price is retrieved but not updated to avoid turning many common MetaSwap functions from view to non-view. The assumption is the feed updates the value periodically).
6. removed both versions of the _xp function (the function that adjusts balances based on precision and virtual price) and replaced with _xp_mem (which takes redemption price into account as well)
7. added a _getRates function to fill the RatesInfo struct with baseVirtualPrice and redemptionPrice
8. The following functions were changed to use _xp_mem instead of _xp and acount for redemptionPrice where needed: calculateWithdrawOneToken, _calculateWithdrawOneToken, _calculateWithdrawOneTokenDY, calculateSwap, _calculateSwap, swap, swapUnderlying, addLiquidity, removeLiquidityOneToken, removeLiquidityImbalance

## D. redemptionPriceSnapMock

### Emulates the redemption price feed for testing (initial value of 3)
Enables setting a new redemption price and retrieving the current value.

## F. ISnappedRedemptionPrice.sol file added under contracts/interfaces

### Interface to access redemption price feed

based on the contract at 0x07210B8871073228626AB79c296d9b22238f63cE

## G. added 004_deploy_MetaSwapUtilsRAI.ts file under /deploy

### pre-deploys the MetaSwapUtilsRAI contract for testing 

## E. metaSwapRAI.ts file added to tests folder

### testing was adapted from the original Saddle testing scheme for MetaSwap with some changes

### testing setup

For all tests a pool is initalized on MetaSwapRAI with DAI, USDC, USDT as base pool tokens, and RAI (deployed as a generic ERC20) as the additional token. the redemptionPriceSnapMock contract is deployed and used as the redemptionPrice feed and 9 as the rp feed scaling factor (from 27 to 18). The pool is initialized with 1 RAI and 1 base LP token. Note: Many of the saddle tests rely on hardcoded expected values. These were modified to reflect the expected values for the RAI pool. These values are correct when the mock redemption price contract is used with a value of 3 (as well as the rest of the test setup conditions described above.)

### Main testing schenarios:
1. **Basic tests:** retrieving the right values for lp token name, base token addresses, admin fee etc.
2. **Adding liquidity:** correct number of amounts provided, cakculates token amount correctly, contract pause works, actual token amount matches calculated amount when adding liquidity, lp token minted correctly, minAmount condition is enforced. AddLiquidity event emited.
3. **Remove Liquidity:** minAmount enforced, can not remove more than total supply, can remove liquidity even when contract is paused, correct amount of underlying tokens returned, block deadline enforced, remove liquidity event emitted.
4. **Remove Liquidity Imbalance:** correct number of amounts give, can not withdraw more than available, Succeeds with calculated max amount of pool token to be burned (±0.1%), Returns correct amount of burned lpToken, Reverts when user tries to burn more LP tokens than they own, Reverts when minAmounts of underlying tokens are not reached due to front running.Reverts when user tries to burn more LP tokens than they own, Reverts when minAmounts of underlying tokens are not reached due to front running, Reverts when block is mined after deadline,  Emits RemoveLiquidityImbalance event.
5. **Remove Liquidity one token:** Reverts when contract is paused.,, Reverts with 'Token index out of range', Reverts with 'Withdraw exceeds available', Reverts with 'Token not found', Succeeds with calculated token amount as minAmount, Returns correct amount of received token, Reverts when user tries to burn more LP tokens than they own, Reverts when minAmount of underlying token is not reached due to front running, Reverts when block is mined after deadline, Emits RemoveLiquidityOne event
6. **Swap** Reverts when contract is paused, Reverts with 'Token index out of range', Reverts with 'Cannot swap more than you own', Succeeds with expected swap amounts, Reverts when minDy (minimum amount token to receive) is not reached due to front running, Succeeds when using lower minDy even when transaction is front-ran, Returns correct amount of received token, Reverts when block is mined after deadline, Emits TokenSwap event
7. **swap Underlying** Reverts when contract is paused, Reverts with 'Token index out of range', Reverts when minDy (minimum amount token to receive) is not reached due to front running, Succeeds when using lower minDy even when transaction is front-ran, Returns correct amount of received token, Reverts when block is mined after deadline, Emits TokenSwap event, Succeeds with expected swap amounts, From 18 decimal token (meta) to 18 decimal token (base), From 6 decimal token (base) to 18 decimal token (meta), From 18 decimal token (meta) to 6 decimal token (base), From 18 decimal token (base) to 6 decimal token (base)
8. **Get Virtual Price** Returns expected value after initial deposit, Returns expected values after swaps, Returns expected values after imbalanced withdrawal, Value is unchanged after balanced deposits, Value is unchanged after balanced withdrawals
9. **Set Swap Fee** Emits NewSwapFee event, Reverts when called by non-owners, Reverts when fee is higher than the limit, Succeeds when fee is within the limit
10. **Set Admin Fee** Emits NewAdminFee event, Reverts when called by non-owners, Reverts when adminFee is higher than the limit, Succeeds when adminFee is within the limit
11. **Get Admin Balance** Reverts with 'Token index out of range', Is always 0 when adminFee is set to 0, Returns expected amounts after swaps when adminFee is higher than 0
12. **Withdraw Admin Fee** Reverts when called by non-owners, Succeeds when there are no fees withdrawn, Succeeds with expected amount of fees withdrawn (swap), Succeeds with expected amount of fees withdrawn (swapUnderlying), Withdrawing admin fees has no impact on users' withdrawal
13. **Ramp A** Emits RampA event, Succeeds to ramp upwards, Succeeds to ramp downwards, Reverts when non-owner calls it, Reverts with 'Wait 1 day before starting ramp', Reverts with 'Insufficient ramp time', Reverts with 'futureA_ must be > 0 and < MAX_A', Reverts with 'futureA_ is too small', Reverts with 'futureA_ is too large'
14. **Stop Ramp A** Emits StopRampA event, Stop ramp succeeds, Reverts with 'Ramp is already stopped'
15. **Check for timestamp manipulations** Check for maximum differences in A and virtual price when A is increasing, Check for maximum differences in A and virtual price when A is decreasing

### All testing were conducted on a local hardhat node.

### For mainnet fork testing:
1. Add FORK_MAINNET="true" to .env file
2. Remove "chainId: 1," from line 107 of hardhat config
3. Use the live redemption price feed at 0x07210B8871073228626AB79c296d9b22238f63cE to initialize the meta pool on the testing code (instead of the mock contract). Note that some of the expected values will need to be adjusted. 