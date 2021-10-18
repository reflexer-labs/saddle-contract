import { BigNumber, Signer, Wallet } from "ethers"
import {
  MAX_UINT256,
  TIME,
  ZERO_ADDRESS,
  asyncForEach,
  deployContractWithLibraries,
  getCurrentBlockTimestamp,
  getUserTokenBalance,
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
import { MetaSwapRAI } from "../build/typechain/MetaSwapRAI"
import MetaSwapRAIArtifact from "../build/artifacts/contracts/meta/metaRAI/MetaSwapRAI.sol/MetaSwapRAI.json"
import { MetaSwapUtilsRAI } from "../build/typechain/MetaSwapUtilsRAI"
import { RedemptionPriceSnapMock } from "../build/typechain/RedemptionPriceSnapMock"
import MetaSwapUtilsRAIArtifact from "../build/artifacts/contracts/meta/metaRAI/MetaSwapUtilsRAI.sol/MetaSwapUtilsRAI.json"
import RedemptionPriceSnapMockArtifact from "../build/artifacts/contracts/meta/metaRAI/redemptionPriceSnapMock.sol/RedemptionPriceSnapMock.json"
import chai from "chai"

chai.use(solidity)
const { expect } = chai

describe("Meta-Swap", async () => {
  let signers: Array<Signer>
  let baseSwap: Swap
  let metaSwapRAI: MetaSwapRAI
  let metaSwapUtilsRAI: MetaSwapUtilsRAI
  let redemptionPriceSnapMock: RedemptionPriceSnapMock
  let susd: GenericERC20
  let RAI: GenericERC20
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
      RAI = (await deployContract(owner as Wallet, GenericERC20Artifact, [
        "RAI",
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
          await RAI.mint(address, BigNumber.from(10).pow(18).mul(100000))
        },
      )

      //deploy mock snap redemption price
      redemptionPriceSnapMock = (await deployContract(
        owner,
        RedemptionPriceSnapMockArtifact,
      )) as RedemptionPriceSnapMock
      await redemptionPriceSnapMock.deployed()

      // Deploy MetaSwapUtils
      metaSwapUtilsRAI = (await deployContract(
        owner,
        MetaSwapUtilsRAIArtifact,
      )) as MetaSwapUtilsRAI
      await metaSwapUtilsRAI.deployed()

      // Deploy Swap with SwapUtils library
      metaSwapRAI = (await deployContractWithLibraries(owner, MetaSwapRAIArtifact, {
        SwapUtils: (await get("SwapUtils")).address,
        MetaSwapUtilsRAI: (await get("MetaSwapUtilsRAI")).address,
        AmplificationUtils: (await get("AmplificationUtils")).address,
      })) as MetaSwapRAI
      await metaSwapRAI.deployed()

      // Set approvals
      await asyncForEach([owner, user1, user2], async (signer) => {
        await RAI.connect(signer).approve(metaSwapRAI.address, MAX_UINT256)
        await dai.connect(signer).approve(metaSwapRAI.address, MAX_UINT256)
        await usdc.connect(signer).approve(metaSwapRAI.address, MAX_UINT256)
        await usdt.connect(signer).approve(metaSwapRAI.address, MAX_UINT256)
        await dai.connect(signer).approve(baseSwap.address, MAX_UINT256)
        await usdc.connect(signer).approve(baseSwap.address, MAX_UINT256)
        await usdt.connect(signer).approve(baseSwap.address, MAX_UINT256)
        await baseLPToken.connect(signer).approve(metaSwapRAI.address, MAX_UINT256)

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
      await metaSwapRAI.initializeMetaSwap(
        [RAI.address, baseLPToken.address],
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
        9
      )

      metaLPToken = (await ethers.getContractAt(
        LPTokenArtifact.abi,
        (
          await metaSwapRAI.swapStorage()
        ).lpToken,
      )) as LPToken

      // Add liquidity to the meta swap pool
      await metaSwapRAI.addLiquidity([String(1e18), String(1e18)], 0, MAX_UINT256)

      expect(await RAI.balanceOf(metaSwapRAI.address)).to.eq(String(1e18))
      expect(await baseLPToken.balanceOf(metaSwapRAI.address)).to.eq(String(1e18))
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
        expect(await metaSwapRAI.getA()).to.eq(INITIAL_A_VALUE)
        expect(await metaSwapRAI.getAPrecise()).to.eq(INITIAL_A_VALUE * 100)
      })
    })

    describe("fee", async () => {
      it("Returns correct fee value", async () => {
        expect((await metaSwapRAI.swapStorage()).swapFee).to.eq(SWAP_FEE)
      })
    })

    describe("adminFee", async () => {
      it("Returns correct adminFee value", async () => {
        expect((await metaSwapRAI.swapStorage()).adminFee).to.eq(0)
      })
    })
  })

  describe("getToken", () => {
    it("Returns correct addresses of pooled tokens", async () => {
      expect(await metaSwapRAI.getToken(0)).to.eq(RAI.address)
      expect(await metaSwapRAI.getToken(1)).to.eq(baseLPToken.address)
    })

    it("Reverts when index is out of range", async () => {
      await expect(metaSwapRAI.getToken(2)).to.be.reverted
    })
  })

  describe("getTokenIndex", () => {
    it("Returns correct token indexes", async () => {
      expect(await metaSwapRAI.getTokenIndex(RAI.address)).to.be.eq(0)
      expect(await metaSwapRAI.getTokenIndex(baseLPToken.address)).to.be.eq(1)
    })

    it("Reverts when token address is not found", async () => {
      await expect(metaSwapRAI.getTokenIndex(ZERO_ADDRESS)).to.be.revertedWith(
        "Token does not exist",
      )
    })
  })

  describe("getTokenBalance", () => {
    it("Returns correct balances of pooled tokens", async () => {
      expect(await metaSwapRAI.getTokenBalance(0)).to.eq(
        BigNumber.from(String(1e18)),
      )
      expect(await metaSwapRAI.getTokenBalance(1)).to.eq(
        BigNumber.from(String(1e18)),
      )
    })

    it("Reverts when index is out of range", async () => {
      await expect(metaSwapRAI.getTokenBalance(2)).to.be.reverted
    })
  })

  describe("getA", () => {
    it("Returns correct value", async () => {
      expect(await metaSwapRAI.getA()).to.eq(INITIAL_A_VALUE)
    })
  })

  describe("addLiquidity", () => {
    it("Reverts when contract is paused", async () => {
      await metaSwapRAI.pause()

      await expect(
        metaSwapRAI
          .connect(user1)
          .addLiquidity([String(1e18), String(3e18)], 0, MAX_UINT256),
      ).to.be.reverted

      // unpause
      await metaSwapRAI.unpause()

      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(1e18), String(3e18)], 0, MAX_UINT256)

      const actualPoolTokenAmount = await metaLPToken.balanceOf(user1Address)
      expect(actualPoolTokenAmount).to.eq(BigNumber.from("6007358892051942657"))
    })

    it("Reverts with 'Amounts must match pooled tokens'", async () => {
      await expect(
        metaSwapRAI.connect(user1).addLiquidity([String(1e16)], 0, MAX_UINT256),
      ).to.be.revertedWith("Amounts must match pooled tokens")
    })

    it("Reverts with 'Cannot withdraw more than available'", async () => {
      await expect(
        metaSwapRAI
          .connect(user1)
          .calculateTokenAmount([MAX_UINT256, String(3e18)], false),
      ).to.be.revertedWith("Cannot withdraw more than available")
    })

    it("Reverts with 'Must supply all tokens in pool'", async () => {
      metaLPToken.approve(metaSwapRAI.address, MAX_UINT256)
      await metaSwapRAI.removeLiquidity(await metaLPToken.balanceOf(ownerAddress), [0, 0], MAX_UINT256)
      await expect(
        metaSwapRAI
          .connect(user1)
          .addLiquidity([0, String(3e18)], MAX_UINT256, MAX_UINT256),
      ).to.be.revertedWith("Must supply all tokens in pool")
    })

    it("Succeeds with expected output amount of pool tokens", async () => {
      const calculatedPoolTokenAmount = await metaSwapRAI
        .connect(user1)
        .calculateTokenAmount([String(1e18), String(3e18)], true)

      const calculatedPoolTokenAmountWithSlippage = calculatedPoolTokenAmount
        .mul(999)
        .div(1000)

      await metaSwapRAI
        .connect(user1)
        .addLiquidity(
          [String(1e18), String(3e18)],
          calculatedPoolTokenAmountWithSlippage,
          MAX_UINT256,
        )

      const actualPoolTokenAmount = await metaLPToken.balanceOf(user1Address)

      // The actual pool token amount is less than 4e18 due to the imbalance of the underlying tokens
      expect(actualPoolTokenAmount).to.eq(BigNumber.from("6007358892051942657"))
    })

    it("Succeeds with actual pool token amount being within ±0.1% range of calculated pool token", async () => {
      const calculatedPoolTokenAmount = await metaSwapRAI
        .connect(user1)
        .calculateTokenAmount([String(1e18), String(3e18)], true)

      const calculatedPoolTokenAmountWithNegativeSlippage =
        calculatedPoolTokenAmount.mul(999).div(1000)

      const calculatedPoolTokenAmountWithPositiveSlippage =
        calculatedPoolTokenAmount.mul(1001).div(1000)

      await metaSwapRAI
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

    it("Succeeds with correctly updated tokenBalance after imbalanced deposit", async () => {
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(1e18), String(3e18)], 0, MAX_UINT256)

      // Check updated token balance
      expect(await metaSwapRAI.getTokenBalance(0)).to.eq(
        BigNumber.from(String(2e18)),
      )
      expect(await metaSwapRAI.getTokenBalance(1)).to.eq(
        BigNumber.from(String(4e18)),
      )
    })

    it("Returns correct minted lpToken amount", async () => {
      const mintedAmount = await metaSwapRAI
        .connect(user1)
        .callStatic.addLiquidity([String(1e18), String(2e18)], 0, MAX_UINT256)

      expect(mintedAmount).to.eq("5001201536808365064")
    })

    it("Reverts when minToMint is not reached due to front running", async () => {
      const calculatedLPTokenAmount = await metaSwapRAI
        .connect(user1)
        .calculateTokenAmount([String(1e18), String(3e18)], true)

      const calculatedLPTokenAmountWithSlippage = calculatedLPTokenAmount
        .mul(999)
        .div(1000)

      // Someone else deposits thus front running user 1's deposit
      await metaSwapRAI.addLiquidity([String(1e18), String(3e18)], 0, MAX_UINT256)

      await expect(
        metaSwapRAI
          .connect(user1)
          .addLiquidity(
            [String(1e18), String(3e18)],
            calculatedLPTokenAmountWithSlippage,
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Reverts when block is mined after deadline", async () => {
      const currentTimestamp = await getCurrentBlockTimestamp()
      await setNextTimestamp(currentTimestamp + 60 * 10)

      await expect(
        metaSwapRAI
          .connect(user1)
          .addLiquidity(
            [String(2e18), String(1e16)],
            0,
            currentTimestamp + 60 * 5,
          ),
      ).to.be.revertedWith("Deadline not met")
    })

    it("Emits addLiquidity event", async () => {
      const calculatedLPTokenAmount = await metaSwapRAI
        .connect(user1)
        .calculateTokenAmount([String(2e18), String(1e16)], true)

      const calculatedLPTokenAmountWithSlippage = calculatedLPTokenAmount
        .mul(999)
        .div(1000)

      await expect(
        metaSwapRAI
          .connect(user1)
          .addLiquidity(
            [String(2e18), String(1e16)],
            calculatedLPTokenAmountWithSlippage,
            MAX_UINT256,
          ),
      ).to.emit(metaSwapRAI.connect(user1), "AddLiquidity")
    })
  })

  describe("removeLiquidity", () => {
    it("Reverts with 'Cannot exceed total supply'", async () => {
      await expect(
        metaSwapRAI.calculateRemoveLiquidity(MAX_UINT256),
      ).to.be.revertedWith("Cannot exceed total supply")
    })

    it("Reverts with 'minAmounts must match poolTokens'", async () => {
      await expect(
        metaSwapRAI.removeLiquidity(String(2e18), [0], MAX_UINT256),
      ).to.be.revertedWith("minAmounts must match poolTokens")
    })

    it("Succeeds even when contract is paused", async () => {
      // User 1 adds liquidity
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      const ownerBalance = await metaLPToken.balanceOf(ownerAddress)
      expect(currentUser1Balance).to.eq(BigNumber.from("5857269599834224948"))

      // Owner pauses the contract
      await metaSwapRAI.pause()



      // Owner and user 1 try to remove liquidity
      metaLPToken.approve(metaSwapRAI.address, ownerBalance)
      metaLPToken.connect(user1).approve(metaSwapRAI.address, currentUser1Balance)

      await metaSwapRAI.removeLiquidity(ownerBalance, [0, 0], MAX_UINT256)
      await metaSwapRAI
        .connect(user1)
        .removeLiquidity(currentUser1Balance, [0, 0], MAX_UINT256)
      expect(await RAI.balanceOf(metaSwapRAI.address)).to.eq(0)
      expect(await baseLPToken.balanceOf(metaSwapRAI.address)).to.eq(0)
    })

    it("Succeeds with expected return amounts of underlying tokens", async () => {
      // User 1 adds liquidity
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)

      const [
        firstTokenBalanceBefore,
        secondTokenBalanceBefore,
        poolTokenBalanceBefore,
      ] = await getUserTokenBalances(user1, [RAI, baseLPToken, metaLPToken])

      expect(poolTokenBalanceBefore).to.eq(
        BigNumber.from("5857269599834224948"),
      )

      const [expectedFirstTokenAmount, expectedSecondTokenAmount] =
        await metaSwapRAI.calculateRemoveLiquidity(poolTokenBalanceBefore)

      expect(expectedFirstTokenAmount).to.eq(
        BigNumber.from("1784968739501924313"),
      )
      expect(expectedSecondTokenAmount).to.eq(
        BigNumber.from("600939475632314518"),
      )

      // User 1 removes liquidity
      await metaLPToken
        .connect(user1)
        .approve(metaSwapRAI.address, poolTokenBalanceBefore)
      await metaSwapRAI
        .connect(user1)
        .removeLiquidity(
          poolTokenBalanceBefore,
          [expectedFirstTokenAmount, expectedSecondTokenAmount],
          MAX_UINT256,
        )

      const [firstTokenBalanceAfter, secondTokenBalanceAfter] =
        await getUserTokenBalances(user1, [RAI, baseLPToken])

      // Check the actual returned token amounts match the expected amounts
      expect(firstTokenBalanceAfter.sub(firstTokenBalanceBefore)).to.eq(
        expectedFirstTokenAmount,
      )
      expect(secondTokenBalanceAfter.sub(secondTokenBalanceBefore)).to.eq(
        expectedSecondTokenAmount,
      )
    })

    it("Returns correct amounts of received tokens", async () => {
      const metaLPTokenBalance = await metaLPToken.balanceOf(ownerAddress)

      await metaLPToken.approve(metaSwapRAI.address, MAX_UINT256)
      const removedTokenAmounts = await metaSwapRAI.callStatic.removeLiquidity(
        metaLPTokenBalance,
        [0, 0],
        MAX_UINT256,
      )

      expect(removedTokenAmounts[0]).to.eq("1000000000000000000")
      expect(removedTokenAmounts[1]).to.eq("1000000000000000000")
    })

    it("Reverts when user tries to burn more LP tokens than they own", async () => {
      // User 1 adds liquidity
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("5857269599834224948"))

      await expect(
        metaSwapRAI
          .connect(user1)
          .removeLiquidity(
            currentUser1Balance.add(1),
            [MAX_UINT256, MAX_UINT256],
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Reverts when minAmounts of underlying tokens are not reached due to front running", async () => {
      // User 1 adds liquidity
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("5857269599834224948"))

      const [expectedFirstTokenAmount, expectedSecondTokenAmount] =
        await metaSwapRAI.calculateRemoveLiquidity(currentUser1Balance)

      expect(expectedFirstTokenAmount).to.eq(
        BigNumber.from("1784968739501924313"),
      )
      expect(expectedSecondTokenAmount).to.eq(
        BigNumber.from("600939475632314518"),
      )

      // User 2 adds liquidity, which leads to change in balance of underlying tokens
      await metaSwapRAI
        .connect(user2)
        .addLiquidity([String(1e16), String(2e18)], 0, MAX_UINT256)

      // User 1 tries to remove liquidity which get reverted due to front running
      await metaLPToken
        .connect(user1)
        .approve(metaSwapRAI.address, currentUser1Balance)
      await expect(
        metaSwapRAI
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
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)

      const currentTimestamp = await getCurrentBlockTimestamp()
      await setNextTimestamp(currentTimestamp + 60 * 10)

      // User 1 tries removing liquidity with deadline of +5 minutes
      await metaLPToken
        .connect(user1)
        .approve(metaSwapRAI.address, currentUser1Balance)
      await expect(
        metaSwapRAI
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
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)

      // User 1 tries removes liquidity
      await metaLPToken
        .connect(user1)
        .approve(metaSwapRAI.address, currentUser1Balance)
      await expect(
        metaSwapRAI
          .connect(user1)
          .removeLiquidity(currentUser1Balance, [0, 0], MAX_UINT256),
      ).to.emit(metaSwapRAI.connect(user1), "RemoveLiquidity")
    })
  })

  describe("removeLiquidityImbalance", () => {
    it("Reverts when contract is paused", async () => {
      // User 1 adds liquidity
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("5857269599834224948"))

      // Owner pauses the contract
      await metaSwapRAI.pause()

      // Owner and user 1 try to initiate imbalanced liquidity withdrawal
      metaLPToken.approve(metaSwapRAI.address, MAX_UINT256)
      metaLPToken.connect(user1).approve(metaSwapRAI.address, MAX_UINT256)

      await expect(
        metaSwapRAI.removeLiquidityImbalance(
          [String(1e18), String(1e16)],
          MAX_UINT256,
          MAX_UINT256,
        ),
      ).to.be.reverted

      await expect(
        metaSwapRAI
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
        metaSwapRAI.removeLiquidityImbalance(
          [String(1e18)],
          MAX_UINT256,
          MAX_UINT256,
        ),
      ).to.be.revertedWith("Amounts should match pool tokens")
    })

    it("Reverts with 'Cannot withdraw more than available'", async () => {
      await expect(
        metaSwapRAI.removeLiquidityImbalance(
          [MAX_UINT256, MAX_UINT256],
          1,
          MAX_UINT256,
        ),
      ).to.be.revertedWith("Cannot withdraw more than available")
    })

    it("Succeeds with calculated max amount of pool token to be burned (±0.1%)", async () => {
      // User 1 adds liquidity
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("5857269599834224948"))

      // User 1 calculates amount of pool token to be burned
      const maxPoolTokenAmountToBeBurned = await metaSwapRAI.calculateTokenAmount(
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
      ] = await getUserTokenBalances(user1, [RAI, baseLPToken, metaLPToken])

      // User 1 withdraws imbalanced tokens
      await metaLPToken
        .connect(user1)
        .approve(metaSwapRAI.address, maxPoolTokenAmountToBeBurnedNegativeSlippage)
      await metaSwapRAI
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
      ] = await getUserTokenBalances(user1, [RAI, baseLPToken, metaLPToken])

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

      expect(actualPoolTokenBurned).to.eq(String("2915188446106073613"))
      expect(actualPoolTokenBurned).to.gte(
        maxPoolTokenAmountToBeBurnedPositiveSlippage,
      )
      expect(actualPoolTokenBurned).to.lte(
        maxPoolTokenAmountToBeBurnedNegativeSlippage,
      )
    })

    it("Returns correct amount of burned lpToken", async () => {
      // User 1 adds liquidity
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)

      // User 1 removes liquidity
      await metaLPToken.connect(user1).approve(metaSwapRAI.address, MAX_UINT256)

      const burnedLPTokenAmount = await metaSwapRAI
        .connect(user1)
        .callStatic.removeLiquidityImbalance(
          [String(1e18), String(1e16)],
          currentUser1Balance,
          MAX_UINT256,
        )

      expect(burnedLPTokenAmount).eq("2915188446106073613")
    })

    it("Reverts when user tries to burn more LP tokens than they own", async () => {
      // User 1 adds liquidity
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("5857269599834224948"))

      await expect(
        metaSwapRAI
          .connect(user1)
          .removeLiquidityImbalance(
            [String(1e18), String(1e16)],
            currentUser1Balance.add(1),
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Reverts when minAmounts of underlying tokens are not reached due to front running", async () => {
      // User 1 adds liquidity
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("5857269599834224948"))

      // User 1 calculates amount of pool token to be burned
      const maxPoolTokenAmountToBeBurned = await metaSwapRAI.calculateTokenAmount(
        [String(1e18), String(1e16)],
        false,
      )

      // Calculate +0.1% of pool token to be burned
      const maxPoolTokenAmountToBeBurnedNegativeSlippage =
        maxPoolTokenAmountToBeBurned.mul(1001).div(1000)

      // User 2 adds liquidity, which leads to change in balance of underlying tokens
      await metaSwapRAI
        .connect(user2)
        .addLiquidity([String(1e16), String(1e20)], 0, MAX_UINT256)

      // User 1 tries to remove liquidity which get reverted due to front running
      await metaLPToken
        .connect(user1)
        .approve(metaSwapRAI.address, maxPoolTokenAmountToBeBurnedNegativeSlippage)
      await expect(
        metaSwapRAI
          .connect(user1)
          .removeLiquidityImbalance(
            [String(1e18), String(1e16)],
            maxPoolTokenAmountToBeBurnedNegativeSlippage,
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Reverts when block is mined after deadline", async () => {
      // User 1 adds liquidity
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)

      const currentTimestamp = await getCurrentBlockTimestamp()
      await setNextTimestamp(currentTimestamp + 60 * 10)

      // User 1 tries removing liquidity with deadline of +5 minutes
      await metaLPToken
        .connect(user1)
        .approve(metaSwapRAI.address, currentUser1Balance)
      await expect(
        metaSwapRAI
          .connect(user1)
          .removeLiquidityImbalance(
            [String(1e18), String(1e16)],
            currentUser1Balance,
            currentTimestamp + 60 * 5,
          ),
      ).to.be.revertedWith("Deadline not met")
    })

    it("Emits RemoveLiquidityImbalance event", async () => {
      // User 1 adds liquidity
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)

      // User 1 removes liquidity
      await metaLPToken.connect(user1).approve(metaSwapRAI.address, MAX_UINT256)

      await expect(
        metaSwapRAI
          .connect(user1)
          .removeLiquidityImbalance(
            [String(1e18), String(1e16)],
            currentUser1Balance,
            MAX_UINT256,
          ),
      ).to.emit(metaSwapRAI.connect(user1), "RemoveLiquidityImbalance")
    })
  })

  describe("removeLiquidityOneToken", () => {
    it("Reverts when contract is paused.", async () => {
      // User 1 adds liquidity
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("5857269599834224948"))

      // Owner pauses the contract
      await metaSwapRAI.pause()

      // Owner and user 1 try to remove liquidity via single token
      metaLPToken.approve(metaSwapRAI.address, String(2e18))
      metaLPToken.connect(user1).approve(metaSwapRAI.address, currentUser1Balance)

      await expect(
        metaSwapRAI.removeLiquidityOneToken(String(2e18), 0, 0, MAX_UINT256),
      ).to.be.reverted
      await expect(
        metaSwapRAI
          .connect(user1)
          .removeLiquidityOneToken(currentUser1Balance, 0, 0, MAX_UINT256),
      ).to.be.reverted
    })

    it("Reverts with 'Token index out of range'", async () => {
      await expect(
        metaSwapRAI.calculateRemoveLiquidityOneToken(1, 5),
      ).to.be.revertedWith("Token index out of range")
    })

    it("Reverts with 'Withdraw exceeds available'", async () => {
      // User 1 adds liquidity
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("5857269599834224948"))

      await expect(
        metaSwapRAI.calculateRemoveLiquidityOneToken(
          currentUser1Balance.mul(162).div(100),
          0,
        ),
      ).to.be.revertedWith("Withdraw exceeds available")
    })

    it("Reverts with 'Token not found'", async () => {
      await expect(
        metaSwapRAI.connect(user1).removeLiquidityOneToken(0, 9, 1, MAX_UINT256),
      ).to.be.revertedWith("Token not found")
    })

    it("Succeeds with calculated token amount as minAmount", async () => {
      // User 1 adds liquidity
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("5857269599834224948"))

      // User 1 calculates the amount of underlying token to receive.
      const calculatedFirstTokenAmount =
        await metaSwapRAI.calculateRemoveLiquidityOneToken(currentUser1Balance, 0)
      expect(calculatedFirstTokenAmount).to.eq(
        BigNumber.from("2003012752713631075"),
      )

      // User 1 initiates one token withdrawal
      const before = await RAI.balanceOf(user1Address)
      metaLPToken.connect(user1).approve(metaSwapRAI.address, currentUser1Balance)
      await metaSwapRAI
        .connect(user1)
        .removeLiquidityOneToken(
          currentUser1Balance,
          0,
          calculatedFirstTokenAmount,
          MAX_UINT256,
        )
      const after = await RAI.balanceOf(user1Address)

      expect(after.sub(before)).to.eq(BigNumber.from("2003012752713631075"))
    })

    it("Returns correct amount of received token", async () => {
      await metaLPToken.approve(metaSwapRAI.address, MAX_UINT256)
      const removedTokenAmount =
        await metaSwapRAI.callStatic.removeLiquidityOneToken(
          String(1e18),
          0,
          0,
          MAX_UINT256,
        )
      expect(removedTokenAmount).to.eq("336363294771444021")
    })

    it("Reverts when user tries to burn more LP tokens than they own", async () => {
      // User 1 adds liquidity
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("5857269599834224948"))

      await expect(
        metaSwapRAI
          .connect(user1)
          .removeLiquidityOneToken(
            currentUser1Balance.add(1),
            0,
            0,
            MAX_UINT256,
          ),
      ).to.be.reverted
    })

    it("Reverts when minAmount of underlying token is not reached due to front running", async () => {
      // User 1 adds liquidity
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)
      expect(currentUser1Balance).to.eq(BigNumber.from("5857269599834224948"))

      // User 1 calculates the amount of underlying token to receive.
      const calculatedFirstTokenAmount =
        await metaSwapRAI.calculateRemoveLiquidityOneToken(currentUser1Balance, 0)
      expect(calculatedFirstTokenAmount).to.eq(
        BigNumber.from("2003012752713631075"),
      )

      // User 2 adds liquidity before User 1 initiates withdrawal
      await metaSwapRAI
        .connect(user2)
        .addLiquidity([String(1e16), String(1e20)], 0, MAX_UINT256)

      // User 1 initiates one token withdrawal
      metaLPToken.connect(user1).approve(metaSwapRAI.address, currentUser1Balance)
      await expect(
        metaSwapRAI
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
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)

      const currentTimestamp = await getCurrentBlockTimestamp()
      await setNextTimestamp(currentTimestamp + 60 * 10)

      // User 1 tries removing liquidity with deadline of +5 minutes
      await metaLPToken
        .connect(user1)
        .approve(metaSwapRAI.address, currentUser1Balance)
      await expect(
        metaSwapRAI
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
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(2e18), String(1e16)], 0, MAX_UINT256)
      const currentUser1Balance = await metaLPToken.balanceOf(user1Address)

      await metaLPToken
        .connect(user1)
        .approve(metaSwapRAI.address, currentUser1Balance)
      await expect(
        metaSwapRAI
          .connect(user1)
          .removeLiquidityOneToken(currentUser1Balance, 0, 0, MAX_UINT256),
      ).to.emit(metaSwapRAI.connect(user1), "RemoveLiquidityOne")
    })
  })

  describe("swap", () => {
    it("Reverts when contract is paused", async () => {
      // Owner pauses the contract
      await metaSwapRAI.pause()

      // User 1 try to initiate swap
      await expect(
        metaSwapRAI.connect(user1).swap(0, 1, String(1e16), 0, MAX_UINT256),
      ).to.be.reverted
    })

    it("Reverts with 'Token index out of range'", async () => {
      await expect(
        metaSwapRAI.calculateSwap(0, 9, String(1e17)),
      ).to.be.revertedWith("Token index out of range")
    })

    it("Reverts with 'Cannot swap more than you own'", async () => {
      await expect(
        metaSwapRAI.connect(user1).swap(0, 1, MAX_UINT256, 0, MAX_UINT256),
      ).to.be.revertedWith("Cannot swap more than you own")
    })

    it("Succeeds with expected swap amounts", async () => {
      // User 1 calculates how much token to receive
      const calculatedSwapReturn = await metaSwapRAI.calculateSwap(
        0,
        1,
        String(1e17),
      )
      expect(calculatedSwapReturn).to.eq(BigNumber.from("285319950088778459"))

      const [tokenFromBalanceBefore, tokenToBalanceBefore] =
        await getUserTokenBalances(user1, [RAI, baseLPToken])

      // User 1 successfully initiates swap
      await metaSwapRAI
        .connect(user1)
        .swap(0, 1, String(1e17), calculatedSwapReturn, MAX_UINT256)

      // Check the sent and received amounts are as expected
      const [tokenFromBalanceAfter, tokenToBalanceAfter] =
        await getUserTokenBalances(user1, [RAI, baseLPToken])
      expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
        BigNumber.from(String(1e17)),
      )
      expect(tokenToBalanceAfter.sub(tokenToBalanceBefore)).to.eq(
        calculatedSwapReturn,
      )
    })

    it("Reverts when minDy (minimum amount token to receive) is not reached due to front running", async () => {
      // User 1 calculates how much token to receive
      const calculatedSwapReturn = await metaSwapRAI.calculateSwap(
        0,
        1,
        String(1e17),
      )
      expect(calculatedSwapReturn).to.eq(BigNumber.from("285319950088778459"))

      // User 2 swaps before User 1 does
      await metaSwapRAI.connect(user2).swap(0, 1, String(1e17), 0, MAX_UINT256)

      // User 1 initiates swap
      await expect(
        metaSwapRAI
          .connect(user1)
          .swap(0, 1, String(1e17), calculatedSwapReturn, MAX_UINT256),
      ).to.be.reverted
    })

    it("Succeeds when using lower minDy even when transaction is front-ran", async () => {
      // User 1 calculates how much token to receive with 1% slippage
      const calculatedSwapReturn = await metaSwapRAI.calculateSwap(
        0,
        1,
        String(1e17),
      )
      expect(calculatedSwapReturn).to.eq(BigNumber.from("285319950088778459"))

      const [tokenFromBalanceBefore, tokenToBalanceBefore] =
        await getUserTokenBalances(user1, [RAI, baseLPToken])

      const calculatedSwapReturnWithNegativeSlippage = calculatedSwapReturn
        .mul(92)
        .div(100)

      // User 2 swaps before User 1 does
      await metaSwapRAI.connect(user2).swap(0, 1, String(1e17), 0, MAX_UINT256)

      // User 1 successfully initiates swap with 8% slippage from initial calculated amount
      await metaSwapRAI
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
        await getUserTokenBalances(user1, [RAI, baseLPToken])

      expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
        BigNumber.from(String(1e17)),
      )

      const actualReceivedAmount = tokenToBalanceAfter.sub(tokenToBalanceBefore)

      expect(actualReceivedAmount).to.eq(BigNumber.from("268256616949382625"))
      expect(actualReceivedAmount).to.gt(
        calculatedSwapReturnWithNegativeSlippage,
      )
      expect(actualReceivedAmount).to.lt(calculatedSwapReturn)
    })

    it("Returns correct amount of received token", async () => {
      const swapReturnAmount = await metaSwapRAI.callStatic.swap(
        0,
        1,
        String(1e18),
        0,
        MAX_UINT256,
      )
      expect(swapReturnAmount).to.eq("986227857942205817")
    })

    it("Reverts when block is mined after deadline", async () => {
      const currentTimestamp = await getCurrentBlockTimestamp()
      await setNextTimestamp(currentTimestamp + 60 * 10)

      // User 1 tries swapping with deadline of +5 minutes
      await expect(
        metaSwapRAI
          .connect(user1)
          .swap(0, 1, String(1e17), 0, currentTimestamp + 60 * 5),
      ).to.be.revertedWith("Deadline not met")
    })

    it("Emits TokenSwap event", async () => {
      // User 1 initiates swap
      await expect(
        metaSwapRAI.connect(user1).swap(0, 1, String(1e17), 0, MAX_UINT256),
      ).to.emit(metaSwapRAI, "TokenSwap")
    })
  })

  describe("swapUnderlying", () => {
    it("Reverts when contract is paused", async () => {
      // Owner pauses the contract
      await metaSwapRAI.pause()

      // User 1 try to initiate swap
      await expect(
        metaSwapRAI
          .connect(user1)
          .swapUnderlying(0, 1, String(1e16), 0, MAX_UINT256),
      ).to.be.reverted
    })

    it("Reverts with 'Token index out of range'", async () => {
      await expect(
        metaSwapRAI.calculateSwapUnderlying(0, 9, String(1e17)),
      ).to.be.revertedWith("Token index out of range")

      await expect(
        metaSwapRAI.swapUnderlying(0, 9, String(1e17), 0, MAX_UINT256),
      ).to.be.revertedWith("Token index out of range")
    })

    describe("Succeeds with expected swap amounts", () => {
      it("From 18 decimal token (meta) to 18 decimal token (base)", async () => {
        // User 1 calculates how much token to receive
        const calculatedSwapReturn = await metaSwapRAI.calculateSwapUnderlying(
          0,
          1,
          String(1e17),
        )
        expect(calculatedSwapReturn).to.eq(BigNumber.from("285262436051108700"))

        const [tokenFromBalanceBefore, tokenToBalanceBefore] =
          await getUserTokenBalances(user1, [RAI, dai])

        // User 1 successfully initiates swap
        await metaSwapRAI
          .connect(user1)
          .swapUnderlying(0, 1, String(1e17), calculatedSwapReturn, MAX_UINT256)

        // Check the sent and received amounts are as expected
        const [tokenFromBalanceAfter, tokenToBalanceAfter] =
          await getUserTokenBalances(user1, [RAI, dai])
        expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
          BigNumber.from(String(1e17)),
        )
        expect(tokenToBalanceAfter.sub(tokenToBalanceBefore)).to.eq(
          calculatedSwapReturn,
        )
      })

      it("From 6 decimal token (base) to 18 decimal token (meta)", async () => {
        // User 1 calculates how much token to receive
        const calculatedSwapReturn = await metaSwapRAI.calculateSwapUnderlying(
          2,
          0,
          String(1e5),
        )
        expect(calculatedSwapReturn).to.eq(BigNumber.from("34329889552906113"))

        // Calculating swapping from a base token to a meta level token
        // does not account for base pool's swap fees
        const minReturnWithNegativeSlippage = calculatedSwapReturn
          .mul(999)
          .div(1000)

        const [tokenFromBalanceBefore, tokenToBalanceBefore] =
          await getUserTokenBalances(user1, [usdc, RAI])

        // User 1 successfully initiates swap
        await metaSwapRAI
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
          await getUserTokenBalances(user1, [usdc, RAI])
        expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
          BigNumber.from(String(1e5)),
        )
        expect(tokenToBalanceAfter.sub(tokenToBalanceBefore)).to.eq(
          "102970164423637841",
        )
      })

      it("From 18 decimal token (meta) to 6 decimal token (base)", async () => {
        // User 1 calculates how much token to receive
        const calculatedSwapReturn = await metaSwapRAI.calculateSwapUnderlying(
          0,
          2,
          String(1e17),
        )
        expect(calculatedSwapReturn).to.eq(BigNumber.from("285262"))

        const [tokenFromBalanceBefore, tokenToBalanceBefore] =
          await getUserTokenBalances(user1, [RAI, usdc])

        // User 1 successfully initiates swap
        await metaSwapRAI
          .connect(user1)
          .swapUnderlying(0, 2, String(1e17), calculatedSwapReturn, MAX_UINT256)

        // Check the sent and received amounts are as expected
        const [tokenFromBalanceAfter, tokenToBalanceAfter] =
          await getUserTokenBalances(user1, [RAI, usdc])
        expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
          BigNumber.from(String(1e17)),
        )
        expect(tokenToBalanceAfter.sub(tokenToBalanceBefore)).to.eq(
          calculatedSwapReturn,
        )
      })

      it("From 18 decimal token (base) to 6 decimal token (base)", async () => {
        // User 1 calculates how much token to receive
        const calculatedSwapReturn = await metaSwapRAI.calculateSwapUnderlying(
          1,
          3,
          String(1e17),
        )
        expect(calculatedSwapReturn).to.eq(BigNumber.from("99959"))

        const [tokenFromBalanceBefore, tokenToBalanceBefore] =
          await getUserTokenBalances(user1, [dai, usdt])

        // User 1 successfully initiates swap
        await metaSwapRAI
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
      // User 1 calculates how much token to receive
      const calculatedSwapReturn = await metaSwapRAI.calculateSwapUnderlying(
        0,
        1,
        String(1e17),
      )
      expect(calculatedSwapReturn).to.eq(BigNumber.from("285262436051108700"))

      // User 2 swaps before User 1 does
      await metaSwapRAI
        .connect(user2)
        .swapUnderlying(0, 1, String(1e17), 0, MAX_UINT256)

      // User 1 initiates swap
      await expect(
        metaSwapRAI
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
      // User 1 calculates how much token to receive with 1% slippage
      const calculatedSwapReturn = await metaSwapRAI.calculateSwapUnderlying(
        0,
        1,
        String(1e17),
      )
      expect(calculatedSwapReturn).to.eq(BigNumber.from("285262436051108700"))

      const [tokenFromBalanceBefore, tokenToBalanceBefore] =
        await getUserTokenBalances(user1, [RAI, dai])

      const calculatedSwapReturnWithNegativeSlippage = calculatedSwapReturn
        .mul(92)
        .div(100)

      // User 2 swaps before User 1 does
      await metaSwapRAI.connect(user2).swap(0, 1, String(1e17), 0, MAX_UINT256)

      // User 1 successfully initiates swap with 8% slippage from initial calculated amount
      await metaSwapRAI
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
        await getUserTokenBalances(user1, [RAI, dai])

      expect(tokenFromBalanceBefore.sub(tokenFromBalanceAfter)).to.eq(
        BigNumber.from(String(1e17)),
      )

      const actualReceivedAmount = tokenToBalanceAfter.sub(tokenToBalanceBefore)

      expect(actualReceivedAmount).to.eq(BigNumber.from("268202567810724106"))
      expect(actualReceivedAmount).to.gt(
        calculatedSwapReturnWithNegativeSlippage,
      )
      expect(actualReceivedAmount).to.lt(calculatedSwapReturn)
    })

    it("Returns correct amount of received token", async () => {
      const swapReturnAmount = await metaSwapRAI.callStatic.swapUnderlying(
        0,
        1,
        String(1e17),
        0,
        MAX_UINT256,
      )
      expect(swapReturnAmount).to.eq("285262436051108700")
    })

    it("Reverts when block is mined after deadline", async () => {
      const currentTimestamp = await getCurrentBlockTimestamp()
      await setNextTimestamp(currentTimestamp + 60 * 10)

      // User 1 tries swapping with deadline of +5 minutes
      await expect(
        metaSwapRAI
          .connect(user1)
          .swapUnderlying(0, 1, String(1e17), 0, currentTimestamp + 60 * 5),
      ).to.be.revertedWith("Deadline not met")
    })

    it("Emits TokenSwap event", async () => {
      // User 1 initiates swap
      await expect(
        metaSwapRAI
          .connect(user1)
          .swapUnderlying(0, 1, String(1e17), 0, MAX_UINT256),
      ).to.emit(metaSwapRAI, "TokenSwapUnderlying")
    })
  })

  describe("getVirtualPrice", () => {
    it("Returns expected value after initial deposit", async () => {
      expect(await metaSwapRAI.getVirtualPrice()).to.eq(
        BigNumber.from(String(1e18)),
      )
    })

    it("Returns expected values after swaps", async () => {
      // With each swap, virtual price will increase due to the fees
      await metaSwapRAI.connect(user1).swap(0, 1, String(1e17), 0, MAX_UINT256)
      expect(await metaSwapRAI.getVirtualPrice()).to.eq(
        BigNumber.from("1000075315447771904"),
      )

      await metaSwapRAI.connect(user1).swap(1, 0, String(1e17), 0, MAX_UINT256)
      expect(await metaSwapRAI.getVirtualPrice()).to.eq(
        BigNumber.from("792931695027079933"),
      )
    })

    it("Returns expected values after imbalanced withdrawal", async () => {
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(1e18), String(1e18)], 0, MAX_UINT256)
      await metaSwapRAI
        .connect(user2)
        .addLiquidity([String(1e18), String(1e18)], 0, MAX_UINT256)
      expect(await metaSwapRAI.getVirtualPrice()).to.eq(
        BigNumber.from(String(1e18)),
      )

      await metaLPToken.connect(user1).approve(metaSwapRAI.address, String(3e18))
      await metaSwapRAI
        .connect(user1)
        .removeLiquidityImbalance([String(1e18), 0], String(3e18), MAX_UINT256)

      expect(await metaSwapRAI.getVirtualPrice()).to.eq(
        BigNumber.from("1000084067419656114"),
      )

      await metaLPToken.connect(user2).approve(metaSwapRAI.address, String(2e18))
      await metaSwapRAI
        .connect(user2)
        .removeLiquidityImbalance([0, String(1e18)], String(2e18), MAX_UINT256)

      expect(await metaSwapRAI.getVirtualPrice()).to.eq(
        BigNumber.from("1000168451649118960"),
      )
    })

    it("Value is unchanged after balanced deposits", async () => {
      // pool is 1:1 ratio
      expect(await metaSwapRAI.getVirtualPrice()).to.eq(
        BigNumber.from(String(1e18)),
      )
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(1e18), String(1e18)], 0, MAX_UINT256)
      expect(await metaSwapRAI.getVirtualPrice()).to.eq(
        BigNumber.from(String(1e18)),
      )

      // pool changes to 2:1 ratio, thus changing the virtual price
      await metaSwapRAI
        .connect(user2)
        .addLiquidity([String(2e18), String(0)], 0, MAX_UINT256)
      expect(await metaSwapRAI.getVirtualPrice()).to.eq(
        BigNumber.from("1000112966333319508"),
      )
      // User 2 makes balanced deposit, keeping the ratio 2:1
      await metaSwapRAI
        .connect(user2)
        .addLiquidity([String(2e18), String(1e18)], 0, MAX_UINT256)
      expect(await metaSwapRAI.getVirtualPrice()).to.eq(
        BigNumber.from("1000112966333319508"),
      )
    })

    it("Value is unchanged after balanced withdrawals", async () => {
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(1e18), String(1e18)], 0, MAX_UINT256)
      await metaLPToken.connect(user1).approve(metaSwapRAI.address, String(1e18))
      await metaSwapRAI
        .connect(user1)
        .removeLiquidity(String(1e18), ["0", "0"], MAX_UINT256)
      expect(await metaSwapRAI.getVirtualPrice()).to.eq(
        BigNumber.from(String(1e18)),
      )
    })
  })

  describe("setSwapFee", () => {
    it("Emits NewSwapFee event", async () => {
      await expect(metaSwapRAI.setSwapFee(BigNumber.from(1e8))).to.emit(
        metaSwapRAI,
        "NewSwapFee",
      )
    })

    it("Reverts when called by non-owners", async () => {
      await expect(metaSwapRAI.connect(user1).setSwapFee(0)).to.be.reverted
      await expect(metaSwapRAI.connect(user2).setSwapFee(BigNumber.from(1e8))).to
        .be.reverted
    })

    it("Reverts when fee is higher than the limit", async () => {
      await expect(metaSwapRAI.setSwapFee(BigNumber.from(1e8).add(1))).to.be
        .reverted
    })

    it("Succeeds when fee is within the limit", async () => {
      await metaSwapRAI.setSwapFee(BigNumber.from(1e8))
      expect((await metaSwapRAI.swapStorage()).swapFee).to.eq(BigNumber.from(1e8))
    })
  })

  describe("setAdminFee", () => {
    it("Emits NewAdminFee event", async () => {
      await expect(metaSwapRAI.setAdminFee(BigNumber.from(1e10))).to.emit(
        metaSwapRAI,
        "NewAdminFee",
      )
    })

    it("Reverts when called by non-owners", async () => {
      await expect(metaSwapRAI.connect(user1).setSwapFee(0)).to.be.reverted
      await expect(metaSwapRAI.connect(user2).setSwapFee(BigNumber.from(1e10))).to
        .be.reverted
    })

    it("Reverts when adminFee is higher than the limit", async () => {
      await expect(metaSwapRAI.setAdminFee(BigNumber.from(1e10).add(1))).to.be
        .reverted
    })

    it("Succeeds when adminFee is within the limit", async () => {
      await metaSwapRAI.setAdminFee(BigNumber.from(1e10))
      expect((await metaSwapRAI.swapStorage()).adminFee).to.eq(
        BigNumber.from(1e10),
      )
    })
  })

  describe("getAdminBalance", () => {
    it("Reverts with 'Token index out of range'", async () => {
      await expect(metaSwapRAI.getAdminBalance(3)).to.be.revertedWith(
        "Token index out of range",
      )
    })

    it("Is always 0 when adminFee is set to 0", async () => {
      expect(await metaSwapRAI.getAdminBalance(0)).to.eq(0)
      expect(await metaSwapRAI.getAdminBalance(1)).to.eq(0)

      await metaSwapRAI.connect(user1).swap(0, 1, String(1e17), 0, MAX_UINT256)

      expect(await metaSwapRAI.getAdminBalance(0)).to.eq(0)
      expect(await metaSwapRAI.getAdminBalance(1)).to.eq(0)
    })

    it("Returns expected amounts after swaps when adminFee is higher than 0", async () => {
      // Sets adminFee to 1% of the swap fees
      await metaSwapRAI.setAdminFee(BigNumber.from(10 ** 8))
      await metaSwapRAI.connect(user1).swap(0, 1, String(1e17), 0, MAX_UINT256)

      expect(await metaSwapRAI.getAdminBalance(0)).to.eq(0)
      expect(await metaSwapRAI.getAdminBalance(1)).to.eq(String(2856055556444))

      // After the first swap, the pool becomes imbalanced; there are more 0th token than 1st token in the pool.
      // Therefore swapping from 1st -> 0th will result in more 0th token returned
      // Also results in higher fees collected on the second swap.

      await metaSwapRAI.connect(user1).swap(1, 0, String(1e17), 0, MAX_UINT256)

      expect(await metaSwapRAI.getAdminBalance(0)).to.eq(String(3148757778478))
      expect(await metaSwapRAI.getAdminBalance(1)).to.eq(String(2856055556444))
    })
  })

  describe("withdrawAdminFees", () => {
    it("Reverts when called by non-owners", async () => {
      await expect(metaSwapRAI.connect(user1).withdrawAdminFees()).to.be.reverted
      await expect(metaSwapRAI.connect(user2).withdrawAdminFees()).to.be.reverted
    })

    it("Succeeds when there are no fees withdrawn", async () => {
      // Sets adminFee to 1% of the swap fees
      await metaSwapRAI.setAdminFee(BigNumber.from(10 ** 8))

      const [firstTokenBefore, secondTokenBefore] = await getUserTokenBalances(
        owner,
        [RAI, baseLPToken],
      )

      await metaSwapRAI.withdrawAdminFees()

      const [firstTokenAfter, secondTokenAfter] = await getUserTokenBalances(
        owner,
        [RAI, baseLPToken],
      )

      expect(firstTokenBefore).to.eq(firstTokenAfter)
      expect(secondTokenBefore).to.eq(secondTokenAfter)
    })

    it("Succeeds with expected amount of fees withdrawn (swap)", async () => {
      // Sets adminFee to 1% of the swap fees
      await metaSwapRAI.setAdminFee(BigNumber.from(10 ** 8))
      await metaSwapRAI.connect(user1).swap(0, 1, String(1e17), 0, MAX_UINT256)
      await metaSwapRAI.connect(user1).swap(1, 0, String(1e17), 0, MAX_UINT256)

      expect(await metaSwapRAI.getAdminBalance(0)).to.eq(String(3148757778478))
      expect(await metaSwapRAI.getAdminBalance(1)).to.eq(String(2856055556444))

      const [firstTokenBefore, secondTokenBefore] = await getUserTokenBalances(
        owner,
        [RAI, baseLPToken],
      )

      await metaSwapRAI.withdrawAdminFees()

      const [firstTokenAfter, secondTokenAfter] = await getUserTokenBalances(
        owner,
        [RAI, baseLPToken],
      )

      expect(firstTokenAfter.sub(firstTokenBefore)).to.eq(String(3148757778478))
      expect(secondTokenAfter.sub(secondTokenBefore)).to.eq(
        String(2856055556444),
      )
    })

    it("Succeeds with expected amount of fees withdrawn (swapUnderlying)", async () => {
      // Sets adminFee to 1% of the swap fees
      await metaSwapRAI.setAdminFee(BigNumber.from(10 ** 8))
      await metaSwapRAI
        .connect(user1)
        .swapUnderlying(0, 1, String(1e17), 0, MAX_UINT256)
      await metaSwapRAI
        .connect(user1)
        .swapUnderlying(1, 0, String(1e17), 0, MAX_UINT256)

      expect(await metaSwapRAI.getAdminBalance(0)).to.eq(String(1062659394616))
      expect(await metaSwapRAI.getAdminBalance(1)).to.eq(String(2856055556444))

      const [firstTokenBefore, secondTokenBefore] = await getUserTokenBalances(
        owner,
        [RAI, baseLPToken],
      )

      await metaSwapRAI.withdrawAdminFees()

      const [firstTokenAfter, secondTokenAfter] = await getUserTokenBalances(
        owner,
        [RAI, baseLPToken],
      )

      expect(firstTokenAfter.sub(firstTokenBefore)).to.eq(String(1062659394616))
      expect(secondTokenAfter.sub(secondTokenBefore)).to.eq(
        String(2856055556444),
      )
    })

    it("Withdrawing admin fees has no impact on users' withdrawal", async () => {
      // Sets adminFee to 1% of the swap fees
      await metaSwapRAI.setAdminFee(BigNumber.from(10 ** 8))
      await metaSwapRAI
        .connect(user1)
        .addLiquidity([String(1e18), String(1e18)], 0, MAX_UINT256)

      for (let i = 0; i < 5; i++) {
        await metaSwapRAI.connect(user2).swap(0, 1, String(1e17), 0, MAX_UINT256)
        await metaSwapRAI.connect(user2).swap(1, 0, String(1e17), 0, MAX_UINT256)
      }

      await metaSwapRAI.withdrawAdminFees()

      const [firstTokenBefore, secondTokenBefore] = await getUserTokenBalances(
        user1,
        [RAI, baseLPToken],
      )

      const user1LPTokenBalance = await metaLPToken.balanceOf(user1Address)
      await metaLPToken
        .connect(user1)
        .approve(metaSwapRAI.address, user1LPTokenBalance)
      await metaSwapRAI
        .connect(user1)
        .removeLiquidity(user1LPTokenBalance, [0, 0], MAX_UINT256)

      const [firstTokenAfter, secondTokenAfter] = await getUserTokenBalances(
        user1,
        [RAI, baseLPToken],
      )

      expect(firstTokenAfter.sub(firstTokenBefore)).to.eq(
        BigNumber.from("470251271037591515"),
      )

      expect(secondTokenAfter.sub(secondTokenBefore)).to.eq(
        BigNumber.from("530289168523327435"),
      )
    })
  })

  describe("rampA", () => {
    beforeEach(async () => {
      await forceAdvanceOneBlock()
    })

    it("Emits RampA event", async () => {
      await expect(
        metaSwapRAI.rampA(
          100,
          (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
        ),
      ).to.emit(metaSwapRAI, "RampA")
    })

    it("Succeeds to ramp upwards", async () => {
      // Create imbalanced pool to measure virtual price change
      // We expect virtual price to increase as A decreases
      await metaSwapRAI.addLiquidity([String(1e18), 0], 0, MAX_UINT256)

      // call rampA(), changing A to 100 within a span of 14 days
      const endTimestamp =
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1
      await metaSwapRAI.rampA(100, endTimestamp)

      // +0 seconds since ramp A
      expect(await metaSwapRAI.getA()).to.be.eq(50)
      expect(await metaSwapRAI.getAPrecise()).to.be.eq(5000)
      expect(await metaSwapRAI.getVirtualPrice()).to.be.eq("1000112966333319508")

      // set timestamp to +100000 seconds
      await setTimestamp((await getCurrentBlockTimestamp()) + 100000)
      expect(await metaSwapRAI.getA()).to.be.eq(54)
      expect(await metaSwapRAI.getAPrecise()).to.be.eq(5413)
      expect(await metaSwapRAI.getVirtualPrice()).to.be.eq("1000843297812379753")

      // set timestamp to the end of ramp period
      await setTimestamp(endTimestamp)
      expect(await metaSwapRAI.getA()).to.be.eq(100)
      expect(await metaSwapRAI.getAPrecise()).to.be.eq(10000)
      expect(await metaSwapRAI.getVirtualPrice()).to.be.eq("1004997514367357405")
    })

    it("Succeeds to ramp downwards", async () => {
      // Create imbalanced pool to measure virtual price change
      // We expect virtual price to decrease as A decreases
      await metaSwapRAI.addLiquidity([String(1e18), 0], 0, MAX_UINT256)

      // call rampA()
      const endTimestamp =
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1
      await metaSwapRAI.rampA(25, endTimestamp)

      // +0 seconds since ramp A
      expect(await metaSwapRAI.getA()).to.be.eq(50)
      expect(await metaSwapRAI.getAPrecise()).to.be.eq(5000)
      expect(await metaSwapRAI.getVirtualPrice()).to.be.eq("1000112966333319508")

      // set timestamp to +100000 seconds
      await setTimestamp((await getCurrentBlockTimestamp()) + 100000)
      expect(await metaSwapRAI.getA()).to.be.eq(47)
      expect(await metaSwapRAI.getAPrecise()).to.be.eq(4794)
      expect(await metaSwapRAI.getVirtualPrice()).to.be.eq("999703956164870752")

      // set timestamp to the end of ramp period
      await setTimestamp(endTimestamp)
      expect(await metaSwapRAI.getA()).to.be.eq(25)
      expect(await metaSwapRAI.getAPrecise()).to.be.eq(2500)
      expect(await metaSwapRAI.getVirtualPrice()).to.be.eq("991000106847751845")
    })

    it("Reverts when non-owner calls it", async () => {
      await expect(
        metaSwapRAI
          .connect(user1)
          .rampA(55, (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1),
      ).to.be.reverted
    })

    it("Reverts with 'Wait 1 day before starting ramp'", async () => {
      await metaSwapRAI.rampA(
        55,
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
      )
      await expect(
        metaSwapRAI.rampA(
          55,
          (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
        ),
      ).to.be.revertedWith("Wait 1 day before starting ramp")
    })

    it("Reverts with 'Insufficient ramp time'", async () => {
      await expect(
        metaSwapRAI.rampA(
          55,
          (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS - 1,
        ),
      ).to.be.revertedWith("Insufficient ramp time")
    })

    it("Reverts with 'futureA_ must be > 0 and < MAX_A'", async () => {
      await expect(
        metaSwapRAI.rampA(
          0,
          (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
        ),
      ).to.be.revertedWith("futureA_ must be > 0 and < MAX_A")
    })

    it("Reverts with 'futureA_ is too small'", async () => {
      await expect(
        metaSwapRAI.rampA(
          24,
          (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
        ),
      ).to.be.revertedWith("futureA_ is too small")
    })

    it("Reverts with 'futureA_ is too large'", async () => {
      await expect(
        metaSwapRAI.rampA(
          101,
          (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
        ),
      ).to.be.revertedWith("futureA_ is too large")
    })
  })

  describe("stopRampA", () => {
    it("Emits StopRampA event", async () => {
      // call rampA()
      await metaSwapRAI.rampA(
        100,
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 100,
      )

      // Stop ramp
      expect(metaSwapRAI.stopRampA()).to.emit(metaSwapRAI, "StopRampA")
    })

    it("Stop ramp succeeds", async () => {
      // call rampA()
      const endTimestamp =
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 100
      await metaSwapRAI.rampA(100, endTimestamp)

      // set timestamp to +100000 seconds
      await setTimestamp((await getCurrentBlockTimestamp()) + 100000)
      expect(await metaSwapRAI.getA()).to.be.eq(54)
      expect(await metaSwapRAI.getAPrecise()).to.be.eq(5413)

      // Stop ramp
      await metaSwapRAI.stopRampA()
      expect(await metaSwapRAI.getA()).to.be.eq(54)
      expect(await metaSwapRAI.getAPrecise()).to.be.eq(5413)

      // set timestamp to endTimestamp
      await setTimestamp(endTimestamp)

      // verify ramp has stopped
      expect(await metaSwapRAI.getA()).to.be.eq(54)
      expect(await metaSwapRAI.getAPrecise()).to.be.eq(5413)
    })

    it("Reverts with 'Ramp is already stopped'", async () => {
      // call rampA()
      const endTimestamp =
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 100
      await metaSwapRAI.rampA(100, endTimestamp)

      // set timestamp to +10000 seconds
      await setTimestamp((await getCurrentBlockTimestamp()) + 100000)
      expect(await metaSwapRAI.getA()).to.be.eq(54)
      expect(await metaSwapRAI.getAPrecise()).to.be.eq(5413)

      // Stop ramp
      await metaSwapRAI.stopRampA()
      expect(await metaSwapRAI.getA()).to.be.eq(54)
      expect(await metaSwapRAI.getAPrecise()).to.be.eq(5413)

      // check call reverts when ramp is already stopped
      await expect(metaSwapRAI.stopRampA()).to.be.revertedWith(
        "Ramp is already stopped",
      )
    })
  })

  describe("Check for timestamp manipulations", () => {
    beforeEach(async () => {
      await forceAdvanceOneBlock()
    })

    it("Check for maximum differences in A and virtual price when A is increasing", async () => {
      // Create imbalanced pool to measure virtual price change
      // Sets the pool in 2:1 ratio where RAI is significantly cheaper than lpToken
      await metaSwapRAI.addLiquidity([String(1e18), 0], 0, MAX_UINT256)

      // Initial A and virtual price
      expect(await metaSwapRAI.getA()).to.be.eq(50)
      expect(await metaSwapRAI.getAPrecise()).to.be.eq(5000)
      expect(await metaSwapRAI.getVirtualPrice()).to.be.eq("1000112966333319508")

      // Start ramp
      await metaSwapRAI.rampA(
        100,
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
      )

      // Malicious miner skips 900 seconds
      await setTimestamp((await getCurrentBlockTimestamp()) + 900)

      expect(await metaSwapRAI.getA()).to.be.eq(50)
      expect(await metaSwapRAI.getAPrecise()).to.be.eq(5003)
      expect(await metaSwapRAI.getVirtualPrice()).to.be.eq("1000118685672016651")

      // Max increase of A between two blocks
      // 5003 / 5000
      // = 1.0006

      // Max increase of virtual price between two blocks (at 2:1 ratio of tokens, starting A = 50)
      // 1000167862696363286 / 1000167146429977312
      // = 1.00000071615
    })

    it("Check for maximum differences in A and virtual price when A is decreasing", async () => {
      // Create imbalanced pool to measure virtual price change
      // Sets the pool in 2:1 ratio where RAI is significantly cheaper than lpToken
      await metaSwapRAI.addLiquidity([String(1e18), 0], 0, MAX_UINT256)

      // Initial A and virtual price
      expect(await metaSwapRAI.getA()).to.be.eq(50)
      expect(await metaSwapRAI.getAPrecise()).to.be.eq(5000)
      expect(await metaSwapRAI.getVirtualPrice()).to.be.eq("1000112966333319508")

      // Start ramp
      await metaSwapRAI.rampA(
        25,
        (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
      )

      // Malicious miner skips 900 seconds
      await setTimestamp((await getCurrentBlockTimestamp()) + 900)

      expect(await metaSwapRAI.getA()).to.be.eq(49)
      expect(await metaSwapRAI.getAPrecise()).to.be.eq(4999)
      expect(await metaSwapRAI.getVirtualPrice()).to.be.eq("1000111058433505677")

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
          RAI,
          baseLPToken,
        ])

        expect(initialAttackerBalances[0]).to.be.eq("100000000000000000000000")
        expect(initialAttackerBalances[1]).to.be.eq(String(3e20))

        // Start ramp upwards
        await metaSwapRAI.rampA(
          100,
          (await getCurrentBlockTimestamp()) + 14 * TIME.DAYS + 1,
        )
        expect(await metaSwapRAI.getAPrecise()).to.be.eq(5000)

        // Check current pool balances
        initialPoolBalances = [
          await metaSwapRAI.getTokenBalance(0),
          await metaSwapRAI.getTokenBalance(1),
        ]
        expect(initialPoolBalances[0]).to.be.eq(String(1e18))
        expect(initialPoolBalances[1]).to.be.eq(String(1e18))
      })

      
    })
  })
})
