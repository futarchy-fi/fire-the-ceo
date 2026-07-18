// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {LMSR} from "../LMSR.sol";

interface IERC20V2 {
    function balanceOf(address account) external view returns (uint256);
}

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

/// @notice V2 market, escrow, observation and docket core. Signed orders settle through
/// the one-time-authorized FireTheCEOExchangeV2 module below.
contract FireTheCEOv2 is Ownable {
    enum MarketKind { Out, Stay, Exit }

    struct Market { int128 qL; int128 qS; uint128 b; }
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
    struct Pos { uint128 sharesL; uint128 sharesS; uint128 paidIn; uint128 escrow; }
    struct Observation { uint32 blockTimestamp; uint224 cumulativePriceWad; }
    struct ObservationState { uint16 index; uint16 cardinality; }
    struct BoostProposal {
        address proposer;
        uint256 companyId;
        uint256 payment;
        int256 baselinePremium;
        uint256 reward;
    }
    struct DocketCycle { uint256 rewardPool; bool settled; }
    struct ListingProposal { address proposer; string ticker; uint256 payment; bool resolved; }

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
    error ExchangeOnly();
    error ExchangeAlreadySet();
    error InvalidTokenId();
    error ObservationTooOld();
    error InvalidBoost();
    error CycleNotReady();
    error AlreadySettled();
    error InvalidProposal();

    IERC20V2 public immutable pusd;
    address public oracle;
    address public exchange;

    uint64 public constant DISPUTE_WINDOW = 172_800;
    uint256 public constant DUST = 1e9;
    uint256 public constant WAD = 1e18;
    int256 internal constant MAX_SHARES = 1e27;
    uint16 public constant OBSERVATION_BUFFER_SIZE = 4096;

    Company[] public companies;
    mapping(uint256 => Market[3]) internal markets_;
    mapping(uint256 => mapping(uint8 => mapping(address => Pos))) public positions;
    mapping(uint256 => mapping(uint16 => Observation)) internal observations_;
    mapping(uint256 => ObservationState) public observationStates;

    mapping(uint256 => DocketCycle) public docketCycles;
    mapping(uint256 => BoostProposal[]) internal boostProposals_;
    mapping(uint256 => uint256[]) internal cycleCompanies_;
    uint256 public pendingDocketRollover;
    ListingProposal[] internal listingProposals_;

    event CompanyListed(uint256 indexed companyId, string ticker, string ceo, uint256 subsidy);
    event Trade(uint256 indexed companyId, uint8 indexed kind, address indexed trader, bool isBuy, bool longSide, uint256 shares, uint256 amount);
    event Resolved(uint256 indexed companyId, bool fired, uint32 priceCents, string sourceURI);
    event Claimed(uint256 indexed companyId, address indexed trader, uint256 amount);
    event ExchangeAuthorized(address indexed exchange);
    event BoostProposed(uint256 indexed cycleId, uint256 indexed companyId, address indexed proposer, uint256 payment, uint256 consumed, int256 baselinePremium, uint128[3] newBs);
    event DocketSettled(uint256 indexed cycleId, uint256 rewardPool, uint256 paid, uint256 rollover);
    event ProposedListing(string ticker, uint256 payment);
    event ListingProposalResolved(uint256 indexed proposalId, bool refunded);

    constructor(address pusd_) {
        if (pusd_ == address(0)) revert InvalidMarketParameters();
        pusd = IERC20V2(pusd_);
        oracle = msg.sender;
        _initializeOwner(msg.sender);
    }

    modifier onlyExchange() {
        if (msg.sender != exchange) revert ExchangeOnly();
        _;
    }

    function setExchange(address exchange_) external onlyOwner {
        if (exchange != address(0)) revert ExchangeAlreadySet();
        if (exchange_ == address(0) || exchange_.code.length == 0) revert InvalidMarketParameters();
        exchange = exchange_;
        emit ExchangeAuthorized(exchange_);
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
        if (spotCents == 0 || horizon >= settleTime || bScalar < WAD || bExit < WAD || initExitProbWad == 0 || initExitProbWad >= WAD) {
            revert InvalidMarketParameters();
        }
        uint256 cap = (uint256(spotCents) * 7) / 4;
        if (cap > type(uint32).max || block.timestamp > type(uint32).max) revert InvalidMarketParameters();
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
        markets_[companyId][0] = Market(0, 0, bScalar);
        markets_[companyId][1] = Market(0, 0, bScalar);
        markets_[companyId][2] = Market(int128(qExit), 0, bExit);

        uint256 subsidy = _marketLoss(markets_[companyId][0]) + DUST + _marketLoss(markets_[companyId][1]) + DUST + _marketLoss(markets_[companyId][2]) + DUST;
        SafeTransferLib.safeTransferFrom(address(pusd), msg.sender, address(this), subsidy);
        cycleCompanies_[horizon].push(companyId);
        for (uint8 kind; kind < 3; ++kind) _initializeObservation(companyId * 3 + kind);
        emit CompanyListed(companyId, ticker, ceo, subsidy);
    }

    function companyCount() external view returns (uint256) { return companies.length; }
    function getCompany(uint256 companyId) external view returns (Company memory) { _requireCompany(companyId); return companies[companyId]; }
    function getMarkets(uint256 companyId) external view returns (Market[3] memory) { _requireCompany(companyId); return markets_[companyId]; }
    function getPositions(address trader, uint256 companyId) external view returns (Pos[3] memory result) {
        _requireCompany(companyId);
        for (uint8 kind; kind < 3; ++kind) result[kind] = positions[companyId][kind][trader];
    }

    function getAllPrices() external view returns (uint256[] memory midOut, uint256[] memory midStay, uint256[] memory pExit, uint8[] memory state) {
        uint256 count = companies.length;
        midOut = new uint256[](count); midStay = new uint256[](count); pExit = new uint256[](count); state = new uint8[](count);
        for (uint256 i; i < count; ++i) {
            midOut[i] = _price(markets_[i][0]); midStay[i] = _price(markets_[i][1]); pExit[i] = _price(markets_[i][2]);
            Company storage company = companies[i];
            if (company.resolved) state[i] = block.timestamp > uint256(company.resolvedAt) + DISPUTE_WINDOW ? 3 : 2;
            else if (block.timestamp >= company.horizon) state[i] = 1;
        }
    }

    function quoteBuy(uint256 companyId, MarketKind kind, bool longSide, uint256 shares) public view returns (uint256 cost) {
        Market storage market = _market(companyId, kind);
        _checkedQ(market, longSide, _shareDelta(shares));
        cost = _quoteBuy(market, longSide, shares);
    }

    function quoteSell(uint256 companyId, MarketKind kind, bool longSide, uint256 shares) public view returns (uint256 proceeds) {
        Market storage market = _market(companyId, kind);
        _checkedQ(market, longSide, -_shareDelta(shares));
        proceeds = _quoteSell(market, longSide, shares);
    }

    function buy(uint256 companyId, MarketKind kind, bool longSide, uint256 shares, uint256 maxCost) external returns (uint256 cost) {
        return _buy(msg.sender, companyId, kind, longSide, shares, maxCost, true);
    }

    function sell(uint256 companyId, MarketKind kind, bool longSide, uint256 shares, uint256 minProceeds) external returns (uint256 proceeds) {
        return _sell(msg.sender, companyId, kind, longSide, shares, minProceeds);
    }

    function exchangeAmmBuy(address trader, uint256 tokenId, uint256 shares, uint256 maxCost) external onlyExchange returns (uint256) {
        (uint256 companyId, MarketKind kind, bool longSide) = decodeTokenId(tokenId);
        return _buy(trader, companyId, kind, longSide, shares, maxCost, true);
    }

    function exchangeAmmSell(address trader, uint256 tokenId, uint256 shares, uint256 minProceeds) external onlyExchange returns (uint256) {
        (uint256 companyId, MarketKind kind, bool longSide) = decodeTokenId(tokenId);
        return _sell(trader, companyId, kind, longSide, shares, minProceeds);
    }

    function exchangeComplementary(uint256 tokenId, address buyer, address seller, uint256 shares, uint256 cost) external onlyExchange {
        (uint256 companyId, MarketKind kind, bool longSide) = decodeTokenId(tokenId);
        _requireOpen(companyId); if (shares == 0 || cost == 0) revert InvalidAmount();
        _debitShares(companyId, uint8(kind), seller, longSide, shares);
        _creditShares(companyId, uint8(kind), buyer, longSide, shares);
        _addPaidIn(companyId, uint8(kind), buyer, cost);
        _addEscrow(companyId, uint8(kind), seller, cost);
        SafeTransferLib.safeTransferFrom(address(pusd), buyer, address(this), cost);
    }

    function exchangeMint(uint256 tokenIdA, address buyerA, address buyerB, uint256 shares, uint256 costA, uint256 costB) external onlyExchange {
        if ((tokenIdA ^ 1) == tokenIdA || costA + costB != shares || shares == 0) revert InvalidAmount();
        (uint256 companyId, MarketKind kind, bool longA) = decodeTokenId(tokenIdA);
        _requireComplement(tokenIdA, tokenIdA ^ 1); _requireOpen(companyId);
        _creditShares(companyId, uint8(kind), buyerA, longA, shares);
        _creditShares(companyId, uint8(kind), buyerB, !longA, shares);
        _addPaidIn(companyId, uint8(kind), buyerA, costA);
        _addPaidIn(companyId, uint8(kind), buyerB, costB);
        if (costA != 0) SafeTransferLib.safeTransferFrom(address(pusd), buyerA, address(this), costA);
        if (costB != 0) SafeTransferLib.safeTransferFrom(address(pusd), buyerB, address(this), costB);
    }

    function exchangeMerge(uint256 tokenIdA, address sellerA, address sellerB, uint256 shares, uint256 proceedsA, uint256 proceedsB) external onlyExchange {
        if (proceedsA + proceedsB != shares || shares == 0) revert InvalidAmount();
        (uint256 companyId, MarketKind kind, bool longA) = decodeTokenId(tokenIdA);
        _requireComplement(tokenIdA, tokenIdA ^ 1); _requireOpen(companyId);
        _debitShares(companyId, uint8(kind), sellerA, longA, shares);
        _debitShares(companyId, uint8(kind), sellerB, !longA, shares);
        _addEscrow(companyId, uint8(kind), sellerA, proceedsA);
        _addEscrow(companyId, uint8(kind), sellerB, proceedsB);
    }

    function decodeTokenId(uint256 tokenId) public view returns (uint256 companyId, MarketKind kind, bool longSide) {
        companyId = tokenId / 6;
        if (companyId >= companies.length) revert InvalidTokenId();
        uint256 local = tokenId % 6;
        kind = MarketKind(local / 2);
        longSide = (local & 1) == 0;
    }

    function isTokenOpen(uint256 tokenId) external view returns (bool) {
        (uint256 companyId,,) = decodeTokenId(tokenId);
        return block.timestamp < companies[companyId].horizon;
    }

    function resolveCompany(uint256 companyId, bool fired, uint32 priceCents, string calldata sourceURI) external {
        _requireCompany(companyId); if (msg.sender != oracle) revert OracleOnly();
        Company storage company = companies[companyId];
        if (block.timestamp < company.settleTime) revert BeforeSettlement();
        if (company.resolved && block.timestamp > uint256(company.resolvedAt) + DISPUTE_WINDOW) revert DisputeWindowClosed();
        if (!company.resolved) { company.resolved = true; company.resolvedAt = uint64(block.timestamp); }
        company.fired = fired; company.settledPriceCents = priceCents; company.resolutionURI = sourceURI;
        emit Resolved(companyId, fired, priceCents, sourceURI);
    }

    function claim(uint256 companyId) external returns (uint256 amount) {
        _requireCompany(companyId); Company storage company = companies[companyId];
        if (!company.resolved) revert NotResolved();
        if (block.timestamp <= uint256(company.resolvedAt) + DISPUTE_WINDOW) revert NotClaimable();
        for (uint8 kind; kind < 3; ++kind) { Pos storage position = positions[companyId][kind][msg.sender]; amount += _entitlement(company, kind, position); delete positions[companyId][kind][msg.sender]; }
        if (amount != 0) SafeTransferLib.safeTransfer(address(pusd), msg.sender, amount);
        emit Claimed(companyId, msg.sender, amount);
    }

    function claimableAmount(uint256 companyId, address trader) external view returns (uint256 amount) {
        _requireCompany(companyId); Company storage company = companies[companyId]; if (!company.resolved) revert NotResolved();
        for (uint8 kind; kind < 3; ++kind) amount += _entitlement(company, kind, positions[companyId][kind][trader]);
    }

    function observe(uint256 marketId, uint32[] calldata secondsAgos) external view returns (uint256[] memory cumulativePrices) {
        _requireMarketId(marketId); cumulativePrices = new uint256[](secondsAgos.length);
        for (uint256 i; i < secondsAgos.length; ++i) {
            if (secondsAgos[i] > block.timestamp) revert ObservationTooOld();
            (cumulativePrices[i],) = _cumulativeAt(marketId, uint32(block.timestamp - secondsAgos[i]));
        }
    }

    function getObservation(uint256 marketId, uint16 index) external view returns (Observation memory) {
        _requireMarketId(marketId); return observations_[marketId][index];
    }

    function timeAvgPremium(uint256 companyId, uint32 window) public view returns (int256 premium) {
        _requireCompany(companyId); if (window == 0) revert InvalidAmount();
        uint32 end = uint32(block.timestamp < companies[companyId].horizon ? block.timestamp : companies[companyId].horizon);
        (premium,) = _timeAvgPremiumAt(companyId, end, window);
    }

    function proposeBoost(uint256 companyId, uint256 payment, uint128[3] calldata newBs) external returns (uint256 proposalId) {
        _requireCompany(companyId); _requireOpen(companyId); if (payment == 0) revert InvalidBoost();
        uint256 tranche = payment * 80 / 100; uint256 consumed;
        int256 baseline = timeAvgPremium(companyId, 24 hours);
        uint256[3] memory oldPrices;
        for (uint8 kind; kind < 3; ++kind) {
            Market storage market = markets_[companyId][kind];
            if (newBs[kind] < market.b || newBs[kind] < WAD) revert InvalidBoost();
            oldPrices[kind] = _price(market);
            int256 delta = LMSR.cost(market.qL, market.qS, int256(uint256(newBs[kind]))) - LMSR.cost(market.qL, market.qS, int256(uint256(market.b)));
            if (delta < 0) revert InvalidBoost(); consumed += uint256(delta);
        }
        if (consumed > tranche || consumed * 10 < tranche * 9) revert InvalidBoost();
        SafeTransferLib.safeTransferFrom(address(pusd), msg.sender, address(this), payment);
        uint256 refund = tranche - consumed; if (refund != 0) SafeTransferLib.safeTransfer(address(pusd), msg.sender, refund);
        for (uint8 kind; kind < 3; ++kind) { markets_[companyId][kind].b = newBs[kind]; _writeObservation(companyId * 3 + kind, oldPrices[kind]); }
        uint256 cycleId = companies[companyId].horizon; DocketCycle storage cycle = docketCycles[cycleId];
        if (cycle.settled) revert AlreadySettled();
        if (pendingDocketRollover != 0) { cycle.rewardPool += pendingDocketRollover; pendingDocketRollover = 0; }
        cycle.rewardPool += payment - tranche;
        proposalId = boostProposals_[cycleId].length;
        boostProposals_[cycleId].push(BoostProposal(msg.sender, companyId, payment - refund, baseline, 0));
        emit BoostProposed(cycleId, companyId, msg.sender, payment - refund, consumed, baseline, newBs);
    }

    function boostProposalCount(uint256 cycleId) external view returns (uint256) { return boostProposals_[cycleId].length; }
    function getBoostProposal(uint256 cycleId, uint256 proposalId) external view returns (BoostProposal memory) { return boostProposals_[cycleId][proposalId]; }

    function settleDocket(uint256 cycleId) external returns (uint256 paid) {
        DocketCycle storage cycle = docketCycles[cycleId]; if (cycle.settled) revert AlreadySettled();
        uint256[] storage ids = cycleCompanies_[cycleId]; if (ids.length == 0) revert CycleNotReady();
        for (uint256 i; i < ids.length; ++i) if (!companies[ids[i]].resolved) revert CycleNotReady();
        BoostProposal[] storage proposals = boostProposals_[cycleId]; uint256 denominator;
        uint256[] memory scores = new uint256[](proposals.length);
        for (uint256 i; i < proposals.length; ++i) {
            BoostProposal storage proposal = proposals[i];
            (int256 finalPremium, bool ok) = _timeAvgPremiumAt(proposal.companyId, uint32(companies[proposal.companyId].horizon), 7 days);
            if (ok && finalPremium > proposal.baselinePremium) {
                scores[i] = proposal.payment * uint256(finalPremium - proposal.baselinePremium);
                denominator += scores[i];
            }
        }
        uint256 pool = cycle.rewardPool; cycle.settled = true;
        if (denominator != 0) for (uint256 i; i < proposals.length; ++i) {
            uint256 reward = FixedPointMathLib.fullMulDiv(pool, scores[i], denominator);
            uint256 cap = proposals[i].payment * 3; if (reward > cap) reward = cap;
            proposals[i].reward = reward; paid += reward;
            if (reward != 0) SafeTransferLib.safeTransfer(address(pusd), proposals[i].proposer, reward);
        }
        pendingDocketRollover += pool - paid;
        emit DocketSettled(cycleId, pool, paid, pool - paid);
    }

    function proposeListing(string calldata ticker, uint256 payment) external returns (uint256 proposalId) {
        if (bytes(ticker).length == 0 || payment == 0) revert InvalidProposal();
        SafeTransferLib.safeTransferFrom(address(pusd), msg.sender, address(this), payment);
        proposalId = listingProposals_.length; listingProposals_.push(ListingProposal(msg.sender, ticker, payment, false));
        emit ProposedListing(ticker, payment);
    }

    function getListingProposal(uint256 proposalId) external view returns (ListingProposal memory) { return listingProposals_[proposalId]; }
    function resolveListingProposal(uint256 proposalId, bool refund) external onlyOwner {
        ListingProposal storage proposal = listingProposals_[proposalId]; if (proposal.resolved) revert InvalidProposal();
        proposal.resolved = true; if (refund) SafeTransferLib.safeTransfer(address(pusd), proposal.proposer, proposal.payment);
        emit ListingProposalResolved(proposalId, refund);
    }

    function _buy(address trader, uint256 companyId, MarketKind kind, bool longSide, uint256 shares, uint256 maxCost, bool pull) internal returns (uint256 cost) {
        Market storage market = _market(companyId, kind); _requireOpen(companyId);
        uint256 oldPrice = _price(market); int256 newQ = _checkedQ(market, longSide, _shareDelta(shares));
        cost = _quoteBuy(market, longSide, shares); if (cost > maxCost) revert SlippageExceeded();
        _creditShares(companyId, uint8(kind), trader, longSide, shares); _addPaidIn(companyId, uint8(kind), trader, cost);
        if (pull) SafeTransferLib.safeTransferFrom(address(pusd), trader, address(this), cost);
        if (longSide) market.qL = int128(newQ); else market.qS = int128(newQ);
        _writeObservation(companyId * 3 + uint8(kind), oldPrice);
        emit Trade(companyId, uint8(kind), trader, true, longSide, shares, cost);
    }

    function _sell(address trader, uint256 companyId, MarketKind kind, bool longSide, uint256 shares, uint256 minProceeds) internal returns (uint256 proceeds) {
        Market storage market = _market(companyId, kind); _requireOpen(companyId);
        uint256 oldPrice = _price(market); _debitShares(companyId, uint8(kind), trader, longSide, shares);
        int256 newQ = _checkedQ(market, longSide, -_shareDelta(shares)); proceeds = _quoteSell(market, longSide, shares);
        if (proceeds < minProceeds) revert SlippageExceeded(); _addEscrow(companyId, uint8(kind), trader, proceeds);
        if (longSide) market.qL = int128(newQ); else market.qS = int128(newQ);
        _writeObservation(companyId * 3 + uint8(kind), oldPrice);
        emit Trade(companyId, uint8(kind), trader, false, longSide, shares, proceeds);
    }

    function _initializeObservation(uint256 marketId) internal {
        observations_[marketId][0] = Observation(uint32(block.timestamp), 0); observationStates[marketId] = ObservationState(0, 1);
    }

    function _writeObservation(uint256 marketId, uint256 oldPrice) internal {
        ObservationState storage state = observationStates[marketId]; Observation storage last = observations_[marketId][state.index];
        uint32 now32 = uint32(block.timestamp); if (last.blockTimestamp == now32) return;
        uint256 cumulative = uint256(last.cumulativePriceWad) + oldPrice * (now32 - last.blockTimestamp);
        if (cumulative > type(uint224).max) revert PositionOverflow();
        uint16 next = uint16((uint256(state.index) + 1) % OBSERVATION_BUFFER_SIZE);
        observations_[marketId][next] = Observation(now32, uint224(cumulative)); state.index = next;
        if (state.cardinality < OBSERVATION_BUFFER_SIZE) ++state.cardinality;
    }

    function _cumulativeAt(uint256 marketId, uint32 target) internal view returns (uint256 cumulative, bool ok) {
        ObservationState memory state = observationStates[marketId]; if (state.cardinality == 0) return (0, false);
        uint16 oldestIndex = state.cardinality < OBSERVATION_BUFFER_SIZE ? 0 : uint16((uint256(state.index) + 1) % OBSERVATION_BUFFER_SIZE);
        Observation memory oldest = observations_[marketId][oldestIndex]; if (target < oldest.blockTimestamp) revert ObservationTooOld();
        Observation memory latest = observations_[marketId][state.index];
        if (target >= latest.blockTimestamp) return (uint256(latest.cumulativePriceWad) + _marketPriceById(marketId) * (target - latest.blockTimestamp), true);
        Observation memory beforeObs = oldest;
        for (uint16 logical = 1; logical < state.cardinality; ++logical) {
            uint16 index = uint16((uint256(oldestIndex) + logical) % OBSERVATION_BUFFER_SIZE);
            Observation memory afterObs = observations_[marketId][index];
            if (target <= afterObs.blockTimestamp) {
                if (target == afterObs.blockTimestamp) return (afterObs.cumulativePriceWad, true);
                uint256 elapsed = target - beforeObs.blockTimestamp;
                uint256 span = afterObs.blockTimestamp - beforeObs.blockTimestamp;
                return (uint256(beforeObs.cumulativePriceWad) + FixedPointMathLib.fullMulDiv(uint256(afterObs.cumulativePriceWad) - uint256(beforeObs.cumulativePriceWad), elapsed, span), true);
            }
            beforeObs = afterObs;
        }
        return (0, false);
    }

    function _timeAvgPremiumAt(uint256 companyId, uint32 end, uint32 window) internal view returns (int256 premium, bool ok) {
        if (window == 0 || end < window) return (0, false); uint32 start = end - window;
        try this.cumulativeAtForDocket(companyId * 3, start, end) returns (uint256 outDelta) {
            try this.cumulativeAtForDocket(companyId * 3 + 1, start, end) returns (uint256 stayDelta) {
                premium = int256(outDelta / window) - int256(stayDelta / window); ok = true;
            } catch { return (0, false); }
        } catch { return (0, false); }
    }

    function cumulativeAtForDocket(uint256 marketId, uint32 start, uint32 end) external view returns (uint256) {
        if (msg.sender != address(this)) revert InvalidAmount(); (uint256 a,) = _cumulativeAt(marketId, start); (uint256 b,) = _cumulativeAt(marketId, end); return b - a;
    }

    function _creditShares(uint256 companyId, uint8 kind, address trader, bool longSide, uint256 shares) internal {
        if (shares == 0) revert InvalidAmount();
        if (shares > uint256(MAX_SHARES) * 2) revert ShareCapExceeded();
        Pos storage p = positions[companyId][kind][trader];
        uint256 next = uint256(longSide ? p.sharesL : p.sharesS) + shares;
        if (next > uint256(MAX_SHARES) * 2) revert ShareCapExceeded();
        if (next > type(uint128).max) revert PositionOverflow();
        if (longSide) p.sharesL = uint128(next); else p.sharesS = uint128(next);
    }

    function _debitShares(uint256 companyId, uint8 kind, address trader, bool longSide, uint256 shares) internal {
        if (shares == 0) revert InvalidAmount(); Pos storage p = positions[companyId][kind][trader]; uint128 held = longSide ? p.sharesL : p.sharesS;
        if (shares > held) revert InsufficientShares(); if (longSide) p.sharesL = held - uint128(shares); else p.sharesS = held - uint128(shares);
    }

    function _addPaidIn(uint256 companyId, uint8 kind, address trader, uint256 amount) internal {
        Pos storage p = positions[companyId][kind][trader]; uint256 next = uint256(p.paidIn) + amount; if (next > type(uint128).max) revert PositionOverflow(); p.paidIn = uint128(next);
    }
    function _addEscrow(uint256 companyId, uint8 kind, address trader, uint256 amount) internal {
        Pos storage p = positions[companyId][kind][trader]; uint256 next = uint256(p.escrow) + amount; if (next > type(uint128).max) revert PositionOverflow(); p.escrow = uint128(next);
    }
    function _requireComplement(uint256 a, uint256 b) internal pure { if ((a ^ 1) != b) revert InvalidTokenId(); }
    function _requireOpen(uint256 companyId) internal view { if (block.timestamp >= companies[companyId].horizon) revert TradingClosed(); }
    function _market(uint256 companyId, MarketKind kind) internal view returns (Market storage market) { _requireCompany(companyId); market = markets_[companyId][uint8(kind)]; }
    function _marketLoss(Market storage market) internal view returns (uint256) { return LMSR.worstCaseLoss(market.qL, market.qS, int256(uint256(market.b))); }
    function _price(Market storage market) internal view returns (uint256) { return LMSR.priceL(market.qL, market.qS, int256(uint256(market.b))); }
    function _marketPriceById(uint256 marketId) internal view returns (uint256) { return _price(markets_[marketId / 3][uint8(marketId % 3)]); }
    function _quoteBuy(Market storage market, bool longSide, uint256 shares) internal view returns (uint256) { int256 raw = LMSR.buyCost(market.qL, market.qS, int256(uint256(market.b)), int256(shares), longSide); return (raw > 0 ? uint256(raw) : 0) + DUST; }
    function _quoteSell(Market storage market, bool longSide, uint256 shares) internal view returns (uint256) { int256 raw = LMSR.buyCost(market.qL, market.qS, int256(uint256(market.b)), -int256(shares), longSide); uint256 gross = raw < 0 ? uint256(-raw) : 0; return gross > DUST ? gross - DUST : 0; }
    function _shareDelta(uint256 shares) internal pure returns (int256) { if (shares == 0) revert InvalidAmount(); if (shares > uint256(MAX_SHARES) * 2) revert ShareCapExceeded(); return int256(shares); }
    function _checkedQ(Market storage market, bool longSide, int256 delta) internal view returns (int256 newQ) { newQ = (longSide ? int256(market.qL) : int256(market.qS)) + delta; if (newQ < -MAX_SHARES || newQ > MAX_SHARES) revert ShareCapExceeded(); }
    function _entitlement(Company storage company, uint8 kind, Pos storage p) internal view returns (uint256) { bool valid = kind == 2 || (kind == 0 && company.fired) || (kind == 1 && !company.fired); if (!valid) return p.paidIn; uint256 weight = kind == 2 ? (company.fired ? WAD : 0) : _weight(company); return uint256(p.escrow) + uint256(p.sharesL) * weight / WAD + uint256(p.sharesS) * (WAD - weight) / WAD; }
    function _weight(Company storage company) internal view returns (uint256) { if (company.settledPriceCents <= company.floorCents) return 0; if (company.settledPriceCents >= company.capCents) return WAD; return uint256(company.settledPriceCents - company.floorCents) * WAD / uint256(company.capCents - company.floorCents); }
    function _requireCompany(uint256 companyId) internal view { if (companyId >= companies.length) revert InvalidCompany(); }
    function _requireMarketId(uint256 marketId) internal view { if (marketId >= companies.length * 3) revert InvalidCompany(); }
}

/// @notice Permissionless Polymarket-V1-shaped signed-order settlement module.
contract FireTheCEOExchangeV2 is Ownable {
    enum Side { BUY, SELL }
    enum SignatureType { EOA, UNUSED_PROXY, UNUSED_SAFE, EIP1271 }
    struct Order {
        uint256 salt; address maker; address signer; address taker; uint256 tokenId;
        uint256 makerAmount; uint256 takerAmount; uint256 expiration; uint256 nonce;
        uint256 feeRateBps; Side side; SignatureType signatureType; bytes signature;
    }
    struct OrderStatus { bool isFilledOrCancelled; uint256 remaining; }

    bytes32 public constant ORDER_TYPEHASH = keccak256("Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)");
    bytes32 public constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant NAME_HASH = keccak256("FireTheCEO Exchange");
    bytes32 public constant VERSION_HASH = keccak256("1");
    uint256 public constant MAX_FEE_RATE_BPS = 10_000;
    bytes4 internal constant EIP1271_MAGICVALUE = 0x1626ba7e;

    FireTheCEOv2 public immutable core;
    bytes32 public immutable domainSeparator;
    mapping(bytes32 => OrderStatus) public orderStatus;
    mapping(address => uint256) public nonces;
    bool public paused;
    uint256 private locked = 1;

    error Paused(); error Reentrant(); error InvalidOrder(); error InvalidSignature(); error InvalidSignatureType();
    error OrderExpired(); error OrderFilledOrCancelled(); error InvalidNonce(); error NotTaker(); error NotMaker();
    error FeeTooHigh(); error FillTooLarge(); error LengthMismatch(); error NotCrossing(); error MismatchedTokenIds(); error BlendedLimit();

    event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 tokenId, uint8 side, uint256 makingAmount, uint256 takingAmount, uint256 fee);
    event OrdersMatched(bytes32 indexed takerOrderHash, address indexed takerMaker, uint256 makingAmount, uint256 takingAmount);
    event OrderCancelled(bytes32 indexed orderHash);
    event NonceIncremented(address indexed maker, uint256 newNonce);
    event TradingPaused(bool paused);

    constructor(address core_) {
        if (core_ == address(0)) revert InvalidOrder(); core = FireTheCEOv2(core_); _initializeOwner(msg.sender);
        domainSeparator = keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    modifier nonReentrant() { if (locked != 1) revert Reentrant(); locked = 2; _; locked = 1; }
    modifier notPaused() { if (paused) revert Paused(); _; }

    function setPaused(bool paused_) external onlyOwner { paused = paused_; emit TradingPaused(paused_); }
    function incrementNonce() external { unchecked { ++nonces[msg.sender]; } emit NonceIncremented(msg.sender, nonces[msg.sender]); }
    function getOrderStatus(bytes32 orderHash) external view returns (OrderStatus memory) { return orderStatus[orderHash]; }

    function hashOrder(Order calldata order) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(ORDER_TYPEHASH, order.salt, order.maker, order.signer, order.taker, order.tokenId, order.makerAmount, order.takerAmount, order.expiration, order.nonce, order.feeRateBps, order.side, order.signatureType));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function validateOrder(Order calldata order) external view { _validate(hashOrder(order), order, address(0), false); }

    function cancelOrder(Order calldata order) external {
        if (msg.sender != order.maker) revert NotMaker(); bytes32 h = hashOrder(order); OrderStatus storage status = orderStatus[h];
        if (status.isFilledOrCancelled) revert OrderFilledOrCancelled(); status.isFilledOrCancelled = true; emit OrderCancelled(h);
    }

    function fillOrder(Order calldata order, uint256 fillAmount) external nonReentrant notPaused {
        bytes32 h = _checkAndFill(order, fillAmount, msg.sender, true); uint256 taking = _taking(fillAmount, order.makerAmount, order.takerAmount);
        if (order.side == Side.BUY) core.exchangeComplementary(order.tokenId, order.maker, msg.sender, taking, fillAmount);
        else core.exchangeComplementary(order.tokenId, msg.sender, order.maker, fillAmount, taking);
        emit OrderFilled(h, order.maker, msg.sender, order.tokenId, uint8(order.side), fillAmount, taking, 0);
    }

    function matchOrders(Order calldata takerOrder, Order[] calldata makerOrders, uint256 takerFillAmount, uint256[] calldata makerFillAmounts) external nonReentrant notPaused {
        _matchOrders(takerOrder, makerOrders, takerFillAmount, makerFillAmounts, false, 0);
    }

    function fillWithAmm(Order calldata takerOrder, Order[] calldata makerOrders, uint256 takerFillAmount, uint256[] calldata makerFillAmounts, uint256 ammMaxShares) external nonReentrant notPaused {
        _matchOrders(takerOrder, makerOrders, takerFillAmount, makerFillAmounts, true, ammMaxShares);
    }

    function _matchOrders(Order calldata takerOrder, Order[] calldata makers, uint256 takerFill, uint256[] calldata makerFills, bool withAmm, uint256 ammMaxShares) internal {
        if (makers.length != makerFills.length) revert LengthMismatch();
        bytes32 takerHash = _checkAndFill(takerOrder, takerFill, msg.sender, false);
        uint256 targetTaking = _taking(takerFill, takerOrder.makerAmount, takerOrder.takerAmount);
        uint256 actualMaking; uint256 actualTaking;
        for (uint256 i; i < makers.length; ++i) {
            Order calldata maker = makers[i]; uint256 fill = makerFills[i];
            bytes32 makerHash = _checkAndFill(maker, fill, msg.sender, false);
            (uint256 used, uint256 received) = _settlePair(takerOrder, maker, fill);
            actualMaking += used; actualTaking += received;
            emit OrderFilled(makerHash, maker.maker, takerOrder.maker, maker.tokenId, uint8(maker.side), fill, _taking(fill, maker.makerAmount, maker.takerAmount), 0);
        }
        if (withAmm) {
            if (takerOrder.side == Side.BUY) {
                if (actualTaking < targetTaking) {
                    uint256 shares = targetTaking - actualTaking; if (shares > ammMaxShares) revert BlendedLimit();
                    uint256 cost = core.exchangeAmmBuy(takerOrder.maker, takerOrder.tokenId, shares, takerFill - actualMaking);
                    actualMaking += cost; actualTaking += shares;
                }
            } else if (actualMaking < takerFill) {
                uint256 shares = takerFill - actualMaking; if (shares > ammMaxShares) revert BlendedLimit();
                uint256 proceeds = core.exchangeAmmSell(takerOrder.maker, takerOrder.tokenId, shares, 0);
                actualMaking += shares; actualTaking += proceeds;
            }
        }
        if (takerOrder.side == Side.BUY) {
            if (actualTaking < targetTaking || actualMaking > takerFill) revert BlendedLimit();
        } else if (actualMaking > takerFill || actualTaking < targetTaking) revert BlendedLimit();
        emit OrderFilled(takerHash, takerOrder.maker, address(this), takerOrder.tokenId, uint8(takerOrder.side), takerFill, actualTaking, 0);
        emit OrdersMatched(takerHash, takerOrder.maker, actualMaking, actualTaking);
    }

    function _settlePair(Order calldata taker, Order calldata maker, uint256 makerFill) internal returns (uint256 activeUsed, uint256 activeReceived) {
        uint256 makerTaking = _taking(makerFill, maker.makerAmount, maker.takerAmount);
        if (taker.side != maker.side) {
            if (taker.tokenId != maker.tokenId || !_crosses(taker, maker)) revert NotCrossing();
            if (taker.side == Side.BUY) {
                core.exchangeComplementary(taker.tokenId, taker.maker, maker.maker, makerFill, makerTaking);
                return (makerTaking, makerFill);
            }
            core.exchangeComplementary(taker.tokenId, maker.maker, taker.maker, makerTaking, makerFill);
            return (makerTaking, makerFill);
        }
        if ((taker.tokenId ^ 1) != maker.tokenId || !_crosses(taker, maker)) revert MismatchedTokenIds();
        if (taker.side == Side.BUY) {
            if (makerTaking < makerFill) revert NotCrossing();
            uint256 takerCost = makerTaking - makerFill;
            core.exchangeMint(taker.tokenId, taker.maker, maker.maker, makerTaking, takerCost, makerFill);
            return (takerCost, makerTaking);
        }
        uint256 pairs = makerFill; if (makerTaking > pairs) revert NotCrossing();
        core.exchangeMerge(taker.tokenId, taker.maker, maker.maker, pairs, pairs - makerTaking, makerTaking);
        return (pairs, pairs - makerTaking);
    }

    function _checkAndFill(Order calldata order, uint256 making, address caller, bool direct) internal returns (bytes32 h) {
        h = hashOrder(order); _validate(h, order, caller, direct); if (making == 0) revert InvalidOrder();
        OrderStatus storage status = orderStatus[h]; uint256 remaining = status.remaining == 0 ? order.makerAmount : status.remaining;
        if (making > remaining) revert FillTooLarge(); remaining -= making; status.remaining = remaining; if (remaining == 0) status.isFilledOrCancelled = true;
    }

    function _validate(bytes32 h, Order calldata order, address caller, bool direct) internal view {
        if (order.maker == address(0) || order.makerAmount == 0 || order.takerAmount == 0) revert InvalidOrder();
        if (order.expiration != 0 && order.expiration < block.timestamp) revert OrderExpired();
        if (order.nonce != nonces[order.maker]) revert InvalidNonce(); if (order.feeRateBps > MAX_FEE_RATE_BPS) revert FeeTooHigh();
        if (orderStatus[h].isFilledOrCancelled) revert OrderFilledOrCancelled();
        if (caller != address(0) && order.taker != address(0) && ((direct && order.taker != caller) || (!direct && order.taker != caller && order.taker != address(this)))) revert NotTaker();
        if (!core.isTokenOpen(order.tokenId)) revert FireTheCEOv2.TradingClosed();
        uint256 price = order.side == Side.BUY ? FixedPointMathLib.fullMulDiv(order.makerAmount, 1e18, order.takerAmount) : FixedPointMathLib.fullMulDiv(order.takerAmount, 1e18, order.makerAmount);
        if (price > 1e18) revert InvalidOrder(); _validateSignature(h, order);
    }

    function _validateSignature(bytes32 h, Order calldata order) internal view {
        if (order.signatureType == SignatureType.EOA) {
            if (order.maker != order.signer || order.signature.length != 65) revert InvalidSignature();
            bytes32 r; bytes32 s; uint8 v; bytes calldata sig = order.signature;
            assembly { r := calldataload(sig.offset) s := calldataload(add(sig.offset, 32)) v := byte(0, calldataload(add(sig.offset, 64))) }
            if (v < 27) v += 27; if (v != 27 && v != 28) revert InvalidSignature();
            if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0 || ecrecover(h, v, r, s) != order.signer) revert InvalidSignature();
        } else if (order.signatureType == SignatureType.EIP1271) {
            if (order.maker != order.signer || order.maker.code.length == 0) revert InvalidSignature();
            (bool ok, bytes memory result) = order.maker.staticcall(abi.encodeCall(IERC1271.isValidSignature, (h, order.signature)));
            if (!ok || result.length < 32 || abi.decode(result, (bytes4)) != EIP1271_MAGICVALUE) revert InvalidSignature();
        } else revert InvalidSignatureType();
    }

    function _taking(uint256 making, uint256 makerAmount, uint256 takerAmount) internal pure returns (uint256) {
        return FixedPointMathLib.fullMulDivUp(making, takerAmount, makerAmount);
    }

    function _crosses(Order calldata a, Order calldata b) internal pure returns (bool) {
        uint256 pa = a.side == Side.BUY ? FixedPointMathLib.fullMulDiv(a.makerAmount, 1e18, a.takerAmount) : FixedPointMathLib.fullMulDiv(a.takerAmount, 1e18, a.makerAmount);
        uint256 pb = b.side == Side.BUY ? FixedPointMathLib.fullMulDiv(b.makerAmount, 1e18, b.takerAmount) : FixedPointMathLib.fullMulDiv(b.takerAmount, 1e18, b.makerAmount);
        if (a.side == b.side) return a.side == Side.BUY ? pa + pb >= 1e18 : pa + pb <= 1e18;
        return a.side == Side.BUY ? pa >= pb : pb >= pa;
    }
}
