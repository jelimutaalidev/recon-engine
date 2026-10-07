// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IERC721.sol";
import "./IERC721Receiver.sol";

contract NFTVault is IERC721Receiver {
    IERC721 public collection;
    mapping(uint256 => address) public depositorOf;
    uint256 public heldCount;

    event Received(address indexed from, uint256 indexed tokenId);
    event Withdrawn(address indexed to, uint256 indexed tokenId);

    constructor(IERC721 _collection) {
        collection = _collection;
    }

    function onERC721Received(address, address from, uint256 tokenId, bytes calldata)
        external
        returns (bytes4)
    {
        depositorOf[tokenId] = from;
        heldCount += 1;
        emit Received(from, tokenId);
        return IERC721Receiver.onERC721Received.selector;
    }

    function withdraw(address to, uint256 tokenId) external {
        require(depositorOf[tokenId] == msg.sender, "not depositor");
        delete depositorOf[tokenId];
        heldCount -= 1;
        collection.transferFrom(address(this), to, tokenId);
        emit Withdrawn(to, tokenId);
    }
}
