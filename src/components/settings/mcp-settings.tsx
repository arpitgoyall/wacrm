'use client';

// ============================================================
// McpSettings — Settings → MCP connector
//
// Explains how to connect AI assistants (Claude.ai, ChatGPT, Claude
// Code, Cursor) to this workspace over MCP. The primary path is OAuth:
// paste the connector URL, sign in, approve. No key to copy.
// Connected apps appear as `OAuth: <app name>` in Settings → API keys.
// ============================================================

import { useState } from 'react';
import { toast } from 'sonner';
import { Check, Copy, KeyRound } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';

// Public domain of this deployment. Override with NEXT_PUBLIC_APP_URL.
const BASE_URL = (
  process.env.NEXT_PUBLIC_APP_URL || 'https://whatsapp.aerocadmy.com'
).replace(/\/+$/, '');
const MCP_URL = `${BASE_URL}/api/mcp`;

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`${label} copied`);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy — select the text and copy manually');
    }
  }
  return (
    <Button type="button" variant="outline" size="sm" onClick={copy}>
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground">
        {code}
      </pre>
      <CopyButton value={code} label={label} />
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-primary">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {children ? (
          <div className="text-sm text-muted-foreground">{children}</div>
        ) : null}
      </div>
    </li>
  );
}

export function McpSettings() {
  const claudeCode = `claude mcp add --transport http wacrm ${MCP_URL}`;

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title="MCP connector"
        description="Let AI assistants like Claude and ChatGPT read your CRM and take actions in natural language. Sign in with OAuth — no API key to copy."
      />

      <Card>
        <CardContent className="space-y-3 pt-6">
          <div className="text-sm font-semibold text-foreground">
            Connector URL
          </div>
          <CodeBlock code={MCP_URL} label="Connector URL" />
          <p className="text-xs text-muted-foreground">
            Paste this into your assistant&apos;s custom connector settings.
            Leave any client ID / secret fields empty — the app registers itself.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="text-sm font-semibold text-foreground">
            Connect with OAuth
          </div>
          <ol className="space-y-4">
            <Step n={1} title="Add a custom connector">
              In <strong>Claude.ai</strong>: Settings → Connectors → Add custom
              connector. In <strong>ChatGPT</strong>: Settings → Connectors →
              Create. Paste the connector URL above.
            </Step>
            <Step n={2} title="Sign in to wacrm">
              A consent page opens. Sign in with a wacrm account — an{' '}
              <strong>admin or owner</strong> must approve.
            </Step>
            <Step n={3} title="Choose permissions and approve">
              Tick only what the assistant needs. With read-only scopes it
              can&apos;t send anything; <code className="text-xs">send_message</code>{' '}
              and <code className="text-xs">send_broadcast</code> appear only if
              you grant <code className="text-xs">messages:send</code> /{' '}
              <code className="text-xs">broadcasts:send</code>.
            </Step>
            <Step n={4} title="Start chatting">
              Try: &quot;How many conversations are still open today?&quot;
            </Step>
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 pt-6">
          <div className="text-sm font-semibold text-foreground">
            Good to know
          </div>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>
              Access tokens last 1 hour and refresh automatically; a connection
              expires after 90 days of inactivity.
            </li>
            <li>
              Each connected app appears in <strong>API keys</strong> as{' '}
              <code className="text-xs">OAuth: &lt;app name&gt;</code>. Revoke
              it there to disconnect it immediately.
            </li>
            <li>Webhook management is never available through OAuth.</li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 pt-6">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <KeyRound className="size-4" /> Client without OAuth support?
          </div>
          <p className="text-sm text-muted-foreground">
            Create a key in <strong>API keys</strong> with only the scopes you
            need, then pass it as a header. Example for Claude Code:
          </p>
          <CodeBlock
            code={`${claudeCode} --header "Authorization: Bearer wacrm_live_xxxxxxxx"`}
            label="Command"
          />
          <p className="text-xs text-muted-foreground">
            Or, with OAuth, simply run the command below and follow the prompt:
          </p>
          <CodeBlock code={claudeCode} label="Command" />
        </CardContent>
      </Card>
    </section>
  );
}
