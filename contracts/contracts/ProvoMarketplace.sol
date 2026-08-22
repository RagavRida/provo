// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ProvoMarketplace
 * @notice "A GPU costs what it delivers, not what it claims."
 *
 * Verified GPU compute marketplace on Monad. Providers stake MON as collateral
 * backing a performance claim (GPU model, claimed tok/s, price per hour). A
 * benchmark agent runs the buyer's workload against the provider's endpoint;
 * a trusted oracle submits the measured result on-chain; this contract
 * auto-settles the escrowed payment and slashes the provider's stake if the
 * claim wasn't met.
 *
 * Mechanism: claim -> stake -> escrow -> execute -> verify -> settle.
 *
 * HACKATHON SCOPE (see "v2 / roadmap" notes below):
 *  - Single trusted oracle address, owner-settable. No decentralized oracle
 *    network, no multi-party consensus, no dispute window.
 *  - One workload / one measurement per job. No partial fills, no recurring
 *    subscriptions.
 *
 * Uses OpenZeppelin's Ownable (audited owner management) and ReentrancyGuard
 * (defense-in-depth on every function that moves MON) instead of hand-rolled
 * equivalents — see the monad-scaffold skill: don't rebuild what OpenZeppelin
 * already ships audited.
 */
contract ProvoMarketplace is Ownable, ReentrancyGuard {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum JobStatus {
        None,
        Funded,
        Verified
    }

    struct Listing {
        address provider;
        string gpuModel;
        uint256 vramGb;          // GPU VRAM in GB (e.g. 80 for H100-80GB)
        string region;           // provider region (e.g. "us-east", "eu-west")
        uint256 claimedTokPerSec; // scaled by 1e6 (e.g. 95.5 tok/s -> 95_500_000)
        uint256 pricePerHour; // wei, price per hour of compute
        uint256 stake; // wei, MON staked as collateral, decreases as slashed
        bool active;
        uint256 passedJobs;
        uint256 totalJobs;
    }

    struct Job {
        uint256 listingId;
        address buyer;
        uint256 escrow; // wei paid by buyer, held until settlement
        JobStatus status;
        uint256 measuredTokPerSec;
        uint256 measuredLatencyMs;
        uint256 measuredSuccessBps; // basis points, 0-10000
        bool passed;
        uint256 slashedAmount;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    address public oracle;

    uint256 public constant TOLERANCE_BPS = 9500; // 95% of claimed tok/s required to pass
    uint256 public constant BPS_DENOMINATOR = 10000;

    uint256 public nextListingId = 1;
    uint256 public nextJobId = 1;

    mapping(uint256 => Listing) public listings;
    mapping(uint256 => Job) public jobs;
    // listingId => count of jobs currently Funded (not yet Verified) against it.
    // A provider can only withdraw a listing when this is zero.
    mapping(uint256 => uint256) public pendingJobCount;

    // ---------------------------------------------------------------------
    // Events — a frontend subscribes to these instead of polling.
    // ---------------------------------------------------------------------

    event ListingCreated(
        uint256 indexed listingId,
        address indexed provider,
        string gpuModel,
        uint256 vramGb,
        string region,
        uint256 claimedTokPerSec,
        uint256 pricePerHour,
        uint256 stake
    );

    event ListingWithdrawn(uint256 indexed listingId, address indexed provider, uint256 returnedStake);

    event JobFunded(uint256 indexed jobId, uint256 indexed listingId, address indexed buyer, uint256 escrow);

    event JobVerified(
        uint256 indexed jobId,
        uint256 measuredTokPerSec,
        uint256 measuredLatencyMs,
        uint256 measuredSuccessBps
    );

    event JobSettled(
        uint256 indexed jobId,
        uint256 indexed listingId,
        bool passed,
        uint256 paidToProvider,
        uint256 refundedToBuyer,
        uint256 slashedAmount
    );

    event OracleUpdated(address indexed previousOracle, address indexed newOracle);

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyOracle() {
        require(msg.sender == oracle, "Provo: not oracle");
        _;
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    constructor(address _oracle) Ownable(msg.sender) {
        require(_oracle != address(0), "Provo: zero oracle");
        oracle = _oracle;
        emit OracleUpdated(address(0), _oracle);
    }

    // ---------------------------------------------------------------------
    // Provider flow
    // ---------------------------------------------------------------------

    /**
     * @notice Provider creates a listing, staking MON as collateral.
     * @param gpuModel free-text GPU model label, e.g. "H100"
     * @param vramGb GPU VRAM in GB, e.g. 80 for H100-80GB
     * @param region provider's geographic region, e.g. "us-east"
     * @param claimedTokPerSec claimed throughput, scaled by 1e6
     * @param pricePerHour price in wei per hour of compute
     */
    function createListing(
        string calldata gpuModel,
        uint256 vramGb,
        string calldata region,
        uint256 claimedTokPerSec,
        uint256 pricePerHour
    ) external payable nonReentrant returns (uint256 listingId) {
        require(msg.value > 0, "Provo: stake required");
        require(claimedTokPerSec > 0, "Provo: claim must be > 0");
        require(pricePerHour > 0, "Provo: price must be > 0");
        require(bytes(gpuModel).length > 0, "Provo: gpuModel required");
        require(vramGb > 0, "Provo: vramGb must be > 0");
        require(bytes(region).length > 0, "Provo: region required");

        listingId = nextListingId++;
        listings[listingId] = Listing({
            provider: msg.sender,
            gpuModel: gpuModel,
            vramGb: vramGb,
            region: region,
            claimedTokPerSec: claimedTokPerSec,
            pricePerHour: pricePerHour,
            stake: msg.value,
            active: true,
            passedJobs: 0,
            totalJobs: 0
        });

        emit ListingCreated(listingId, msg.sender, gpuModel, vramGb, region, claimedTokPerSec, pricePerHour, msg.value);
    }

    /**
     * @notice Provider reclaims their stake and deactivates the listing.
     *         Only allowed when no jobs are pending verification.
     */
    function withdrawListing(uint256 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.provider == msg.sender, "Provo: not provider");
        require(listing.active, "Provo: not active");
        require(pendingJobCount[listingId] == 0, "Provo: jobs pending");

        uint256 amount = listing.stake;
        listing.active = false;
        listing.stake = 0;

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Provo: stake transfer failed");

        emit ListingWithdrawn(listingId, msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Buyer flow
    // ---------------------------------------------------------------------

    /**
     * @notice Buyer funds a job against a listing, paying into escrow.
     */
    function fundJob(uint256 listingId) external payable nonReentrant returns (uint256 jobId) {
        Listing storage listing = listings[listingId];
        require(listing.active, "Provo: listing inactive");
        require(msg.value > 0, "Provo: payment required");

        jobId = nextJobId++;
        jobs[jobId] = Job({
            listingId: listingId,
            buyer: msg.sender,
            escrow: msg.value,
            status: JobStatus.Funded,
            measuredTokPerSec: 0,
            measuredLatencyMs: 0,
            measuredSuccessBps: 0,
            passed: false,
            slashedAmount: 0
        });

        pendingJobCount[listingId] += 1;

        emit JobFunded(jobId, listingId, msg.sender, msg.value);
    }

    // ---------------------------------------------------------------------
    // Oracle flow
    // ---------------------------------------------------------------------

    /**
     * @notice Oracle submits the benchmark agent's measured result for a job.
     *         Triggers automatic settlement.
     */
    function submitVerification(
        uint256 jobId,
        uint256 measuredTokPerSec,
        uint256 measuredLatencyMs,
        uint256 measuredSuccessBps
    ) external onlyOracle nonReentrant {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Funded, "Provo: job not funded");
        require(measuredSuccessBps <= BPS_DENOMINATOR, "Provo: successBps > 10000");

        job.measuredTokPerSec = measuredTokPerSec;
        job.measuredLatencyMs = measuredLatencyMs;
        job.measuredSuccessBps = measuredSuccessBps;
        job.status = JobStatus.Verified;

        emit JobVerified(jobId, measuredTokPerSec, measuredLatencyMs, measuredSuccessBps);

        _settle(jobId);
    }

    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    function _settle(uint256 jobId) internal {
        Job storage job = jobs[jobId];
        Listing storage listing = listings[job.listingId];

        require(pendingJobCount[job.listingId] > 0, "Provo: pending count underflow");
        pendingJobCount[job.listingId] -= 1;

        // Pass condition: measured tok/s >= claimed tok/s * TOLERANCE_BPS / 10000
        uint256 requiredTokPerSec = (listing.claimedTokPerSec * TOLERANCE_BPS) / BPS_DENOMINATOR;
        bool passed = job.measuredTokPerSec >= requiredTokPerSec;

        job.passed = passed;
        listing.totalJobs += 1;

        uint256 escrow = job.escrow;
        uint256 paidToProvider;
        uint256 refundedToBuyer;
        uint256 slashedAmount;

        if (passed) {
            listing.passedJobs += 1;
            paidToProvider = escrow;
            (bool ok, ) = payable(listing.provider).call{value: paidToProvider}("");
            require(ok, "Provo: provider payment failed");
        } else {
            // Buyer gets escrow refunded in full, plus a proportional slash of
            // the provider's stake, capped at whatever stake remains.
            //
            // Slash proportional to shortfall: the further below the claim the
            // measured throughput fell, the larger the slash — capped at the
            // full escrow amount and at the provider's remaining stake.
            uint256 shortfallBps;
            if (listing.claimedTokPerSec == 0) {
                shortfallBps = BPS_DENOMINATOR;
            } else if (job.measuredTokPerSec >= listing.claimedTokPerSec) {
                shortfallBps = 0;
            } else {
                uint256 delivered = (job.measuredTokPerSec * BPS_DENOMINATOR) / listing.claimedTokPerSec;
                shortfallBps = BPS_DENOMINATOR - delivered; // e.g. delivered 80% -> shortfall 2000 bps
            }

            uint256 desiredSlash = (escrow * shortfallBps) / BPS_DENOMINATOR;
            slashedAmount = desiredSlash > listing.stake ? listing.stake : desiredSlash;

            listing.stake -= slashedAmount;
            refundedToBuyer = escrow;

            (bool refundOk, ) = payable(job.buyer).call{value: refundedToBuyer}("");
            require(refundOk, "Provo: buyer refund failed");

            if (slashedAmount > 0) {
                (bool slashOk, ) = payable(job.buyer).call{value: slashedAmount}("");
                require(slashOk, "Provo: slash transfer failed");
            }

            job.slashedAmount = slashedAmount;
        }

        emit JobSettled(jobId, job.listingId, passed, paidToProvider, refundedToBuyer, slashedAmount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Running pass rate for a provider's listing, in basis points (0-10000).
    function reputationScoreBps(uint256 listingId) external view returns (uint256) {
        Listing storage listing = listings[listingId];
        if (listing.totalJobs == 0) return 0;
        return (listing.passedJobs * BPS_DENOMINATOR) / listing.totalJobs;
    }

    // ---------------------------------------------------------------------
    // Admin (hackathon-scope trusted oracle / owner)
    //
    // Ownership itself (transferOwnership, renounceOwnership, owner()) comes
    // from OpenZeppelin's Ownable — only the oracle address is custom here.
    //
    // v2 / ROADMAP: replace this single owner-settable oracle address with a
    // decentralized oracle network (e.g. multiple attesters + median/quorum
    // aggregation) and add a dispute window before settlement finalizes, so
    // no single party can unilaterally decide a provider's outcome.
    // ---------------------------------------------------------------------

    function setOracle(address newOracle) external onlyOwner {
        require(newOracle != address(0), "Provo: zero oracle");
        emit OracleUpdated(oracle, newOracle);
        oracle = newOracle;
    }

    // ---------------------------------------------------------------------
    // Read helpers
    // ---------------------------------------------------------------------

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return listings[listingId];
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }
}
