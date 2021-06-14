import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"
import { CHAIN_ID } from "../utils/network"
import { BigNumber } from "ethers"

const ALETH_TOKENS_ARGS: { [token: string]: any[] } = {
  WETH: ["Wrapped Ether", "WETH", "18"],
  ALETH: ["Alchemix ETH", "alETH", "18"],
  SETH: ["Synthetic ETH", "sETH", "18"],
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, getChainId } = hre
  const { deploy, execute } = deployments
  const { deployer } = await getNamedAccounts()

  for (const token in ALETH_TOKENS_ARGS) {
    await deploy(token, {
      from: deployer,
      log: true,
      contract: "GenericERC20",
      args: ALETH_TOKENS_ARGS[token],
      skipIfAlreadyDeployed: true,
    })
    // If it's on hardhat, mint test tokens
    if ((await getChainId()) == CHAIN_ID.HARDHAT) {
      const decimals = ALETH_TOKENS_ARGS[token][2]
      await execute(
        token,
        { from: deployer, log: true },
        "mint",
        deployer,
        BigNumber.from(10).pow(decimals).mul(1000),
      )
    }
  }
}
export default func
func.tags = ["ALETHPoolTokens"]