# Bulk Transfer ENS

A small Vite + React app to batch-transfer all of your ENS names (`.eth`
registrations, wrapped names, and subnames) to a new owner in a single
transaction using EIP-5792 `wallet_sendCalls` (via wagmi's `useSendCalls`).

Names are read from the [ENS subgraph](https://thegraph.com/explorer/subgraphs/5XqPmWe6gjyrJtFn9cLy237i4cWw2j9HcUJEXsP5qGtH)
on The Graph's decentralized network.

## Setup

```bash
bun install
cp .env.example .env   # then add your Graph API key to the URL
bun run dev
```

Get a free Graph API key at <https://thegraph.com/studio/apikeys/> and paste the
query URL it gives you into `VITE_SUBGRAPH_URL`.

## How it works

1. Connect a wallet (or, without connecting, type any address to preview the
   names it owns — transfers are disabled in that read-only mode).
2. The app queries the subgraph for every name where you are the
   wrapped owner, the registrant, or the registry controller, and labels each:
   - **wrapped** → transferred via the NameWrapper `safeTransferFrom`
   - **.eth** → unwrapped registration, transferred via the BaseRegistrar
     `safeTransferFrom`
   - **subname** → unwrapped subname, transferred via the Registry `setOwner`
3. Select the names, enter a recipient (address or `name.eth`), and submit.
   All selected transfers are bundled into one `sendCalls` batch.

> Your wallet must support EIP-5792 batch calls (e.g. Coinbase Smart Wallet,
> or another wallet that advertises `wallet_sendCalls`). Wallets without it
> will reject the batch.

## Notes

- Transferring an unwrapped `.eth` registration moves the registrant (the NFT).
  The new owner may need to reclaim the registry controller afterwards.
- This targets Ethereum mainnet.
