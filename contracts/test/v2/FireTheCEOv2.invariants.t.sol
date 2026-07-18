// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {FireTheCEOv2, FireTheCEOExchangeV2} from "../../src/v2/FireTheCEOv2.sol";
import {PlayUSD} from "../../src/PlayUSD.sol";

contract FireTheCEOv2Handler is Test {
    FireTheCEOv2 internal immutable core;
    FireTheCEOExchangeV2 internal immutable exchange;
    PlayUSD internal immutable pusd;
    uint256[4] internal keys;
    address[4] internal actors;
    uint256 internal salt;

    constructor(FireTheCEOv2 core_, FireTheCEOExchangeV2 exchange_, PlayUSD pusd_, uint256[4] memory keys_) {
        core = core_; exchange = exchange_; pusd = pusd_; keys = keys_;
        for (uint256 i; i < 4; ++i) actors[i] = vm.addr(keys_[i]);
    }

    function ammBuy(uint256 actorSeed, uint256 companySeed, uint256 kindSeed, bool longSide, uint256 sharesSeed) external {
        address actor = actors[actorSeed % 4]; uint256 companyId = companySeed % 2;
        FireTheCEOv2.MarketKind kind = FireTheCEOv2.MarketKind(kindSeed % 3);
        uint256 shares = bound(sharesSeed, 1e9, 100e18); uint256 quote = core.quoteBuy(companyId, kind, longSide, shares);
        if (pusd.balanceOf(actor) < quote) return; vm.prank(actor); core.buy(companyId, kind, longSide, shares, quote);
    }

    function ammSell(uint256 actorSeed, uint256 companySeed, uint256 kindSeed, bool longSide, uint256 sharesSeed) external {
        address actor = actors[actorSeed % 4]; uint256 companyId = companySeed % 2; uint8 kind = uint8(kindSeed % 3);
        (uint128 sharesL, uint128 sharesS,,) = core.positions(companyId, kind, actor); uint256 held = longSide ? sharesL : sharesS;
        if (held == 0) return; uint256 shares = bound(sharesSeed, 1, held);
        uint256 quote = core.quoteSell(companyId, FireTheCEOv2.MarketKind(kind), longSide, shares);
        vm.prank(actor); core.sell(companyId, FireTheCEOv2.MarketKind(kind), longSide, shares, quote);
    }

    function signedBuyFill(uint256 seed, uint256 companySeed, uint256 kindSeed, bool longSide, uint256 sharesSeed) external {
        uint256 sellerIndex = seed % 4; uint256 buyerIndex = (sellerIndex + 1) % 4; uint256 companyId = companySeed % 2; uint8 kind = uint8(kindSeed % 3);
        (uint128 sharesL, uint128 sharesS,,) = core.positions(companyId, kind, actors[sellerIndex]); uint256 held = longSide ? sharesL : sharesS;
        if (held < 2) return; uint256 shares = bound(sharesSeed, 2, held); uint256 cost = shares / 2; if (cost == 0) return;
        FireTheCEOExchangeV2.Order memory order = _order(keys[buyerIndex], companyId * 6 + kind * 2 + (longSide ? 0 : 1), FireTheCEOExchangeV2.Side.BUY, cost, shares);
        vm.prank(actors[sellerIndex]); exchange.fillOrder(order, cost);
    }

    function signedSellFill(uint256 seed, uint256 companySeed, uint256 kindSeed, bool longSide, uint256 sharesSeed) external {
        uint256 sellerIndex = seed % 4; uint256 buyerIndex = (sellerIndex + 1) % 4; uint256 companyId = companySeed % 2; uint8 kind = uint8(kindSeed % 3);
        (uint128 sharesL, uint128 sharesS,,) = core.positions(companyId, kind, actors[sellerIndex]); uint256 held = longSide ? sharesL : sharesS;
        if (held < 2) return; uint256 shares = bound(sharesSeed, 2, held); uint256 proceeds = shares / 2;
        FireTheCEOExchangeV2.Order memory order = _order(keys[sellerIndex], companyId * 6 + kind * 2 + (longSide ? 0 : 1), FireTheCEOExchangeV2.Side.SELL, shares, proceeds);
        vm.prank(actors[buyerIndex]); exchange.fillOrder(order, shares);
    }

    function signedMint(uint256 seed, uint256 companySeed, uint256 kindSeed, uint256 sharesSeed) external {
        uint256 a = seed % 4; uint256 b = (a + 1) % 4; uint256 companyId = companySeed % 2; uint8 kind = uint8(kindSeed % 3);
        uint256 shares = bound(sharesSeed, 2e9, 20e18); uint256 costB = shares * 40 / 100; uint256 costA = shares - costB;
        FireTheCEOExchangeV2.Order memory active = _order(keys[a], companyId * 6 + kind * 2, FireTheCEOExchangeV2.Side.BUY, costA, shares);
        FireTheCEOExchangeV2.Order memory passive = _order(keys[b], companyId * 6 + kind * 2 + 1, FireTheCEOExchangeV2.Side.BUY, costB, shares);
        FireTheCEOExchangeV2.Order[] memory makers = new FireTheCEOExchangeV2.Order[](1); makers[0] = passive;
        uint256[] memory fills = new uint256[](1); fills[0] = costB;
        exchange.matchOrders(active, makers, costA, fills);
    }

    function _order(uint256 pk, uint256 tokenId, FireTheCEOExchangeV2.Side side, uint256 making, uint256 taking) internal returns (FireTheCEOExchangeV2.Order memory order) {
        address maker = vm.addr(pk); order = FireTheCEOExchangeV2.Order({
            salt: ++salt, maker: maker, signer: maker, taker: address(0), tokenId: tokenId,
            makerAmount: making, takerAmount: taking, expiration: 0, nonce: exchange.nonces(maker), feeRateBps: 0,
            side: side, signatureType: FireTheCEOExchangeV2.SignatureType.EOA, signature: ""
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, exchange.hashOrder(order)); order.signature = abi.encodePacked(r, s, v);
    }
}

contract FireTheCEOv2InvariantTest is StdInvariant, Test {
    uint256 internal constant WAD = 1e18;
    PlayUSD internal pusd; FireTheCEOv2 internal core; FireTheCEOExchangeV2 internal exchange; FireTheCEOv2Handler internal handler;
    uint256[4] internal keys = [uint256(0x101), uint256(0x202), uint256(0x303), uint256(0x404)];
    address[4] internal actors;

    function setUp() public {
        vm.warp(10 days); pusd = new PlayUSD(); core = new FireTheCEOv2(address(pusd)); exchange = new FireTheCEOExchangeV2(address(core)); core.setExchange(address(exchange));
        pusd.mint(address(this), 1_000_000e18); pusd.approve(address(core), type(uint256).max);
        core.listCompany("LOW", "Low", "CEO", 40_000, type(uint64).max - 1, type(uint64).max, 1_000e18, 400e18, 0.05e18);
        core.listCompany("HIGH", "High", "CEO", 20_000, type(uint64).max - 1, type(uint64).max, 1_000e18, 400e18, 0.95e18);
        for (uint256 i; i < 4; ++i) { actors[i] = vm.addr(keys[i]); pusd.mint(actors[i], 50_000e18); vm.prank(actors[i]); pusd.approve(address(core), type(uint256).max); }
        handler = new FireTheCEOv2Handler(core, exchange, pusd, keys); targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](5); selectors[0] = handler.ammBuy.selector; selectors[1] = handler.ammSell.selector;
        selectors[2] = handler.signedBuyFill.selector; selectors[3] = handler.signedSellFill.selector; selectors[4] = handler.signedMint.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
    }

    function invariant_SolventForEveryResolutionScenarioAfterSignedAndAmmFills() public view {
        uint256 balance = pusd.balanceOf(address(core));
        for (uint256 firedRaw; firedRaw < 2; ++firedRaw) for (uint256 priceCase; priceCase < 5; ++priceCase) {
            uint256 total;
            for (uint256 companyId; companyId < 2; ++companyId) {
                FireTheCEOv2.Company memory company = core.getCompany(companyId); uint32 price = _scenarioPrice(company, priceCase);
                for (uint8 kind; kind < 3; ++kind) for (uint256 actorIndex; actorIndex < 4; ++actorIndex) {
                    (uint128 l, uint128 s, uint128 paidIn, uint128 escrow) = core.positions(companyId, kind, actors[actorIndex]);
                    bool fired = firedRaw == 1; bool valid = kind == 2 || (kind == 0 && fired) || (kind == 1 && !fired);
                    if (!valid) total += paidIn;
                    else { uint256 weight = kind == 2 ? (fired ? WAD : 0) : _weight(company, price); total += escrow + uint256(l) * weight / WAD + uint256(s) * (WAD - weight) / WAD; }
                }
            }
            assertLe(total, balance, "resolution scenario insolvent");
        }
    }

    function invariant_EscrowNeverExceedsPaidInAcrossEachMarket() public view {
        for (uint256 companyId; companyId < 2; ++companyId) for (uint8 kind; kind < 3; ++kind) {
            uint256 paid; uint256 escrow;
            for (uint256 i; i < 4; ++i) { (,,uint128 p,uint128 e) = core.positions(companyId, kind, actors[i]); paid += p; escrow += e; }
            assertGe(paid, escrow, "escrow exceeds paid-in");
        }
    }

    function _scenarioPrice(FireTheCEOv2.Company memory c, uint256 priceCase) internal pure returns (uint32) {
        if (priceCase == 0) return 0; if (priceCase == 1) return c.floorCents; if (priceCase == 2) return c.spotCents; if (priceCase == 3) return c.capCents; return c.capCents * 2;
    }
    function _weight(FireTheCEOv2.Company memory c, uint32 price) internal pure returns (uint256) {
        if (price <= c.floorCents) return 0; if (price >= c.capCents) return WAD; return uint256(price - c.floorCents) * WAD / (c.capCents - c.floorCents);
    }
}
