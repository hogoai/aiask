import type { Metadata } from "next";
import PartnersExperience from "./PartnersExperience";
import { normalizePartnerRole } from "../../lib/ai/contracts";

export const metadata: Metadata = {
  title: "AI Team — AIASK",
  description: "Explore six complementary AI Team roles around the ideas that matter to you.",
};

export default async function PartnersPage({ searchParams }: { searchParams: Promise<{ conversationId?: string; partner?: string }> }) {
  const params = await searchParams;
  const conversationId = typeof params.conversationId === "string" && /^[0-9a-f-]{36}$/i.test(params.conversationId) ? params.conversationId : undefined;
  const partnerId = normalizePartnerRole(params.partner) ?? undefined;
  return <PartnersExperience initialConversationId={conversationId} initialPartnerId={partnerId} />;
}
