/**
 * Seeds the three demo listings on a live network (Monad testnet).
 *
 * Unlike scripts/localDemo.js (which uses Hardhat's built-in test signers),
 * this runs against a real chain using PROVIDER_PRIVATE_KEY from .env.
 *
 *   CONTRACT_ADDRESS=0x... npx hardhat run scripts/seedTestnet.js --network monadTestnet
 *
 * Listing set is chosen to make the buyer agent's failure-and-reroute visible:
 *   #1 headline-best score, will underdeliver  -> agent picks it first, gets slashed
 *   #2 honest, slightly pricier                -> agent reroutes here, passes
 *   #3 below the workload minimum              -> demonstrates the eligibility filter
 */

const hre = require("hardhat");

const TOK = (n) => BigInt(Math.round(n * 1e6));
const ETH = (n) => hre.ethers.parseEther(String(n));

// Monad charges gas on the LIMIT, not on usage (see the monad-gas skill), so
// set tight explicit limits rather than letting a wallet inflate them.
const CREATE_LISTING_GAS = 320_000n; // slightly higher for v2 (extra string + uint)

const LISTINGS = [
  { gpu: "H100", vram: 80, region: "us-east", tok: 100, price: "0.010", stake: "0.05", note: "headline-best — will underdeliver" },
  { gpu: "H100", vram: 80, region: "eu-west", tok: 95,  price: "0.014", stake: "0.05", note: "honest — delivers" },
  { gpu: "A100", vram: 40, region: "us-east", tok: 60,  price: "0.009", stake: "0.05", note: "below workload minimum — filtered out" },
];

async function main() {
  const contractAddress = process.env.CONTRACT_ADDRESS;
  if (!contractAddress) throw new Error("Set CONTRACT_ADDRESS to the deployed marketplace address.");

  const [signer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(signer.address);

  console.log(`Provider wallet: ${signer.address}`);
  console.log(`Balance:         ${hre.ethers.formatEther(balance)} MON`);
  console.log(`Contract:        ${contractAddress}\n`);

  const totalStake = LISTINGS.reduce((s, l) => s + ETH(l.stake), 0n);
  const gasPrice = (await hre.ethers.provider.getFeeData()).gasPrice ?? 0n;
  const estGas = CREATE_LISTING_GAS * BigInt(LISTINGS.length) * gasPrice;
  const needed = totalStake + estGas;

  console.log(`Stakes:      ${hre.ethers.formatEther(totalStake)} MON`);
  console.log(`Est. gas:    ${hre.ethers.formatEther(estGas)} MON  (charged on limit, not usage)`);
  console.log(`Total need:  ${hre.ethers.formatEther(needed)} MON`);

  if (balance < needed) {
    throw new Error(
      `Insufficient balance. Need ~${hre.ethers.formatEther(needed)} MON, have ${hre.ethers.formatEther(balance)} MON. Top up from the faucet first.`
    );
  }

  const market = await hre.ethers.getContractAt("ProvoMarketplace", contractAddress, signer);

  console.log("\nCreating listings…");
  for (const l of LISTINGS) {
    const tx = await market.createListing(l.gpu, l.vram, l.region, TOK(l.tok), ETH(l.price), {
      value: ETH(l.stake),
      gasLimit: CREATE_LISTING_GAS,
    });
    const receipt = await tx.wait();

    let listingId = "?";
    for (const log of receipt.logs) {
      try {
        const parsed = market.interface.parseLog(log);
        if (parsed?.name === "ListingCreated") listingId = parsed.args.listingId.toString();
      } catch {
        /* not ours */
      }
    }

    console.log(
      `  #${listingId} ${l.gpu} ${l.vram}GB ${l.region.padEnd(8)}  ${String(l.tok).padStart(3)} tok/s @ ${l.price} MON/hr  ` +
        `stake ${l.stake} MON   ${l.note}`
    );
    console.log(`      tx ${receipt.hash}`);
  }

  const nextId = await market.nextListingId();
  console.log(`\nDone. ${Number(nextId) - 1} total listing(s) on-chain.`);
}

main().catch((err) => {
  console.error(`\n${err.message || err}`);
  process.exit(1);
});
