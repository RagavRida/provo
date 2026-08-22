const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ProvoMarketplace", function () {
  let marketplace;
  let owner, oracle, provider, buyer;

  const CLAIMED_TOK_PER_SEC = 95_000_000n; // 95.0 tok/s scaled by 1e6
  const PRICE_PER_HOUR = ethers.parseEther("0.01");
  const STAKE = ethers.parseEther("1.0");
  const ESCROW = ethers.parseEther("0.02");

  beforeEach(async function () {
    [owner, oracle, provider, buyer] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ProvoMarketplace", owner);
    marketplace = await Factory.deploy(oracle.address);
    await marketplace.waitForDeployment();
  });

  it("creates a listing and stakes MON", async function () {
    await expect(
      marketplace.connect(provider).createListing("H100", CLAIMED_TOK_PER_SEC, PRICE_PER_HOUR, { value: STAKE })
    )
      .to.emit(marketplace, "ListingCreated")
      .withArgs(1, provider.address, "H100", CLAIMED_TOK_PER_SEC, PRICE_PER_HOUR, STAKE);

    const listing = await marketplace.getListing(1);
    expect(listing.provider).to.equal(provider.address);
    expect(listing.stake).to.equal(STAKE);
    expect(listing.active).to.equal(true);
  });

  it("funds a job into escrow", async function () {
    await marketplace.connect(provider).createListing("H100", CLAIMED_TOK_PER_SEC, PRICE_PER_HOUR, { value: STAKE });

    await expect(marketplace.connect(buyer).fundJob(1, { value: ESCROW }))
      .to.emit(marketplace, "JobFunded")
      .withArgs(1, 1, buyer.address, ESCROW);

    const job = await marketplace.getJob(1);
    expect(job.buyer).to.equal(buyer.address);
    expect(job.escrow).to.equal(ESCROW);
  });

  it("settles a passing job: provider gets paid, reputation updates", async function () {
    await marketplace.connect(provider).createListing("H100", CLAIMED_TOK_PER_SEC, PRICE_PER_HOUR, { value: STAKE });
    await marketplace.connect(buyer).fundJob(1, { value: ESCROW });

    const measured = 96_000_000n; // above 95% tolerance of claim
    const providerBalanceBefore = await ethers.provider.getBalance(provider.address);

    await expect(marketplace.connect(oracle).submitVerification(1, measured, 250, 10000))
      .to.emit(marketplace, "JobSettled")
      .withArgs(1, 1, true, ESCROW, 0, 0);

    const providerBalanceAfter = await ethers.provider.getBalance(provider.address);
    expect(providerBalanceAfter - providerBalanceBefore).to.equal(ESCROW);

    expect(await marketplace.reputationScoreBps(1)).to.equal(10000n);

    const listing = await marketplace.getListing(1);
    expect(listing.stake).to.equal(STAKE); // untouched on pass
  });

  it("settles a failing job: buyer refunded + proportional slash of stake", async function () {
    await marketplace.connect(provider).createListing("H100", CLAIMED_TOK_PER_SEC, PRICE_PER_HOUR, { value: STAKE });
    await marketplace.connect(buyer).fundJob(1, { value: ESCROW });

    // Measured 76 tok/s vs claimed 95 -> delivered ~80%, shortfall ~20% (2000 bps)
    const measured = 76_000_000n;
    const buyerBalanceBefore = await ethers.provider.getBalance(buyer.address);

    const tx = await marketplace.connect(oracle).submitVerification(1, measured, 400, 9800);
    const receipt = await tx.wait();

    const settledEvent = receipt.logs
      .map((log) => {
        try {
          return marketplace.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "JobSettled");

    expect(settledEvent.args.passed).to.equal(false);
    expect(settledEvent.args.refundedToBuyer).to.equal(ESCROW);
    expect(settledEvent.args.slashedAmount).to.be.gt(0n);

    const buyerBalanceAfter = await ethers.provider.getBalance(buyer.address);
    expect(buyerBalanceAfter - buyerBalanceBefore).to.equal(ESCROW + settledEvent.args.slashedAmount);

    const listing = await marketplace.getListing(1);
    expect(listing.stake).to.equal(STAKE - settledEvent.args.slashedAmount);
    expect(await marketplace.reputationScoreBps(1)).to.equal(0n);
  });

  it("caps slash at remaining stake", async function () {
    const smallStake = ethers.parseEther("0.001");
    await marketplace.connect(provider).createListing("H100", CLAIMED_TOK_PER_SEC, PRICE_PER_HOUR, { value: smallStake });
    await marketplace.connect(buyer).fundJob(1, { value: ESCROW });

    // Complete failure (0 measured tok/s) would compute a slash larger than stake
    await marketplace.connect(oracle).submitVerification(1, 0, 9999, 0);

    const listing = await marketplace.getListing(1);
    expect(listing.stake).to.equal(0n); // fully slashed, capped at available stake
  });

  it("rejects withdrawListing while a job is pending", async function () {
    await marketplace.connect(provider).createListing("H100", CLAIMED_TOK_PER_SEC, PRICE_PER_HOUR, { value: STAKE });
    await marketplace.connect(buyer).fundJob(1, { value: ESCROW });

    await expect(marketplace.connect(provider).withdrawListing(1)).to.be.revertedWith("Provo: jobs pending");
  });

  it("allows withdrawListing once no jobs are pending", async function () {
    await marketplace.connect(provider).createListing("H100", CLAIMED_TOK_PER_SEC, PRICE_PER_HOUR, { value: STAKE });
    await marketplace.connect(buyer).fundJob(1, { value: ESCROW });
    await marketplace.connect(oracle).submitVerification(1, 96_000_000n, 250, 10000);

    await expect(marketplace.connect(provider).withdrawListing(1))
      .to.emit(marketplace, "ListingWithdrawn")
      .withArgs(1, provider.address, STAKE);
  });

  it("rejects submitVerification from a non-oracle address", async function () {
    await marketplace.connect(provider).createListing("H100", CLAIMED_TOK_PER_SEC, PRICE_PER_HOUR, { value: STAKE });
    await marketplace.connect(buyer).fundJob(1, { value: ESCROW });

    await expect(
      marketplace.connect(buyer).submitVerification(1, 96_000_000n, 250, 10000)
    ).to.be.revertedWith("Provo: not oracle");
  });

  it("lets the owner rotate the oracle address", async function () {
    await expect(marketplace.connect(owner).setOracle(buyer.address))
      .to.emit(marketplace, "OracleUpdated")
      .withArgs(oracle.address, buyer.address);

    expect(await marketplace.oracle()).to.equal(buyer.address);
  });
});
