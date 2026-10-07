import "server-only";
import { accountCopies, accountSummary, deleteAccountCopy, restoreAccountCopy } from "./account";
import { usesCloud } from "./scope";
import { deleteLocalCopy, localCopies, localSummary, restoreLocal } from "./store/local-db";
import type { DataCopy, DataSummary } from "@/lib/types";

/*
 * Copies of the data in use, kept before Settings → Data replaces it (Load sample data, Start empty, or putting a
 * copy back), so each of those can be undone there: the account's in the account itself (account_copies, account.ts),
 * this computer's own in files next to it (store/local-db.ts). The newest ten of each stay.
 */

export async function dataCopies(): Promise<DataCopy[]> {
  return (await usesCloud()) ? accountCopies() : localCopies();
}

export async function dataSummary(): Promise<DataSummary> {
  return (await usesCloud()) ? accountSummary() : localSummary();
}

export async function restoreCopy(id: string) {
  if (await usesCloud()) await restoreAccountCopy(id);
  else restoreLocal(id);
}

export async function deleteCopy(id: string) {
  if (await usesCloud()) await deleteAccountCopy(id);
  else deleteLocalCopy(id);
}
