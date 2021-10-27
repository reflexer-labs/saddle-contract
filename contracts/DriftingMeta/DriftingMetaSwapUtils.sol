// SPDX-License-Identifier: MIT

pragma solidity 0.6.12;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "../LPToken.sol";
import "../interfaces/IRedemptionPriceGetter.sol";
import "../interfaces/ISwap.sol";
import "../MathUtils.sol";
import "../SwapUtils.sol";

/**
 * @title DriftingMetaSwapUtils library
 * @notice A library to be used within DriftingMetaSwap.sol. Contains functions responsible for custody and AMM
 * functionalities.
 *
 * DriftingMetaSwap is a modified version of MetaSwap that allows an asset with a drifting target price to be used to
 * trade against the base LP token.
 *
 * @dev Contracts relying on this library must initialize SwapUtils.Swap struct then use this library
 * for SwapUtils.Swap struct. Note that this library contains both functions called by users and admins.
 * Admin functions should be protected within contracts using this library.
 */
library DriftingMetaSwapUtils {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;
    using MathUtils for uint256;
    using AmplificationUtils for SwapUtils.Swap;

    /*** EVENTS ***/

    event TokenSwap(
        address indexed buyer,
        uint256 tokensSold,
        uint256 tokensBought,
        uint128 soldId,
        uint128 boughtId
    );
    event TokenSwapUnderlying(
        address indexed buyer,
        uint256 tokensSold,
        uint256 tokensBought,
        uint128 soldId,
        uint128 boughtId
    );
    event AddLiquidity(
        address indexed provider,
        uint256[] tokenAmounts,
        uint256[] fees,
        uint256 invariant,
        uint256 lpTokenSupply
    );
    event RemoveLiquidityOne(
        address indexed provider,
        uint256 lpTokenAmount,
        uint256 lpTokenSupply,
        uint256 boughtId,
        uint256 tokensBought
    );
    event RemoveLiquidityImbalance(
        address indexed provider,
        uint256[] tokenAmounts,
        uint256[] fees,
        uint256 invariant,
        uint256 lpTokenSupply
    );
    event NewAdminFee(uint256 newAdminFee);
    event NewSwapFee(uint256 newSwapFee);
    event NewWithdrawFee(uint256 newWithdrawFee);

    struct DriftingMetaSwap {
        // Meta-Swap related parameters
        ISwap baseSwap;
        IRedemptionPriceGetter redemptionPriceGetter;
        uint256 baseVirtualPrice;
        uint256 baseCacheLastUpdated;
        IERC20[] baseTokens;
    }

    // Struct storing variables used in calculations in the
    // calculateWithdrawOneTokenDY function to avoid stack too deep errors
    struct CalculateWithdrawOneTokenDYInfo {
        uint256 d0;
        uint256 d1;
        uint256 newY;
        uint256 feePerToken;
        uint256 preciseA;
        uint256 xpi;
        uint256 i;
        uint256 dy;
    }

    // Struct storing variables used in calculation in removeLiquidityImbalance function
    // to avoid stack too deep error
    struct ManageLiquidityInfo {
        uint256 d0;
        uint256 d1;
        uint256 d2;
        LPToken lpToken;
        uint256 totalSupply;
        uint256 preciseA;
        uint256 baseVirtualPrice;
        uint256[] scaleMultipliers;
        uint256[] newBalances;
    }

    struct CalculateTokenAmountInfo {
        uint256 a;
        uint256 d0;
        uint256 d1;
        uint256 baseVirtualPrice;
    }

    struct SwapInfo {
        uint256 transferredDx;
        uint256 dyAdminFee;
        uint256 dy;
        uint256 dyFee;
        uint256[] scaleMultipliers;
    }

    struct SwapUnderlyingInfo {
        uint256 x;
        uint256 dx;
        uint256 dy;
        uint256[] scaleMultipliers;
        uint256[] oldBalances;
        IERC20[] baseTokens;
        IERC20 tokenFrom;
        uint8 metaIndexFrom;
        IERC20 tokenTo;
        uint8 metaIndexTo;
        uint256 baseVirtualPrice;
    }

    struct CalculateSwapUnderlyingInfo {
        uint256 baseVirtualPrice;
        ISwap baseSwap;
        uint8 baseTokensLength;
        uint8 metaIndexTo;
        uint256 x;
        uint256 dy;
    }

    // the denominator used to calculate admin and LP fees. For example, an
    // LP fee might be something like tradeAmount.mul(fee).div(FEE_DENOMINATOR)
    uint256 private constant FEE_DENOMINATOR = 10**10;

    // Cache expire time for the stored value of base Swap's virtual price
    uint256 public constant BASE_CACHE_EXPIRE_TIME = 10 minutes;
    uint256 public constant PRECISION = 10**18;

    // The precision used by the quasi oracle for the drifting assets target price
    uint256 public constant REDEMPTION_PRICE_EXTRA_PRECISION = 10**9;
    uint256 public constant DRIFT_ASSET_INDEX = 0;
    uint8 public constant BASE_LP_TOKEN_INDEX = 1;  // There are always two tokens in a meta pool
    uint256 public constant NUM_META_TOKENS = 2;

    /*** VIEW & PURE FUNCTIONS ***/

    /**
     * @notice Get multipliers to scale for the precision used by the two tokens and account for the redemption price of
     * the drifting asset.
     * @param self Swap struct to read from
     * @param driftingMetaSwapStorage DriftingMetaSwap struct to read from
     */
    function _getScaleMultipliers(
        SwapUtils.Swap storage self,
        DriftingMetaSwap storage driftingMetaSwapStorage
    ) internal view returns (uint256[] memory) {
        uint256[] memory scaleMultipliers = self.tokenPrecisionMultipliers;
        scaleMultipliers[DRIFT_ASSET_INDEX] = scaleMultipliers[DRIFT_ASSET_INDEX]
            .mul(driftingMetaSwapStorage.redemptionPriceGetter.snappedRedemptionPrice())
            .div(REDEMPTION_PRICE_EXTRA_PRECISION);
        scaleMultipliers[BASE_LP_TOKEN_INDEX] = scaleMultipliers[BASE_LP_TOKEN_INDEX]
            .mul(PRECISION);
        return scaleMultipliers;
    }

    /**
     * @notice Return the stored value of base Swap's virtual price. If
     * value was updated past BASE_CACHE_EXPIRE_TIME, then read it directly
     * from the base Swap contract.
     * @param driftingMetaSwapStorage DriftingMetaSwap struct to read from
     * @return base Swap's virtual price
     */
    function _getBaseVirtualPrice(DriftingMetaSwap storage driftingMetaSwapStorage)
        internal
        view
        returns (uint256)
    {
        if (
            block.timestamp >
            driftingMetaSwapStorage.baseCacheLastUpdated + BASE_CACHE_EXPIRE_TIME
        ) {
            return driftingMetaSwapStorage.baseSwap.getVirtualPrice();
        }
        return driftingMetaSwapStorage.baseVirtualPrice;
    }

    /**
     * @notice Calculate how much the user would receive when withdrawing via single token
     * @param self Swap struct to read from
     * @param driftingMetaSwapStorage DriftingMetaSwap struct to read from
     * @param tokenAmount the amount to withdraw in the pool's precision
     * @param tokenIndex which token will be withdrawn
     * @return dy the amount of token user will receive
     */
    function calculateWithdrawOneToken(
        SwapUtils.Swap storage self,
        DriftingMetaSwap storage driftingMetaSwapStorage,
        uint256 tokenAmount,
        uint8 tokenIndex
    ) external view returns (uint256 dy) {
        (dy, ) = _calculateWithdrawOneToken(
            self,
            driftingMetaSwapStorage,
            tokenAmount,
            tokenIndex,
            _getBaseVirtualPrice(driftingMetaSwapStorage),
            self.lpToken.totalSupply()
        );
    }

    function _calculateWithdrawOneToken(
        SwapUtils.Swap storage self,
        DriftingMetaSwap storage driftingMetaSwapStorage,
        uint256 tokenAmount,
        uint8 tokenIndex,
        uint256 baseVirtualPrice,
        uint256 totalSupply
    ) internal view returns (uint256, uint256) {
        uint256 dy;
        uint256 dySwapFee;

        {
            uint256 currentY;
            uint256 newY;
            uint256[] memory scaleMultipliers = _getScaleMultipliers(self, driftingMetaSwapStorage);

            // Calculate how much to withdraw
            (dy, newY, currentY) = _calculateWithdrawOneTokenDY(
                self,
                driftingMetaSwapStorage,
                tokenIndex,
                tokenAmount,
                baseVirtualPrice,
                totalSupply
            );

            // Calculate the associated swap fee
            dySwapFee = currentY
                .sub(newY)
                .mul(PRECISION)
                .div(scaleMultipliers[tokenIndex])
                .sub(dy);
        }

        return (dy, dySwapFee);
    }

    /**
     * @notice Calculate the dy of withdrawing in one token
     * @param self Swap struct to read from
     * @param driftingMetaSwapStorage DriftingMetaSwap struct to read from
     * @param tokenIndex which token will be withdrawn
     * @param tokenAmount the amount to withdraw in the pools precision
     * @param baseVirtualPrice the virtual price of the base swap's LP token
     * @return the dy excluding swap fee, the new y after withdrawing one token, and current y
     */
    function _calculateWithdrawOneTokenDY(
        SwapUtils.Swap storage self,
        DriftingMetaSwap storage driftingMetaSwapStorage,
        uint8 tokenIndex,
        uint256 tokenAmount,
        uint256 baseVirtualPrice,
        uint256 totalSupply
    )
        internal
        view
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        // Get the current D, then solve the stableswap invariant
        // y_i for D - tokenAmount
        uint256[] memory xp = _xp(self, driftingMetaSwapStorage, baseVirtualPrice);
        require(tokenIndex < xp.length, "Token index out of range");

        CalculateWithdrawOneTokenDYInfo
            memory v = CalculateWithdrawOneTokenDYInfo(
                0,
                0,
                0,
                0,
                self._getAPrecise(),
                0,
                0,
                0
            );
        v.d0 = SwapUtils.getD(xp, v.preciseA);
        v.d1 = v.d0.sub(tokenAmount.mul(v.d0).div(totalSupply));

        require(tokenAmount <= xp[tokenIndex], "Withdraw exceeds available");

        v.newY = SwapUtils.getYD(v.preciseA, tokenIndex, xp, v.d1);

        uint256[] memory xpReduced = new uint256[](xp.length);
        uint256[] memory scaleMultipliers = _getScaleMultipliers(self, driftingMetaSwapStorage);

        v.feePerToken = SwapUtils._feePerToken(self.swapFee, xp.length);
        for (v.i = 0; v.i < xp.length; v.i++) {
            v.xpi = xp[v.i];
            // if i == tokenIndex, dxExpected = xp[i] * d1 / d0 - newY
            // else dxExpected = xp[i] - (xp[i] * d1 / d0)
            // xpReduced[i] -= dxExpected * fee / FEE_DENOMINATOR
            xpReduced[v.i] = v.xpi.sub(
                (
                    (v.i == tokenIndex)
                        ? v.xpi.mul(v.d1).div(v.d0).sub(v.newY)
                        : v.xpi.sub(v.xpi.mul(v.d1).div(v.d0))
                ).mul(v.feePerToken).div(FEE_DENOMINATOR)
            );
        }

        v.dy = xpReduced[tokenIndex].sub(
            SwapUtils.getYD(v.preciseA, tokenIndex, xpReduced, v.d1)
        );

        if (tokenIndex == xp.length.sub(1)) {
            v.dy = v.dy.mul(PRECISION).div(baseVirtualPrice);
        }
        v.dy = v.dy.sub(1).mul(PRECISION).div(scaleMultipliers[tokenIndex]);

        return (v.dy, v.newY, xp[tokenIndex]);
    }

    /**
     * @notice Given a set of balances and precision multipliers, return the
     * precision-adjusted balances. The last element will also get scaled up by
     * the given baseVirtualPrice.
     *
     * @param balances an array of token balances, in their native precisions.
     * These should generally correspond with pooled tokens.
     *
     * @param scaleMultipliers an array of multipliers, corresponding to
     * the amounts in the balances array. When multiplied together they
     * should yield amounts at the pool's precision and scale for the drifting
     * assets target price.
     *
     * @param baseVirtualPrice the base virtual price to scale the balance of the
     * base Swap's LP token.
     *
     * @return an array of amounts "scaled" to the pool's precision
     */
    function _xp(
        uint256[] memory balances,
        uint256[] memory scaleMultipliers,
        uint256 baseVirtualPrice
    ) internal pure returns (uint256[] memory) {
        uint256[] memory xp = new uint256[](NUM_META_TOKENS);
        xp[DRIFT_ASSET_INDEX] = balances[DRIFT_ASSET_INDEX].mul(scaleMultipliers[DRIFT_ASSET_INDEX]).div(PRECISION);
        xp[BASE_LP_TOKEN_INDEX] = balances[BASE_LP_TOKEN_INDEX].mul(baseVirtualPrice).div(PRECISION);
        return xp;
    }

    /**
     * @notice Return the precision-adjusted balances of all tokens in the pool
     * @param self Swap struct to read from
     * @param driftingMetaSwapStorage DriftingMetaSwap struct to read from
     * @return the pool balances "scaled" to the pool's precision, allowing
     * them to be more easily compared.
     */
    function _xp(
        SwapUtils.Swap storage self,
        DriftingMetaSwap storage driftingMetaSwapStorage,
        uint256 baseVirtualPrice
    )
        internal
        view
        returns (uint256[] memory)
    {
        return
            _xp(
                self.balances,
                _getScaleMultipliers(self, driftingMetaSwapStorage),
                baseVirtualPrice
            );
    }

    /**
     * @notice Get the virtual price, to help calculate profit
     * @param self Swap struct to read from
     * @param driftingMetaSwapStorage DriftingMetaSwap struct to read from
     * @return the virtual price, scaled to precision of PRECISION
     */
    function getVirtualPrice(
        SwapUtils.Swap storage self,
        DriftingMetaSwap storage driftingMetaSwapStorage
    ) external view returns (uint256) {
        uint256 d = SwapUtils.getD(
            _xp(
                self.balances,
                _getScaleMultipliers(self, driftingMetaSwapStorage),
                _getBaseVirtualPrice(driftingMetaSwapStorage)
            ),
            self._getAPrecise()
        );
        uint256 supply = self.lpToken.totalSupply();
        if (supply != 0) {
            return d.mul(PRECISION).div(supply);
        }
        return 0;
    }

    /**
     * @notice Externally calculates a swap between two tokens. The SwapUtils.Swap storage and
     * DriftingMetaSwap storage should be from the same DriftingMetaSwap contract.
     * @param self Swap struct to read from
     * @param driftingMetaSwapStorage DriftingMetaSwap struct from the same contract
     * @param tokenIndexFrom the token to sell
     * @param tokenIndexTo the token to buy
     * @param dx the number of tokens to sell. If the token charges a fee on transfers,
     * use the amount that gets transferred after the fee.
     * @return dy the number of tokens the user will get
     */
    function calculateSwap(
        SwapUtils.Swap storage self,
        DriftingMetaSwap storage driftingMetaSwapStorage,
        uint8 tokenIndexFrom,
        uint8 tokenIndexTo,
        uint256 dx
    ) external view returns (uint256 dy) {
        (dy, ) = _calculateSwap(
            self,
            driftingMetaSwapStorage,
            tokenIndexFrom,
            tokenIndexTo,
            dx,
            _getBaseVirtualPrice(driftingMetaSwapStorage)
        );
    }

    /**
     * @notice Internally calculates a swap between two tokens.
     *
     * @dev The caller is expected to transfer the actual amounts (dx and dy)
     * using the token contracts.
     *
     * @param self Swap struct to read from
     * @param driftingMetaSwapStorage DriftingMetaSwap struct to read from
     * @param tokenIndexFrom the token to sell
     * @param tokenIndexTo the token to buy
     * @param dx the number of tokens to sell. If the token charges a fee on transfers,
     * use the amount that gets transferred after the fee.
     * @param baseVirtualPrice the virtual price of the base LP token
     * @return dy the number of tokens the user will get and dyFee the associated fee
     */
    function _calculateSwap(
        SwapUtils.Swap storage self,
        DriftingMetaSwap storage driftingMetaSwapStorage,
        uint8 tokenIndexFrom,
        uint8 tokenIndexTo,
        uint256 dx,
        uint256 baseVirtualPrice
    ) internal view returns (uint256 dy, uint256 dyFee) {
        uint256[] memory xp = _xp(self, driftingMetaSwapStorage, baseVirtualPrice);
        require(
            tokenIndexFrom < xp.length && tokenIndexTo < xp.length,
            "Token index out of range"
        );
        uint256[] memory scaleMultipliers = _getScaleMultipliers(self, driftingMetaSwapStorage);
        uint256 x = dx.mul(scaleMultipliers[tokenIndexFrom]).div(PRECISION);
        x = x.add(xp[tokenIndexFrom]);
        uint256 y = SwapUtils.getY(
            self._getAPrecise(),
            tokenIndexFrom,
            tokenIndexTo,
            x,
            xp
        );
        dy = xp[tokenIndexTo].sub(y).sub(1);
        dyFee = dy.mul(self.swapFee).div(FEE_DENOMINATOR);
        dy = dy.sub(dyFee).mul(PRECISION).div(scaleMultipliers[tokenIndexTo]);
    }

    /**
     * @notice Calculates the expected return amount from swapping between
     * the pooled tokens and the underlying tokens of the base Swap pool.
     *
     * @param self Swap struct to read from
     * @param driftingMetaSwapStorage DriftingMetaSwap struct from the same contract
     * @param tokenIndexFrom the token to sell
     * @param tokenIndexTo the token to buy
     * @param dx the number of tokens to sell. If the token charges a fee on transfers,
     * use the amount that gets transferred after the fee.
     * @return dy the number of tokens the user will get
     */
    function calculateSwapUnderlying(
        SwapUtils.Swap storage self,
        DriftingMetaSwap storage driftingMetaSwapStorage,
        uint8 tokenIndexFrom,
        uint8 tokenIndexTo,
        uint256 dx
    ) external view returns (uint256) {
        CalculateSwapUnderlyingInfo memory v = CalculateSwapUnderlyingInfo(
            _getBaseVirtualPrice(driftingMetaSwapStorage),
            driftingMetaSwapStorage.baseSwap,
            uint8(driftingMetaSwapStorage.baseTokens.length),
            0,
            0,
            0
        );

        uint256[] memory xp = _xp(self, driftingMetaSwapStorage, v.baseVirtualPrice);
        uint256[] memory scaleMultipliers = _getScaleMultipliers(self, driftingMetaSwapStorage);
        {
            uint8 maxRange = BASE_LP_TOKEN_INDEX + v.baseTokensLength;
            require(
                tokenIndexFrom < maxRange && tokenIndexTo < maxRange,
                "Token index out of range"
            );
        }
        if (tokenIndexFrom < BASE_LP_TOKEN_INDEX) {
            v.x = xp[tokenIndexFrom].add(dx.mul(scaleMultipliers[tokenIndexFrom]).div(PRECISION));
        } else {
            // tokenFrom is from the base pool
            tokenIndexFrom = tokenIndexFrom - BASE_LP_TOKEN_INDEX;
            if (tokenIndexTo < BASE_LP_TOKEN_INDEX) {
                uint256[] memory baseInputs = new uint256[](v.baseTokensLength);
                baseInputs[tokenIndexFrom] = dx;
                v.x = v
                    .baseSwap
                    .calculateTokenAmount(baseInputs, true)
                    .mul(v.baseVirtualPrice)
                    .div(PRECISION)
                    .add(xp[BASE_LP_TOKEN_INDEX]);
            } else {
                // both from and to are from the base pool
                return
                    v.baseSwap.calculateSwap(
                        tokenIndexFrom,
                        tokenIndexTo - BASE_LP_TOKEN_INDEX,
                        dx
                    );
            }
            tokenIndexFrom = BASE_LP_TOKEN_INDEX;
        }

        v.metaIndexTo = BASE_LP_TOKEN_INDEX;
        if (tokenIndexTo < BASE_LP_TOKEN_INDEX) {
            v.metaIndexTo = tokenIndexTo;
        }

        {
            uint256 y = SwapUtils.getY(
                self._getAPrecise(),
                tokenIndexFrom,
                v.metaIndexTo,
                v.x,
                xp
            );
            v.dy = xp[v.metaIndexTo].sub(y).sub(1);
            uint256 dyFee = v.dy.mul(self.swapFee).div(FEE_DENOMINATOR);
            v.dy = v.dy.sub(dyFee);
        }

        if (tokenIndexTo < BASE_LP_TOKEN_INDEX) {
            // tokenTo is from this pool
            v.dy = v.dy.mul(PRECISION).div(scaleMultipliers[v.metaIndexTo]);
        } else {
            // tokenTo is from the base pool
            v.dy = v.baseSwap.calculateRemoveLiquidityOneToken(
                v.dy.mul(PRECISION).div(v.baseVirtualPrice),
                tokenIndexTo - BASE_LP_TOKEN_INDEX
            );
        }

        return v.dy;
    }

    /**
     * @notice A simple method to calculate prices from deposits or
     * withdrawals, excluding fees but including slippage. This is
     * helpful as an input into the various "min" parameters on calls
     * to fight front-running
     *
     * @dev This shouldn't be used outside frontends for user estimates.
     *
     * @param self Swap struct to read from
     * @param driftingMetaSwapStorage DriftingMetaSwap struct to read from
     * @param amounts an array of token amounts to deposit or withdrawal,
     * corresponding to pooledTokens. The amount should be in each
     * pooled token's native precision. If a token charges a fee on transfers,
     * use the amount that gets transferred after the fee.
     * @param deposit whether this is a deposit or a withdrawal
     * @return if deposit was true, total amount of lp token that will be minted and if
     * deposit was false, total amount of lp token that will be burned
     */
    function calculateTokenAmount(
        SwapUtils.Swap storage self,
        DriftingMetaSwap storage driftingMetaSwapStorage,
        uint256[] calldata amounts,
        bool deposit
    ) external view returns (uint256) {
        CalculateTokenAmountInfo memory v = CalculateTokenAmountInfo(
            self._getAPrecise(),
            0,
            0,
            _getBaseVirtualPrice(driftingMetaSwapStorage)
        );

        {
            uint256[] memory balances1 = self.balances;
            uint256[] memory scaleMultipliers = _getScaleMultipliers(self, driftingMetaSwapStorage);
            uint256 numTokens = balances1.length;
            v.d0 = SwapUtils.getD(
                _xp(
                    balances1,
                    scaleMultipliers,
                    v.baseVirtualPrice
                ),
                v.a
            );
            for (uint256 i = 0; i < numTokens; i++) {
                if (deposit) {
                    balances1[i] = balances1[i].add(amounts[i]);
                } else {
                    balances1[i] = balances1[i].sub(
                        amounts[i],
                        "Cannot withdraw more than available"
                    );
                }
            }
            v.d1 = SwapUtils.getD(
                _xp(
                    balances1,
                    scaleMultipliers,
                    v.baseVirtualPrice
                ),
                v.a
            );
        }
        uint256 totalSupply = self.lpToken.totalSupply();

        if (deposit) {
            return v.d1.sub(v.d0).mul(totalSupply).div(v.d0);
        } else {
            return v.d0.sub(v.d1).mul(totalSupply).div(v.d0);
        }
    }

    /*** STATE MODIFYING FUNCTIONS ***/

    /**
     * @notice swap two tokens in the pool
     * @param self Swap struct to read from and write to
     * @param driftingMetaSwapStorage DriftingMetaSwap struct to read from and write to
     * @param tokenIndexFrom the token the user wants to sell
     * @param tokenIndexTo the token the user wants to buy
     * @param dx the amount of tokens the user wants to sell
     * @param minDy the min amount the user would like to receive, or revert.
     * @return amount of token user received on swap
     */
    function swap(
        SwapUtils.Swap storage self,
        DriftingMetaSwap storage driftingMetaSwapStorage,
        uint8 tokenIndexFrom,
        uint8 tokenIndexTo,
        uint256 dx,
        uint256 minDy
    ) external returns (uint256) {
        SwapInfo memory v = SwapInfo(
            0,
            0,
            0,
            0,
            _getScaleMultipliers(self, driftingMetaSwapStorage)
        );
        {
            uint256 pooledTokensLength = self.pooledTokens.length;
            require(
                tokenIndexFrom < pooledTokensLength &&
                    tokenIndexTo < pooledTokensLength,
                "Token index is out of range"
            );
        }

        {
            IERC20 tokenFrom = self.pooledTokens[tokenIndexFrom];
            require(
                dx <= tokenFrom.balanceOf(msg.sender),
                "Cannot swap more than you own"
            );

            {
                // Transfer tokens first to see if a fee was charged on transfer
                uint256 beforeBalance = tokenFrom.balanceOf(address(this));
                tokenFrom.safeTransferFrom(msg.sender, address(this), dx);

                // Use the actual transferred amount for AMM math
                v.transferredDx = tokenFrom.balanceOf(address(this)).sub(
                    beforeBalance
                );
            }
        }

        (v.dy, v.dyFee) = _calculateSwap(
            self,
            driftingMetaSwapStorage,
            tokenIndexFrom,
            tokenIndexTo,
            v.transferredDx,
            _updateBaseVirtualPrice(driftingMetaSwapStorage)
        );
        require(v.dy >= minDy, "Swap didn't result in min tokens");

        v.dyAdminFee = v.dyFee.mul(self.adminFee).div(FEE_DENOMINATOR).mul(PRECISION).div(
            v.scaleMultipliers[tokenIndexTo]
        );

        self.balances[tokenIndexFrom] = self.balances[tokenIndexFrom].add(
            v.transferredDx
        );
        self.balances[tokenIndexTo] = self.balances[tokenIndexTo].sub(v.dy).sub(
            v.dyAdminFee
        );

        self.pooledTokens[tokenIndexTo].safeTransfer(msg.sender, v.dy);

        emit TokenSwap(
            msg.sender,
            v.transferredDx,
                v.dy,
            tokenIndexFrom,
            tokenIndexTo
        );

        return v.dy;
    }

    /**
     * @notice Swaps with the underlying tokens of the base Swap pool. For this function,
     * the token indices are flattened out so that underlying tokens are represented
     * in the indices.
     * @dev Since this calls multiple external functions during the execution,
     * it is recommended to protect any function that depends on this with reentrancy guards.
     * @param self Swap struct to read from and write to
     * @param driftingMetaSwapStorage DriftingMetaSwap struct to read from and write to
     * @param tokenIndexFrom the token the user wants to sell
     * @param tokenIndexTo the token the user wants to buy
     * @param dx the amount of tokens the user wants to sell
     * @param minDy the min amount the user would like to receive, or revert.
     * @return amount of token user received on swap
     */
    function swapUnderlying(
        SwapUtils.Swap storage self,
        DriftingMetaSwap storage driftingMetaSwapStorage,
        uint8 tokenIndexFrom,
        uint8 tokenIndexTo,
        uint256 dx,
        uint256 minDy
    ) external returns (uint256) {
        SwapUnderlyingInfo memory v = SwapUnderlyingInfo(
            0,
            0,
            0,
            _getScaleMultipliers(self, driftingMetaSwapStorage),
            self.balances,
            driftingMetaSwapStorage.baseTokens,
            IERC20(address(0)),
            0,
            IERC20(address(0)),
            0,
            _updateBaseVirtualPrice(driftingMetaSwapStorage)
        );

        {
            uint8 maxRange = uint8(BASE_LP_TOKEN_INDEX + v.baseTokens.length);
            require(
                tokenIndexFrom < maxRange && tokenIndexTo < maxRange,
                "Token index out of range"
            );
        }

        ISwap baseSwap = driftingMetaSwapStorage.baseSwap;

        // Find the address of the token swapping from and the index in DriftingMetaSwap's token list
        if (tokenIndexFrom < BASE_LP_TOKEN_INDEX) {
            v.tokenFrom = self.pooledTokens[tokenIndexFrom];
            v.metaIndexFrom = tokenIndexFrom;
        } else {
            v.tokenFrom = v.baseTokens[tokenIndexFrom - BASE_LP_TOKEN_INDEX];
            v.metaIndexFrom = BASE_LP_TOKEN_INDEX;
        }

        // Find the address of the token swapping to and the index in DriftingMetaSwap's token list
        if (tokenIndexTo < BASE_LP_TOKEN_INDEX) {
            v.tokenTo = self.pooledTokens[tokenIndexTo];
            v.metaIndexTo = tokenIndexTo;
        } else {
            v.tokenTo = v.baseTokens[tokenIndexTo - BASE_LP_TOKEN_INDEX];
            v.metaIndexTo = BASE_LP_TOKEN_INDEX;
        }

        // Check for possible fee on transfer
        v.dx = v.tokenFrom.balanceOf(address(this));
        v.tokenFrom.safeTransferFrom(msg.sender, address(this), dx);
        v.dx = v.tokenFrom.balanceOf(address(this)).sub(v.dx); // update dx in case of fee on transfer

        if (
            tokenIndexFrom < BASE_LP_TOKEN_INDEX || tokenIndexTo < BASE_LP_TOKEN_INDEX
        ) {
            // Either one of the tokens belongs to the DriftingMetaSwap tokens list
            uint256[] memory xp = _xp(
                v.oldBalances,
                v.scaleMultipliers,
                v.baseVirtualPrice
            );

            if (tokenIndexFrom < BASE_LP_TOKEN_INDEX) {
                // Swapping from a DriftingMetaSwap token
                v.x = xp[tokenIndexFrom].add(
                    dx.mul(v.scaleMultipliers[tokenIndexFrom]).div(PRECISION)
                );
            } else {
                // Swapping from a base Swap token
                // This case requires adding the underlying token to the base Swap, then
                // using the base LP token to swap to the desired token
                uint256[] memory baseAmounts = new uint256[](
                    v.baseTokens.length
                );
                baseAmounts[tokenIndexFrom - BASE_LP_TOKEN_INDEX] = v.dx;

                // Add liquidity to the underlying Swap contract and receive base LP token
                v.dx = baseSwap.addLiquidity(baseAmounts, 0, block.timestamp);

                // Calculate the value of total amount of baseLPToken we end up with
                v.x = v
                    .dx
                    .mul(v.baseVirtualPrice)
                    .div(PRECISION)
                    .add(xp[BASE_LP_TOKEN_INDEX]);
            }

            // Calculate how much to withdraw in DriftingMetaSwap level and the the associated swap fee
            uint256 dyFee;
            {
                uint256 y = SwapUtils.getY(
                    self._getAPrecise(),
                    v.metaIndexFrom,
                    v.metaIndexTo,
                    v.x,
                    xp
                );
                v.dy = xp[v.metaIndexTo].sub(y).sub(1);
                dyFee = v.dy.mul(self.swapFee).div(FEE_DENOMINATOR);
                v.dy = v.dy.sub(dyFee).mul(PRECISION).div(v.scaleMultipliers[v.metaIndexTo]);
            }
            if (tokenIndexTo >= BASE_LP_TOKEN_INDEX) {
                // When swapping to a base Swap token, scale down dy by its virtual price
                v.dy = v.dy.mul(PRECISION).div(
                    v.baseVirtualPrice
                );
            }

            // Update the balances array according to the calculated input and output amount
            {
                uint256 dyAdminFee = dyFee.mul(self.adminFee).div(
                    FEE_DENOMINATOR
                );
                dyAdminFee = dyAdminFee.mul(PRECISION).div(
                    v.scaleMultipliers[v.metaIndexTo]
                );
                self.balances[v.metaIndexFrom] = v
                    .oldBalances[v.metaIndexFrom]
                    .add(v.dx);
                self.balances[v.metaIndexTo] = v
                    .oldBalances[v.metaIndexTo]
                    .sub(v.dy)
                    .sub(dyAdminFee);
            }

            if (tokenIndexTo >= BASE_LP_TOKEN_INDEX) {
                // When swapping to a token that belongs to the base Swap, burn the LP token
                // and withdraw the desired token from the base pool
                uint256 oldBalance = v.tokenTo.balanceOf(address(this));
                baseSwap.removeLiquidityOneToken(
                    v.dy,
                    tokenIndexTo - BASE_LP_TOKEN_INDEX,
                    0,
                    block.timestamp
                );
                v.dy = v.tokenTo.balanceOf(address(this)) - oldBalance;
            }

            // Check the amount of token to send meets minDy
            require(v.dy >= minDy, "Swap didn't result in min tokens");
        } else {
            // Both tokens are from the base Swap pool
            // Do a swap through the base Swap
            v.dy = v.tokenTo.balanceOf(address(this));
            baseSwap.swap(
                tokenIndexFrom - BASE_LP_TOKEN_INDEX,
                tokenIndexTo - BASE_LP_TOKEN_INDEX,
                v.dx,
                minDy,
                block.timestamp
            );
            v.dy = v.tokenTo.balanceOf(address(this)).sub(v.dy);
        }

        // Send the desired token to the caller
        v.tokenTo.safeTransfer(msg.sender, v.dy);

        emit TokenSwapUnderlying(
            msg.sender,
            dx,
            v.dy,
            tokenIndexFrom,
            tokenIndexTo
        );

        return v.dy;
    }

    /**
     * @notice Add liquidity to the pool
     * @param self Swap struct to read from and write to
     * @param driftingMetaSwapStorage DriftingMetaSwap struct to read from and write to
     * @param amounts the amounts of each token to add, in their native precision
     * @param minToMint the minimum LP tokens adding this amount of liquidity
     * should mint, otherwise revert. Handy for front-running mitigation
     * allowed addresses. If the pool is not in the guarded launch phase, this parameter will be ignored.
     * @return amount of LP token user received
     */
    function addLiquidity(
        SwapUtils.Swap storage self,
        DriftingMetaSwap storage driftingMetaSwapStorage,
        uint256[] memory amounts,
        uint256 minToMint
    ) external returns (uint256) {
        IERC20[] memory pooledTokens = self.pooledTokens;
        require(
            amounts.length == pooledTokens.length,
            "Amounts must match pooled tokens"
        );

        uint256[] memory fees = new uint256[](pooledTokens.length);

        // current state
        ManageLiquidityInfo memory v = ManageLiquidityInfo(
            0,
            0,
            0,
            self.lpToken,
            0,
            self._getAPrecise(),
            _updateBaseVirtualPrice(driftingMetaSwapStorage),
            _getScaleMultipliers(self, driftingMetaSwapStorage),
            self.balances
        );
        v.totalSupply = v.lpToken.totalSupply();

        if (v.totalSupply != 0) {
            v.d0 = SwapUtils.getD(
                _xp(
                    v.newBalances,
                    v.scaleMultipliers,
                    v.baseVirtualPrice
                ),
                v.preciseA
            );
        }

        for (uint256 i = 0; i < pooledTokens.length; i++) {
            require(
                v.totalSupply != 0 || amounts[i] > 0,
                "Must supply all tokens in pool"
            );

            // Transfer tokens first to see if a fee was charged on transfer
            if (amounts[i] != 0) {
                uint256 beforeBalance = pooledTokens[i].balanceOf(
                    address(this)
                );
                pooledTokens[i].safeTransferFrom(
                    msg.sender,
                    address(this),
                    amounts[i]
                );

                // Update the amounts[] with actual transfer amount
                amounts[i] = pooledTokens[i].balanceOf(address(this)).sub(
                    beforeBalance
                );
            }

            v.newBalances[i] = v.newBalances[i].add(amounts[i]);
        }

        // invariant after change
        v.d1 = SwapUtils.getD(
            _xp(v.newBalances, v.scaleMultipliers, v.baseVirtualPrice),
            v.preciseA
        );
        require(v.d1 > v.d0, "D should increase");

        // updated to reflect fees and calculate the user's LP tokens
        v.d2 = v.d1;
        uint256 toMint;

        if (v.totalSupply != 0) {
            uint256 feePerToken = SwapUtils._feePerToken(
                self.swapFee,
                pooledTokens.length
            );
            for (uint256 i = 0; i < pooledTokens.length; i++) {
                uint256 idealBalance = v.d1.mul(self.balances[i]).div(v.d0);
                fees[i] = feePerToken
                    .mul(idealBalance.difference(v.newBalances[i]))
                    .div(FEE_DENOMINATOR);
                self.balances[i] = v.newBalances[i].sub(
                    fees[i].mul(self.adminFee).div(FEE_DENOMINATOR)
                );
                v.newBalances[i] = v.newBalances[i].sub(fees[i]);
            }
            v.d2 = SwapUtils.getD(
                _xp(
                    v.newBalances,
                    v.scaleMultipliers,
                    v.baseVirtualPrice
                ),
                v.preciseA
            );
            toMint = v.d2.sub(v.d0).mul(v.totalSupply).div(v.d0);
        } else {
            // the initial depositor doesn't pay fees
            self.balances = v.newBalances;
            toMint = v.d1;
        }

        require(toMint >= minToMint, "Couldn't mint min requested");

        // mint the user's LP tokens
        self.lpToken.mint(msg.sender, toMint);

        emit AddLiquidity(
            msg.sender,
            amounts,
            fees,
            v.d1,
            v.totalSupply.add(toMint)
        );

        return toMint;
    }

    /**
     * @notice Remove liquidity from the pool all in one token.
     * @param self Swap struct to read from and write to
     * @param driftingMetaSwapStorage DriftingMetaSwap struct to read from and write to
     * @param tokenAmount the amount of the lp tokens to burn
     * @param tokenIndex the index of the token you want to receive
     * @param minAmount the minimum amount to withdraw, otherwise revert
     * @return amount chosen token that user received
     */
    function removeLiquidityOneToken(
        SwapUtils.Swap storage self,
        DriftingMetaSwap storage driftingMetaSwapStorage,
        uint256 tokenAmount,
        uint8 tokenIndex,
        uint256 minAmount
    ) external returns (uint256) {
        LPToken lpToken = self.lpToken;
        uint256 totalSupply = lpToken.totalSupply();
        uint256 numTokens = self.pooledTokens.length;
        require(tokenAmount <= lpToken.balanceOf(msg.sender), ">LP.balanceOf");
        require(tokenIndex < numTokens, "Token not found");

        uint256 dyFee;
        uint256 dy;

        (dy, dyFee) = _calculateWithdrawOneToken(
            self,
            driftingMetaSwapStorage,
            tokenAmount,
            tokenIndex,
            _updateBaseVirtualPrice(driftingMetaSwapStorage),
            totalSupply
        );

        require(dy >= minAmount, "dy < minAmount");

        // Update balances array
        self.balances[tokenIndex] = self.balances[tokenIndex].sub(
            dy.add(dyFee.mul(self.adminFee).div(FEE_DENOMINATOR))
        );

        // Burn the associated LP token from the caller and send the desired token
        lpToken.burnFrom(msg.sender, tokenAmount);
        self.pooledTokens[tokenIndex].safeTransfer(msg.sender, dy);

        emit RemoveLiquidityOne(
            msg.sender,
            tokenAmount,
            totalSupply,
            tokenIndex,
            dy
        );

        return dy;
    }

    /**
     * @notice Remove liquidity from the pool, weighted differently than the
     * pool's current balances.
     *
     * @param self Swap struct to read from and write to
     * @param driftingMetaSwapStorage DriftingMetaSwap struct to read from and write to
     * @param amounts how much of each token to withdraw
     * @param maxBurnAmount the max LP token provider is willing to pay to
     * remove liquidity. Useful as a front-running mitigation.
     * @return actual amount of LP tokens burned in the withdrawal
     */
    function removeLiquidityImbalance(
        SwapUtils.Swap storage self,
        DriftingMetaSwap storage driftingMetaSwapStorage,
        uint256[] memory amounts,
        uint256 maxBurnAmount
    ) public returns (uint256) {
        // Using this struct to avoid stack too deep error
        ManageLiquidityInfo memory v = ManageLiquidityInfo(
            0,
            0,
            0,
            self.lpToken,
            0,
            self._getAPrecise(),
            _updateBaseVirtualPrice(driftingMetaSwapStorage),
            _getScaleMultipliers(self, driftingMetaSwapStorage),
            self.balances
        );
        v.totalSupply = v.lpToken.totalSupply();

        require(
            amounts.length == v.newBalances.length,
            "Amounts should match pool tokens"
        );
        require(maxBurnAmount != 0, "Must burn more than 0");

        uint256 feePerToken = SwapUtils._feePerToken(
            self.swapFee,
            v.newBalances.length
        );

        // Calculate how much LPToken should be burned
        uint256[] memory fees = new uint256[](v.newBalances.length);
        {
            uint256[] memory balances1 = new uint256[](v.newBalances.length);

            v.d0 = SwapUtils.getD(
                _xp(
                    v.newBalances,
                    v.scaleMultipliers,
                    v.baseVirtualPrice
                ),
                v.preciseA
            );
            for (uint256 i = 0; i < v.newBalances.length; i++) {
                balances1[i] = v.newBalances[i].sub(
                    amounts[i],
                    "Cannot withdraw more than available"
                );
            }
            v.d1 = SwapUtils.getD(
                _xp(balances1, v.scaleMultipliers, v.baseVirtualPrice),
                v.preciseA
            );

            for (uint256 i = 0; i < v.newBalances.length; i++) {
                uint256 idealBalance = v.d1.mul(v.newBalances[i]).div(v.d0);
                uint256 difference = idealBalance.difference(balances1[i]);
                fees[i] = feePerToken.mul(difference).div(FEE_DENOMINATOR);
                self.balances[i] = balances1[i].sub(
                    fees[i].mul(self.adminFee).div(FEE_DENOMINATOR)
                );
                balances1[i] = balances1[i].sub(fees[i]);
            }

            v.d2 = SwapUtils.getD(
                _xp(balances1, v.scaleMultipliers, v.baseVirtualPrice),
                v.preciseA
            );
        }

        uint256 tokenAmount = v.d0.sub(v.d2).mul(v.totalSupply).div(v.d0);
        require(tokenAmount != 0, "Burnt amount cannot be zero");

        // Scale up by withdraw fee
        tokenAmount = tokenAmount.add(1);

        // Check for max burn amount
        require(tokenAmount <= maxBurnAmount, "tokenAmount > maxBurnAmount");

        // Burn the calculated amount of LPToken from the caller and send the desired tokens
        v.lpToken.burnFrom(msg.sender, tokenAmount);
        for (uint256 i = 0; i < v.newBalances.length; i++) {
            self.pooledTokens[i].safeTransfer(msg.sender, amounts[i]);
        }

        emit RemoveLiquidityImbalance(
            msg.sender,
            amounts,
            fees,
            v.d1,
            v.totalSupply.sub(tokenAmount)
        );

        return tokenAmount;
    }

    /**
     * @notice Determines if the stored value of base Swap's virtual price is expired.
     * If the last update was past the BASE_CACHE_EXPIRE_TIME, then update the stored value.
     *
     * @param driftingMetaSwapStorage DriftingMetaSwap struct to read from and write to
     * @return base Swap's virtual price
     */
    function _updateBaseVirtualPrice(DriftingMetaSwap storage driftingMetaSwapStorage)
        internal
        returns (uint256)
    {
        if (
            block.timestamp >
            driftingMetaSwapStorage.baseCacheLastUpdated + BASE_CACHE_EXPIRE_TIME
        ) {
            // When the cache is expired, update it
            uint256 baseVirtualPrice = ISwap(driftingMetaSwapStorage.baseSwap)
                .getVirtualPrice();
            driftingMetaSwapStorage.baseVirtualPrice = baseVirtualPrice;
            driftingMetaSwapStorage.baseCacheLastUpdated = block.timestamp;
            return baseVirtualPrice;
        } else {
            return driftingMetaSwapStorage.baseVirtualPrice;
        }
    }
}
