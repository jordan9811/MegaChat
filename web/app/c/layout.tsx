import '../dashboard/campaigns/campaigns.css'

// The public offer page wears the shared product header (the same bar as
// /dashboard/campaigns, /account and /join), whose styles live with the
// campaign dashboard. The UI face comes from the root layout.

export default function CampaignOfferLayout({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>
}
