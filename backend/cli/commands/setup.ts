import { LocalClient } from "../client";
import { CliError } from "../errors";
import type { Command, CommandGroup } from "../framework";
import { choosePassword, PASSWORD_OPTIONS, stringOption } from "../inputs";
import { formatTime, printJson } from "../output";
import { report, requiredOption, requireLocal, revealSecret } from "./common";

const status: Command = {
  name: "status",
  summary: "Show whether first-boot setup is still open",
  async run(context) {
    await requireLocal(context, "aigctl setup");
    const { getSetupStatus } = await import("../../setup");
    const setup = await getSetupStatus();
    if (context.output === "json") return printJson(context.io, setup);
    context.io.out(setup.required
      ? "Setup is open: no user exists yet. Create the first administrator with 'aigctl setup init'.\n"
      : `Setup is complete${setup.completedAt ? ` (since ${formatTime(setup.completedAt)})` : ""}.\n`);
  },
};

const init: Command = {
  name: "init",
  summary: "Create the first administrator and close setup for good",
  details: `Does what the /setup page does, from inside the gateway container, so a new installation never has to
expose an open setup page. Without --password-stdin or --generate-password, aigctl asks for the password
(use kubectl exec -it). Passwords need 12-128 characters with a letter and a number.`,
  options: {
    username: { type: "string", value: "<username>", description: "Sign-in name: 3-40 letters, digits, dots, underscores or hyphens (required)" },
    email: { type: "string", value: "<email>", description: "Email address (required)" },
    name: { type: "string", value: "<name>", description: "Display name (default: the username)" },
    ...PASSWORD_OPTIONS,
  },
  examples: ["kubectl exec -it deploy/ai-gateway-ai-gateway -- aigctl setup init --username admin --email admin@example.com --name 'Gateway Admin'"],
  async run(context) {
    const username = requiredOption(context, "username");
    const email = requiredOption(context, "email");
    const name = stringOption(context.options.name)?.trim() || username;
    const client = await requireLocal(context, "aigctl setup");
    const { createInitialAdministrator, getSetupStatus, SetupError, validateLocalAccount } = await import("../../setup");
    try {
      // Check the account fields before asking for a password.
      validateLocalAccount({ username, email, name, password: "valid-password-1" });
    } catch (error) {
      throw new CliError(error instanceof Error ? error.message : String(error));
    }
    if (!(await getSetupStatus()).required) throw new CliError("Setup is already complete; create more users with 'aigctl users create'");
    const { password, generated } = await choosePassword(context, username);
    let administrator: { id: string; username: string; email: string };
    try {
      const via = client instanceof LocalClient ? client.principal.actorId : "aigctl";
      administrator = await createInitialAdministrator({ username, email, name, password }, crypto.randomUUID(), { via });
    } catch (error) {
      if (error instanceof SetupError) throw new CliError(error.message);
      throw error;
    }
    const signIn = context.io.env.BASE_URL?.trim() ? ` Sign in at ${context.io.env.BASE_URL.trim()}.` : "";
    const message = `Created the administrator ${administrator.username} and closed setup.${signIn}`;
    const result = { ...administrator, role: "admin" };
    if (generated) revealSecret(context, `${message} The generated password is shown only once:`, password, { ...result, password });
    else report(context, message, result);
  },
};

export const setupGroup: CommandGroup = {
  name: "setup",
  summary: "First-boot setup: create the first administrator",
  details: "Runs only inside the gateway container.",
  commands: [status, init],
};
