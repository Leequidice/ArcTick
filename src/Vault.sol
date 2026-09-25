// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BinaryMarket} from "./BinaryMarket.sol";
import {MarketFactory} from "./MarketFactory.sol";

/// @notice Custodial internal USDC ledger operated by a trusted backend.
/// @dev The Vault claims once per market and allocates that exact payout among
/// its users. A max allowance is set lazily for each factory-created market.
contract Vault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    MarketFactory public immutable factory;
    address public operator;
    mapping(address user => uint256) public balances;
    mapping(address market => bool) public marketSettled;

    struct Position { uint256 yesStake; uint256 noStake; bool participant; }
    mapping(address market => mapping(address user => Position)) public positions;
    mapping(address market => address[]) private marketParticipants;

    error OnlyOperator();
    error InsufficientBalance();
    error InvalidMarket();
    error InvalidAmount();
    error MarketNotResolved();
    error MarketAlreadySettled();

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event OperatorChanged(address indexed operator);
    event OperatorBetPlaced(address indexed user, address indexed market, bool isYes, uint256 amount);
    event MarketSettled(address indexed market, uint256 payout, bool refunded);

    constructor(IERC20 usdc_, MarketFactory factory_, address initialOwner, address operator_) Ownable(initialOwner) {
        if (address(usdc_) == address(0) || address(factory_) == address(0) || initialOwner == address(0) || operator_ == address(0)) revert InvalidMarket();
        usdc = usdc_;
        factory = factory_;
        operator = operator_;
    }

    modifier onlyOperator() { if (msg.sender != operator) revert OnlyOperator(); _; }

    function setOperator(address operator_) external onlyOwner nonReentrant {
        if (operator_ == address(0)) revert InvalidMarket();
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        balances[msg.sender] += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (balances[msg.sender] < amount) revert InsufficientBalance();
        balances[msg.sender] -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function operatorPlaceBet(address user, address market, bool isYes, uint256 amount) external onlyOperator nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (!_isFactoryMarket(market)) revert InvalidMarket();
        if (balances[user] < amount) revert InsufficientBalance();
        balances[user] -= amount;

        Position storage position = positions[market][user];
        if (!position.participant) {
            position.participant = true;
            marketParticipants[market].push(user);
        }
        if (isYes) position.yesStake += amount;
        else position.noStake += amount;

        usdc.forceApprove(market, type(uint256).max);
        BinaryMarket(market).placeBet(isYes, amount);
        emit OperatorBetPlaced(user, market, isYes, amount);
    }

    function operatorSettleMarket(address market) external onlyOperator nonReentrant {
        if (!_isFactoryMarket(market)) revert InvalidMarket();
        if (marketSettled[market]) revert MarketAlreadySettled();
        BinaryMarket binaryMarket = BinaryMarket(market);
        if (!binaryMarket.resolved()) revert MarketNotResolved();

        marketSettled[market] = true;
        bool isRefunded = binaryMarket.refunded();
        uint256 winningVaultStake = binaryMarket.yesWon()
            ? binaryMarket.yesStakes(address(this))
            : binaryMarket.noStakes(address(this));
        // A Vault holding only losing stakes has nothing to claim. Marking it
        // settled is still essential so the keeper does not retry forever.
        if (!isRefunded && winningVaultStake == 0) {
            emit MarketSettled(market, 0, false);
            return;
        }
        uint256 payout = binaryMarket.claim();
        address[] storage participants = marketParticipants[market];
        uint256 denominator = isRefunded
            ? binaryMarket.yesStakes(address(this)) + binaryMarket.noStakes(address(this))
            : winningVaultStake;

        uint256 allocated;
        address lastEligible;
        for (uint256 i; i < participants.length; ++i) {
            Position storage position = positions[market][participants[i]];
            uint256 eligible = isRefunded ? position.yesStake + position.noStake : (binaryMarket.yesWon() ? position.yesStake : position.noStake);
            if (eligible != 0) lastEligible = participants[i];
        }
        for (uint256 i; i < participants.length; ++i) {
            address user = participants[i];
            Position storage position = positions[market][user];
            uint256 eligible = isRefunded ? position.yesStake + position.noStake : (binaryMarket.yesWon() ? position.yesStake : position.noStake);
            if (eligible == 0) continue;
            uint256 credit = user == lastEligible ? payout - allocated : (eligible * payout) / denominator;
            balances[user] += credit;
            allocated += credit;
        }
        emit MarketSettled(market, payout, isRefunded);
    }

    function getMarketParticipants(address market) external view returns (address[] memory) { return marketParticipants[market]; }

    function _isFactoryMarket(address market) private view returns (bool) {
        return market.code.length != 0 && BinaryMarket(market).factory() == address(factory) && address(BinaryMarket(market).usdc()) == address(usdc);
    }
}
