# Phase 2 — Pluggable payment token

## Summary

- Dashboard field: **Passkey payment token** (Arc ERC-20 address).
- Server reads `decimals()` and `symbol()` on save — never hardcodes 6/18.
- **Passkey path:** approve + `transferFrom` meter uses the room token.
- **MetaMask/Gateway:** always USDC (Gateway is USDC-specific). UI notes this.

Default: Arc USDC `0x3600000000000000000000000000000000000000`.

## Automated gate

```bash
node _gate-tokens-phase2.mjs
npm run build:passkey
npm run gate:dashboard
```

## Manual test

1. Dashboard → set token to USDC (default) → passkey join still works.
2. Set a custom Arc ERC-20 (must hold balance + approve seller).
3. Join page shows token **symbol** in price box and meter.
4. MetaMask join on same room still uses USDC Gateway flow.
