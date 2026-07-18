// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {FireTheCEOv2} from "../../src/v2/FireTheCEOv2.sol";

contract ListCompaniesV2 is Script {
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
        FireTheCEOv2 core = FireTheCEOv2(vm.envAddress("FIRE_THE_CEO_V2"));
        string memory path = vm.envOr("LISTINGS_FILE", string("../data/listings.json"));
        Listing[] memory listings = abi.decode(vm.parseJson(vm.readFile(path)), (Listing[]));
        vm.startBroadcast();
        for (uint256 i; i < listings.length; ++i) {
            Listing memory listing = listings[i];
            if (_isListed(core, listing.ticker)) continue;
            core.listCompany(listing.ticker, listing.name, listing.ceo, listing.spotCents, HORIZON, SETTLE_TIME, B_SCALAR, B_EXIT, listing.initExitProbWad);
        }
        vm.stopBroadcast();
    }

    function _isListed(FireTheCEOv2 core, string memory ticker) internal view returns (bool) {
        uint256 count = core.companyCount(); bytes32 tickerHash = keccak256(bytes(ticker));
        for (uint256 i; i < count; ++i) if (keccak256(bytes(core.getCompany(i).ticker)) == tickerHash) return true;
        return false;
    }
}
