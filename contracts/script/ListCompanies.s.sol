// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {FireTheCEO} from "../src/FireTheCEO.sol";

contract ListCompanies is Script {
    uint64 internal constant HORIZON = 1_790_812_740;
    uint64 internal constant SETTLE_TIME = 1_793_394_000;
    uint128 internal constant B_SCALAR = 5_000e18;
    uint128 internal constant B_EXIT = 2_000e18;

    // vm.parseJson ABI-encodes object keys alphabetically.
    struct Listing {
        string ceo;
        uint256 initExitProbWad;
        string name;
        uint32 spotCents;
        string ticker;
    }

    function run() external {
        FireTheCEO exchange = FireTheCEO(vm.envAddress("FIRE_THE_CEO"));
        string memory path = vm.envOr("LISTINGS_FILE", string("../data/listings.json"));
        Listing[] memory listings = abi.decode(vm.parseJson(vm.readFile(path)), (Listing[]));

        vm.startBroadcast();
        for (uint256 i; i < listings.length; ++i) {
            Listing memory listing = listings[i];
            if (_isListed(exchange, listing.ticker)) continue;
            exchange.listCompany(
                listing.ticker,
                listing.name,
                listing.ceo,
                listing.spotCents,
                HORIZON,
                SETTLE_TIME,
                B_SCALAR,
                B_EXIT,
                listing.initExitProbWad
            );
        }
        vm.stopBroadcast();
    }

    function _isListed(FireTheCEO exchange, string memory ticker) internal view returns (bool) {
        uint256 count = exchange.companyCount();
        bytes32 tickerHash = keccak256(bytes(ticker));
        for (uint256 i; i < count; ++i) {
            if (keccak256(bytes(exchange.getCompany(i).ticker)) == tickerHash) return true;
        }
        return false;
    }
}
