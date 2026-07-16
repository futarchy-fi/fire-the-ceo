// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {FireTheCEO} from "../src/FireTheCEO.sol";
import {PlayUSD} from "../src/PlayUSD.sol";

contract FireTheCEOHandler is Test {
    FireTheCEO internal immutable exchange;
    PlayUSD internal immutable pusd;
    address[6] internal actors;

    constructor(FireTheCEO exchange_, PlayUSD pusd_, address[6] memory actors_) {
        exchange = exchange_;
        pusd = pusd_;
        actors = actors_;
    }

    function faucet(uint256 actorSeed) external {
        address actor = actors[actorSeed % actors.length];
        vm.prank(actor);
        try pusd.faucet() {} catch {}
    }

    function buy(uint256 actorSeed, uint256 companySeed, uint256 kindSeed, bool longSide, uint256 sharesSeed) external {
        address actor = actors[actorSeed % actors.length];
        uint256 companyId = companySeed % 3;
        FireTheCEO.MarketKind kind = FireTheCEO.MarketKind(kindSeed % 3);
        uint256 shares = bound(sharesSeed, 1e9, 250e18);
        uint256 quote = exchange.quoteBuy(companyId, kind, longSide, shares);
        if (pusd.balanceOf(actor) < quote) return;

        vm.prank(actor);
        exchange.buy(companyId, kind, longSide, shares, quote);
    }

    function sell(uint256 actorSeed, uint256 companySeed, uint256 kindSeed, bool longSide, uint256 sharesSeed)
        external
    {
        address actor = actors[actorSeed % actors.length];
        uint256 companyId = companySeed % 3;
        uint8 kind = uint8(kindSeed % 3);
        (uint128 sharesL, uint128 sharesS,,) = exchange.positions(companyId, kind, actor);
        uint256 held = longSide ? sharesL : sharesS;
        if (held == 0) return;
        uint256 shares = bound(sharesSeed, 1, held);
        uint256 quote = exchange.quoteSell(companyId, FireTheCEO.MarketKind(kind), longSide, shares);

        vm.prank(actor);
        exchange.sell(companyId, FireTheCEO.MarketKind(kind), longSide, shares, quote);
    }
}

contract FireTheCEOInvariantTest is StdInvariant, Test {
    uint256 internal constant WAD = 1e18;

    PlayUSD internal pusd;
    FireTheCEO internal exchange;
    FireTheCEOHandler internal handler;
    address[6] internal actors;

    function setUp() public {
        pusd = new PlayUSD();
        exchange = new FireTheCEO(address(pusd));
        pusd.mint(address(this), 1_000_000e18);
        pusd.approve(address(exchange), type(uint256).max);

        uint64 horizon = type(uint64).max - 1;
        uint64 settleTime = type(uint64).max;
        exchange.listCompany("LOW", "Low Prior", "CEO 1", 40_000, horizon, settleTime, 1_000e18, 400e18, 0.05e18);
        exchange.listCompany("HIGH", "High Prior", "CEO 2", 20_000, horizon, settleTime, 1_000e18, 400e18, 0.95e18);
        exchange.listCompany("BASE", "Base Prior", "CEO 3", 10_000, horizon, settleTime, 1_000e18, 400e18, 0.04e18);

        for (uint256 i; i < actors.length; ++i) {
            actors[i] = makeAddr(string.concat("actor-", vm.toString(i)));
            pusd.mint(actors[i], 20_000e18);
            vm.prank(actors[i]);
            pusd.approve(address(exchange), type(uint256).max);
        }

        handler = new FireTheCEOHandler(exchange, pusd, actors);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = handler.faucet.selector;
        selectors[1] = handler.buy.selector;
        selectors[2] = handler.sell.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariant_SolventForEveryResolutionScenario() public view {
        uint256 balance = pusd.balanceOf(address(exchange));
        FireTheCEO.Company[3] memory companySnapshots;
        FireTheCEO.Pos[6][3][3] memory positionSnapshots;
        for (uint256 companyId; companyId < 3; ++companyId) {
            companySnapshots[companyId] = exchange.getCompany(companyId);
            for (uint8 kind; kind < 3; ++kind) {
                for (uint256 actorIndex; actorIndex < actors.length; ++actorIndex) {
                    (uint128 sharesL, uint128 sharesS, uint128 paidIn, uint128 escrow) =
                        exchange.positions(companyId, kind, actors[actorIndex]);
                    positionSnapshots[companyId][kind][actorIndex] =
                        FireTheCEO.Pos({sharesL: sharesL, sharesS: sharesS, paidIn: paidIn, escrow: escrow});
                }
            }
        }

        for (uint256 firedRaw; firedRaw < 2; ++firedRaw) {
            for (uint256 priceCase; priceCase < 5; ++priceCase) {
                uint256 sameScenarioTotal;
                for (uint256 companyId; companyId < 3; ++companyId) {
                    FireTheCEO.Company memory company = companySnapshots[companyId];
                    uint32 price = _scenarioPrice(company, priceCase);
                    sameScenarioTotal += _companyEntitlement(
                        companyId, company, positionSnapshots, firedRaw == 1, price
                    );
                }
                assertLe(sameScenarioTotal, balance, "same resolution scenario insolvent");
            }
        }

        uint256 independentlyWorstTotal;
        for (uint256 companyId; companyId < 3; ++companyId) {
            FireTheCEO.Company memory company = companySnapshots[companyId];
            uint256 companyWorst;
            for (uint256 firedRaw; firedRaw < 2; ++firedRaw) {
                for (uint256 priceCase; priceCase < 5; ++priceCase) {
                    uint256 entitlement = _companyEntitlement(
                        companyId, company, positionSnapshots, firedRaw == 1, _scenarioPrice(company, priceCase)
                    );
                    if (entitlement > companyWorst) companyWorst = entitlement;
                }
            }
            independentlyWorstTotal += companyWorst;
        }
        assertLe(independentlyWorstTotal, balance, "independent company worst cases insolvent");
    }

    function invariant_PaidInCoversEscrowPerMarket() public view {
        for (uint256 companyId; companyId < 3; ++companyId) {
            for (uint8 kind; kind < 3; ++kind) {
                uint256 totalPaidIn;
                uint256 totalEscrow;
                for (uint256 actorIndex; actorIndex < actors.length; ++actorIndex) {
                    (,, uint128 paidIn, uint128 escrow) = exchange.positions(companyId, kind, actors[actorIndex]);
                    totalPaidIn += paidIn;
                    totalEscrow += escrow;
                }
                assertGe(totalPaidIn, totalEscrow, "market escrow exceeds paid-in cash");
            }
        }
    }

    function _companyEntitlement(
        uint256 companyId,
        FireTheCEO.Company memory company,
        FireTheCEO.Pos[6][3][3] memory positionSnapshots,
        bool fired,
        uint32 priceCents
    ) internal pure returns (uint256 total) {
        uint256 weight = _weight(company, priceCents);
        for (uint8 kind; kind < 3; ++kind) {
            bool valid = kind == uint8(FireTheCEO.MarketKind.Exit)
                || (kind == uint8(FireTheCEO.MarketKind.Out) && fired)
                || (kind == uint8(FireTheCEO.MarketKind.Stay) && !fired);
            uint256 marketWeight = kind == uint8(FireTheCEO.MarketKind.Exit) ? (fired ? WAD : 0) : weight;

            for (uint256 actorIndex; actorIndex < 6; ++actorIndex) {
                FireTheCEO.Pos memory position = positionSnapshots[companyId][kind][actorIndex];
                if (valid) {
                    total += uint256(position.escrow) + (uint256(position.sharesL) * marketWeight) / WAD
                    + (uint256(position.sharesS) * (WAD - marketWeight)) / WAD;
                } else {
                    total += position.paidIn;
                }
            }
        }
    }

    function _scenarioPrice(FireTheCEO.Company memory company, uint256 priceCase) internal pure returns (uint32) {
        if (priceCase == 0) return 0;
        if (priceCase == 1) return company.floorCents;
        if (priceCase == 2) return company.spotCents;
        if (priceCase == 3) return company.capCents;
        return company.capCents * 2;
    }

    function _weight(FireTheCEO.Company memory company, uint32 priceCents) internal pure returns (uint256) {
        if (priceCents <= company.floorCents) return 0;
        if (priceCents >= company.capCents) return WAD;
        return (uint256(priceCents - company.floorCents) * WAD) / (company.capCents - company.floorCents);
    }
}
