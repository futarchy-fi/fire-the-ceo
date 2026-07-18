// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {FireTheCEOv2, FireTheCEOExchangeV2, IERC1271} from "../../src/v2/FireTheCEOv2.sol";
import {PlayUSD} from "../../src/PlayUSD.sol";

abstract contract V2TestBase is Test {
    PlayUSD internal pusd;
    FireTheCEOv2 internal core;
    FireTheCEOExchangeV2 internal exchange;
    uint64 internal horizon;
    uint64 internal settleTime;
    uint256 internal companyId;

    uint256 internal constant ALICE_PK = 0xA11CE;
    uint256 internal constant BOB_PK = 0xB0B;
    uint256 internal constant CAROL_PK = 0xCA401;
    address internal alice;
    address internal bob;
    address internal carol;

    function setUp() public virtual {
        vm.warp(10 days);
        pusd = new PlayUSD();
        core = new FireTheCEOv2(address(pusd));
        exchange = new FireTheCEOExchangeV2(address(core));
        core.setExchange(address(exchange));
        horizon = uint64(block.timestamp + 30 days);
        settleTime = uint64(block.timestamp + 60 days);
        pusd.mint(address(this), 10_000_000e18);
        pusd.approve(address(core), type(uint256).max);
        companyId = core.listCompany("ACME", "Acme Corp", "Ada Lovelace", 40_000, horizon, settleTime, 5_000e18, 2_000e18, 0.05e18);

        alice = vm.addr(ALICE_PK); bob = vm.addr(BOB_PK); carol = vm.addr(CAROL_PK);
        _fund(alice); _fund(bob); _fund(carol);
    }

    function _fund(address who) internal {
        pusd.mint(who, 1_000_000e18);
        vm.prank(who); pusd.approve(address(core), type(uint256).max);
    }

    function _buy(address who, FireTheCEOv2.MarketKind kind, bool longSide, uint256 shares) internal returns (uint256 cost) {
        cost = core.quoteBuy(companyId, kind, longSide, shares);
        vm.prank(who); core.buy(companyId, kind, longSide, shares, cost);
    }

    function _signedOrder(
        uint256 pk,
        uint256 tokenId,
        FireTheCEOExchangeV2.Side side,
        uint256 makerAmount,
        uint256 takerAmount
    ) internal returns (FireTheCEOExchangeV2.Order memory order) {
        address maker = vm.addr(pk);
        order = FireTheCEOExchangeV2.Order({
            salt: uint256(keccak256(abi.encode(pk, tokenId, side, makerAmount, takerAmount, block.timestamp))),
            maker: maker,
            signer: maker,
            taker: address(0),
            tokenId: tokenId,
            makerAmount: makerAmount,
            takerAmount: takerAmount,
            expiration: horizon - 1,
            nonce: exchange.nonces(maker),
            feeRateBps: 0,
            side: side,
            signatureType: FireTheCEOExchangeV2.SignatureType.EOA,
            signature: ""
        });
        bytes32 digest = exchange.hashOrder(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        order.signature = abi.encodePacked(r, s, v);
    }
}

contract AlwaysValid1271 is IERC1271 {
    PlayUSD internal immutable token;
    constructor(PlayUSD token_, FireTheCEOv2 core) { token = token_; token_.approve(address(core), type(uint256).max); }
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) { return 0x1626ba7e; }
}

contract Reentrant1271 is IERC1271 {
    PlayUSD internal immutable token;
    address internal immutable exchange;
    bytes internal payload;

    constructor(PlayUSD token_, FireTheCEOv2 core, FireTheCEOExchangeV2 exchange_) {
        token = token_; exchange = address(exchange_); token_.approve(address(core), type(uint256).max);
    }

    function setPayload(bytes calldata payload_) external { payload = payload_; }

    function isValidSignature(bytes32, bytes calldata) external view returns (bytes4) {
        (bool ok, bytes memory result) = exchange.staticcall(payload);
        if (ok || result.length < 4) return 0xffffffff;
        bytes4 selector; assembly { selector := mload(add(result, 32)) }
        return selector == FireTheCEOExchangeV2.Reentrant.selector ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
