import { Address, BigInt } from '@graphprotocol/graph-ts'

import { Transfer as TransferEvent } from './types/ERC20Token/ERC20'
import { HourObservation, User } from './types/schema'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const SECONDS_PER_HOUR = 3600

function getOrCreateUser(address: Address): User {
  let user = User.load(address.toHexString())
  if (user == null) {
    user = new User(address.toHexString())
    user.address = address
    user.balance = BigInt.fromI32(0)
    user.observationCount = BigInt.fromI32(0)
    user.lastHourTimestamp = BigInt.fromI32(0)
    user.save()
  }
  return user
}

function getOrCreateHourObservation(user: User, currentTimestamp: BigInt, priorUserBalance: BigInt): HourObservation {
  const hourTimestamp = currentTimestamp.div(BigInt.fromI32(SECONDS_PER_HOUR)).times(BigInt.fromI32(SECONDS_PER_HOUR))
  const observationId = user.id + '-' + hourTimestamp.toString()
  let observation = HourObservation.load(observationId)

  if (observation == null) {
    observation = new HourObservation(observationId)
    observation.user = user.id
    observation.timestamp = currentTimestamp

    if (user.observationCount.gt(BigInt.fromI32(0))) {
      const lastObservationId = user.id + '-' + user.lastHourTimestamp.toString()
      const lastObservation = HourObservation.load(lastObservationId)
      if (lastObservation) {
        const timeDelta = currentTimestamp.minus(lastObservation.timestamp)
        observation.cumulativeHODL = lastObservation.cumulativeHODL.plus(timeDelta.times(priorUserBalance))
      } else {
        observation.cumulativeHODL = BigInt.fromI32(0)
      }
    } else {
      observation.cumulativeHODL = BigInt.fromI32(0)
    }

    user.observationCount = user.observationCount.plus(BigInt.fromI32(1))
    user.lastHourTimestamp = hourTimestamp
    user.save()
  } else {
    const timeDelta = currentTimestamp.minus(observation.timestamp)
    observation.cumulativeHODL = observation.cumulativeHODL.plus(timeDelta.times(priorUserBalance))
    observation.timestamp = currentTimestamp
  }

  return observation
}

export function handleTransfer(event: TransferEvent): void {
  const fromUser = getOrCreateUser(event.params.from)
  const toUser = getOrCreateUser(event.params.to)
  const tokenUser = getOrCreateUser(Address.fromString(ZERO_ADDRESS))

  const isMint = fromUser.id == ZERO_ADDRESS
  const isBurn = toUser.id == ZERO_ADDRESS

  if (isMint && isBurn) {
    throw new Error('Invariant: cannot mint & burn in same Transfer event')
  }

  const priorFromBalance = fromUser.balance
  const priorToBalance = toUser.balance
  const priorTotalSupply = tokenUser.balance

  // Update balances
  if (!isMint) {
    fromUser.balance = fromUser.balance.minus(event.params.value)
    fromUser.save()
  }
  if (!isBurn) {
    toUser.balance = toUser.balance.plus(event.params.value)
    toUser.save()
  }

  // Update total supply (stored in the zero address user)
  if (isMint) {
    tokenUser.balance = tokenUser.balance.plus(event.params.value)
  } else if (isBurn) {
    tokenUser.balance = tokenUser.balance.minus(event.params.value)
  }
  tokenUser.save()

  // Create or update observations
  if (!isMint) {
    const fromObservation = getOrCreateHourObservation(fromUser, event.block.timestamp, priorFromBalance)
    fromObservation.save()
  }
  if (!isBurn) {
    const toObservation = getOrCreateHourObservation(toUser, event.block.timestamp, priorToBalance)
    toObservation.save()
  }

  // Create or update token-wide observation
  const tokenObservation = getOrCreateHourObservation(tokenUser, event.block.timestamp, priorTotalSupply)
  tokenObservation.save()
}
