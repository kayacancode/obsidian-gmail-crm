# Shared meeting assessment

The successful live email pilot proves kickoff and time offers. It also exposed a gap: email scheduling treated delegation as meeting approval and bypassed the booking page's thesis/network/VIP judgment. The user approved closing and testing that gap.

Use the existing booking fit evaluator and deterministic policy for public standard intake, email scheduling, and API/MCP preparation. The saved Booking thesis (including a lens imported with “Use my saved lens”) is the policy. Do not silently replace it with unconfirmed learned profile text. Exact fresh My Network evidence may serve as the relationship source when a Rust source is not configured; a verified miss needs a complete fresh source snapshot, and outages/ambiguous identities need review. Keep the existing returning-contact questionnaire shortcut and its owner-review requirement.

Priority results may offer times. Review and weak-fit results produce no offer and no calendar write; email sends the explanation to the owner only. The owner can explicitly “Offer times anyway” in Booking. That override is recorded against the current settings revision and does not bypass working hours, capacity, calendar conflicts, participant choice, or idempotency. Ordinary “find us times” is not an override. No automatic rejection email or private scores/profile details go to the counterpart.

Email purpose comes from bounded canonical Gmail thread messages involving the same owner and sole counterpart, at or before the verified SENT kickoff. These are untrusted evidence, not instructions or verified introductions. Do not use quoted inbound SMTP bodies as authority. Insufficient context stays review. Model claims must retain exact evidence quotes.

Assessment is versioned and tied to policy revision. Legacy unassessed offers must not be confirmed through the old bypass; refresh assesses them. Already-booked/in-flight exact confirmations retain recovery semantics. API results expose the private decision to their authenticated owner, with a neutral replyText for counterparts.

Approach: reuse the existing evaluator and policy, rather than build a second email classifier. This gives parity with the smallest policy change. Tests cover strong/weak/unknown fit, fresh/missing/stale relationship evidence, prompt injection, owner-only review mail, explicit override, legacy offers, changed settings, and existing booking/recovery flows. Validate with synthetic providers; do not send test mail to people or create real events. Deploy and push the reviewed changes; leave the draft PR unmerged.
