# ERC20 HODL Subgraph

This repository contains a subgraph implementation for tracking and analyzing HODLer behavior in ERC20 tokens. The subgraph calculates HODLer ratios for users over specific time periods, providing insights into token retention and user loyalty.

## Key Features:
- Tracks user balances and cumulative HODL values at regular (hourly) intervals
- Exposes data that enables clients to calculate HODLer ratios between any two discrete hourly timestamps (e.g., 1:00 PM, 2:00 PM, but not 1:30 PM)
- Implements comprehensive tests to verify correct entity updates and HODLer ratio calculations over arbitrary time ranges

## Use Cases:
- Analyze user retention and loyalty metrics
- Identify long-term token holders
- Support token economics research and decision-making
- Provide data for community rewards or governance systems based on HODLing behavior

This subgraph offers a powerful tool for token projects, analysts, and researchers to gain deep insights into HODLing patterns and user behavior within ERC20 token ecosystems.

## HODLer Ratio Calculation

A given user's HODLer ratio over a period [A,B] can be calculated as follows:

```
(cumulativeHODL(user, B) - cumulativeHODL(user, A)) / (cumulativeHODL(token, B) - cumulativeHODL(token, A))
```

Where:
- `cumulativeHODL(user, X)` is the cumulative HODL value for a user at time X
- `cumulativeHODL(token, X)` is the cumulative HODL value for the entire token supply at time X (represented by address(0))

## Handling Missing Data Points

1. If cumulativeHODL for a user (or the token) at time N does not exist but has an immediately preceding observation at time M where M < N:

```
cumulativeHODL(user, N) = cumulativeHODL(user, M) + latest user balance * (N - M)
```

This extrapolation assumes the user's balance has remained unchanged from M to N.

2. If cumulativeHODL for a user at time N does not exist and has no earlier observation:

```
cumulativeHODL(user, N) = 0
```

This approach ensures accurate HODLer ratio calculations by using only known data points and extrapolating when necessary.

### Subgraph Endpoint

Synced at: <url>

Pending Changes at same URL

### Running Unit Tests

1. Install [Docker](https://docs.docker.com/get-docker/) if you don't have it already
2. Install postgres: `brew install postgresql`
3. `yarn run build:docker`
4. `yarn run test`

### Adding New Chains

TODO:
