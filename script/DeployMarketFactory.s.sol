// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketFactory} from "../src/MarketFactory.sol";

/// @notice Deploys with environment-supplied settings; no network metadata is hard-coded.
contract DeployMarketFactory is Script {
    error ExternalOwnerMustGrantMarketCreator();

    function run() external returns (MarketFactory factory) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address usdc = vm.envAddress("USDC_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address owner = vm.envOr("FACTORY_OWNER", vm.addr(deployerKey));
        address marketCreator = vm.envOr("MARKET_CREATOR", address(0));

        // Setting an external owner in the constructor makes an immediate
        // follow-up role grant from the deployer unauthorized. Fail before
        // broadcasting anything instead of risking a partially configured
        // production deployment. The external owner must call
        // setMarketCreator after deployment in that configuration.
        if (marketCreator != address(0) && owner != vm.addr(deployerKey)) {
            revert ExternalOwnerMustGrantMarketCreator();
        }

        vm.startBroadcast(deployerKey);
        factory = new MarketFactory(IERC20(usdc), treasury, owner);
        if (marketCreator != address(0)) factory.setMarketCreator(marketCreator, true);
        vm.stopBroadcast();
    }
}
