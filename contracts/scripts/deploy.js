const hre = require("hardhat");

async function main() {
  const oracleAddress = process.env.ORACLE_ADDRESS;
  if (!oracleAddress) {
    throw new Error(
      "Set ORACLE_ADDRESS env var to the address that will call submitVerification (the oracle bridge's signer)."
    );
  }

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying ProvoMarketplace with deployer:", deployer.address);
  console.log("Oracle address:", oracleAddress);

  const ProvoMarketplace = await hre.ethers.getContractFactory("ProvoMarketplace");
  const marketplace = await ProvoMarketplace.deploy(oracleAddress);
  await marketplace.waitForDeployment();

  const address = await marketplace.getAddress();
  console.log("ProvoMarketplace deployed to:", address);
  console.log("\nNext steps:");
  console.log("1. Verify via the monad-scaffold verification API (all 3 explorers, one call).");
  console.log("2. Write the address into agent/.env and oracle/.env as CONTRACT_ADDRESS.");
  console.log("3. Write the address + ABI into web/src/lib/contract.js.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
