import { createFileRoute } from "@richie-router/react";
import { useEffect, useState } from "react";
import { IconFlask, IconTrash, IconUpload } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { managementFetch } from "../../management-api";
import { loadPublicConfig, type PublicConfig } from "../../config";

type Branding = { revision: number; productName: string; tagline: string; logoUrl: string | null; faviconUrl: string | null; primaryColor: string; primaryForegroundColor: string };
type Aws = {
  revision: number; defaultRegion: string | null; accessKeyId: string | null; secretAccessKey: { configured: boolean }; sessionToken: { configured: boolean };
  lastTestedAt?: string | null; lastTestSucceeded?: boolean | null; lastTestMessage?: string | null;
};
type Model = { id: string; modelId: string; name: string; region: string | null; enabled: boolean };

export const Route = createFileRoute("/admin/settings")({ component: Settings });

function Settings() {
  const [brand, setBrand] = useState<Branding | null>(null);
  const [publicConfig, setPublicConfig] = useState<PublicConfig | null>(null);
  const [aws, setAws] = useState<Aws | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [awsForm, setAwsForm] = useState({ defaultRegion: "", accessKeyId: "", secretAccessKey: "", sessionToken: "" });
  const [testModel, setTestModel] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const [branding, awsResult, modelResult, runtime] = await Promise.all([
        managementFetch<{ data: Branding }>("/branding"), managementFetch<{ data: Aws }>("/aws"),
        managementFetch<{ data: Model[] }>("/models"), loadPublicConfig(true),
      ]);
      setBrand(branding.data); setAws(awsResult.data); setModels(modelResult.data); setPublicConfig(runtime);
      setAwsForm((current) => ({ ...current, defaultRegion: awsResult.data.defaultRegion ?? "" }));
      setTestModel((current) => current || modelResult.data.find((model) => model.enabled)?.modelId || "");
      setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load settings"); }
  };
  useEffect(() => { void load(); }, []);

  const run = async (action: () => Promise<void>, success: string) => {
    setSaving(true); setError(null); setMessage("");
    try { await action(); setMessage(success); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Update failed"); }
    finally { setSaving(false); }
  };

  const upload = async (kind: "logo" | "favicon", file?: File) => {
    if (!file) return;
    await run(async () => {
      await managementFetch(`/branding/assets/${kind}`, { method: "POST", body: file, headers: { "content-type": file.type } });
      await load();
    }, `${kind === "logo" ? "Logo" : "Favicon"} uploaded`);
  };

  if (!brand || !aws) return <p>{error ?? "Loading settings…"}</p>;
  return <div className="space-y-5">
    <div><h1 className="text-2xl font-semibold">Branding & AWS</h1><p className="text-sm text-muted-foreground">Runtime product identity and encrypted Bedrock credentials.</p></div>
    {error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    {message && <p className="rounded-md bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-400">{message}</p>}
    <div className="grid gap-5 xl:grid-cols-2">
      <Card><CardHeader><CardTitle>Branding</CardTitle><CardDescription>Text, colors, URLs, and uploads update at runtime without rebuilding.</CardDescription></CardHeader><CardContent>
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void run(async () => {
          const result = await managementFetch<{ data: Branding }>("/branding", { method: "PUT", body: JSON.stringify(brand) });
          setBrand(result.data); setPublicConfig(await loadPublicConfig(true));
        }, "Branding saved"); }}>
          <div><Label>Product name</Label><Input value={brand.productName} onChange={(event) => setBrand({ ...brand, productName: event.target.value })} required /></div>
          <div><Label>Tagline</Label><Input value={brand.tagline} onChange={(event) => setBrand({ ...brand, tagline: event.target.value })} /></div>
          <div className="grid gap-3 sm:grid-cols-2"><div><Label>Primary color</Label><Input type="color" className="h-10" value={brand.primaryColor} onChange={(event) => setBrand({ ...brand, primaryColor: event.target.value })} /></div><div><Label>Primary foreground</Label><Input type="color" className="h-10" value={brand.primaryForegroundColor} onChange={(event) => setBrand({ ...brand, primaryForegroundColor: event.target.value })} /></div></div>
          <div><Label>External logo URL</Label><Input type="url" placeholder="https://…" value={brand.logoUrl ?? ""} onChange={(event) => setBrand({ ...brand, logoUrl: event.target.value || null })} /></div>
          <div><Label>External favicon URL</Label><Input type="url" placeholder="https://…" value={brand.faviconUrl ?? ""} onChange={(event) => setBrand({ ...brand, faviconUrl: event.target.value || null })} /></div>
          <Button disabled={saving}>Save branding</Button>
        </form>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Asset kind="logo" title="Logo upload" currentUrl={publicConfig?.brand.logoUrl ?? null} accept="image/png,image/jpeg,image/webp" disabled={saving} onUpload={(file) => void upload("logo", file)} onDelete={() => void run(async () => { await managementFetch("/branding/assets/logo", { method: "DELETE" }); await load(); }, "Uploaded logo removed")} />
          <Asset kind="favicon" title="Favicon upload" currentUrl={publicConfig?.brand.faviconUrl ?? null} accept="image/png,image/x-icon" disabled={saving} onUpload={(file) => void upload("favicon", file)} onDelete={() => void run(async () => { await managementFetch("/branding/assets/favicon", { method: "DELETE" }); await load(); }, "Uploaded favicon removed")} />
        </div>
      </CardContent></Card>

      <Card><CardHeader><CardTitle>AWS Bedrock</CardTitle><CardDescription>Credentials are encrypted. Blank secret fields preserve existing values.</CardDescription></CardHeader><CardContent className="space-y-5">
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void run(async () => {
          const result = await managementFetch<{ data: Aws }>("/aws", { method: "PUT", body: JSON.stringify({
            revision: aws.revision, defaultRegion: awsForm.defaultRegion,
            accessKeyId: awsForm.accessKeyId || undefined,
            secretAccessKey: awsForm.secretAccessKey ? { operation: "replace", value: awsForm.secretAccessKey } : { operation: "preserve" },
            sessionToken: awsForm.sessionToken ? { operation: "replace", value: awsForm.sessionToken } : { operation: "preserve" },
          }) });
          setAws(result.data); setAwsForm({ defaultRegion: result.data.defaultRegion ?? "", accessKeyId: "", secretAccessKey: "", sessionToken: "" });
        }, "AWS settings saved"); }}>
          <div><Label>Default region</Label><Input placeholder="us-east-1" value={awsForm.defaultRegion} onChange={(event) => setAwsForm({ ...awsForm, defaultRegion: event.target.value })} /></div>
          <div><Label>Access key ID {aws.accessKeyId ? `(current ${aws.accessKeyId})` : ""}</Label><Input autoComplete="off" placeholder={aws.accessKeyId ? "Leave blank to preserve" : "AKIA…"} value={awsForm.accessKeyId} onChange={(event) => setAwsForm({ ...awsForm, accessKeyId: event.target.value })} /></div>
          <div><Label>Secret access key {aws.secretAccessKey.configured ? "(configured)" : ""}</Label><Input type="password" autoComplete="new-password" placeholder={aws.secretAccessKey.configured ? "Leave blank to preserve" : "Required with access key ID"} value={awsForm.secretAccessKey} onChange={(event) => setAwsForm({ ...awsForm, secretAccessKey: event.target.value })} /></div>
          <div><Label>Session token {aws.sessionToken.configured ? "(configured)" : "(optional)"}</Label><div className="flex gap-2"><Input type="password" autoComplete="new-password" placeholder={aws.sessionToken.configured ? "Leave blank to preserve" : "Optional"} value={awsForm.sessionToken} onChange={(event) => setAwsForm({ ...awsForm, sessionToken: event.target.value })} />{aws.sessionToken.configured && <Button type="button" variant="outline" onClick={() => void run(async () => {
            const result = await managementFetch<{ data: Aws }>("/aws", { method: "PUT", body: JSON.stringify({ revision: aws.revision, defaultRegion: aws.defaultRegion, secretAccessKey: { operation: "preserve" }, sessionToken: { operation: "clear" } }) }); setAws(result.data);
          }, "Session token cleared")}>Clear token</Button>}</div></div>
          <div className="flex flex-wrap gap-2"><Button disabled={saving}>Save AWS settings</Button>{aws.accessKeyId && <Button type="button" variant="destructive" onClick={() => {
            if (!window.confirm("Clear AWS credentials? Enabled models will stop working until credentials are configured again.")) return;
            void run(async () => { const result = await managementFetch<{ data: Aws }>("/aws", { method: "PUT", body: JSON.stringify({ revision: aws.revision, defaultRegion: null, accessKeyId: null, secretAccessKey: { operation: "clear" }, sessionToken: { operation: "clear" } }) }); setAws(result.data); setAwsForm({ defaultRegion: "", accessKeyId: "", secretAccessKey: "", sessionToken: "" }); }, "AWS credentials cleared");
          }}><IconTrash />Clear credentials</Button>}</div>
        </form>
        <div className="space-y-2 rounded-lg border p-4"><Label>Connection test model</Label><div className="flex gap-2"><Select value={testModel} onValueChange={setTestModel}><SelectTrigger className="flex-1"><SelectValue placeholder="Select configured model" /></SelectTrigger><SelectContent>{models.map((model) => <SelectItem key={model.id} value={model.modelId}>{model.name} ({model.modelId})</SelectItem>)}</SelectContent></Select><Button variant="outline" disabled={!testModel || saving} onClick={() => void run(async () => {
          const result = await managementFetch<{ success: boolean; message: string }>("/aws/test", { method: "POST", body: JSON.stringify({ modelId: testModel }) }); setMessage(result.message); await load();
        }, "Bedrock connection succeeded")}><IconFlask />Test</Button></div>{aws.lastTestedAt && <p className={`text-xs ${aws.lastTestSucceeded ? "text-green-700 dark:text-green-400" : "text-destructive"}`}>{aws.lastTestMessage} · {new Date(aws.lastTestedAt).toLocaleString()}</p>}</div>
      </CardContent></Card>
    </div>
  </div>;
}

function Asset({ title, currentUrl, accept, disabled, onUpload, onDelete }: { kind: string; title: string; currentUrl: string | null; accept: string; disabled: boolean; onUpload: (file?: File) => void; onDelete: () => void }) {
  return <div className="space-y-2 rounded-lg border p-3"><Label>{title}</Label>{currentUrl ? <img src={currentUrl} alt="" className="h-12 max-w-full object-contain" /> : <p className="text-xs text-muted-foreground">No active asset</p>}<div className="flex flex-wrap gap-2"><Label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm"><IconUpload size={16} />Upload<input type="file" className="sr-only" accept={accept} disabled={disabled} onChange={(event) => { onUpload(event.target.files?.[0]); event.currentTarget.value = ""; }} /></Label><Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onDelete}>Remove upload</Button></div><p className="text-xs text-muted-foreground">Max 512 KiB. An upload takes precedence over the external URL.</p></div>;
}
