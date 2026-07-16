// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {LMSR} from "./LMSR.sol";

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

contract FireTheCEO is Ownable {
    enum MarketKind {
        Out,
        Stay,
        Exit
    }

    struct Market {
        int128 qL;
        int128 qS;
        uint128 b;
    }

    struct Company {
        string ticker;
        string name;
        string ceo;
        uint32 spotCents;
        uint32 floorCents;
        uint32 capCents;
        uint64 horizon;
        uint64 settleTime;
        bool resolved;
        bool fired;
        uint32 settledPriceCents;
        uint64 resolvedAt;
        string resolutionURI;
    }

    struct Pos {
        uint128 sharesL;
        uint128 sharesS;
        uint128 paidIn;
        uint128 escrow;
    }

    error InvalidCompany();
    error InvalidMarketParameters();

    IERC20 public immutable pusd;
    address public oracle;

    uint64 public constant DISPUTE_WINDOW = 172_800;
    uint256 public constant DUST = 1e9;
    int256 internal constant WAD = 1e18;
    int256 internal constant MAX_SHARES = 1e27;

    Company[] public companies;
    mapping(uint256 => Market[3]) internal markets_;
    mapping(uint256 => mapping(uint8 => mapping(address => Pos))) public positions;

    event CompanyListed(uint256 indexed companyId, string ticker, string ceo, uint256 subsidy);
    event Trade(
        uint256 indexed companyId,
        uint8 indexed kind,
        address indexed trader,
        bool isBuy,
        bool longSide,
        uint256 shares,
        uint256 amount
    );
    event Resolved(uint256 indexed companyId, bool fired, uint32 priceCents, string sourceURI);
    event Claimed(uint256 indexed companyId, address indexed trader, uint256 amount);

    constructor(address pusd_) {
        if (pusd_ == address(0)) revert InvalidMarketParameters();
        pusd = IERC20(pusd_);
        oracle = msg.sender;
        _initializeOwner(msg.sender);
    }

    function setOracle(address newOracle) external onlyOwner {
        if (newOracle == address(0)) revert InvalidMarketParameters();
        oracle = newOracle;
    }

    function listCompany(
        string calldata ticker,
        string calldata name,
        string calldata ceo,
        uint32 spotCents,
        uint64 horizon,
        uint64 settleTime,
        uint128 bScalar,
        uint128 bExit,
        uint256 initExitProbWad
    ) external onlyOwner returns (uint256 companyId) {
        if (
            spotCents == 0 || horizon >= settleTime || bScalar < uint128(uint256(WAD)) || bExit < uint128(uint256(WAD))
                || initExitProbWad == 0 || initExitProbWad >= uint256(WAD)
        ) revert InvalidMarketParameters();

        uint256 cap = (uint256(spotCents) * 7) / 4;
        if (cap > type(uint32).max) revert InvalidMarketParameters();

        int256 qExit = LMSR.initialQ(int256(uint256(bExit)), initExitProbWad);
        if (qExit < -MAX_SHARES || qExit > MAX_SHARES) revert InvalidMarketParameters();

        companyId = companies.length;
        companies.push();
        Company storage company = companies[companyId];
        company.ticker = ticker;
        company.name = name;
        company.ceo = ceo;
        company.spotCents = spotCents;
        company.floorCents = spotCents / 4;
        company.capCents = uint32(cap);
        company.horizon = horizon;
        company.settleTime = settleTime;

        markets_[companyId][uint8(MarketKind.Out)] = Market({qL: 0, qS: 0, b: bScalar});
        markets_[companyId][uint8(MarketKind.Stay)] = Market({qL: 0, qS: 0, b: bScalar});
        markets_[companyId][uint8(MarketKind.Exit)] = Market({qL: int128(qExit), qS: 0, b: bExit});

        uint256 subsidy = _marketLoss(markets_[companyId][0]) + DUST + _marketLoss(markets_[companyId][1]) + DUST
            + _marketLoss(markets_[companyId][2]) + DUST;
        SafeTransferLib.safeTransferFrom(address(pusd), msg.sender, address(this), subsidy);

        emit CompanyListed(companyId, ticker, ceo, subsidy);
    }

    function companyCount() external view returns (uint256) {
        return companies.length;
    }

    function getCompany(uint256 companyId) external view returns (Company memory) {
        _requireCompany(companyId);
        return companies[companyId];
    }

    function getMarkets(uint256 companyId) external view returns (Market[3] memory) {
        _requireCompany(companyId);
        return markets_[companyId];
    }

    function getAllPrices()
        external
        view
        returns (uint256[] memory midOut, uint256[] memory midStay, uint256[] memory pExit, uint8[] memory state)
    {
        uint256 count = companies.length;
        midOut = new uint256[](count);
        midStay = new uint256[](count);
        pExit = new uint256[](count);
        state = new uint8[](count);

        for (uint256 i; i < count; ++i) {
            midOut[i] = _price(markets_[i][uint8(MarketKind.Out)]);
            midStay[i] = _price(markets_[i][uint8(MarketKind.Stay)]);
            pExit[i] = _price(markets_[i][uint8(MarketKind.Exit)]);

            Company storage company = companies[i];
            if (company.resolved) {
                state[i] = block.timestamp > uint256(company.resolvedAt) + DISPUTE_WINDOW ? 3 : 2;
            } else if (block.timestamp >= company.horizon) {
                state[i] = 1;
            }
        }
    }

    function quoteBuy(uint256 companyId, MarketKind kind, bool longSide, uint256 shares)
        external
        view
        returns (uint256 cost)
    {
        Market storage market = _market(companyId, kind);
        int256 rawCost = LMSR.buyCost(market.qL, market.qS, int256(uint256(market.b)), int256(shares), longSide);
        cost = uint256(rawCost) + DUST;
    }

    function quoteSell(uint256 companyId, MarketKind kind, bool longSide, uint256 shares)
        external
        view
        returns (uint256 proceeds)
    {
        Market storage market = _market(companyId, kind);
        int256 rawCost = LMSR.buyCost(market.qL, market.qS, int256(uint256(market.b)), -int256(shares), longSide);
        uint256 gross = uint256(-rawCost);
        proceeds = gross > DUST ? gross - DUST : 0;
    }

    function _market(uint256 companyId, MarketKind kind) internal view returns (Market storage market) {
        _requireCompany(companyId);
        market = markets_[companyId][uint8(kind)];
    }

    function _marketLoss(Market storage market) internal view returns (uint256) {
        return LMSR.worstCaseLoss(market.qL, market.qS, int256(uint256(market.b)));
    }

    function _price(Market storage market) internal view returns (uint256) {
        return LMSR.priceL(market.qL, market.qS, int256(uint256(market.b)));
    }

    function _requireCompany(uint256 companyId) internal view {
        if (companyId >= companies.length) revert InvalidCompany();
    }
}
