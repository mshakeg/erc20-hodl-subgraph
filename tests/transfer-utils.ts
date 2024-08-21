import { Address, BigInt, ethereum } from '@graphprotocol/graph-ts'
import { newMockEvent } from 'matchstick-as'

import { Transfer } from '../src/types/ERC20Token/ERC20'

export function createTransferEvent(from: Address, to: Address, value: BigInt, timestamp: BigInt): Transfer {
  const transferEvent = changetype<Transfer>(newMockEvent())

  transferEvent.parameters = []
  transferEvent.parameters.push(new ethereum.EventParam('from', ethereum.Value.fromAddress(from)))
  transferEvent.parameters.push(new ethereum.EventParam('to', ethereum.Value.fromAddress(to)))
  transferEvent.parameters.push(new ethereum.EventParam('value', ethereum.Value.fromUnsignedBigInt(value)))

  // Set the block timestamp
  transferEvent.block.timestamp = timestamp

  // Optionally, you can also set other block properties if needed for your tests
  // transferEvent.block.number = timestamp.div(BigInt.fromI32(15)) // Assuming 15 seconds per block

  return transferEvent
}
