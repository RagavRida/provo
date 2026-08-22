require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/**
 * Monad testnet network params — VERIFY against https://docs.monad.xyz before
 * deploying, since testnet RPC endpoints/chain IDs can rotate. Values below are
 * the documented ones at time of writing (chainId 10143, public RPC below).
 */
const MONAD_TESTNET_RPC = process.env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz";
const MONAD_TESTNET_CHAIN_ID = 10143;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    monadTestnet: {
      url: MONAD_TESTNET_RPC,
      chainId: MONAD_TESTNET_CHAIN_ID,
      // Never commit a real private key. Set DEPLOYER_PRIVATE_KEY in a local
      // .env (gitignored) or use the monad-wallet Alchemy Agent Wallet flow
      // instead of a raw key when deploying from an agent context.
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  sourcify: {
    enabled: true,
    apiUrl: "https://sourcify-api-monad.blockvision.org/",
    browserUrl: "https://testnet.monadverifier.com/",
  },
};
