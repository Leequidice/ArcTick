// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MarketFactory} from "../src/MarketFactory.sol";
import {BinaryMarket} from "../src/BinaryMarket.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockAggregatorV3} from "./mocks/MockAggregatorV3.sol";

contract BinaryMarketTest is Test {
    uint256 internal constant UNIT = 1e6;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");
    MockUSDC internal usdc;
    MockAggregatorV3 internal feed;
    MarketFactory internal factory;

    function setUp() public {
        vm.warp(1_000);
        usdc = new MockUSDC();
        feed = new MockAggregatorV3(100e8);
        factory = new MarketFactory(usdc, treasury, address(this));
        factory.setMarketCreator(address(this), true);
        usdc.mint(alice, 1_000 * UNIT);
        usdc.mint(bob, 1_000 * UNIT);
        vm.prank(alice); usdc.approve(address(factory), type(uint256).max);
        vm.prank(bob); usdc.approve(address(factory), type(uint256).max);
    }

    function _market() internal returns (BinaryMarket) {
        return factory.createMarket("BTC/USD", address(feed), 60);
    }

    function _bet(BinaryMarket market, address bettor, bool isYes, uint256 amount) internal {
        vm.prank(bettor); usdc.approve(address(market), amount);
        vm.prank(bettor); market.placeBet(isYes, amount);
    }

    function testYesWinsResolveAndClaim() public {
        BinaryMarket market = _market();
        _bet(market, alice, true, 100 * UNIT);
        _bet(market, bob, false, 100 * UNIT);
        (uint256 yesParticipants, uint256 noParticipants) = market.getParticipantCounts();
        assertEq(yesParticipants, 1);
        assertEq(noParticipants, 1);

        feed.setAnswer(101e8);
        vm.warp(market.endTime());
        market.resolve();

        assertTrue(market.yesWon());
        assertEq(usdc.balanceOf(treasury), 2 * UNIT);
        vm.prank(alice); market.claim();
        assertEq(usdc.balanceOf(alice), 1_098 * UNIT);
    }

    function testNoWinsResolveAndClaimFlatPrice() public {
        BinaryMarket market = _market();
        _bet(market, alice, true, 100 * UNIT);
        _bet(market, bob, false, 100 * UNIT);

        feed.setAnswer(100e8); // Flat explicitly resolves to NO.
        vm.warp(market.endTime());
        market.resolve();
        assertFalse(market.yesWon());
        vm.prank(bob); market.claim();
        assertEq(usdc.balanceOf(bob), 1_098 * UNIT);
    }

    function testEmptySideRefundsAndTakesNoCommission() public {
        BinaryMarket market = _market();
        _bet(market, alice, true, 100 * UNIT);
        feed.setAnswer(101e8);
        vm.warp(market.endTime());
        market.resolve();

        assertEq(market.commissionPaid(), 0);
        vm.prank(alice); market.claim();
        assertEq(usdc.balanceOf(alice), 1_000 * UNIT);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    function testZeroPoolMarketResolvesAsHarmlessRefund() public {
        BinaryMarket market = _market();
        vm.warp(market.endTime());

        market.resolve();

        assertTrue(market.resolved());
        assertTrue(market.refunded());
        assertEq(market.commissionPaid(), 0);
        assertEq(usdc.balanceOf(address(market)), 0);
    }

    function testStaleRoundRefundsBothSidesWithoutCommission() public {
        BinaryMarket market = _market();
        _bet(market, alice, true, 100 * UNIT);
        _bet(market, bob, false, 100 * UNIT);
        feed.setAnswerWithoutNewRound(101e8); // Price changed in mock, but no oracle round arrived.
        vm.warp(market.endTime());
        market.resolve();

        assertTrue(market.refunded());
        assertEq(market.commissionPaid(), 0);
        vm.prank(alice); market.claim();
        vm.prank(bob); market.claim();
        assertEq(usdc.balanceOf(alice), 1_000 * UNIT);
        assertEq(usdc.balanceOf(bob), 1_000 * UNIT);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    function testCannotClaimBeforeResolution() public {
        BinaryMarket market = _market();
        _bet(market, alice, true, 100 * UNIT);
        vm.prank(alice);
        vm.expectRevert(BinaryMarket.MarketNotResolved.selector);
        market.claim();
    }

    function testCannotClaimTwice() public {
        BinaryMarket market = _market();
        _bet(market, alice, true, 100 * UNIT);
        _bet(market, bob, false, 100 * UNIT);
        feed.setAnswer(101e8);
        vm.warp(market.endTime());
        market.resolve();
        vm.prank(alice); market.claim();
        vm.prank(alice);
        vm.expectRevert(BinaryMarket.AlreadyClaimed.selector);
        market.claim();
    }

    function testCannotBetAfterMarketEnd() public {
        BinaryMarket market = _market();
        vm.warp(market.endTime());
        vm.prank(alice); usdc.approve(address(market), 100 * UNIT);
        vm.prank(alice);
        vm.expectRevert(BinaryMarket.MarketClosed.selector);
        market.placeBet(true, 100 * UNIT);
    }

    function testCommissionIsTwoPercentOfLosingPool() public {
        BinaryMarket market = _market();
        _bet(market, alice, true, 70 * UNIT);
        _bet(market, bob, false, 125 * UNIT);
        feed.setAnswer(101e8);
        vm.warp(market.endTime());
        market.resolve();
        assertEq(market.commissionPaid(), (125 * UNIT * 200) / 10_000);
        assertEq(usdc.balanceOf(treasury), 2_500_000);
    }

    function testOnlyMarketCreatorCanCreateMarket() public {
        vm.prank(keeper);
        vm.expectRevert(MarketFactory.NotMarketCreator.selector);
        factory.createMarket("BTC/USD", address(feed), 60);

        factory.setMarketCreator(keeper, true);
        vm.prank(keeper);
        BinaryMarket market = factory.createMarket("BTC/USD", address(feed), 60);
        assertEq(market.factory(), address(factory));
    }

    function testCannotCreateDuplicateOpenMarketForFeedAndDuration() public {
        BinaryMarket first = _market();

        vm.expectRevert(abi.encodeWithSelector(MarketFactory.OpenMarketAlreadyExists.selector, address(first)));
        factory.createMarket("BTC/USD duplicate label", address(feed), 60);

        vm.warp(first.endTime());
        first.resolve();

        BinaryMarket replacement = factory.createMarket("BTC/USD", address(feed), 60);
        assertTrue(address(replacement) != address(first));
    }

    function testMarketCreatorCannotExecuteOwnerOnlyRoleAdministration() public {
        factory.setMarketCreator(keeper, true);
        vm.prank(keeper);
        vm.expectRevert();
        factory.setMarketCreator(alice, true);
    }
}
