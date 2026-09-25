// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketFactory} from "../src/MarketFactory.sol";
import {Vault} from "../src/Vault.sol";

contract DeployVault is Script {
    function run() external returns (Vault vault) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address owner = vm.envOr("VAULT_OWNER", vm.addr(deployerKey));
        vm.startBroadcast(deployerKey);
        vault = new Vault(
            IERC20(vm.envAddress("USDC_ADDRESS")),
            MarketFactory(vm.envAddress("FACTORY_ADDRESS")),
            owner,
            vm.envAddress("OPERATOR_ADDRESS")
        );
        vm.stopBroadcast();
    }
}
