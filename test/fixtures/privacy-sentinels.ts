import type { PrivacyReasonCode, SourceClassification } from "../../src/privacy.ts";

export interface PrivacySentinel {
  name: string;
  value: string;
  classification?: SourceClassification;
  reason: PrivacyReasonCode;
}

export const PRIVACY_SENTINELS: readonly PrivacySentinel[] = [
  { name: "email", value: "Contact jane.doe@example.com", reason: "pii-pattern" },
  { name: "phone", value: "Call +1 (415) 555-0134", reason: "pii-pattern" },
  { name: "ip address", value: "Host 192.168.10.24 failed", reason: "pii-pattern" },
  { name: "GitHub token", value: "ghp_0123456789abcdefghijklmnopqrstuvwxyz", reason: "secret-pattern" },
  { name: "OpenAI key", value: "sk-proj-0123456789abcdefghijklmnop", reason: "secret-pattern" },
  { name: "private key", value: "-----BEGIN PRIVATE KEY-----", reason: "secret-pattern" },
  { name: "POSIX path", value: "Read /home/alice/project/config.ts", reason: "path-bearing" },
  { name: "Windows path", value: "Read C:\\Users\\Alice\\secret.txt", reason: "path-bearing" },
  { name: "UNC path", value: "Read \\\\server\\share\\file", reason: "path-bearing" },
  { name: "code fence", value: "```ts\nconst token = 1;\n```", reason: "code-fenced" },
  { name: "shell prompt", value: "$ npm test\nFAIL test.ts", reason: "terminal-shaped" },
  { name: "PowerShell prompt", value: "PS C:\\> Get-ChildItem", reason: "terminal-shaped" },
  { name: "environment dump", value: "DATABASE_URL=postgres://localhost/db", reason: "raw-environment" },
  {
    name: "terminal classification",
    value: "Tests require the package-local command.",
    classification: "terminal-output",
    reason: "unsafe-source",
  },
  {
    name: "customer classification",
    value: "The account uses a custom setting.",
    classification: "customer-data",
    reason: "unsafe-source",
  },
  {
    name: "unclassified source",
    value: "Prefer the package-local command.",
    classification: "unclassified",
    reason: "unsafe-source",
  },
];
