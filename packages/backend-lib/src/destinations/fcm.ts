import { Static, Type } from "@sinclair/typebox";
import { credential, ServiceAccount } from "firebase-admin";
import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging, Message } from "firebase-admin/messaging";
import {
  jsonParseSafe,
  schemaValidateWithErr,
} from "isomorphic-lib/src/resultHandling/schemaValidation";
import { err, ok, Result } from "neverthrow";

export const FcmKey = Type.Object({
  project_id: Type.String(),
  client_email: Type.String(),
  private_key: Type.String(),
});

export type FcmKey = Static<typeof FcmKey>;

const FcmKeyRing = Type.Object({
  default: Type.Optional(FcmKey),
  projects: Type.Record(Type.String(), FcmKey),
});

function toServiceAccount(fcmKey: FcmKey): ServiceAccount {
  return {
    projectId: fcmKey.project_id,
    privateKey: fcmKey.private_key,
    clientEmail: fcmKey.client_email,
  };
}

function extractServiceAccounts(
  fcmKeyString: string,
  routingKeys: string[] = [],
): Result<ServiceAccount[], Error> {
  return jsonParseSafe(fcmKeyString).andThen((parsed) => {
    const direct = schemaValidateWithErr(parsed, FcmKey);
    if (direct.isOk()) return ok([toServiceAccount(direct.value)]);

    const keyRing = schemaValidateWithErr(parsed, FcmKeyRing);
    if (keyRing.isErr()) return err(keyRing.error);
    const normalizedProjects = new Map(
      Object.entries(keyRing.value.projects).map(([name, account]) => [
        name.toLowerCase(),
        account,
      ]),
    );
    const selected = routingKeys
      .map((key) => normalizedProjects.get(key.toLowerCase()))
      .find((account) => account !== undefined);
    const candidates = [
      selected,
      normalizedProjects.get("*"),
      keyRing.value.default,
      ...Object.values(keyRing.value.projects),
    ].filter((account): account is FcmKey => account !== undefined);
    const uniqueCandidates = [
      ...new Map(
        candidates.map((account) => [account.project_id, account]),
      ).values(),
    ];
    if (uniqueCandidates.length === 0) {
      return err(
        new Error(
          `No Firebase service account configured for ${routingKeys.join(", ") || "default route"}`,
        ),
      );
    }
    return ok(uniqueCandidates.map(toServiceAccount));
  });
}

export function extractServiceAccount(
  fcmKeyString: string,
  routingKeys: string[] = [],
): Result<ServiceAccount, Error> {
  return extractServiceAccounts(fcmKeyString, routingKeys).andThen(
    (accounts) => {
      const account = accounts[0];
      return account
        ? ok(account)
        : err(new Error("No Firebase service account configured"));
    },
  );
}

function isSenderMismatch(error: unknown): boolean {
  const candidate = schemaValidateWithErr(
    error,
    Type.Object(
      {
        code: Type.Optional(Type.String()),
        message: Type.Optional(Type.String()),
      },
      { additionalProperties: true },
    ),
  );
  if (candidate.isErr()) return false;
  return (
    candidate.value.code === "messaging/mismatched-credential" ||
    /sender.?id mismatch|credential/i.test(candidate.value.message ?? "")
  );
}

export async function sendNotification({
  key,
  routingKeys,
  ...message
}: Message & { key: string; routingKeys?: string[] }): Promise<
  Result<string, Error>
> {
  const serviceAccounts = extractServiceAccounts(key, routingKeys);
  if (serviceAccounts.isErr()) {
    return err(serviceAccounts.error);
  }
  let lastError: unknown;
  for (const [index, serviceAccount] of serviceAccounts.value.entries()) {
    const { projectId } = serviceAccount;
    if (!projectId) {
      return err(new Error("Firebase service account is missing project_id"));
    }
    const appName = `dittofeed-${projectId}`;
    const app = getApps().some((candidate) => candidate.name === appName)
      ? getApp(appName)
      : initializeApp({ credential: credential.cert(serviceAccount) }, appName);
    try {
      // Candidate credentials must be attempted in routing order.
      // eslint-disable-next-line no-await-in-loop
      return ok(await getMessaging(app).send(message));
    } catch (error) {
      lastError = error;
      const hasFallback = index < serviceAccounts.value.length - 1;
      if (!hasFallback || !isSenderMismatch(error)) throw error;
    }
  }
  return err(
    lastError instanceof Error
      ? lastError
      : new Error("Firebase notification failed"),
  );
}
