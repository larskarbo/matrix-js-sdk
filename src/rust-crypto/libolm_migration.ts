/*
Copyright 2023 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { Logger } from "../logger";
import { CryptoStore, MigrationState, SecretStorePrivateKeys } from "../crypto/store/base";
import * as RustSdkCryptoJs from "../../../matrix-rust-sdk-crypto-wasm";
import { IndexedDBCryptoStore } from "../crypto/store/indexeddb-crypto-store";
import { decryptAES, IEncryptedPayload } from "../crypto/aes";
import { IHttpOpts, MatrixHttpApi } from "../http-api";
import { requestKeyBackupVersion } from "./backup";
import { PickledInboundGroupSession, PickledSession } from "../../../matrix-rust-sdk-crypto-wasm";

/**
 * Determine if any data needs migrating from the legacy store, and do so.
 *
 * @param args - Arguments object.
 */
export async function migrateFromLegacyCrypto(args: {
    /** A `Logger` instance that will be used for debug output. */
    logger: Logger;

    /**
     * Low-level HTTP interface: used to make outgoing requests required by the rust SDK.
     * We expect it to set the access token, etc.
     */
    http: MatrixHttpApi<IHttpOpts & { onlyData: true }>;

    /** Store to migrate data from. */
    legacyStore: CryptoStore;

    /** Pickle key for `legacyStore`. */
    legacyPickleKey?: string;

    /** Local user's User ID. */
    userId: string;

    /** Local user's Device ID. */
    deviceId: string;

    /** Rust crypto store to migrate data into. */
    storeHandle: RustSdkCryptoJs.StoreHandle;
}): Promise<void> {
    const { logger, legacyStore } = args;

    // initialise the rust matrix-sdk-crypto-wasm, if it hasn't already been done
    await RustSdkCryptoJs.initAsync();

    // enable tracing in the rust-sdk
    new RustSdkCryptoJs.Tracing(RustSdkCryptoJs.LoggerLevel.Debug).turnOn();

    if (!(await legacyStore.containsData())) {
        // This store was never used. Nothing to migrate.
        return;
    }

    await legacyStore.startup();
    let migrationState = await legacyStore.getMigrationState();

    if (migrationState === MigrationState.MEGOLM_SESSIONS_MIGRATED) {
        // All migration is done.
        return;
    }

    const pickleKey = new TextEncoder().encode(args.legacyPickleKey);

    if (migrationState === MigrationState.NOT_STARTED) {
        logger.info("Migrating data from legacy crypto store. Step 1: base data");
        await migrateBaseData(args.http, args.userId, args.deviceId, legacyStore, pickleKey, args.storeHandle);

        migrationState = MigrationState.INITIAL_DATA_MIGRATED;
        await legacyStore.setMigrationState(migrationState);
    }

    if (migrationState === MigrationState.INITIAL_DATA_MIGRATED) {
        logger.info("Migrating data from legacy crypto store. Step 2: olm sessions");
        await migrateOlmSessions(logger, legacyStore, pickleKey, args.storeHandle);

        migrationState = MigrationState.OLM_SESSIONS_MIGRATED;
        await legacyStore.setMigrationState(migrationState);
    }

    if (migrationState === MigrationState.OLM_SESSIONS_MIGRATED) {
        logger.info("Migrating data from legacy crypto store. Step 3: megolm sessions");
        await migrateMegolmSessions(logger, legacyStore, pickleKey, args.storeHandle);

        migrationState = MigrationState.MEGOLM_SESSIONS_MIGRATED;
        await legacyStore.setMigrationState(migrationState);
    }

    logger.info("Migration from legacy crypto store complete");
}

async function migrateBaseData(
    http: MatrixHttpApi<IHttpOpts & { onlyData: true }>,
    userId: string,
    deviceId: string,
    legacyStore: CryptoStore,
    pickleKey: Uint8Array,
    storeHandle: RustSdkCryptoJs.StoreHandle,
): Promise<void> {
    const migrationData = new RustSdkCryptoJs.BaseMigrationData();
    migrationData.userId = new RustSdkCryptoJs.UserId(userId);
    migrationData.deviceId = new RustSdkCryptoJs.DeviceId(deviceId);

    await legacyStore.doTxn("readwrite", [IndexedDBCryptoStore.STORE_ACCOUNT], (txn) =>
        legacyStore.getAccount(txn, (a) => {
            migrationData.pickledAccount = a ?? "";
        }),
    );

    const recoveryKey = await getAndDecryptCachedSecretKey(legacyStore, pickleKey, "m.megolm_backup.v1");

    // If we have a backup recovery key, we need to try to figure out which backup version it is for.
    // All we can really do is ask the server for the most recent version.
    if (recoveryKey) {
        const backupInfo = await requestKeyBackupVersion(http);
        if (backupInfo) {
            migrationData.backupVersion = backupInfo.version;
            migrationData.backupRecoveryKey = recoveryKey;
        }
    }

    migrationData.crossSigningMasterKey = await getAndDecryptCachedSecretKey(legacyStore, pickleKey, "master");
    migrationData.crossSigningSelfSigningKey = await getAndDecryptCachedSecretKey(
        legacyStore,
        pickleKey,
        "self_signing",
    );
    migrationData.crossSigningUserSigningKey = await getAndDecryptCachedSecretKey(
        legacyStore,
        pickleKey,
        "user_signing",
    );
    await RustSdkCryptoJs.Migration.migrateBaseData(migrationData, pickleKey, storeHandle);
}

async function migrateOlmSessions(
    logger: Logger,
    legacyStore: CryptoStore,
    pickleKey: Uint8Array,
    storeHandle: RustSdkCryptoJs.StoreHandle,
): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const batch = await legacyStore.getEndToEndSessionsBatch();
        if (batch === null) return;

        logger.debug(`Migrating batch of ${batch.length} olm sessions`);
        const migrationData: PickledSession[] = [];
        for (const session of batch) {
            const pickledSession = new PickledSession();
            pickledSession.senderKey = session.deviceKey!;
            pickledSession.pickle = session.session!;
            pickledSession.lastUseTime = pickledSession.creationTime = new Date(session.lastReceivedMessageTs!);
            migrationData.push(pickledSession);
        }

        await RustSdkCryptoJs.Migration.migrateOlmSessions(migrationData, pickleKey, storeHandle);
        await legacyStore.deleteEndToEndSessionsBatch(batch);
    }
}

async function migrateMegolmSessions(
    logger: Logger,
    legacyStore: CryptoStore,
    pickleKey: Uint8Array,
    storeHandle: RustSdkCryptoJs.StoreHandle,
): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const batch = await legacyStore.getEndToEndInboundGroupSessionsBatch();
        if (batch === null) return;

        logger.debug(`Migrating batch of ${batch.length} megolm sessions`);
        const migrationData: PickledInboundGroupSession[] = [];
        for (const session of batch) {
            const pickledSession = new PickledInboundGroupSession();
            pickledSession.pickle = session.sessionData!.session;
            pickledSession.roomId = new RustSdkCryptoJs.RoomId(session.sessionData!.room_id);
            pickledSession.senderKey = session.senderKey;
            pickledSession.senderSigningKey = session.sessionData!.keysClaimed["ed25519"];
            pickledSession.backedUp = !session.needsBackup;

            // Not sure if we can reliably distinguish imported vs not-imported sessions in the libolm database.
            // For now at least, let's be conservative and say that all the sessions are imported (which means that
            // the Rust SDK treats them as less secure).
            pickledSession.imported = true;

            migrationData.push(pickledSession);
        }

        await RustSdkCryptoJs.Migration.migrateMegolmSessions(migrationData, pickleKey, storeHandle);
        await legacyStore.deleteEndToEndInboundGroupSessionsBatch(batch);
    }
}

async function getAndDecryptCachedSecretKey(
    legacyStore: CryptoStore,
    legacyPickleKey: Uint8Array,
    name: string,
): Promise<string | undefined> {
    let encodedKey: IEncryptedPayload | null = null;

    await legacyStore.doTxn("readonly", "account", (txn) => {
        legacyStore.getSecretStorePrivateKey(
            txn,
            (k) => {
                encodedKey = k as IEncryptedPayload | null;
            },
            name as keyof SecretStorePrivateKeys,
        );
    });

    return encodedKey === null ? undefined : await decryptAES(encodedKey, legacyPickleKey, name);
}
