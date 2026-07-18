// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract HashOrderReference {
    struct Order {
        uint256 salt;
        address maker;
        address signer;
        address taker;
        uint256 tokenId;
        uint256 makerAmount;
        uint256 takerAmount;
        uint256 expiration;
        uint256 nonce;
        uint256 feeRateBps;
        uint8 side;
        uint8 signatureType;
    }

    bytes32 internal constant ORDER_TYPEHASH = keccak256(
        "Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function hashOrder(Order calldata order, string calldata name, uint256 chainId, address verifyingContract)
        external
        pure
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                order.salt,
                order.maker,
                order.signer,
                order.taker,
                order.tokenId,
                order.makerAmount,
                order.takerAmount,
                order.expiration,
                order.nonce,
                order.feeRateBps,
                order.side,
                order.signatureType
            )
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes("1")), chainId, verifyingContract)
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }
}
