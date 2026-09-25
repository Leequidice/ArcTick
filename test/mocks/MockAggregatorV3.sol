// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AggregatorV3Interface} from "../../src/interfaces/AggregatorV3Interface.sol";

contract MockAggregatorV3 is AggregatorV3Interface {
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId;

    constructor(int256 answer_) { setAnswer(answer_); }
    function setAnswer(int256 answer_) public { answer = answer_; updatedAt = block.timestamp; ++roundId; }
    function setAnswerWithoutNewRound(int256 answer_) external { answer = answer_; updatedAt = block.timestamp; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}
