import { BigNumber, Signer, Wallet } from "ethers"
import {
  MAX_UINT256,
  TIME,
  ZERO_ADDRESS,
  asyncForEach,
  deployContractWithLibraries,
  getCurrentBlockTimestamp,
  getUserTokenBalances,
  setNextTimestamp,
  setTimestamp,
  forceAdvanceOneBlock,
} from "./testUtils"
import { deployContract, solidity } from "ethereum-waffle"
import { deployments } from "hardhat"

import { GenericERC20 } from "../build/typechain/GenericERC20"
import GenericERC20Artifact from "../build/artifacts/contracts/helper/GenericERC20.sol/GenericERC20.json"
import { LPToken } from "../build/typechain/LPToken"
import LPTokenArtifact from "../build/artifacts/contracts/LPToken.sol/LPToken.json"
import { Swap } from "../build/typechain/Swap"
import { DriftingMetaSwap } from "../build/typechain/DriftingMetaSwap"
import DriftingMetaSwapArtifact from "../build/artifacts/contracts/DriftingMeta/DriftingMetaSwap.sol/DriftingMetaSwap.json"
import { DriftingMetaSwapUtils } from "../build/typechain/DriftingMetaSwapUtils"
import DriftingMetaSwapUtilsArtifact from "../build/artifacts/contracts/DriftingMeta/DriftingMetaSwapUtils.sol/DriftingMetaSwapUtils.json"
import { RedemptionPriceSnapMock } from "../build/typechain/RedemptionPriceSnapMock"
import RedemptionPriceSnapMockArtifact from "../build/artifacts/contracts/mock/RedemptionPriceSnapMock.sol/RedemptionPriceSnapMock.json"
import chai from "chai"

chai.use(solidity)
const { expect } = chai

describe("Drifting-Meta-Swap", async () => {
  let signers: Array<Signer>
  let baseSwap: Swap
  let driftingMetaSwap: DriftingMetaSwap
  let driftingMetaSwapUtils: DriftingMetaSwapUtils
  let redemptionPriceSnapMock: RedemptionPriceSnapMock
  let rai: GenericERC20
  let dai: GenericERC20
  let usdc: GenericERC20
  let usdt: GenericERC20
  let baseLPToken: GenericERC20
  let metaLPToken: LPToken
  let owner: Signer
  let user1: Signer
  let user2: Signer
  let ownerAddress: string
  let user1Address: string
  let user2Address: string

  // Test Values
  const INITIAL_A_VALUE = 50
  const SWAP_FEE = 1e7
  const LP_TOKEN_NAME = "Test LP Token Name"
  const LP_TOKEN_SYMBOL = "TESTLP"
  const RAY = BigNumber.from("10").pow(27)
  const WAD = BigNumber.from("10").pow(18)
  const ONE_PC_WAD = BigNumber.from("10").pow(17)
  const INITIAL_RP = BigNumber.from("1").mul(RAY)
  const HIGHER_RP = BigNumber.from("15").mul(RAY).div(10)
  const LOWER_RP = BigNumber.from("5").mul(RAY).div(10)

  async function setLowerRP() {
    await redemptionPriceSnapMock.setRedemptionPriceSnap(LOWER_RP)
  }

  async function setHigherRP() {
    await redemptionPriceSnapMock.setRedemptionPriceSnap(HIGHER_RP)
  }

  const setupTest = deployments.createFixture(
    async ({ deployments, ethers }) => {
      const { get } = deployments
      await deployments.fixture() // ensure you start from a fresh deployments

      signers = await ethers.getSigners()
      owner = signers[0]
      user1 = signers[1]
      user2 = signers[2]
      ownerAddress = await owner.getAddress()
      user1Address = await user1.getAddress()
      user2Address = await user2.getAddress()

      // Get deployed Swap
      baseSwap = await ethers.getContract("Swap")

      dai = await ethers.getContract("DAI")
      usdc = await ethers.getContract("USDC")
      usdt = await ethers.getContract("USDT")

      await baseSwap.initialize(
        [dai.address, usdc.address, usdt.address],
        [18, 6, 6],
        LP_TOKEN_NAME,
        LP_TOKEN_SYMBOL,
        200,
        4e6,
        0,
        (
          await get("LPToken")
        ).address,
      )

      baseLPToken = (await ethers.getContractAt(
        GenericERC20Artifact.abi,
        (
          await baseSwap.swapStorage()
        ).lpToken,
      )) as GenericERC20

      // Deploy dummy tokens
      rai = (await deployContract(owner as Wallet, GenericERC20Artifact, [
        "Rai Stablecoin",
        "RAI",
        "18",
      ])) as GenericERC20

      // Mint tokens
      await asyncForEach(
        [ownerAddress, user1Address, user2Address],
        async (address) => {
          await dai.mint(address, BigNumber.from(10).pow(18).mul(100000))
          await usdc.mint(address, BigNumber.from(10).pow(6).mul(100000))
          await usdt.mint(address, BigNumber.from(10).pow(6).mul(100000))
          await rai.mint(address, BigNumber.from(10).pow(18).mul(100000))
        },
      )

      // Deploy RedemptionPriceSnapMock
      redemptionPriceSnapMock = (await deployContract(
        owner,
        RedemptionPriceSnapMockArtifact,
      )) as RedemptionPriceSnapMock
      await redemptionPriceSnapMock.deployed()

      // Deploy DriftingMetaSwapUtils
      driftingMetaSwapUtils = (await deployContract(
        owner,
        DriftingMetaSwapUtilsArtifact,
      )) as DriftingMetaSwapUtils
      await driftingMetaSwapUtils.deployed()

      // Deploy Swap with SwapUtils library
      driftingMetaSwap = (await deployContractWithLibraries(
        owner,
        DriftingMetaSwapArtifact,
        {
          SwapUtils: (await get("SwapUtils")).address,
          DriftingMetaSwapUtils: (await get("DriftingMetaSwapUtils")).address,
          AmplificationUtils: (await get("AmplificationUtils")).address,
        },
      )) as DriftingMetaSwap
      await driftingMetaSwap.deployed()

      // Set approvals
      await asyncForEach([owner, user1, user2], async (signer) => {
        await rai.connect(signer).approve(driftingMetaSwap.address, MAX_UINT256)
        await dai.connect(signer).approve(driftingMetaSwap.address, MAX_UINT256)
        await usdc
          .connect(signer)
          .approve(driftingMetaSwap.address, MAX_UINT256)
        await usdt
          .connect(signer)
          .approve(driftingMetaSwap.address, MAX_UINT256)
        await dai.connect(signer).approve(baseSwap.address, MAX_UINT256)
        await usdc.connect(signer).approve(baseSwap.address, MAX_UINT256)
        await usdt.connect(signer).approve(baseSwap.address, MAX_UINT256)
        await baseLPToken
          .connect(signer)
          .approve(driftingMetaSwap.address, MAX_UINT256)

        // Add some liquidity to the base pool
        await baseSwap
          .connect(signer)
          .addLiquidity(
            [String(1e20), String(1e8), String(1e8)],
            0,
            MAX_UINT256,
          )
      })

      // Initialize meta swap pool
      // Manually overload the signature
      await driftingMetaSwap.initializeDriftingMetaSwap(
        [rai.address, baseLPToken.address],
        [18, 18],
        LP_TOKEN_NAME,
        LP_TOKEN_SYMBOL,
        INITIAL_A_VALUE,
        SWAP_FEE,
        0,
        (
          await get("LPToken")
        ).address,
        baseSwap.address,
        redemptionPriceSnapMock.address,
      )
      metaLPToken = (await ethers.getContractAt(
        LPTokenArtifact.abi,
        (
          await driftingMetaSwap.swapStorage()
        ).lpToken,
      )) as LPToken

      // Add liquidity to the meta swap pool
      await driftingMetaSwap.addLiquidity(
        [String(1e18), String(1e18)],
        0,
        MAX_UINT256,
      )

      expect(await rai.balanceOf(driftingMetaSwap.address)).to.eq(String(1e18))
      expect(await baseLPToken.balanceOf(driftingMetaSwap.address)).to.eq(
        String(1e18),
      )
    },
  )

  beforeEach(async () => {
    await setupTest()
  })

  describe("swapStorage", () => {
    describe("lpToken", async () => {
      it("Returns correct lpTokenName", async () => {
        expect(await metaLPToken.name()).to.eq(LP_TOKEN_NAME)
      })

      it("Returns correct lpTokenSymbol", async () => {
        expect(await metaLPToken.symbol()).to.eq(LP_TOKEN_SYMBOL)
      })
    })

    describe("A", async () => {
      it("Returns correct A value", async () => {
        expect(await driftingMetaSwap.getA()).to.eq(INITIAL_A_VALUE)
        expect(await driftingMetaSwap.getAPrecise()).to.eq(
          INITIAL_A_VALUE * 100,
        )
      })
    })

    describe("fee", async () => {
      it("Returns correct fee value", async () => {
        expect((await driftingMetaSwap.swapStorage()).swapFee).to.eq(SWAP_FEE)
      })
    })

    describe("adminFee", async () => {
      it("Returns correct adminFee value", async () => {
        expect((await driftingMetaSwap.swapStorage()).adminFee).to.eq(0)
      })
    })
  })

  describe("getToken", () => {
    it("Returns correct addresses of pooled tokens", async () => {
      expect(await driftingMetaSwap.getToken(0)).to.eq(rai.address)
      expect(await driftingMetaSwap.getToken(1)).to.eq(baseLPToken.address)
    })

    it("Reverts when index is out of range", async () => {
      await expect(driftingMetaSwap.getToken(2)).to.be.reverted
    })
  })

  describe("getTokenIndex", () => {
    it("Returns correct token indexes", async () => {
      expect(await driftingMetaSwap.getTokenIndex(rai.address)).to.be.eq(0)
      expect(
        await driftingMetaSwap.getTokenIndex(baseLPToken.address),
      ).to.be.eq(1)
    })

    it("Reverts when token address is not found", async () => {
      await expect(
        driftingMetaSwap.getTokenIndex(ZERO_ADDRESS),
      ).to.be.revertedWith("Token does not exist")
    })
  })

  describe("getTokenBalance", () => {
    it("Returns correct balances of pooled tokens", async () => {
      expect(await driftingMetaSwap.getTokenBalance(0)).to.eq(
        BigNumber.from(String(1e18)),
      )
      expect(await driftingMetaSwap.getTokenBalance(1)).to.eq(
        BigNumber.from(String(1e18)),
      )
    })

    it("Reverts when index is out of range", async () => {
      await expect(driftingMetaSwap.getTokenBalance(2)).to.be.reverted
    })
  })

  describe("redemption price caching", () => {
    it("Reads and sets redemption price to test persistence", async () => {
      expect(await redemptionPriceSnapMock.snappedRedemptionPrice()).to.eq(
        INITIAL_RP,
      )
      await setLowerRP()
      expect(await redemptionPriceSnapMock.snappedRedemptionPrice()).to.eq(
        LOWER_RP,
      )
      await setHigherRP()
      expect(await redemptionPriceSnapMock.snappedRedemptionPrice()).to.eq(
        HIGHER_RP,
      )
    })
  })

  describe("getA", () => {
    it("Returns correct value", async () => {
      expect(await driftingMetaSwap.getA()).to.eq(INITIAL_A_VALUE)
    })
  })

  describe("addLiquidity", () => {
    it("Reverts when contract is paused", async () => {
      await driftingMetaSwap.pause()

      await expect(
        driftingMetaSwap
          .connect(user1)
          .addLiquidity([String(1e18), String(3e18)], 0, MAX_UINT256),
      ).to.be.reverted

      // unpause
      await driftingMetaSwap.unpause()

      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(1e18), String(3e18)], 0, MAX_UINT256)

      const actualPoolTokenAmount = await metaLPToken.balanceOf(user1Address)
      expect(actualPoolTokenAmount).to.eq(BigNumber.from("3991672211258372957"))
    })

    it("Reverts with 'Amounts must match pooled tokens'", async () => {
      await expect(
        driftingMetaSwap
          .connect(user1)
          .addLiquidity([String(1e16)], 0, MAX_UINT256),
      ).to.be.revertedWith("Amounts must match pooled tokens")
    })

    it("Reverts with 'Cannot withdraw more than available'", async () => {
      await expect(
        driftingMetaSwap
          .connect(user1)
          .calculateTokenAmount([MAX_UINT256, String(3e18)], false),
      ).to.be.revertedWith("Cannot withdraw more than available")
    })

    it("Reverts with 'Must supply all tokens in pool'", async () => {
      metaLPToken.approve(driftingMetaSwap.address, String(2e18))
      await driftingMetaSwap.removeLiquidity(String(2e18), [0, 0], MAX_UINT256)
      await expect(
        driftingMetaSwap
          .connect(user1)
          .addLiquidity([0, String(3e18)], MAX_UINT256, MAX_UINT256),
      ).to.be.revertedWith("Must supply all tokens in pool")
    })

    it("Succeeds with expected output amount of pool tokens", async () => {
      const calculatedPoolTokenAmount = await driftingMetaSwap
        .connect(user1)
        .calculateTokenAmount([String(1e18), String(3e18)], true)

      const calculatedPoolTokenAmountWithSlippage = calculatedPoolTokenAmount
        .mul(999)
        .div(1000)

      await driftingMetaSwap
        .connect(user1)
        .addLiquidity(
          [String(1e18), String(3e18)],
          calculatedPoolTokenAmountWithSlippage,
          MAX_UINT256,
        )

      const actualPoolTokenAmount = await metaLPToken.balanceOf(user1Address)

      // The actual pool token amount is less than 4e18 due to the imbalance of the underlying tokens
      expect(actualPoolTokenAmount).to.eq(BigNumber.from("3991672211258372957"))
    })

    it("Add liquidity with higher RP", async () => {
      await setHigherRP()
      // Modifying the RP has effectively made the pool contain 1.5 and 1 and there are 2 LP tokens. We add another
      // effective 1.5 and 1 to double liquidity and expect 2 meta LP tokens back.
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(1e18), String(1e18)], 0, MAX_UINT256)

      const actualPoolTokenAmount = await metaLPToken.balanceOf(user1Address)

      // The actual pool token amount is less than 4e18 due to the imbalance of the underlying tokens
      expect(actualPoolTokenAmount).to.lte(
        BigNumber.from("2").mul(WAD).add(ONE_PC_WAD),
      )
      expect(actualPoolTokenAmount).to.gte(
        BigNumber.from("2").mul(WAD).sub(ONE_PC_WAD),
      )
    })

    it("Add liquidity with higher RP", async () => {
      await setHigherRP()
      // Modifying the RP has effectively made the pool contain 1.5 and 1 and there are 2 LP tokens. We add another
      // effective 1.5 and 1 to double liquidity and expect 2 meta LP tokens back.
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(1e18), String(1e18)], 0, MAX_UINT256)

      const actualPoolTokenAmount = await metaLPToken.balanceOf(user1Address)

      // The actual pool token amount is less than 4e18 due to the imbalance of the underlying tokens
      expect(actualPoolTokenAmount).to.lte(
        BigNumber.from("2").mul(WAD).add(ONE_PC_WAD),
      )
      expect(actualPoolTokenAmount).to.gte(
        BigNumber.from("2").mul(WAD).sub(ONE_PC_WAD),
      )
    })

    it("Succeeds with actual pool token amount being within ±0.1% range of calculated pool token", async () => {
      const calculatedPoolTokenAmount = await driftingMetaSwap
        .connect(user1)
        .calculateTokenAmount([String(1e18), String(3e18)], true)

      const calculatedPoolTokenAmountWithNegativeSlippage =
        calculatedPoolTokenAmount.mul(999).div(1000)

      const calculatedPoolTokenAmountWithPositiveSlippage =
        calculatedPoolTokenAmount.mul(1001).div(1000)

      await driftingMetaSwap
        .connect(user1)
        .addLiquidity(
          [String(1e18), String(3e18)],
          calculatedPoolTokenAmountWithNegativeSlippage,
          MAX_UINT256,
        )

      const actualPoolTokenAmount = await metaLPToken.balanceOf(user1Address)

      expect(actualPoolTokenAmount).to.gte(
        calculatedPoolTokenAmountWithNegativeSlippage,
      )

      expect(actualPoolTokenAmount).to.lte(
        calculatedPoolTokenAmountWithPositiveSlippage,
      )
    })

    it("Pool token calc matches result with modified RP", async () => {
      await setHigherRP()

      const calculatedPoolTokenAmount = await driftingMetaSwap
        .connect(user1)
        .calculateTokenAmount([String(1e18), String(3e18)], true)

      const calculatedPoolTokenAmountWithNegativeSlippage =
        calculatedPoolTokenAmount.mul(999).div(1000)

      const calculatedPoolTokenAmountWithPositiveSlippage =
        calculatedPoolTokenAmount.mul(1001).div(1000)

      await driftingMetaSwap
        .connect(user1)
        .addLiquidity(
          [String(1e18), String(3e18)],
          calculatedPoolTokenAmountWithNegativeSlippage,
          MAX_UINT256,
        )

      const actualPoolTokenAmount = await metaLPToken.balanceOf(user1Address)

      expect(actualPoolTokenAmount).to.gte(
        calculatedPoolTokenAmountWithNegativeSlippage,
      )

      expect(actualPoolTokenAmount).to.lte(
        calculatedPoolTokenAmountWithPositiveSlippage,
      )
    })

    it("Succeeds with correctly updated tokenBalance after imbalanced deposit and higher RP", async () => {
      await setHigherRP()
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(1e18), String(3e18)], 0, MAX_UINT256)

      // Check updated token balance
      expect(await driftingMetaSwap.getTokenBalance(0)).to.eq(
        BigNumber.from(String(2e18)),
      )
      expect(await driftingMetaSwap.getTokenBalance(1)).to.eq(
        BigNumber.from(String(4e18)),
      )
    })

    it("Returns correct minted lpToken amount with higher RP", async () => {
      await setHigherRP()
      const mintedAmount = await driftingMetaSwap
        .connect(user1)
        .callStatic.addLiquidity([String(1e17), String(0)], 0, MAX_UINT256)
      // 0.1 * 1.5 / 2.5 * 2 = 0.12
      expect(mintedAmount).to.eq("119488639743016353")
    })

    it("Returns correct minted lpToken amount with higher RP", async () => {
      await setHigherRP()
      const mintedAmount = await driftingMetaSwap
        .connect(user1)
        .callStatic.addLiquidity([String(1e18), String(1e18)], 0, MAX_UINT256)
      expect(mintedAmount).to.eq("2000000000000000000")
    })

    it("Reverts when minToMint is not reached due to front running, higher RP", async () => {
      await setHigherRP()

      const calculatedLPTokenAmount = await driftingMetaSwap
        .connect(user1)
        .calculateTokenAmount([String(1e18), String(3e18)], true)

      const calculatedLPTokenAmountWithSlippage = calculatedLPTokenAmount
        .mul(999)
        .div(1000)

      // Someone else deposits thus front running user 1's deposit
      await driftingMetaSwap.addLiquidity(
        [String(1e18), String(3e18)],
        0,
        MAX_UINT256,
      )

      await expect(
        driftingMetaSwap
          .connect(user1)
          .addLiquidity(
            [String(1e18), String(3e18)],
            calculatedLPTokenAmountWithSlippage,
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Reverts when block is mined after deadline, lower RP", async () => {
      await setLowerRP()
      const currentTimestamp = await getCurrentBlockTimestamp()
      await setNextTimestamp(currentTimestamp + 60 * 10)

      await expect(
        driftingMetaSwap
          .connect(user1)
          .addLiquidity(
            [String(2e18), String(1e16)],
            0,
            currentTimestamp + 60 * 5,
          ),
      ).to.be.revertedWith("Deadline not met")
    })

    it("Emits addLiquidity event, higher RP", async () => {
      await setHigherRP()
      const calculatedLPTokenAmount = await driftingMetaSwap
        .connect(user1)
        .calculateTokenAmount([String(2e18), String(1e16)], true)

      const calculatedLPTokenAmountWithSlippage = calculatedLPTokenAmount
        .mul(999)
        .div(1000)

      await expect(
        driftingMetaSwap
          .connect(user1)
          .addLiquidity(
            [String(2e18), String(1e16)],
            calculatedLPTokenAmountWithSlippage,
            MAX_UINT256,
          ),
      ).to.emit(driftingMetaSwap.connect(user1), "AddLiquidity")
    })
  })

  describe("removeLiquidity", () => {
    it("Reverts with 'Cannot exceed total supply', lower RP", async () => {
      await setLowerRP()
      await expect(
        driftingMetaSwap.calculateRemoveLiquidity(MAX_UINT256),
      ).to.be.revertedWith("Cannot exceed total supply")
    })

    it("Reverts with 'minAmounts must match poolTokens'", async () => {
      await expect(
        driftingMetaSwap.removeLiquidity(String(2e18), [0], MAX_UINT256),
      ).to.be.revertedWith("minAmounts must match poolTokens")
    })

    it("Succeeds even when contract is paused, higher RP", async () => {
      await setHigherRP()
      // User 1 adds liquidity
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("2380413123715248198"))

      // Owner pauses the contract
      await driftingMetaSwap.pause()

      // Owner and user 1 try to remove liquidity
      metaLPToken.approve(driftingMetaSwap.address, String(2e18))
      await metaLPToken
        .connect(user1)
        .approve(driftingMetaSwap.address, currentUser1Balance)

      await driftingMetaSwap.removeLiquidity(String(2e18), [0, 0], MAX_UINT256)
      await driftingMetaSwap
        .connect(user1)
        .removeLiquidity(currentUser1Balance, [0, 0], MAX_UINT256)
      expect(await rai.balanceOf(driftingMetaSwap.address)).to.eq(0)
      expect(await baseLPToken.balanceOf(driftingMetaSwap.address)).to.eq(0)
    })

    it("Succeeds with expected return amounts of underlying tokens, higher RP", async () => {
      await setHigherRP()
      // User 1 adds liquidity
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)

      const [
        firstTokenBalanceBefore,
        secondTokenBalanceBefore,
        poolTokenBalanceBefore,
      ] = await getUserTokenBalances(user1, [rai, baseLPToken, metaLPToken])

      expect(poolTokenBalanceBefore).to.eq(
        BigNumber.from("2380413123715248198"),
      )

      const [expectedFirstTokenAmount, expectedSecondTokenAmount] =
        await driftingMetaSwap.calculateRemoveLiquidity(poolTokenBalanceBefore)

      expect(expectedFirstTokenAmount).to.eq(
        BigNumber.from("1630266180256738228"),
      )
      expect(expectedSecondTokenAmount).to.eq(
        BigNumber.from("548856280686435203"),
      )

      // User 1 removes liquidity
      await metaLPToken
        .connect(user1)
        .approve(driftingMetaSwap.address, poolTokenBalanceBefore)
      await driftingMetaSwap
        .connect(user1)
        .removeLiquidity(
          poolTokenBalanceBefore,
          [expectedFirstTokenAmount, expectedSecondTokenAmount],
          MAX_UINT256,
        )

      const [firstTokenBalanceAfter, secondTokenBalanceAfter] =
        await getUserTokenBalances(user1, [rai, baseLPToken])

      // Check the actual returned token amounts match the expected amounts
      expect(firstTokenBalanceAfter.sub(firstTokenBalanceBefore)).to.eq(
        expectedFirstTokenAmount,
      )
      expect(secondTokenBalanceAfter.sub(secondTokenBalanceBefore)).to.eq(
        expectedSecondTokenAmount,
      )
    })

    it("Returns correct amounts of received tokens, lower RP", async () => {
      await setLowerRP()
      const metaLPTokenBalance = await metaLPToken.balanceOf(ownerAddress)

      await metaLPToken.approve(driftingMetaSwap.address, MAX_UINT256)
      const removedTokenAmounts =
        await driftingMetaSwap.callStatic.removeLiquidity(
          metaLPTokenBalance,
          [0, 0],
          MAX_UINT256,
        )

      expect(removedTokenAmounts[0]).to.eq("1000000000000000000")
      expect(removedTokenAmounts[1]).to.eq("1000000000000000000")
    })

    it("Reverts when user tries to burn more LP tokens than they own, higher RP", async () => {
      await setHigherRP()
      // User 1 adds liquidity
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("2380413123715248198"))

      await expect(
        driftingMetaSwap
          .connect(user1)
          .removeLiquidity(
            currentUser1Balance.add(1),
            [MAX_UINT256, MAX_UINT256],
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Reverts when minAmounts of underlying tokens are not reached, higher RP", async () => {
      await setHigherRP()
      // User 1 adds liquidity
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("2380413123715248198"))
      const [expectedFirstTokenAmount, expectedSecondTokenAmount] =
        await driftingMetaSwap.calculateRemoveLiquidity(currentUser1Balance)

      expect(expectedFirstTokenAmount).to.eq(
        BigNumber.from("1630266180256738228"),
      )
      expect(expectedSecondTokenAmount).to.eq(
        BigNumber.from("548856280686435203"),
      )

      // User 2 adds liquidity, which leads to change in balance of underlying tokens
      await driftingMetaSwap
        .connect(user2)
        .addLiquidity([String(1e16), String(2e18)], 0, MAX_UINT256)

      // User 1 tries to remove liquidity which get reverted due to front running
      await metaLPToken
        .connect(user1)
        .approve(driftingMetaSwap.address, currentUser1Balance)
      await expect(
        driftingMetaSwap
          .connect(user1)
          .removeLiquidity(
            currentUser1Balance,
            [expectedFirstTokenAmount, expectedSecondTokenAmount],
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Reverts when minAmounts of underlying tokens are not reached, higher RP", async () => {
      await setHigherRP()
      // User 1 adds liquidity
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("2380413123715248198"))

      const [expectedFirstTokenAmount, expectedSecondTokenAmount] =
        await driftingMetaSwap.calculateRemoveLiquidity(currentUser1Balance)

      expect(expectedFirstTokenAmount).to.eq(
        BigNumber.from("1630266180256738228"),
      )
      expect(expectedSecondTokenAmount).to.eq(
        BigNumber.from("548856280686435203"),
      )

      // User 2 adds liquidity, which leads to change in balance of underlying tokens
      await driftingMetaSwap
        .connect(user2)
        .addLiquidity([String(1e16), String(2e18)], 0, MAX_UINT256)

      // User 1 tries to remove liquidity which get reverted due to front running
      await metaLPToken
        .connect(user1)
        .approve(driftingMetaSwap.address, currentUser1Balance)
      await expect(
        driftingMetaSwap
          .connect(user1)
          .removeLiquidity(
            currentUser1Balance,
            [expectedFirstTokenAmount, expectedSecondTokenAmount],
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Reverts when block is mined after deadline", async () => {
      // User 1 adds liquidity
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)

      const currentTimestamp = await getCurrentBlockTimestamp()
      await setNextTimestamp(currentTimestamp + 60 * 10)

      // User 1 tries removing liquidity with deadline of +5 minutes
      await metaLPToken
        .connect(user1)
        .approve(driftingMetaSwap.address, currentUser1Balance)
      await expect(
        driftingMetaSwap
          .connect(user1)
          .removeLiquidity(
            currentUser1Balance,
            [0, 0],
            currentTimestamp + 60 * 5,
          ),
      ).to.be.revertedWith("Deadline not met")
    })

    it("Emits removeLiquidity event", async () => {
      // User 1 adds liquidity
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)

      // User 1 tries removes liquidity
      await metaLPToken
        .connect(user1)
        .approve(driftingMetaSwap.address, currentUser1Balance)
      await expect(
        driftingMetaSwap
          .connect(user1)
          .removeLiquidity(currentUser1Balance, [0, 0], MAX_UINT256),
      ).to.emit(driftingMetaSwap.connect(user1), "RemoveLiquidity")
    })
  })

  describe("removeLiquidityImbalance", () => {
    it("Reverts when contract is paused", async () => {
      // User 1 adds liquidity
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("1996275270169644725"))

      // Owner pauses the contract
      await driftingMetaSwap.pause()

      // Owner and user 1 try to initiate imbalanced liquidity withdrawal
      metaLPToken.approve(driftingMetaSwap.address, MAX_UINT256)
      metaLPToken.connect(user1).approve(driftingMetaSwap.address, MAX_UINT256)

      await expect(
        driftingMetaSwap.removeLiquidityImbalance(
          [String(1e18), String(1e16)],
          MAX_UINT256,
          MAX_UINT256,
        ),
      ).to.be.reverted

      await expect(
        driftingMetaSwap
          .connect(user1)
          .removeLiquidityImbalance(
            [String(1e18), String(1e16)],
            MAX_UINT256,
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Reverts with 'Amounts should match pool tokens'", async () => {
      await expect(
        driftingMetaSwap.removeLiquidityImbalance(
          [String(1e18)],
          MAX_UINT256,
          MAX_UINT256,
        ),
      ).to.be.revertedWith("Amounts should match pool tokens")
    })

    it("Reverts with 'Cannot withdraw more than available', lower RP", async () => {
      await setLowerRP()
      await expect(
        driftingMetaSwap.removeLiquidityImbalance(
          [MAX_UINT256, MAX_UINT256],
          1,
          MAX_UINT256,
        ),
      ).to.be.revertedWith("Cannot withdraw more than available")
    })

    it("Succeeds with calculated max amount of pool token to be burned (±0.1%), modding RP", async () => {
      // User 1 adds liquidity
      await setHigherRP()
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("2380413123715248198"))

      // User 1 calculates amount of pool token to be burned
      // There are about 4.38 LP tokens with liquidity of 3, 1.01 or 4.5, 1.01 effective.
      // Burning about 1.51 of 4.38 so expect to lose about 1.51 / 5.51 * 4.38 = about 0.91
      const maxPoolTokenAmountToBeBurned =
        await driftingMetaSwap.calculateTokenAmount(
          [String(1e18), String(1e16)],
          false,
        )

      // ±0.1% range of pool token to be burned
      const maxPoolTokenAmountToBeBurnedNegativeSlippage =
        maxPoolTokenAmountToBeBurned.mul(1001).div(1000)
      const maxPoolTokenAmountToBeBurnedPositiveSlippage =
        maxPoolTokenAmountToBeBurned.mul(999).div(1000)

      const [
        firstTokenBalanceBefore,
        secondTokenBalanceBefore,
        poolTokenBalanceBefore,
      ] = await getUserTokenBalances(user1, [rai, baseLPToken, metaLPToken])

      // User 1 withdraws imbalanced tokens
      await metaLPToken
        .connect(user1)
        .approve(
          driftingMetaSwap.address,
          maxPoolTokenAmountToBeBurnedNegativeSlippage,
        )
      await driftingMetaSwap
        .connect(user1)
        .removeLiquidityImbalance(
          [String(1e18), String(1e16)],
          maxPoolTokenAmountToBeBurnedNegativeSlippage,
          MAX_UINT256,
        )

      const [
        firstTokenBalanceAfter,
        secondTokenBalanceAfter,
        poolTokenBalanceAfter,
      ] = await getUserTokenBalances(user1, [rai, baseLPToken, metaLPToken])

      // Check the actual returned token amounts match the requested amounts
      expect(firstTokenBalanceAfter.sub(firstTokenBalanceBefore)).to.eq(
        String(1e18),
      )
      expect(secondTokenBalanceAfter.sub(secondTokenBalanceBefore)).to.eq(
        String(1e16),
      )

      // Check the actual burned pool token amount
      const actualPoolTokenBurned = poolTokenBalanceBefore.sub(
        poolTokenBalanceAfter,
      )

      expect(actualPoolTokenBurned).to.eq(String("1190394116482591156"))
      expect(actualPoolTokenBurned).to.gte(
        maxPoolTokenAmountToBeBurnedPositiveSlippage,
      )
      expect(actualPoolTokenBurned).to.lte(
        maxPoolTokenAmountToBeBurnedNegativeSlippage,
      )
    })

    it("Returns correct amount of burned lpToken, changed RP", async () => {
      // User 1 adds liquidity
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)

      await setHigherRP()
      //liquidity is about 3, 1.01 and 4.5, 1.01 effective.
      // There are about 4 LP tokens as RP was modified after the second deposit.
      // Burning about effective 1.51 of 5.51 so expect to lose about 1.51 / 5.51 * 4 = about 1.09 expected

      // User 1 removes liquidity
      await metaLPToken
        .connect(user1)
        .approve(driftingMetaSwap.address, MAX_UINT256)

      const burnedLPTokenAmount = await driftingMetaSwap
        .connect(user1)
        .callStatic.removeLiquidityImbalance(
          [String(1e18), String(1e16)],
          currentUser1Balance,
          MAX_UINT256,
        )

      expect(burnedLPTokenAmount).eq("1086003177120438165")
    })

    it("Reverts when user tries to burn more LP tokens than they own", async () => {
      // User 1 adds liquidity
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("1996275270169644725"))

      await expect(
        driftingMetaSwap
          .connect(user1)
          .removeLiquidityImbalance(
            [String(1e18), String(1e16)],
            currentUser1Balance.add(1),
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Reverts when minAmounts of underlying tokens are not reached, higher RP", async () => {
      await setHigherRP()
      // User 1 adds liquidity
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("2380413123715248198"))

      // User 1 calculates amount of pool token to be burned
      const maxPoolTokenAmountToBeBurned =
        await driftingMetaSwap.calculateTokenAmount(
          [String(1e18), String(1e16)],
          false,
        )

      // Calculate +0.1% of pool token to be burned
      const maxPoolTokenAmountToBeBurnedNegativeSlippage =
        maxPoolTokenAmountToBeBurned.mul(1001).div(1000)

      // User 2 adds liquidity, which leads to change in balance of underlying tokens
      await driftingMetaSwap
        .connect(user2)
        .addLiquidity([String(1e16), String(1e20)], 0, MAX_UINT256)

      // User 1 tries to remove liquidity which get reverted due to front running
      await metaLPToken
        .connect(user1)
        .approve(
          driftingMetaSwap.address,
          maxPoolTokenAmountToBeBurnedNegativeSlippage,
        )
      await expect(
        driftingMetaSwap
          .connect(user1)
          .removeLiquidityImbalance(
            [String(1e18), String(1e16)],
            maxPoolTokenAmountToBeBurnedNegativeSlippage,
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Reverts when block is mined after deadline", async () => {
      await setHigherRP()
      // User 1 adds liquidity
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)

      const currentTimestamp = await getCurrentBlockTimestamp()
      await setNextTimestamp(currentTimestamp + 60 * 10)

      // User 1 tries removing liquidity with deadline of +5 minutes
      await metaLPToken
        .connect(user1)
        .approve(driftingMetaSwap.address, currentUser1Balance)
      await expect(
        driftingMetaSwap
          .connect(user1)
          .removeLiquidityImbalance(
            [String(1e18), String(1e16)],
            currentUser1Balance,
            currentTimestamp + 60 * 5,
          ),
      ).to.be.revertedWith("Deadline not met")
    })

    it("Emits RemoveLiquidityImbalance event", async () => {
      await setLowerRP()
      // User 1 adds liquidity
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)

      // User 1 removes liquidity
      await metaLPToken
        .connect(user1)
        .approve(driftingMetaSwap.address, MAX_UINT256)

      await expect(
        driftingMetaSwap
          .connect(user1)
          .removeLiquidityImbalance(
            [String(1e18), String(1e16)],
            currentUser1Balance,
            MAX_UINT256,
          ),
      ).to.emit(driftingMetaSwap.connect(user1), "RemoveLiquidityImbalance")
    })
  })

  describe("removeLiquidityOneToken", () => {
    it("Reverts when contract is paused.", async () => {
      // User 1 adds liquidity
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("1996275270169644725"))

      // Owner pauses the contract
      await driftingMetaSwap.pause()

      // Owner and user 1 try to remove liquidity via single token
      metaLPToken.approve(driftingMetaSwap.address, String(2e18))
      await metaLPToken
        .connect(user1)
        .approve(driftingMetaSwap.address, currentUser1Balance)

      await expect(
        driftingMetaSwap.removeLiquidityOneToken(
          String(2e18),
          0,
          0,
          MAX_UINT256,
        ),
      ).to.be.reverted
      await expect(
        driftingMetaSwap
          .connect(user1)
          .removeLiquidityOneToken(currentUser1Balance, 0, 0, MAX_UINT256),
      ).to.be.reverted
    })

    it("Reverts with 'Token index out of range'", async () => {
      await expect(
        driftingMetaSwap.calculateRemoveLiquidityOneToken(1, 5),
      ).to.be.revertedWith("Token index out of range")
    })

    it("Reverts with 'Withdraw exceeds available', lower RP", async () => {
      await setLowerRP()
      // User 1 adds liquidity
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("1348571688270068450"))

      await expect(
        driftingMetaSwap.calculateRemoveLiquidityOneToken(
          currentUser1Balance.mul(2),
          0,
        ),
      ).to.be.revertedWith("Withdraw exceeds available")
    })

    it("Reverts with 'Token not found'", async () => {
      await expect(
        driftingMetaSwap
          .connect(user1)
          .removeLiquidityOneToken(0, 9, 1, MAX_UINT256),
      ).to.be.revertedWith("Token not found")
    })

    it("Succeeds with calculated token amount as minAmount, higher RP", async () => {
      // User 1 adds liquidity
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("1996275270169644725"))

      await setHigherRP()

      // User 1 calculates the amount of underlying token to receive.
      const calculatedFirstTokenAmount =
        await driftingMetaSwap.calculateRemoveLiquidityOneToken(
          currentUser1Balance,
          0,
        )

      // As RP has increased user will get less of the drifting target coin.
      expect(calculatedFirstTokenAmount).to.eq(
        BigNumber.from("1845125093630728874"),
      )

      // User 1 initiates one token withdrawal
      const before = await rai.balanceOf(user1Address)
      await metaLPToken
        .connect(user1)
        .approve(driftingMetaSwap.address, currentUser1Balance)
      await driftingMetaSwap
        .connect(user1)
        .removeLiquidityOneToken(
          currentUser1Balance,
          0,
          calculatedFirstTokenAmount,
          MAX_UINT256,
        )
      const after = await rai.balanceOf(user1Address)

      expect(after.sub(before)).to.eq(BigNumber.from("1845125093630728874"))
    })

    it("Returns correct amount of received token", async () => {
      await metaLPToken.approve(driftingMetaSwap.address, MAX_UINT256)
      const removedTokenAmount =
        await driftingMetaSwap.callStatic.removeLiquidityOneToken(
          String(1e18),
          0,
          0,
          MAX_UINT256,
        )
      expect(removedTokenAmount).to.eq("954404308901884931")
    })

    it("Returns correct amount of received token, higher RP", async () => {
      await setHigherRP()
      await metaLPToken.approve(driftingMetaSwap.address, MAX_UINT256)
      const removedTokenAmount =
        await driftingMetaSwap.callStatic.removeLiquidityOneToken(
          String(1e18),
          0,
          0,
          MAX_UINT256,
        )
      expect(removedTokenAmount).to.eq("828982515014366590")
    })

    it("With a lower RP reverts due to insufficient coins available on drift token side", async () => {
      await setLowerRP()
      await metaLPToken.approve(driftingMetaSwap.address, MAX_UINT256)
      await expect(
        driftingMetaSwap.callStatic.removeLiquidityOneToken(
          String(1e18),
          0,
          0,
          MAX_UINT256,
        ),
      ).to.be.revertedWith("Withdraw exceeds available")
    })

    it("Reverts when user tries to burn more LP tokens than they own", async () => {
      // User 1 adds liquidity
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("1996275270169644725"))

      await expect(
        driftingMetaSwap
          .connect(user1)
          .removeLiquidityOneToken(
            currentUser1Balance.add(1),
            0,
            0,
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Reverts when minAmount of underlying token is not reached, higher RP", async () => {
      await setHigherRP()
      // User 1 adds liquidity
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("2380413123715248198"))

      // User 1 calculates the amount of underlying token to receive.
      const calculatedFirstTokenAmount =
        await driftingMetaSwap.calculateRemoveLiquidityOneToken(
          currentUser1Balance,
          0,
        )
      expect(calculatedFirstTokenAmount).to.eq(
        BigNumber.from("2005978693434997376"),
      )

      // User 2 adds liquidity before User 1 initiates withdrawal
      await driftingMetaSwap
        .connect(user2)
        .addLiquidity([String(1e16), String(1e20)], 0, MAX_UINT256)

      // User 1 initiates one token withdrawal
      metaLPToken
        .connect(user1)
        .approve(driftingMetaSwap.address, currentUser1Balance)
      await expect(
        driftingMetaSwap
          .connect(user1)
          .removeLiquidityOneToken(
            currentUser1Balance,
            0,
            calculatedFirstTokenAmount,
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Reverts when block is mined after deadline", async () => {
      // User 1 adds liquidity
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)

      const currentTimestamp = await getCurrentBlockTimestamp()
      await setNextTimestamp(currentTimestamp + 60 * 10)

      // User 1 tries removing liquidity with deadline of +5 minutes
      await metaLPToken
        .connect(user1)
        .approve(driftingMetaSwap.address, currentUser1Balance)
      await expect(
        driftingMetaSwap
          .connect(user1)
          .removeLiquidityOneToken(
            currentUser1Balance,
            0,
            0,
            currentTimestamp + 60 * 5,
          ),
      ).to.be.revertedWith("Deadline not met")
    })

    it("Emits RemoveLiquidityOne event", async () => {
      // User 1 adds liquidity
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)

      await metaLPToken
        .connect(user1)
        .approve(driftingMetaSwap.address, currentUser1Balance)
      await expect(
        driftingMetaSwap
          .connect(user1)
          .removeLiquidityOneToken(currentUser1Balance, 0, 0, MAX_UINT256),
      ).to.emit(driftingMetaSwap.connect(user1), "RemoveLiquidityOne")
    })
  })

  describe("swap", () => {
    it("Reverts when contract is paused", async () => {
      // Owner pauses the contract
      await driftingMetaSwap.pause()

      // User 1 try to initiate swap
      await expect(
        driftingMetaSwap
          .connect(user1)
          .swap(0, 1, String(1e16), 0, MAX_UINT256),
      ).to.be.reverted
    })

    it("Reverts with 'Token index out of range'", async () => {
      await expect(
        driftingMetaSwap.calculateSwap(0, 9, String(1e17)),
      ).to.be.revertedWith("Token index out of range")
    })

    it("Reverts with 'Cannot swap more than you own'", async () => {
      await expect(
        driftingMetaSwap.connect(user1).swap(0, 1, MAX_UINT256, 0, MAX_UINT256),
      ).to.be.revertedWith("Cannot swap more than you own")
    })

    it("Succeeds with expected swap amounts, higher RP", async () => {
      await setHigherRP()
      // User 1 calculates how much token to receive
      const calculatedSwapReturn = await driftingMetaSwap.calculateSwap(
        0,
        1,
        String(1e17),
      )
      expect(calculatedSwapReturn).to.eq(BigNumber.from("148100769371293393"))

      const [tokenFromBalanceBefore, tokenToBalanceBefore] =
        await getUserTokenBalances(user1, [rai, baseLPToken])

      // User 1 successfully initiates swap
      await driftingMetaSwap
        .connect(user1)
        .swap(0, 1, String(1e17), calculatedSwapReturn, MAX_UINT256)

      // Check the sent and received amounts are as expected
      const [tokenFromBalanceAfter, tokenToBalanceAfter] =
        await getUserTokenBalances(user1, [rai, baseLPToken])
      expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
        BigNumber.from(String(1e17)),
      )
      expect(tokenToBalanceAfter.sub(tokenToBalanceBefore)).to.eq(
        calculatedSwapReturn,
      )
    })

    it("Succeeds with expected swap amounts, lower RP", async () => {
      await setLowerRP()
      // User 1 calculates how much token to receive
      const calculatedSwapReturn = await driftingMetaSwap.calculateSwap(
        0,
        1,
        String(1e17),
      )
      expect(calculatedSwapReturn).to.eq(BigNumber.from("50661237372326538"))

      const [tokenFromBalanceBefore, tokenToBalanceBefore] =
        await getUserTokenBalances(user1, [rai, baseLPToken])

      // User 1 successfully initiates swap
      await driftingMetaSwap
        .connect(user1)
        .swap(0, 1, String(1e17), calculatedSwapReturn, MAX_UINT256)

      // Check the sent and received amounts are as expected
      const [tokenFromBalanceAfter, tokenToBalanceAfter] =
        await getUserTokenBalances(user1, [rai, baseLPToken])
      expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
        BigNumber.from(String(1e17)),
      )
      expect(tokenToBalanceAfter.sub(tokenToBalanceBefore)).to.eq(
        calculatedSwapReturn,
      )
    })

    it("Reverts when minDy (minimum amount token to receive) is not reached due to front running", async () => {
      await setLowerRP()
      // User 1 calculates how much token to receive
      const calculatedSwapReturn = await driftingMetaSwap.calculateSwap(
        0,
        1,
        String(1e17),
      )
      expect(calculatedSwapReturn).to.eq(BigNumber.from("50661237372326538"))

      // User 2 swaps before User 1 does
      await driftingMetaSwap
        .connect(user2)
        .swap(0, 1, String(1e17), 0, MAX_UINT256)

      // User 1 initiates swap
      await expect(
        driftingMetaSwap
          .connect(user1)
          .swap(0, 1, String(1e17), calculatedSwapReturn, MAX_UINT256),
      ).to.be.reverted
    })

    it("Succeeds when using lower minDy even when transaction is front-ran", async () => {
      await setHigherRP()
      // User 1 calculates how much token to receive with 1% slippage
      const calculatedSwapReturn = await driftingMetaSwap.calculateSwap(
        0,
        1,
        String(1e17),
      )
      expect(calculatedSwapReturn).to.eq(BigNumber.from("148100769371293393"))

      const [tokenFromBalanceBefore, tokenToBalanceBefore] =
        await getUserTokenBalances(user1, [rai, baseLPToken])

      const calculatedSwapReturnWithNegativeSlippage = calculatedSwapReturn
        .mul(99)
        .div(100)

      // User 2 swaps before User 1 does
      await driftingMetaSwap
        .connect(user2)
        .swap(0, 1, String(1e17), 0, MAX_UINT256)

      // User 1 successfully initiates swap with 1% slippage from initial calculated amount
      await driftingMetaSwap
        .connect(user1)
        .swap(
          0,
          1,
          String(1e17),
          calculatedSwapReturnWithNegativeSlippage,
          MAX_UINT256,
        )

      // Check the sent and received amounts are as expected
      const [tokenFromBalanceAfter, tokenToBalanceAfter] =
        await getUserTokenBalances(user1, [rai, baseLPToken])

      expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
        BigNumber.from(String(1e17)),
      )

      const actualReceivedAmount = tokenToBalanceAfter.sub(tokenToBalanceBefore)

      expect(actualReceivedAmount).to.eq(BigNumber.from("146859291684610133"))
      expect(actualReceivedAmount).to.gt(
        calculatedSwapReturnWithNegativeSlippage,
      )
      expect(actualReceivedAmount).to.lt(calculatedSwapReturn)
    })

    it("Returns correct amount of received token", async () => {
      await setHigherRP()
      const swapReturnAmount = await driftingMetaSwap.callStatic.swap(
        0,
        1,
        String(1e18),
        0,
        MAX_UINT256,
      )
      //Swapped everything so massive slippage explains why result is low even with higher RP.
      expect(swapReturnAmount).to.eq("975364157142287839")
    })

    it("Reverts when block is mined after deadline", async () => {
      const currentTimestamp = await getCurrentBlockTimestamp()
      await setNextTimestamp(currentTimestamp + 60 * 10)

      // User 1 tries swapping with deadline of +5 minutes
      await expect(
        driftingMetaSwap
          .connect(user1)
          .swap(0, 1, String(1e17), 0, currentTimestamp + 60 * 5),
      ).to.be.revertedWith("Deadline not met")
    })

    it("Emits TokenSwap event", async () => {
      // User 1 initiates swap
      await expect(
        driftingMetaSwap
          .connect(user1)
          .swap(0, 1, String(1e17), 0, MAX_UINT256),
      ).to.emit(driftingMetaSwap, "TokenSwap")
    })
  })

  describe("swapUnderlying", () => {
    it("Reverts when contract is paused", async () => {
      // Owner pauses the contract
      await driftingMetaSwap.pause()

      // User 1 try to initiate swap
      await expect(
        driftingMetaSwap
          .connect(user1)
          .swapUnderlying(0, 1, String(1e16), 0, MAX_UINT256),
      ).to.be.reverted
    })

    it("Reverts with 'Token index out of range'", async () => {
      await expect(
        driftingMetaSwap.calculateSwapUnderlying(0, 9, String(1e17)),
      ).to.be.revertedWith("Token index out of range")

      await expect(
        driftingMetaSwap.swapUnderlying(0, 9, String(1e17), 0, MAX_UINT256),
      ).to.be.revertedWith("Token index out of range")
    })

    describe("Succeeds with expected swap amounts", () => {
      it("From 18 decimal token (meta) to 18 decimal token (base)", async () => {
        await setHigherRP()
        // User 1 calculates how much token to receive
        const calculatedSwapReturn =
          await driftingMetaSwap.calculateSwapUnderlying(0, 1, String(1e17))
        expect(calculatedSwapReturn).to.eq(BigNumber.from("148071027990509710"))

        const [tokenFromBalanceBefore, tokenToBalanceBefore] =
          await getUserTokenBalances(user1, [rai, dai])

        // User 1 successfully initiates swap
        await driftingMetaSwap
          .connect(user1)
          .swapUnderlying(0, 1, String(1e17), calculatedSwapReturn, MAX_UINT256)

        // Check the sent and received amounts are as expected
        const [tokenFromBalanceAfter, tokenToBalanceAfter] =
          await getUserTokenBalances(user1, [rai, dai])
        expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
          BigNumber.from(String(1e17)),
        )
        expect(tokenToBalanceAfter.sub(tokenToBalanceBefore)).to.eq(
          calculatedSwapReturn,
        )
      })

      it("From 6 decimal token (base) to 18 decimal token (meta)", async () => {
        await setHigherRP()
        // User 1 calculates how much token to receive
        const calculatedSwapReturn =
          await driftingMetaSwap.calculateSwapUnderlying(2, 0, String(1e5))
        // expect to get about 2/3 as to asset has 150% value.
        expect(calculatedSwapReturn).to.eq(BigNumber.from("67041897861919562"))

        // Calculating swapping from a base token to a meta level token
        // does not account for base pool's swap fees
        const minReturnWithNegativeSlippage = calculatedSwapReturn
          .mul(999)
          .div(1000)

        const [tokenFromBalanceBefore, tokenToBalanceBefore] =
          await getUserTokenBalances(user1, [usdc, rai])

        // User 1 successfully initiates swap
        await driftingMetaSwap
          .connect(user1)
          .swapUnderlying(
            2,
            0,
            String(1e5),
            minReturnWithNegativeSlippage,
            MAX_UINT256,
          )

        // Check the sent and received amounts are as expected
        const [tokenFromBalanceAfter, tokenToBalanceAfter] =
          await getUserTokenBalances(user1, [usdc, rai])
        expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
          BigNumber.from(String(1e5)),
        )
        expect(tokenToBalanceAfter.sub(tokenToBalanceBefore)).to.eq(
          "67029182601837288",
        )
      })

      it("From 18 decimal token (meta) to 6 decimal token (base)", async () => {
        await setHigherRP()
        // User 1 calculates how much token to receive
        const calculatedSwapReturn =
          await driftingMetaSwap.calculateSwapUnderlying(0, 2, String(1e17))
        expect(calculatedSwapReturn).to.eq(BigNumber.from("148071"))

        const [tokenFromBalanceBefore, tokenToBalanceBefore] =
          await getUserTokenBalances(user1, [rai, usdc])

        // User 1 successfully initiates swap
        await driftingMetaSwap
          .connect(user1)
          .swapUnderlying(0, 2, String(1e17), calculatedSwapReturn, MAX_UINT256)

        // Check the sent and received amounts are as expected
        const [tokenFromBalanceAfter, tokenToBalanceAfter] =
          await getUserTokenBalances(user1, [rai, usdc])
        expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
          BigNumber.from(String(1e17)),
        )
        expect(tokenToBalanceAfter.sub(tokenToBalanceBefore)).to.eq(
          calculatedSwapReturn,
        )
      })

      it("From 18 decimal token (base) to 6 decimal token (base)", async () => {
        // RP should have no impact
        await setLowerRP()
        // User 1 calculates how much token to receive
        const calculatedSwapReturn =
          await driftingMetaSwap.calculateSwapUnderlying(1, 3, String(1e17))
        expect(calculatedSwapReturn).to.eq(BigNumber.from("99959"))

        const [tokenFromBalanceBefore, tokenToBalanceBefore] =
          await getUserTokenBalances(user1, [dai, usdt])

        // User 1 successfully initiates swap
        await driftingMetaSwap
          .connect(user1)
          .swapUnderlying(1, 3, String(1e17), calculatedSwapReturn, MAX_UINT256)

        // Check the sent and received amounts are as expected
        const [tokenFromBalanceAfter, tokenToBalanceAfter] =
          await getUserTokenBalances(user1, [dai, usdt])
        expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
          BigNumber.from(String(1e17)),
        )
        expect(tokenToBalanceAfter.sub(tokenToBalanceBefore)).to.eq(
          calculatedSwapReturn,
        )
      })
    })

    it("Reverts when minDy (minimum amount token to receive) is not reached due to front running", async () => {
      await setHigherRP()
      // User 1 calculates how much token to receive
      const calculatedSwapReturn =
        await driftingMetaSwap.calculateSwapUnderlying(0, 1, String(1e17))
      expect(calculatedSwapReturn).to.eq(BigNumber.from("148071027990509710"))

      // User 2 swaps before User 1 does
      await driftingMetaSwap
        .connect(user2)
        .swapUnderlying(0, 1, String(1e17), 0, MAX_UINT256)

      // User 1 initiates swap
      await expect(
        driftingMetaSwap
          .connect(user1)
          .swapUnderlying(
            0,
            1,
            String(1e17),
            calculatedSwapReturn,
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Succeeds when using lower minDy even when transaction is front-ran", async () => {
      await setHigherRP()
      // User 1 calculates how much token to receive with 1% slippage
      const calculatedSwapReturn =
        await driftingMetaSwap.calculateSwapUnderlying(0, 1, String(1e17))
      expect(calculatedSwapReturn).to.eq(BigNumber.from("148071027990509710"))

      const [tokenFromBalanceBefore, tokenToBalanceBefore] =
        await getUserTokenBalances(user1, [rai, dai])

      const calculatedSwapReturnWithNegativeSlippage = calculatedSwapReturn
        .mul(99)
        .div(100)

      // User 2 swaps before User 1 does
      await driftingMetaSwap
        .connect(user2)
        .swap(0, 1, String(1e17), 0, MAX_UINT256)

      // User 1 successfully initiates swap with 1% slippage from initial calculated amount
      await driftingMetaSwap
        .connect(user1)
        .swapUnderlying(
          0,
          1,
          String(1e17),
          calculatedSwapReturnWithNegativeSlippage,
          MAX_UINT256,
        )

      // Check the sent and received amounts are as expected
      const [tokenFromBalanceAfter, tokenToBalanceAfter] =
        await getUserTokenBalances(user1, [rai, dai])

      expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
        BigNumber.from(String(1e17)),
      )

      const actualReceivedAmount = tokenToBalanceAfter.sub(tokenToBalanceBefore)

      expect(actualReceivedAmount).to.eq(BigNumber.from("146829800623524682"))
      expect(actualReceivedAmount).to.gt(
        calculatedSwapReturnWithNegativeSlippage,
      )
      expect(actualReceivedAmount).to.lt(calculatedSwapReturn)
    })

    it("Returns correct amount of received token, higher RP", async () => {
      await setHigherRP()
      const swapReturnAmount = await driftingMetaSwap.callStatic.swapUnderlying(
        0,
        1,
        String(1e17),
        0,
        MAX_UINT256,
      )
      expect(swapReturnAmount).to.eq("148071027990509710")
    })

    it("Returns correct amount of received token, lower RP", async () => {
      await setLowerRP()
      const swapReturnAmount = await driftingMetaSwap.callStatic.swapUnderlying(
        0,
        1,
        String(1e17),
        0,
        MAX_UINT256,
      )
      expect(swapReturnAmount).to.eq("50651090942180164")
    })

    it("Reverts when block is mined after deadline", async () => {
      await setLowerRP()
      const currentTimestamp = await getCurrentBlockTimestamp()
      await setNextTimestamp(currentTimestamp + 60 * 10)

      // User 1 tries swapping with deadline of +5 minutes
      await expect(
        driftingMetaSwap
          .connect(user1)
          .swapUnderlying(0, 1, String(1e17), 0, currentTimestamp + 60 * 5),
      ).to.be.revertedWith("Deadline not met")
    })

    it("Emits TokenSwap event", async () => {
      await setHigherRP()
      // User 1 initiates swap
      await expect(
        driftingMetaSwap
          .connect(user1)
          .swapUnderlying(0, 1, String(1e17), 0, MAX_UINT256),
      ).to.emit(driftingMetaSwap, "TokenSwapUnderlying")
    })
  })

  describe("getVirtualPrice", () => {
    it("Returns expected value after initial deposit", async () => {
      // As LP tokens have been distributed before the RP alteration pool tokens are worth considerably different values
      // relative to the underlying assets. ie if RP makes one side worth 1.5 and the other 1 then expect a bit less
      // than the average 1.25 after slippage.
      expect(await driftingMetaSwap.getVirtualPrice()).to.eq(
        BigNumber.from(String(1e18)),
      )
      await setHigherRP()
      expect(await driftingMetaSwap.getVirtualPrice()).to.eq(
        BigNumber.from("1249489997713579157"),
      )
      await setLowerRP()
      expect(await driftingMetaSwap.getVirtualPrice()).to.eq(
        BigNumber.from("749084212234759883"),
      )
    })

    it("Returns expected values after swaps", async () => {
      // With each swap, virtual price will increase due to the fees
      await setHigherRP()
      await driftingMetaSwap
        .connect(user1)
        .swap(0, 1, String(1e17), 0, MAX_UINT256)
      expect(await driftingMetaSwap.getVirtualPrice()).to.eq(
        BigNumber.from("1249564793276303253"),
      )
      await driftingMetaSwap
        .connect(user1)
        .swap(1, 0, String(1e17), 0, MAX_UINT256)
      expect(await driftingMetaSwap.getVirtualPrice()).to.eq(
        BigNumber.from("1249615206856672664"),
      )
    })

    it("Returns expected values after imbalanced withdrawal", async () => {
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(1e18), String(1e18)], 0, MAX_UINT256)
      await driftingMetaSwap
        .connect(user2)
        .addLiquidity([String(1e18), String(1e18)], 0, MAX_UINT256)
      expect(await driftingMetaSwap.getVirtualPrice()).to.eq(
        BigNumber.from(String(1e18)),
      )

      await setHigherRP()

      await metaLPToken
        .connect(user1)
        .approve(driftingMetaSwap.address, String(2e18))
      await driftingMetaSwap
        .connect(user1)
        .removeLiquidityImbalance([String(1e18), 0], String(2e18), MAX_UINT256)

      expect(await driftingMetaSwap.getVirtualPrice()).to.eq(
        BigNumber.from("1249615010219932918"),
      )

      await metaLPToken
        .connect(user2)
        .approve(driftingMetaSwap.address, String(2e18))
      await setLowerRP()
      await driftingMetaSwap
        .connect(user2)
        .removeLiquidityImbalance([0, String(1e18)], String(2e18), MAX_UINT256)

      expect(await driftingMetaSwap.getVirtualPrice()).to.eq(
        BigNumber.from("830450101837688234"),
      )
    })

    it("Value is unchanged after balanced deposits", async () => {
      // pool is 1:1 ratio
      expect(await driftingMetaSwap.getVirtualPrice()).to.eq(
        BigNumber.from(String(1e18)),
      )
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(1e18), String(1e18)], 0, MAX_UINT256)
      expect(await driftingMetaSwap.getVirtualPrice()).to.eq(
        BigNumber.from(String(1e18)),
      )

      // pool changes to 2:1 ratio, thus changing the virtual price
      await driftingMetaSwap
        .connect(user2)
        .addLiquidity([String(2e18), String(0)], 0, MAX_UINT256)
      expect(await driftingMetaSwap.getVirtualPrice()).to.eq(
        BigNumber.from("1000167146429977312"),
      )
      // Halve the RP so that it's back in balance other than the altered value from the RP change
      await setLowerRP()
      const expectedBothTimes = BigNumber.from("667593262609390758")
      expect(await driftingMetaSwap.getVirtualPrice()).to.eq(expectedBothTimes)
      // User 2 makes balanced deposit considering the RP so result should stay the same as above
      await driftingMetaSwap
        .connect(user2)
        .addLiquidity([String(2e18), String(1e18)], 0, MAX_UINT256)
      expect(await driftingMetaSwap.getVirtualPrice()).to.eq(expectedBothTimes)
    })

    it("Value is unchanged after balanced withdrawals", async () => {
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(1e18), String(1e18)], 0, MAX_UINT256)
      await metaLPToken
        .connect(user1)
        .approve(driftingMetaSwap.address, String(1e18))
      await driftingMetaSwap
        .connect(user1)
        .removeLiquidity(String(1e18), ["0", "0"], MAX_UINT256)
      expect(await driftingMetaSwap.getVirtualPrice()).to.eq(
        BigNumber.from(String(1e18)),
      )
    })
  })

  describe("setSwapFee", () => {
    it("Emits NewSwapFee event", async () => {
      await expect(driftingMetaSwap.setSwapFee(BigNumber.from(1e8))).to.emit(
        driftingMetaSwap,
        "NewSwapFee",
      )
    })

    it("Reverts when called by non-owners", async () => {
      await expect(driftingMetaSwap.connect(user1).setSwapFee(0)).to.be.reverted
      await expect(
        driftingMetaSwap.connect(user2).setSwapFee(BigNumber.from(1e8)),
      ).to.be.reverted
    })

    it("Reverts when fee is higher than the limit", async () => {
      await expect(driftingMetaSwap.setSwapFee(BigNumber.from(1e8).add(1))).to
        .be.reverted
    })

    it("Succeeds when fee is within the limit", async () => {
      await driftingMetaSwap.setSwapFee(BigNumber.from(1e8))
      expect((await driftingMetaSwap.swapStorage()).swapFee).to.eq(
        BigNumber.from(1e8),
      )
    })
  })

  describe("setAdminFee", () => {
    it("Emits NewAdminFee event", async () => {
      await expect(driftingMetaSwap.setAdminFee(BigNumber.from(1e10))).to.emit(
        driftingMetaSwap,
        "NewAdminFee",
      )
    })

    it("Reverts when called by non-owners", async () => {
      await expect(driftingMetaSwap.connect(user1).setSwapFee(0)).to.be.reverted
      await expect(
        driftingMetaSwap.connect(user2).setSwapFee(BigNumber.from(1e10)),
      ).to.be.reverted
    })

    it("Reverts when adminFee is higher than the limit", async () => {
      await expect(driftingMetaSwap.setAdminFee(BigNumber.from(1e10).add(1))).to
        .be.reverted
    })

    it("Succeeds when adminFee is within the limit", async () => {
      await driftingMetaSwap.setAdminFee(BigNumber.from(1e10))
      expect((await driftingMetaSwap.swapStorage()).adminFee).to.eq(
        BigNumber.from(1e10),
      )
    })
  })

  describe("getAdminBalance", () => {
    it("Reverts with 'Token index out of range'", async () => {
      await expect(driftingMetaSwap.getAdminBalance(3)).to.be.revertedWith(
        "Token index out of range",
      )
    })

    it("Is always 0 when adminFee is set to 0", async () => {
      await setHigherRP()
      expect(await driftingMetaSwap.getAdminBalance(0)).to.eq(0)
      expect(await driftingMetaSwap.getAdminBalance(1)).to.eq(0)

      await driftingMetaSwap
        .connect(user1)
        .swap(0, 1, String(1e17), 0, MAX_UINT256)

      expect(await driftingMetaSwap.getAdminBalance(0)).to.eq(0)
      expect(await driftingMetaSwap.getAdminBalance(1)).to.eq(0)
    })

    it("Returns expected amounts after swaps when adminFee is higher than 0", async () => {
      await setHigherRP()
      // Sets adminFee to 1% of the swap fees
      await driftingMetaSwap.setAdminFee(BigNumber.from(10 ** 8))
      await driftingMetaSwap
        .connect(user1)
        .swap(0, 1, String(1e17), 0, MAX_UINT256)

      expect(await driftingMetaSwap.getAdminBalance(0)).to.eq(0)
      // As the higher RP caused a larger value trade the admin balance should be proportionately larger
      expect(await driftingMetaSwap.getAdminBalance(1)).to.eq(
        String(1482490183896),
      )

      // After the first swap, the pool becomes imbalanced; there are more 0th token than 1st token in the pool.
      // Therefore swapping from 1st -> 0th will result in more 0th token returned
      // Also results in higher fees collected on the second swap.

      await driftingMetaSwap
        .connect(user1)
        .swap(1, 0, String(1e17), 0, MAX_UINT256)

      expect(await driftingMetaSwap.getAdminBalance(0)).to.eq(
        String(675276327691),
      )
      expect(await driftingMetaSwap.getAdminBalance(1)).to.eq(
        String(1482490183896),
      )
    })
  })

  describe("withdrawAdminFees", () => {
    it("Reverts when called by non-owners", async () => {
      await setHigherRP()
      await expect(driftingMetaSwap.connect(user1).withdrawAdminFees()).to.be
        .reverted
      await expect(driftingMetaSwap.connect(user2).withdrawAdminFees()).to.be
        .reverted
    })

    it("Succeeds when there are no fees withdrawn", async () => {
      await setHigherRP()
      // Sets adminFee to 1% of the swap fees
      await driftingMetaSwap.setAdminFee(BigNumber.from(10 ** 8))

      const [firstTokenBefore, secondTokenBefore] = await getUserTokenBalances(
        owner,
        [rai, baseLPToken],
      )

      await driftingMetaSwap.withdrawAdminFees()

      const [firstTokenAfter, secondTokenAfter] = await getUserTokenBalances(
        owner,
        [rai, baseLPToken],
      )

      expect(firstTokenBefore).to.eq(firstTokenAfter)
      expect(secondTokenBefore).to.eq(secondTokenAfter)
    })

    it("Succeeds with expected amount of fees withdrawn (swap)", async () => {
      await setHigherRP()
      // Sets adminFee to 1% of the swap fees
      await driftingMetaSwap.setAdminFee(BigNumber.from(10 ** 8))
      await driftingMetaSwap
        .connect(user1)
        .swap(0, 1, String(1e17), 0, MAX_UINT256)
      await setLowerRP()
      await driftingMetaSwap
        .connect(user1)
        .swap(1, 0, String(1e17), 0, MAX_UINT256)

      // Traded from 1 to zero when 1 was double the value so admin fee should be double
      expect(await driftingMetaSwap.getAdminBalance(0)).to.eq(
        String(1973400179918),
      )
      // Traded from 1 to 0 when 0 was worth fifty percent more so fee should be 1.5 times more
      expect(await driftingMetaSwap.getAdminBalance(1)).to.eq(
        String(1482490183896),
      )

      const [firstTokenBefore, secondTokenBefore] = await getUserTokenBalances(
        owner,
        [rai, baseLPToken],
      )
      await driftingMetaSwap.withdrawAdminFees()

      const [firstTokenAfter, secondTokenAfter] = await getUserTokenBalances(
        owner,
        [rai, baseLPToken],
      )

      expect(firstTokenAfter.sub(firstTokenBefore)).to.eq(String(1973400179918))
      expect(secondTokenAfter.sub(secondTokenBefore)).to.eq(
        String(1482490183896),
      )
    })

    it("Succeeds with expected amount of fees withdrawn (swapUnderlying)", async () => {
      // Sets adminFee to 1% of the swap fees
      await setHigherRP()
      await driftingMetaSwap.setAdminFee(BigNumber.from(10 ** 8))
      await driftingMetaSwap
        .connect(user1)
        .swapUnderlying(0, 1, String(1e17), 0, MAX_UINT256)
      await driftingMetaSwap
        .connect(user1)
        .swapUnderlying(1, 0, String(1e17), 0, MAX_UINT256)

      expect(await driftingMetaSwap.getAdminBalance(0)).to.eq(
        String(675142286975),
      )

      expect(await driftingMetaSwap.getAdminBalance(1)).to.eq(
        String(1482490183896),
      )

      const [firstTokenBefore, secondTokenBefore] = await getUserTokenBalances(
        owner,
        [rai, baseLPToken],
      )

      await driftingMetaSwap.withdrawAdminFees()

      const [firstTokenAfter, secondTokenAfter] = await getUserTokenBalances(
        owner,
        [rai, baseLPToken],
      )

      expect(firstTokenAfter.sub(firstTokenBefore)).to.eq(String(675142286975))
      expect(secondTokenAfter.sub(secondTokenBefore)).to.eq(
        String(1482490183896),
      )
    })

    it("Withdrawing admin fees has no impact on users' withdrawal", async () => {
      await setHigherRP()
      // Sets adminFee to 1% of the swap fees
      await driftingMetaSwap.setAdminFee(BigNumber.from(10 ** 8))
      await driftingMetaSwap
        .connect(user1)
        .addLiquidity([String(1e18), String(1e18)], 0, MAX_UINT256)

      for (let i = 0; i < 10; i++) {
        await driftingMetaSwap
          .connect(user2)
          .swap(0, 1, String(1e17), 0, MAX_UINT256)
        await driftingMetaSwap
          .connect(user2)
          .swap(1, 0, String(1485e14), 0, MAX_UINT256)
      }

      await driftingMetaSwap.withdrawAdminFees()

      const [firstTokenBefore, secondTokenBefore] = await getUserTokenBalances(
        user1,
        [rai, baseLPToken],
      )

      const user1LPTokenBalance = await metaLPToken.balanceOf(user1Address)
      await metaLPToken
        .connect(user1)
        .approve(driftingMetaSwap.address, user1LPTokenBalance)
      await driftingMetaSwap
        .connect(user1)
        .removeLiquidity(user1LPTokenBalance, [0, 0], MAX_UINT256)

      const [firstTokenAfter, secondTokenAfter] = await getUserTokenBalances(
        user1,
        [rai, baseLPToken],
      )

      expect(firstTokenAfter.sub(firstTokenBefore)).to.eq(
        BigNumber.from("1000508971050812103"),
      )

      expect(secondTokenAfter.sub(secondTokenBefore)).to.eq(
        BigNumber.from("1000715719181667297"),
      )
    })
  })

  describe("rampA", () => {
    beforeEach(async () => {
      await setHigherRP()
      await forceAdvanceOneBlock()
    })

    it("Emits RampA event", async () => {
      await expect(
        driftingMetaSwap.rampA(
          100,
          (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
        ),
      ).to.emit(driftingMetaSwap, "RampA")
    })

    it("Succeeds to ramp upwards", async () => {
      // Create imbalanced pool to measure virtual price change
      // We expect virtual price to increase as A decreases
      await driftingMetaSwap.addLiquidity([String(1e18), 0], 0, MAX_UINT256)

      // call rampA(), changing A to 100 within a span of 14 days
      const endTimestamp =
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1
      await driftingMetaSwap.rampA(100, endTimestamp)

      // +0 seconds since ramp A
      expect(await driftingMetaSwap.getA()).to.be.eq(50)
      expect(await driftingMetaSwap.getAPrecise()).to.be.eq(5000)
      expect(await driftingMetaSwap.getVirtualPrice()).to.be.eq(
        "1249679383882433617",
      )

      // set timestamp to +100000 seconds
      await setTimestamp((await getCurrentBlockTimestamp()) + 100000)
      expect(await driftingMetaSwap.getA()).to.be.eq(54)
      expect(await driftingMetaSwap.getAPrecise()).to.be.eq(5413)
      expect(await driftingMetaSwap.getVirtualPrice()).to.be.eq(
        "1249980712770790964",
      )

      // set timestamp to the end of ramp period
      await setTimestamp(endTimestamp)
      expect(await driftingMetaSwap.getA()).to.be.eq(100)
      expect(await driftingMetaSwap.getAPrecise()).to.be.eq(10000)
      expect(await driftingMetaSwap.getVirtualPrice()).to.be.eq(
        "1251678547135835521",
      )
    })

    it("Succeeds to ramp downwards", async () => {
      // Create imbalanced pool to measure virtual price change
      // We expect virtual price to decrease as A decreases
      await driftingMetaSwap.addLiquidity([String(1e18), 0], 0, MAX_UINT256)

      // call rampA()
      const endTimestamp =
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1
      await driftingMetaSwap.rampA(25, endTimestamp)

      // +0 seconds since ramp A
      expect(await driftingMetaSwap.getA()).to.be.eq(50)
      expect(await driftingMetaSwap.getAPrecise()).to.be.eq(5000)
      expect(await driftingMetaSwap.getVirtualPrice()).to.be.eq(
        "1249679383882433617",
      )

      // set timestamp to +100000 seconds
      await setTimestamp((await getCurrentBlockTimestamp()) + 100000)
      expect(await driftingMetaSwap.getA()).to.be.eq(47)
      expect(await driftingMetaSwap.getAPrecise()).to.be.eq(4794)
      expect(await driftingMetaSwap.getVirtualPrice()).to.be.eq(
        "1249510259089632345",
      )

      // set timestamp to the end of ramp period
      await setTimestamp(endTimestamp)
      expect(await driftingMetaSwap.getA()).to.be.eq(25)
      expect(await driftingMetaSwap.getAPrecise()).to.be.eq(2500)
      expect(await driftingMetaSwap.getVirtualPrice()).to.be.eq(
        "1245848416928964864",
      )
    })

    it("Reverts when non-owner calls it", async () => {
      await expect(
        driftingMetaSwap
          .connect(user1)
          .rampA(55, (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1),
      ).to.be.reverted
    })

    it("Reverts with 'Wait 1 day before starting ramp'", async () => {
      await driftingMetaSwap.rampA(
        55,
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
      )
      await expect(
        driftingMetaSwap.rampA(
          55,
          (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
        ),
      ).to.be.revertedWith("Wait 1 day before starting ramp")
    })

    it("Reverts with 'Insufficient ramp time'", async () => {
      await expect(
        driftingMetaSwap.rampA(
          55,
          (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS - 1,
        ),
      ).to.be.revertedWith("Insufficient ramp time")
    })

    it("Reverts with 'futureA_ must be > 0 and < MAX_A'", async () => {
      await expect(
        driftingMetaSwap.rampA(
          0,
          (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
        ),
      ).to.be.revertedWith("futureA_ must be > 0 and < MAX_A")
    })

    it("Reverts with 'futureA_ is too small'", async () => {
      await expect(
        driftingMetaSwap.rampA(
          24,
          (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
        ),
      ).to.be.revertedWith("futureA_ is too small")
    })

    it("Reverts with 'futureA_ is too large'", async () => {
      await expect(
        driftingMetaSwap.rampA(
          101,
          (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
        ),
      ).to.be.revertedWith("futureA_ is too large")
    })
  })

  describe("stopRampA", () => {
    it("Emits StopRampA event", async () => {
      await setHigherRP()
      // call rampA()
      await driftingMetaSwap.rampA(
        100,
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 100,
      )

      // Stop ramp
      expect(driftingMetaSwap.stopRampA()).to.emit(
        driftingMetaSwap,
        "StopRampA",
      )
    })

    it("Stop ramp succeeds", async () => {
      await setHigherRP()
      // call rampA()
      const endTimestamp =
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 100
      await driftingMetaSwap.rampA(100, endTimestamp)

      // set timestamp to +100000 seconds
      await setTimestamp((await getCurrentBlockTimestamp()) + 100000)
      expect(await driftingMetaSwap.getA()).to.be.eq(54)
      expect(await driftingMetaSwap.getAPrecise()).to.be.eq(5413)

      // Stop ramp
      await driftingMetaSwap.stopRampA()
      expect(await driftingMetaSwap.getA()).to.be.eq(54)
      expect(await driftingMetaSwap.getAPrecise()).to.be.eq(5413)

      // set timestamp to endTimestamp
      await setTimestamp(endTimestamp)

      // verify ramp has stopped
      expect(await driftingMetaSwap.getA()).to.be.eq(54)
      expect(await driftingMetaSwap.getAPrecise()).to.be.eq(5413)
    })

    it("Reverts with 'Ramp is already stopped'", async () => {
      await setHigherRP()
      // call rampA()
      const endTimestamp =
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 100
      await driftingMetaSwap.rampA(100, endTimestamp)

      // set timestamp to +10000 seconds
      await setTimestamp((await getCurrentBlockTimestamp()) + 100000)
      expect(await driftingMetaSwap.getA()).to.be.eq(54)
      expect(await driftingMetaSwap.getAPrecise()).to.be.eq(5413)

      // Stop ramp
      await driftingMetaSwap.stopRampA()
      expect(await driftingMetaSwap.getA()).to.be.eq(54)
      expect(await driftingMetaSwap.getAPrecise()).to.be.eq(5413)

      // check call reverts when ramp is already stopped
      await expect(driftingMetaSwap.stopRampA()).to.be.revertedWith(
        "Ramp is already stopped",
      )
    })
  })

  describe("Check for timestamp manipulations", () => {
    beforeEach(async () => {
      await setHigherRP()
      await forceAdvanceOneBlock()
    })

    it("Check for maximum differences in A and virtual price when A is increasing", async () => {
      // Create imbalanced pool to measure virtual price change
      // Sets the pool in 2:1 ratio where rai is significantly cheaper than lpToken
      await driftingMetaSwap.addLiquidity([String(1e18), 0], 0, MAX_UINT256)

      // Initial A and virtual price
      expect(await driftingMetaSwap.getA()).to.be.eq(50)
      expect(await driftingMetaSwap.getAPrecise()).to.be.eq(5000)
      expect(await driftingMetaSwap.getVirtualPrice()).to.be.eq(
        "1249679383882433617",
      )

      // Start ramp
      await driftingMetaSwap.rampA(
        100,
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
      )

      // Malicious miner skips 900 seconds
      await setTimestamp((await getCurrentBlockTimestamp()) + 900)

      expect(await driftingMetaSwap.getA()).to.be.eq(50)
      expect(await driftingMetaSwap.getAPrecise()).to.be.eq(5003)
      expect(await driftingMetaSwap.getVirtualPrice()).to.be.eq(
        "1249681746930908509",
      )

      // Max increase of A between two blocks
      // 5003 / 5000
      // = 1.0006

      // Max increase of virtual price between two blocks (at 2:1 ratio of tokens, starting A = 50)
      // 1000167862696363286 / 1000167146429977312
      // = 1.00000071615
    })

    it("Check for maximum differences in A and virtual price when A is decreasing", async () => {
      // Create imbalanced pool to measure virtual price change
      // Sets the pool in 2:1 ratio where rai is significantly cheaper than lpToken
      await driftingMetaSwap.addLiquidity([String(1e18), 0], 0, MAX_UINT256)

      // Initial A and virtual price
      expect(await driftingMetaSwap.getA()).to.be.eq(50)
      expect(await driftingMetaSwap.getAPrecise()).to.be.eq(5000)
      expect(await driftingMetaSwap.getVirtualPrice()).to.be.eq(
        "1249679383882433617",
      )

      // Start ramp
      await driftingMetaSwap.rampA(
        25,
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
      )

      // Malicious miner skips 900 seconds
      await setTimestamp((await getCurrentBlockTimestamp()) + 900)

      expect(await driftingMetaSwap.getA()).to.be.eq(49)
      expect(await driftingMetaSwap.getAPrecise()).to.be.eq(4999)
      expect(await driftingMetaSwap.getVirtualPrice()).to.be.eq(
        "1249678595587467013",
      )

      // Max decrease of A between two blocks
      // 4999 / 5000
      // = 0.9998

      // Max decrease of virtual price between two blocks (at 2:1 ratio of tokens, starting A = 50)
      // 1000166907487883089 / 1000167146429977312
      // = 0.99999976109
    })

    // Below tests try to verify the issues found in Curve Vulnerability Report are resolved.
    // https://medium.com/@peter_4205/curve-vulnerability-report-a1d7630140ec
    // The two cases we are most concerned are:
    //
    // 1. A is ramping up, and the pool is at imbalanced state.
    //
    // Attacker can 'resolve' the imbalance prior to the change of A. Then try to recreate the imbalance after A has
    // changed. Due to the price curve becoming more linear, recreating the imbalance will become a lot cheaper. Thus
    // benefiting the attacker.
    //
    // 2. A is ramping down, and the pool is at balanced state
    //
    // Attacker can create the imbalance in token balances prior to the change of A. Then try to resolve them
    // near 1:1 ratio. Since downward change of A will make the price curve less linear, resolving the token balances
    // to 1:1 ratio will be cheaper. Thus benefiting the attacker
    //
    // For visual representation of how price curves differ based on A, please refer to Figure 1 in the above
    // Curve Vulnerability Report.

    describe("Check for attacks while A is ramping upwards", () => {
      let initialAttackerBalances: BigNumber[] = []
      let initialPoolBalances: BigNumber[] = []
      let attacker: Signer

      beforeEach(async () => {
        // This attack is achieved by creating imbalance in the first block then
        // trading in reverse direction in the second block.
        attacker = user1

        initialAttackerBalances = await getUserTokenBalances(attacker, [
          rai,
          baseLPToken,
        ])

        expect(initialAttackerBalances[0]).to.be.eq("100000000000000000000000")
        expect(initialAttackerBalances[1]).to.be.eq(String(3e20))

        // Start ramp upwards
        await driftingMetaSwap.rampA(
          100,
          (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
        )
        expect(await driftingMetaSwap.getAPrecise()).to.be.eq(5000)

        // Check current pool balances
        initialPoolBalances = [
          await driftingMetaSwap.getTokenBalance(0),
          await driftingMetaSwap.getTokenBalance(1),
        ]
        expect(initialPoolBalances[0]).to.be.eq(String(1e18))
        expect(initialPoolBalances[1]).to.be.eq(String(1e18))
      })
    })

    describe("Check for attacks while A is ramping downwards", () => {
      let initialAttackerBalances: BigNumber[] = []
      let initialPoolBalances: BigNumber[] = []
      let attacker: Signer

      beforeEach(async () => {
        // Set up the downward ramp A
        attacker = user1

        initialAttackerBalances = await getUserTokenBalances(attacker, [
          rai,
          baseLPToken,
        ])

        expect(initialAttackerBalances[0]).to.be.eq("100000000000000000000000")
        expect(initialAttackerBalances[1]).to.be.eq(String(3e20))

        // Start ramp downwards
        await driftingMetaSwap.rampA(
          25,
          (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
        )
        expect(await driftingMetaSwap.getAPrecise()).to.be.eq(5000)

        // Check current pool balances
        initialPoolBalances = [
          await driftingMetaSwap.getTokenBalance(0),
          await driftingMetaSwap.getTokenBalance(1),
        ]
        expect(initialPoolBalances[0]).to.be.eq(String(1e18))
        expect(initialPoolBalances[1]).to.be.eq(String(1e18))
      })
    })
  })
})
