#!/usr/bin/env bun
/**
 * Live A/B of reasoning replay against a deployed gateway (!770).
 *
 * Runs a deterministic multi-step tool task (an upgrade pre-flight check over
 * fixture files) and sends every step twice with the identical request body:
 *   - "replayed": AI_GATEWAY_API_KEY, the user whose earlier reasoning the
 *     gateway stores and sends back;
 *   - "control": AI_GATEWAY_CONTROL_API_KEY, a different user. Reasoning is
 *     never shared between users, so the same request goes out without
 *     Claude's earlier thinking.
 * The conversation continues with the replayed response. The report compares
 * output tokens, time and settled cost per step; step 1 has nothing to replay
 * and shows the noise between two identical requests.
 *
 * This spends real money (a large max-effort Opus step costs about $1.40, and
 * every step runs twice). It stops once the settled cost reaches --max-cost.
 *
 *   GATEWAY_URL=https://gateway.example.com \
 *   AI_GATEWAY_API_KEY=aig_... AI_GATEWAY_CONTROL_API_KEY=aig_... \
 *   bun scripts/reasoning-replay-ab.ts --model claude-opus --effort max --steps 8 --max-cost 25
 */
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    model: { type: "string", default: "claude-opus" },
    effort: { type: "string", default: "max" },
    steps: { type: "string", default: "8" },
    "max-cost": { type: "string", default: "25" },
  },
});
const base = process.env.GATEWAY_URL?.replace(/\/$/, "");
const replayKey = process.env.AI_GATEWAY_API_KEY;
const controlKey = process.env.AI_GATEWAY_CONTROL_API_KEY;
if (!base || !replayKey || !controlKey) {
  throw new Error("Set GATEWAY_URL, AI_GATEWAY_API_KEY and AI_GATEWAY_CONTROL_API_KEY (keys of two different users)");
}
const maxSteps = Number(args.steps);
const maxCost = Number(args["max-cost"]);

const FILES: Record<string, string> = {
  "cluster/nodes.txt": `NAME        ROLES           VERSION    CPU   MEMORY   PODS     CONDITIONS
cp-1        control-plane   v1.31.4    8     32Gi     41/110   Ready
cp-2        control-plane   v1.31.4    8     32Gi     39/110   Ready
cp-3        control-plane   v1.31.2    8     32Gi     40/110   Ready,MemoryPressure
worker-1    <none>          v1.31.4    32    128Gi    104/110  Ready
worker-2    <none>          v1.31.4    32    128Gi    97/110   Ready
worker-3    <none>          v1.30.9    32    128Gi    88/110   Ready`,
  "kube-system/coredns-configmap.yaml": `apiVersion: v1
kind: ConfigMap
metadata: { name: coredns, namespace: kube-system }
data:
  Corefile: |
    .:53 {
        errors
        health { lameduck 5s }
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa { pods insecure; fallthrough in-addr.arpa ip6.arpa }
        prometheus :9153
        forward . /etc/resolv.conf { max_concurrent 1000 }
        cache 30
        loop
        reload
        loadbalance
        import /etc/coredns/custom/*.override
    }`,
  "kube-system/coredns-deployment.yaml": `apiVersion: apps/v1
kind: Deployment
metadata: { name: coredns, namespace: kube-system }
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: coredns
          image: registry.k8s.io/coredns/coredns:v1.10.1
          volumeMounts: [{ name: custom-config, mountPath: /etc/coredns/custom }]
      volumes:
        - name: custom-config
          configMap: { name: coredns-custom, optional: false }`,
  "kube-system/coredns-custom.yaml": "# ConfigMap coredns-custom: not found in kube-system (kubectl get cm coredns-custom -n kube-system => NotFound)",
  "etcd/backup-cronjob.yaml": `apiVersion: batch/v1
kind: CronJob
metadata: { name: etcd-backup, namespace: kube-system }
spec:
  schedule: "0 */6 * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          nodeSelector: { node-role.kubernetes.io/control-plane: "" }
          containers:
            - name: backup
              image: registry.k8s.io/etcd:3.5.12-0
              command: ["/bin/sh", "-c", "etcdctl snapshot save /backup/etcd-$(date +%F-%H%M).db && find /backup -mtime +3 -delete"]
              volumeMounts: [{ name: backup, mountPath: /backup }]
          volumes: [{ name: backup, hostPath: { path: /var/backups/etcd } }]`,
  "etcd/backup-jobs.txt": `NAME                     COMPLETIONS   DURATION   AGE
etcd-backup-29372160     1/1           41s        2d
etcd-backup-29372520     0/1           6h         36h
etcd-backup-29372880     0/1           6h         30h
etcd-backup-29373240     0/1           6h         24h
etcd-backup-29373600     0/1           6h         18h
last failure: "Error: context deadline exceeded" (snapshot save, endpoint https://127.0.0.1:2379)`,
  "kubelet/config.yaml": `apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cgroupDriver: systemd
featureGates:
  KubeletInUserNamespace: true
  DisableCloudProviders: true
maxPods: 110
evictionHard: { memory.available: "100Mi", nodefs.available: "10%" }
seccompDefault: false`,
  "manifests/flowschema.yaml": `apiVersion: flowcontrol.apiserver.k8s.io/v1beta3
kind: FlowSchema
metadata: { name: batch-jobs }
spec:
  priorityLevelConfiguration: { name: workload-low }
  matchingPrecedence: 1000`,
  "manifests/ingress-api.yaml": `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: api, namespace: prod }
spec:
  ingressClassName: traefik
  rules: [{ host: api.example.com, http: { paths: [{ path: /, pathType: Prefix, backend: { service: { name: api, port: { number: 80 } } } }] } }]`,
  "manifests/pdb-payments.yaml": `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: payments, namespace: prod }
spec:
  maxUnavailable: 0
  selector: { matchLabels: { app: payments } }`,
};

const SYSTEM = "You are a meticulous SRE assistant. Investigate with the tools before concluding. Call exactly one tool per turn, then wait for its result.";
const QUESTION = "We upgrade this Kubernetes cluster from 1.31 to 1.32 tomorrow morning. Do a thorough pre-flight check: nodes and version skew, CoreDNS, the etcd backups, kubelet configuration, removed APIs and anything that would block node drains. Read every relevant file, then give a go/no-go with the blocking items first.";
const TOOLS = [
  { type: "function", function: { name: "list_files", description: "List the files of the cluster snapshot.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "read_file", description: "Read one file of the cluster snapshot.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
];

function runTool(name: string, args: string): string {
  if (name === "list_files") return Object.keys(FILES).join("\n");
  if (name === "read_file") {
    let path = "";
    try { path = String((JSON.parse(args) as { path?: unknown }).path ?? ""); } catch { /* reported below */ }
    return FILES[path] ?? `No such file: ${path}. Use list_files.`;
  }
  return `Unknown tool ${name}`;
}

interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
interface StepResult {
  content: string;
  reasoningChars: number;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number; cost?: number; prompt_tokens_details?: { cached_tokens?: number } };
  seconds: number;
}

async function chat(key: string, body: unknown, requestId: string): Promise<StepResult> {
  const started = performance.now();
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-request-id": requestId },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) throw new Error(`${requestId}: HTTP ${response.status} ${await response.text()}`);
  const result: StepResult = { content: "", reasoningChars: 0, toolCalls: [], finishReason: null, usage: {}, seconds: 0 };
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      if (!data || data === "[DONE]") continue;
      const chunk = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>;
        usage?: StepResult["usage"];
      };
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) result.content += choice.delta.content;
      if (choice?.delta?.reasoning_content) result.reasoningChars += choice.delta.reasoning_content.length;
      for (const delta of choice?.delta?.tool_calls ?? []) {
        const call = result.toolCalls[delta.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
        if (delta.id) call.id = delta.id;
        if (delta.function?.name) call.function.name = delta.function.name;
        if (delta.function?.arguments) call.function.arguments += delta.function.arguments;
      }
      if (choice?.finish_reason) result.finishReason = choice.finish_reason;
      if (chunk.usage) result.usage = chunk.usage;
    }
  }
  result.seconds = (performance.now() - started) / 1000;
  return result;
}

const runId = `ab-${Date.now().toString(36)}`;
const messages: unknown[] = [{ role: "system", content: SYSTEM }, { role: "user", content: QUESTION }];
const rows: Array<{ step: number; replayed: StepResult; control: StepResult }> = [];
let spent = 0;
for (let step = 1; step <= maxSteps; step++) {
  const body = { model: args.model, stream: true, reasoning_effort: args.effort, tools: TOOLS, messages };
  const [replayed, control] = await Promise.all([
    chat(replayKey, body, `${runId}-${step}-replayed`),
    chat(controlKey, body, `${runId}-${step}-control`),
  ]);
  rows.push({ step, replayed, control });
  spent += (replayed.usage.cost ?? 0) + (control.usage.cost ?? 0);
  const out = (result: StepResult) => `${String(result.usage.completion_tokens ?? "?").padStart(6)} out ${result.seconds.toFixed(0).padStart(4)}s $${(result.usage.cost ?? 0).toFixed(2)}`;
  console.log(`step ${step}: replayed ${out(replayed)} | control ${out(control)} | ${replayed.toolCalls.map((call) => `${call.function.name}(${call.function.arguments})`).join(", ") || "final answer"}`);
  // Continue with the replayed response exactly as received, so the gateway finds its reasoning.
  messages.push({ role: "assistant", content: replayed.content || null, ...(replayed.toolCalls.length > 0 && { tool_calls: replayed.toolCalls }) });
  if (replayed.toolCalls.length === 0) break;
  for (const call of replayed.toolCalls) messages.push({ role: "tool", tool_call_id: call.id, content: runTool(call.function.name, call.function.arguments) });
  if (spent >= maxCost) {
    console.log(`Stopping: settled cost $${spent.toFixed(2)} reached --max-cost`);
    break;
  }
}

const later = rows.filter((row) => row.step > 1);
const total = (pick: (row: (typeof rows)[number]) => number) => later.reduce((sum, row) => sum + pick(row), 0);
const summary = {
  runId, gateway: base, model: args.model, effort: args.effort, steps: rows.length, spent,
  stepsAfterFirst: later.length,
  outputTokens: { replayed: total((row) => row.replayed.usage.completion_tokens ?? 0), control: total((row) => row.control.usage.completion_tokens ?? 0) },
  seconds: { replayed: total((row) => row.replayed.seconds), control: total((row) => row.control.seconds) },
  cost: { replayed: total((row) => row.replayed.usage.cost ?? 0), control: total((row) => row.control.usage.cost ?? 0) },
};
console.log(JSON.stringify(summary, null, 2));
await mkdir(".data", { recursive: true });
const reportPath = `.data/reasoning-replay-${runId}.json`;
await writeFile(reportPath, JSON.stringify({ summary, rows, messages }, null, 2));
console.log(`Report: ${reportPath} (search the gateway log for request=${runId} to see replayed blocks per step)`);
