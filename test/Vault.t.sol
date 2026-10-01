// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MarketFactory} from "../src/MarketFactory.sol";
import {BinaryMarket} from "../src/BinaryMarket.sol";
import {Vault} from "../src/Vault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockAggregatorV3} from "./mocks/MockAggregatorV3.sol";

contract VaultTest is Test {
    uint256 internal constant UNIT = 1e6;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal operator = makeAddr("operator");
    MockUSDC internal usdc;
    MockAggregatorV3 internal feed;
    MarketFactory internal factory;
    Vault internal vault;

    function setUp() public {
        vm.warp(1_000);
        usdc = new MockUSDC();
        feed = new MockAggregatorV3(100e8);
        factory = new MarketFactory(usdc, makeAddr("treasury"), address(this));
        factory.setMarketCreator(address(this), true);
        vault = new Vault(usdc, factory, address(this), operator);
        usdc.mint(alice, 1_000 * UNIT);
        usdc.mint(bob, 1_000 * UNIT);
        vm.prank(alice); usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob); usdc.approve(address(vault), type(uint256).max);
    }

    function _market() internal returns (BinaryMarket) { return factory.createMarket("BTC/USD", address(feed), 60); }
    function _deposit(address user, uint256 amount) internal { vm.prank(user); vault.deposit(amount); }

    function testDepositAndWithdraw() public {
        _deposit(alice, 100 * UNIT);
        assertEq(vault.balances(alice), 100 * UNIT);
        vm.prank(alice); vault.withdraw(40 * UNIT);
        assertEq(vault.balances(alice), 60 * UNIT);
        assertEq(usdc.balanceOf(alice), 940 * UNIT);
    }

    function testOperatorCannotBetBeyondBalance() public {
        BinaryMarket market = _market();
        vm.prank(operator);
        vm.expectRevert(Vault.InsufficientBalance.selector);
        vault.operatorPlaceBet(alice, address(market), true, UNIT);
    }

    function testWinningBetIsCreditedAndLosingBetIsNot() public {
        _deposit(alice, 100 * UNIT);
        _deposit(bob, 100 * UNIT);
        BinaryMarket market = _market();
        vm.prank(operator); vault.operatorPlaceBet(alice, address(market), true, 100 * UNIT);
        vm.prank(operator); vault.operatorPlaceBet(bob, address(market), false, 100 * UNIT);
        feed.setAnswer(101e8);
        vm.warp(market.endTime()); market.resolve();
        vm.prank(operator); vault.operatorSettleMarket(address(market));
        assertEq(vault.balances(alice), 198 * UNIT);
        assertEq(vault.balances(bob), 0);
    }

    function testNoBetWinsOnPriceDropWithBothPoolsFunded() public {
        _deposit(alice, 100 * UNIT);
        _deposit(bob, 100 * UNIT);
        BinaryMarket market = _market();
        vm.prank(operator); vault.operatorPlaceBet(alice, address(market), true, 100 * UNIT);
        vm.prank(operator); vault.operatorPlaceBet(bob, address(market), false, 100 * UNIT);

        (uint256 yesPool, uint256 noPool) = market.getPoolSizes();
        assertEq(yesPool, 100 * UNIT);
        assertEq(noPool, 100 * UNIT);

        feed.setAnswer(99e8);
        vm.warp(market.endTime());
        market.resolve();
        assertTrue(market.resolved());
        assertFalse(market.refunded());
        assertFalse(market.yesWon());
        assertEq(market.commissionPaid(), 2 * UNIT);
        assertEq(usdc.balanceOf(market.treasury()), 2 * UNIT);

        vm.prank(operator); vault.operatorSettleMarket(address(market));
        assertEq(vault.balances(alice), 0);
        assertEq(vault.balances(bob), 198 * UNIT);
    }

    function testRefundedMarketCreditsEveryone() public {
        _deposit(alice, 100 * UNIT);
        _deposit(bob, 100 * UNIT);
        BinaryMarket market = _market();
        vm.prank(operator); vault.operatorPlaceBet(alice, address(market), true, 100 * UNIT);
        vm.prank(operator); vault.operatorPlaceBet(bob, address(market), false, 100 * UNIT);
        vm.warp(market.endTime()); market.resolve(); // no new feed round
        vm.prank(operator); vault.operatorSettleMarket(address(market));
        assertEq(vault.balances(alice), 100 * UNIT);
        assertEq(vault.balances(bob), 100 * UNIT);
    }

    function testLosingOnlyVaultPositionSettlesWithoutCredit() public {
        _deposit(alice, 100 * UNIT);
        BinaryMarket market = _market();
        vm.prank(operator); vault.operatorPlaceBet(alice, address(market), false, 100 * UNIT);
        // A direct external YES bet gives the market a winning side while the
        // Vault itself holds only the losing NO position.
        vm.prank(bob); usdc.approve(address(market), 100 * UNIT);
        vm.prank(bob); market.placeBet(true, 100 * UNIT);
        feed.setAnswer(101e8);
        vm.warp(market.endTime()); market.resolve();
        vm.prank(operator); vault.operatorSettleMarket(address(market));
        assertTrue(vault.marketSettled(address(market)));
        assertEq(vault.balances(alice), 0);
    }

    function testNonOperatorCannotCallOperatorFunctions() public {
        BinaryMarket market = _market();
        vm.expectRevert(Vault.OnlyOperator.selector);
        vault.operatorPlaceBet(alice, address(market), true, UNIT);
        vm.expectRevert(Vault.OnlyOperator.selector);
        vault.operatorSettleMarket(address(market));
    }
}
