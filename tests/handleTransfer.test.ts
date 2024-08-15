import { Address, BigDecimal, BigInt } from '@graphprotocol/graph-ts'
import { afterEach, assert, clearStore, describe, log, test } from 'matchstick-as/assembly/index'

import { SECONDS_PER_HOUR, ZERO_ADDRESS } from '../src/constants'
import { handleTransfer } from '../src/mapping'
import { HourObservation, User } from '../src/types/schema'
import { createTransferEvent } from './transfer-utils'

const ALICE_ADDRESS = '0x0000000000000000000000000000000000000001'
const BOB_ADDRESS = '0x0000000000000000000000000000000000000002'
const CAROL_ADDRESS = '0x0000000000000000000000000000000000000003'
// const DAVE_ADDRESS = '0x0000000000000000000000000000000000000004'

function getObservationId(address: string, hourTimestamp: BigInt): string {
  return address + '-' + hourTimestamp.toString()
}

function getHourTimestamp(timestamp: BigInt): BigInt {
  return timestamp.div(BigInt.fromI32(SECONDS_PER_HOUR)).times(BigInt.fromI32(SECONDS_PER_HOUR))
}

// Helper function to get cumulativeHODL value
function getCumulativeHODL(address: string, hourTimestamp: BigInt): BigInt {
  const hourObservation = HourObservation.load(getObservationId(address, hourTimestamp))
  if (hourObservation) {
    return hourObservation.cumulativeHODL
  }
  return BigInt.fromI32(0)
}

function interpolateCumulativeHODL(
  observation1: HourObservation,
  observation2: HourObservation,
  timestamp: BigInt,
): BigInt {
  const timeDelta = timestamp.minus(observation1.timestamp)
  const totalDelta = observation2.timestamp.minus(observation1.timestamp)
  const hodlDelta = observation2.cumulativeHODL.minus(observation1.cumulativeHODL)
  return observation1.cumulativeHODL.plus(hodlDelta.times(timeDelta).div(totalDelta))
}

function extrapolateCumulativeHODL(observation: HourObservation, latestBalance: BigInt, timestamp: BigInt): BigInt {
  const timeDelta = timestamp.minus(observation.timestamp)
  return observation.cumulativeHODL.plus(latestBalance.times(timeDelta))
}

// NOTE: while this helper function may need to iterate over the observations in reverse to find a surrounding observation
// this need not be the case for the equivalent function implement on the client that make GQL queries to the subgraph.
// As the client may instead specify in the GQL query for the 1st observation before and after:
// 1. with a timestamp <= a provided timestamp in descending order to find the timestamp below(if not exactly equal to)
// 2. with a timestamp >= a provided timestamp in ascending order to find the timestamp after(if not exactly equal to)
// This would make the previousHourTimestamp and nextHourTimestamp fields on the HourObservation entity unnessary in production
function getOrComputeCumulativeHODL(address: string, timestamp: BigInt): BigInt {
  const user = User.load(address)
  if (user == null) {
    return BigInt.fromI32(0)
  }

  const hourTimestamp = getHourTimestamp(timestamp)
  const observationId = getObservationId(address, hourTimestamp)
  const observation = HourObservation.load(observationId)

  if (observation != null) {
    if (observation.timestamp.equals(timestamp)) {
      // Exact match, return the stored cumulativeHODL
      return observation.cumulativeHODL
    }

    // Need to interpolate or extrapolate
    if (observation.nextHourTimestamp.gt(BigInt.fromI32(0))) {
      // Interpolate
      const nextObservationId = getObservationId(address, observation.nextHourTimestamp)
      const nextObservation = HourObservation.load(nextObservationId)
      if (nextObservation != null) {
        return interpolateCumulativeHODL(observation, nextObservation, timestamp)
      } else {
        throw new Error('Invariant: if nextHourTimestamp is defined then nextObservation must exist')
      }
    }

    // Extrapolate
    return extrapolateCumulativeHODL(observation, user.balance, timestamp)
  }

  // No observation found at the provided timestamp's hourTimestamp, find the closest previous observation
  let currentHourTimestamp = user.lastHourTimestamp

  while (currentHourTimestamp.gt(BigInt.fromI32(0))) {
    const currentObservationId = getObservationId(address, currentHourTimestamp)
    const currentObservation = HourObservation.load(currentObservationId)

    if (currentObservation == null) {
      throw new Error("Invariant: since we're iterating in reverse currentObservation must exist")
      // unless we reach the end of the list in which case we end up with currentHourTimestamp = 0
      // and obviously no observation exists at hour 0 i.e. 0th hour of January 1st, 1970 UTC
      // however we won't ever reach that case since the while conditional is: currentHourTimestamp.gt(BigInt.fromI32(0))
      // so it'll exit the while loop and return 0 for cumulativeHODL at the provided timestamp
    }

    if (currentObservation.timestamp.le(timestamp)) {
      if (currentObservation.nextHourTimestamp.gt(BigInt.fromI32(0))) {
        // We have found observations before and after the provided timestamp
        const nextObservationId = getObservationId(address, currentObservation.nextHourTimestamp)
        const nextObservation = HourObservation.load(nextObservationId)
        if (nextObservation != null) {
          return interpolateCumulativeHODL(currentObservation, nextObservation, timestamp)
        } else {
          throw new Error('Invariant: if nextHourTimestamp is defined then nextObservation must exist')
        }
      } else {
        // The provided timestamp is after the last observation, so we extrapolate
        return extrapolateCumulativeHODL(currentObservation, user.balance, timestamp)
      }
    }

    currentHourTimestamp = currentObservation.previousHourTimestamp
  }

  // No previous observation found, return 0
  return BigInt.fromI32(0)
}

function computeHODLerRatio(userAddress: string, startTimestamp: BigInt, endTimestamp: BigInt): BigDecimal {
  if (endTimestamp.le(startTimestamp)) {
    throw new Error('End timestamp must be greater than start timestamp')
  }

  const userStartCumulativeHODL = getOrComputeCumulativeHODL(userAddress, startTimestamp)
  const userEndCumulativeHODL = getOrComputeCumulativeHODL(userAddress, endTimestamp)
  const userHODLDelta = userEndCumulativeHODL.minus(userStartCumulativeHODL)

  const tokenStartCumulativeHODL = getOrComputeCumulativeHODL(ZERO_ADDRESS, startTimestamp)
  const tokenEndCumulativeHODL = getOrComputeCumulativeHODL(ZERO_ADDRESS, endTimestamp)
  const tokenHODLDelta = tokenEndCumulativeHODL.minus(tokenStartCumulativeHODL)

  if (tokenHODLDelta.equals(BigInt.fromI32(0))) {
    throw new Error('Total token HODL delta is zero, cannot compute ratio')
  }

  return userHODLDelta.toBigDecimal().div(tokenHODLDelta.toBigDecimal())
}

describe('Simple Transfer Tests', () => {
  afterEach(() => {
    clearStore()
  })

  test('should handle minting tokens', () => {
    const from = Address.fromString(ZERO_ADDRESS)
    const to = Address.fromString(ALICE_ADDRESS)
    const value = BigInt.fromI32(1000)
    const timestamp = BigInt.fromI32(1000)
    const hourTimestamp = getHourTimestamp(timestamp)

    const transferEvent = createTransferEvent(from, to, value, timestamp)
    handleTransfer(transferEvent)

    assert.fieldEquals('User', to.toHexString(), 'balance', '1000')
    assert.fieldEquals('User', ZERO_ADDRESS, 'balance', '1000')
    assert.fieldEquals('HourObservation', getObservationId(to.toHexString(), hourTimestamp), 'cumulativeHODL', '0')
    assert.fieldEquals('HourObservation', getObservationId(ZERO_ADDRESS, hourTimestamp), 'cumulativeHODL', '0')
  })

  test('should handle burning tokens', () => {
    const mintTimestamp = BigInt.fromI32(1000)
    const burnTimestamp = BigInt.fromI32(2000)
    const burnHourTimestamp = getHourTimestamp(burnTimestamp)

    // First, mint some tokens
    const mintEvent = createTransferEvent(
      Address.fromString(ZERO_ADDRESS),
      Address.fromString(ALICE_ADDRESS),
      BigInt.fromI32(2000),
      mintTimestamp,
    )
    handleTransfer(mintEvent)

    // Then burn some tokens
    const burnEvent = createTransferEvent(
      Address.fromString(ALICE_ADDRESS),
      Address.fromString(ZERO_ADDRESS),
      BigInt.fromI32(1000),
      burnTimestamp,
    )
    handleTransfer(burnEvent)

    assert.fieldEquals('User', ALICE_ADDRESS, 'balance', '1000')
    assert.fieldEquals('User', ZERO_ADDRESS, 'balance', '1000')
    assert.fieldEquals(
      'HourObservation',
      getObservationId(ALICE_ADDRESS, burnHourTimestamp),
      'cumulativeHODL',
      '2000000',
    )
    assert.fieldEquals(
      'HourObservation',
      getObservationId(ZERO_ADDRESS, burnHourTimestamp),
      'cumulativeHODL',
      '2000000',
    )
  })

  test('should handle regular transfer between users', () => {
    const mintTimestamp = BigInt.fromI32(1000)
    const transferTimestamp = BigInt.fromI32(2000)
    const transferHourTimestamp = getHourTimestamp(transferTimestamp)

    // First, mint some tokens to Alice
    const mintEvent = createTransferEvent(
      Address.fromString(ZERO_ADDRESS),
      Address.fromString(ALICE_ADDRESS),
      BigInt.fromI32(2000),
      mintTimestamp,
    )
    handleTransfer(mintEvent)

    // Then transfer from Alice to Bob
    const transferEvent = createTransferEvent(
      Address.fromString(ALICE_ADDRESS),
      Address.fromString(BOB_ADDRESS),
      BigInt.fromI32(500),
      transferTimestamp,
    )
    handleTransfer(transferEvent)

    assert.fieldEquals('User', ALICE_ADDRESS, 'balance', '1500')
    assert.fieldEquals('User', BOB_ADDRESS, 'balance', '500')
    assert.fieldEquals('User', ZERO_ADDRESS, 'balance', '2000')
    assert.fieldEquals(
      'HourObservation',
      getObservationId(ALICE_ADDRESS, transferHourTimestamp),
      'cumulativeHODL',
      '2000000',
    )
    assert.fieldEquals('HourObservation', getObservationId(BOB_ADDRESS, transferHourTimestamp), 'cumulativeHODL', '0')
    assert.fieldEquals(
      'HourObservation',
      getObservationId(ZERO_ADDRESS, transferHourTimestamp),
      'cumulativeHODL',
      '2000000',
    )
  })

  test('should handle multiple transfers within the same hour', () => {
    const baseTimestamp = BigInt.fromI32(3600) // Start at exactly 1 hour
    const hourTimestamp = getHourTimestamp(baseTimestamp)

    // Mint to Alice
    handleTransfer(
      createTransferEvent(
        Address.fromString(ZERO_ADDRESS),
        Address.fromString(ALICE_ADDRESS),
        BigInt.fromI32(1000),
        baseTimestamp,
      ),
    )

    // Transfer from Alice to Bob
    handleTransfer(
      createTransferEvent(
        Address.fromString(ALICE_ADDRESS),
        Address.fromString(BOB_ADDRESS),
        BigInt.fromI32(300),
        baseTimestamp.plus(BigInt.fromI32(1000)),
      ),
    )

    // Transfer from Bob to Carol
    handleTransfer(
      createTransferEvent(
        Address.fromString(BOB_ADDRESS),
        Address.fromString(CAROL_ADDRESS),
        BigInt.fromI32(100),
        baseTimestamp.plus(BigInt.fromI32(2000)),
      ),
    )

    // Calculate expected cumulativeHODL values
    const aliceCumulativeHODL = BigInt.fromI32(1000).times(BigInt.fromI32(1000)) // 1000 tokens * 1000 seconds
    const bobCumulativeHODL = BigInt.fromI32(300).times(BigInt.fromI32(1000)) // 300 tokens * 1000 seconds
    const carolCumulativeHODL = BigInt.fromI32(0) // Carol just received tokens, so cumulativeHODL is still 0

    // Correct calculation for totalCumulativeHODL
    const totalCumulativeHODL = BigInt.fromI32(0) // Initial mint: cumulativeHODL starts at 0
      .plus(BigInt.fromI32(1000).times(BigInt.fromI32(1000))) // After first transfer: 1000 tokens * 1000 seconds
      .plus(BigInt.fromI32(1000).times(BigInt.fromI32(1000))) // After second transfer: 1000 tokens * 1000 seconds

    const tokenCumulativeHODL = getCumulativeHODL(ZERO_ADDRESS, hourTimestamp)
    log.info('tokenCumulativeHODL: {}', [tokenCumulativeHODL.toString()])

    assert.fieldEquals('User', ALICE_ADDRESS, 'balance', '700')
    assert.fieldEquals('User', BOB_ADDRESS, 'balance', '200')
    assert.fieldEquals('User', CAROL_ADDRESS, 'balance', '100')
    assert.fieldEquals(
      'HourObservation',
      getObservationId(ALICE_ADDRESS, hourTimestamp),
      'cumulativeHODL',
      aliceCumulativeHODL.toString(),
    )
    assert.fieldEquals(
      'HourObservation',
      getObservationId(BOB_ADDRESS, hourTimestamp),
      'cumulativeHODL',
      bobCumulativeHODL.toString(),
    )
    assert.fieldEquals(
      'HourObservation',
      getObservationId(CAROL_ADDRESS, hourTimestamp),
      'cumulativeHODL',
      carolCumulativeHODL.toString(),
    )
    assert.fieldEquals(
      'HourObservation',
      getObservationId(ZERO_ADDRESS, hourTimestamp),
      'cumulativeHODL',
      totalCumulativeHODL.toString(),
    )
  })

  test('should handle transfers across different hours', () => {
    const baseTimestamp = BigInt.fromI32(SECONDS_PER_HOUR)
    const hourTimestamp1 = getHourTimestamp(baseTimestamp)
    const hourTimestamp2 = getHourTimestamp(baseTimestamp.plus(BigInt.fromI32(SECONDS_PER_HOUR)))

    // Mint to Alice in hour 1
    handleTransfer(
      createTransferEvent(
        Address.fromString(ZERO_ADDRESS),
        Address.fromString(ALICE_ADDRESS),
        BigInt.fromI32(1000),
        baseTimestamp,
      ),
    )

    // Transfer from Alice to Bob in hour 2
    handleTransfer(
      createTransferEvent(
        Address.fromString(ALICE_ADDRESS),
        Address.fromString(BOB_ADDRESS),
        BigInt.fromI32(300),
        baseTimestamp.plus(BigInt.fromI32(SECONDS_PER_HOUR)),
      ),
    )

    assert.fieldEquals('User', ALICE_ADDRESS, 'balance', '700')
    assert.fieldEquals('User', BOB_ADDRESS, 'balance', '300')
    assert.fieldEquals('HourObservation', getObservationId(ALICE_ADDRESS, hourTimestamp1), 'cumulativeHODL', '0')
    assert.fieldEquals('HourObservation', getObservationId(ALICE_ADDRESS, hourTimestamp2), 'cumulativeHODL', '3600000')
    assert.fieldEquals('HourObservation', getObservationId(BOB_ADDRESS, hourTimestamp2), 'cumulativeHODL', '0')
  })

  test('should handle zero value transfers', () => {
    const timestamp = BigInt.fromI32(1000)
    const hourTimestamp = getHourTimestamp(timestamp)

    // Mint to Alice
    handleTransfer(
      createTransferEvent(
        Address.fromString(ZERO_ADDRESS),
        Address.fromString(ALICE_ADDRESS),
        BigInt.fromI32(1000),
        timestamp,
      ),
    )

    // Zero value transfer from Alice to Bob
    handleTransfer(
      createTransferEvent(
        Address.fromString(ALICE_ADDRESS),
        Address.fromString(BOB_ADDRESS),
        BigInt.fromI32(0),
        timestamp.plus(BigInt.fromI32(1000)),
      ),
    )

    // Assert that balances remain unchanged
    assert.fieldEquals('User', ALICE_ADDRESS, 'balance', '1000')
    assert.fieldEquals('User', ZERO_ADDRESS, 'balance', '1000')

    assert.notInStore('User', BOB_ADDRESS) // since we early returned on the 0 transfer and did not create Bob

    // Assert that Alice's HourObservation was created for the initial mint
    assert.fieldEquals('HourObservation', getObservationId(ALICE_ADDRESS, hourTimestamp), 'cumulativeHODL', '0')

    // Assert that no HourObservation was created for Bob
    assert.notInStore('HourObservation', getObservationId(BOB_ADDRESS, hourTimestamp))

    // Assert that the token-wide HourObservation was created for the initial mint
    assert.fieldEquals('HourObservation', getObservationId(ZERO_ADDRESS, hourTimestamp), 'cumulativeHODL', '0')

    assert.notInStore(
      'HourObservation',
      getObservationId(BOB_ADDRESS, getHourTimestamp(timestamp.plus(BigInt.fromI32(1000)))),
    )
  })
})

// TODO: implement the test cases for the following describe block
describe('HODLer Ratio Calculations', () => {
  test('should calculate basic HODLer ratio for a single user', () => {
    // Implement test case
  })

  test('should calculate HODLer ratios for multiple users over the same period', () => {
    // Implement test case
  })

  test('should handle HODLer ratio calculation with zero transfers', () => {
    // Implement test case
  })

  test('should calculate HODLer ratio for a period exactly matching observation timestamps', () => {
    // Implement test case
  })

  test('should interpolate HODLer ratio between two observations', () => {
    // Implement test case
  })

  test('should extrapolate HODLer ratio after the last observation', () => {
    // Implement test case
  })

  test('should calculate HODLer ratio for a period before the first observation', () => {
    // Implement test case
  })

  test('should handle HODLer ratio calculation across multiple observations', () => {
    // Implement test case
  })

  test('should calculate HODLer ratio during periods of minting', () => {
    // Implement test case
  })

  test('should calculate HODLer ratio during periods of burning', () => {
    // Implement test case
  })

  test('should handle HODLer ratio calculation with frequent small transfers', () => {
    // Implement test case
  })

  test('should calculate HODLer ratio for long-term holders vs short-term traders', () => {
    // Implement test case
  })

  test('should handle HODLer ratio calculation for users who receive and transfer all tokens', () => {
    // Implement test case
  })

  test('should calculate HODLer ratio across a very long period', () => {
    // Implement test case
  })

  test('should handle precision for very small token amounts in HODLer ratio calculation', () => {
    // Implement test case
  })

  test('should calculate relative HODLer ratios between multiple users', () => {
    // Implement test case
  })

  test('should handle HODLer ratio calculation across complex transfer patterns', () => {
    // Implement test case
  })
})
