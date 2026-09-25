// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @notice TESTNET ONLY: owner-operated Chainlink-compatible price feed.
/// @dev Never add this address to a mainnet configuration or deployment.
contract MockV3Aggregator is AggregatorV3Interface, Ownable {
    uint80 public roundId;
    int256 public answer;
    uint256 public updatedAt;

    error InvalidAnswer();

    event RoundPushed(uint80 indexed roundId, int256 answer, uint256 updatedAt);

    constructor(address initialOwner, int256 initialAnswer) Ownable(initialOwner) {
        if (initialAnswer <= 0) revert InvalidAnswer();
        roundId = 1;
        answer = initialAnswer;
        updatedAt = block.timestamp;
    }

    /// @notice Push any test observation. Reusing `roundId` deliberately models
    /// a stale Chainlink observation, exercising BinaryMarket's refund branch.
    function pushRound(uint80 roundId_, int256 answer_, uint256 updatedAt_) external onlyOwner {
        if (answer_ <= 0 || updatedAt_ == 0) revert InvalidAnswer();
        roundId = roundId_;
        answer = answer_;
        updatedAt = updatedAt_;
        emit RoundPushed(roundId_, answer_, updatedAt_);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}
