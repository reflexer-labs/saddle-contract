# Adaption to Saddle to Enable a RAI meta pool

This temporary file provides documentation for the pull request to add a new meta pool variant to Saddle finance which
allows Saddle and RAI to work together. The goal is described at
[gitcoin](https://gitcoin.co/issue/reflexer-labs/saddle-contract/1/100026701).

## Licence

All changes are made under the MIT License [licence](LICENSE)

## Description of Modifications

To integrate RAI with Saddle it was decided the best strategy was to create a meta pool which would allow RAI to be
paired with the LP token of either the D4 Pool or the Stablecoin Pool V2. The existing meta swap implementation was not
designed to accommodate an asset with a drifting target like RAI, instead of modifying the existing metaswap contract
the approach was to extend saddle and create a new metapool for assets with drifting redemption rates.

To allow RAI to work in the new pool without making major changes RAIs target price is read from the redemption price
snapshot contract and is used similarly to the LP tokens virtual price. Quantities are scaled so assets with slowly
varying values can still be used with the stableswap algorithm. In the original metaSwapUtils the variable
tokenPrecisionMultipliers handles bringing tokens to a common precision with a different method to that used in curve.
For a token with decimals = 18 the value will just be 1, whereas for one with 8 it will be 10 ** 10. As the small
integer can't be scaled, Saddle adds extra separate steps to scale by the virtual price where necessary. Scaling by the
redemption price is required in many more places so continuing that pattern was not suitable, manually adding it in
every necessary scenario was very error-prone and unmaintainable, so the precision mechanism was adapted to always
consider the redemption price and now uses 10 ** 18 as base precision in scaleMultipliers. All precision access now goes
through the scaleMultipliers so redemption price scaling is never missed. This made the solution to addapt saddle for
RAI cleaner and much more reliable. There is an opportunity to improve code in some areas by moving the virtual price
into the same mechanism, but to avoid excessive changes from saddles existing meta contracts VP scaling has been left
separate.

## Contracts
This is a lower level description of changes by file, with DriftingMetaSwapUtils in more detail and last as it contains
all the important functional changes.

[DriftingMetaSwap.sol](contracts/DriftingMeta/DriftingMetaSwap.sol)
Based on MetaSwap.sol with renamed variables and an additional parameter in the initializer and storage to
record the redemptionPriceGetterj contract.

[DriftingMetaSwapDeposit.sol](contracts/DriftingMeta/DriftingMetaSwapDeposit.sol) Based on MetaSwapDeposit.sol with
renaming and an IDriftingMetaSwap interface rather than an IMetaSwap.

[IDriftingMetaSwap.sol](contracts/interfaces/IDriftingMetaSwap.sol)
Based on IMetaSwap.sol, only a slight change to the interface for redemptionPriceGetter being passed in to the
initializer.

[IRedemptionPriceGetter.sol](contracts/interfaces/IRedemptionPriceGetter.sol)
A simple interface to the redemption price getter contract so the drifting meta swap utils can read the redemption price
snapshot.

[RedemptionPriceSnapMock.sol](contracts/mock/RedemptionPriceSnapMock.sol)
Added a mock of the redemption price
provider [contract](https://github.com/reflexer-labs/geb-redemption-price-snap/blob/master/src/RedemptionPriceSnap.sol).
It emulates the generated snappedRedemptionPrice() getter function and adds a setter so the redemption price can be
manipulated during tests.

[004_deploy_DriftingMetaSwapUtils.ts](deploy/004_deploy_DriftingMetaSwapUtils.ts),
[240_check_RAIMetaPoolTokens.ts](deploy/240_check_RAIMetaPoolTokens.ts),
[241_deploy_RAIRedemptionPriceSnapMock.ts](deploy/241_deploy_RAIRedemptionPriceSnapMock.ts),
[242_deploy_RAIMetaPool.ts](deploy/242_deploy_RAIMetaPool.ts),
[243_deploy_RAIMetaPoolDeposit.ts](deploy/243_deploy_RAIMetaPoolDeposit.ts)
These new files extend Saddle's deployment system for the new contracts. In the RAIMetaPool deployer the initial A is
set to "const INITIAL_A = 100" this could potentially be increased to get closer to constant price or decreased so price
changes faster with trading volume like constant product. The redemption price snapshot contract is only deployed if
running on a test network.

[DriftingMetaSwapUtils.sol](contracts/DriftingMeta/DriftingMetaSwapUtils.sol)
This contains the core changes as summarised in Description of Modifications. It is based on MetaSwapUtils.sol. In
addition to renaming, several structs have been modified or added. These are used so that stack depth limitations are
not exceeded and also function somewhat as useful facades. tokenPrecisionMultipliers arrays have been renamed to
scaleMultipliers everywhere which take the redemption price into account as well as the number of decimals used by
tokens. Additional constants have been added to avoid extra calculations to find loop limits from array length such
as BASE_LP_TOKEN_INDEX and NUM_META_TOKENS as we know there are always two tokens in the pool, RAI and the base LP
token.

### _getScaleMultipliers():
This is a new method used to get the array of multiplies used throughout this library. The result is used in place of
tokenPrecisionMultipliers everywhere and uses a base of 10**18 instead of 1 to allow scaling. The values come from
tokenPrecisionMultipliers with the drifting asset multiplied by the redemption price and scaled down to the precision
while the base LP token is scaled up to the precision. The virtual price is not considered here as in other functions
it is not always required like the redemption price is. Note in all usage of the results there will be additional mul()
or divs() to account for the new scale.

Many methods have extra args to give them access to driftingMetaSwapStorage so that they can use it to read the
redemption price while getting scaleMultipliers or calculating _xp().

### _xp():
Formerly this was calculated in SwapUtils but due to the scaleMultipliers change it is now implemented here. The new
implementation allows for the different scale of the multipliers to return the same result.

Other changes are repeated instances of changes mentioned above.

## Tests
Specific tests have been added for the new meta pool based on the existing metapool tests to keep the same coverage
and also add in changing the redemption price. Benchmarks were approximated externally to make sure all tests are
testing for correct results considering the redemption price. To run tests set up according to saddle
[instructions](README.md), note in particular env vars ALCHEMY_API_ROPSTEN and ALCHEMY_API need to be set. Pool specific
tests can be run with "hh test test/driftingMetaSwap.ts"

[test/driftingMetaSwap.ts](test/driftingMetaSwap.ts): All new tests are found here, it has similar coverage to the
preexisting meta swap tests but with different results due to the modified redemption prices. The tests are thousands of
lines and quite well self documenting so each low level change isn't described here.
