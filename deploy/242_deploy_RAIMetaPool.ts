import { DeployFunction } from "hardhat-deploy/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { MULTISIG_ADDRESS } from "../utils/accounts"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { execute, deploy, get, getOrNull, log, read, save } = deployments
  const { deployer } = await getNamedAccounts()

  // Manually check if the pool is already deployed
  const saddleRAIMetaPool = await getOrNull("SaddleRAIMetaPool")
  if (saddleRAIMetaPool) {
    log(`reusing "SaddleRAIMetaPool" at ${saddleRAIMetaPool.address}`)
  } else {
    // Constructor arguments
    const TOKEN_ADDRESSES = [
      (await get("RAI")).address,
      (await get("SaddleUSDPoolV2LPToken")).address,
    ]
    const TOKEN_DECIMALS = [18, 18]
    const LP_TOKEN_NAME = "Saddle RAI/saddleUSD-V2"
    const LP_TOKEN_SYMBOL = "saddleRAI"
    const INITIAL_A = 100
    const SWAP_FEE = 4e6 // 4bps
    const ADMIN_FEE = 0

    await deploy("SaddleRAIMetaPool", {
      from: deployer,
      log: true,
      contract: "DriftingMetaSwap",
      skipIfAlreadyDeployed: true,
      libraries: {
        SwapUtils: (await get("SwapUtils")).address,
        DriftingMetaSwapUtils: (await get("DriftingMetaSwapUtils")).address,
        AmplificationUtils: (await get("AmplificationUtils")).address,
      },
    })

    await execute(
      "SaddleRAIMetaPool",
      {
        from: deployer,
        log: true,
      },
      "initializeDriftingMetaSwap",
      TOKEN_ADDRESSES,
      TOKEN_DECIMALS,
      LP_TOKEN_NAME,
      LP_TOKEN_SYMBOL,
      INITIAL_A,
      SWAP_FEE,
      ADMIN_FEE,
      (
        await get("LPToken")
      ).address,
      (
        await get("SaddleUSDPoolV2")
      ).address,
      (
        await get("RedemptionPriceSnapMock")
      ).address,
    )

    await execute(
      "SaddleRAIMetaPool",
      { from: deployer, log: true },
      "transferOwnership",
      MULTISIG_ADDRESS,
    )
  }

  const lpTokenAddress = (await read("SaddleRAIMetaPool", "swapStorage"))
    .lpToken
  log(`Saddle RAI DriftingMetaSwap LP Token at ${lpTokenAddress}`)

  await save("SaddleRAIMetaPoolLPToken", {
    abi: (await get("LPToken")).abi, // LPToken ABI
    address: lpTokenAddress,
  })
}
export default func
func.tags = ["RAIMetaPool"]
func.dependencies = [
  "RAIMetaPoolTokens",
  "USDPoolV2",
  "DriftingMetaSwapUtils",
  "AmplificationUtils",
]
