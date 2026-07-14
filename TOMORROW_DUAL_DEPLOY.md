# TOMORROW — two sites under megachat.xyz

Goal: run BOTH transports/chains side by side under one domain.

- **megachat.xyz** → the CURRENT service (Tempo mainnet, real money, all
  features). Just attach the domain — no new deploy.
- **testnet.megachat.xyz** → a NEW Railway service running the Circle/Arc
  build (fake testnet money, a safe sandbox to hand people).

## Sign up for
- **Cloudflare** ([dash.cloudflare.com](https://dash.cloudflare.com)) as the
  domain registrar + DNS. Why Cloudflare specifically: free DNS, at-cost
  domains, and CNAME flattening so the bare apex `megachat.xyz` works with
  Railway (most registrars can't point an apex at a Railway CNAME).
- Everything else already exists: Railway, LiveKit, Privy, Circle, Twitch/X.

## Cost
- `megachat.xyz` (.xyz): ~$10–12/yr (sometimes ~$1 first year).
- Railway 2nd service: usage-based, ~$5–10/mo extra for a low-traffic Node
  service. May push you from Hobby ($5/mo incl. $5 usage) toward Pro ($20/mo)
  only if traffic grows.
- LiveKit Cloud / Privy / Arc testnet: free tiers, no change.
- **One-time ~$12, then a few $/mo.**

## Time
~1–1.5 hrs of clicking + DNS propagation (minutes on Cloudflare).

## Steps only you can do
1. Buy `megachat.xyz` at Cloudflare Registrar (~10 min).
2. **Apex → current service:** Railway → megachat-production → Settings →
   Networking → Custom Domain → `megachat.xyz` → Railway shows a target →
   add it as the apex record in Cloudflare DNS (Cloudflare flattens the CNAME
   at apex automatically).
3. **Subdomain → new service:** create a new Railway service in the same
   project, connect the same GitHub repo, point it at the `arc-testnet`
   branch (I'll create it). Add its custom domain `testnet.megachat.xyz`
   (plain CNAME in Cloudflare — easy).
4. **Arc env vars** on the new service (I'll hand you the exact list — it's a
   different chain/RPC/USDC/gateway than Tempo).
5. **Circle allowlist:** add `testnet.megachat.xyz` to your Circle passkey
   app's allowed domains. Passkeys are domain-locked and 401 on any host
   Circle doesn't know — required or logins break on the testnet site.

## Two decisions (my recommendations)
- **Which Circle build?** Recommend branching at commit `6106405` — the last
  Arc/Circle commit on v0-ui-migration right before the Tempo merge. Has the
  polished v0 UI + connection stability on Circle/Arc. Does NOT have
  letters/handles/OAuth/LiveKit (those came with Tempo). Fine for a testnet
  sandbox; just know it's a slightly older feature set.
- **Persistence:** Railway's filesystem is ephemeral — `rooms.json` resets on
  redeploy unless you attach a Railway Volume. Fine for a testnet playground
  (demo room re-seeds on boot); add a volume if you want testnet rooms to
  survive deploys.

## The prompt to paste tomorrow
> Make an `arc-testnet` branch at commit 6106405 (last Circle/Arc commit
> before the Tempo merge), verify `npm ci` + build pass on it, and push it.
> Then give me the exact Arc/Circle env-var list for a second Railway
> service, the Cloudflare DNS records for megachat.xyz + testnet.megachat.xyz,
> and the Circle allowlist steps — walk me through pointing the new service
> at the branch.

## Status snapshot (as of tonight)
- OAuth (Twitch/X): LIVE on megachat-production.
- LiveKit: shipped + `livekitConfigured:true` — transport dropdown enabled.
- Tempo mainnet: default, untouched (chainId 4217, rooms default to vdo).
