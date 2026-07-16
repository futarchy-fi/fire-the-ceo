// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {FireTheCEO} from "../src/FireTheCEO.sol";
import {PlayUSD} from "../src/PlayUSD.sol";

contract Deploy is Script {
    address internal constant DEFAULT_OPERATOR = 0x693E3FB46Bb36eE43C702FE94f9463df0691b43d;

    function run() external returns (PlayUSD pusd, FireTheCEO exchange) {
        address operator = vm.envOr("OPERATOR", DEFAULT_OPERATOR);

        vm.startBroadcast();
        pusd = new PlayUSD();
        exchange = new FireTheCEO(address(pusd));
        pusd.mint(operator, 2_000_000e18);
        pusd.approve(address(exchange), type(uint256).max);
        vm.stopBroadcast();

        console2.log("PlayUSD", address(pusd));
        console2.log("FireTheCEO", address(exchange));
    }
}
