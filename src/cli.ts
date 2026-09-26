import { main } from "./runtime.ts";
main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : "GitLab bot failed");
  process.exitCode = 1;
  // A failed managed child must not remain alive just because its readiness
  // channel still has listeners. The parent receives failure, never a receipt.
  if (process.argv.includes('--managed-start') && process.connected) process.disconnect?.();
});
