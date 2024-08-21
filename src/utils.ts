import { BigInt } from '@graphprotocol/graph-ts'

import { SECONDS_PER_HOUR } from './constants'

export function getObservationId(address: string, hourTimestamp: BigInt): string {
  return address + '-' + hourTimestamp.toString()
}

export function getHourTimestamp(timestamp: BigInt): BigInt {
  return timestamp.div(BigInt.fromI32(SECONDS_PER_HOUR)).times(BigInt.fromI32(SECONDS_PER_HOUR))
}
