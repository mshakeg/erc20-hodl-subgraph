# ERC20 HODL Subgraph

This repository contains a subgraph implementation for tracking and analyzing HODLer behavior in ERC20 tokens. The subgraph calculates HODLer ratios for users over specific time periods, providing insights into token retention and user loyalty.

## Key Features:
- Tracks user balances and cumulative HODL values at regular(hourly) intervals
- Exposes the above data so that HODLer ratios between any two points in time can be easily calculated NOT by the subgraph but the client quering the subgraph using the data the subgraph exposes.
- Implements tests that prove that the subgraph correctly updates all relevant entities and that using this data HODLer ratios can be calculated over arbitrary time ranges.

## Use Cases:
- Analyze user retention and loyalty metrics
- Identify long-term token holders
- Support token economics research and decision-making
- Provide data for community rewards or governance systems based on HODLing behavior

This subgraph offers a powerful tool for token projects, analysts, and researchers to gain deep insights into HODLing patterns and user behavior within ERC20 token ecosystems.

A given user's HODLer ratio over a period [A,B] can be calculated as follows:

(cumulativeHODL(user, B) - cumulativeHODL(user, A)) / (cumulativeHODL(token, B) - cumulativeHODL(token, A))

If cumulativeHODL for a user(or the tokenUser i.e address(0)) at a time N does not exist but has surrounding observations at time M and O then the cumulativeHODL for the user at time N can be interpolated as follows:

cumulativeHODL(user, N) = cumulativeHODL(user, M) + (cumulativeHODL(user, O) - cumulativeHODL(user, M)) * (N - M) / (O - M)

If cumulativeHODL for a user(or the tokenUser i.e address(0)) at a time N does not exist but has a latest observation at time M where M < N then cumulativeHODL for the user at time N can be extrapolated as follows(since the user's balance has remain unchanged for the duration of M to N):

cumulativeHODL(user, N) = cumulativeHODL(user, M) + latest user balance(i.e. the balance that was constant for the duration from M to N) * (N - M)

If cumulativeHODL for a user at a time N does not exist but and has no earlier observation stored in the subgraph then we can assume cumulativeHODL for the user at time N to be 0.

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
