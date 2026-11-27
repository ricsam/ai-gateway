import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { MonthlyCreditMode } from "@/shared/credit-control";
import {
  creditControlDetails, monthlyRunPreview, parseCreditControlDraft, type CreditControl, type CreditControlDraft,
} from "../lib/credit-control";

/** A short summary of an account's credit control for tables. */
export function CreditControlSummary({ control, monthlySpendRemaining }: { control: CreditControl; monthlySpendRemaining?: number | null }) {
  const rollover = control.monthlyCreditMode === "rollover";
  return (
    <div className="space-y-0.5 text-xs">
      <Badge variant={rollover ? "secondary" : "outline"}>{rollover ? "Rollover" : "Reset"}</Badge>
      {creditControlDetails(control, monthlySpendRemaining).map((line) => <p key={line} className="text-muted-foreground">{line}</p>)}
    </div>
  );
}

/** The monthly credit mode, rollover cap and max monthly spend inputs. */
export function CreditControlFields({ draft, onChange, idPrefix }: { draft: CreditControlDraft; onChange: (draft: CreditControlDraft) => void; idPrefix: string }) {
  const rollover = draft.monthlyCreditMode === "rollover";
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={`${idPrefix}-mode`}>Monthly credit mode</Label>
        <Select value={draft.monthlyCreditMode} onValueChange={(monthlyCreditMode) => onChange({ ...draft, monthlyCreditMode: monthlyCreditMode as MonthlyCreditMode })}>
          <SelectTrigger id={`${idPrefix}-mode`} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="reset">Reset: the balance is set to the monthly quota; unspent credits expire</SelectItem>
            <SelectItem value="rollover">Rollover: the monthly quota is added to the balance; unspent credits carry over</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-cap`}>Rollover cap ($)</Label>
        <Input id={`${idPrefix}-cap`} type="number" min="0" step="0.01" placeholder={rollover ? "No cap" : "Rollover only"} disabled={!rollover} value={draft.rolloverCap} onChange={(event) => onChange({ ...draft, rolloverCap: event.target.value })} />
        <p className="text-xs text-muted-foreground">The most the balance can bank. Quota that would take it past the cap is trimmed, and skipped at or above it.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-limit`}>Max monthly spend ($)</Label>
        <Input id={`${idPrefix}-limit`} type="number" min="0" step="0.01" placeholder="No limit" value={draft.monthlySpendLimit} onChange={(event) => onChange({ ...draft, monthlySpendLimit: event.target.value })} />
        <p className="text-xs text-muted-foreground">The most the account can be charged in a UTC month, whatever its balance. Applies in both modes.</p>
      </div>
    </div>
  );
}

/** Edits credit control in a dialog; `preview` shows what the next monthly run would do for one account. */
export function CreditControlDialog({ open, title, description, initial, preview, saving, onCancel, onSave }: {
  open: boolean;
  title: string;
  description?: string;
  initial: CreditControlDraft;
  preview?: { monthlyCredits: number; balance: number };
  saving: boolean;
  onCancel: () => void;
  onSave: (control: CreditControl) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  // Start from the account's values each time the dialog opens, not on every render of its parent.
  useEffect(() => { if (open) { setDraft(initial); setError(null); } }, [open]);
  let parsed: CreditControl | null = null;
  try { parsed = parseCreditControlDraft(draft); } catch { parsed = null; }
  const save = () => {
    try { onSave(parseCreditControlDraft(draft)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Invalid credit control"); }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <CreditControlFields draft={draft} onChange={(next) => { setDraft(next); setError(null); }} idPrefix="credit-control" />
        {preview && parsed && <p className="rounded-md bg-muted/50 p-3 text-sm" data-testid="monthly-run-preview">{monthlyRunPreview(parsed, preview.monthlyCredits, preview.balance)}</p>}
        {error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button disabled={saving} onClick={save}>Save credit control</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
