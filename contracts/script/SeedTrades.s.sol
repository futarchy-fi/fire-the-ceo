// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {FireTheCEO} from "../src/FireTheCEO.sol";
import {PlayUSD} from "../src/PlayUSD.sol";

contract SeedTrades is Script {
    // vm.parseJson ABI-encodes object keys alphabetically.
    struct SeedTrade {
        uint8 kind;
        bool longSide;
        uint256 shares;
        string ticker;
    }

    function run() external {
        FireTheCEO exchange = FireTheCEO(vm.envAddress("FIRE_THE_CEO"));
        PlayUSD pusd = PlayUSD(vm.envAddress("PUSD"));
        string memory path = vm.envOr("SEED_TRADES_FILE", string("../data/seed-trades.json"));
        SeedTrade[] memory trades = abi.decode(vm.parseJson(vm.readFile(path)), (SeedTrade[]));

        vm.startBroadcast();
        try pusd.faucet() {} catch {}
        pusd.approve(address(exchange), type(uint256).max);
        for (uint256 i; i < trades.length; ++i) {
            SeedTrade memory seed = trades[i];
            require(seed.kind <= uint8(FireTheCEO.MarketKind.Exit), "invalid market kind");
            uint256 companyId = _findCompany(exchange, seed.ticker);
            FireTheCEO.MarketKind kind = FireTheCEO.MarketKind(seed.kind);
            uint256 quote = exchange.quoteBuy(companyId, kind, seed.longSide, seed.shares);
            exchange.buy(companyId, kind, seed.longSide, seed.shares, quote);
        }
        vm.stopBroadcast();
    }

    function _findCompany(FireTheCEO exchange, string memory ticker) internal view returns (uint256) {
        uint256 count = exchange.companyCount();
        bytes32 tickerHash = keccak256(bytes(ticker));
        for (uint256 i; i < count; ++i) {
            if (keccak256(bytes(exchange.getCompany(i).ticker)) == tickerHash) return i;
        }
        revert("ticker not listed");
    }
}
