import { apiCommand } from "./commands/api";
import { authProvidersGroup } from "./commands/auth-providers";
import { awsGroup, brandingGroup, modelsGroup, settingsGroup } from "./commands/config";
import { groupsGroup } from "./commands/groups";
import { managementKeysGroup } from "./commands/management-keys";
import { analyticsGroup, auditGroup, creditsGroup, usageGroup } from "./commands/reports";
import { setupGroup } from "./commands/setup";
import { apiKeysGroup, usersGroup } from "./commands/users";
import type { Program } from "./framework";

export const program: Program = {
  name: "aigctl",
  overview: `aigctl manages an AI Gateway: users, groups, keys, credits, settings, AWS, login providers, usage and audit history.

Usage:
  aigctl <command> <subcommand> [arguments] [options]

Inside the gateway container, aigctl works on the gateway's database directly. Your access to the pod is the
authority (it already holds the database credentials), and changes are audited as cli aigctl@<pod>:
  kubectl exec -it deploy/<release>-ai-gateway -- aigctl users list

Anywhere else, aigctl uses a gateway's management API with a management key:
  export AI_GATEWAY_MANAGEMENT_KEY=aigm_...
  aigctl --server https://gateway.example.com users list`,
  entries: [
    setupGroup,
    usersGroup,
    apiKeysGroup,
    groupsGroup,
    creditsGroup,
    managementKeysGroup,
    modelsGroup,
    settingsGroup,
    brandingGroup,
    awsGroup,
    authProvidersGroup,
    auditGroup,
    usageGroup,
    analyticsGroup,
    apiCommand,
  ],
};
