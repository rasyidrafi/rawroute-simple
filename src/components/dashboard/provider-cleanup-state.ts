export async function runProviderCleanupRetry(
  retry: () => Promise<unknown>,
): Promise<string | null> {
  try {
    await retry();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Cleanup retry failed.";
  }
}
