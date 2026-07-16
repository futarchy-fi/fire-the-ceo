// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {FireTheCEO} from "../src/FireTheCEO.sol";

contract Resolve is Script {
    function run() external {
        FireTheCEO exchange = FireTheCEO(vm.envAddress("FIRE_THE_CEO"));
        uint256 companyId = vm.envUint("COMPANY_ID");
        bool fired = vm.envBool("FIRED");
        uint32 priceCents = uint32(vm.envUint("PRICE_CENTS"));
        string memory sourceURI = vm.envString("SOURCE_URI");

        vm.startBroadcast();
        exchange.resolveCompany(companyId, fired, priceCents, sourceURI);
        vm.stopBroadcast();
    }
}
