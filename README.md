# ERC20 HODL Subgraph

This repository contains a subgraph implementation for tracking and analyzing HODLer behavior in ERC20 tokens. The subgraph calculates HODLer ratios for users over specific time periods, providing insights into token retention and user loyalty.

## Key Features:
- Tracks user balances and cumulative HODL values at regular(hourly) intervals
- Exposes the above data so that HODLer ratios between any two points in time can be easily calculated
- Implements test that demonstrate how HODLer ratios can be calculated including using extrapolation for precise time ranges.

## Use Cases:
- Analyze user retention and loyalty metrics
- Identify long-term token holders
- Support token economics research and decision-making
- Provide data for community rewards or governance systems based on HODLing behavior

This subgraph offers a powerful tool for token projects, analysts, and researchers to gain deep insights into HODLing patterns and user behavior within ERC20 token ecosystems.

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
