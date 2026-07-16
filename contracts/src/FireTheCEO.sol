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
    error InvalidAmount();
    error TradingClosed();
    error SlippageExceeded();
    error InsufficientShares();
    error ShareCapExceeded();
    error PositionOverflow();
    error OracleOnly();
    error BeforeSettlement();
    error DisputeWindowClosed();
    error NotResolved();
    error NotClaimable();

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
        _checkedQ(market, longSide, _shareDelta(shares));
        cost = _quoteBuy(market, longSide, shares);
    }

    function quoteSell(uint256 companyId, MarketKind kind, bool longSide, uint256 shares)
        external
        view
        returns (uint256 proceeds)
    {
        Market storage market = _market(companyId, kind);
        _checkedQ(market, longSide, -_shareDelta(shares));
        proceeds = _quoteSell(market, longSide, shares);
    }

    function buy(uint256 companyId, MarketKind kind, bool longSide, uint256 shares, uint256 maxCost)
        external
        returns (uint256 cost)
    {
        Market storage market = _market(companyId, kind);
        if (block.timestamp >= companies[companyId].horizon) revert TradingClosed();
        int256 newQ = _checkedQ(market, longSide, _shareDelta(shares));
        cost = _quoteBuy(market, longSide, shares);
        if (cost > maxCost) revert SlippageExceeded();

        Pos storage position = positions[companyId][uint8(kind)][msg.sender];
        uint256 newShares = uint256(longSide ? position.sharesL : position.sharesS) + shares;
        uint256 newPaidIn = uint256(position.paidIn) + cost;
        if (newShares > type(uint128).max || newPaidIn > type(uint128).max) revert PositionOverflow();

        SafeTransferLib.safeTransferFrom(address(pusd), msg.sender, address(this), cost);
        if (longSide) {
            market.qL = int128(newQ);
            position.sharesL = uint128(newShares);
        } else {
            market.qS = int128(newQ);
            position.sharesS = uint128(newShares);
        }
        position.paidIn = uint128(newPaidIn);

        emit Trade(companyId, uint8(kind), msg.sender, true, longSide, shares, cost);
    }

    function sell(uint256 companyId, MarketKind kind, bool longSide, uint256 shares, uint256 minProceeds)
        external
        returns (uint256 proceeds)
    {
        Market storage market = _market(companyId, kind);
        if (block.timestamp >= companies[companyId].horizon) revert TradingClosed();
        Pos storage position = positions[companyId][uint8(kind)][msg.sender];
        uint128 held = longSide ? position.sharesL : position.sharesS;
        if (shares == 0) revert InvalidAmount();
        if (shares > held) revert InsufficientShares();

        int256 newQ = _checkedQ(market, longSide, -_shareDelta(shares));
        proceeds = _quoteSell(market, longSide, shares);
        if (proceeds < minProceeds) revert SlippageExceeded();
        uint256 newEscrow = uint256(position.escrow) + proceeds;
        if (newEscrow > type(uint128).max) revert PositionOverflow();

        if (longSide) {
            market.qL = int128(newQ);
            position.sharesL = held - uint128(shares);
        } else {
            market.qS = int128(newQ);
            position.sharesS = held - uint128(shares);
        }
        position.escrow = uint128(newEscrow);

        emit Trade(companyId, uint8(kind), msg.sender, false, longSide, shares, proceeds);
    }

    function resolveCompany(uint256 companyId, bool fired, uint32 priceCents, string calldata sourceURI) external {
        _requireCompany(companyId);
        if (msg.sender != oracle) revert OracleOnly();
        Company storage company = companies[companyId];
        if (block.timestamp < company.settleTime) revert BeforeSettlement();
        if (company.resolved && block.timestamp > uint256(company.resolvedAt) + DISPUTE_WINDOW) {
            revert DisputeWindowClosed();
        }

        if (!company.resolved) {
            company.resolved = true;
            company.resolvedAt = uint64(block.timestamp);
        }
        company.fired = fired;
        company.settledPriceCents = priceCents;
        company.resolutionURI = sourceURI;

        emit Resolved(companyId, fired, priceCents, sourceURI);
    }

    function claim(uint256 companyId) external returns (uint256 amount) {
        _requireCompany(companyId);
        Company storage company = companies[companyId];
        if (!company.resolved) revert NotResolved();
        if (block.timestamp <= uint256(company.resolvedAt) + DISPUTE_WINDOW) revert NotClaimable();

        for (uint8 kind; kind < 3; ++kind) {
            Pos storage position = positions[companyId][kind][msg.sender];
            amount += _entitlement(company, kind, position);
            delete positions[companyId][kind][msg.sender];
        }
        if (amount != 0) SafeTransferLib.safeTransfer(address(pusd), msg.sender, amount);

        emit Claimed(companyId, msg.sender, amount);
    }

    function claimableAmount(uint256 companyId, address trader) external view returns (uint256 amount) {
        _requireCompany(companyId);
        Company storage company = companies[companyId];
        if (!company.resolved) revert NotResolved();
        for (uint8 kind; kind < 3; ++kind) {
            amount += _entitlement(company, kind, positions[companyId][kind][trader]);
        }
    }

    function getPositions(address trader, uint256 companyId) external view returns (Pos[3] memory result) {
        _requireCompany(companyId);
        for (uint8 kind; kind < 3; ++kind) {
            result[kind] = positions[companyId][kind][trader];
        }
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

    function _quoteBuy(Market storage market, bool longSide, uint256 shares) internal view returns (uint256) {
        int256 rawCost = LMSR.buyCost(market.qL, market.qS, int256(uint256(market.b)), int256(shares), longSide);
        return (rawCost > 0 ? uint256(rawCost) : 0) + DUST;
    }

    function _quoteSell(Market storage market, bool longSide, uint256 shares) internal view returns (uint256) {
        int256 rawCost = LMSR.buyCost(market.qL, market.qS, int256(uint256(market.b)), -int256(shares), longSide);
        uint256 gross = rawCost < 0 ? uint256(-rawCost) : 0;
        return gross > DUST ? gross - DUST : 0;
    }

    function _shareDelta(uint256 shares) internal pure returns (int256) {
        if (shares == 0) revert InvalidAmount();
        if (shares > uint256(MAX_SHARES) * 2) revert ShareCapExceeded();
        return int256(shares);
    }

    function _checkedQ(Market storage market, bool longSide, int256 delta) internal view returns (int256 newQ) {
        newQ = (longSide ? int256(market.qL) : int256(market.qS)) + delta;
        if (newQ < -MAX_SHARES || newQ > MAX_SHARES) revert ShareCapExceeded();
    }

    function _entitlement(Company storage company, uint8 kind, Pos storage position) internal view returns (uint256) {
        bool valid = kind == uint8(MarketKind.Exit) || (kind == uint8(MarketKind.Out) && company.fired)
            || (kind == uint8(MarketKind.Stay) && !company.fired);
        if (!valid) return position.paidIn;

        uint256 weight = kind == uint8(MarketKind.Exit) ? (company.fired ? uint256(WAD) : 0) : _weight(company);
        return uint256(position.escrow) + (uint256(position.sharesL) * weight) / uint256(WAD)
            + (uint256(position.sharesS) * (uint256(WAD) - weight)) / uint256(WAD);
    }

    function _weight(Company storage company) internal view returns (uint256) {
        if (company.settledPriceCents <= company.floorCents) return 0;
        if (company.settledPriceCents >= company.capCents) return uint256(WAD);
        return (uint256(company.settledPriceCents - company.floorCents) * uint256(WAD))
            / uint256(company.capCents - company.floorCents);
    }

    function _requireCompany(uint256 companyId) internal view {
        if (companyId >= companies.length) revert InvalidCompany();
    }
}
