"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { LEAD_CARD_KEYS, type LeadCard } from "@/lib/ai/types";

const LABELS: Record<keyof LeadCard, string> = {
  name: "Name",
  occupation: "Does",
  goal: "Goal",
  experience: "Experience",
  intent: "Intent",
  objection: "Objection",
  city: "City",
};

const INTENT_STYLE: Record<string, string> = {
  high: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  medium: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  low: "bg-muted-foreground/15 text-muted-foreground",
};

/** How often to re-read the card while the chat is open. The AI updates it
 *  after each reply, so a short poll keeps the panel current without
 *  needing realtime on the contacts table. */
const REFRESH_MS = 10_000;

function toCard(raw: unknown): LeadCard {
  const card: LeadCard = {};
  if (raw && typeof raw === "object") {
    for (const key of LEAD_CARD_KEYS) {
      const v = (raw as Record<string, unknown>)[key];
      if (typeof v === "string" && v.trim()) card[key] = v.trim();
    }
  }
  return card;
}

/**
 * What the AI has learned about this lead (contacts.ai_lead_card), shown in
 * the inbox sidebar so a counsellor picking up the chat sees it at a glance.
 */
export function AiLeadCard({ contactId }: { contactId: string }) {
  const [card, setCard] = useState<LeadCard>({});

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase
        .from("contacts")
        .select("ai_lead_card")
        .eq("id", contactId)
        .maybeSingle();
      if (!cancelled) setCard(toCard(data?.ai_lead_card));
    };
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [contactId]);

  const filled = LEAD_CARD_KEYS.filter((k) => card[k]);

  return (
    <div>
      <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Sparkles className="h-3 w-3" />
        AI lead card
      </div>
      {filled.length === 0 ? (
        <p className="mt-2 px-1 text-xs text-muted-foreground">
          Nothing learned yet — the AI fills this in as it chats.
        </p>
      ) : (
        <dl className="mt-2 space-y-1.5 rounded-lg bg-muted px-3 py-2">
          {filled.map((key) => (
            <div key={key} className="flex gap-2 text-xs">
              <dt className="w-20 shrink-0 text-muted-foreground">{LABELS[key]}</dt>
              <dd className="min-w-0 flex-1 break-words text-foreground">
                {key === "intent" ? (
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.5 text-[10px] font-medium capitalize",
                      INTENT_STYLE[card.intent!.toLowerCase()] ?? INTENT_STYLE.low
                    )}
                  >
                    {card.intent}
                  </span>
                ) : (
                  card[key]
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
