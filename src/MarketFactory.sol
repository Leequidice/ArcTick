// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {BinaryMarket} from "./BinaryMarket.sol";

/// @notice Owner-seeded factory for the fixed 1, 5, and 15 minute market menu.
contract MarketFactory is Ownable {
    IERC20 public immutable usdc;
    address public immutable treasury;
    address[] public markets;
    mapping(address account => bool) public marketCreators;
    /// @dev Latest market for a feed/duration key. It may be overwritten only
    /// once the previous market is no longer open.
    mapping(bytes32 key => address market) public latestMarketByFeedAndDuration;

    error UnsupportedDuration();
    error InvalidStartTime();
    error InvalidAddress();
    error InvalidPrice();
    error NotMarketCreator();
    error OpenMarketAlreadyExists(address existingMarket);

    event MarketCreated(
        address indexed market,
        string assetPair,
        address indexed priceFeed,
        uint256 duration,
        uint256 startTime,
        uint256 endTime,
        int256 startPrice
    );
    event MarketCreatorSet(address indexed account, bool allowed);

    constructor(IERC20 usdc_, address treasury_, address initialOwner) Ownable(initialOwner) {
        if (address(usdc_) == address(0) || treasury_ == address(0) || initialOwner == address(0)) revert InvalidAddress();
        usdc = usdc_;
        treasury = treasury_;
    }

    modifier onlyMarketCreator() {
        if (!marketCreators[msg.sender]) revert NotMarketCreator();
        _;
    }

    /// @notice Grants or revokes permission to create markets only.
    /// @dev This authority cannot transfer ownership, change operators, or move funds.
    function setMarketCreator(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert InvalidAddress();
        marketCreators[account] = allowed;
        emit MarketCreatorSet(account, allowed);
    }

    function createMarket(string calldata assetPair, address priceFeed, uint256 duration)
        external
        onlyMarketCreator
        returns (BinaryMarket market)
    {
        if (!isSupportedDuration(duration)) revert UnsupportedDuration();
        if (priceFeed == address(0)) revert InvalidAddress();

        bytes32 key = keccak256(abi.encode(priceFeed, duration));
        address existingMarket = latestMarketByFeedAndDuration[key];
        if (existingMarket != address(0)) {
            BinaryMarket existing = BinaryMarket(existingMarket);
            if (!existing.resolved() && block.timestamp < existing.endTime()) {
                revert OpenMarketAlreadyExists(existingMarket);
            }
        }

        (uint80 startRoundId, int256 startPrice,, uint256 updatedAt,) = AggregatorV3Interface(priceFeed).latestRoundData();
        if (startPrice <= 0 || updatedAt == 0) revert InvalidPrice();

        // The on-chain creation block is the opening instant, avoiding an
        // off-chain timestamp race between a keeper and the mined transaction.
        uint256 startTime = block.timestamp;
        market = new BinaryMarket(usdc, AggregatorV3Interface(priceFeed), treasury, assetPair, duration, startTime, startPrice, startRoundId);
        latestMarketByFeedAndDuration[key] = address(market);
        markets.push(address(market));
        emit MarketCreated(address(market), assetPair, priceFeed, duration, startTime, startTime + duration, startPrice);
    }

    function isSupportedDuration(uint256 duration) public pure returns (bool) {
        return duration == 60 || duration == 300 || duration == 900 || duration == 3600;
    }

    function marketCount() external view returns (uint256) {
        return markets.length;
    }
}
