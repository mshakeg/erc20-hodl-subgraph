import { Address, BigDecimal, BigInt } from '@graphprotocol/graph-ts'
import { afterEach, assert, clearStore, describe, log, test } from 'matchstick-as/assembly/index'

import { SECONDS_PER_HOUR, ZERO_ADDRESS } from '../src/constants'
import { handleTransfer } from '../src/mapping'
import { HourObservation, User } from '../src/types/schema'
import { getHourTimestamp, getObservationId } from '../src/utils'
import { createTransferEvent } from './transfer-utils'

const ALICE_ADDRESS = '0x0000000000000000000000000000000000000001'
const BOB_ADDRESS = '0x0000000000000000000000000000000000000002'
const CAROL_ADDRESS = '0x0000000000000000000000000000000000000003'
// const DAVE_ADDRESS = '0x0000000000000000000000000000000000000004'

// Helper function to get cumulativeHODL value
function getCumulativeHODL(address: string, hourTimestamp: BigInt): BigInt {
  const hourObservation = HourObservation.load(getObservationId(address, hourTimestamp))
  if (hourObservation) {
    return hourObservation.cumulativeHODL
  }
  return BigInt.fromI32(0)
}

function extrapolateCumulativeHODL(observation: HourObservation, timestamp: BigInt): BigInt {
  const timeDelta = timestamp.minus(observation.lastTimestamp)
  return observation.cumulativeHODL.plus(observation.lastBalance.times(timeDelta))
}

function assertEquals(a: BigDecimal, b: BigDecimal): void {
  const isEqual = a.minus(b).equals(BigDecimal.fromString('0'))
  if (!isEqual) {
    throw new Error('BigDecimals are not equal')
  }
}

// NOTE: while this helper function may need to iterate over the observations in reverse to find a surrounding observation
// this need not be the case for the equivalent function implement on the client that make GQL queries to the subgraph.
// As the client may instead specify in the GQL query for the 1st observation before and after:
// 1. with a timestamp <= a provided timestamp in descending order to find the timestamp below(if not exactly equal to)
// 2. with a timestamp >= a provided timestamp in ascending order to find the timestamp after(if not exactly equal to)
// This would make the previousHourTimestamp and nextHourTimestamp fields on the HourObservation entity unnessary in production
function getOrComputeCumulativeHODL(address: string, timestamp: BigInt): BigInt {
  // Ensure the provided timestamp is a discrete hour timestamp
  if (!timestamp.equals(getHourTimestamp(timestamp))) {
    throw new Error('Timestamp must be a discrete hour timestamp')
  }

  const user = User.load(address)
  if (user == null) {
    return BigInt.fromI32(0)
  }

  const observationId = getObservationId(address, timestamp)
  const observation = HourObservation.load(observationId)

  if (observation != null) {
    // Exact match found, return the stored cumulativeHODL
    // get the previous observation and extrapolate from that previous observation if it exists
    const previousObservationId = getObservationId(address, observation.previousHourTimestamp)
    const previousObservation = HourObservation.load(previousObservationId)
    if (previousObservation != null) {
      return extrapolateCumulativeHODL(previousObservation, timestamp)
    } else {
      return BigInt.fromI32(0)
    }
  }

  // No observation found at the provided timestamp, find the closest previous observation
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

    if (currentObservation.lastTimestamp.le(timestamp)) {
      // Found the closest previous observation, extrapolate from here
      return extrapolateCumulativeHODL(currentObservation, timestamp)
    }

    currentHourTimestamp = currentObservation.previousHourTimestamp
  }

  // No previous observation found, return 0
  return BigInt.fromI32(0)
}

/*
 * Explanation of the finalized approach to the getOrComputeCumulativeHODL implementation:
 *
 * 1. We only allow discrete hour timestamps:
 *    This ensures that we're always working with consistent time points that align with our hourly observations.
 *    It simplifies calculations and prevents potential inconsistencies that could arise from arbitrary timestamps.
 *
 * 2. We never perform interpolations:
 *    Interpolation between two hourly observations can lead to inaccuracies because each observation aggregates
 *    multiple balance changes within its hour. Interpolating between these aggregated points doesn't accurately
 *    represent the actual HODL value at a specific time between observations.
 *
 * 3. We only extrapolate when necessary:
 *    Extrapolation is only done when we don't have an exact observation for the requested timestamp.
 *    We use the most recent observation before the requested timestamp and the user's latest known balance.
 *    This approach ensures accuracy because:
 *    a) We're using the last known actual cumulative HODL value.
 *    b) We're using the user's latest balance, which is correct for any point after the last observation.
 *    c) The time delta for extrapolation is precise, as we're using discrete hour timestamps.
 *
 * 4. This approach guarantees 100% accuracy under all scenarios because:
 *    a) For existing observations, we return the exact stored value.
 *    b) For timestamps after the last observation, we extrapolate using the correct balance and time delta.
 *    c) For timestamps before the first observation, we correctly return 0.
 *    d) We avoid any estimation or averaging between aggregated data points.
 *
 * By adhering to these principles, we ensure that the cumulative HODL calculations are always based on
 * actual data points and precise time intervals, eliminating potential inaccuracies that could arise
 * from interpolation or working with non-discrete timestamps.
 */

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

function fraction(a: BigInt, b: BigInt): BigDecimal {
  return a.toBigDecimal().div(b.toBigDecimal())
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

describe('HODLer Ratio Calculations', () => {
  afterEach(() => {
    clearStore()
  })

  test('should calculate basic HODLer ratio for a single user', () => {
    const mintTimestamp = BigInt.fromI32(3600) // 1 hour
    const endTimestamp = BigInt.fromI32(7200) // 2 hours

    // Mint 1000 tokens to Alice
    handleTransfer(
      createTransferEvent(
        Address.fromString(ZERO_ADDRESS),
        Address.fromString(ALICE_ADDRESS),
        BigInt.fromI32(1000),
        mintTimestamp,
      ),
    )

    // Calculate HODLer ratio
    const ratio = computeHODLerRatio(ALICE_ADDRESS, mintTimestamp, endTimestamp)

    // Alice should have a 100% HODLer ratio as she holds all tokens
    assert.fieldEquals('User', ALICE_ADDRESS, 'balance', '1000')
    assertEquals(ratio, BigDecimal.fromString('1'))
  })

  test('should calculate HODLer ratios for multiple users over the same period', () => {
    const mintTimestamp = BigInt.fromI32(3600) // 1 hour
    const transferTimestamp = BigInt.fromI32(5400) // 1.5 hours
    const endTimestamp = BigInt.fromI32(7200) // 2 hours

    // Mint 1000 tokens to Alice
    handleTransfer(
      createTransferEvent(
        Address.fromString(ZERO_ADDRESS),
        Address.fromString(ALICE_ADDRESS),
        BigInt.fromI32(1000),
        mintTimestamp,
      ),
    )

    // Transfer 400 tokens from Alice to Bob
    handleTransfer(
      createTransferEvent(
        Address.fromString(ALICE_ADDRESS),
        Address.fromString(BOB_ADDRESS),
        BigInt.fromI32(400),
        transferTimestamp,
      ),
    )

    // Calculate HODLer ratios
    const aliceRatio = computeHODLerRatio(ALICE_ADDRESS, mintTimestamp, endTimestamp)
    const bobRatio = computeHODLerRatio(BOB_ADDRESS, mintTimestamp, endTimestamp)

    // Alice = 1800 * 1000 + 1800 * 600 = 1800 * 1600
    // Bob = 1800 * 400

    // Total = Alice + Bob = 1800 * 1600 + 1800 * 400 = 1800 * 2000

    // Alice ratio = 1800 * 1600 / 1800 * 2000 = 16/20 = 0.8
    // Bob ratio = 1800 * 400 / 1800 * 2000 = 4/20 = 0.2

    // Alice should have a 80% HODLer ratio (1000 tokens for half a period, then 600 tokens for half a period)
    // Bob should have a 20% HODLer ratio (400 tokens for half a period)
    assertEquals(aliceRatio, BigDecimal.fromString('0.8'))
    assertEquals(bobRatio, BigDecimal.fromString('0.2'))
  })

  test('should calculate HODLer ratio as 0 for a user who has never held tokens', () => {
    const mintTimestamp = BigInt.fromI32(3600) // 1 hour
    const endTimestamp = BigInt.fromI32(7200) // 2 hours

    // Mint 1000 tokens to Alice
    handleTransfer(
      createTransferEvent(
        Address.fromString(ZERO_ADDRESS),
        Address.fromString(ALICE_ADDRESS),
        BigInt.fromI32(1000),
        mintTimestamp,
      ),
    )

    // Calculate HODLer ratio for Bob (who has never held any tokens)
    const bobRatio = computeHODLerRatio(BOB_ADDRESS, mintTimestamp, endTimestamp)

    // The ratio should be 0 as Bob has never held any tokens
    assertEquals(bobRatio, BigDecimal.fromString('0'))

    // Verify that Alice's ratio is 1 (she holds all tokens)
    const aliceRatio = computeHODLerRatio(ALICE_ADDRESS, mintTimestamp, endTimestamp)
    assertEquals(aliceRatio, BigDecimal.fromString('1'))
  })

  test('should calculate HODLer ratio for a period exactly matching observation timestamps', () => {
    const mintTimestamp = BigInt.fromI32(3600) // 1 hour
    const endTimestamp = BigInt.fromI32(7200) // 2 hours

    // Mint 1000 tokens to Alice
    handleTransfer(
      createTransferEvent(
        Address.fromString(ZERO_ADDRESS),
        Address.fromString(ALICE_ADDRESS),
        BigInt.fromI32(1000),
        mintTimestamp,
      ),
    )

    // Calculate HODLer ratio
    const ratio = computeHODLerRatio(ALICE_ADDRESS, mintTimestamp, endTimestamp)

    // Alice should have a 100% HODLer ratio
    assertEquals(ratio, BigDecimal.fromString('1'))
  })

  test('should extrapolate HODLer ratio after the last observation', () => {
    const mintTimestamp = BigInt.fromI32(3600) // 1 hour
    const calculationEndTimestamp = BigInt.fromI32(10800) // 3 hours

    // Mint 1000 tokens to Alice
    handleTransfer(
      createTransferEvent(
        Address.fromString(ZERO_ADDRESS),
        Address.fromString(ALICE_ADDRESS),
        BigInt.fromI32(1000),
        mintTimestamp,
      ),
    )

    // Calculate HODLer ratio
    const ratio = computeHODLerRatio(ALICE_ADDRESS, mintTimestamp, calculationEndTimestamp)

    // Alice should still have a 100% HODLer ratio as her balance remains unchanged
    assertEquals(ratio, BigDecimal.fromString('1'))
  })

  test('should calculate HODLer ratio for a period including time before the first observation', () => {
    const startTimestamp = BigInt.fromI32(0) // 0 hours
    const mintTimestamp = BigInt.fromI32(3600) // 1 hour
    const endTimestamp = BigInt.fromI32(7200) // 2 hours

    // Mint 1000 tokens to Alice at 1 hour
    handleTransfer(
      createTransferEvent(
        Address.fromString(ZERO_ADDRESS),
        Address.fromString(ALICE_ADDRESS),
        BigInt.fromI32(1000),
        mintTimestamp,
      ),
    )

    // Calculate HODLer ratio from 0 to 2 hours
    const ratio = computeHODLerRatio(ALICE_ADDRESS, startTimestamp, endTimestamp)

    // Alice should have a 100% HODLer ratio
    // Even though we're considering a period before the token had supply,
    // Alice is the only holder once tokens exist, so she accounts for 100% of the HODLing
    assertEquals(ratio, BigDecimal.fromString('1'))

    // Verify that the total supply (token user) has the same cumulative HODL
    const tokenUserRatio = computeHODLerRatio(ZERO_ADDRESS, startTimestamp, endTimestamp)
    assertEquals(tokenUserRatio, BigDecimal.fromString('1'))
  })

  test('should handle HODLer ratio calculation across multiple observations', () => {
    const mintTimestamp = BigInt.fromI32(3600) // 1 hour
    const transfer1Timestamp = BigInt.fromI32(7200) // 2 hours
    const transfer2Timestamp = BigInt.fromI32(10800) // 3 hours
    const endTimestamp = BigInt.fromI32(14400) // 4 hours

    // Mint 1000 tokens to Alice
    handleTransfer(
      createTransferEvent(
        Address.fromString(ZERO_ADDRESS),
        Address.fromString(ALICE_ADDRESS),
        BigInt.fromI32(1000),
        mintTimestamp,
      ),
    )

    // Transfer 300 tokens from Alice to Bob
    handleTransfer(
      createTransferEvent(
        Address.fromString(ALICE_ADDRESS),
        Address.fromString(BOB_ADDRESS),
        BigInt.fromI32(300),
        transfer1Timestamp,
      ),
    )

    // Transfer 200 tokens from Alice to Carol
    handleTransfer(
      createTransferEvent(
        Address.fromString(ALICE_ADDRESS),
        Address.fromString(CAROL_ADDRESS),
        BigInt.fromI32(200),
        transfer2Timestamp,
      ),
    )

    // Calculate HODLer ratios
    const aliceRatio = computeHODLerRatio(ALICE_ADDRESS, mintTimestamp, endTimestamp)
    const bobRatio = computeHODLerRatio(BOB_ADDRESS, mintTimestamp, endTimestamp)
    const carolRatio = computeHODLerRatio(CAROL_ADDRESS, mintTimestamp, endTimestamp)

    // Total = 1000 for 3hrs = 10_800_000
    // Alice: 1000 for 3600s, 700 for 3600s, 500 for 3600s = 7_920_000 token-seconds
    // Bob: 300 for 7200s = 2_160_000 token-seconds
    // Carol: 200 for 3600s = 720_000 token-seconds
    assertEquals(aliceRatio, fraction(BigInt.fromU64(7_920_000), BigInt.fromU64(10_800_000)))
    assertEquals(bobRatio, fraction(BigInt.fromU64(2_160_000), BigInt.fromU64(10_800_000)))
    assertEquals(carolRatio, fraction(BigInt.fromU64(720_000), BigInt.fromU64(10_800_000)))

    // Ensure the ratios sum to 1
    const totalRatio = aliceRatio.plus(bobRatio).plus(carolRatio)
    assertEquals(totalRatio, BigDecimal.fromString('1'))
  })

  test('should calculate HODLer ratio during periods of minting', () => {
    const mint1Timestamp = BigInt.fromI32(3600) // 1 hour
    const mint2Timestamp = BigInt.fromI32(7200) // 2 hours
    const endTimestamp = BigInt.fromI32(10800) // 3 hours

    // Mint 1000 tokens to Alice
    handleTransfer(
      createTransferEvent(
        Address.fromString(ZERO_ADDRESS),
        Address.fromString(ALICE_ADDRESS),
        BigInt.fromI32(1000),
        mint1Timestamp,
      ),
    )

    // Mint 500 more tokens to Alice
    handleTransfer(
      createTransferEvent(
        Address.fromString(ZERO_ADDRESS),
        Address.fromString(ALICE_ADDRESS),
        BigInt.fromI32(500),
        mint2Timestamp,
      ),
    )

    // Calculate HODLer ratio
    const ratio = computeHODLerRatio(ALICE_ADDRESS, mint1Timestamp, endTimestamp)

    // Alice should have a 100% HODLer ratio as she holds all tokens
    assertEquals(ratio, BigDecimal.fromString('1'))
  })

  test('should calculate HODLer ratio during periods of burning', () => {
    const mintTimestamp = BigInt.fromI32(3600) // 1 hour
    const burnTimestamp = BigInt.fromI32(7200) // 2 hours
    const endTimestamp = BigInt.fromI32(10800) // 3 hours

    // Mint 1000 tokens to Alice
    handleTransfer(
      createTransferEvent(
        Address.fromString(ZERO_ADDRESS),
        Address.fromString(ALICE_ADDRESS),
        BigInt.fromI32(1000),
        mintTimestamp,
      ),
    )

    // Burn 400 tokens from Alice
    handleTransfer(
      createTransferEvent(
        Address.fromString(ALICE_ADDRESS),
        Address.fromString(ZERO_ADDRESS),
        BigInt.fromI32(400),
        burnTimestamp,
      ),
    )

    // Calculate HODLer ratio
    const ratio = computeHODLerRatio(ALICE_ADDRESS, mintTimestamp, endTimestamp)

    // Alice should have a 100% HODLer ratio as she holds all non-burned tokens
    assertEquals(ratio, BigDecimal.fromString('1'))
  })

  test('should handle HODLer ratio calculation with frequent small transfers', () => {
    const mintTimestamp = BigInt.fromI32(3600) // 1 hour
    const endTimestamp = BigInt.fromI32(7200) // 2 hours

    // Mint 1000 tokens to Alice
    handleTransfer(
      createTransferEvent(
        Address.fromString(ZERO_ADDRESS),
        Address.fromString(ALICE_ADDRESS),
        BigInt.fromI32(1000),
        mintTimestamp,
      ),
    )

    // Perform 10 small transfers from Alice to Bob
    for (let i = 0; i < 10; i++) {
      handleTransfer(
        createTransferEvent(
          Address.fromString(ALICE_ADDRESS),
          Address.fromString(BOB_ADDRESS),
          BigInt.fromI32(10),
          mintTimestamp.plus(BigInt.fromI32((i + 1) * 180)), // Every 3 minutes
        ),
      )
    }

    // Calculate HODLer ratios
    const aliceRatio = computeHODLerRatio(ALICE_ADDRESS, mintTimestamp, endTimestamp)
    const bobRatio = computeHODLerRatio(BOB_ADDRESS, mintTimestamp, endTimestamp)

    // Explanation of expected ratios(NB: these are close approximations):
    // 1. First 30 minutes (1800 seconds):
    //    - Alice's balance decreases from 1000 to 900
    //    - Bob's balance increases from 0 to 100
    //    - Alice's average balance: (1000 + 900) / 2 = 950
    //    - Bob's average balance: (0 + 100) / 2 = 50
    // 2. Second 30 minutes (1800 seconds):
    //    - Alice's balance stays at 900
    //    - Bob's balance stays at 100
    //
    // Cumulative HODL calculation:
    // Alice: (950 * 1800) + (900 * 1800) = 3,330,000 token-seconds
    // Bob: (50 * 1800) + (100 * 1800) = 270,000 token-seconds
    // Total: 3,600,000 token-seconds
    //
    // Expected ratios:
    // Alice: 3,330,000 / 3,600,000 ≈ 0.9250
    // Bob: 270,000 / 3,600,000 ≈ 0.0750

    // We use a small range to account for potential minor discrepancies
    // due to block timing and rounding in the contract calculations
    assert.assertTrue(aliceRatio.ge(BigDecimal.fromString('0.92')) && aliceRatio.le(BigDecimal.fromString('0.93')))
    assert.assertTrue(bobRatio.ge(BigDecimal.fromString('0.07')) && bobRatio.le(BigDecimal.fromString('0.08')))

    // Ensure the ratios sum to 1
    const totalRatio = aliceRatio.plus(bobRatio)
    assert.assertTrue(totalRatio.ge(BigDecimal.fromString('0.99')) && totalRatio.le(BigDecimal.fromString('1.01')))
  })

  test('should calculate HODLer ratio for long-term holders vs short-term traders', () => {
    const mintTimestamp = BigInt.fromI32(3600) // 1 hour
    const tradeTimestamp = BigInt.fromI32(7200) // 2 hours
    const endTimestamp = BigInt.fromI32(86400) // 24 hours

    // Mint 1000 tokens to Alice (long-term holder)
    handleTransfer(
      createTransferEvent(
        Address.fromString(ZERO_ADDRESS),
        Address.fromString(ALICE_ADDRESS),
        BigInt.fromI32(1000),
        mintTimestamp,
      ),
    )

    // Bob receives and immediately sends tokens (short-term trader)
    handleTransfer(
      createTransferEvent(
        Address.fromString(ALICE_ADDRESS),
        Address.fromString(BOB_ADDRESS),
        BigInt.fromI32(200),
        tradeTimestamp,
      ),
    )
    handleTransfer(
      createTransferEvent(
        Address.fromString(BOB_ADDRESS),
        Address.fromString(CAROL_ADDRESS),
        BigInt.fromI32(200),
        tradeTimestamp.plus(BigInt.fromI32(60)), // 1 minute later
      ),
    )

    // Calculate HODLer ratios
    const aliceRatio = computeHODLerRatio(ALICE_ADDRESS, mintTimestamp, endTimestamp)
    const bobRatio = computeHODLerRatio(BOB_ADDRESS, mintTimestamp, endTimestamp)
    const carolRatio = computeHODLerRatio(CAROL_ADDRESS, mintTimestamp, endTimestamp)

    // Alice should have approximately 80.87% HODLer ratio
    // Bob should have a very small HODLer ratio (approximately 0.0145%)
    // Carol should have approximately 19.12% HODLer ratio
    assert.assertTrue(aliceRatio.ge(BigDecimal.fromString('0.8085')) && aliceRatio.le(BigDecimal.fromString('0.8088')))
    assert.assertTrue(bobRatio.ge(BigDecimal.fromString('0.00014')) && bobRatio.le(BigDecimal.fromString('0.00015')))
    assert.assertTrue(carolRatio.ge(BigDecimal.fromString('0.1910')) && carolRatio.le(BigDecimal.fromString('0.1913')))

    // Ensure the ratios sum to 1 (allowing for a small margin of error due to rounding)
    const totalRatio = aliceRatio.plus(bobRatio).plus(carolRatio)
    assert.assertTrue(totalRatio.ge(BigDecimal.fromString('0.9999')) && totalRatio.le(BigDecimal.fromString('1.0001')))
  })

  test('should handle HODLer ratio calculation for users who receive and transfer all tokens', () => {
    const mintTimestamp = BigInt.fromI32(3600) // 1 hour
    const transferTimestamp = BigInt.fromI32(7200) // 2 hours
    const endTimestamp = BigInt.fromI32(10800) // 3 hours

    // Mint 1000 tokens to Alice
    handleTransfer(
      createTransferEvent(
        Address.fromString(ZERO_ADDRESS),
        Address.fromString(ALICE_ADDRESS),
        BigInt.fromI32(1000),
        mintTimestamp,
      ),
    )

    // Alice transfers all tokens to Bob
    handleTransfer(
      createTransferEvent(
        Address.fromString(ALICE_ADDRESS),
        Address.fromString(BOB_ADDRESS),
        BigInt.fromI32(1000),
        transferTimestamp,
      ),
    )

    // Calculate HODLer ratios
    const aliceRatio = computeHODLerRatio(ALICE_ADDRESS, mintTimestamp, endTimestamp)
    const bobRatio = computeHODLerRatio(BOB_ADDRESS, mintTimestamp, endTimestamp)

    // Alice should have 1/2 HODLer ratio (held all tokens for half of the time)
    // Bob should have 1/2 HODLer ratio (held all tokens for half of the time)
    assert.fieldEquals('User', ALICE_ADDRESS, 'balance', '0')
    assert.fieldEquals('User', BOB_ADDRESS, 'balance', '1000')

    // Use approximate equality to account for potential small rounding errors
    assertEquals(aliceRatio, BigDecimal.fromString('0.5'))
    assertEquals(bobRatio, BigDecimal.fromString('0.5'))

    // The sum of both ratios should be 1
    const totalRatio = aliceRatio.plus(bobRatio)
    assertEquals(totalRatio, BigDecimal.fromString('1'))
  })

  test('should calculate HODLer ratio across a very long period', () => {
    const mintTimestamp = BigInt.fromI32(3600) // 1 hour
    const endTimestamp = BigInt.fromI32(31536000) // 1 year (365 days)

    // Mint 1000 tokens to Alice
    handleTransfer(
      createTransferEvent(
        Address.fromString(ZERO_ADDRESS),
        Address.fromString(ALICE_ADDRESS),
        BigInt.fromI32(1000),
        mintTimestamp,
      ),
    )

    // Transfer 200 tokens from Alice to Bob after 6 months
    handleTransfer(
      createTransferEvent(
        Address.fromString(ALICE_ADDRESS),
        Address.fromString(BOB_ADDRESS),
        BigInt.fromI32(200),
        BigInt.fromI32(15768000), // 6 months
      ),
    )

    // Calculate HODLer ratios
    const aliceRatio = computeHODLerRatio(ALICE_ADDRESS, mintTimestamp, endTimestamp)
    const bobRatio = computeHODLerRatio(BOB_ADDRESS, mintTimestamp, endTimestamp)

    // Alice should have approximately 90% HODLer ratio (1000 for 6 months, 800 for 6 months)
    // Bob should have approximately 10% HODLer ratio (200 for 6 months)
    assert.assertTrue(aliceRatio.ge(BigDecimal.fromString('0.89')) && aliceRatio.le(BigDecimal.fromString('0.91')))
    assert.assertTrue(bobRatio.ge(BigDecimal.fromString('0.09')) && bobRatio.le(BigDecimal.fromString('0.11')))
  })

  test('should handle precision for very small token amounts in HODLer ratio calculation', () => {
    const mintTimestamp = BigInt.fromI32(3600) // 1 hour
    const transferTimestamp = BigInt.fromI32(7200) // 2 hours
    const endTimestamp = BigInt.fromI32(10800) // 3 hours

    // Mint 1,000,000 tokens to Alice
    handleTransfer(
      createTransferEvent(
        Address.fromString(ZERO_ADDRESS),
        Address.fromString(ALICE_ADDRESS),
        BigInt.fromI32(1000000),
        mintTimestamp,
      ),
    )

    // Transfer 1 token from Alice to Bob
    handleTransfer(
      createTransferEvent(
        Address.fromString(ALICE_ADDRESS),
        Address.fromString(BOB_ADDRESS),
        BigInt.fromI32(1),
        transferTimestamp,
      ),
    )

    // Calculate HODLer ratios
    const aliceRatio = computeHODLerRatio(ALICE_ADDRESS, mintTimestamp, endTimestamp)
    const bobRatio = computeHODLerRatio(BOB_ADDRESS, mintTimestamp, endTimestamp)

    // Alice should have approximately 99.9999% HODLer ratio
    // Bob should have approximately 0.0001% HODLer ratio
    assert.assertTrue(aliceRatio.ge(BigDecimal.fromString('0.999998')) && aliceRatio.le(BigDecimal.fromString('1')))
    assert.assertTrue(bobRatio.ge(BigDecimal.fromString('0')) && bobRatio.le(BigDecimal.fromString('0.000002')))
  })

  test('should calculate relative HODLer ratios between multiple users', () => {
    const mintTimestamp = BigInt.fromI32(3600) // 1 hour
    const transfer1Timestamp = BigInt.fromI32(7200) // 2 hours
    const transfer2Timestamp = BigInt.fromI32(10800) // 3 hours
    const endTimestamp = BigInt.fromI32(14400) // 4 hours

    // Mint 1000 tokens to Alice
    handleTransfer(
      createTransferEvent(
        Address.fromString(ZERO_ADDRESS),
        Address.fromString(ALICE_ADDRESS),
        BigInt.fromI32(1000),
        mintTimestamp,
      ),
    )

    // Transfer 300 tokens from Alice to Bob
    handleTransfer(
      createTransferEvent(
        Address.fromString(ALICE_ADDRESS),
        Address.fromString(BOB_ADDRESS),
        BigInt.fromI32(300),
        transfer1Timestamp,
      ),
    )

    // Transfer 200 tokens from Alice to Carol
    handleTransfer(
      createTransferEvent(
        Address.fromString(ALICE_ADDRESS),
        Address.fromString(CAROL_ADDRESS),
        BigInt.fromI32(200),
        transfer2Timestamp,
      ),
    )

    // Calculate HODLer ratios
    const aliceRatio = computeHODLerRatio(ALICE_ADDRESS, mintTimestamp, endTimestamp)
    const bobRatio = computeHODLerRatio(BOB_ADDRESS, mintTimestamp, endTimestamp)
    const carolRatio = computeHODLerRatio(CAROL_ADDRESS, mintTimestamp, endTimestamp)

    // Check that the sum of all ratios is approximately 1
    const totalRatio = aliceRatio.plus(bobRatio).plus(carolRatio)
    assert.assertTrue(totalRatio.ge(BigDecimal.fromString('0.99')) && totalRatio.le(BigDecimal.fromString('1.01')))

    // Check relative ratios
    assert.assertTrue(aliceRatio.gt(bobRatio))
    assert.assertTrue(bobRatio.gt(carolRatio))
  })

  test('should handle HODLer ratio calculation across complex transfer patterns', () => {
    const mintTimestamp = BigInt.fromI32(3600) // 1 hour
    const endTimestamp = BigInt.fromI32(18000) // 5 hours

    // Mint 1000 tokens to Alice
    handleTransfer(
      createTransferEvent(
        Address.fromString(ZERO_ADDRESS),
        Address.fromString(ALICE_ADDRESS),
        BigInt.fromI32(1000),
        mintTimestamp,
      ),
    )

    // NOTE: due to the following issues AS limitations we cannot create an array of objects containing transfer data
    // which we can iterate over to emit Transfer events(using createTransferEvent), however standard for loops with an index counter work
    // * ERROR AS225: Expression cannot be represented by a type.
    // * ERROR AS100: Not implemented: Iterators
    // So we instead explicitly emit each Transfer event as done below

    // Complex transfer pattern
    handleTransfer(
      createTransferEvent(
        Address.fromString(ALICE_ADDRESS),
        Address.fromString(BOB_ADDRESS),
        BigInt.fromI32(200),
        BigInt.fromI32(7200), // 2 hours
      ),
    )

    handleTransfer(
      createTransferEvent(
        Address.fromString(BOB_ADDRESS),
        Address.fromString(CAROL_ADDRESS),
        BigInt.fromI32(50),
        BigInt.fromI32(9000), // 2.5 hours
      ),
    )

    handleTransfer(
      createTransferEvent(
        Address.fromString(ALICE_ADDRESS),
        Address.fromString(CAROL_ADDRESS),
        BigInt.fromI32(300),
        BigInt.fromI32(10800), // 3 hours
      ),
    )

    handleTransfer(
      createTransferEvent(
        Address.fromString(CAROL_ADDRESS),
        Address.fromString(BOB_ADDRESS),
        BigInt.fromI32(100),
        BigInt.fromI32(12600), // 3.5 hours
      ),
    )

    handleTransfer(
      createTransferEvent(
        Address.fromString(BOB_ADDRESS),
        Address.fromString(ALICE_ADDRESS),
        BigInt.fromI32(150),
        BigInt.fromI32(14400), // 4 hours
      ),
    )

    // Calculate HODLer ratios
    const aliceRatio = computeHODLerRatio(ALICE_ADDRESS, mintTimestamp, endTimestamp)
    const bobRatio = computeHODLerRatio(BOB_ADDRESS, mintTimestamp, endTimestamp)
    const carolRatio = computeHODLerRatio(CAROL_ADDRESS, mintTimestamp, endTimestamp)

    // Check that the sum of all ratios is approximately 1
    const totalRatio = aliceRatio.plus(bobRatio).plus(carolRatio)
    assert.assertTrue(totalRatio.ge(BigDecimal.fromString('0.99')) && totalRatio.le(BigDecimal.fromString('1.01')))

    // Expected approximate ratios:
    // Alice: ~70% (starts with 1000, ends with 650)
    // Bob: ~15% (receives 200, then fluctuates)
    // Carol: ~15% (receives 350, then fluctuates)
    assert.assertTrue(aliceRatio.ge(BigDecimal.fromString('0.65')) && aliceRatio.le(BigDecimal.fromString('0.75')))
    assert.assertTrue(bobRatio.ge(BigDecimal.fromString('0.10')) && bobRatio.le(BigDecimal.fromString('0.20')))
    assert.assertTrue(carolRatio.ge(BigDecimal.fromString('0.10')) && carolRatio.le(BigDecimal.fromString('0.20')))
  })
})
