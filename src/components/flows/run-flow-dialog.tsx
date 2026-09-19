"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ContactOption {
  id: string;
  name: string | null;
  phone: string;
}

interface RunFlowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  flowId: string;
  flowName: string;
}

/**
 * Contact picker for the editor's "Run manually" action. Loads the
 * account's contacts on open (unpaginated — same known tradeoff as
 * the pipelines deal-form contact picker) and lets the owner filter
 * by name/phone before starting the run.
 */
export function RunFlowDialog({
  open,
  onOpenChange,
  flowId,
  flowName,
}: RunFlowDialogProps) {
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelectedId(null);
    setFilter("");
    let cancelled = false;
    void (async () => {
      setLoadingContacts(true);
      const supabase = createClient();
      const { data } = await supabase
        .from("contacts")
        .select("id, name, phone")
        .order("name");
      if (!cancelled) {
        setContacts((data ?? []) as ContactOption[]);
      }
      setLoadingContacts(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) => c.name?.toLowerCase().includes(q) || c.phone.includes(q),
    );
  }, [contacts, filter]);

  async function handleRun() {
    if (!selectedId) return;
    setRunning(true);
    try {
      const res = await fetch(`/api/flows/${flowId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: selectedId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error ?? `Run failed (${res.status})`);
      }
      toast.success(`"${flowName}" started for this contact.`);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start run");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Run &quot;{flowName}&quot; manually</DialogTitle>
        </DialogHeader>

        <Input
          placeholder="Search contacts by name or phone…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />

        <div className="max-h-64 overflow-y-auto rounded-md border border-border">
          {loadingContacts ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No contacts match.
            </p>
          ) : (
            <ul className="flex flex-col">
              {filtered.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(c.id)}
                    className={
                      "flex w-full items-center justify-between gap-2 border-b border-border/60 px-3 py-2 text-left last:border-b-0 hover:bg-muted " +
                      (selectedId === c.id ? "bg-primary-soft" : "")
                    }
                  >
                    <span className="truncate text-sm font-medium text-foreground">
                      {c.name || c.phone}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {c.phone}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void handleRun()} disabled={!selectedId || running}>
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            Run flow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
