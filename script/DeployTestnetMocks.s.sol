// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {MockV3Aggregator} from "../src/testnet/MockV3Aggregator.sol";

/// @notice TESTNET ONLY. Deploys independently controlled mock BTC/USD and ETH/USD feeds.
contract DeployTestnetMocks is Script {
    function run() external returns (MockV3Aggregator btc, MockV3Aggregator eth) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address owner = vm.envOr("MOCK_ORACLE_OWNER", vm.addr(deployerKey));
        vm.startBroadcast(deployerKey);
        btc = new MockV3Aggregator(owner, 100_000e8);
        eth = new MockV3Aggregator(owner, 3_000e8);
        vm.stopBroadcast();
    }
}
