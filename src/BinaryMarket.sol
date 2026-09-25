// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/// @notice A fixed-window, two-sided parimutuel market settled in USDC.
/// @dev A flat or lower end price resolves to NO. If either side is empty at
/// resolution, all bettors on the populated side receive their original stake;
/// no commission is charged.
contract BinaryMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant COMMISSION_BPS = 200;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    IERC20 public immutable usdc;
    AggregatorV3Interface public immutable priceFeed;
    address public immutable factory;
    address public immutable treasury;
    string public assetPair;

    uint256 public yesPool;
    uint256 public noPool;
    mapping(address account => uint256 amount) public yesStakes;
    mapping(address account => uint256 amount) public noStakes;
    mapping(address account => bool claimed) public hasClaimed;
    uint256 public yesParticipants;
    uint256 public noParticipants;

    int256 public immutable startPrice;
    uint80 public immutable startRoundId;
    int256 public endPrice;
    bool public resolved;
    bool public refunded;
    bool public yesWon;
    uint256 public immutable startTime;
    uint256 public immutable endTime;
    uint256 public commissionPaid;

    error OnlyFactory();
    error MarketNotOpen();
    error MarketClosed();
    error MarketNotResolved();
    error AlreadyClaimed();
    error NoWinningStake();
    error InvalidAmount();
    error InvalidPrice();

    event BetPlaced(address indexed bettor, bool indexed isYes, uint256 amount);
    event Resolved(int256 startPrice, int256 endPrice, bool indexed yesWon, bool refunded, uint256 commission);
    event Claimed(address indexed bettor, uint256 amount);

    constructor(
        IERC20 usdc_,
        AggregatorV3Interface priceFeed_,
        address treasury_,
        string memory assetPair_,
        uint256 duration,
        uint256 startTime_,
        int256 startPrice_,
        uint80 startRoundId_
    ) {
        if (address(usdc_) == address(0) || address(priceFeed_) == address(0) || treasury_ == address(0)) revert InvalidPrice();
        if (startPrice_ <= 0) revert InvalidPrice();

        usdc = usdc_;
        priceFeed = priceFeed_;
        factory = msg.sender;
        treasury = treasury_;
        assetPair = assetPair_;
        startTime = startTime_;
        endTime = startTime_ + duration;
        startPrice = startPrice_;
        startRoundId = startRoundId_;
    }

    function placeBet(bool isYes, uint256 amount) external nonReentrant {
        if (block.timestamp < startTime) revert MarketNotOpen();
        if (block.timestamp >= endTime || resolved) revert MarketClosed();
        if (amount == 0) revert InvalidAmount();

        if (isYes) {
            if (yesStakes[msg.sender] == 0) ++yesParticipants;
            yesStakes[msg.sender] += amount;
            yesPool += amount;
        } else {
            if (noStakes[msg.sender] == 0) ++noParticipants;
            noStakes[msg.sender] += amount;
            noPool += amount;
        }
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit BetPlaced(msg.sender, isYes, amount);
    }

    function resolve() external nonReentrant {
        if (block.timestamp < endTime) revert MarketNotOpen();
        if (resolved) revert MarketClosed();

        (uint80 roundId, int256 answer,, uint256 updatedAt,) = priceFeed.latestRoundData();
        if (answer <= 0 || updatedAt == 0) revert InvalidPrice();

        endPrice = answer;
        // No new Chainlink observation in this market window means it cannot
        // be fairly resolved. Every stake is refundable and no fee is taken.
        refunded = roundId == startRoundId || yesPool == 0 || noPool == 0;
        // Explicit flat handling, when a fresh observation exists: NO wins.
        yesWon = !refunded && answer > startPrice;
        resolved = true;

        // A commission exists only when there are both winners and losers.
        if (!refunded) {
            uint256 losingPool = yesWon ? noPool : yesPool;
            commissionPaid = (losingPool * COMMISSION_BPS) / BPS_DENOMINATOR;
            usdc.safeTransfer(treasury, commissionPaid);
        }
        emit Resolved(startPrice, answer, yesWon, refunded, commissionPaid);
    }

    function claim() external nonReentrant returns (uint256 payout) {
        if (!resolved) revert MarketNotResolved();
        if (hasClaimed[msg.sender]) revert AlreadyClaimed();

        uint256 stake;
        if (refunded) {
            // Empty-side and stale-round safety: return every original stake.
            stake = yesStakes[msg.sender] + noStakes[msg.sender];
            if (stake == 0) revert NoWinningStake();
            payout = stake;
        } else {
            stake = yesWon ? yesStakes[msg.sender] : noStakes[msg.sender];
            if (stake == 0) revert NoWinningStake();
            uint256 winningPool = yesWon ? yesPool : noPool;
            uint256 losingPool = yesWon ? noPool : yesPool;
            uint256 distributableLosingPool = losingPool - commissionPaid;
            payout = stake + ((stake * distributableLosingPool) / winningPool);
        }

        hasClaimed[msg.sender] = true;
        usdc.safeTransfer(msg.sender, payout);
        emit Claimed(msg.sender, payout);
    }

    function getPoolSizes() external view returns (uint256, uint256) {
        return (yesPool, noPool);
    }

    function getParticipantCounts() external view returns (uint256, uint256) {
        return (yesParticipants, noParticipants);
    }
}
