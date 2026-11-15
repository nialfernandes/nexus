// The words the command prints in front of a value, and the names of the environment variables it reads, in one place, so the
// command, its README and its tests all say the same thing.

/** The environment variables the commands read. A key is never an argument: it would show in the process list and in a shell's history. */
export const ENV = {
  /** The address Nexus's routes sit under, such as https://nexus.example.org/nexus/api. */
  address: "NEXUS_ADDRESS",
  /** A sign-in token: the owner's for create-vault and approve-agent, the agent's own for read, write and list. */
  token: "NEXUS_TOKEN",
  /** The agent's private key, as `keygen` printed it. */
  privateKey: "NEXUS_AGENT_PRIVATE_KEY",
  /** The agent's approval, as `approve-agent` printed it. */
  approval: "NEXUS_AGENT_APPROVAL",
} as const;

/** What stands before each value on its own line of the command's output. A value that is a secret says so. */
export const LABEL = {
  privateKey: "PRIVATE KEY (secret, keep it in your secrets manager)",
  publicKey: "PUBLIC KEY (safe to share)",
  publicKeyCode: "PUBLIC KEY CODE",
  token: "TOKEN (shown once, secret)",
  recoveryKey: "RECOVERY KEY (secret, write it down now)",
  vaultId: "VAULT ID",
  approval: "APPROVAL (keep it beside the agent's private key)",
} as const;
