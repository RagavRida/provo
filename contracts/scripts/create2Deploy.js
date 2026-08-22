/**
 * CREATE2 deploy helper for the Alchemy Agent Wallet flow (see the
 * `monad-wallet` skill). This does NOT sign or send any transaction itself —
 * the Alchemy CLI session is the only thing allowed to do that, and only the
 * developer can authenticate that CLI (never do this on the user's behalf).
 *
 * What this script does:
 *   1. Reads the compiled ProvoMarketplace bytecode from the Hardhat artifact
 *      (no Foundry required, even though monad-wallet's docs assume forge).
 *   2. ABI-encodes the constructor arg (oracle address) and appends it to the
 *      creation bytecode to build INIT_CODE.
 *   3. Calls CreateX's computeCreate2Address(bytes32,bytes32) as a read-only
 *      eth_call against the Monad RPC to predict the deployment address
 *      *before* anything is deployed.
 *   4. Prints the exact `alchemy evm contract call` command to actually
 *      deploy through the session signer.
 *
 * Usage:
 *   node scripts/create2Deploy.js --oracle 0xOracleAddress --network testnet [--salt 0x00...]
 *
 * Prereqs (per monad-wallet skill — the user does these themselves):
 *   npm install -g @alchemy/cli@latest   (v0.18.0+)
 *   alchemy auth                         (or --device-code in headless envs)
 *   alchemy wallet connect --mode session   (after creating a session in the
 *                                             Alchemy Dashboard)
 */

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const CREATEX_ADDRESS = "0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed";
const ZERO_SALT = "0x0000000000000000000000000000000000000000000000000000000000000000".slice(0, 66);

const NETWORKS = {
  mainnet: { rpc: "https://rpc.monad.xyz", chainId: 143, alchemyNetwork: "monad-mainnet" },
  testnet: { rpc: "https://testnet-rpc.monad.xyz", chainId: 10143, alchemyNetwork: "monad-testnet" },
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const network = NETWORKS[args.network || "testnet"];
  if (!network) throw new Error(`Unknown --network "${args.network}". Use "testnet" or "mainnet".`);
  if (!args.oracle) throw new Error("Pass --oracle 0xOracleAddress (the address that will call submitVerification).");

  const salt = args.salt || ZERO_SALT;

  console.log(`Network: ${args.network || "testnet"} (chainId ${network.chainId})`);
  console.log(`RPC: ${network.rpc}  <-- confirm against https://docs.monad.xyz, testnet endpoints rotate`);
  console.log(`Oracle: ${args.oracle}`);
  console.log(`Salt: ${salt}`);

  // 1. Load Hardhat artifact bytecode.
  const artifactPath = path.join(
    __dirname,
    "..",
    "artifacts",
    "contracts",
    "ProvoMarketplace.sol",
    "ProvoMarketplace.json"
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Artifact not found at ${artifactPath}. Run "npx hardhat compile" first.`);
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const creationBytecode = artifact.bytecode;

  // 2. Build INIT_CODE = creation bytecode + ABI-encoded constructor args.
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encodedArgs = abiCoder.encode(["address"], [args.oracle]);
  const initCode = creationBytecode + encodedArgs.slice(2);
  const initCodeHash = ethers.keccak256(initCode);

  console.log(`\nINIT_CODE_HASH: ${initCodeHash}`);

  // 3. Predict the CREATE2 address via a read-only call to CreateX.
  const provider = new ethers.JsonRpcProvider(network.rpc, network.chainId);
  const createX = new ethers.Contract(
    CREATEX_ADDRESS,
    ["function computeCreate2Address(bytes32,bytes32) view returns (address)"],
    provider
  );

  // Verify CreateX actually has code on this network before relying on it
  // (see monad-addresses skill).
  const code = await provider.getCode(CREATEX_ADDRESS);
  if (code === "0x") {
    throw new Error(`CreateX has no code at ${CREATEX_ADDRESS} on this network — check the RPC/chainId.`);
  }

  const predicted = await createX.computeCreate2Address(salt, initCodeHash);
  console.log(`Predicted deployment address: ${predicted}`);

  // 4. Print the exact Alchemy CLI command to actually deploy.
  console.log("\n--- Next: deploy through the Alchemy Agent Wallet session signer ---\n");
  console.log("Prereqs (you do these yourself — I never see the private key):");
  console.log("  npm install -g @alchemy/cli@latest");
  console.log("  alchemy auth                              # or: alchemy auth login --device-code (headless)");
  console.log("  # create an EVM Agent Wallet session at https://dashboard.alchemy.com/products/agent-wallet/evm-wallet");
  console.log("  alchemy wallet connect --mode session");
  console.log("  alchemy wallet use session");
  console.log(`  alchemy config set network ${network.alchemyNetwork}`);
  console.log("\nThen deploy:");
  console.log(
    `  alchemy evm contract call ${CREATEX_ADDRESS} "deployCreate2(bytes32,bytes)" \\\n` +
      `    --args "${salt},${initCode}" \\\n` +
      `    -n ${network.alchemyNetwork}`
  );
  console.log("\nThen confirm:");
  console.log(`  alchemy evm status <call-id>`);
  console.log(`  cast code ${predicted} --rpc-url ${network.rpc}   # or eth_getCode via curl if Foundry isn't installed`);
  console.log(
    `\nIf it deploys to ${predicted}, that's your ProvoMarketplace address — write it into agent/.env, oracle/.env, and web/.env as CONTRACT_ADDRESS / VITE_CONTRACT_ADDRESS.`
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
