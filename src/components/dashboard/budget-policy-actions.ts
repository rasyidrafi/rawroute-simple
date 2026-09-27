export type BudgetPolicySnapshot = {
  hasData: boolean;
  loading: boolean;
  error?: string;
};

export function budgetPolicyActionsDisabled(
  snapshot: BudgetPolicySnapshot,
): boolean {
  return !snapshot.hasData || snapshot.loading || Boolean(snapshot.error);
}

/**
 * Confirmation dialogs can outlive the snapshot that authorized them. Recheck
 * at confirmation time so a stale dialog can never submit a policy mutation.
 */
export function runBudgetPolicyAction(
  snapshot: BudgetPolicySnapshot,
  closeConfirmation: () => void,
  action: () => void,
): boolean {
  if (budgetPolicyActionsDisabled(snapshot)) {
    closeConfirmation();
    return false;
  }
  action();
  return true;
}
