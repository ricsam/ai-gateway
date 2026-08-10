import { createFileRoute } from "@richie-router/react";
import { useEffect, useState } from "react";
import { IconFlask, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { managementFetch } from "../../management-api";
import { loadPublicConfig } from "../../config";

type ProviderType = "oidc" | "trusted_header";
type Provider = {
  id: string;
  type: ProviderType;
  providerKey: string;
  label: string;
  enabled: boolean;
  revision: number;
  config: Record<string, unknown>;
  secret: { configured: boolean };
  lastTestedAt: string | null;
  lastTestSucceeded: boolean | null;
  lastTestMessage: string | null;
};
type Form = {
  type: ProviderType; providerKey: string; label: string; enabled: boolean; secret: string;
  issuer: string; discoveryUrl: string; clientId: string; scopes: string; pkce: boolean; autoProvision: boolean; linkExistingUsersByEmail: boolean;
  subjectClaim: string; emailClaim: string; nameClaim: string; usernameClaim: string;
  subjectHeader: string; emailHeader: string; nameHeader: string; usernameHeader: string; secretHeader: string; sourceCidrs: string;
};
const blank: Form = {
  type: "oidc", providerKey: "", label: "", enabled: false, secret: "", issuer: "", discoveryUrl: "", clientId: "",
  scopes: "openid profile email", pkce: true, autoProvision: true, linkExistingUsersByEmail: false,
  subjectClaim: "sub", emailClaim: "email", nameClaim: "name", usernameClaim: "preferred_username",
  subjectHeader: "x-auth-subject", emailHeader: "x-auth-email", nameHeader: "x-auth-name", usernameHeader: "x-auth-username",
  secretHeader: "x-ai-gateway-proxy-secret", sourceCidrs: "",
};

export const Route = createFileRoute("/admin/authentication")({ component: Authentication });

function Authentication() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [editing, setEditing] = useState<Provider | "new" | null>(null);
  const [form, setForm] = useState<Form>(blank);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try { setProviders((await managementFetch<{ data: Provider[] }>("/auth/providers")).data); setError(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load login providers"); }
  };
  useEffect(() => { void load(); }, []);

  const open = (provider?: Provider) => {
    setEditing(provider ?? "new");
    const config = provider?.config ?? {};
    const stringValue = (key: string, fallback = "") => typeof config[key] === "string" ? String(config[key]) : fallback;
    setForm(provider ? {
      ...blank,
      type: provider.type,
      providerKey: provider.providerKey,
      label: provider.label,
      enabled: provider.enabled,
      issuer: stringValue("issuer"), discoveryUrl: stringValue("discoveryUrl"), clientId: stringValue("clientId"),
      scopes: Array.isArray(config.scopes) ? config.scopes.join(" ") : blank.scopes,
      pkce: config.pkce !== false, autoProvision: config.autoProvision !== false, linkExistingUsersByEmail: config.linkExistingUsersByEmail === true,
      subjectClaim: stringValue("subjectClaim", blank.subjectClaim), emailClaim: stringValue("emailClaim", blank.emailClaim), nameClaim: stringValue("nameClaim", blank.nameClaim), usernameClaim: stringValue("usernameClaim", blank.usernameClaim),
      subjectHeader: stringValue("subjectHeader", blank.subjectHeader), emailHeader: stringValue("emailHeader", blank.emailHeader), nameHeader: stringValue("nameHeader", blank.nameHeader), usernameHeader: stringValue("usernameHeader", blank.usernameHeader), secretHeader: stringValue("secretHeader", blank.secretHeader),
      sourceCidrs: Array.isArray(config.sourceCidrs) ? config.sourceCidrs.join("\n") : "",
    } : blank);
  };

  const configForForm = () => form.type === "oidc" ? {
    issuer: form.issuer.trim() || undefined,
    discoveryUrl: form.discoveryUrl.trim() || undefined,
    clientId: form.clientId.trim(),
    scopes: form.scopes.split(/[\s,]+/).filter(Boolean), pkce: form.pkce,
    autoProvision: form.autoProvision, linkExistingUsersByEmail: form.linkExistingUsersByEmail,
    subjectClaim: form.subjectClaim.trim(), emailClaim: form.emailClaim.trim(), nameClaim: form.nameClaim.trim(), usernameClaim: form.usernameClaim.trim(),
  } : {
    subjectHeader: form.subjectHeader.trim().toLowerCase(), emailHeader: form.emailHeader.trim().toLowerCase(), nameHeader: form.nameHeader.trim().toLowerCase(), usernameHeader: form.usernameHeader.trim().toLowerCase(),
    secretHeader: form.secretHeader.trim().toLowerCase(), sourceCidrs: form.sourceCidrs.split(/[\s,]+/).filter(Boolean), autoProvision: form.autoProvision,
  };

  const save = async () => {
    setSaving(true); setError(null); setMessage(null);
    try {
      if (editing === "new") {
        await managementFetch("/auth/providers", { method: "POST", body: JSON.stringify({
          type: form.type, providerKey: form.providerKey.trim().toLowerCase(), label: form.label.trim(), enabled: false,
          config: configForForm(), secret: { operation: "replace", value: form.secret },
        }) });
      } else if (editing) {
        const nextConfig = configForForm();
        const enabling = form.enabled && !editing.enabled;
        await managementFetch(`/auth/providers/${editing.id}`, { method: "PATCH", body: JSON.stringify({
          revision: editing.revision, label: form.label.trim(), enabled: form.enabled,
          ...(enabling ? {} : { config: nextConfig }),
          secret: enabling ? { operation: "preserve" } : form.secret ? { operation: "replace", value: form.secret } : { operation: "preserve" },
        }) });
      }
      setEditing(null); setMessage("Login provider saved"); await Promise.all([load(), loadPublicConfig(true)]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save login provider"); }
    finally { setSaving(false); }
  };

  const test = async (provider: Provider) => {
    setError(null); setMessage(null);
    try {
      const result = await managementFetch<{ success: boolean; message: string }>(`/auth/providers/${provider.id}/test`, { method: "POST" });
      setMessage(result.message); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Provider test failed"); await load(); }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold">Authentication</h1><p className="text-sm text-muted-foreground">Configure multiple OIDC providers or explicit trusted-header integrations without restarting.</p></div><Button onClick={() => open()}><IconPlus />Add provider</Button></div>
      <Card><CardHeader><CardTitle className="text-base">Local accounts</CardTitle><CardDescription>Username/password login remains enabled as the administrator recovery path. Public self-registration is disabled.</CardDescription></CardHeader></Card>
      {error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {message && <p className="rounded-md bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-400">{message}</p>}
      <div className="grid gap-3 md:grid-cols-2">
        {providers.map((provider) => <Card key={provider.id}><CardHeader><div className="flex items-start justify-between gap-3"><div><CardTitle>{provider.label}</CardTitle><CardDescription><code>{provider.providerKey}</code> · {provider.type === "oidc" ? "OpenID Connect" : "Trusted headers"}</CardDescription></div><Badge variant={provider.enabled ? "default" : "secondary"}>{provider.enabled ? "Enabled" : "Disabled"}</Badge></div></CardHeader><CardContent className="space-y-3"><p className="text-xs text-muted-foreground">Secret: {provider.secret.configured ? "configured" : "missing"}{provider.lastTestMessage ? ` · Last test: ${provider.lastTestMessage}` : ""}</p><div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => open(provider)}><IconPencil />Edit</Button><Button variant="outline" size="sm" onClick={() => void test(provider)}><IconFlask />Test</Button><Button variant="ghost" size="sm" onClick={async () => { if (!window.confirm(`Delete ${provider.label}?`)) return; await managementFetch(`/auth/providers/${provider.id}`, { method: "DELETE" }); await Promise.all([load(), loadPublicConfig(true)]); }}><IconTrash />Delete</Button></div></CardContent></Card>)}
        {!providers.length && <p className="text-sm text-muted-foreground">No external login providers configured.</p>}
      </div>

      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{editing === "new" ? "Add login provider" : `Edit ${form.label}`}</DialogTitle></DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Provider type"><Select value={form.type} disabled={editing !== "new"} onValueChange={(type) => setForm({ ...form, type: type as ProviderType })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="oidc">OpenID Connect</SelectItem><SelectItem value="trusted_header">Trusted headers</SelectItem></SelectContent></Select></Field>
            <Field label="Provider key"><Input value={form.providerKey} disabled={editing !== "new"} placeholder="customer-oidc" onChange={(event) => setForm({ ...form, providerKey: event.target.value })} /></Field>
            <Field label="Display label"><Input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} /></Field>
            <Field label={form.type === "oidc" ? (editing === "new" ? "Client secret" : "Replacement client secret") : (editing === "new" ? "Shared proxy secret" : "Replacement shared secret")}><Input type="password" autoComplete="new-password" value={form.secret} placeholder={editing === "new" ? "Required" : "Leave blank to preserve"} onChange={(event) => setForm({ ...form, secret: event.target.value })} /></Field>
            {form.type === "oidc" ? <>
              <Field label="Issuer URL"><Input value={form.issuer} placeholder="https://id.customer.example" onChange={(event) => setForm({ ...form, issuer: event.target.value })} /></Field>
              <Field label="Discovery URL"><Input value={form.discoveryUrl} placeholder="Optional; defaults to issuer metadata" onChange={(event) => setForm({ ...form, discoveryUrl: event.target.value })} /></Field>
              <Field label="Client ID"><Input value={form.clientId} onChange={(event) => setForm({ ...form, clientId: event.target.value })} /></Field>
              <Field label="Scopes"><Input value={form.scopes} onChange={(event) => setForm({ ...form, scopes: event.target.value })} /></Field>
              <Field label="Subject claim"><Input value={form.subjectClaim} onChange={(event) => setForm({ ...form, subjectClaim: event.target.value })} /></Field>
              <Field label="Email claim"><Input value={form.emailClaim} onChange={(event) => setForm({ ...form, emailClaim: event.target.value })} /></Field>
              <Field label="Name claim"><Input value={form.nameClaim} onChange={(event) => setForm({ ...form, nameClaim: event.target.value })} /></Field>
              <Field label="Username claim"><Input value={form.usernameClaim} onChange={(event) => setForm({ ...form, usernameClaim: event.target.value })} /></Field>
              <Toggle label="Use PKCE" checked={form.pkce} onChange={(pkce) => setForm({ ...form, pkce })} />
              <Toggle label="Link existing users by email" checked={form.linkExistingUsersByEmail} onChange={(linkExistingUsersByEmail) => setForm({ ...form, linkExistingUsersByEmail })} />
            </> : <>
              <Field label="Subject header"><Input value={form.subjectHeader} onChange={(event) => setForm({ ...form, subjectHeader: event.target.value })} /></Field>
              <Field label="Email header"><Input value={form.emailHeader} onChange={(event) => setForm({ ...form, emailHeader: event.target.value })} /></Field>
              <Field label="Name header"><Input value={form.nameHeader} onChange={(event) => setForm({ ...form, nameHeader: event.target.value })} /></Field>
              <Field label="Username header"><Input value={form.usernameHeader} onChange={(event) => setForm({ ...form, usernameHeader: event.target.value })} /></Field>
              <Field label="Shared-secret header"><Input value={form.secretHeader} onChange={(event) => setForm({ ...form, secretHeader: event.target.value })} /></Field>
              <Field label="Allowed proxy peer CIDRs"><Input value={form.sourceCidrs} placeholder="10.0.0.0/8, 192.0.2.10/32 (required)" onChange={(event) => setForm({ ...form, sourceCidrs: event.target.value })} /></Field>
            </>}
            <Toggle label="Auto-provision users" checked={form.autoProvision} onChange={(autoProvision) => setForm({ ...form, autoProvision })} />
            <Toggle label="Provider enabled" checked={form.enabled} onChange={(enabled) => setForm({ ...form, enabled })} />
          </div>
          {editing === "new" && form.enabled && <p className="rounded-md bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">New providers are created disabled. Test the saved configuration, then edit it again to enable sign-in.</p>}
          {editing && editing !== "new" && form.enabled && !editing.enabled && <p className="rounded-md bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">When enabling, only the enabled state is saved. Save and test any configuration or secret changes first.</p>}
          {form.type === "oidc" && form.linkExistingUsersByEmail && <p className="rounded-md bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">The sole enabled OIDC provider may attach an existing account by exact email on first sign-in. Use only for a tenant that controls those addresses; the immutable provider subject is stored after linking.</p>}
          {form.type === "trusted_header" && <p className="rounded-md bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">Only enable this when a trusted proxy strips all client identity headers, sets the configured values, and supplies the shared secret.</p>}
          <DialogFooter><Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={() => void save()} disabled={saving || !form.providerKey.trim() || !form.label.trim() || (editing === "new" && !form.secret) || (form.type === "trusted_header" && !form.sourceCidrs.trim())}>Save provider</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>; }
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) { return <label className="flex items-center gap-2 self-end rounded-md border px-3 py-2 text-sm"><Switch checked={checked} onCheckedChange={onChange} />{label}</label>; }
