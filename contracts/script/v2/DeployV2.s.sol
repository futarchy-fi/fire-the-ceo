// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {FireTheCEOv2, FireTheCEOExchangeV2} from "../../src/v2/FireTheCEOv2.sol";
import {PlayUSD} from "../../src/PlayUSD.sol";

contract DeployV2 is Script {
    address internal constant DEFAULT_OPERATOR = 0x693E3FB46Bb36eE43C702FE94f9463df0691b43d;

    function run() external returns (PlayUSD pusd, FireTheCEOv2 core, FireTheCEOExchangeV2 exchange) {
        address operator = vm.envOr("OPERATOR", DEFAULT_OPERATOR);
        vm.startBroadcast();
        pusd = new PlayUSD();
        core = new FireTheCEOv2(address(pusd));
        exchange = new FireTheCEOExchangeV2(address(core));
        core.setExchange(address(exchange));
        pusd.mint(operator, 2_000_000e18);
        pusd.approve(address(core), type(uint256).max);
        vm.stopBroadcast();
        console2.log("PlayUSD", address(pusd));
        console2.log("FireTheCEOv2", address(core));
        console2.log("FireTheCEOExchangeV2", address(exchange));
    }
}
