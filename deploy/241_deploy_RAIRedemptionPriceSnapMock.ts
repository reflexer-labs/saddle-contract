import { DeployFunction } from "hardhat-deploy/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { execute, deploy, get, getOrNull, log } = deployments
  const { deployer } = await getNamedAccounts()

  // Manually check if the pool is already deployed
  const saddleRAIMetaPool = await getOrNull("SaddleRAIMetaPoolDeposit")
  if (saddleRAIMetaPool) {
    log(
      `reusing "SaddleRAIMetaPoolDeposit" at ${saddleRAIMetaPool.address}`,
    )
  } else {
    await deploy("SaddleRAIMetaPoolDeposit", {
      from: deployer,
      log: true,
      contract: "DriftingMetaSwapDeposit",
      skipIfAlreadyDeployed: true,
    })

    await execute(
      "SaddleRAIMetaPoolDeposit",
      { from: deployer, log: true },
      "initialize",
      (
        await get("SaddleUSDPoolV2")
      ).address,
      (
        await get("SaddleRAIMetaPool")
      ).address,
      (
        await get("SaddleRAIMetaPoolLPToken")
      ).address,
    )
  }
}
export default func
func.tags = ["RAIMetaPoolDeposit"]
func.dependencies = ["RAIMetaPoolTokens", "RAIMetaPool"]
