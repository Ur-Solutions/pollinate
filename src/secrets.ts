export function resolveSecret(value: string): string {
  if (!value.startsWith("env:")) return value;
  const envName = value.slice("env:".length);
  const secret = process.env[envName];
  if (!secret) throw new Error(`Secret env var is not set: ${envName}`);
  return secret;
}
