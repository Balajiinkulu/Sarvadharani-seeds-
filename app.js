
    const firebaseConfig = {
        apiKey: "AIzaSyDssPwJJfCpDJCdxqDlrSzMDqWn4xJdvLI",
        authDomain: "sarvadharani-seeds-31db6.firebaseapp.com",
        projectId: "sarvadharani-seeds-31db6",
        storageBucket: "sarvadharani-seeds-31db6.firebasestorage.app",
        messagingSenderId: "867103212119",
        appId: "1:867103212119:web:e4464711483d2098a95912",
        measurementId: "G-SXHC1DQKQT"
    };

    firebase.initializeApp(firebaseConfig);
    const cloudDb = firebase.firestore();
    const cloudAuth = firebase.auth();

    // Real Firebase Authentication (email/password) — each staff member
    // signs in with their own account (created ahead of time by an admin
    // in the Firebase Console: Authentication > Users > Add user, not
    // self-registered here). Firestore's security rule checks this same
    // sign-in via `request.auth != null`, so the login screen and the
    // database access are backed by the same real accounts. See
    // handleAdminLogin() further down for where sign-in actually happens.

    // Lets the app keep working with no internet and push the queued
    // changes automatically once the connection comes back.
    cloudDb.enablePersistence({ synchronizeTabs: true }).catch(err => {
        console.warn('Firestore offline persistence not enabled:', err.code);
    });

    // Two Firestore locations now, instead of one:
    //  - CLOUD_DOC: parties, stock items, accounts, groups, settings —
    //    small, changes rarely, stays as one shared document.
    //  - TXN_COL: one document PER VOUCHER. Previously every voucher lived
    //    inside a single giant array on CLOUD_DOC, so posting/editing/
    //    deleting ANY voucher re-uploaded the ENTIRE transaction history,
    //    and the whole dataset was capped by Firestore's 1MB per-document
    //    limit. Splitting transactions into their own collection means a
    //    single voucher change only ever moves that one small record.
    const CLOUD_DOC = cloudDb.collection('sarvadharaniSeeds').doc('appData');
    const TXN_COL = cloudDb.collection('sarvadharaniSeeds_transactions');
    // Append-only audit trail: one document per action, never edited or
    // deleted. Kept in its own collection (not inside the voucher) so the
    // record survives the voucher itself being deleted — which is exactly
    // the case you most need a trail for.
    const AUDIT_COL = cloudDb.collection('sarvadharaniSeeds_audit');
    let auditLog = JSON.parse(localStorage.getItem('tally_mob_audit')) || [];

    // Records who did what, to which voucher, and when. Called at the point
    // a change is actually committed, so a cancelled or failed action leaves
    // no entry. Writes straight to Firestore rather than going through the
    // debounced sync, because an audit entry must not be lost if the tab is
    // closed a moment later.
    function logAudit(action, txn, extra) {
        try {
            const entry = {
                id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
                action: action,                       // Created | Edited | Deleted
                invNo: (txn && txn.invNo) || '',
                type: (txn && (txn.customVoucherTypeName || txn.type)) || '',
                party: (txn && txn.partyName) || '',
                amount: (txn && txn.grandTotal) || 0,
                user: currentUserEmail() || 'unknown',
                at: Date.now(),
                note: extra || ''
            };
            auditLog.unshift(entry);
            // Keep the local cache bounded; the full history stays in the cloud.
            if (auditLog.length > 500) auditLog = auditLog.slice(0, 500);
            localStorage.setItem('tally_mob_audit', JSON.stringify(auditLog));
            if (typeof renderAuditTrail === 'function'
                && document.getElementById('panelAuditTrail')
                && document.getElementById('panelAuditTrail').classList.contains('active')) {
                renderAuditTrail();
            }
            AUDIT_COL.doc(entry.id).set(entry).catch(err => console.error('Audit write failed:', err));
        } catch (e) { console.error('Audit log error:', e); }
    }


    // ---- Master records: one document each, same as transactions ----
    // Parties, stock items, accounts and the groups used to travel as whole
    // ARRAYS inside CLOUD_DOC. That made every edit a rewrite of the entire
    // list, so two devices editing two DIFFERENT records at roughly the
    // same moment each wrote their own full copy — and the slower write
    // silently erased the other person's change. Giving every record its
    // own document means editing one party can never touch another,
    // exactly as TXN_COL already does for vouchers.
    //
    // CLOUD_DOC keeps receiving the same fields it always did, but is now
    // only a mirror/backup — these collections are what actually gets read
    // back. Settings that aren't id-keyed records (refCounter, subLedgers,
    // userRoles) really are single shared values, so they stay on
    // CLOUD_DOC and are unaffected by any of this.
    const MASTER_SPECS = [
        { name: 'parties',            lsKey: 'tally_mob_parties',      get: () => parties,            set: v => { parties = v; } },
        { name: 'stockItems',         lsKey: 'tally_mob_stock',        get: () => stockItems,         set: v => { stockItems = v; } },
        { name: 'accounts',           lsKey: 'tally_mob_accounts',     get: () => accounts,           set: v => { accounts = v; } },
        { name: 'stockGroups',        lsKey: 'tally_mob_stockgroups',  get: () => stockGroups,        set: v => { stockGroups = v; } },
        { name: 'ledgerGroups',       lsKey: 'tally_mob_ledgergroups', get: () => ledgerGroups,       set: v => { ledgerGroups = v; } },
        { name: 'customVoucherTypes', lsKey: 'tally_mob_vouchertypes', get: () => customVoucherTypes, set: v => { customVoucherTypes = v; } }
    ];
    MASTER_SPECS.forEach(s => {
        s.ref = cloudDb.collection('sarvadharaniSeeds_' + s.name);
        s.bootstrapped = false;   // this collection has been read at least once
        s.lastSynced = new Map(); // id -> JSON of what we last confirmed saved
        s.reconciled = false;     // first snapshot has been handled
        s.emptyAtStart = null;    // was it empty on that first read?
        s.legacyFromMeta = null;  // the old CLOUD_DOC array, once read
    });

    let cloudBootstrapped = false;   // CLOUD_DOC has been read at least once
    let txnBootstrapped = false;     // TXN_COL has been read at least once
    let cloudPushTimer = null;
    let txnPushTimer = null;
    let masterPushTimer = null;

    // What we last confirmed is saved in TXN_COL, keyed by id (as a JSON
    // string of the row) — lets syncCloud() diff the in-memory list
    // against it and only write the rows that actually changed, instead
    // of re-uploading every voucher on every save.
    let lastSyncedTxnSnapshot = new Map();

    // Splits a batch of Firestore writes into chunks of at most 400 (the
    // hard limit is 500 ops per batch) so a large one-time migration or
    // bulk change can never silently fail from exceeding it.
    function commitInChunks(ops) {
        const CHUNK = 400;
        let chain = Promise.resolve();
        for (let i = 0; i < ops.length; i += CHUNK) {
            const slice = ops.slice(i, i + CHUNK);
            chain = chain.then(() => {
                const batch = cloudDb.batch();
                slice.forEach(op => op(batch));
                return batch.commit();
            });
        }
        return chain;
    }

    // Push current in-memory metadata (everything except transactions) to
    // Firestore (debounced so a burst of edits doesn't fire a write per
    // keystroke).
    //
    // IMPORTANT: this refuses to run until cloudBootstrapped is true —
    // i.e. until we've heard back from Firestore at least once. Without
    // this guard, a brand-new device (empty localStorage) could push its
    // empty starting state to the cloud and wipe out real data before its
    // very first read from Firestore had a chance to come back.
    function syncCloud() {
        if (!cloudBootstrapped) return;
        clearTimeout(cloudPushTimer);
        cloudPushTimer = setTimeout(() => {
            CLOUD_DOC.set({
                parties, stockItems, accounts,
                stockGroups, ledgerGroups, refCounter, subLedgers,
                customVoucherTypes, userRoles, updatedAt: Date.now()
            }, { merge: true }).catch(err => console.error('Cloud sync failed:', err));
        }, 400);
        syncTxnsCloud();
        syncMastersCloud();
    }

    // Push only the master records that actually changed, one document per
    // record — same debounce-and-diff approach as syncTxnsCloud() above, so
    // editing a single party writes exactly one small document instead of
    // re-uploading every party, item and account.
    //
    // Each collection refuses to write until its own first read has come
    // back (s.bootstrapped), for the same reason syncCloud() waits on
    // cloudBootstrapped: a device that hasn't heard from Firestore yet
    // would otherwise push its empty starting state over real data.
    function syncMastersCloud() {
        clearTimeout(masterPushTimer);
        masterPushTimer = setTimeout(() => {
            MASTER_SPECS.forEach(s => {
                if (!s.bootstrapped) return;
                const rows = s.get() || [];
                const ops = [];
                const seenIds = new Set();

                rows.forEach(r => {
                    if (!r || r.id == null) return;
                    const id = String(r.id);
                    seenIds.add(id);
                    const json = JSON.stringify(r);
                    if (s.lastSynced.get(id) !== json) ops.push(batch => batch.set(s.ref.doc(id), r));
                });
                s.lastSynced.forEach((_, id) => {
                    if (!seenIds.has(id)) ops.push(batch => batch.delete(s.ref.doc(id)));
                });

                if (ops.length === 0) return;
                commitInChunks(ops).then(() => {
                    s.lastSynced = new Map(
                        (s.get() || []).filter(r => r && r.id != null).map(r => [String(r.id), JSON.stringify(r)])
                    );
                }).catch(err => console.error('Cloud sync failed:', err));
            });
        }, 400);
    }

    // Push only the transactions that changed since the last confirmed
    // sync — same debounce pattern as syncCloud(), but diffs against
    // lastSyncedTxnSnapshot first so a single new/edited/deleted voucher
    // becomes one small write instead of re-uploading the whole ledger.
    function syncTxnsCloud() {
        if (!txnBootstrapped) return;
        clearTimeout(txnPushTimer);
        txnPushTimer = setTimeout(() => {
            const ops = [];
            const seenIds = new Set();

            transactions.forEach(t => {
                const id = String(t.id);
                seenIds.add(id);
                const json = JSON.stringify(t);
                if (lastSyncedTxnSnapshot.get(id) !== json) {
                    ops.push(batch => batch.set(TXN_COL.doc(id), t));
                }
            });
            lastSyncedTxnSnapshot.forEach((_, id) => {
                if (!seenIds.has(id)) ops.push(batch => batch.delete(TXN_COL.doc(id)));
            });

            if (ops.length === 0) return;
            commitInChunks(ops).then(() => {
                lastSyncedTxnSnapshot = new Map(transactions.map(t => [String(t.id), JSON.stringify(t)]));
            }).catch(err => console.error('Cloud sync failed:', err));
        }, 400);
    }

    // Apply metadata that came from Firestore (this device's own confirmed
    // write, or a change made on another device) into memory + the local
    // cache, then redraw. Transactions are handled separately by
    // applyTxnChanges() below, via the TXN_COL listener.
    function applyCloudData(data) {
        if (!data) return;
        // The master arrays on this document are now only a mirror — the
        // per-record collections above are what's authoritative, and their
        // own listeners apply them. All we take from here is a copy to seed
        // those collections from, the one time they're still empty.
        MASTER_SPECS.forEach(s => {
            s.legacyFromMeta = Array.isArray(data[s.name]) ? data[s.name] : [];
        });

        // Genuinely single shared values (not id-keyed records), so these
        // stay on this document and are still read straight from it.
        refCounter = data.refCounter || { Payment: 0, Receipt: 0 };
        subLedgers = data.subLedgers || [];
        userRoles = data.userRoles || {};

        localStorage.setItem('tally_mob_refcounter', JSON.stringify(refCounter));
        localStorage.setItem('tally_mob_subledgers', JSON.stringify(subLedgers));
        localStorage.setItem('tally_mob_userroles', JSON.stringify(userRoles));

        if (typeof render === 'function') render();
    }

    // Applies incremental added/modified/removed changes from a master
    // collection's listener into the in-memory array + local cache.
    function applyMasterChanges(spec, docChanges) {
        const arr = (spec.get() || []).slice();
        docChanges.forEach(change => {
            const id = change.doc.id;
            const idx = arr.findIndex(r => r && String(r.id) === id);
            if (change.type === 'removed') {
                if (idx !== -1) arr.splice(idx, 1);
            } else {
                const data = change.doc.data();
                if (idx !== -1) arr[idx] = data; else arr.push(data);
            }
        });
        spec.set(arr);
        localStorage.setItem(spec.lsKey, JSON.stringify(arr));
        if (typeof render === 'function') render();
    }

    // Live listener per master collection — mirrors the TXN_COL listener:
    // the first non-empty read is treated as the authoritative full list,
    // and everything after that is applied as incremental changes.
    function startMasterListeners() {
        MASTER_SPECS.forEach(s => {
            s.ref.onSnapshot(snap => {
                if (snap.metadata.hasPendingWrites) { s.bootstrapped = true; return; }

                if (!s.reconciled) {
                    s.reconciled = true;
                    s.emptyAtStart = snap.empty;
                    // Empty may simply mean the one-time migration below
                    // hasn't run yet, so don't wipe the local cache for it.
                    if (!snap.empty) {
                        s.set(snap.docs.map(d => d.data()));
                        localStorage.setItem(s.lsKey, JSON.stringify(s.get()));
                        if (typeof render === 'function') render();
                    }
                } else {
                    applyMasterChanges(s, snap.docChanges());
                }
                s.lastSynced = new Map(snap.docs.map(d => [d.id, JSON.stringify(d.data())]));
                s.bootstrapped = true;
                maybeMigrateLegacyMasters();
            }, err => console.error('Cloud listener error:', err));
        });
    }

    // One-time seed of the per-record collections from the old arrays on
    // CLOUD_DOC, using the same shape as the transaction migration: only
    // runs for a collection that was still empty on its first read, only
    // ever writes the same ids with set() (never add()), so it's safe if
    // two devices happen to run it at once.
    let masterMigrationChecked = false;
    function maybeMigrateLegacyMasters() {
        if (masterMigrationChecked) return;
        // Wait until every collection has reported in AND the metadata
        // document has been read, so we never migrate on partial info.
        if (MASTER_SPECS.some(s => s.emptyAtStart === null || s.legacyFromMeta === null)) return;
        masterMigrationChecked = true;

        const ops = [];
        MASTER_SPECS.forEach(s => {
            if (!s.emptyAtStart) return; // already migrated by this or another device
            (s.legacyFromMeta || []).forEach(r => {
                if (r && r.id != null) ops.push(batch => batch.set(s.ref.doc(String(r.id)), r));
            });
        });
        if (ops.length === 0) return;

        console.warn(`Migrating ${ops.length} master record(s) to per-record cloud storage...`);
        commitInChunks(ops)
            .then(() => console.warn('Master data migration complete.'))
            .catch(err => console.error('Cloud sync failed:', err));
    }

    // Applies incremental added/modified/removed changes from the TXN_COL
    // listener into the in-memory array + local cache, then redraws.
    function applyTxnChanges(docChanges) {
        docChanges.forEach(change => {
            const id = change.doc.id;
            const idx = transactions.findIndex(t => String(t.id) === id);
            if (change.type === 'removed') {
                if (idx !== -1) transactions.splice(idx, 1);
            } else {
                const data = change.doc.data();
                if (idx !== -1) transactions[idx] = data; else transactions.push(data);
            }
        });
        localStorage.setItem('tally_mob_db', JSON.stringify(transactions));
        if (typeof render === 'function') render();
    }

    // One-time migration from the old single-document design: the first
    // time this runs after both listeners below have reported in, if the
    // new transactions collection is still empty AND the old appData
    // document still has a legacy `transactions` array on it, copy every
    // row over as its own document, then remove the old array field.
    // Safe to run from more than one device at once — it only ever
    // re-writes the same rows with the same ids (set(), not add()), and
    // deleting an already-deleted field is a no-op.
    let legacyMigrationChecked = false;
    let legacyTxnsFromMeta = null;   // array once the metadata doc has been read, else null
    let txnCollectionEmptyAtStart = null; // boolean once TXN_COL has been read, else null
    function maybeMigrateLegacyTransactions() {
        if (legacyMigrationChecked) return;
        if (legacyTxnsFromMeta === null || txnCollectionEmptyAtStart === null) return;
        legacyMigrationChecked = true;
        if (!txnCollectionEmptyAtStart || legacyTxnsFromMeta.length === 0) return;

        console.warn(`Migrating ${legacyTxnsFromMeta.length} transaction(s) to per-voucher cloud storage...`);
        const ops = legacyTxnsFromMeta.map(t => (batch => batch.set(TXN_COL.doc(String(t.id)), t)));
        commitInChunks(ops).then(() => {
            return CLOUD_DOC.set({ transactions: firebase.firestore.FieldValue.delete() }, { merge: true });
        }).then(() => {
            console.warn('Migration to per-voucher cloud storage complete.');
        }).catch(err => console.error('Cloud sync failed:', err));
    }

    // Live listeners — fire immediately once signed in with whatever is
    // already saved, and again any time this device or ANY other device
    // (phone/laptop) changes the data. Only start after real Firebase Auth
    // confirms a signed-in user, so they line up with a Firestore rule
    // like `allow read, write: if request.auth != null`.
    let cloudListenerStarted = false;
    let txnFirstSnapshotReconciled = false;
    cloudAuth.onAuthStateChanged(user => {
        if (user && !cloudListenerStarted) {
            cloudListenerStarted = true;

            CLOUD_DOC.onSnapshot(snap => {
                if (!snap.exists) {
                    // Nothing in the cloud yet (genuinely first ever run) — mark
                    // bootstrapped FIRST, then seed the cloud with whatever this
                    // device already has.
                    cloudBootstrapped = true;
                    legacyTxnsFromMeta = [];
                    MASTER_SPECS.forEach(s => { s.legacyFromMeta = []; }); // no legacy arrays to migrate from
                    syncCloud();
                } else if (!snap.metadata.hasPendingWrites) {
                    // Confirmed server data (own write acknowledged, or a change
                    // pushed from another device) — safe to apply.
                    cloudBootstrapped = true;
                    const data = snap.data();
                    legacyTxnsFromMeta = Array.isArray(data.transactions) ? data.transactions : [];
                    applyCloudData(data);
                    ensureRoleBootstrap();
                } else {
                    cloudBootstrapped = true;
                }
                maybeMigrateLegacyTransactions();
                maybeMigrateLegacyMasters();
                hideDataLoadingBanner();
            }, err => console.error('Cloud listener error:', err));

            startMasterListeners();

            // Audit entries from every device. Ordered newest-first and
            // capped, since this collection only ever grows.
            AUDIT_COL.orderBy('at', 'desc').limit(500).onSnapshot(snap => {
                auditLog = snap.docs.map(d => d.data());
                localStorage.setItem('tally_mob_audit', JSON.stringify(auditLog));
                const p = document.getElementById('panelAuditTrail');
                if (p && p.classList.contains('active') && typeof renderAuditTrail === 'function') {
                    renderAuditTrail();
                }
            }, err => console.error('Audit listener error:', err));

            TXN_COL.onSnapshot(snap => {
                if (snap.metadata.hasPendingWrites) { txnBootstrapped = true; return; }

                if (!txnFirstSnapshotReconciled) {
                    // First read ever from this collection. If it already has
                    // data, treat it as the authoritative full list (replaces
                    // whatever was cached locally, clearing out any ghost rows
                    // left over from before this device's listener started —
                    // e.g. a voucher deleted on another device while this one
                    // was closed). If it's empty, leave the locally-cached
                    // transactions untouched for now — that emptiness may just
                    // mean the one-time migration below hasn't run yet.
                    txnFirstSnapshotReconciled = true;
                    txnCollectionEmptyAtStart = snap.empty;
                    if (!snap.empty) {
                        transactions = snap.docs.map(d => d.data());
                        localStorage.setItem('tally_mob_db', JSON.stringify(transactions));
                        if (typeof render === 'function') render();
                    }
                } else {
                    applyTxnChanges(snap.docChanges());
                }
                lastSyncedTxnSnapshot = new Map(snap.docs.map(d => [d.id, JSON.stringify(d.data())]));
                txnBootstrapped = true;
                maybeMigrateLegacyTransactions();
            }, err => console.error('Cloud listener error:', err));
        } else if (!user) {
            console.warn('Cloud sync waiting for authentication...');
        }
    });

    // The very first person ever to sign in (before any roles exist at
    // all) becomes admin automatically — after that, every other account
    // defaults to 'staff' explicitly and must be promoted by an admin.
    // This only runs once: as soon as userRoles has any entry, it does
    // nothing on subsequent logins.
    function ensureRoleBootstrap() {
        const email = cloudAuth.currentUser && cloudAuth.currentUser.email;
        if (!email) return;
        if (Object.keys(userRoles).length === 0) {
            userRoles[email] = 'admin';
            localStorage.setItem('tally_mob_userroles', JSON.stringify(userRoles));
            syncCloud();
        } else if (!(email in userRoles)) {
            userRoles[email] = 'staff';
            localStorage.setItem('tally_mob_userroles', JSON.stringify(userRoles));
            syncCloud();
        }
        if (typeof applyRolePermissions === 'function') applyRolePermissions();
    }

    function isAdmin() {
        const email = cloudAuth.currentUser && cloudAuth.currentUser.email;
        if (!email) return false;
        return userRoles[email] === 'admin';
    }

    function currentUserEmail() {
        return (cloudAuth.currentUser && cloudAuth.currentUser.email) || '';
    }


  
    // ================================================================
    // SYNC STATUS TOAST — a visible notice when cloud sync fails, so a
    // problem (e.g. Firestore silently rejecting a write because some
    // field ended up `undefined`) shows up immediately instead of only
    // surfacing much later as devices quietly drifting out of sync.
    //
    // This does NOT change how sync itself works: syncCloud(), the
    // Firestore .set()/.catch() calls, and the onSnapshot listener in the
    // Firebase block are completely untouched. Both of that block's error
    // paths already funnel through console.error('Cloud sync failed:', ...)
    // and console.error('Cloud listener error:', ...) — this just also
    // listens for those same two messages and raises a banner, while still
    // calling the browser's real console.error so logging behavior is
    // identical to before.
    // ================================================================
    (function () {
        const nativeConsoleError = console.error.bind(console);
        let toastTimer = null;

        console.error = function (...args) {
            nativeConsoleError(...args);
            const firstArg = args[0];
            if (typeof firstArg === 'string' && (
                firstArg.indexOf('Cloud sync failed') !== -1 ||
                firstArg.indexOf('Cloud listener error') !== -1
            )) {
                const errObj = args[1];
                const detail = errObj && (errObj.code || errObj.message) ? ` (${errObj.code || errObj.message})` : '';
                showSyncToast('error', "Cloud sync failed" + detail + " — your latest change may not have saved. This device will keep retrying.");
            }
        };

        window.showSyncToast = function (kind, message) {
            const el = document.getElementById('syncToast');
            const textEl = document.getElementById('syncToastText');
            if (!el || !textEl) return;
            textEl.innerText = message;
            el.classList.remove('sync-error', 'sync-recovered', 'sync-ok');
            const cls = (kind === 'recovered') ? 'sync-recovered' : (kind === 'ok') ? 'sync-ok' : 'sync-error';
            el.classList.add(cls);
            el.classList.add('show');
            clearTimeout(toastTimer);
            // Only genuine errors stay up until dismissed; both "recovered"
            // and plain "ok" confirmations are transient and self-clear.
            if (kind === 'recovered' || kind === 'ok') {
                toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'ok' ? 3000 : 5000);
            }
        };

        window.dismissSyncToast = function () {
            const el = document.getElementById('syncToast');
            if (el) el.classList.remove('show');
            clearTimeout(toastTimer);
        };

        // If a sync error banner is showing and a later write succeeds,
        // let the person know the connection recovered rather than leaving
        // a stale-looking error banner on screen indefinitely.
        let lastSyncOk = true;
        window.addEventListener('online', () => {
            if (!lastSyncOk) {
                showSyncToast('recovered', 'Back online — syncing your changes now.');
                lastSyncOk = true;
            }
        });
        window.addEventListener('offline', () => {
            lastSyncOk = false;
            showSyncToast('error', "You're offline — changes are saved on this device and will sync once you're back online.");
            // Nothing more to wait for right now — the dashboard is showing
            // whatever's on this device, and the existing offline banner
            // above already says so, so leaving "Loading latest data…" up
            // too would just be a second, redundant notice for the same
            // fact. It comes back on its own next time the page loads.
            hideDataLoadingBanner();
        });
    })();

    // Attached to window (not scoped to the IIFE above) so it's callable
    // from the Firestore onSnapshot handler wherever that's defined, the
    // same way window.showSyncToast is exposed for cross-scope use.
    window.hideDataLoadingBanner = function () {
        const el = document.getElementById('dataLoadingBanner');
        if (el) el.remove();
    };

    let parties = JSON.parse(localStorage.getItem('tally_mob_parties')) || [];  
    let stockItems = JSON.parse(localStorage.getItem('tally_mob_stock')) || [];  
    let transactions = JSON.parse(localStorage.getItem('tally_mob_db')) || [];  
    let accounts = JSON.parse(localStorage.getItem('tally_mob_accounts')) || [];
    let stockGroups = JSON.parse(localStorage.getItem('tally_mob_stockgroups')) || [];
    let ledgerGroups = JSON.parse(localStorage.getItem('tally_mob_ledgergroups')) || [];
    let refCounter = JSON.parse(localStorage.getItem('tally_mob_refcounter')) || { Payment: 0, Receipt: 0 };
    let subLedgers = JSON.parse(localStorage.getItem('tally_mob_subledgers')) || [];
    let customVoucherTypes = JSON.parse(localStorage.getItem('tally_mob_vouchertypes')) || [];
    let userRoles = JSON.parse(localStorage.getItem('tally_mob_userroles')) || {};
    let currentVoucherItems = [];

    // Seed the three default sale/purchase categories the first time only.
    if (localStorage.getItem('tally_mob_subledgers') === null) {
        subLedgers = ['Fertiliser', 'Seeds', 'Pesticides'];
        localStorage.setItem('tally_mob_subledgers', JSON.stringify(subLedgers));
        syncCloud();
    }

    // Seed sensible Tally-style default groups the very first time the app
    // runs (key never existed yet) — never re-seeds if the user later empties
    // their group lists on purpose.
    if (localStorage.getItem('tally_mob_stockgroups') === null) {
        stockGroups = [{ id: Date.now(), name: 'Primary' }];
        localStorage.setItem('tally_mob_stockgroups', JSON.stringify(stockGroups));
        syncCloud();
    }
    if (localStorage.getItem('tally_mob_ledgergroups') === null) {
        const base = Date.now();
        ledgerGroups = [
            { id: base + 1, name: 'Capital Account', nature: 'Liabilities' },
            { id: base + 2, name: 'Current Liabilities', nature: 'Liabilities' },
            { id: base + 3, name: 'Current Assets', nature: 'Assets' },
            { id: base + 4, name: 'Bank Accounts', nature: 'Assets' },
            { id: base + 5, name: 'Cash-in-Hand', nature: 'Assets' },
            { id: base + 6, name: 'Sundry Debtors', nature: 'Assets' },
            { id: base + 7, name: 'Sundry Creditors', nature: 'Liabilities' },
            { id: base + 8, name: 'Sales Account', nature: 'Income' },
            { id: base + 9, name: 'Purchase Account', nature: 'Expenses' },
            { id: base + 10, name: 'Direct Expenses', nature: 'Expenses' },
            { id: base + 11, name: 'Indirect Expenses', nature: 'Expenses' },
            { id: base + 12, name: 'Duties & Taxes', nature: 'Liabilities' }
        ];
        localStorage.setItem('tally_mob_ledgergroups', JSON.stringify(ledgerGroups));
        syncCloud();
    }

    function getStockGroupName(id) {
        const g = stockGroups.find(s => s.id == id);
        return g ? g.name : 'Uncategorized';
    }

    // Stock Summary — filterable by category (stock group) via the
    // dropdown on that panel, and paginated like every other list. The
    // dropdown itself is rebuilt from the CURRENT stockGroups every call,
    // so a newly-added category (e.g. "Pesticides") shows up immediately
    // without needing a page reload, and the previously-selected filter
    // is preserved across re-renders rather than silently resetting.
    function renderStockSummary() {
        const filterSelect = document.getElementById('stockGroupFilter');
        if (!filterSelect) return; // panel not in the DOM yet on first load
        const previousSelection = filterSelect.value;
        const groupsInUse = [...new Set(stockItems.map(i => i.groupId).filter(Boolean).map(String))];
        filterSelect.innerHTML = '<option value="">All Categories</option>'
            + stockGroups
                .filter(g => groupsInUse.includes(String(g.id)))
                .map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('')
            + (stockItems.some(i => !i.groupId) ? '<option value="__uncategorized__">Uncategorized</option>' : '');
        // Restore whatever was selected before this rebuild, as long as it's still a valid option.
        if ([...filterSelect.options].some(o => o.value === previousSelection)) {
            filterSelect.value = previousSelection;
        }

        const selectedGroup = filterSelect.value;
        const filteredItems = !selectedGroup
            ? stockItems
            : selectedGroup === '__uncategorized__'
                ? stockItems.filter(i => !i.groupId)
                : stockItems.filter(i => i.groupId == selectedGroup);

        const stockBody = document.getElementById('stockSummaryBody');
        stockBody.innerHTML = '';

        if (filteredItems.length === 0) {
            stockBody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">No items in this category.</td></tr>';
        } else {
            const pageRows = paginateRows('stockSummary', filteredItems);
            pageRows.forEach(i => {
                const totalVal = i.qty * i.rate;
                const isOversold = i.qty < 0;
                const qtyColor = isOversold ? 'var(--danger)' : (i.qty < 5 ? 'var(--danger)' : 'var(--success)');
                const qtyDisplay = isOversold
                    ? `${i.qty} ${escapeHtml(i.uom)} <span style="font-size:0.68rem; font-weight:normal; background:var(--danger); color:#fff; padding:1px 6px; border-radius:4px; margin-left:4px;">Oversold</span>`
                    : `${i.qty} ${escapeHtml(i.uom)}`;
                stockBody.innerHTML += `
                    <tr>
                        <td onclick="viewStockItem(${i.id})" style="cursor:pointer;" title="View item summary"><strong>${escapeHtml(i.name)}</strong></td>
                        <td><span class="group-badge${i.groupId ? '' : ' muted'}">${escapeHtml(getStockGroupName(i.groupId))}</span></td>
                        <td>${escapeHtml(i.hsn)}</td>
                        <td onclick="viewStockItem(${i.id})" style="cursor:pointer; color:${qtyColor}"><strong>${qtyDisplay}</strong></td>
                        <td>\u20B9${i.rate.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        <td>\u20B9${totalVal.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        <td style="display:flex; gap:6px;">
                            <button onclick="editItem(${i.id})" style="padding:4px 10px; font-size:0.75rem; width:auto;">Edit</button>
                            <button onclick="deleteItem(${i.id})" class="btn-danger" style="padding:4px 10px; font-size:0.75rem;">Delete</button>
                        </td>
                    </tr>
                `;
            });
        }
        renderPaginationControls('stockSummary', filteredItems.length, renderStockSummary);
    }
    function getLedgerGroupName(id) {
        const g = ledgerGroups.find(l => l.id == id);
        return g ? g.name : 'Uncategorized';
    }

    // Indian financial year label (1 Apr - 31 Mar), e.g. "25-26" for any
    // date between 1 Apr 2025 and 31 Mar 2026. Parsed at noon to avoid any
    // timezone edge case shifting the date across midnight.
    function financialYearLabel(dateStr) {
        const d = dateStr ? new Date(dateStr + 'T12:00:00') : new Date();
        let startYear = d.getFullYear();
        if (d.getMonth() < 3) startYear -= 1; // Jan/Feb/Mar belong to the FY that started the previous April
        return String(startYear).slice(-2) + '-' + String(startYear + 1).slice(-2);
    }

    function nextRefNo(type, dateStr) {
        return nextVoucherNo(type, type === 'Receipt' ? 'RCPT' : 'PYMT', null, dateStr);
    }

    // Every record's id is Date.now(). That doubles as the record's
    // creation timestamp (printed invoices show it as the time of issue),
    // so the value has to stay a real millisecond figure — but plain
    // Date.now() is NOT guaranteed unique: anything created inside the
    // same millisecond gets an identical id. That matters because each
    // transaction is stored in the cloud under its id as the document
    // key, so a duplicate id doesn't just confuse a lookup — the second
    // voucher silently overwrites the first and is gone.
    //
    // This keeps the timestamp meaning intact and simply steps forward a
    // millisecond at a time until it finds a value nothing else in that
    // collection is already using. The shift is at most a few ms, far too
    // small to change the printed time.
    function newId(collection) {
        let id = Date.now();
        if (Array.isArray(collection)) {
            while (collection.some(r => r && r.id == id)) id++;
        }
        return id;
    }

    // Sequential, gap-free, financial-year-aware numbering for every
    // voucher type — required for GST tax invoices (no repeats, no gaps
    // within a year), automatically resets to 1 at the start of each new
    // financial year (1 April), and branded "SDS" (Sarvadharani Seeds).
    // Each "key" + financial-year combination gets its own independent
    // counter stored in refCounter, e.g. Sales_25-26, Sales_26-27, ...
    // Format: SDS/25-26/INV/0001
    function nextVoucherNo(key, prefix, pad, dateStr) {
        const fy = financialYearLabel(dateStr);
        const counterKey = key + '_' + fy;
        const padLen = pad || 4;
        const seriesPrefix = `SDS/${fy}/${prefix}/`;

        // The local counter alone isn't safe to trust blindly — on a
        // multi-device/cloud-synced setup it can drift behind what's
        // actually been posted (another device posted moments before this
        // one's sync caught up, or a delete/renumber shifted things), and
        // handing out its raw "next" value can collide with a number that
        // already exists. So cross-check against every invNo currently in
        // this exact series (same financial year + prefix) and skip past
        // any that are already taken, guaranteeing whatever we return here
        // is genuinely free right now.
        const used = new Set();
        transactions.forEach(t => {
            if (t.invNo && t.invNo.indexOf(seriesPrefix) === 0) {
                const n = parseInt(t.invNo.slice(seriesPrefix.length), 10);
                if (!isNaN(n)) used.add(n);
            }
        });

        let candidate = (refCounter[counterKey] || 0) + 1;
        while (used.has(candidate)) candidate++;

        refCounter[counterKey] = candidate;
        localStorage.setItem('tally_mob_refcounter', JSON.stringify(refCounter));
        syncCloud();
        return seriesPrefix + String(candidate).padStart(padLen, '0');
    }

    // The refCounter key nextVoucherNo() would have used to create this
    // exact voucher, reconstructed from the voucher itself. Needed so a
    // deletion can step the right counter back down (see below).
    function voucherCounterKeyOf(t) {
        if (t.customVoucherTypeId) return 'custom_' + t.customVoucherTypeId;
        if (t.type === 'Purchase') return t.rawPurchase ? 'RawPurchase' : 'Purchase';
        return t.type; // Sales, RawPurchase, Payment, Receipt, DeliveryNote,
                        // Journal, Conversion, OptionalSales, OptionalPurchase
    }

    // Closes the gap a deleted voucher leaves behind, so every series (one
    // financial year + one prefix, e.g. SDS/26-27/INV) stays a clean,
    // unbroken 1, 2, 3, ... run with nothing missing — every voucher
    // AFTER the deleted one in that same series steps its number down by
    // one, and the counter that hands out the next NEW number for that
    // series steps back down to match, so the next voucher posted picks
    // up right where the shifted numbers now leave off.
    //
    // Call this with the voucher's own data captured BEFORE removing it
    // from the transactions array (it only needs txn.invNo and enough of
    // txn itself for voucherCounterKeyOf() — it doesn't touch the array
    // membership itself).
    function renumberSeriesAfterDelete(deletedTxn) {
        const m = /^SDS\/([^/]+)\/([^/]+)\/(\d+)$/.exec(deletedTxn && deletedTxn.invNo || '');
        if (!m) return; // not the standard auto-numbered pattern — nothing to shift
        const fy = m[1], prefix = m[2], deletedNum = parseInt(m[3], 10), pad = m[3].length;

        const affected = transactions
            .map(t => {
                const mm = /^SDS\/([^/]+)\/([^/]+)\/(\d+)$/.exec(t.invNo || '');
                if (!mm || mm[1] !== fy || mm[2] !== prefix) return null;
                const num = parseInt(mm[3], 10);
                return num > deletedNum ? { t, num } : null;
            })
            .filter(Boolean)
            .sort((a, b) => a.num - b.num); // shift lowest-first so numbers never collide mid-shift

        if (affected.length === 0 && !(voucherCounterKeyOf(deletedTxn) + '_' + fy in refCounter)) return;

        affected.forEach(({ t, num }) => {
            t.invNo = `SDS/${fy}/${prefix}/` + String(num - 1).padStart(pad, '0');
            // Payment/Receipt/Journal vouchers keep a plain-text snapshot of
            // the invoice number they're settling (refInvoiceNo) alongside
            // the real link (refInvoiceId). The line above just changed
            // this invoice's number, so every voucher pointing at it by ID
            // needs that snapshot refreshed too — otherwise it keeps
            // displaying a number that no longer belongs to anything.
            transactions.forEach(other => {
                if (other.refInvoiceId == t.id) other.refInvoiceNo = t.invNo;
            });
        });

        const counterKey = voucherCounterKeyOf(deletedTxn) + '_' + fy;
        if (refCounter[counterKey] !== undefined) {
            refCounter[counterKey] = Math.max(0, refCounter[counterKey] - 1);
            localStorage.setItem('tally_mob_refcounter', JSON.stringify(refCounter));
        }
    }

    // Repairs an invoice number that's ALREADY duplicated in the live data
    // — something nextVoucherNo() now prevents from happening again, but
    // can't undo for vouchers that were saved before that fix went in.
    // Two vouchers with the identical number is exactly the bug behind the
    // "Fix numbering" button on the Invoice Number Gap Check screen.
    //
    // The oldest voucher (earliest id) keeps the number as-is. Every other
    // voucher sharing it is moved, one at a time, to the next number in
    // that series nothing is currently using — the same "skip past what's
    // taken" search nextVoucherNo() itself does, so the result can never
    // collide with anything else, including a different duplicate elsewhere
    // in the same series being fixed in the same pass.
    function resolveDuplicateInvoiceNumber(fy, prefix, num) {
        if (!isAdmin() && !hasPermission('editVoucher')) return alert("Only an admin, or a user with 'Edit a voucher' turned on, can fix a duplicate invoice number.");
        const seriesPrefix = `SDS/${fy}/${prefix}/`;
        const matches = transactions.filter(t => {
            if (!t.invNo || t.invNo.indexOf(seriesPrefix) !== 0) return false;
            return parseInt(t.invNo.slice(seriesPrefix.length), 10) === num;
        });
        if (matches.length < 2) { renderInvoiceGapCheck(); return; } // already resolved elsewhere (e.g. another device)

        const pad = matches[0].invNo.length - seriesPrefix.length;
        matches.sort((a, b) => (a.id || 0) - (b.id || 0)); // oldest keeps the number
        const keptInvNo = matches[0].invNo;

        const used = new Set();
        transactions.forEach(t => {
            if (t.invNo && t.invNo.indexOf(seriesPrefix) === 0) {
                const n = parseInt(t.invNo.slice(seriesPrefix.length), 10);
                if (!isNaN(n)) used.add(n);
            }
        });

        matches.slice(1).forEach(t => {
            let candidate = num + 1;
            while (used.has(candidate)) candidate++;
            used.add(candidate);
            t.invNo = seriesPrefix + String(candidate).padStart(pad, '0');

            // Keep that voucher type's own counter ahead of whatever we
            // just handed out, so the next NEW voucher of this type
            // doesn't wander back into a number just assigned here.
            const ck = voucherCounterKeyOf(t) + '_' + fy;
            refCounter[ck] = Math.max(refCounter[ck] || 0, candidate);

            // Same stale-reference issue as renumberSeriesAfterDelete:
            // a Payment/Receipt/Journal linked by ID keeps a plain-text
            // copy of the number it's settling, which needs refreshing now
            // that this voucher's real number just changed.
            transactions.forEach(other => {
                if (other.refInvoiceId == t.id) other.refInvoiceNo = t.invNo;
            });
        });

        localStorage.setItem('tally_mob_db', JSON.stringify(transactions));
        localStorage.setItem('tally_mob_refcounter', JSON.stringify(refCounter));
        syncCloud();
        render();
        renderInvoiceGapCheck();
        alert(`Fixed. ${keptInvNo} now belongs to one voucher; the other${matches.length - 1 === 1 ? '' : 's'} ${matches.length - 1 === 1 ? 'has' : 'have'} been moved to the next free number${matches.length - 1 === 1 ? '' : 's'} in that series.`);
    }

    // Outstanding still due on a Sales/Purchase invoice (grandTotal minus
    // all cash vouchers linked to it).
    function invoiceOutstanding(txn) {
        const settled = transactions
            .filter(t => t.refInvoiceId == txn.id)
            .reduce((a, c) => a + c.grandTotal, 0);
        return Math.max(0, txn.grandTotal - settled);
    }

    // ---- Recent Transactions (dashboard widget) ----
    // Shows the last few posted vouchers of any type, newest first.
    // Read-only summary — rows do not open or navigate anywhere.
    function renderRecentTransactions() {
        const listEl = document.getElementById('recentTxnList');
        if (!listEl) return;

        const recent = [...transactions]
            .sort((a, b) => b.id - a.id)
            .slice(0, 5);

        if (recent.length === 0) {
            listEl.innerHTML = '<div class="recent-txn-empty">No vouchers posted yet.</div>';
            return;
        }

        listEl.innerHTML = recent.map(t => {
            const who = t.partyName || t.accountName ||
                (t.type === 'Journal' ? ((t.journalDebit && t.journalDebit.name) || 'Journal Entry') : 'Cash Party');
            const dateLabel = t.date ? new Date(t.date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';
            return `
                <div class="recent-txn-row">
                    <div class="recent-txn-main">
                        <div class="recent-txn-party">${escapeHtml(who)}</div>
                        <div class="recent-txn-meta">${escapeHtml(t.type)} &middot; ${escapeHtml(t.invNo || '')} &middot; ${dateLabel}</div>
                    </div>
                    <div class="recent-txn-amt">&#8377;${(t.grandTotal || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</div>
                </div>
            `;
        }).join('');
    }

    // ---- Pending to Receive / Pending to Pay (dashboard tile drill-downs) ----
    // Lists every Sales (or Purchase/RawPurchase) invoice that still has
    // money outstanding, using the same invoiceOutstanding() math the
    // dashboard total itself is built from, so the two always agree.
    function renderPendingReceivable() {
        // Group every outstanding Sales invoice by customer, so someone
        // with several unpaid invoices shows as ONE row with a combined
        // balance, not one row per invoice — but each individual invoice
        // number is still listed and clickable right there in that row,
        // opening that invoice directly, so you don't have to leave this
        // screen to see which specific invoices make up the total.
        const byParty = {};
        transactions
            .filter(t => t.type === 'Sales')
            .forEach(t => {
                const due = invoiceOutstanding(t);
                if (due <= 0.001) return;
                if (!byParty[t.partyId]) {
                    byParty[t.partyId] = { partyId: t.partyId, partyName: t.partyName, invoiceCount: 0, totalInvoiced: 0, totalDue: 0, invoices: [] };
                }
                byParty[t.partyId].invoiceCount += 1;
                byParty[t.partyId].totalInvoiced += t.grandTotal;
                byParty[t.partyId].totalDue += due;
                byParty[t.partyId].invoices.push({ id: t.id, invNo: t.invNo });
            });

        const rows = Object.values(byParty).sort((a, b) => b.totalDue - a.totalDue);

        const body = document.getElementById('pendingReceivableBody');
        body.innerHTML = '';
        let total = 0;

        if (rows.length === 0) {
            body.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">Nothing pending &mdash; every sale is fully received.</td></tr>';
        } else {
            rows.forEach(r => {
                total += r.totalDue;
                const received = r.totalInvoiced - r.totalDue;
                const invoiceLinks = r.invoices.map(inv =>
                    `<span style="color:var(--accent); text-decoration:underline; cursor:pointer; white-space:nowrap;" onclick="event.stopPropagation(); printInvoice(${inv.id})" title="Open ${escapeHtml(inv.invNo)}">${escapeHtml(inv.invNo)}</span>`
                ).join(', ');
                body.innerHTML += `
                    <tr style="cursor:pointer;" title="Open party ledger" onclick="openPartyLedgerFromReport(${r.partyId})">
                        <td style="color:var(--accent); text-decoration:underline;">${escapeHtml(r.partyName)}</td>
                        <td style="white-space:normal;">${invoiceLinks}</td>
                        <td>\u20B9${r.totalInvoiced.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        <td style="color:var(--text-muted);">\u20B9${received.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        <td style="color:var(--success); font-weight:bold;">\u20B9${r.totalDue.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    </tr>
                `;
            });
        }

        document.getElementById('prTotalReceivable').innerText = `\u20B9${total.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
        document.getElementById('prCountReceivable').innerText = rows.length;
    }

    function renderPendingPayable() {
        // Same grouping as renderPendingReceivable, mirrored for vendors —
        // one row per vendor with a combined outstanding balance across
        // every unpaid Purchase/RawPurchase voucher, with each individual
        // voucher number listed and clickable in that same row.
        const byParty = {};
        transactions
            .filter(t => t.type === 'Purchase' || t.type === 'RawPurchase')
            .forEach(t => {
                const due = invoiceOutstanding(t);
                if (due <= 0.001) return;
                if (!byParty[t.partyId]) {
                    byParty[t.partyId] = { partyId: t.partyId, partyName: t.partyName, invoiceCount: 0, totalInvoiced: 0, totalDue: 0, invoices: [] };
                }
                byParty[t.partyId].invoiceCount += 1;
                byParty[t.partyId].totalInvoiced += t.grandTotal;
                byParty[t.partyId].totalDue += due;
                byParty[t.partyId].invoices.push({ id: t.id, invNo: t.invNo });
            });

        const rows = Object.values(byParty).sort((a, b) => b.totalDue - a.totalDue);

        const body = document.getElementById('pendingPayableBody');
        body.innerHTML = '';
        let total = 0;

        if (rows.length === 0) {
            body.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">Nothing pending &mdash; every purchase is fully paid.</td></tr>';
        } else {
            rows.forEach(r => {
                total += r.totalDue;
                const paid = r.totalInvoiced - r.totalDue;
                const invoiceLinks = r.invoices.map(inv =>
                    `<span style="color:var(--accent); text-decoration:underline; cursor:pointer; white-space:nowrap;" onclick="event.stopPropagation(); printInvoice(${inv.id})" title="Open ${escapeHtml(inv.invNo)}">${escapeHtml(inv.invNo)}</span>`
                ).join(', ');
                body.innerHTML += `
                    <tr style="cursor:pointer;" title="Open vendor ledger" onclick="openPartyLedgerFromReport(${r.partyId})">
                        <td style="color:var(--accent); text-decoration:underline;">${escapeHtml(r.partyName)}</td>
                        <td style="white-space:normal;">${invoiceLinks}</td>
                        <td>\u20B9${r.totalInvoiced.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        <td style="color:var(--text-muted);">\u20B9${paid.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        <td style="color:var(--danger); font-weight:bold;">\u20B9${r.totalDue.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    </tr>
                `;
            });
        }

        document.getElementById('prTotalPayable').innerText = `\u20B9${total.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
        document.getElementById('prCountPayable').innerText = rows.length;
    }


    document.getElementById('vDate').valueAsDate = new Date();  

    function escapeHtml(str) {
        return (str || '').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    // ================================================================
    // MULTI-SELECT + BATCH PRINT (shared by every list screen)
    //
    // Each list keeps its own Set of selected transaction ids, keyed by a
    // listKey string (e.g. 'salesStatement', 'ledgerStatement'). A screen
    // just needs a checkbox per row with data-select-key/data-select-id,
    // a "select all" checkbox, a counter span, and a Print Selected button
    // — all driven by the functions below.
    // ================================================================
    // ================================================================
    // PAGINATION (shared by every list screen)
    //
    // Each list keeps its current page number, keyed by the same listKey
    // string convention as the selection engine. A screen just needs to
    // call paginateRows(listKey, allRows) right before rendering to slice
    // out the current page, then renderPaginationControls(listKey,
    // totalRowCount, rerenderFn) to draw the Prev/Next + page indicator.
    // Default page size is 25 rows; changing the page size resets to page 1.
    // ================================================================
    const listPageState = {}; // { [listKey]: { page: 1, pageSize: 25 } }
    const DEFAULT_PAGE_SIZE = 25;

    function pageStateFor(listKey) {
        if (!listPageState[listKey]) listPageState[listKey] = { page: 1, pageSize: DEFAULT_PAGE_SIZE };
        return listPageState[listKey];
    }

    // Slices the full row array down to just the current page. Also
    // clamps the page number back into range if the underlying data
    // shrank (e.g. a filter narrowed the results) so you're never stuck
    // looking at an empty page 4 of 2.
    function paginateRows(listKey, allRows) {
        const state = pageStateFor(listKey);
        const totalPages = Math.max(1, Math.ceil(allRows.length / state.pageSize));
        if (state.page > totalPages) state.page = totalPages;
        if (state.page < 1) state.page = 1;
        const start = (state.page - 1) * state.pageSize;
        return allRows.slice(start, start + state.pageSize);
    }

    function goToPage(listKey, page, rerenderFn) {
        const state = pageStateFor(listKey);
        state.page = page;
        rerenderFn();
        // Scroll the list back into view — jumping pages while scrolled
        // halfway down a long list is disorienting otherwise.
        const anchor = document.querySelector(`[data-page-anchor="${listKey}"]`);
        if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function changePageSize(listKey, newSize, rerenderFn) {
        const state = pageStateFor(listKey);
        state.pageSize = Number(newSize);
        state.page = 1; // always reset to page 1 — a stale page number would make no sense at a new page size
        rerenderFn();
    }

    // Renders "Showing X–Y of Z" plus Prev/Next/page-jump controls into
    // any container with [data-page-controls="listKey"]. Call this once
    // per render, after the rows themselves are drawn.
    function renderPaginationControls(listKey, totalRowCount, rerenderFn) {
        const container = document.querySelector(`[data-page-controls="${listKey}"]`);
        if (!container) return;
        const state = pageStateFor(listKey);
        const totalPages = Math.max(1, Math.ceil(totalRowCount / state.pageSize));
        if (state.page > totalPages) state.page = totalPages;

        if (totalRowCount === 0) { container.innerHTML = ''; return; }

        const start = (state.page - 1) * state.pageSize + 1;
        const end = Math.min(totalRowCount, state.page * state.pageSize);

        window[`__rerender_${listKey}`] = rerenderFn; // stash so inline onclick can reach it without a closure per row

        container.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; padding:10px 4px; font-size:0.8rem; color:var(--text-muted);">
                <span>Showing ${start}\u2013${end} of ${totalRowCount}</span>
                <div style="display:flex; align-items:center; gap:6px;">
                    <label style="font-size:0.75rem; margin:0;">Rows</label>
                    <select style="width:auto; padding:4px 6px; font-size:0.78rem;" onchange="changePageSize('${listKey}', this.value, window['__rerender_${listKey}'])">
                        <option value="25" ${state.pageSize == 25 ? 'selected' : ''}>25</option>
                        <option value="50" ${state.pageSize == 50 ? 'selected' : ''}>50</option>
                        <option value="100" ${state.pageSize == 100 ? 'selected' : ''}>100</option>
                    </select>
                    <button type="button" ${state.page <= 1 ? 'disabled' : ''} onclick="goToPage('${listKey}', ${state.page - 1}, window['__rerender_${listKey}'])" style="width:auto; padding:6px 12px; font-size:0.78rem; ${state.page <= 1 ? 'opacity:0.4;' : ''}">&#8592; Prev</button>
                    <span style="font-size:0.78rem;">Page ${state.page} of ${totalPages}</span>
                    <button type="button" ${state.page >= totalPages ? 'disabled' : ''} onclick="goToPage('${listKey}', ${state.page + 1}, window['__rerender_${listKey}'])" style="width:auto; padding:6px 12px; font-size:0.78rem; ${state.page >= totalPages ? 'opacity:0.4;' : ''}">Next &#8594;</button>
                </div>
            </div>
        `;
    }

    const listSelections = {};
    const listSelectModeActive = {};

    // Whether a list's checkboxes are currently visible at all. Off by
    // default for every list — checkboxes only appear once "Select" is
    // tapped, and tapping it again (or "Cancel") hides them and clears
    // whatever was ticked, so a hidden selection can never linger unseen.
    function isSelectModeActive(listKey) {
        return !!listSelectModeActive[listKey];
    }

    function toggleSelectMode(listKey) {
        const turningOn = !isSelectModeActive(listKey);
        listSelectModeActive[listKey] = turningOn;
        if (!turningOn) {
            // Leaving select mode always drops any selection — both the
            // internal tracking AND the actual checkbox elements, so
            // re-entering select mode later starts from a clean slate
            // instead of showing stale ticks from before.
            selectionSetFor(listKey).clear();
            document.querySelectorAll(`input[data-select-key="${listKey}"]`).forEach(cb => { cb.checked = false; });
            const selectAllBox = document.querySelector(`input[data-select-all="${listKey}"]`);
            if (selectAllBox) selectAllBox.checked = false;
        }
        applySelectModeUI(listKey);
        updateSelectionUI(listKey);
    }

    // Shows/hides every checkbox column cell for this list (both the
    // header's select-all and each row's own checkbox), and updates the
    // "Select" button's own label so it reads "Cancel" while active.
    function applySelectModeUI(listKey) {
        const active = isSelectModeActive(listKey);
        document.querySelectorAll(`[data-select-col="${listKey}"]`).forEach(el => {
            el.style.display = active ? '' : 'none';
        });
        document.querySelectorAll(`[data-select-togglebtn="${listKey}"]`).forEach(btn => {
            btn.textContent = active ? 'Cancel' : 'Select';
            btn.classList.toggle('select-mode-on', active);
        });
        // Hide the Print Selected button and counter too while not selecting
        // — nothing to print if you can't even tick a box right now.
        document.querySelectorAll(`[data-select-printbtn="${listKey}"]`).forEach(btn => {
            btn.style.display = active ? '' : 'none';
        });
        document.querySelectorAll(`[data-select-count="${listKey}"]`).forEach(el => {
            el.style.display = active ? '' : 'none';
        });
    }

    function selectionSetFor(listKey) {
        if (!listSelections[listKey]) listSelections[listKey] = new Set();
        return listSelections[listKey];
    }

    function toggleRowSelection(listKey, txnId, checked) {
        const set = selectionSetFor(listKey);
        if (checked) set.add(txnId); else set.delete(txnId);
        updateSelectionUI(listKey);
    }

    // Selects/deselects every currently-rendered checkbox for a list at
    // once. Only affects rows actually in the DOM right now (i.e. whatever
    // the current filter/period shows) — not any selection from a
    // different filter state, which avoids silently printing something
    // that's no longer even visible.
    function toggleSelectAll(listKey, checked) {
        const set = selectionSetFor(listKey);
        document.querySelectorAll(`input[data-select-key="${listKey}"]`).forEach(cb => {
            cb.checked = checked;
            const id = Number(cb.dataset.selectId);
            if (checked) set.add(id); else set.delete(id);
        });
        updateSelectionUI(listKey);
    }

    // Clears a list's selection entirely — called whenever the list itself
    // re-renders with a different filter/period, so stale ticks from a
    // previous view never silently carry over into a new one. Also
    // re-applies the current select-mode visibility, since freshly
    // rendered rows' checkbox cells start visible by default and need to
    // be hidden again if the list isn't actively in select mode.
    function clearSelection(listKey) {
        selectionSetFor(listKey).clear();
        applySelectModeUI(listKey);
        updateSelectionUI(listKey);
    }

    function updateSelectionUI(listKey) {
        const set = selectionSetFor(listKey);
        document.querySelectorAll(`[data-select-count="${listKey}"]`).forEach(el => {
            el.textContent = set.size > 0 ? `${set.size} selected` : '';
        });
        document.querySelectorAll(`[data-select-printbtn="${listKey}"]`).forEach(btn => {
            btn.disabled = set.size === 0;
            btn.style.opacity = set.size === 0 ? '0.5' : '1';
        });
        // Keep "select all" reflecting reality: fully checked only if every
        // rendered row is selected, unchecked otherwise (including partial).
        const allBoxes = [...document.querySelectorAll(`input[data-select-key="${listKey}"]`)];
        const selectAllBox = document.querySelector(`input[data-select-all="${listKey}"]`);
        if (selectAllBox) {
            selectAllBox.checked = allBoxes.length > 0 && allBoxes.every(cb => set.has(Number(cb.dataset.selectId)));
        }
    }

    // Prints every selected transaction as a full invoice page, one after
    // another — same layout each would get individually via printInvoice,
    // just composed back-to-back into one print job instead of one at a
    // time. Order follows whatever order the ids were given in (normally
    // the list's current sort order).
    function printSelected(listKey, orderedIdsInCurrentView) {
        const set = selectionSetFor(listKey);
        if (set.size === 0) return;
        const ids = (orderedIdsInCurrentView || []).filter(id => set.has(id));
        // Fall back to Set order if no explicit ordering was given (still
        // correct, just not guaranteed to match the visible row order).
        const finalIds = ids.length ? ids : [...set];

        const pages = finalIds.map(id => buildInvoiceHtml(id)).filter(Boolean);
        if (pages.length === 0) { alert("Nothing to print — the selected entries may have been deleted."); return; }

        const printWindow = window.open('', '_blank');
        if (!printWindow) { alert("Please allow pop-ups to print multiple invoices."); return; }
        printWindow.document.write(`
            <html><head><title>Selected Vouchers</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 0; }
                .invoice-page { padding: 24px; page-break-after: always; }
                .invoice-page:last-child { page-break-after: auto; }
                table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                @media print { .invoice-page { page-break-after: always; } }
            </style>
            </head><body>
                ${pages.map(html => `<div class="invoice-page">${html}</div>`).join('')}
                <script>window.onload = () => { window.print(); };<\/script>
            </body></html>
        `);
        printWindow.document.close();
    }

    // ================================================================
    // PER-USER GRANULAR PERMISSIONS
    //
    // "Admin" is unchanged — userRoles[email] === 'admin' still means full
    // authority over everything, exactly as before.
    //
    // A "User" (renamed from the old fixed "Staff" role) is no longer one
    // fixed bundle. userRoles[email] for a User is now an OBJECT of
    // individual Yes/No permission flags, not the plain string 'staff'.
    // Older accounts that still have the plain string 'staff' saved from
    // before this change are treated as ALL PERMISSIONS OFF by default —
    // exactly what the old "Staff" role already restricted them to for
    // deletes/opening-balance/FY, so nobody who already existed suddenly
    // gains new abilities just because the data shape changed under them.
    // An admin can open Users at any time and turn on whichever specific
    // permissions that account should actually have.
    // ================================================================
    const PERMISSION_DEFS = [
        { key: 'editVoucher',    label: 'Edit a voucher' },
        { key: 'deleteVoucher',  label: 'Delete a voucher' },
        { key: 'editParty',      label: 'Edit a party' },
        { key: 'deleteParty',    label: 'Delete a party' },
        { key: 'editAccount',    label: 'Edit a cash/bank account' },
        { key: 'deleteAccount',  label: 'Delete a cash/bank account' },
        { key: 'editItem',       label: 'Edit a stock item' },
        { key: 'deleteItem',     label: 'Delete a stock item' },
        { key: 'deleteGroup',    label: 'Delete a ledger/stock group' },
        { key: 'editOpening',    label: 'Edit opening balances' },
        { key: 'newFinancialYear', label: 'Start a new financial year' },
        { key: 'manageUsers',    label: "Manage other users' access" },
        { key: 'createMasters',  label: 'Create parties, items, accounts (Masters)' },
        { key: 'postVouchers',   label: 'Post new vouchers (Sales, Purchase, Payment, Receipt, etc.)' },
        { key: 'viewReports',    label: 'View reports (Ledger, Sales Statement, GST Liability, etc.)' },
        { key: 'exportPrint',    label: 'Export / print (PDF, CSV, invoices)' },
        { key: 'rawAndConversion', label: 'View/access Raw Purchase &amp; Conversion (stock processing) features and reports' }
    ];

    // The role object a brand-new User account starts with — every
    // permission off, same as the old fixed Staff restriction, until an
    // admin explicitly turns something on for them.
    function blankPermissions() {
        const perms = {};
        PERMISSION_DEFS.forEach(p => { perms[p.key] = false; });
        return perms;
    }

    // True/false for one specific permission, for a given email (defaults
    // to the currently signed-in user). Admins always pass every check.
    // Handles both the new object shape and an older plain 'staff' string
    // (no permissions) so nothing breaks for an account created before
    // this feature existed.
    function hasPermission(permKey, email) {
        const who = email || currentUserEmail();
        if (!who) return false;
        if (userRoles[who] === 'admin') return true;
        const entry = userRoles[who];
        if (!entry || typeof entry === 'string') return false; // old 'staff' string, or no entry at all
        return !!entry[permKey];
    }

    // Panels that require a specific permission just to open. Anything
    // NOT listed here has always been open to any signed-in user (posting
    // the main voucher screen itself, viewing the dashboard, etc. are
    // intentionally left unrestricted — only the sensitive/admin-style
    // areas are gated).
    const PANEL_PERMISSIONS = {
        panelParty: 'createMasters', panelItem: 'createMasters', panelAccounts: 'createMasters',
        panelStockGroup: 'createMasters', panelLedgerGroup: 'createMasters',
        panelVoucherTypes: 'createMasters',
        panelRawPurchase: 'rawAndConversion', panelConversion: 'rawAndConversion',
        panelProcessedReport: 'rawAndConversion', panelRawPurchaseReport: 'rawAndConversion',
        panelLedger: 'viewReports', panelSalesStatement: 'viewReports', panelPurchaseReport: 'viewReports',
        panelGstLiability: 'viewReports', panelSubLedgerReport: 'viewReports', panelCashReport: 'viewReports',
        panelPendingReceivable: 'viewReports', panelPendingPayable: 'viewReports',
        panelTrialBalance: 'viewReports', panelCategoryDetail: 'viewReports',
        panelDaybook: 'viewReports', panelDeliveryNotes: 'viewReports',
        panelInvoiceGapCheck: 'viewReports'
    };

    // ================================================================
    // DATE-WISE SORTING (shared by every ledger/report/transaction list)
    //
    // Sorts by the transaction's own Date field first (not by when it was
    // created — those can differ if a voucher is backdated). Same-day
    // entries keep the order they were actually entered in, using id as
    // a tiebreaker (ids are creation-time timestamps).
    //
    // sortDirFor(listKey) reads/remembers which direction ('desc'/'asc')
    // each individual list is currently showing, defaulting to 'desc'
    // (newest date first) the first time a list is opened.
    // ================================================================
    const listSortDirs = {};

    function sortDirFor(listKey) {
        if (!listSortDirs[listKey]) listSortDirs[listKey] = 'desc';
        return listSortDirs[listKey];
    }

    function toggleSortDir(listKey, rerenderFn) {
        listSortDirs[listKey] = (sortDirFor(listKey) === 'desc') ? 'asc' : 'desc';
        if (typeof rerenderFn === 'function') rerenderFn();
        else if (typeof window[rerenderFn] === 'function') window[rerenderFn]();
        updateSortToggleLabel(listKey);
    }

    // Keeps every "Sort: Newest first / Oldest first" button's label and
    // icon in sync with the list's actual current direction.
    function updateSortToggleLabel(listKey) {
        document.querySelectorAll(`[data-sort-toggle="${listKey}"]`).forEach(btn => {
            const dir = sortDirFor(listKey);
            btn.innerHTML = dir === 'desc'
                ? '&#8681; Newest first'
                : '&#8679; Oldest first';
        });
    }

    // Sorts an array of transaction-like objects (each with .date and .id)
    // by date, honoring the given list's current direction, with same-day
    // entries kept in entry order (ascending id) regardless of the overall
    // direction — so "added one after another" always reads top-to-bottom
    // the way it was actually entered, even when the list itself is newest-first.
    function sortByDate(rows, listKey) {
        const dir = sortDirFor(listKey);
        const mult = (dir === 'desc') ? -1 : 1;
        return rows.slice().sort((a, b) => {
            const dateA = new Date(a.date).getTime();
            const dateB = new Date(b.date).getTime();
            if (dateA !== dateB) return mult * (dateA - dateB);
            // Same-day tiebreak: follows the same Newest/Oldest First
            // direction as the date comparison above, so "Newest First"
            // genuinely means the most-recently-created entry on that day
            // shows at the top too — not just newer dates overall.
            return mult * (a.id - b.id);
        });
    }

    // Normalizes a name for duplicate-detection purposes only (never used
    // for display or storage) — lowercases, strips common punctuation, and
    // collapses whitespace, so "Ramesh Trader's" and "ramesh  traders" are
    // recognized as the same underlying name.
    function normalizeNameForDupCheck(str) {
        return (str || '')
            .toLowerCase()
            .replace(/['".,\-]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Shows/hides the small inline "create a new group without leaving this
    // form" row used on both the Item form and the Account/Ledger form.
    function toggleQuickAdd(rowId) {
        document.getElementById(rowId).classList.toggle('active');
    }

    // ---- Tile / panel navigation ----
    // Which sub-menu each panel belongs to (so "Back" returns there).
    const PANEL_GROUP = {
        panelParty: 'groupMasters', panelItem: 'groupMasters', panelStockGroup: 'groupMasters',
        panelAccounts: 'groupMasters', panelLedgerGroup: 'groupMasters', panelGroupStock: 'groupMasters',
        panelOptional: 'groupMasters', panelVoucherTypes: 'groupMasters',
        panelAlter: 'groupMasters', panelAlterParty: 'groupMasters', panelAlterUnit: 'groupMasters',
        panelAlterVoucher: 'groupMasters', panelDataTransfer: 'groupMasters',
        panelPayments: 'groupTransactions',
        panelReceipts: 'groupTransactions', panelDaybook: 'groupTransactions',
        panelCustomVoucherList: 'groupTransactions',
        panelStock: 'groupReports',
        panelGroupLedgers: 'groupReports', panelStockItemView: 'groupReports',
        panelSubLedgerReport: 'groupReports', panelSalesStatement: 'groupReports', panelPurchaseReport: 'groupReports',
        panelGstLiability: 'groupReports',
        panelCashReport: 'groupReports', panelCategoryDetail: 'groupReports',
        panelPendingReceivable: 'groupReports', panelPendingPayable: 'groupReports',
        panelDeliveryNotes: 'groupTransactions',
        panelRawPurchase: 'groupTransactions', panelConversion: 'groupTransactions',
        panelProcessedReport: 'groupReports', panelRawPurchaseReport: 'groupReports', panelTrialBalance: 'groupReports',
        panelInvoiceGapCheck: 'groupReports',
        panelManageStaff: 'groupSettings'
    };
    let currentGroup = null;

    // ---------- Back-button navigation ----------
    // Every "open a screen" action below pushes one browser-history entry
    // paired with the function that restores the screen underneath it.
    // The hardware/gesture back button and the in-app "\u2190 Back" buttons
    // both end up popping that same stack, so either one steps back a
    // single screen instead of the back button exiting the whole app.
    const navBackStack = [];
    let navPendingAfterBack = null;
    function navPushState(uiBackFn) {
        navBackStack.push(uiBackFn);
        history.pushState({ nb: navBackStack.length }, document.title);
    }
    window.addEventListener('popstate', function () {
        const fn = navBackStack.pop();
        if (fn) { try { fn(); } catch (e) {} }
        // A caller that needs to close the current screen and then open a
        // different one (e.g. the invoice modal's "Edit" button) defers the
        // "open" half until the close has actually finished, instead of
        // firing both in the same click — see closeInvoiceModal() call sites.
        if (navPendingAfterBack) {
            const next = navPendingAfterBack;
            navPendingAfterBack = null;
            try { next(); } catch (e) {}
        }
    });

    // Elements that belong to the home dashboard only — hidden the moment
    // any group/panel is opened, so that content appears right at the top
    // instead of below the whole dashboard, and restored only when back home.
    // ---------- Styled alert()/confirm() replacements ----------
    // Native alert()/confirm() block the whole page, can't be restyled, and
    // (for confirm) guard destructive actions with a dialog that's easy to
    // reflexively tap through. These swap in the app's own themed modals,
    // wired through the same back-button history stack as everything else.
    // alert() call sites throughout the file are untouched — window.alert
    // is simply redefined here. confirm() calls are converted individually
    // to `await confirmAsync(...)` since a synchronous return value can't
    // be faked with an async modal.
    function closeAppNotice() {
        document.getElementById('appNoticeModal').style.display = 'none';
        history.back();
    }
    function closeAppNoticeUI() {
        document.getElementById('appNoticeModal').style.display = 'none';
    }
    window.alert = function (message) {
        document.getElementById('appNoticeText').textContent = message;
        document.getElementById('appNoticeModal').style.display = 'flex';
        navPushState(closeAppNoticeUI);
    };

    let appConfirmResolve = null;
    function closeAppConfirmUI() {
        document.getElementById('appConfirmModal').style.display = 'none';
        if (appConfirmResolve) { const r = appConfirmResolve; appConfirmResolve = null; r(false); }
    }
    // Fired by the Cancel/OK buttons. Hides + resolves immediately (no
    // waiting on the async popstate round-trip) and also steps history
    // back so the pushed entry doesn't linger; the resulting popstate
    // still runs closeAppConfirmUI, but by then appConfirmResolve is
    // already null so it's a harmless no-op.
    function resolveAppConfirm(result) {
        document.getElementById('appConfirmModal').style.display = 'none';
        const r = appConfirmResolve;
        appConfirmResolve = null;
        history.back();
        if (r) r(result);
    }
    function confirmAsync(message) {
        return new Promise(resolve => {
            appConfirmResolve = resolve;
            document.getElementById('appConfirmText').textContent = message;
            document.getElementById('appConfirmModal').style.display = 'flex';
            navPushState(closeAppConfirmUI);
        });
    }

    // ---------- Light/dark mode ----------
    function updateThemeToggleIcon() {
        const icon = document.getElementById('themeToggleIcon');
        if (icon) icon.innerHTML = document.body.classList.contains('dark-mode') ? '&#9728;&#65039;' : '&#127769;';
    }
    function toggleTheme() {
        const isDark = document.body.classList.toggle('dark-mode');
        localStorage.setItem('sds_theme', isDark ? 'dark' : 'light');
        updateThemeToggleIcon();
    }
    updateThemeToggleIcon(); // reflect whatever the inline head script already applied

    function renderAuditTrail() {
        const body = document.getElementById('auditBody');
        if (!body) return;
        const actionFilter = (document.getElementById('auditActionFilter') || {}).value || '';
        const q = ((document.getElementById('auditSearch') || {}).value || '').trim().toLowerCase();

        const rows = auditLog.filter(e => {
            if (actionFilter && e.action !== actionFilter) return false;
            if (!q) return true;
            return [e.invNo, e.party, e.user, e.type].some(v => (v || '').toLowerCase().includes(q));
        });

        const countEl = document.getElementById('auditCount');
        if (countEl) {
            countEl.innerText = rows.length === auditLog.length
                ? `${rows.length} entries`
                : `${rows.length} of ${auditLog.length} entries`;
        }

        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">No matching activity yet.</td></tr>';
            return;
        }

        const colour = a => a === 'Deleted' ? 'var(--danger)'
                        : a === 'Edited'  ? 'var(--warning)'
                        : 'var(--success)';

        body.innerHTML = rows.map(e => {
            const d = new Date(e.at);
            const when = isNaN(d) ? '-' : d.toLocaleString('en-IN', {
                day: '2-digit', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: true
            });
            return `<tr>
                <td style="white-space:nowrap;">${escapeHtml(when)}</td>
                <td><strong style="color:${colour(e.action)};">${escapeHtml(e.action)}</strong></td>
                <td><strong>${escapeHtml(e.invNo || '-')}</strong>${e.type ? `<div style="font-size:0.75rem; color:var(--text-muted);">${escapeHtml(e.type)}</div>` : ''}</td>
                <td>${escapeHtml(e.party || '-')}</td>
                <td style="font-family:'JetBrains Mono',monospace;">\u20B9${(e.amount || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                <td style="font-size:0.8rem;">${escapeHtml(e.user || 'unknown')}</td>
            </tr>`;
        }).join('');
    }

    function setHomeDashboardVisible(visible) {
        const ids = ['homeDashboardSummary', 'extrasBar', 'backupBanner', 'recentTxnCard', 'dataLoadingBanner'];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = visible ? '' : 'none';
        });
    }

    function hideAllMenus() {
        document.getElementById('tileMenu').style.display = 'none';
        setHomeDashboardVisible(false);
        document.querySelectorAll('.submenu').forEach(s => s.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    }

    // Top-level: reveal a sub-menu of options.
    function openGroup(groupId) {
        hideAllMenus();
        currentGroup = groupId;
        document.getElementById(groupId).classList.add('active');
        navPushState(backToGroupsUI);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // Back from a sub-menu to the three top groups — called by the in-app
    // Back button. Just steps the browser back one entry; the actual UI
    // restore happens in backToGroupsUI() via the popstate handler above,
    // so hardware/gesture back and the in-app button behave identically.
    function backToGroups() { history.back(); }
    function backToGroupsUI() {
        hideAllMenus();
        currentGroup = null;
        document.getElementById('tileMenu').style.display = 'block';
        setHomeDashboardVisible(true);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // Open a specific panel (remembers which sub-menu it belongs to).
    function openPanel(id) {
        const requiredPerm = PANEL_PERMISSIONS[id];
        if (requiredPerm && !isAdmin() && !hasPermission(requiredPerm)) {
            alert("Your account doesn't have access to this. Ask an admin to enable it for you under Admin \u2192 Users.");
            return;
        }
        // Capture what's actually on screen right now, before hideAllMenus()
        // wipes it — this is what "back" needs to restore. PANEL_GROUP below
        // still sets currentGroup (used elsewhere for e.g. permission
        // context), but it's a guess at which group a panel *conceptually*
        // belongs to, not proof that group's screen was ever shown: a
        // dashboard shortcut like "Pending to Pay" opens panelPendingPayable
        // directly, skipping the Reports group screen entirely. Restoring
        // "Reports" on back in that case would show a screen with no real
        // history entry behind it — back from there has nowhere left to go.
        const activeSubmenu = document.querySelector('.submenu.active');
        const previousGroupId = activeSubmenu ? activeSubmenu.id : null;
        hideAllMenus();
        currentGroup = PANEL_GROUP[id] || null;
        const panel = document.getElementById(id);
        panel.classList.add('active');
        // Pushed here (not at the end) so that a branch below which itself
        // calls closePanel() — e.g. the Users permission check — pops
        // exactly this one entry instead of the one underneath it.
        navPushState(() => closePanelUI(previousGroupId));
        if (id === 'panelVoucher') toggleVoucherMode();
        if (id === 'panelPayments') renderCashList('Payment');
        if (id === 'panelReceipts') renderCashList('Receipt');
        if (id === 'panelDaybook') clearSelection('daybook');
        if (id === 'panelOptional') renderOptional();
        if (id === 'panelSubLedgerReport') renderSubLedgerReport();
        if (id === 'panelPendingReceivable') renderPendingReceivable();
        if (id === 'panelPendingPayable') renderPendingPayable();
        if (id === 'panelSalesStatement') renderSalesStatement();
        if (id === 'panelPurchaseReport') renderPurchaseReport();
        if (id === 'panelGstLiability') renderGstLiability();
        if (id === 'panelDeliveryNotes') renderDeliveryNotes();
        if (id === 'panelCashReport') renderCashReport();
        if (id === 'panelVoucherTypes') renderVoucherTypes();
        if (id === 'panelAlterParty') renderAlterParty();
        if (id === 'panelAlterUnit') renderAlterUnits();
        if (id === 'panelAlterVoucher') renderAlterVoucherSearch();
        if (id === 'panelRawPurchase') { populateRawPurchaseDropdowns(); document.getElementById('rpDate').valueAsDate = new Date(); }
        if (id === 'panelConversion') { populateConversionDropdowns(); document.getElementById('cvDate').valueAsDate = new Date(); }
        if (id === 'panelProcessedReport') renderProcessedReport();
        if (id === 'panelRawPurchaseReport') renderRawPurchaseReport();
        if (id === 'panelTrialBalance') renderTrialBalance();
        if (id === 'panelInvoiceGapCheck') renderInvoiceGapCheck();
        if (id === 'panelAuditTrail') renderAuditTrail();
        if (id === 'panelManageStaff') {
            if (!isAdmin() && !hasPermission('manageUsers')) { alert("Only an admin, or a user with 'Manage other users' access' turned on, can open Users."); closePanel(); return; }
            renderManageStaff();
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
        autofocusFirstField(panel);
    }

    // Focuses the first sensible field in a just-opened panel, so someone
    // can start typing right away instead of tapping into the form first —
    // most useful on Post Voucher and the various Add/Edit master forms.
    // Skips date fields (focusing one can pop a native date picker the
    // person didn't ask for) and anything hidden/disabled/readonly; falls
    // through to whatever the next real field is, so e.g. Post Voucher
    // lands on Voucher Type rather than Date.
    function autofocusFirstField(panel) {
        const field = panel.querySelector(
            'input:not([type="hidden"]):not([type="date"]):not([disabled]):not([readonly]), select:not([disabled]), textarea:not([disabled])'
        );
        if (!field) return;
        // A short delay lets the panel's own layout/scroll settle first —
        // focusing mid-transition can jump the page in an odd direction.
        setTimeout(() => field.focus(), 60);
    }

    // Back from a panel → return to whichever screen was actually showing
    // before it opened (a group's tile list, or straight to home if the
    // panel was opened directly from a dashboard shortcut).
    function closePanel() { history.back(); }
    function closePanelUI(previousGroupId) {
        hideAllMenus();
        if (previousGroupId) {
            currentGroup = previousGroupId;
            document.getElementById(previousGroupId).classList.add('active');
        } else {
            currentGroup = null;
            document.getElementById('tileMenu').style.display = 'block';
            setHomeDashboardVisible(true);
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

  
    document.getElementById('partyForm').addEventListener('submit', async (e) => {  
        e.preventDefault();  
        const groupId = document.getElementById('pGroup').value;
        if (!groupId) return alert("Please select a Ledger Group (or create one with + New).");

        const newPartyName = document.getElementById('pName').value.trim();
        const normalizedNewParty = normalizeNameForDupCheck(newPartyName);
        const similarParty = parties.find(p => normalizeNameForDupCheck(p.name) === normalizedNewParty);
        if (similarParty) {
            const proceed = await confirmAsync(`A party named "${similarParty.name}" already exists.\n\nAdd "${newPartyName}" anyway as a separate party?`);
            if (!proceed) return;
        }

        const openingAmt = Math.abs(parseFloat(document.getElementById('pOpening').value) || 0);
        const openingSign = document.getElementById('pOpeningType').value === 'Cr' ? -1 : 1;

        parties.push({  
            id: newId(parties),  
            type: document.getElementById('pType').value,
            name: document.getElementById('pName').value.trim(),  
            phone: document.getElementById('pPhone').value.trim(),  
            gstin: document.getElementById('pGstin').value.trim(),
            address: document.getElementById('pAddress').value.trim(),
            groupId: groupId,
            opening: openingAmt * openingSign,
            openingAsOf: '2000-01-01'
        });  
        localStorage.setItem('tally_mob_parties', JSON.stringify(parties));
        syncCloud();  
        document.getElementById('pGroupQuickAdd').classList.remove('active');
        document.getElementById('pGroupQuickInput').value = '';
        document.getElementById('pOpening').value = '0';
        document.getElementById('pOpeningType').value = 'Dr';
        e.target.reset();  
        render();  
    });  

    // Create a Ledger Group on the fly from inside the Party form, Tally-style.
    function quickAddLedgerGroupForParty() {
        const input = document.getElementById('pGroupQuickInput');
        const name = input.value.trim();
        if (!name) return alert("Enter a group name first.");
        const nature = document.getElementById('pGroupQuickNature').value;
        const newGroup = { id: newId(ledgerGroups), name, nature };
        ledgerGroups.push(newGroup);
        localStorage.setItem('tally_mob_ledgergroups', JSON.stringify(ledgerGroups));
        syncCloud();
        populateGroupDropdowns();
        document.getElementById('pGroup').value = newGroup.id;
        input.value = '';
        document.getElementById('pGroupQuickAdd').classList.remove('active');
        renderGroupTables();
    }
  
    function toggleCustomUom() {
        const sel = document.getElementById('itemUom').value;
        const wrap = document.getElementById('customUomWrap');
        wrap.style.display = (sel === '__CUSTOM__') ? 'block' : 'none';
    }

    // ---- Alter Party (edit an existing party's details) ----
    function renderAlterParty() {
        const body = document.getElementById('alterPartyBody');
        body.innerHTML = '';
        if (parties.length === 0) {
            body.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No parties yet.</td></tr>';
            return;
        }
        parties.forEach(p => {
            const bal = partyBalance(p.id);
            body.innerHTML += `
                <tr>
                    <td><strong>${escapeHtml(p.name)}</strong></td>
                    <td>${escapeHtml(p.type)}</td>
                    <td>${escapeHtml(p.phone || '-')}</td>
                    <td style="color:${bal >= 0 ? 'var(--success)' : 'var(--danger)'};">\u20B9${Math.abs(bal).toLocaleString('en-IN', {minimumFractionDigits: 2})} ${bal >= 0 ? 'Dr' : 'Cr'}</td>
                    <td style="display:flex; gap:6px;">
                        <button onclick="editPartyAlter(${p.id})" style="padding:4px 10px; font-size:0.75rem; width:auto;">Edit</button>
                        <button onclick="deleteParty(${p.id})" class="btn-danger" style="padding:4px 10px; font-size:0.75rem;">Delete</button>
                    </td>
                </tr>
            `;
        });
    }

    // Deletes a party outright — only allowed when nothing references it
    // (no vouchers posted against it, no non-zero opening/closing balance),
    // same safety pattern used for deleting an account/item/group. This
    // prevents Ledger/Statement history from ever pointing at a party that
    // no longer exists.
    async function deleteParty(partyId) {
        if (!isAdmin() && !hasPermission('deleteParty')) return alert("Only an admin, or a user with 'Delete a party' turned on, can delete a party.");
        const p = parties.find(x => x.id == partyId);
        if (!p) return;

        // A Journal voucher doesn't carry partyId — it points at each side
        // through journalDebit/journalCredit instead. Checking only partyId
        // would let a party used solely in journals be deleted, leaving
        // those journals pointing at a ledger that no longer exists.
        const used = transactions.some(t =>
            t.partyId == partyId
            || (t.journalDebit && t.journalDebit.kind === 'party' && t.journalDebit.id == partyId)
            || (t.journalCredit && t.journalCredit.kind === 'party' && t.journalCredit.id == partyId)
        );
        if (used) return alert(`Cannot delete "${p.name}" — it has vouchers linked to it. Delete or reassign those first.`);

        const bal = partyBalance(partyId);
        if (Math.abs(bal) > 0.005) return alert(`Cannot delete "${p.name}" — it still has an outstanding balance of \u20B9${Math.abs(bal).toLocaleString('en-IN', {minimumFractionDigits: 2})} ${bal >= 0 ? 'Dr' : 'Cr'}. Clear the balance first.`);

        if (!(await confirmAsync(`Delete party "${p.name}"? This cannot be undone.`))) return;
        parties = parties.filter(x => x.id != partyId);
        localStorage.setItem('tally_mob_parties', JSON.stringify(parties));
        syncCloud();
        renderAlterParty();
        render();
    }

    function editPartyAlter(partyId) {
        const p = parties.find(x => x.id == partyId);
        if (!p) return;

        // Populate the ledger-group dropdown fresh each time (groups may
        // have changed since the page loaded).
        const groupSel = document.getElementById('apGroup');
        groupSel.innerHTML = '<option value="">-- Select Group --</option>';
        ledgerGroups.forEach(g => groupSel.innerHTML += `<option value="${g.id}">${escapeHtml(g.name)} (${g.nature})</option>`);

        document.getElementById('apEditId').value = p.id;
        document.getElementById('apType').value = p.type;
        document.getElementById('apPhone').value = p.phone || '';
        document.getElementById('apName').value = p.name;
        groupSel.value = p.groupId || '';
        document.getElementById('apGstin').value = p.gstin || '';
        document.getElementById('apOpening').value = Math.abs(p.opening || 0);
        document.getElementById('apOpeningType').value = (p.opening || 0) < 0 ? 'Cr' : 'Dr';
        document.getElementById('apOpeningAsOf').value = p.openingAsOf || '2000-01-01';
        document.getElementById('apAddress').value = p.address || '';
        document.getElementById('alterPartyForm').style.display = 'grid';
        window.scrollTo({ top: document.getElementById('alterPartyForm').offsetTop - 20, behavior: 'smooth' });
    }

    function cancelAlterParty() {
        document.getElementById('alterPartyForm').style.display = 'none';
        document.getElementById('alterPartyForm').reset();
        document.getElementById('apEditId').value = '';
    }

    document.getElementById('alterPartyForm').addEventListener('submit', (e) => {
        e.preventDefault();
        if (!isAdmin() && !hasPermission('editParty')) return alert("Only an admin, or a user with 'Edit a party' turned on, can edit a party.");
        const editId = document.getElementById('apEditId').value;
        const p = parties.find(x => x.id == editId);
        if (!p) return;
        const groupId = document.getElementById('apGroup').value;
        if (!groupId) return alert("Please select a Ledger Group.");

        p.type = document.getElementById('apType').value;
        p.phone = document.getElementById('apPhone').value.trim();
        p.name = document.getElementById('apName').value.trim();
        p.groupId = groupId;
        p.gstin = document.getElementById('apGstin').value.trim();
        p.address = document.getElementById('apAddress').value.trim();

        const openingAmt = Math.abs(parseFloat(document.getElementById('apOpening').value) || 0);
        const openingSign = document.getElementById('apOpeningType').value === 'Cr' ? -1 : 1;
        const newOpening = openingAmt * openingSign;
        const newOpeningAsOf = document.getElementById('apOpeningAsOf').value || '2000-01-01';
        if ((newOpening !== (p.opening || 0) || newOpeningAsOf !== (p.openingAsOf || '2000-01-01')) && !isAdmin() && !hasPermission('editOpening')) {
            return alert("You don't have access to change a party's Opening Balance. The rest of your changes were not saved either — please undo the Opening Balance edit and try again.");
        }
        p.opening = newOpening;
        p.openingAsOf = newOpeningAsOf;

        localStorage.setItem('tally_mob_parties', JSON.stringify(parties));
        syncCloud();
        cancelAlterParty();
        render();
        renderAlterParty();
        alert(`${p.name} updated.`);
    });

    document.getElementById('itemForm').addEventListener('submit', async (e) => {  
        e.preventDefault();  
        let uom = document.getElementById('itemUom').value;
        if (uom === '__CUSTOM__') {
            uom = document.getElementById('itemUomCustom').value.trim();
            if (!uom) return alert("Please enter a custom unit name.");
        }
        const groupId = document.getElementById('itemGroup').value;
        if (!groupId) return alert("Please select a Stock Group (or create one with + New).");

        const editId = document.getElementById('itemEditId').value;
        // This field is labelled "Opening Qty" but doubles as the everyday
        // way to correct current stock (after a physical count, spoilage,
        // etc.), so what's typed here is always the CURRENT stock the item
        // should show right after saving — not a fixed starting point.
        // openingQty is back-solved so that opening + net ledger activity
        // so far reproduces exactly that figure; every future Purchase/Sale
        // still moves stock normally from there. See recalcStockFromLedger.
        const desiredQty = parseFloat(document.getElementById('itemQty').value) || 0;
        const netSoFar = editId ? (netLedgerQtyByItem()[editId] || 0) : 0; // 0 for a brand-new item — nothing can reference it yet
        const data = {
            name: document.getElementById('itemName').value.trim(),  
            groupId: groupId,
            hsn: document.getElementById('itemHsn').value.trim(),  
            uom: uom,  
            openingQty: desiredQty - netSoFar,
            rate: parseFloat(document.getElementById('itemRate').value) || 0,  
            gstRate: parseFloat(document.getElementById('itemGst').value) || 0  
        };

        if (editId) {
            if (!isAdmin() && !hasPermission('editItem')) return alert("Only an admin, or a user with 'Edit a stock item' turned on, can edit a stock item.");
            const item = stockItems.find(s => s.id == editId);
            if (item) Object.assign(item, data);
        } else {
            const normalizedNewItem = normalizeNameForDupCheck(data.name);
            const similarItem = stockItems.find(s => normalizeNameForDupCheck(s.name) === normalizedNewItem);
            if (similarItem) {
                const proceed = await confirmAsync(`A stock item named "${similarItem.name}" already exists.\n\nAdd "${data.name}" anyway as a separate item?`);
                if (!proceed) return;
            }
            stockItems.push({ id: newId(stockItems), ...data });
        }
        localStorage.setItem('tally_mob_stock', JSON.stringify(stockItems));
        syncCloud();  
        cancelItemEdit();
        render();  
    });  

    function editItem(itemId) {
        const item = stockItems.find(s => s.id == itemId);
        if (!item) return;
        document.getElementById('itemEditId').value = item.id;
        document.getElementById('itemName').value = item.name;
        document.getElementById('itemGroup').value = item.groupId || '';
        document.getElementById('itemHsn').value = item.hsn;
        document.getElementById('itemQty').value = item.qty;
        document.getElementById('itemRate').value = item.rate;
        document.getElementById('itemGst').value = item.gstRate;

        const uomSel = document.getElementById('itemUom');
        const preset = Array.from(uomSel.options).some(o => o.value === item.uom && o.value !== '__CUSTOM__');
        if (preset) {
            uomSel.value = item.uom;
            document.getElementById('customUomWrap').style.display = 'none';
        } else {
            uomSel.value = '__CUSTOM__';
            document.getElementById('customUomWrap').style.display = 'block';
            document.getElementById('itemUomCustom').value = item.uom;
        }

        document.getElementById('itemPanelTitle').innerText = 'Edit Stock Item';
        document.getElementById('itemSubmitBtn').innerText = 'Save Changes';
        document.getElementById('itemCancelBtn').style.display = 'block';
        openPanel('panelItem');
    }

    function cancelItemEdit() {
        document.getElementById('itemForm').reset();
        document.getElementById('itemEditId').value = '';
        document.getElementById('customUomWrap').style.display = 'none';
        document.getElementById('itemGroupQuickAdd').classList.remove('active');
        document.getElementById('itemGroupQuickInput').value = '';
        document.getElementById('itemPanelTitle').innerText = 'Add Stock Item';
        document.getElementById('itemSubmitBtn').innerText = 'Create Stock Item';
        document.getElementById('itemCancelBtn').style.display = 'none';
    }

    // ---- Alter Unit (rename a UOM everywhere it's used, Tally-style) ----
    // Units aren't a separate master list in this app — they're the free-text
    // "uom" field stored on each stock item and on each voucher line. Altering
    // a unit means finding every distinct name in use and, on rename, sweeping
    // both stockItems and every transaction's line items so nothing is left
    // referencing the old name.
    function collectDistinctUnits() {
        const counts = {};
        stockItems.forEach(i => {
            if (!i.uom) return;
            counts[i.uom] = (counts[i.uom] || 0) + 1;
        });
        return counts;
    }

    function renderAlterUnits() {
        const body = document.getElementById('alterUnitBody');
        body.innerHTML = '';
        const counts = collectDistinctUnits();
        const names = Object.keys(counts).sort((a, b) => a.localeCompare(b));
        if (names.length === 0) {
            body.innerHTML = '<tr><td colspan="3" style="text-align:center; color:var(--text-muted);">No units in use yet.</td></tr>';
            return;
        }
        names.forEach(name => {
            body.innerHTML += `
                <tr>
                    <td><strong>${escapeHtml(name)}</strong></td>
                    <td>${counts[name]} item(s)</td>
                    <td><button onclick="startAlterUnit('${escapeHtml(name)}')" style="padding:4px 10px; font-size:0.75rem; width:auto;">Rename</button></td>
                </tr>
            `;
        });
    }

    function startAlterUnit(name) {
        document.getElementById('auOldName').value = name;
        document.getElementById('auNewName').value = name;
        document.getElementById('alterUnitForm').style.display = 'grid';
        window.scrollTo({ top: document.getElementById('alterUnitForm').offsetTop - 20, behavior: 'smooth' });
    }

    function cancelAlterUnit() {
        document.getElementById('alterUnitForm').style.display = 'none';
        document.getElementById('alterUnitForm').reset();
        document.getElementById('auOldName').value = '';
    }

    document.getElementById('alterUnitForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const oldName = document.getElementById('auOldName').value;
        const newName = document.getElementById('auNewName').value.trim();
        if (!newName) return alert("Enter a new unit name.");
        if (newName === oldName) { cancelAlterUnit(); return; }

        let itemsChanged = 0, lineChanged = 0;
        stockItems.forEach(i => {
            if (i.uom === oldName) { i.uom = newName; itemsChanged++; }
        });
        transactions.forEach(t => {
            (t.items || []).forEach(line => {
                if (line.uom === oldName) { line.uom = newName; lineChanged++; }
            });
        });

        localStorage.setItem('tally_mob_stock', JSON.stringify(stockItems));
        localStorage.setItem('tally_mob_db', JSON.stringify(transactions));
        syncCloud();

        cancelAlterUnit();
        render();
        renderAlterUnits();
        alert(`Renamed "${oldName}" to "${newName}" across ${itemsChanged} item(s) and ${lineChanged} voucher line(s).`);
    });

    // ---- Stock Groups (Tally-style "Under Group" for items) ----
    document.getElementById('stockGroupForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const name = document.getElementById('stockGroupName').value.trim();
        const editId = document.getElementById('stockGroupEditId').value;
        if (editId) {
            const g = stockGroups.find(s => s.id == editId);
            if (g) g.name = name;
        } else {
            stockGroups.push({ id: newId(stockGroups), name });
        }
        localStorage.setItem('tally_mob_stockgroups', JSON.stringify(stockGroups));
        syncCloud();
        cancelStockGroupEdit();
        render();
    });

    function editStockGroup(groupId) {
        const g = stockGroups.find(s => s.id == groupId);
        if (!g) return;
        document.getElementById('stockGroupEditId').value = g.id;
        document.getElementById('stockGroupName').value = g.name;
        document.getElementById('stockGroupPanelTitle').innerText = 'Edit Stock Group';
        document.getElementById('stockGroupSubmitBtn').innerText = 'Save Changes';
        document.getElementById('stockGroupCancelBtn').style.display = 'block';
        openPanel('panelStockGroup');
    }

    function cancelStockGroupEdit() {
        document.getElementById('stockGroupForm').reset();
        document.getElementById('stockGroupEditId').value = '';
        document.getElementById('stockGroupPanelTitle').innerText = 'Stock Groups';
        document.getElementById('stockGroupSubmitBtn').innerText = 'Create Stock Group';
        document.getElementById('stockGroupCancelBtn').style.display = 'none';
    }

    async function deleteStockGroup(groupId) {
        if (!isAdmin() && !hasPermission('deleteGroup')) return alert("Only an admin, or a user with 'Delete a ledger/stock group' turned on, can delete a group.");
        const used = stockItems.some(i => i.groupId == groupId);
        if (used) return alert("Cannot delete a group that has stock items in it. Move those items to another group first.");
        const g = stockGroups.find(s => s.id == groupId);
        if (g && await confirmAsync(`Delete stock group "${g.name}"?`)) {
            stockGroups = stockGroups.filter(s => s.id != groupId);
            localStorage.setItem('tally_mob_stockgroups', JSON.stringify(stockGroups));
            syncCloud();
            render();
        }
    }

    // Create a Stock Group on the fly from inside the Item form, Tally-style.
    // ---- Sub-Ledger / Category helpers ----
    function populateSubLedgerDropdown() {
        const sel = document.getElementById('vSubLedger');
        if (!sel) return;
        const prev = sel.value;
        sel.innerHTML = '<option value="">-- Select Category --</option>';
        subLedgers.forEach(name => {
            sel.innerHTML += `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
        });
        if (prev && subLedgers.includes(prev)) sel.value = prev;
    }

    function quickAddSubLedger() {
        const input = document.getElementById('subLedgerQuickInput');
        const name = input.value.trim();
        if (!name) return alert("Enter a category name first.");
        if (subLedgers.some(s => s.toLowerCase() === name.toLowerCase())) {
            return alert("That category already exists.");
        }
        subLedgers.push(name);
        localStorage.setItem('tally_mob_subledgers', JSON.stringify(subLedgers));
        syncCloud();
        populateSubLedgerDropdown();
        document.getElementById('vSubLedger').value = name;
        input.value = '';
        document.getElementById('subLedgerQuickAdd').classList.remove('active');
    }

    function quickAddStockGroup() {
        const input = document.getElementById('itemGroupQuickInput');
        const name = input.value.trim();
        if (!name) return alert("Enter a group name first.");
        const newGroup = { id: newId(stockGroups), name };
        stockGroups.push(newGroup);
        localStorage.setItem('tally_mob_stockgroups', JSON.stringify(stockGroups));
        syncCloud();
        populateGroupDropdowns();
        document.getElementById('itemGroup').value = newGroup.id;
        input.value = '';
        document.getElementById('itemGroupQuickAdd').classList.remove('active');
        renderGroupTables();
    }

    // ---- Cash / Bank / Capital accounts ----
    document.getElementById('accountForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const groupId = document.getElementById('acctGroup').value;
        if (!groupId) return alert("Please select a Ledger Group (or create one with + New).");

        const editId = document.getElementById('acctEditId').value;
        const data = {
            name: document.getElementById('acctName').value.trim(),
            type: document.getElementById('acctType').value,
            groupId: groupId,
            opening: parseFloat(document.getElementById('acctOpening').value) || 0,
            openingAsOf: document.getElementById('acctOpeningAsOf').value || '2000-01-01'
        };
        if (editId) {
            const acc = accounts.find(a => a.id == editId);
            if (!acc) return;
            if (!isAdmin() && !hasPermission('editAccount')) return alert("Only an admin, or a user with 'Edit a cash/bank account' turned on, can edit an account.");
            if ((data.opening !== (acc.opening || 0) || data.openingAsOf !== (acc.openingAsOf || '2000-01-01')) && !isAdmin() && !hasPermission('editOpening')) {
                return alert("You don't have access to change an account's Opening Balance. The rest of your changes were not saved either — please undo the Opening Balance edit and try again.");
            }
            Object.assign(acc, data);
        } else {
            accounts.push({ id: newId(accounts), ...data });
        }
        localStorage.setItem('tally_mob_accounts', JSON.stringify(accounts));
        syncCloud();
        cancelAcctEdit();
        render();
    });

    // Balance for a Cash/Bank account as of a given date (exclusive of the
    // cutoff itself) — i.e. the manual opening balance plus every
    // transaction from openingAsOf up to but not including `cutoff`.
    // Pass cutoff=null for "everything, no upper bound" (= accountBalance).
    // True if the given transaction type is a custom voucher type marked
    // "No" for Requires a Party — these behave like a Payment (cash-out)
    // for account balance purposes, since a no-party custom voucher in
    // this app always represents money leaving an account (e.g. Rent,
    // Transport, Bank Charges), never money coming in.
    function isCustomNoPartyType(type) {
        const vt = customVoucherTypes.find(v => v.id === type);
        return !!(vt && vt.requiresParty === 'no');
    }

    function accountBalanceAsOf(accId, cutoff) {
        const acc = accounts.find(a => a.id == accId);
        if (!acc) return 0;
        const asOf = acc.openingAsOf || '2000-01-01';
        let bal = acc.opening || 0;
        transactions.forEach(t => {
            if (t.date < asOf || (cutoff && t.date >= cutoff)) return;
            if (t.type === 'Journal') {
                // Debit increases the ledger's balance, Credit decreases it —
                // same convention as an account (Receipt=Debit=in, Payment=Credit=out).
                if (t.journalDebit && t.journalDebit.kind === 'account' && t.journalDebit.id == accId) bal += t.grandTotal;
                if (t.journalCredit && t.journalCredit.kind === 'account' && t.journalCredit.id == accId) bal -= t.grandTotal;
                return;
            }
            if (t.accountId == accId) {
                if (t.type === 'Receipt') bal += t.grandTotal;   // money in
                else if (t.type === 'Payment') bal -= t.grandTotal; // money out
                else if (isCustomNoPartyType(t.type)) bal -= t.grandTotal; // custom no-party types (e.g. Expense) are always cash-out
            }
        });
        return bal;
    }
    function accountBalance(accId) {
        return accountBalanceAsOf(accId, null);
    }

    // Net closing balance for a party as of a given date (exclusive) —
    // positive (Dr) means they owe us, negative (Cr) means we owe them.
    // Pass cutoff=null for "everything, no upper bound" (= partyBalance).
    // Same "opening + everything since openingAsOf" pattern as
    // accountBalanceAsOf, so Start New Financial Year (below) and the
    // per-Financial-Year ledger statement can both use it identically.
    function partyBalanceAsOf(partyId, cutoff) {
        const p = parties.find(x => x.id == partyId);
        if (!p) return 0;
        const asOf = p.openingAsOf || '2000-01-01';
        let bal = p.opening || 0;
        transactions.forEach(t => {
            if (t.date < asOf || (cutoff && t.date >= cutoff)) return;
            if (t.type === 'Journal') {
                if (t.journalDebit && t.journalDebit.kind === 'party' && t.journalDebit.id == partyId) bal += t.grandTotal;
                if (t.journalCredit && t.journalCredit.kind === 'party' && t.journalCredit.id == partyId) bal -= t.grandTotal;
                return;
            }
            if (t.partyId == partyId) {
                if (t.type === 'Sales') bal += t.grandTotal;
                else if (t.type === 'Receipt') bal -= t.grandTotal;
                else if (t.type === 'Purchase' || t.type === 'RawPurchase') bal -= t.grandTotal;
                else if (t.type === 'Payment') bal += t.grandTotal;
                else if (t.customVoucherTypeId && t.inMainBooks) {
                    // A custom voucher type can be configured to debit or
                    // credit the party it's raised against ("they owe you" /
                    // "you owe them"), and the ledger statement already shows
                    // it in exactly those columns — so the party's actual
                    // BALANCE has to move by the same amount, or the running
                    // total on the statement won't agree with the closing
                    // figure shown everywhere else. Off-book custom types
                    // (inMainBooks false) are deliberately skipped, same as
                    // Optional vouchers.
                    if (t.ledgerEffect === 'debit') bal += t.grandTotal;
                    else if (t.ledgerEffect === 'credit') bal -= t.grandTotal;
                }
            }
        });
        return bal;
    }
    function partyBalance(partyId) {
        return partyBalanceAsOf(partyId, null);
    }

    // ---- Trial Balance ----
    function renderTrialBalance() {
        // Default the carry-forward date to the next 1 April if the user
        // hasn't picked one yet, purely as a convenient starting point.
        const dateInput = document.getElementById('fyCarryForwardDate');
        if (!dateInput.value) {
            const today = new Date();
            let nextApril = today.getMonth() < 3 ? today.getFullYear() : today.getFullYear() + 1;
            dateInput.value = `${nextApril}-04-01`;
        }

        const rows = [];
        let totalDr = 0, totalCr = 0;

        parties.forEach(p => {
            const bal = partyBalance(p.id);
            if (Math.abs(bal) < 0.005) return;
            const group = ledgerGroups.find(g => g.id == p.groupId);
            rows.push({ name: p.name, group: group ? group.name : '-', dr: bal > 0 ? bal : 0, cr: bal < 0 ? -bal : 0 });
            if (bal > 0) totalDr += bal; else totalCr += -bal;
        });

        accounts.forEach(a => {
            const bal = accountBalance(a.id);
            if (Math.abs(bal) < 0.005) return;
            const group = ledgerGroups.find(g => g.id == a.groupId);
            rows.push({ name: `${a.name} (${a.type})`, group: group ? group.name : '-', dr: bal > 0 ? bal : 0, cr: bal < 0 ? -bal : 0 });
            if (bal > 0) totalDr += bal; else totalCr += -bal;
        });

        // Sales / Purchase / Raw Purchase Accounts — all-time taxable value
        // (the GST itself is booked separately, below, as Duties & Taxes).
        const salesTaxable = transactions.filter(t => t.type === 'Sales').reduce((s, t) => s + t.taxable, 0);
        if (salesTaxable > 0.005) { rows.push({ name: 'Sales Account', group: 'Income', dr: 0, cr: salesTaxable }); totalCr += salesTaxable; }

        const purchaseTaxable = transactions.filter(t => t.type === 'Purchase').reduce((s, t) => s + t.taxable, 0);
        if (purchaseTaxable > 0.005) { rows.push({ name: 'Purchase Account', group: 'Expenses', dr: purchaseTaxable, cr: 0 }); totalDr += purchaseTaxable; }

        const rawPurchaseTaxable = transactions.filter(t => t.type === 'RawPurchase').reduce((s, t) => s + t.taxable, 0);
        if (rawPurchaseTaxable > 0.005) { rows.push({ name: 'Raw Purchase Account', group: 'Expenses', dr: rawPurchaseTaxable, cr: 0 }); totalDr += rawPurchaseTaxable; }

        // Duties & Taxes — net GST (Output from Sales minus Input from
        // Purchase), same convention as the GST Liability report.
        const outputTax = transactions.filter(t => t.type === 'Sales').reduce((s, t) => s + t.totalTax, 0);
        const inputTax = transactions.filter(t => t.type === 'Purchase').reduce((s, t) => s + t.totalTax, 0);
        const netGst = outputTax - inputTax;
        if (netGst > 0.005) { rows.push({ name: 'Duties & Taxes (GST Payable)', group: 'Liabilities', dr: 0, cr: netGst }); totalCr += netGst; }
        else if (netGst < -0.005) { rows.push({ name: 'Duties & Taxes (GST Credit Carried Forward)', group: 'Assets', dr: -netGst, cr: 0 }); totalDr += -netGst; }

        rows.sort((a, b) => a.name.localeCompare(b.name));

        const body = document.getElementById('trialBalanceBody');
        if (rows.length === 0) {
            body.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">No ledger balances yet.</td></tr>';
        } else {
            body.innerHTML = rows.map(r => `
                <tr>
                    <td>${escapeHtml(r.name)}</td>
                    <td style="color:var(--text-muted);">${escapeHtml(r.group)}</td>
                    <td style="color:var(--success);">${r.dr > 0 ? '\u20B9' + r.dr.toLocaleString('en-IN', {minimumFractionDigits: 2}) : '-'}</td>
                    <td style="color:var(--danger);">${r.cr > 0 ? '\u20B9' + r.cr.toLocaleString('en-IN', {minimumFractionDigits: 2}) : '-'}</td>
                </tr>
            `).join('');
        }

        document.getElementById('tbTotalDr').innerText = `\u20B9${totalDr.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
        document.getElementById('tbTotalCr').innerText = `\u20B9${totalCr.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
        const diff = totalDr - totalCr;
        const diffEl = document.getElementById('tbDifference');
        diffEl.innerText = `\u20B9${Math.abs(diff).toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
        diffEl.style.color = Math.abs(diff) < 0.01 ? 'var(--success)' : 'var(--danger)';
    }

    // Snapshots every party's, account's, and stock item's CURRENT closing
    // balance as their new Opening Balance/Opening Qty from the chosen date onward. Nothing is
    // deleted — every past voucher stays exactly as editable/deletable as
    // it always was; this only moves where the running-balance count
    // starts from, same as closing a financial year in any accounting
    // system.
    async function startNewFinancialYear() {
        if (!isAdmin() && !hasPermission('newFinancialYear')) return alert("Only an admin, or a user with 'Start a new financial year' turned on, can do this.");
        const asOfDate = document.getElementById('fyCarryForwardDate').value;
        if (!asOfDate) return alert("Please choose the date the new financial year starts on.");

        const confirmMsg = `This will set every party's and account's current closing balance, AND every stock item's current "In Stock" figure, as their new Opening Balance/Opening Qty, effective ${asOfDate}.\n\nPast vouchers are NOT deleted or locked — they stay fully visible and editable.\n\nProceed?`;
        if (!(await confirmAsync(confirmMsg))) return;

        parties.forEach(p => {
            p.opening = partyBalance(p.id);
            p.openingAsOf = asOfDate;
        });
        accounts.forEach(a => {
            a.opening = accountBalance(a.id);
            a.openingAsOf = asOfDate;
        });
        // Same rollover for stock: whatever's currently on the shelf becomes
        // each item's new Opening Qty, and openingAsOf moves forward so
        // netLedgerQtyByItem() stops counting anything before this date —
        // it's already folded into the new opening figure. recalcStockFromLedger()
        // then rebuilds item.qty from that new baseline before render() runs.
        stockItems.forEach(s => {
            s.openingQty = s.qty;
            s.openingAsOf = asOfDate;
        });
        recalcStockFromLedger();

        localStorage.setItem('tally_mob_parties', JSON.stringify(parties));
        localStorage.setItem('tally_mob_accounts', JSON.stringify(accounts));
        localStorage.setItem('tally_mob_stock', JSON.stringify(stockItems));
        syncCloud();

        render();
        renderTrialBalance();
        alert(`Done. Opening balances carried forward as of ${asOfDate}.`);
    }

    // ---- Invoice Number Gap Check ----
    // Every voucher number is produced by nextVoucherNo() as
    // SDS/<financial year>/<prefix>/<number>, and that counter climbs
    // by exactly 1 each time a voucher of that type+year is posted. On
    // top of that, deleting a voucher (see renumberSeriesAfterDelete())
    // shifts every later voucher in its own series down by one number,
    // so within one series (one FY + one prefix, e.g. SDS/25-26/INV) the
    // numbers actually in use should always run 1, 2, 3, ... with
    // nothing missing. A hole in that run at this point would mean a
    // voucher's number was edited/typed manually outside the normal
    // auto-numbering, or a very old voucher predates this renumbering
    // behaviour — either way, worth checking and documenting before an
    // audit rather than being found for the first time by a tax officer.
    function renderInvoiceGapCheck() {
        const seriesMap = {};   // "FY/PREFIX" -> { fy, prefix, numbers: { n: [txns] } }
        const unparsed = [];

        transactions.forEach(t => {
            const m = /^SDS\/([^/]+)\/([^/]+)\/(\d+)$/.exec(t.invNo || '');
            if (!m) { unparsed.push(t); return; }
            const fy = m[1], prefix = m[2], num = parseInt(m[3], 10);
            const key = fy + '/' + prefix;
            if (!seriesMap[key]) seriesMap[key] = { fy, prefix, numbers: {} };
            (seriesMap[key].numbers[num] = seriesMap[key].numbers[num] || []).push(t);
        });

        const seriesKeys = Object.keys(seriesMap).sort((a, b) => {
            const [fyA, pfxA] = a.split('/');
            const [fyB, pfxB] = b.split('/');
            if (fyA !== fyB) return fyB.localeCompare(fyA); // newest financial year first
            return pfxA.localeCompare(pfxB);
        });

        let totalMissing = 0, seriesWithGaps = 0;
        const duplicateGroups = []; // { fy, prefix, num, count }

        const rowsHtml = seriesKeys.map(key => {
            const s = seriesMap[key];
            const nums = Object.keys(s.numbers).map(Number).sort((a, b) => a - b);
            const min = nums[0], max = nums[nums.length - 1];

            const missing = [];
            for (let i = 1; i <= max; i++) {
                if (!s.numbers[i]) missing.push(i);
            }
            if (missing.length) { totalMissing += missing.length; seriesWithGaps++; }

            Object.keys(s.numbers).forEach(numStr => {
                if (s.numbers[numStr].length > 1) {
                    duplicateGroups.push({ fy: s.fy, prefix: s.prefix, num: Number(numStr), count: s.numbers[numStr].length });
                }
            });

            const seriesLabel = `SDS/${s.fy}/${s.prefix}`;
            const missingLabel = missing.length === 0
                ? '&mdash;'
                : missing.slice(0, 12).map(n => String(n).padStart(4, '0')).join(', ')
                    + (missing.length > 12 ? ` &hellip; +${missing.length - 12} more` : '');
            const statusHtml = missing.length === 0
                ? '<span style="color:var(--success); font-weight:600;">&#10003; No gaps</span>'
                : `<span style="color:var(--danger); font-weight:600;">&#9888; ${missing.length} missing</span>`;

            return `<tr>
                <td><strong>${escapeHtml(seriesLabel)}</strong></td>
                <td>${nums.length}</td>
                <td>${String(min).padStart(4, '0')} &ndash; ${String(max).padStart(4, '0')}</td>
                <td>${missingLabel}</td>
                <td>${statusHtml}</td>
            </tr>`;
        }).join('');

        document.getElementById('invoiceGapBody').innerHTML = rowsHtml ||
            '<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No vouchers posted yet.</td></tr>';

        let summaryHtml = totalMissing > 0
            ? `<div style="background: rgba(192,57,43,0.12); border:1px solid var(--danger); border-radius: var(--radius-sm); padding:12px 14px; margin-bottom:10px; color:var(--danger); font-size:0.85rem;">
                &#9888; ${totalMissing} invoice number${totalMissing === 1 ? '' : 's'} missing, across ${seriesWithGaps} series. Usually means a voucher was deleted after it was numbered &mdash; if you can't account for a number below, it's worth a note (or a replacement/cancelled voucher) so it's explained if this ever gets checked.
            </div>`
            : `<div style="background: rgba(27,95,168,0.10); border:1px solid var(--success); border-radius: var(--radius-sm); padding:12px 14px; margin-bottom:10px; color:var(--success); font-size:0.85rem;">
                &#10003; No gaps found in any voucher series.
            </div>`;
        if (duplicateGroups.length > 0) {
            const items = duplicateGroups.map(g => {
                const label = `SDS/${g.fy}/${g.prefix}/${String(g.num).padStart(4, '0')}`;
                return `<div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:4px 0;">
                    <span>${escapeHtml(label)} (used ${g.count}\u00d7)</span>
                    <button onclick="event.stopPropagation(); resolveDuplicateInvoiceNumber('${escapeHtml(g.fy)}','${escapeHtml(g.prefix)}',${g.num})" style="width:auto; padding:5px 12px; font-size:0.75rem; background:var(--warning); border-color:rgba(255,255,255,0.3);">Fix numbering</button>
                </div>`;
            }).join('');
            summaryHtml += `<div style="background: rgba(200,127,43,0.12); border:1px solid var(--warning); border-radius: var(--radius-sm); padding:12px 14px; color:var(--warning); font-size:0.85rem;">
                &#9888; Duplicate invoice number${duplicateGroups.length === 1 ? '' : 's'} (same number used more than once). The older voucher keeps its number; "Fix numbering" moves the newer one(s) to the next free number in that series and updates any receipt/payment referencing it.
                <div style="margin-top:8px;">${items}</div>
            </div>`;
        }
        document.getElementById('invoiceGapSummary').innerHTML = summaryHtml;

        const unparsedEl = document.getElementById('invoiceGapUnparsed');
        if (unparsed.length > 0) {
            const sample = unparsed.slice(0, 5).map(t => escapeHtml(t.invNo || '(blank)')).join(', ');
            unparsedEl.innerHTML = `${unparsed.length} voucher${unparsed.length === 1 ? '' : 's'} not in the SDS/&lt;year&gt;/&lt;prefix&gt;/&lt;number&gt; format this check expects, so excluded from the analysis above: ${sample}${unparsed.length > 5 ? `, &hellip; +${unparsed.length - 5} more` : ''}.`;
        } else {
            unparsedEl.innerHTML = '';
        }
    }

    // ---- Manage Staff Access (admin-only) ----
    function renderManageStaff() {
        const body = document.getElementById('manageStaffBody');
        const emails = Object.keys(userRoles);
        if (emails.length === 0) {
            body.innerHTML = '<tr><td colspan="3" style="text-align:center; color:var(--text-muted);">No accounts yet.</td></tr>';
            return;
        }
        body.innerHTML = emails.sort().map(email => {
            const entry = userRoles[email];
            const isAdminRole = entry === 'admin';
            const isMe = email === currentUserEmail();
            return `
                <tr>
                    <td>${escapeHtml(email)}${isMe ? ' <span style="color:var(--text-muted); font-size:0.78rem;">(you)</span>' : ''}</td>
                    <td><strong style="color:${isAdminRole ? 'var(--success)' : 'var(--text-main)'};">${isAdminRole ? 'Admin' : 'User'}</strong></td>
                    <td style="display:flex; gap:6px; flex-wrap:wrap;">
                        ${!isAdminRole ? `<button onclick="openUserPermissionsModal('${email}')" style="padding:4px 10px; font-size:0.75rem; width:auto;">Permissions</button>` : ''}
                        <button onclick="toggleStaffRole('${email}')" style="padding:4px 10px; font-size:0.75rem; width:auto;">Make ${isAdminRole ? 'User' : 'Admin'}</button>
                        ${!isMe ? `<button onclick="removeStaffRole('${email}')" class="btn-danger" style="padding:4px 10px; font-size:0.75rem; width:auto;">Remove</button>` : ''}
                    </td>
                </tr>
            `;
        }).join('');
    }

    function setStaffRole() {
        const email = document.getElementById('newStaffEmail').value.trim().toLowerCase();
        const role = document.getElementById('newStaffRole').value;
        if (!email) return alert("Enter the user's email.");
        // Admin stays a plain string, unchanged. A brand-new User starts
        // with every individual permission OFF — an admin turns on
        // specifically what that person needs via the Permissions button.
        userRoles[email] = (role === 'admin') ? 'admin' : blankPermissions();
        localStorage.setItem('tally_mob_userroles', JSON.stringify(userRoles));
        syncCloud();
        document.getElementById('newStaffEmail').value = '';
        renderManageStaff();
    }

    function toggleStaffRole(email) {
        if (email === currentUserEmail()) return alert("You can't change your own role — ask another admin to do it.");
        const isCurrentlyAdmin = userRoles[email] === 'admin';
        // Switching Admin -> User starts them with everything off (same as
        // a brand-new User) rather than guessing what they should keep.
        // Switching User -> Admin simply grants full authority, as before.
        userRoles[email] = isCurrentlyAdmin ? blankPermissions() : 'admin';
        localStorage.setItem('tally_mob_userroles', JSON.stringify(userRoles));
        syncCloud();
        renderManageStaff();
    }

    async function removeStaffRole(email) {
        if (email === currentUserEmail()) return alert("You can't remove your own access this way.");
        if (!(await confirmAsync(`Remove ${email}'s access role? They will default back to a User with everything off if they sign in again (their Firebase login itself is unaffected — remove that separately in the Firebase Console if needed).`))) return;
        delete userRoles[email];
        localStorage.setItem('tally_mob_userroles', JSON.stringify(userRoles));
        syncCloud();
        renderManageStaff();
    }

    // ---- Per-user permission toggles ----
    let permModalEmail = null;

    function openUserPermissionsModal(email) {
        permModalEmail = email;
        document.getElementById('permUserEmail').textContent = email;
        const entry = userRoles[email];
        // Normalize: an old plain 'staff' string, or a missing entry,
        // starts the toggle list from all-off rather than crashing.
        const perms = (entry && typeof entry === 'object') ? entry : blankPermissions();

        const list = document.getElementById('permUserToggleList');
        list.innerHTML = PERMISSION_DEFS.map(p => `
            <label style="display:flex; align-items:center; gap:10px; padding:8px 4px; border-bottom:1px solid var(--border); cursor:pointer; font-weight:normal;">
                <input type="checkbox" data-perm-key="${p.key}" ${perms[p.key] ? 'checked' : ''} style="width:18px; height:18px; flex-shrink:0;">
                <span>${p.label}</span>
            </label>
        `).join('');

        document.getElementById('userPermissionsModal').style.display = 'flex';
    }

    function closeUserPermissionsModal() {
        document.getElementById('userPermissionsModal').style.display = 'none';
        permModalEmail = null;
    }

    function saveUserPermissions() {
        if (!permModalEmail) return;
        const perms = blankPermissions();
        document.querySelectorAll('#permUserToggleList input[data-perm-key]').forEach(cb => {
            perms[cb.dataset.permKey] = cb.checked;
        });
        userRoles[permModalEmail] = perms;
        localStorage.setItem('tally_mob_userroles', JSON.stringify(userRoles));
        syncCloud();
        closeUserPermissionsModal();
        renderManageStaff();
        alert('Permissions saved.');
    }

    // Updates the parts of the UI that depend on role — called after
    // login and whenever userRoles/render refreshes. The real
    // enforcement lives in the gated functions themselves (deleteX(),
    // startNewFinancialYear(), etc.) — this just keeps the buttons a
    // staff account sees in line with what they're actually allowed to do.
    function applyRolePermissions() {
        const admin = isAdmin();
        const roleBadge = document.getElementById('roleBadge');
        if (roleBadge) {
            roleBadge.style.display = 'inline-block';
            roleBadge.textContent = admin ? 'Admin' : 'User';
        }
        const staffTile = document.getElementById('manageStaffTile');
        if (staffTile) staffTile.style.display = (admin || hasPermission('manageUsers')) ? '' : 'none';
    }

    function editAccount(accId) {
        const acc = accounts.find(a => a.id == accId);
        if (!acc) return;
        document.getElementById('acctEditId').value = acc.id;
        document.getElementById('acctName').value = acc.name;
        document.getElementById('acctType').value = acc.type;
        document.getElementById('acctGroup').value = acc.groupId || '';
        document.getElementById('acctOpening').value = acc.opening;
        document.getElementById('acctOpeningAsOf').value = acc.openingAsOf || '2000-01-01';
        document.getElementById('acctPanelTitle').innerText = 'Edit Account';
        document.getElementById('acctSubmitBtn').innerText = 'Save Changes';
        document.getElementById('acctCancelBtn').style.display = 'block';
        openPanel('panelAccounts');
    }

    function cancelAcctEdit() {
        document.getElementById('accountForm').reset();
        document.getElementById('acctEditId').value = '';
        document.getElementById('acctGroupQuickAdd').classList.remove('active');
        document.getElementById('acctGroupQuickInput').value = '';
        document.getElementById('acctPanelTitle').innerText = 'Cash / Bank Accounts';
        document.getElementById('acctSubmitBtn').innerText = 'Create Account';
        document.getElementById('acctCancelBtn').style.display = 'none';
    }

    async function deleteAccount(accId) {
        if (!isAdmin() && !hasPermission('deleteAccount')) return alert("Only an admin, or a user with 'Delete a cash/bank account' turned on, can delete an account.");
        // Same Journal blind spot as deleteParty above — journals link to an
        // account through journalDebit/journalCredit rather than accountId.
        const used = transactions.some(t =>
            t.accountId == accId
            || (t.journalDebit && t.journalDebit.kind === 'account' && t.journalDebit.id == accId)
            || (t.journalCredit && t.journalCredit.kind === 'account' && t.journalCredit.id == accId)
        );
        if (used) return alert("Cannot delete an account that has transactions linked to it.");
        const acc = accounts.find(a => a.id == accId);
        if (acc && await confirmAsync(`Delete account "${acc.name}"?`)) {
            accounts = accounts.filter(a => a.id != accId);
            localStorage.setItem('tally_mob_accounts', JSON.stringify(accounts));
            syncCloud();
            render();
        }
    }

    // ---- Ledger Groups (Tally-style "Under Group" for ledgers/accounts) ----
    document.getElementById('ledgerGroupForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const name = document.getElementById('ledgerGroupName').value.trim();
        const nature = document.getElementById('ledgerGroupNature').value;
        const editId = document.getElementById('ledgerGroupEditId').value;
        if (editId) {
            const g = ledgerGroups.find(l => l.id == editId);
            if (g) { g.name = name; g.nature = nature; }
        } else {
            ledgerGroups.push({ id: newId(ledgerGroups), name, nature });
        }
        localStorage.setItem('tally_mob_ledgergroups', JSON.stringify(ledgerGroups));
        syncCloud();
        cancelLedgerGroupEdit();
        render();
    });

    function editLedgerGroup(groupId) {
        const g = ledgerGroups.find(l => l.id == groupId);
        if (!g) return;
        document.getElementById('ledgerGroupEditId').value = g.id;
        document.getElementById('ledgerGroupName').value = g.name;
        document.getElementById('ledgerGroupNature').value = g.nature || 'Assets';
        document.getElementById('ledgerGroupPanelTitle').innerText = 'Edit Ledger Group';
        document.getElementById('ledgerGroupSubmitBtn').innerText = 'Save Changes';
        document.getElementById('ledgerGroupCancelBtn').style.display = 'block';
        openPanel('panelLedgerGroup');
    }

    function cancelLedgerGroupEdit() {
        document.getElementById('ledgerGroupForm').reset();
        document.getElementById('ledgerGroupEditId').value = '';
        document.getElementById('ledgerGroupPanelTitle').innerText = 'Ledger Groups';
        document.getElementById('ledgerGroupSubmitBtn').innerText = 'Create Ledger Group';
        document.getElementById('ledgerGroupCancelBtn').style.display = 'none';
    }

    async function deleteLedgerGroup(groupId) {
        if (!isAdmin() && !hasPermission('deleteGroup')) return alert("Only an admin, or a user with 'Delete a ledger/stock group' turned on, can delete a group.");
        const used = accounts.some(a => a.groupId == groupId) || parties.some(p => p.groupId == groupId);
        if (used) return alert("Cannot delete a group that has ledgers in it. Move those ledgers to another group first.");
        const g = ledgerGroups.find(l => l.id == groupId);
        if (g && await confirmAsync(`Delete ledger group "${g.name}"?`)) {
            ledgerGroups = ledgerGroups.filter(l => l.id != groupId);
            localStorage.setItem('tally_mob_ledgergroups', JSON.stringify(ledgerGroups));
            syncCloud();
            render();
        }
    }

    // Create a Ledger Group on the fly from inside the Account form, Tally-style.
    function quickAddLedgerGroup() {
        const input = document.getElementById('acctGroupQuickInput');
        const name = input.value.trim();
        if (!name) return alert("Enter a group name first.");
        const nature = document.getElementById('acctGroupQuickNature').value;
        const newGroup = { id: newId(ledgerGroups), name, nature };
        ledgerGroups.push(newGroup);
        localStorage.setItem('tally_mob_ledgergroups', JSON.stringify(ledgerGroups));
        syncCloud();
        populateGroupDropdowns();
        document.getElementById('acctGroup').value = newGroup.id;
        input.value = '';
        document.getElementById('acctGroupQuickAdd').classList.remove('active');
        renderGroupTables();
    }
  
    function autoFillItem() {  
        const id = document.getElementById('vItem').value;  
        const item = stockItems.find(s => s.id == id);
        if (!item) { document.getElementById('vRate').value = ''; return; }

        // Prefer the rate this exact party paid/was charged for this exact
        // item last time (same voucher type — Sales and Purchase rates
        // differ), since prices often repeat. Falls back to the item's
        // master rate if there's no history yet with this party.
        const partyId = document.getElementById('vParty').value;
        const voucherType = document.getElementById('vType').value;
        let lastRate = null;

        if (partyId) {
            const history = transactions
                .filter(t => t.type === voucherType && t.partyId == partyId && Array.isArray(t.items))
                .sort((a, b) => b.id - a.id);
            for (const t of history) {
                const line = t.items.find(it => it.itemId == id);
                if (line) { lastRate = line.inclRate; break; }
            }
        }

        document.getElementById('vRate').value = (lastRate !== null) ? lastRate : item.rate;
    }  

    // -------------------------------------------------------------
    // Item search combobox for voucher entry — same type-to-search
    // pattern as the party field above. #vItem (hidden) still holds
    // the selected item id, so autoFillItem()/addItemToVoucher() keep
    // working unchanged.
    // -------------------------------------------------------------
    let vItemFiltered = [];
    let vItemActiveIndex = -1;

    function filterItemDropdown() {
        document.getElementById('vItem').value = '';

        const q = document.getElementById('vItemSearch').value.trim().toLowerCase();
        const listEl = document.getElementById('vItemList');

        vItemFiltered = stockItems.filter(s => !q || s.name.toLowerCase().includes(q));
        vItemActiveIndex = -1;

        if (vItemFiltered.length === 0) {
            listEl.innerHTML = '<div class="party-ac-empty">No matching item</div>';
        } else {
            listEl.innerHTML = vItemFiltered.map((s, idx) => `
                <div class="party-ac-item" data-idx="${idx}" onclick="selectItemFromList(${idx})">
                    ${escapeHtml(s.name)} <span style="color:var(--text-muted); font-size:0.8em;">(${escapeHtml(s.uom || '')})</span>
                </div>
            `).join('');
        }
        listEl.style.display = 'block';
    }

    function selectItemFromList(idx) {
        const s = vItemFiltered[idx];
        if (!s) return;
        document.getElementById('vItem').value = s.id;
        document.getElementById('vItemSearch').value = s.name;
        document.getElementById('vItemList').style.display = 'none';
        autoFillItem();
    }

    function handleItemKeydown(e) {
        const listEl = document.getElementById('vItemList');
        if (listEl.style.display === 'none') return;
        const items = listEl.querySelectorAll('.party-ac-item');

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            vItemActiveIndex = Math.min(vItemActiveIndex + 1, items.length - 1);
            items.forEach((el, i) => el.classList.toggle('active', i === vItemActiveIndex));
            if (items[vItemActiveIndex]) items[vItemActiveIndex].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            vItemActiveIndex = Math.max(vItemActiveIndex - 1, 0);
            items.forEach((el, i) => el.classList.toggle('active', i === vItemActiveIndex));
            if (items[vItemActiveIndex]) items[vItemActiveIndex].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (vItemActiveIndex >= 0 && vItemFiltered[vItemActiveIndex]) {
                selectItemFromList(vItemActiveIndex);
            } else if (vItemFiltered.length === 1) {
                selectItemFromList(0);
            }
        } else if (e.key === 'Escape') {
            listEl.style.display = 'none';
        }
    }

    // Close the item dropdown when tapping/clicking outside it.
    document.addEventListener('click', function(e) {
        const input = document.getElementById('vItemSearch');
        const list = document.getElementById('vItemList');
        if (!input || !list) return;
        if (list.style.display === 'none') return;
        if (e.target === input || input.contains(e.target) || list.contains(e.target)) return;
        list.style.display = 'none';
    });

    // Calculate inclusive GST
    function calculateInclusiveTax(inclRate, qty, gstRate) {
        const lineTotal = inclRate * qty;
        const taxable = lineTotal / (1 + (gstRate / 100));
        const taxAmount = lineTotal - taxable;
        return { lineTotal, taxable, taxAmount };
    }

    // Mode-aware line maths.
    //   INCL: normal case — the rate already contains GST at the item's rate,
    //         so tax is backed out of it (CGST+SGST or IGST as chosen).
    //   EXEMPT: no GST is charged at all, regardless of the item's configured
    //           GST rate. The rate entered is simply the price — no tax split.
    function calculateLine(rate, qty, gstRate, mode) {
        if (mode === 'EXEMPT') {
            const lineTotal = rate * qty;
            return { taxable: lineTotal, taxAmount: 0, lineTotal };
        }
        return calculateInclusiveTax(rate, qty, gstRate);
    }

    // The Tax Type dropdown carries three options: INTRA (CGST+SGST), INTER
    // (IGST), and EXEMPT (no GST charged on this voucher at all, overriding
    // the item's normal GST rate).
    function currentRateMode() {
        const el = document.getElementById('vTaxType');
        return (el && el.value === 'EXEMPT') ? 'EXEMPT' : 'INCL';
    }

    // Keep the wording honest about which mode is active.
    function onRateModeChange() {
        const exempt = (currentRateMode() === 'EXEMPT');
        const lbl = document.getElementById('vRateLabel');
        const title = document.getElementById('itemBuilderTitle');
        const head = document.getElementById('tempRateHead');
        if (lbl) lbl.innerHTML = exempt ? 'Rate/Unit (\u20B9, Nil GST)' : 'Rate/Unit (\u20B9 Incl. GST)';
        if (title) title.innerText = exempt ? 'Add Line Item (Nil GST)' : 'Add Line Item (Inclusive Rates)';
        if (head) head.innerText = exempt ? 'Rate (Nil GST)' : 'Incl. Rate';
        renderTempItems();
    }


    function addItemToVoucher() {
        const itemId = document.getElementById('vItem').value;
        const qty = parseFloat(document.getElementById('vQty').value);
        const rate = parseFloat(document.getElementById('vRate').value);

        if (!itemId) return alert("Select an item.");
        if (isNaN(qty) || qty <= 0) return alert("Enter valid quantity.");
        if (isNaN(rate) || rate < 0) return alert("Enter valid rate.");

        const item = stockItems.find(s => s.id == itemId);

        currentVoucherItems.push({
            itemId: item.id,
            name: item.name,
            hsn: item.hsn,
            uom: item.uom,
            qty: qty,
            inclRate: rate,
            gstRate: item.gstRate
        });

        document.getElementById('vItem').value = '';
        document.getElementById('vItemSearch').value = '';
        document.getElementById('vQty').value = '1';
        document.getElementById('vRate').value = '';
        renderTempItems();
    }

    function removeTempItem(index) {
        currentVoucherItems.splice(index, 1);
        renderTempItems();
    }

    function renderTempItems() {
        const tableBody = document.getElementById('vItemsTable');
        const taxType = document.getElementById('vTaxType').value;
        tableBody.innerHTML = '';

        if (currentVoucherItems.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">No items added yet</td></tr>';
            document.getElementById('lblTaxable').innerText = '\u20B90.00';
            document.getElementById('lblTax').innerText = '\u20B90.00';
            document.getElementById('lblTotal').innerText = '\u20B90.00';
            return;
        }

        let totTaxable = 0, totTax = 0, totGrand = 0;

        currentVoucherItems.forEach((it, idx) => {
            const taxDetails = calculateLine(it.inclRate, it.qty, it.gstRate, currentRateMode());
            totTaxable += taxDetails.taxable;
            totTax += taxDetails.taxAmount;
            totGrand += taxDetails.lineTotal;

            tableBody.innerHTML += `
                <tr>
                    <td>${escapeHtml(it.name)}</td>
                    <td>${it.qty} ${escapeHtml(it.uom)}</td>
                    <td>\u20B9${it.inclRate.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    <td>\u20B9${taxDetails.taxable.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    <td>\u20B9${taxDetails.taxAmount.toLocaleString('en-IN', {minimumFractionDigits: 2})} (${it.gstRate}%)</td>
                    <td>\u20B9${taxDetails.lineTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    <td><button onclick="removeTempItem(${idx})" class="btn-danger" style="padding:2px 6px; font-size:0.75rem;">X</button></td>
                </tr>
            `;
        });

        document.getElementById('lblTaxable').innerText = `\u20B9${totTaxable.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
        document.getElementById('lblTax').innerText = `\u20B9${totTax.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
        document.getElementById('lblTotal').innerText = `\u20B9${totGrand.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
    }

    // Shows the settle-on-post block only where paying immediately makes
    // sense — a plain Sales or Purchase invoice. Payment/Receipt vouchers
    // ARE the payment, Journals move money between ledgers, and Delivery
    // Notes / Optional vouchers never carry a real payable balance.
    function refreshSettleBlock() {
        const wrap = document.getElementById('vSettleWrap');
        if (!wrap) return;
        const type = document.getElementById('vType').value;
        const eligible = (type === 'Sales' || type === 'Purchase' || type === 'RawPurchase');
        wrap.style.display = eligible ? '' : 'none';
        if (!eligible) {
            document.getElementById('vSettleMode').value = 'none';
            toggleSettleFields();
            return;
        }
        // Cash/Bank accounts to receive into, defaulting to CASH SALE where
        // it exists since that's the usual counter case.
        const sel = document.getElementById('vSettleAccount');
        const keep = sel.value;
        const opts = accounts.filter(a => a.type === 'Cash' || a.type === 'Bank');
        sel.innerHTML = opts.map(a =>
            `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
        if (keep && opts.some(a => a.id == keep)) {
            sel.value = keep;
        } else {
            const preferred = opts.find(a => (a.name || '').toUpperCase() === 'CASH SALE')
                           || opts.find(a => a.type === 'Cash');
            if (preferred) sel.value = preferred.id;
        }
        toggleSettleFields();
    }

    function toggleSettleFields() {
        const mode = (document.getElementById('vSettleMode') || {}).value || 'none';
        const amt = document.getElementById('vSettleAmount');
        const acc = document.getElementById('vSettleAccount');
        const hint = document.getElementById('vSettleHint');
        if (!amt) return;
        amt.style.display = (mode === 'part') ? '' : 'none';
        acc.style.display = (mode === 'none') ? 'none' : '';
        if (mode === 'none') {
            hint.style.display = 'none';
        } else {
            const type = document.getElementById('vType').value;
            const kind = (type === 'Sales') ? 'Receipt' : 'Payment';
            hint.style.display = 'block';
            hint.innerText = `A ${kind} voucher will be posted automatically and linked against this invoice.`;
        }
    }

    function toggleVoucherMode() {
        const type = document.getElementById('vType').value;
        refreshSettleBlock();
        const customType = customVoucherTypes.find(v => v.id === type);
        const isCash = (type === 'Payment' || type === 'Receipt');
        const isJournal = (type === 'Journal');
        const isOptional = (type === 'OptionalSales' || type === 'OptionalPurchase');
        const isDN = (type === 'DeliveryNote');
        const isRawPurchase = (type === 'RawPurchase');
        const isCustomNoGst = !!(customType && customType.gst === 'no');
        // A custom type marked "No" for Requires a Party behaves like a
        // Payment/Receipt structurally — no items, just an amount and an
        // account — so it can express things like Rent or Transport that
        // have no natural party. requiresParty defaults to true for older
        // custom types created before this option existed.
        const customNoParty = !!(customType && customType.requiresParty === 'no');
        const isCashLike = isCash || customNoParty;
        const customUsesCategory = !!(customType && customType.usesCategory === 'yes');

        // Journal has no party field at all — it picks its own two ledgers
        // directly, one of which may itself be a party or an account.
        document.getElementById('vPartyWrap').style.display = (customNoParty || isJournal) ? 'none' : 'block';
        document.getElementById('journalPanel').style.display = isJournal ? 'block' : 'none';
        if (isJournal) populateJournalLedgerDropdowns();
        document.getElementById('paymentPanel').style.display = isCashLike ? 'block' : 'none';
        // A custom no-party type has no ref-invoice to settle against —
        // hide that field, it only applies to real Payment/Receipt.
        document.getElementById('vRefInvoiceWrap').style.display = isCash ? 'block' : 'none';
        document.getElementById('itemBuilder').style.display = (isCashLike || isJournal) ? 'none' : 'block';
        document.getElementById('tempItemsWrap').style.display = (isCashLike || isJournal) ? 'none' : 'block';
        document.getElementById('totalsBox').style.display = (isCashLike || isJournal) ? 'none' : 'block';
        // Optional vouchers and no-GST custom types carry inventory but no GST split.
        document.getElementById('taxTypeWrap').style.display = (isCashLike || isJournal || isOptional || isDN || isCustomNoGst) ? 'none' : 'block';
        document.getElementById('optionalNoteWrap').style.display = (isOptional || isDN || isRawPurchase || !!customType) ? 'block' : 'none';
        document.getElementById('dnTransportWrap').style.display = isDN ? 'block' : 'none';
        if (isDN) {
            document.getElementById('optionalNoteWrap').innerHTML =
                '<div style="background: rgba(34,211,238,0.12); border:1px solid rgba(34,211,238,0.35); color:var(--cyan); padding:10px 14px; border-radius:12px; font-size:0.8rem;">'
                + '&#9432; A Delivery Note is a <strong>dispatch record only</strong>. It does not change stock, party balances, or GST.</div>';
        } else if (isRawPurchase) {
            document.getElementById('optionalNoteWrap').innerHTML =
                '<div style="background: rgba(52,211,153,0.12); border:1px solid rgba(52,211,153,0.35); color:var(--success); padding:10px 14px; border-radius:12px; font-size:0.8rem;">'
                + '&#9432; Increases the raw seed item\'s stock and updates the vendor\'s ledger, same as a Purchase. Tracked separately in the <strong>Raw Purchase Report</strong> rather than the normal Purchase/GST totals.</div>';
        } else if (isOptional) {
            document.getElementById('optionalNoteWrap').innerHTML =
                '<div style="background: rgba(251,191,36,0.12); border:1px solid rgba(251,191,36,0.35); color:#fbbf24; padding:10px 14px; border-radius:12px; font-size:0.8rem;">'
                + '&#9432; Optional vouchers are recorded separately. They do <strong>not</strong> affect party balances, main stock, sales/purchase totals, or GST.</div>';
        } else if (customType) {
            const stockTxt = customType.stockEffect === 'out' ? 'reduces stock'
                : customType.stockEffect === 'in' ? 'increases stock' : 'has no stock effect';
            const ledgerTxt = customNoParty ? 'has no party'
                : customType.ledgerEffect === 'debit' ? 'debits the party (they owe you)'
                : customType.ledgerEffect === 'credit' ? 'credits the party (you owe them)' : 'does not affect party balance';
            const booksTxt = customType.inMainBooks === 'no' ? 'It is kept off the main books.' : 'It counts in the main books and reports.';
            document.getElementById('optionalNoteWrap').innerHTML =
                '<div style="background: rgba(139,124,255,0.1); border:1px solid rgba(139,124,255,0.3); color:var(--violet); padding:10px 14px; border-radius:12px; font-size:0.8rem;">'
                + `&#9432; <strong>${escapeHtml(customType.name)}</strong>: ${stockTxt}, ${ledgerTxt}. ${booksTxt}</div>`;
        }

        // Sub-Ledger/Category applies to any inventory voucher (sale/purchase,
        // incl. optional) AND to a custom type that explicitly asked for it —
        // including the cash-like no-party ones (e.g. an Expense voucher
        // categorised as Rent / Transport / Labor). Journal has neither.
        document.getElementById('subLedgerWrap').style.display = (isCash || isJournal || (isCashLike && !customUsesCategory)) ? 'none' : 'block';
        // The Payment/Receipt panel already has its own narration field, and
        // Journal has its own too — this universal one only shows for
        // inventory-style vouchers.
        document.getElementById('vNarrationWrap').style.display = (isCash || isCashLike || isJournal) ? 'none' : 'block';
        if (!isCashLike && !isJournal) onRateModeChange();
        if ((!isCashLike && !isJournal) || customUsesCategory) populateSubLedgerDropdown();

        if (isCashLike) {
            populateAccountDropdown();
            if (isCash) populateRefInvoices();
        }
    }

    // Journal's two ledger pickers list every party and every cash/bank
    // account together, prefixed so it's clear which is which — a Journal
    // is the one place a party AND an account are both valid on either
    // side, unlike everywhere else in the app where they're kept separate.
    function populateJournalLedgerDropdowns() {
        const options = ['<option value="">-- Select Ledger --</option>'];
        if (parties.length) {
            options.push('<optgroup label="Parties">');
            parties.forEach(p => options.push(`<option value="party_${p.id}">${escapeHtml(p.name)} (${p.type})</option>`));
            options.push('</optgroup>');
        }
        if (accounts.length) {
            options.push('<optgroup label="Cash / Bank Accounts">');
            accounts.forEach(a => options.push(`<option value="account_${a.id}">${escapeHtml(a.name)} (${a.type})</option>`));
            options.push('</optgroup>');
        }
        const html = options.join('');
        document.getElementById('vJournalDebitLedger').innerHTML = html;
        document.getElementById('vJournalCreditLedger').innerHTML = html;
    }

    function populateAccountDropdown() {
        const sel = document.getElementById('vAccount');
        sel.innerHTML = '<option value="">-- Select Account --</option>';
        accounts.forEach(a => {
            sel.innerHTML += `<option value="${a.id}">${escapeHtml(a.name)} (${a.type})</option>`;
        });
    }

    // List the current party's open invoices matching the voucher type:
    // Receipt settles Sales; Payment settles Purchase.
    function populateRefInvoices() {
        const sel = document.getElementById('vRefInvoice');
        const type = document.getElementById('vType').value;
        const partyId = document.getElementById('vParty').value;
        const wantTypes = (type === 'Receipt') ? ['Sales'] : ['Purchase', 'RawPurchase'];

        sel.innerHTML = '<option value="">-- On Account (no specific invoice) --</option>';
        document.getElementById('refOutstandingWrap').style.display = 'none';

        if (!partyId) return;
        transactions
            .filter(t => t.partyId == partyId && wantTypes.includes(t.type))
            .filter(t => invoiceOutstanding(t) > 0.001)
            .sort((a, b) => a.id - b.id)
            .forEach(t => {
                const due = invoiceOutstanding(t);
                sel.innerHTML += `<option value="${t.id}">${t.invNo} - ${t.date} (Due: \u20B9${due.toLocaleString('en-IN', {minimumFractionDigits: 2})})</option>`;
            });
    }

    function autoFillFromInvoice() {
        const invId = document.getElementById('vRefInvoice').value;
        const wrap = document.getElementById('refOutstandingWrap');
        if (!invId) { wrap.style.display = 'none'; return; }
        const inv = transactions.find(t => t.id == invId);
        if (!inv) return;
        const due = invoiceOutstanding(inv);
        document.getElementById('vAmount').value = due.toLocaleString('en-IN', {minimumFractionDigits: 2});
        wrap.style.display = 'block';
        wrap.innerHTML = `Invoice <strong>${inv.invNo}</strong> total \u20B9${inv.grandTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}, outstanding <strong style="color:var(--accent);">\u20B9${due.toLocaleString('en-IN', {minimumFractionDigits: 2})}</strong>. You may enter a partial amount.`;
    }

    // Called when the party changes on the voucher form
    function onPartyChange() {
        const type = document.getElementById('vType').value;
        if (type === 'Payment' || type === 'Receipt') populateRefInvoices();
    }

    // -------------------------------------------------------------
    // Party search combobox for voucher entry — type to filter instead
    // of scrolling a long dropdown. #vParty (hidden) still holds the
    // selected party id, so every other function reading its value
    // keeps working unchanged.
    // -------------------------------------------------------------
    let vPartyFiltered = [];
    let vPartyActiveIndex = -1;

    function filterPartyDropdown() {
        // Typing invalidates whatever was previously selected until the
        // user picks a match again — prevents silently submitting against
        // a stale party if they start editing the text.
        document.getElementById('vParty').value = '';

        const q = document.getElementById('vPartySearch').value.trim().toLowerCase();
        const listEl = document.getElementById('vPartyList');
        document.getElementById('vPartyClearBtn').style.display = q ? 'block' : 'none';

        vPartyFiltered = parties.filter(p =>
            !q || p.name.toLowerCase().includes(q) || (p.type || '').toLowerCase().includes(q)
        );
        vPartyActiveIndex = -1;

        if (vPartyFiltered.length === 0) {
            listEl.innerHTML = '<div class="party-ac-empty">No matching party</div>';
        } else {
            listEl.innerHTML = vPartyFiltered.map((p, idx) => `
                <div class="party-ac-item" data-idx="${idx}" onclick="selectPartyFromList(${idx})">
                    ${escapeHtml(p.name)} <span style="color:var(--text-muted); font-size:0.8em;">(${escapeHtml(p.type)})</span>
                </div>
            `).join('');
        }
        listEl.style.display = 'block';
    }

    function clearPartySelection() {
        document.getElementById('vParty').value = '';
        document.getElementById('vPartySearch').value = '';
        document.getElementById('vPartyClearBtn').style.display = 'none';
        document.getElementById('vPartyList').style.display = 'none';
        onPartyChange();
        document.getElementById('vPartySearch').focus();
    }

    function selectPartyFromList(idx) {
        const p = vPartyFiltered[idx];
        if (!p) return;
        document.getElementById('vParty').value = p.id;
        document.getElementById('vPartySearch').value = p.name;
        document.getElementById('vPartyClearBtn').style.display = 'block';
        document.getElementById('vPartyList').style.display = 'none';
        onPartyChange();
        // If an item is already picked, refresh its suggested rate now that
        // the party (and therefore any rate history) has changed.
        if (document.getElementById('vItem').value) autoFillItem();
    }

    function handlePartyKeydown(e) {
        const listEl = document.getElementById('vPartyList');
        if (listEl.style.display === 'none') return;
        const items = listEl.querySelectorAll('.party-ac-item');

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            vPartyActiveIndex = Math.min(vPartyActiveIndex + 1, items.length - 1);
            highlightPartyItem(items);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            vPartyActiveIndex = Math.max(vPartyActiveIndex - 1, 0);
            highlightPartyItem(items);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (vPartyActiveIndex >= 0 && vPartyFiltered[vPartyActiveIndex]) {
                selectPartyFromList(vPartyActiveIndex);
            } else if (vPartyFiltered.length === 1) {
                selectPartyFromList(0);
            }
        } else if (e.key === 'Escape') {
            listEl.style.display = 'none';
        }
    }

    function highlightPartyItem(items) {
        items.forEach((el, i) => el.classList.toggle('active', i === vPartyActiveIndex));
        if (items[vPartyActiveIndex]) items[vPartyActiveIndex].scrollIntoView({ block: 'nearest' });
    }

    // Close the party dropdown when tapping/clicking outside it.
    document.addEventListener('click', function(e) {
        const input = document.getElementById('vPartySearch');
        const list = document.getElementById('vPartyList');
        if (!input || !list) return;
        if (list.style.display === 'none') return;
        if (e.target === input || input.contains(e.target) || list.contains(e.target)) return;
        list.style.display = 'none';
    });

    // Guards the Post Voucher button against double-submits — a slow
    // network or an accidental double-tap could otherwise fire
    // submitVoucher() twice before the first call finishes, posting the
    // same sale as two separate vouchers. Disabling the button for the
    // full duration of submitVoucher() (including any stock-shortage
    // confirm dialog inside it) closes that window without needing to
    // touch submitVoucher()'s own internals or its several early-return
    // validation paths — whatever path it takes, this always re-enables
    // the button once it settles.
    let postVoucherInFlight = false;
    async function postVoucherGuarded() {
        if (postVoucherInFlight) return;
        postVoucherInFlight = true;
        const btn = document.getElementById('postVoucherBtn');
        if (btn) btn.disabled = true;
        try {
            await submitVoucher();
        } finally {
            postVoucherInFlight = false;
            if (btn) btn.disabled = false;
        }
    }

    async function submitVoucher() {
        if (!isAdmin() && !hasPermission('postVouchers')) return alert("Only an admin, or a user with 'Post new vouchers' turned on, can post a voucher.");
        const type = document.getElementById('vType').value;
        const customTypeDef = customVoucherTypes.find(v => v.id === type);
        const customNoPartyDef = !!(customTypeDef && customTypeDef.requiresParty === 'no');
        const isJournalType = (type === 'Journal');
        const partyId = document.getElementById('vParty').value;
        if (!customNoPartyDef && !isJournalType && !partyId) return alert("Please select a party.");
        const partyObj = parties.find(p => p.id == partyId);

        // ---- Journal: a manual adjustment directly between two ledgers,
        // each of which can be a party or a cash/bank account. No stock, no
        // GST, no invoice numbering series shared with anything else. ----
        if (isJournalType) {
            const debitVal = document.getElementById('vJournalDebitLedger').value;
            const creditVal = document.getElementById('vJournalCreditLedger').value;
            if (!debitVal) return alert("Please select the Debit ledger.");
            if (!creditVal) return alert("Please select the Credit ledger.");
            if (debitVal === creditVal) return alert("Debit and Credit ledgers must be different.");

            const amount = parseFloat(document.getElementById('vJournalAmount').value);
            if (isNaN(amount) || amount <= 0) return alert("Please enter a valid amount.");

            const parseLedgerRef = (val) => {
                const isParty = val.startsWith('party_');
                const rawId = val.replace(/^(party|account)_/, '');
                if (isParty) {
                    const p = parties.find(x => x.id == rawId);
                    return { kind: 'party', id: p ? p.id : null, name: p ? p.name : 'Unknown' };
                }
                const a = accounts.find(x => x.id == rawId);
                return { kind: 'account', id: a ? a.id : null, name: a ? a.name : 'Unknown' };
            };
            const debitRef = parseLedgerRef(debitVal);
            const creditRef = parseLedgerRef(creditVal);

            const journalTxn = {
                id: newId(transactions),
                invNo: nextVoucherNo('Journal', 'JRNL', null, document.getElementById('vDate').value),
                date: document.getElementById('vDate').value,
                type: 'Journal',
                journalDebit: debitRef,
                journalCredit: creditRef,
                narration: document.getElementById('vJournalNarration').value.trim(),
                items: [],
                taxable: 0,
                totalTax: 0,
                grandTotal: amount
            };

            transactions.push(journalTxn);
            localStorage.setItem('tally_mob_db', JSON.stringify(transactions));
            syncCloud();

            document.getElementById('vJournalDebitLedger').value = '';
            document.getElementById('vJournalCreditLedger').value = '';
            document.getElementById('vJournalAmount').value = '';
            document.getElementById('vJournalNarration').value = '';
            document.getElementById('vDate').valueAsDate = new Date();
            render();
            logAudit('Created', journalTxn);
            showSyncToast('ok', `Journal posted \u2022 ${journalTxn.invNo}`);
            return;
        }

        // ---- Payment / Receipt, and any custom voucher type marked "No"
        // for Requires a Party (e.g. Rent, Transport, Bank Charges) — all
        // share the same cash-in/cash-out shape: an amount against an
        // account, no stock, no GST. ----
        if (type === 'Payment' || type === 'Receipt' || customNoPartyDef) {
            const amount = parseFloat(document.getElementById('vAmount').value);
            if (isNaN(amount) || amount <= 0) return alert("Please enter a valid amount.");

            const accountId = document.getElementById('vAccount').value;
            if (!accountId) return alert("Please select the cash/bank account.");

            const category = (customNoPartyDef && customTypeDef.usesCategory === 'yes')
                ? document.getElementById('vSubLedger').value : '';
            if (customNoPartyDef && customTypeDef.usesCategory === 'yes' && !category) {
                return alert("Please select a category.");
            }

            const refInvId = customNoPartyDef ? '' : document.getElementById('vRefInvoice').value;
            let refInvNo = '';
            if (refInvId) {
                const inv = transactions.find(t => t.id == refInvId);
                const due = invoiceOutstanding(inv);
                if (amount > due + 0.001) {
                    return alert(`Amount exceeds outstanding of \u20B9${due.toLocaleString('en-IN', {minimumFractionDigits: 2})} on ${inv.invNo}.`);
                }
                refInvNo = inv.invNo;
            }

            const accObj = accounts.find(a => a.id == accountId);

            const cashTxn = {
                id: newId(transactions),
                invNo: customNoPartyDef
                    ? nextVoucherNo('custom_' + type, customTypeDef.prefix || 'CV', null, document.getElementById('vDate').value)
                    : nextRefNo(type, document.getElementById('vDate').value),
                date: document.getElementById('vDate').value,
                type: type,
                accountId: accountId,
                accountName: accObj ? accObj.name : '',
                refInvoiceId: refInvId || null,
                refInvoiceNo: refInvNo,
                narration: document.getElementById('vNarration').value.trim(),
                partyId: partyObj ? partyObj.id : null,
                partyName: partyObj ? partyObj.name : (customNoPartyDef ? (customTypeDef.name || 'Expense') : 'Cash Party'),
                items: [],
                taxable: 0,
                totalTax: 0,
                grandTotal: amount
            };
            if (customNoPartyDef) {
                cashTxn.customVoucherTypeId = type;
                cashTxn.customVoucherTypeName = customTypeDef.name;
                cashTxn.inMainBooks = (customTypeDef.inMainBooks !== 'no');
                cashTxn.subLedger = category || '';
            }

            transactions.push(cashTxn);
            localStorage.setItem('tally_mob_db', JSON.stringify(transactions));
            syncCloud();

            document.getElementById('vAmount').value = '';
            document.getElementById('vNarration').value = '';
            document.getElementById('vRefInvoice').value = '';
            document.getElementById('refOutstandingWrap').style.display = 'none';
            document.getElementById('vDate').valueAsDate = new Date();
            render();
            if (!customNoPartyDef) populateRefInvoices();
            logAudit('Created', cashTxn);
            showSyncToast('ok', `${customNoPartyDef ? (customTypeDef.name || 'Expense') : type} posted \u2022 ${cashTxn.invNo}`);

            if (lastLedger && lastLedger.kind === 'party' && lastLedger.id == partyId
                && document.getElementById('ledgerPrintArea').style.display === 'block') {
                openLedgerStatement('party', partyId);
            }
            return;
        }

        // ---- Delivery Note (dispatch record only; no stock/ledger/GST effect) ----
        if (type === 'DeliveryNote') {
            if (currentVoucherItems.length === 0) return alert("Please add at least one item.");

            const dnMode = currentRateMode();
            let dnTotal = 0;
            const dnItems = currentVoucherItems.map(it => {
                const lineTotal = calculateLine(it.inclRate, it.qty, it.gstRate, dnMode).lineTotal;
                dnTotal += lineTotal;
                return { ...it, lineTotal: lineTotal };
            });

            const dnTxn = {
                id: newId(transactions),
                invNo: nextVoucherNo('DeliveryNote', 'DN', null, document.getElementById('vDate').value),
                date: document.getElementById('vDate').value,
                type: 'DeliveryNote',
                deliveryNote: true,
                rateMode: dnMode,
                subLedger: document.getElementById('vSubLedger').value || '',
                narration: document.getElementById('vNarrationMain').value.trim(),
                partyId: partyObj ? partyObj.id : null,
                partyName: partyObj ? partyObj.name : 'Cash Party',
                items: dnItems,
                taxable: 0,
                totalTax: 0,
                grandTotal: dnTotal,
                driverName: document.getElementById('dnDriverName').value.trim(),
                driverPhone: document.getElementById('dnDriverPhone').value.trim(),
                vehicleNo: document.getElementById('dnVehicleNo').value.trim(),
                vehicleType: document.getElementById('dnVehicleType').value.trim()
            };

            transactions.push(dnTxn);
            localStorage.setItem('tally_mob_db', JSON.stringify(transactions));
            syncCloud();

            currentVoucherItems = [];
            renderTempItems();
            document.getElementById('vSubLedger').value = '';
            document.getElementById('vNarrationMain').value = '';
            document.getElementById('dnDriverName').value = '';
            document.getElementById('dnDriverPhone').value = '';
            document.getElementById('dnVehicleNo').value = '';
            document.getElementById('dnVehicleType').value = '';
            document.getElementById('vDate').valueAsDate = new Date();
            render();
            logAudit('Created', dnTxn);
            showSyncToast('ok', `Delivery Note created (dispatch record only) \u2022 ${dnTxn.invNo}`);
            return;
        }

        // ---- Custom Voucher Type (user-defined behavior) ----
        const customType = customVoucherTypes.find(v => v.id === type);
        if (customType) {
            if (currentVoucherItems.length === 0) return alert("Please add at least one item.");

            // Stock validation for "reduces stock" custom types
            if (customType.stockEffect === 'out') {
                for (const line of currentVoucherItems) {
                    const stItem = stockItems.find(s => s.id == line.itemId);
                    if (!stItem || stItem.qty < line.qty) {
                        alert(`Insufficient stock for ${line.name}! Available: ${stItem ? stItem.qty : 0}`);
                        return;
                    }
                }
            }

            const ctMode = (customType.gst === 'no') ? 'EXEMPT' : currentRateMode();
            const ctTaxType = (customType.gst === 'no') ? 'EXEMPT' : document.getElementById('vTaxType').value;

            let totalTaxable = 0, totalTax = 0, grandTotal = 0;
            const ctItems = currentVoucherItems.map(it => {
                const res = calculateLine(it.inclRate, it.qty, it.gstRate, ctMode);
                totalTaxable += res.taxable;
                totalTax += res.taxAmount;
                grandTotal += res.lineTotal;
                return { ...it, taxable: res.taxable, taxAmount: res.taxAmount, lineTotal: res.lineTotal };
            });

            // Apply stock effect
            if (customType.stockEffect === 'out' || customType.stockEffect === 'in') {
                currentVoucherItems.forEach(line => {
                    const stItem = stockItems.find(s => s.id == line.itemId);
                    if (stItem) {
                        if (customType.stockEffect === 'out') stItem.qty -= line.qty;
                        else stItem.qty += line.qty;
                    }
                });
                localStorage.setItem('tally_mob_stock', JSON.stringify(stockItems));
                syncCloud();
            }

            const ctTxn = {
                id: newId(transactions),
                invNo: nextVoucherNo('custom_' + type, customType.prefix || 'CV', null, document.getElementById('vDate').value),
                date: document.getElementById('vDate').value,
                type: type,
                customVoucherTypeId: type,
                customVoucherTypeName: customType.name,
                ledgerEffect: customType.ledgerEffect,
                inMainBooks: customType.inMainBooks !== 'no',
                taxType: ctTaxType,
                rateMode: ctMode,
                subLedger: document.getElementById('vSubLedger').value || '',
                narration: document.getElementById('vNarrationMain').value.trim(),
                partyId: partyObj ? partyObj.id : null,
                partyName: partyObj ? partyObj.name : 'Cash Party',
                items: ctItems,
                taxable: totalTaxable,
                totalTax: totalTax,
                grandTotal: grandTotal
            };

            transactions.push(ctTxn);
            localStorage.setItem('tally_mob_db', JSON.stringify(transactions));
            syncCloud();

            currentVoucherItems = [];
            renderTempItems();
            document.getElementById('vSubLedger').value = '';
            document.getElementById('vNarrationMain').value = '';
            document.getElementById('vDate').valueAsDate = new Date();
            render();
            logAudit('Created', ctTxn);
            showSyncToast('ok', `${customType.name} created \u2022 ${ctTxn.invNo}`);
            return;
        }

        // ---- Optional Sale / Optional Purchase (off the main books) ----
        if (type === 'OptionalSales' || type === 'OptionalPurchase') {
            if (currentVoucherItems.length === 0) return alert("Please add at least one item.");

            const isSale = (type === 'OptionalSales');
            const optMode = currentRateMode();
            let grandTotal = 0;
            const optItems = currentVoucherItems.map(it => {
                const lineTotal = calculateLine(it.inclRate, it.qty, it.gstRate, optMode).lineTotal;
                grandTotal += lineTotal;
                return { ...it, lineTotal: lineTotal };
            });

            const optTxn = {
                id: newId(transactions),
                invNo: isSale ? nextVoucherNo('OptionalSales', 'OPT-S', null, document.getElementById('vDate').value) : nextVoucherNo('OptionalPurchase', 'OPT-P', null, document.getElementById('vDate').value),
                date: document.getElementById('vDate').value,
                type: type,
                optional: true,
                rateMode: optMode,
                subLedger: document.getElementById('vSubLedger').value || '',
                narration: document.getElementById('vNarrationMain').value.trim(),
                partyId: partyObj ? partyObj.id : null,
                partyName: partyObj ? partyObj.name : 'Cash Party',
                items: optItems,
                taxable: 0,
                totalTax: 0,
                grandTotal: grandTotal
            };

            transactions.push(optTxn);
            localStorage.setItem('tally_mob_db', JSON.stringify(transactions));
            syncCloud();

            currentVoucherItems = [];
            renderTempItems();
            document.getElementById('vSubLedger').value = '';
            document.getElementById('vNarrationMain').value = '';
            document.getElementById('vDate').valueAsDate = new Date();
            render();
            alert(`Optional voucher ${optTxn.invNo} saved (kept off the main books).`);
            return;
        }

        // ---- Sales / Purchase / Raw Purchase ----
        if (currentVoucherItems.length === 0) return alert("Please add at least one item.");

        const taxType = document.getElementById('vTaxType').value;
        const rateMode = currentRateMode();
        const isRawPurchase = (type === 'RawPurchase');

        // Stock check — Sales no longer blocks an oversell outright. If any
        // line would take an item's stock below zero, warn with exactly how
        // short it is and let the person decide: Cancel keeps the voucher
        // unposted (same as before), OK posts it anyway and the item's
        // quantity goes negative, showing clearly in Stock Summary until a
        // later Purchase brings it back up.
        if (type === 'Sales') {
            const shortages = [];
            for (let line of currentVoucherItems) {
                const stItem = stockItems.find(s => s.id == line.itemId);
                const available = stItem ? stItem.qty : 0;
                if (available < line.qty) shortages.push(`${line.name}: only ${available} in stock, selling ${line.qty}`);
            }
            if (shortages.length > 0) {
                const proceed = await confirmAsync(
                    `This sale goes below available stock:\n\n${shortages.join('\n')}\n\nPost it anyway? Stock will show negative until you purchase more.`
                );
                if (!proceed) return;
            }
        }

        // Adjust Stock — Raw Purchase behaves exactly like a Purchase (stock
        // goes up), it just lands specifically on the raw seed item selected
        // and is tagged separately so it can be tracked on its own.
        currentVoucherItems.forEach(line => {
            const stItem = stockItems.find(s => s.id == line.itemId);
            if (stItem) {
                if (type === 'Sales') stItem.qty -= line.qty;
                else stItem.qty += line.qty; // Purchase or RawPurchase: stock in
                // First time a variety is bought as a Raw Purchase, tag the
                // item itself as raw material so the Conversion screen and
                // Raw Purchase Report can find it.
                if (isRawPurchase) stItem.rawMaterial = true;
            }
        });
        localStorage.setItem('tally_mob_stock', JSON.stringify(stockItems));
        syncCloud();

        // Process Totals
        let totalTaxable = 0, totalTax = 0, grandTotal = 0;
        const processedItems = currentVoucherItems.map(it => {
            const taxRes = calculateLine(it.inclRate, it.qty, it.gstRate, rateMode);
            totalTaxable += taxRes.taxable;
            totalTax += taxRes.taxAmount;
            grandTotal += taxRes.lineTotal;

            return {
                ...it,
                taxable: taxRes.taxable,
                taxAmount: taxRes.taxAmount,
                lineTotal: taxRes.lineTotal
            };
        });

        const invPrefix = type === 'Sales' ? 'INV' : isRawPurchase ? 'RPUR' : 'PUR';
        const counterKey = type === 'Sales' ? 'Sales' : isRawPurchase ? 'RawPurchase' : 'Purchase';
        const txn = {
            id: newId(transactions),
            invNo: nextVoucherNo(counterKey, invPrefix, null, document.getElementById('vDate').value),
            date: document.getElementById('vDate').value,
            type: type,
            rawPurchase: isRawPurchase,
            taxType: taxType,
            rateMode: rateMode,
            subLedger: document.getElementById('vSubLedger').value || '',
            narration: document.getElementById('vNarrationMain').value.trim(),
            partyId: partyObj ? partyObj.id : null,
            partyName: partyObj ? partyObj.name : 'Cash Party',
            items: processedItems,
            taxable: totalTaxable,
            totalTax: totalTax,
            grandTotal: grandTotal
        };

        transactions.push(txn);
        localStorage.setItem('tally_mob_db', JSON.stringify(transactions));
        syncCloud();

        currentVoucherItems = [];
        renderTempItems();
        document.getElementById('vSubLedger').value = '';
        document.getElementById('vNarrationMain').value = '';
        document.getElementById('vDate').valueAsDate = new Date();
        render();
        logAudit('Created', txn);

        // Settle-on-post: if the person marked this invoice paid, create the
        // matching Receipt/Payment now and link it via refInvoiceId — the
        // exact same shape a manually posted, manually linked voucher has,
        // so ledgers, Pending to Receive/Pay and reports all treat it
        // identically. Done after the invoice is saved so a failure here
        // can never lose the invoice itself.
        try {
            const settleMode = (document.getElementById('vSettleMode') || {}).value || 'none';
            if (settleMode !== 'none' && (type === 'Sales' || type === 'Purchase' || isRawPurchase)) {
                const settleAccId = document.getElementById('vSettleAccount').value;
                const settleAcc = accounts.find(a => a.id == settleAccId);
                let payAmt = (settleMode === 'full')
                    ? grandTotal
                    : parseFloat(document.getElementById('vSettleAmount').value);

                if (!settleAcc) {
                    alert('Voucher posted, but no Cash/Bank account was selected, so no payment entry was made. Post it separately.');
                } else if (isNaN(payAmt) || payAmt <= 0) {
                    alert('Voucher posted, but the payment amount was not valid, so no payment entry was made. Post it separately.');
                } else {
                    // Never record more money than the invoice is worth.
                    if (payAmt > grandTotal) payAmt = grandTotal;
                    const settleType = (type === 'Sales') ? 'Receipt' : 'Payment';
                    const settleTxn = {
                        id: newId(transactions),
                        invNo: nextRefNo(settleType, txn.date),
                        date: txn.date,
                        type: settleType,
                        accountId: settleAcc.id,
                        accountName: settleAcc.name,
                        refInvoiceId: txn.id,
                        refInvoiceNo: txn.invNo,
                        narration: 'Auto-posted with ' + txn.invNo,
                        partyId: txn.partyId,
                        partyName: txn.partyName,
                        items: [],
                        taxable: 0,
                        totalTax: 0,
                        grandTotal: payAmt
                    };
                    transactions.push(settleTxn);
                    localStorage.setItem('tally_mob_db', JSON.stringify(transactions));
                    syncCloud();
                    logAudit('Created', settleTxn, 'Auto-posted against ' + txn.invNo);
                    render();
                }
            }
            // Reset for the next voucher so a paid sale doesn't silently
            // mark the following one as paid too.
            const modeSel = document.getElementById('vSettleMode');
            if (modeSel) { modeSel.value = 'none'; toggleSettleFields(); }
            const amtEl = document.getElementById('vSettleAmount');
            if (amtEl) amtEl.value = '';
        } catch (e) {
            console.error('Settle-on-post failed:', e);
            alert('The voucher was posted, but the linked payment entry could not be created. Please post it separately.');
        }
        showSyncToast('ok', `${type === 'Sales' ? 'Sale' : isRawPurchase ? 'Raw purchase' : 'Purchase'} posted \u2022 ${txn.invNo}`);
        
        // Refresh Ledger if open
        if (lastLedger && lastLedger.kind === 'party' && lastLedger.id == partyId
            && document.getElementById('ledgerPrintArea').style.display === 'block') {
            openLedgerStatement('party', partyId);
        }
    }

    // ============ EDIT VOUCHER ============
    // A single popup that adapts to the voucher type. Editing safely reverses
    // the old voucher's stock/settlement effect and applies the new values.

    function isInventoryType(type) {
        if (type === 'Sales' || type === 'Purchase' || type === 'RawPurchase' || type === 'OptionalSales'
            || type === 'OptionalPurchase' || type === 'DeliveryNote') return true;
        if (isCustomNoPartyType(type)) return false; // cash-out custom types (e.g. Expense) are not inventory vouchers
        return customVoucherTypes.some(v => v.id === type);
    }
    function affectsMainStock(type) {
        if (type === 'Sales' || type === 'Purchase' || type === 'RawPurchase') return true; // optional/DN never touch main stock
        const vt = customVoucherTypes.find(v => v.id === type);
        return !!(vt && (vt.stockEffect === 'out' || vt.stockEffect === 'in'));
    }
    // Direction: +1 means "reduces stock on post" (like Sales), -1 means
    // "increases stock on post" (like Purchase). Used so the edit modal can
    // reverse/reapply a custom voucher's stock effect symmetrically.
    function stockDirection(type) {
        if (type === 'Sales') return 1;
        if (type === 'Purchase' || type === 'RawPurchase') return -1;
        const vt = customVoucherTypes.find(v => v.id === type);
        if (vt && vt.stockEffect === 'out') return 1;
        if (vt && vt.stockEffect === 'in') return -1;
        return 0;
    }

    // Self-healing stock recalculation. item.qty is normally nudged up or
    // down incrementally on every post/edit/delete — convenient, but it
    // means any single missed reversal (a bad edit, a half-applied cloud
    // sync between devices, anything) leaves it permanently out of step
    // with what "Total Purchased" / "Total Sold" actually add up to, with
    // nothing to ever bring it back in line on its own.
    //
    // This instead throws away the stored running balance and rebuilds
    // every item's qty from zero by replaying the full transaction ledger
    // — the exact same source of truth the item summary screen already
    // sums Purchased/Sold from. Called on every render(), so stock can
    // never silently drift again: whatever the ledger says is correct,
    // the displayed "In Stock" figure is forced to match it immediately.
    // Pure transaction-driven net change for every stock item in one pass —
    // purchases and "in" custom types add, sales and "out" custom types
    // subtract, conversions move raw material into processed goods. This
    // deliberately knows nothing about openingQty itself; callers combine
    // the two. Shared by recalcStockFromLedger() (every render) and the
    // item-save handler above (once per save, to back-solve openingQty from
    // whatever current stock figure was typed in).
    //
    // Each item only counts transactions from its OWN openingAsOf date
    // onward — same "opening + everything since openingAsOf" pattern as
    // accountBalanceAsOf/partyBalanceAsOf above. This is what makes Start
    // New Financial Year safe for stock: rolling an item's closing qty
    // into its new Opening Qty, and moving openingAsOf forward to match,
    // means transactions before that date stop being counted a second
    // time — they're already folded into the new opening figure.
    function netLedgerQtyByItem() {
        const net = {};
        const cutoff = {};
        stockItems.forEach(s => { net[s.id] = 0; cutoff[s.id] = s.openingAsOf || '2000-01-01'; });
        transactions.forEach(t => {
            if (t.conversion) {
                if (t.rawItemId != null && net[t.rawItemId] !== undefined && !(t.date < cutoff[t.rawItemId])) net[t.rawItemId] -= (t.rawQty || 0);
                if (t.processedItemId != null && net[t.processedItemId] !== undefined && !(t.date < cutoff[t.processedItemId])) net[t.processedItemId] += (t.outQty || 0);
                return;
            }
            if (!t.items || !affectsMainStock(t.type)) return;
            const dir = stockDirection(t.type);
            t.items.forEach(line => {
                if (line.itemId == null || net[line.itemId] === undefined) return;
                if (t.date < cutoff[line.itemId]) return; // predates this item's own opening-balance cutoff — already folded into openingQty
                net[line.itemId] -= dir * line.qty;
            });
        });
        return net;
    }

    function recalcStockFromLedger() {
        const net = netLedgerQtyByItem();
        let changed = false;
        stockItems.forEach(s => {
            // One-time migration for an item that predates openingQty.
            // This USED to back-calculate an opening balance from whatever
            // qty happened to be cached on this device at the moment the
            // migration first ran — but that figure isn't trustworthy: if
            // this device hadn't yet re-rendered since the ledger-only fix
            // that came before openingQty, or pulled back a stale value via
            // sync, the OLD bug's wrong number got permanently canonised as
            // real opening stock instead of healing to 0 (exactly what
            // happened here — Purchased 50, Sold 50, but a leftover "1"
            // got locked in as Opening Qty instead of clearing to 0).
            // Defaulting to 0 is deterministic and correct for a shop
            // whose stock has always come through tracked Purchase entries;
            // any item with genuine un-invoiced opening stock can still
            // have that entered via Edit Stock Item, which now holds it
            // correctly (see the item-form submit handler above).
            if (s.openingQty === undefined) {
                s.openingQty = 0;
                changed = true;
            }
            const correct = s.openingQty + (net[s.id] || 0);
            if (s.qty !== correct) { s.qty = correct; changed = true; }
        });
        if (changed) localStorage.setItem('tally_mob_stock', JSON.stringify(stockItems));
    }

    // Clears one item's Opening Qty back to 0 — the quick per-item fix for
    // the migration mistake described above: a stale pre-fix number that
    // got locked in as if it were real opening stock. In Stock immediately
    // becomes whatever this item's own transactions add up to.
    //
    // openingAsOf is what tells the two cases apart. A leftover migration
    // artifact never has it set — the old migration only ever touched
    // openingQty. A REAL opening balance, from Start New Financial Year,
    // always sets both together. So an item with openingAsOf present isn't
    // a bug to clean up — it's this item's actual carried-forward stock
    // from closing the books, and clearing it to 0 would erase real
    // trading history, not fix anything. Still allowed if an admin
    // deliberately wants that, but the warning has to say so honestly
    // instead of describing it as a fix.
    async function resetItemOpeningQty(itemId) {
        if (!isAdmin() && !hasPermission('editItem')) return alert("Only an admin, or a user with 'Edit a stock item' turned on, can reset an item's opening quantity.");
        const item = stockItems.find(s => s.id == itemId);
        if (!item) return;
        if ((item.openingQty || 0) === 0) return alert("Opening Qty is already 0 for this item.");

        if (item.openingAsOf) {
            const ok = await confirmAsync(
                `"${item.name}"'s Opening Qty of ${item.openingQty} ${item.uom} isn't a leftover bug — it's this item's real carried-forward stock as of ${item.openingAsOf}, set when a financial year was closed.\n\n`
                + `Clearing it to 0 will erase that opening balance, not fix anything. Only proceed if you're deliberately correcting it (in which case Edit Stock Item, entering the right count directly, is usually what you want instead).\n\n`
                + `Clear it to 0 anyway?`
            );
            if (!ok) return;
        } else {
            if (!(await confirmAsync(`Reset "${item.name}"'s Opening Qty from ${item.openingQty} to 0? In Stock will then be purely what its Purchase/Sale entries add up to.`))) return;
        }

        item.openingQty = 0;
        recalcStockFromLedger();
        syncCloud();
        render();
        if (typeof viewStockItem === 'function') viewStockItem(itemId);
    }

    // Bulk version of the fix above, for a device where several items
    // picked up a bogus Opening Qty the same way — shows exactly what will
    // change before touching anything, since this alters stock data across
    // the whole item list at once.
    //
    // Deliberately excludes any item with openingAsOf set (see
    // resetItemOpeningQty above): this bulk tool exists to sweep up
    // migration artifacts, not to mass-clear real financial-year opening
    // balances. Those stay untouched here even if nonzero — fixing one of
    // those, if it's ever genuinely wrong, is a deliberate one-item
    // decision via resetItemOpeningQty or Edit Stock Item, never a bulk
    // sweep.
    async function resetAllOpeningQuantities() {
        if (!isAdmin()) return alert("Only an admin can reset opening quantities for every item at once.");
        const affected = stockItems.filter(s => (s.openingQty || 0) !== 0 && !s.openingAsOf);
        const protectedCount = stockItems.filter(s => (s.openingQty || 0) !== 0 && s.openingAsOf).length;

        if (affected.length === 0) {
            return alert(protectedCount > 0
                ? `Nothing to fix. ${protectedCount} item(s) have a nonzero Opening Qty, but each is a real financial-year opening balance (not a bug) — use Reset to 0 on an individual item if one genuinely needs correcting.`
                : "Every item's Opening Qty is already 0 — nothing to fix.");
        }

        const preview = affected.slice(0, 15)
            .map(s => `\u2022 ${s.name}: ${s.openingQty} ${s.uom} \u2192 0`)
            .join('\n') + (affected.length > 15 ? `\n\u2026 and ${affected.length - 15} more` : '');

        const ok = await confirmAsync(
            `Reset Opening Qty to 0 for ${affected.length} item(s), so In Stock becomes purely what Purchase/Sale/etc. entries add up to:\n\n${preview}\n\n`
            + `If any of these genuinely has real stock that was never entered as a Purchase in this app, re-enter that amount afterward via Edit Stock Item.`
            + (protectedCount > 0 ? `\n\n(${protectedCount} other item(s) with a real financial-year opening balance are left untouched.)` : '')
            + `\n\nProceed?`
        );
        if (!ok) return;

        affected.forEach(s => { s.openingQty = 0; });
        localStorage.setItem('tally_mob_stock', JSON.stringify(stockItems));
        recalcStockFromLedger();
        syncCloud();
        render();
        alert(`Done — ${affected.length} item(s) now show stock purely from transactions.`);
    }

    // ---- Alter Voucher (search any voucher, then reuse the Edit popup) ----
    function renderAlterVoucherSearch() {
        const q = (document.getElementById('avSearch').value || '').trim().toLowerCase();
        const body = document.getElementById('alterVoucherBody');
        body.innerHTML = '';

        let rows = transactions.slice().sort((a, b) => b.id - a.id);
        if (q) {
            rows = rows.filter(t =>
                (t.invNo || '').toLowerCase().includes(q) ||
                (t.partyName || '').toLowerCase().includes(q) ||
                (t.type || '').toLowerCase().includes(q) ||
                (t.customVoucherTypeName || '').toLowerCase().includes(q)
            );
        }
        // Without a search term, keep the list to a sane size (most recent
        // first) rather than dumping the entire history at once.
        if (!q) rows = rows.slice(0, 50);

        if (rows.length === 0) {
            body.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">No matching vouchers.</td></tr>';
            return;
        }
        rows.forEach(t => {
            const typeLabel = t.customVoucherTypeName || t.type;
            body.innerHTML += `
                <tr>
                    <td>${t.date}</td>
                    <td>${escapeHtml(typeLabel)}</td>
                    <td>${escapeHtml(t.invNo)}</td>
                    <td>${escapeHtml(t.partyName || '-')}</td>
                    <td>\u20B9${t.grandTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    <td><button onclick="openEditModal(${t.id})" style="padding:4px 10px; font-size:0.75rem; width:auto;">Edit</button></td>
                </tr>
            `;
        });
        if (!q && transactions.length > 50) {
            body.innerHTML += `<tr><td colspan="6" style="text-align:center; color:var(--text-muted); font-size:0.75rem;">Showing the 50 most recent. Type above to search the full history.</td></tr>`;
        }
    }

    // Working copy of an edited voucher's line items — lets the Edit modal
    // add/remove items freely without being tied to fixed array indices.
    let editWorkingItems = [];
    let editRowIdSeq = 0;
    let editWorkingItemsOriginal = []; // snapshot of rates as the voucher was BEFORE this edit session, for "Reset to item rates"

    function renderEditItemsList() {
        const list = document.getElementById('editItemsList');
        if (editWorkingItems.length === 0) {
            list.innerHTML = '<div style="padding:10px 0; color:var(--text-muted); font-size:0.85rem;">No items \u2014 add at least one below before saving.</div>';
            return;
        }
        list.innerHTML = editWorkingItems.map(it => `
            <div class="edit-line-row">
                <div class="ln-name">${escapeHtml(it.name)} <span style="color:var(--text-muted);">(${escapeHtml(it.uom)})</span></div>
                <div>
                    <label style="font-size:0.7rem;">Qty</label>
                    <input type="number" min="0" step="any" value="${it.qty}" oninput="updateEditRow(${it.rowId}, 'qty', this.value)">
                </div>
                <div>
                    <label style="font-size:0.7rem;">Rate (Incl)</label>
                    <input type="number" min="0" step="any" value="${it.inclRate}" oninput="updateEditRow(${it.rowId}, 'inclRate', this.value)">
                </div>
                <button type="button" class="btn-danger" style="width:auto; padding:8px 10px; font-size:0.75rem;" onclick="removeEditRow(${it.rowId})">Remove</button>
            </div>
        `).join('');
    }

    // Base (undiscounted) total from the line items as currently entered —
    // used as the reference point for both the Discount field and the
    // direct Total-override field, so switching between them is consistent.
    function editBaseTotal() {
        let total = 0;
        editWorkingItems.forEach(it => { total += (it.qty || 0) * (it.inclRate || 0); });
        return total;
    }

    // Scales every line's inclRate by the same factor so the invoice adds
    // up to the target total. Rates stay GST-inclusive, so tax recalculates
    // correctly from the scaled rate — this is why a discount or a typed
    // total isn't just subtracted at the end, it has to flow back into the
    // rates themselves.
    function scaleEditRatesToTotal(targetTotal) {
        const base = editBaseTotal();
        if (base <= 0) return; // nothing to scale from
        const factor = targetTotal / base;
        editWorkingItems.forEach(it => { it.inclRate = it.inclRate * factor; });
        renderEditItemsList();
    }

    function onEditDiscountInput() {
        const discount = parseFloat(document.getElementById('editDiscount').value) || 0;
        document.getElementById('editTotalOverride').value = '';
        if (discount <= 0) {
            document.getElementById('editDiscountNote').innerText = '';
            recomputeEditTotal();
            return;
        }
        const base = editOriginalBaseTotal();
        const target = Math.max(0, base - discount);
        document.getElementById('editDiscountNote').innerText =
            `Rates scaled down so the invoice totals \u20B9${target.toLocaleString('en-IN', {minimumFractionDigits: 2})} (was \u20B9${base.toLocaleString('en-IN', {minimumFractionDigits: 2})}).`;
        scaleEditRatesToTotal(target);
        recomputeEditTotal();
    }

    function onEditTotalOverrideInput() {
        const target = parseFloat(document.getElementById('editTotalOverride').value);
        document.getElementById('editDiscount').value = '';
        if (isNaN(target) || target < 0) {
            document.getElementById('editDiscountNote').innerText = '';
            recomputeEditTotal();
            return;
        }
        const base = editOriginalBaseTotal();
        document.getElementById('editDiscountNote').innerText =
            `Rates scaled so the invoice totals \u20B9${target.toLocaleString('en-IN', {minimumFractionDigits: 2})} (was \u20B9${base.toLocaleString('en-IN', {minimumFractionDigits: 2})}).`;
        scaleEditRatesToTotal(target);
        recomputeEditTotal();
    }

    // The total BEFORE any discount/override this editing session has
    // applied — captured once when the edit modal opens, so repeatedly
    // adjusting the discount field scales from the same starting point
    // instead of compounding on top of the last scale.
    let editOriginalTotalSnapshot = 0;
    function editOriginalBaseTotal() { return editOriginalTotalSnapshot; }

    async function clearEditTotalAdjust() {
        if (!(await confirmAsync('Reset every line back to its original rate, undoing any discount or total override made this session?'))) return;
        editWorkingItems.forEach(it => {
            const orig = editWorkingItemsOriginal.find(o => o.rowId === it.rowId);
            if (orig) it.inclRate = orig.inclRate;
        });
        document.getElementById('editDiscount').value = '';
        document.getElementById('editTotalOverride').value = '';
        document.getElementById('editDiscountNote').innerText = '';
        renderEditItemsList();
        recomputeEditTotal();
    }

    function updateEditRow(rowId, field, value) {
        const row = editWorkingItems.find(r => r.rowId === rowId);
        if (!row) return;
        row[field] = parseFloat(value) || 0;
        // A manual line edit supersedes any discount/total-override figure
        // shown — clear those inputs so they don't display a stale number
        // that no longer matches what's actually on screen.
        document.getElementById('editDiscount').value = '';
        document.getElementById('editTotalOverride').value = '';
        document.getElementById('editDiscountNote').innerText = '';
        recomputeEditTotal();
    }

    async function removeEditRow(rowId) {
        if (editWorkingItems.length <= 1) return alert("A voucher needs at least one item \u2014 add a replacement first, or delete the whole voucher instead of emptying it.");
        if (!(await confirmAsync("Remove this item from the voucher?"))) return;
        editWorkingItems = editWorkingItems.filter(r => r.rowId !== rowId);
        renderEditItemsList();
        recomputeEditTotal();
    }

    function onEditAddItemChange() {
        const id = document.getElementById('editAddItemSelect').value;
        const item = stockItems.find(s => s.id == id);
        document.getElementById('editAddItemRate').value = item ? item.rate : '';
    }

    function addEditItemRow() {
        const itemId = document.getElementById('editAddItemSelect').value;
        if (!itemId) return alert("Select an item first.");
        const qty = parseFloat(document.getElementById('editAddItemQty').value);
        const rate = parseFloat(document.getElementById('editAddItemRate').value);
        if (isNaN(qty) || qty <= 0) return alert("Enter a valid quantity.");
        if (isNaN(rate) || rate < 0) return alert("Enter a valid rate.");
        const item = stockItems.find(s => s.id == itemId);
        if (!item) return;

        // If this exact item is already a row on this voucher, just add to
        // its quantity instead of creating a confusing duplicate line.
        const existing = editWorkingItems.find(r => r.itemId == itemId);
        if (existing) {
            existing.qty += qty;
        } else {
            editWorkingItems.push({
                rowId: ++editRowIdSeq,
                itemId: item.id, name: item.name, hsn: item.hsn, uom: item.uom, gstRate: item.gstRate,
                qty: qty, inclRate: rate
            });
        }

        document.getElementById('editAddItemSelect').value = '';
        document.getElementById('editAddItemQty').value = '1';
        document.getElementById('editAddItemRate').value = '';
        renderEditItemsList();
        recomputeEditTotal();
    }

    function openEditModal(txnId) {
        if (!isAdmin() && !hasPermission('editVoucher')) { alert("Only an admin, or a user with 'Edit a voucher' turned on, can edit a voucher."); return; }
        const txn = transactions.find(t => t.id == txnId);
        if (!txn) return;
        if (txn.type === 'Journal') {
            alert("Journal entries can't be edited directly yet — delete this one and post a new one instead.");
            return;
        }
        navPushState(closeEditModalUI);
        renderLinkedPayments(txn);
        document.getElementById('editTxnId').value = txn.id;
        document.getElementById('editTitle').innerText = `Edit ${txn.invNo}`;
        document.getElementById('editDate').value = txn.date;

        // Party dropdown
        const pSel = document.getElementById('editParty');
        pSel.innerHTML = '<option value="">-- Choose Party --</option>';
        parties.forEach(p => pSel.innerHTML += `<option value="${p.id}">${escapeHtml(p.name)} (${p.type})</option>`);
        pSel.value = txn.partyId || '';

        const isCash = (txn.type === 'Payment' || txn.type === 'Receipt' || isCustomNoPartyType(txn.type));
        const isInv = isInventoryType(txn.type);
        document.getElementById('editPartyWrap').style.display = isCustomNoPartyType(txn.type) ? 'none' : 'block';

        document.getElementById('editCashWrap').style.display = isCash ? 'block' : 'none';
        document.getElementById('editItemsWrap').style.display = isInv ? 'block' : 'none';
        document.getElementById('editSubLedgerWrap').style.display = isInv ? 'block' : 'none';
        document.getElementById('editNarrationMainWrap').style.display = isInv ? 'block' : 'none';
        if (isInv) document.getElementById('editNarrationMain').value = txn.narration || '';
        document.getElementById('editTransportWrap').style.display = (txn.deliveryNote) ? 'block' : 'none';
        if (txn.deliveryNote) {
            document.getElementById('editDriverName').value = txn.driverName || '';
            document.getElementById('editDriverPhone').value = txn.driverPhone || '';
            document.getElementById('editVehicleNo').value = txn.vehicleNo || '';
            document.getElementById('editVehicleType').value = txn.vehicleType || '';
        }

        if (isInv) {
            // Sub-ledger
            const slSel = document.getElementById('editSubLedger');
            slSel.innerHTML = '<option value="">-- Select Category --</option>';
            subLedgers.forEach(n => slSel.innerHTML += `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`);
            slSel.value = txn.subLedger || '';

            // Working copy of the line items — lets add/remove work without
            // being tied to fixed array indices (which would break as soon
            // as a row is removed or a new one added).
            editWorkingItems = txn.items.map(it => ({
                rowId: ++editRowIdSeq,
                itemId: it.itemId, name: it.name, hsn: it.hsn, uom: it.uom, gstRate: it.gstRate,
                qty: it.qty, inclRate: it.inclRate,
                enteredQty: it.enteredQty, enteredUnit: it.enteredUnit, enteredRate: it.enteredRate
            }));
            // Snapshot BEFORE any discount/total-override edits this session,
            // so "Reset to item rates" and the discount/total scaling always
            // measure from the voucher's actual saved state, not from
            // whatever the rates have already been scaled to mid-session.
            editWorkingItemsOriginal = editWorkingItems.map(it => ({ rowId: it.rowId, inclRate: it.inclRate }));
            editOriginalTotalSnapshot = editBaseTotal();
            document.getElementById('editDiscount').value = '';
            document.getElementById('editTotalOverride').value = '';
            document.getElementById('editDiscountNote').innerText = '';
            renderEditItemsList();

            // "Add Item" picker — every stock item, current master rate
            // auto-filled as a starting point once one is chosen.
            const addSel = document.getElementById('editAddItemSelect');
            addSel.innerHTML = '<option value="">-- Select Item --</option>';
            stockItems.forEach(s => addSel.innerHTML += `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(s.uom)})</option>`);
            document.getElementById('editAddItemQty').value = '1';
            document.getElementById('editAddItemRate').value = '';
        }

        if (isCash) {
            const aSel = document.getElementById('editAccount');
            aSel.innerHTML = '<option value="">-- Select Account --</option>';
            accounts.forEach(a => aSel.innerHTML += `<option value="${a.id}">${escapeHtml(a.name)} (${a.type})</option>`);
            aSel.value = txn.accountId || '';
            document.getElementById('editAmount').value = txn.grandTotal;
            document.getElementById('editNarration').value = txn.narration || '';

            const customEditType = customVoucherTypes.find(v => v.id === txn.type);
            const showCategory = !!(customEditType && customEditType.usesCategory === 'yes');
            document.getElementById('editCashCategoryWrap').style.display = showCategory ? 'block' : 'none';
            if (showCategory) {
                const cSel = document.getElementById('editCashCategory');
                cSel.innerHTML = '<option value="">-- Select Category --</option>';
                subLedgers.forEach(n => cSel.innerHTML += `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`);
                cSel.value = txn.subLedger || '';
            }

            const note = document.getElementById('editRefNote');
            if (isCustomNoPartyType(txn.type)) {
                note.innerHTML = ''; // no-party custom types have no ref-invoice concept
            } else if (txn.refInvoiceId) {
                const inv = transactions.find(t => t.id == txn.refInvoiceId);
                if (inv) {
                    // outstanding excluding THIS voucher
                    const settledOthers = transactions
                        .filter(t => t.refInvoiceId == inv.id && t.id != txn.id)
                        .reduce((a, c) => a + c.grandTotal, 0);
                    const avail = inv.grandTotal - settledOthers;
                    note.innerHTML = `Linked to <strong>${escapeHtml(inv.invNo)}</strong>. Max you can set here: <strong style="color:var(--accent);">\u20B9${avail.toLocaleString('en-IN', {minimumFractionDigits: 2})}</strong>`;
                } else { note.innerHTML = ''; }
            } else {
                note.innerHTML = 'On-account voucher (not linked to a specific invoice).';
            }
        }

        recomputeEditTotal();
        document.getElementById('editModal').style.display = 'flex';
    }

    // Lists every payment linked to the invoice being edited, with the
    // running total and balance, so the person can see at a glance whether
    // changing the invoice amount leaves a receipt out of step.
    function renderLinkedPayments(txn) {
        const wrap = document.getElementById('editLinkedPayWrap');
        const list = document.getElementById('editLinkedPayList');
        if (!wrap || !list) return;

        const isInvoice = (txn.type === 'Sales' || txn.type === 'Purchase' || txn.type === 'RawPurchase');
        const linked = isInvoice
            ? transactions.filter(t => t.refInvoiceId == txn.id)
            : [];

        // The row is useful even with no payments yet — that's the case where
        // a credit sale is now being settled for the first time.
        if (!isInvoice) { wrap.style.display = 'none'; return; }
        wrap.style.display = '';

        const paid = linked.reduce((a, c2) => a + (c2.grandTotal || 0), 0);
        const total = txn.grandTotal || 0;
        const due = Math.max(0, total - paid);
        const over = paid > total;

        const rows = linked.map(p => `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 0;">
                <div>
                    <strong style="font-family:'JetBrains Mono',monospace;">\u20B9${(p.grandTotal || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</strong>
                    <span style="color:var(--text-muted);"> \u00b7 ${escapeHtml(p.invNo || '')} \u00b7 ${escapeHtml(p.date || '')}</span>
                </div>
                <button type="button" class="btn-inline" style="width:auto;"
                        onclick="editLinkedPayment(${p.id})">Edit</button>
            </div>`).join('');

        // Offer to collect whatever is still outstanding, pre-filled.
        const addRow = document.getElementById('editAddPayRow');
        if (addRow) {
            addRow.style.display = due > 0 ? 'flex' : 'none';
            if (due > 0) {
                const accSel = document.getElementById('editAddPayAccount');
                const opts = accounts.filter(a => a.type === 'Cash' || a.type === 'Bank');
                accSel.innerHTML = opts.map(a =>
                    `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
                const preferred = opts.find(a => (a.name || '').toUpperCase() === 'CASH SALE')
                               || opts.find(a => a.type === 'Cash');
                if (preferred) accSel.value = preferred.id;
                document.getElementById('editAddPayAmount').value = due.toFixed(2);
                closeAddPayment();
            }
        }

        if (!linked.length) {
            list.innerHTML = `<div style="color:var(--text-muted);">Nothing received yet \u00b7 Balance due: \u20B9${total.toLocaleString('en-IN', {minimumFractionDigits: 2})}</div>`;
            return;
        }

        list.innerHTML = rows + `
            <div style="margin-top:8px; padding-top:8px;">
                Received: <strong style="font-family:'JetBrains Mono',monospace;">\u20B9${paid.toLocaleString('en-IN', {minimumFractionDigits: 2})}</strong>
                of <strong style="font-family:'JetBrains Mono',monospace;">\u20B9${total.toLocaleString('en-IN', {minimumFractionDigits: 2})}</strong>
                <span style="color:${over ? 'var(--danger)' : 'var(--text-muted)'};">
                    &nbsp;\u00b7&nbsp;${over
                        ? 'Received exceeds the invoice total \u2014 correct a payment below.'
                        : 'Balance due: \u20B9' + due.toLocaleString('en-IN', {minimumFractionDigits: 2})}
                </span>
            </div>`;
    }

    // Jumps from the invoice's edit screen straight into the linked
    // payment's own edit screen, rather than editing it in place: a receipt
    // records money that actually changed hands, so it gets the same
    // deliberate edit path (and audit entry) as any other voucher.
    // The "+" only reveals the fields — it never records anything by itself.
    function openAddPayment() {
        ['editAddPayAmount', 'editAddPayAccount', 'editAddPayConfirm', 'editAddPayCancel']
            .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = ''; });
        const open = document.getElementById('editAddPayOpen');
        if (open) open.style.display = 'none';
        const amt = document.getElementById('editAddPayAmount');
        if (amt) { amt.focus(); amt.select(); }
    }

    function closeAddPayment() {
        ['editAddPayAmount', 'editAddPayAccount', 'editAddPayConfirm', 'editAddPayCancel']
            .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
        const open = document.getElementById('editAddPayOpen');
        if (open) open.style.display = '';
    }

    // Posts a Receipt/Payment for this invoice, already linked. Same shape
    // as one posted manually with "Against Invoice" filled in — the linkage
    // just can't be forgotten.
    function addPaymentAgainstInvoice() {
        const txn = transactions.find(t => t.id == document.getElementById('editTxnId').value);
        if (!txn) return;
        if (!isAdmin() && !hasPermission('postVouchers')) {
            return alert("Only an admin, or a user with 'Post new vouchers' turned on, can post a voucher.");
        }
        const amt = parseFloat(document.getElementById('editAddPayAmount').value);
        if (isNaN(amt) || amt <= 0) return alert('Enter the amount received.');

        const paidSoFar = transactions
            .filter(t => t.refInvoiceId == txn.id)
            .reduce((a, c2) => a + (c2.grandTotal || 0), 0);
        const due = (txn.grandTotal || 0) - paidSoFar;
        if (amt > due + 0.005) {
            return alert(`That's more than the \u20B9${due.toLocaleString('en-IN', {minimumFractionDigits: 2})} still outstanding on this invoice.`);
        }

        const accId = document.getElementById('editAddPayAccount').value;
        const acc = accounts.find(a => a.id == accId);
        if (!acc) return alert('Choose the Cash/Bank account the money went into.');

        const payType = (txn.type === 'Sales') ? 'Receipt' : 'Payment';
        const today = new Date().toISOString().slice(0, 10);
        const payTxn = {
            id: newId(transactions),
            invNo: nextRefNo(payType, today),
            date: today,
            type: payType,
            accountId: acc.id,
            accountName: acc.name,
            refInvoiceId: txn.id,
            refInvoiceNo: txn.invNo,
            narration: 'Against ' + txn.invNo,
            partyId: txn.partyId,
            partyName: txn.partyName,
            items: [],
            taxable: 0,
            totalTax: 0,
            grandTotal: amt
        };
        transactions.push(payTxn);
        localStorage.setItem('tally_mob_db', JSON.stringify(transactions));
        syncCloud();
        logAudit('Created', payTxn, 'Added against ' + txn.invNo);
        closeAddPayment();
        renderLinkedPayments(txn);
        render();
        showSyncToast('ok', `${payType} posted \u2022 ${payTxn.invNo}`);
    }

    function editLinkedPayment(payId) {
        navPendingAfterBack = () => openEditModal(payId);
        closeEditModal();
    }

    function closeEditModal() { history.back(); }
    function closeEditModalUI() {
        document.getElementById('editModal').style.display = 'none';
    }

    function recomputeEditTotal() {
        const txn = transactions.find(t => t.id == document.getElementById('editTxnId').value);
        if (!txn) return;
        let total = 0;
        if (txn.type === 'Payment' || txn.type === 'Receipt' || isCustomNoPartyType(txn.type)) {
            total = parseFloat(document.getElementById('editAmount').value) || 0;
        } else {
            editWorkingItems.forEach(it => { total += (it.qty || 0) * (it.inclRate || 0); });
        }
        document.getElementById('editTotal').innerText = `\u20B9${total.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
    }

    async function saveEditedVoucher() {
        const txn = transactions.find(t => t.id == document.getElementById('editTxnId').value);
        if (!txn) return;

        const newDate = document.getElementById('editDate').value;
        if (!newDate) return alert("Please choose a date.");
        const noPartyType = isCustomNoPartyType(txn.type);
        const newPartyId = document.getElementById('editParty').value;
        if (!noPartyType && !newPartyId) return alert("Please choose a party.");
        const newParty = parties.find(p => p.id == newPartyId);

        const isCash = (txn.type === 'Payment' || txn.type === 'Receipt' || noPartyType);

        if (isCash) {
            const amount = parseFloat(document.getElementById('editAmount').value);
            if (isNaN(amount) || amount <= 0) return alert("Enter a valid amount.");
            const accountId = document.getElementById('editAccount').value;
            if (!accountId) return alert("Select an account.");

            const customEditType = customVoucherTypes.find(v => v.id === txn.type);
            const requiresCategory = !!(customEditType && customEditType.usesCategory === 'yes');
            const category = requiresCategory ? document.getElementById('editCashCategory').value : '';
            if (requiresCategory && !category) return alert("Please select a category.");

            // Validate against linked invoice outstanding (excluding this voucher)
            // — only meaningful for real Payment/Receipt, never for a
            // no-party custom type, which has no ref-invoice concept.
            if (!noPartyType && txn.refInvoiceId) {
                const inv = transactions.find(t => t.id == txn.refInvoiceId);
                if (inv) {
                    const settledOthers = transactions
                        .filter(t => t.refInvoiceId == inv.id && t.id != txn.id)
                        .reduce((a, c) => a + c.grandTotal, 0);
                    const avail = inv.grandTotal - settledOthers;
                    if (amount > avail + 0.001) {
                        return alert(`Amount exceeds available \u20B9${avail.toLocaleString('en-IN', {minimumFractionDigits: 2})} on ${inv.invNo}.`);
                    }
                }
            }

            const accObj = accounts.find(a => a.id == accountId);
            txn.date = newDate;
            if (!noPartyType) {
                txn.partyId = newParty.id;
                txn.partyName = newParty.name;
            }
            txn.accountId = accountId;
            txn.accountName = accObj ? accObj.name : '';
            txn.narration = document.getElementById('editNarration').value.trim();
            txn.grandTotal = amount;
            if (requiresCategory) txn.subLedger = category;

            localStorage.setItem('tally_mob_db', JSON.stringify(transactions));
            syncCloud();
            finishEdit(txn);
            return;
        }

        // ---- Inventory voucher (Sales/Purchase/Optional) ----
        if (editWorkingItems.length === 0) return alert("Add at least one item before saving.");
        if (editWorkingItems.some(l => !(l.qty > 0))) return alert("Quantities must be greater than zero.");
        if (editWorkingItems.some(l => !(l.inclRate >= 0))) return alert("Rates must be zero or more.");

        // If this is a real Sales/Purchase/RawPurchase that has payments linked, changing the
        // total could break settlements — guard it.
        if ((txn.type === 'Sales' || txn.type === 'Purchase' || txn.type === 'RawPurchase')) {
            const linked = transactions.some(t => t.refInvoiceId == txn.id);
            let gt = 0; editWorkingItems.forEach(l => gt += l.qty * l.inclRate);
            const alreadySettled = transactions.filter(t => t.refInvoiceId == txn.id).reduce((a,c)=>a+c.grandTotal,0);
            if (linked && gt < alreadySettled - 0.001) {
                return alert(`New total \u20B9${gt.toLocaleString('en-IN', {minimumFractionDigits: 2})} is less than \u20B9${alreadySettled.toLocaleString('en-IN', {minimumFractionDigits: 2})} already settled by linked payments. Adjust or delete those first.`);
            }
        }

        // Reverse OLD stock effect, based on the voucher's original items
        // (before this edit) — unaffected by any add/remove done just now.
        const dir = stockDirection(txn.type);
        if (affectsMainStock(txn.type)) {
            txn.items.forEach(line => {
                const item = stockItems.find(s => s.id == line.itemId);
                if (item) item.qty += dir * line.qty; // undo: +qty if it had reduced stock, -qty if it had increased it
            });
        }

        // Build the NEW items array fresh from the working copy — this is
        // what makes added/removed rows actually take effect, unlike the
        // old fixed-index qty/rate-only update.
        // calculateLine already zeroes tax out for EXEMPT-mode vouchers
        // (optional/delivery-note/GST-exempt custom types), so every voucher
        // can go through the same taxable/tax/lineTotal computation here.
        let totalTaxable = 0, totalTax = 0, grandTotal = 0;
        const newItemsArr = editWorkingItems.map(row => {
            const tax = calculateLine(row.inclRate, row.qty, row.gstRate, txn.rateMode || 'INCL');
            totalTaxable += tax.taxable;
            totalTax += tax.taxAmount;
            grandTotal += tax.lineTotal;
            const line = {
                itemId: row.itemId, name: row.name, hsn: row.hsn, uom: row.uom, gstRate: row.gstRate,
                qty: row.qty, inclRate: row.inclRate,
                taxable: tax.taxable, taxAmount: tax.taxAmount, lineTotal: tax.lineTotal
            };
            // Carry through the Raw Purchase "entered as X Bags" display
            // metadata if this row still has it (see Raw Purchase entry) —
            // purely cosmetic, only used by that report.
            if (row.enteredQty != null) {
                line.enteredQty = row.enteredQty; line.enteredUnit = row.enteredUnit; line.enteredRate = row.enteredRate;
            }
            return line;
        });

        // Stock check on save — Sales only, matching the same rule new
        // Sales vouchers already follow: going below available stock is
        // allowed, but only after an explicit confirm, and only for Sales.
        // Every other stock-reducing type edited here (Optional Sales,
        // custom stock-out types, etc.) keeps the original hard block.
        if (dir === 1) {
            const isSalesEdit = (txn.type === 'Sales');
            const shortages = [];
            for (const line of newItemsArr) {
                const item = stockItems.find(s => s.id == line.itemId);
                const available = item ? item.qty : 0;
                if (item && available < line.qty) shortages.push({ line, available });
            }
            if (shortages.length > 0) {
                if (isSalesEdit) {
                    const msg = shortages.map(s => `${s.line.name}: only ${s.available} in stock, this line needs ${s.line.qty}`).join('\n');
                    const proceed = await confirmAsync(`This edit goes below available stock:\n\n${msg}\n\nSave anyway? Stock will show negative until you purchase more.`);
                    if (!proceed) {
                        stockItems = JSON.parse(localStorage.getItem('tally_mob_stock')); // rollback the reversal done above
                        return;
                    }
                } else {
                    // rollback the reversal we did above before aborting
                    stockItems = JSON.parse(localStorage.getItem('tally_mob_stock'));
                    return alert(`Not enough stock for ${shortages[0].line.name}. Available after other entries: ${shortages[0].available}.`);
                }
            }
        }

        // Apply new stock effect
        if (affectsMainStock(txn.type)) {
            newItemsArr.forEach(line => {
                const item = stockItems.find(s => s.id == line.itemId);
                if (item) item.qty -= dir * line.qty; // opposite of the undo above
            });
            localStorage.setItem('tally_mob_stock', JSON.stringify(stockItems));
            syncCloud();
        }

        txn.items = newItemsArr;
        txn.date = newDate;
        txn.partyId = newParty.id;
        txn.partyName = newParty.name;
        txn.subLedger = document.getElementById('editSubLedger').value || '';
        txn.narration = document.getElementById('editNarrationMain').value.trim();
        txn.taxable = totalTaxable;
        txn.totalTax = totalTax;
        txn.grandTotal = grandTotal;
        if (txn.deliveryNote) {
            txn.driverName = document.getElementById('editDriverName').value.trim();
            txn.driverPhone = document.getElementById('editDriverPhone').value.trim();
            txn.vehicleNo = document.getElementById('editVehicleNo').value.trim();
            txn.vehicleType = document.getElementById('editVehicleType').value.trim();
        }

        localStorage.setItem('tally_mob_db', JSON.stringify(transactions));
        syncCloud();
        finishEdit(txn);
    }

    // After any successful edit, refresh whatever views are open.
    // Every edit path funnels through here, so it's the one place that
    // reliably catches an edit having been committed.
    function finishEdit(txn) {
        logAudit('Edited', txn);
        closeEditModal();
        render();
        if (typeof renderOptional === 'function' && txn.optional) renderOptional();
        // refresh any open list panels
        const openPanels = document.querySelectorAll('.panel.active');
        openPanels.forEach(p => {
            if (p.id === 'panelPayments') renderCashList('Payment');
            if (p.id === 'panelReceipts') renderCashList('Receipt');
            if (p.id === 'panelOptional') renderOptional();
            if (p.id === 'panelSubLedgerReport') renderSubLedgerReport();
            if (p.id === 'panelSalesStatement') renderSalesStatement();
            if (p.id === 'panelDeliveryNotes') renderDeliveryNotes();
            if (p.id === 'panelCashReport') renderCashReport();
            if (p.id === 'panelCustomVoucherList') renderCustomVoucherList();
            if (p.id === 'panelVoucherTypes') renderVoucherTypes();
        });
        // refresh open ledger statement
        if (document.getElementById('ledgerPrintArea').style.display === 'block' && typeof lastLedger !== 'undefined' && lastLedger) {
            openLedgerStatement(lastLedger.kind, lastLedger.id);
        }
        alert(`${txn.invNo} updated.`);
    }

    async function deleteTransaction(txnId) {
        if (!isAdmin() && !hasPermission('deleteVoucher')) return alert("Only an admin, or a user with 'Delete a voucher' turned on, can delete a voucher.");
        const txnIndex = transactions.findIndex(t => t.id == txnId);
        if (txnIndex === -1) return;
        const txn = transactions[txnIndex];

        // Block deleting a Sales/Purchase/RawPurchase invoice that has payments linked to it
        if (txn.type === 'Sales' || txn.type === 'Purchase' || txn.type === 'RawPurchase') {
            const linked = transactions.some(t => t.refInvoiceId == txn.id);
            if (linked) return alert(`Cannot delete ${txn.invNo}: there are Payment/Receipt entries linked to it. Delete those first.`);
        }

        if (!(await confirmAsync(`Are you sure you want to delete ${txn.invNo}? Stock will be updated accordingly.`))) return;
        logAudit('Deleted', txn);

        (txn.items || []).forEach(line => {
            const item = stockItems.find(s => s.id == line.itemId);
            if (!item) return;
            if (txn.type === 'Sales') item.qty += line.qty;
            else if (txn.type === 'Purchase' || txn.type === 'RawPurchase') item.qty -= line.qty;
            else if (txn.customVoucherTypeId) {
                const vt = customVoucherTypes.find(v => v.id === txn.customVoucherTypeId);
                if (vt && vt.stockEffect === 'out') item.qty += line.qty;      // undo the reduction
                else if (vt && vt.stockEffect === 'in') item.qty -= line.qty; // undo the increase
            }
        });
        localStorage.setItem('tally_mob_stock', JSON.stringify(stockItems));
        syncCloud();

        transactions.splice(txnIndex, 1);
        renumberSeriesAfterDelete(txn);
        localStorage.setItem('tally_mob_db', JSON.stringify(transactions));
        syncCloud();
        render();
        
        document.getElementById('ledgerPrintArea').style.display = 'none';
    }

    async function deleteItem(itemId) {
        if (!isAdmin() && !hasPermission('deleteItem')) return alert("Only an admin, or a user with 'Delete a stock item' turned on, can delete a stock item.");
        const item = stockItems.find(s => s.id == itemId);
        if (!item) return;

        if (item.qty !== 0) return alert("Cannot delete item with active stock balance!");

        if (await confirmAsync(`Delete stock item "${item.name}"?`)) {
            stockItems = stockItems.filter(s => s.id != itemId);
            localStorage.setItem('tally_mob_stock', JSON.stringify(stockItems));
            syncCloud();
            render();
        }
    }
  
    // ---- Payments / Receipts lists with period filter ----
    function onPeriodChange(kind) {
        const isPay = kind === 'Payment';
        const sel = document.getElementById(isPay ? 'payPeriod' : 'rcptPeriod').value;
        document.getElementById(isPay ? 'payCustomWrap' : 'rcptCustomWrap').style.display =
            (sel === 'custom') ? 'block' : 'none';
        renderCashList(kind);
    }

    // Returns {from, to} Date bounds (inclusive) for the chosen preset, or null for all.
    // Local-timezone-safe YYYY-MM-DD (avoids the UTC day-shift that
    // toISOString() can cause for date-only comparisons).
    function dateToYMD(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function periodRange(preset, fromStr, toStr) {
        const now = new Date();
        if (preset === 'all') return null;
        if (preset === 'thisMonth') {
            return { from: new Date(now.getFullYear(), now.getMonth(), 1),
                     to: new Date(now.getFullYear(), now.getMonth() + 1, 0) };
        }
        if (preset === 'lastMonth') {
            return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1),
                     to: new Date(now.getFullYear(), now.getMonth(), 0) };
        }
        if (preset === 'thisYear') {
            // Financial year Apr 1 - Mar 31 (Indian convention), following
            // whichever Financial Year is currently active (chosen at
            // login / the header FY badge) rather than always "today".
            const y = Number(localStorage.getItem(ACTIVE_FY_KEY)) || currentFinancialYearStart();
            return { from: new Date(y, 3, 1), to: new Date(y + 1, 2, 31) };
        }
        if (preset === 'custom') {
            const f = fromStr ? new Date(fromStr) : null;
            const t = toStr ? new Date(toStr) : null;
            return { from: f, to: t };
        }
        return null;
    }

    function inRange(dateStr, range) {
        if (!range) return true;
        // Parse at local NOON, not bare "YYYY-MM-DD". A bare date string is
        // parsed as UTC midnight, which lands on the PREVIOUS day once
        // converted to a local time behind UTC — silently dropping
        // start-of-period vouchers out of a report. Noon is far enough from
        // both midnights that no timezone can shift the day, and it matches
        // what financialYearLabel() already does.
        const d = new Date(dateStr + 'T12:00:00');
        if (isNaN(d)) return true; // unparseable date — don't hide the row
        if (range.from && d < new Date(range.from.getFullYear(), range.from.getMonth(), range.from.getDate())) return false;
        if (range.to && d > new Date(range.to.getFullYear(), range.to.getMonth(), range.to.getDate(), 23, 59, 59)) return false;
        return true;
    }

    let paymentsRowOrder = [];
    let receiptsRowOrder = [];
    function renderCashList(kind) {
        const isPay = kind === 'Payment';
        const listKey = isPay ? 'payments' : 'receipts';
        clearSelection(listKey);
        const preset = document.getElementById(isPay ? 'payPeriod' : 'rcptPeriod').value;
        const fromStr = document.getElementById(isPay ? 'payFrom' : 'rcptFrom').value;
        const toStr = document.getElementById(isPay ? 'payTo' : 'rcptTo').value;
        const range = periodRange(preset, fromStr, toStr);

        const rows = sortByDate(
            transactions.filter(t => t.type === kind && inRange(t.date, range)),
            listKey
        );

        const body = document.getElementById(isPay ? 'paymentsBody' : 'receiptsBody');
        body.innerHTML = '';
        let total = 0;

        if (rows.length === 0) {
            body.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--text-muted);">No ${kind.toLowerCase()}s in this period.</td></tr>`;
        } else {
            if (isPay) paymentsRowOrder = rows.map(t => t.id); else receiptsRowOrder = rows.map(t => t.id);
            rows.forEach(t => { total += t.grandTotal; }); // full-set total, independent of which page is showing
            const pageRows = paginateRows(listKey, rows);
            pageRows.forEach(t => {
                const ref = t.refInvoiceNo
                    ? `<span style="color:var(--accent);">${escapeHtml(t.refInvoiceNo)}</span>`
                    : '<span style="color:var(--text-muted);">On Account</span>';
                // Ref No opens the Payment/Receipt voucher itself. Against
                // Invoice opens the sale/purchase invoice it's settling, if
                // any — same distinction as Purchase/Sales reports.
                const openId = t.id;
                const invOpenId = t.refInvoiceId || t.id;
                body.innerHTML += `
                    <tr style="cursor:pointer;" title="Open ${kind.toLowerCase()}">
                        <td class="no-print" data-select-col="${listKey}" style="display:none;" onclick="event.stopPropagation();">
                            <input type="checkbox" data-select-key="${listKey}" data-select-id="${t.id}" onchange="toggleRowSelection('${listKey}', ${t.id}, this.checked)">
                        </td>
                        <td onclick="printInvoice(${openId})">${t.date}</td>
                        <td onclick="printInvoice(${openId})">${escapeHtml(t.invNo)}</td>
                        <td style="color:var(--accent); text-decoration:underline;" onclick="event.stopPropagation(); openPartyLedgerFromReport(${t.partyId})" title="Open party ledger">${escapeHtml(t.partyName)}</td>
                        <td onclick="printInvoice(${openId})">${escapeHtml(t.accountName || 'Cash')}</td>
                        <td onclick="printInvoice(${invOpenId})">${ref}</td>
                        <td onclick="printInvoice(${openId})" style="font-weight:bold;">\u20B9${t.grandTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        <td style="display:flex; gap:6px;"><button onclick="event.stopPropagation(); deleteTransaction(${t.id})" class="btn-danger" style="padding:4px 10px; font-size:0.72rem;">Delete</button></td>
                    </tr>
                `;
            });
        }

        renderPaginationControls(listKey, rows.length, () => renderCashList(kind));
        document.getElementById(isPay ? 'payPeriodTotal' : 'rcptPeriodTotal').innerText =
            `\u20B9${total.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
    }

    // ---- Payments & Receipts Report (Reports tile): ref no + inventory ----
    function onCrPeriodChange() {
        const sel = document.getElementById('crPeriod').value;
        document.getElementById('crCustomWrap').style.display = (sel === 'custom') ? 'block' : 'none';
        renderCashReport();
    }

    function renderCashReport() {
        // Keep the account filter's option list current (accounts can be
        // added/renamed at any time).
        const accSel = document.getElementById('crAccount');
        const prevAccSel = accSel.value;
        accSel.innerHTML = '<option value="all">All Accounts</option><option value="group:Cash">All Cash Accounts</option><option value="group:Bank">All Bank Accounts</option>';
        accounts.forEach(a => {
            accSel.innerHTML += `<option value="${a.id}">${escapeHtml(a.name)} (${escapeHtml(a.type)})</option>`;
        });
        if ([...accSel.options].some(o => o.value === prevAccSel)) accSel.value = prevAccSel;

        // Live balance strip — every Cash account and every Bank account
        // shown separately, so the two are never lumped into one figure.
        const stripEl = document.getElementById('crBalanceStrip');
        const cashAccts = accounts.filter(a => a.type === 'Cash');
        const bankAccts = accounts.filter(a => a.type === 'Bank');
        let stripHtml = '';
        cashAccts.forEach(a => {
            stripHtml += `<div class="summary-card" style="cursor:default;"><div>Cash: ${escapeHtml(a.name)}</div><div style="color:var(--success);">\u20B9${accountBalance(a.id).toLocaleString('en-IN', {minimumFractionDigits: 2})}</div></div>`;
        });
        bankAccts.forEach(a => {
            stripHtml += `<div class="summary-card" style="cursor:default;"><div>Bank: ${escapeHtml(a.name)}</div><div style="color:var(--accent);">\u20B9${accountBalance(a.id).toLocaleString('en-IN', {minimumFractionDigits: 2})}</div></div>`;
        });
        stripEl.innerHTML = stripHtml || '<div class="summary-card" style="cursor:default;"><div>No Cash/Bank accounts yet</div><div style="color:var(--text-muted);">Add one under Accounts</div></div>';

        const typeFilter = document.getElementById('crType').value;
        const accFilter = accSel.value;
        const range = periodRange(document.getElementById('crPeriod').value,
                                  document.getElementById('crFrom').value,
                                  document.getElementById('crTo').value);

        const rows = sortByDate(transactions
            .filter(t => (t.type === 'Payment' || t.type === 'Receipt'))
            .filter(t => typeFilter === 'both' || t.type === typeFilter)
            .filter(t => {
                if (accFilter === 'all') return true;
                if (accFilter === 'group:Cash') return cashAccts.some(a => a.id == t.accountId);
                if (accFilter === 'group:Bank') return bankAccts.some(a => a.id == t.accountId);
                return t.accountId == accFilter;
            })
            .filter(t => inRange(t.date, range)), 'cashReport');

        const body = document.getElementById('cashReportBody');
        body.innerHTML = '';
        let receiptsTotal = 0, paymentsTotal = 0;

        if (rows.length === 0) {
            body.innerHTML = '<tr><td colspan="8" style="text-align:center; color:var(--text-muted);">No payments or receipts in this period.</td></tr>';
        } else {
            rows.forEach(t => {
                if (t.type === 'Receipt') receiptsTotal += t.grandTotal;
                else paymentsTotal += t.grandTotal;

                const ref = t.refInvoiceNo
                    ? `<span style="color:var(--accent);">${escapeHtml(t.refInvoiceNo)}</span>`
                    : '<span style="color:var(--text-muted);">On Account</span>';

                // Pull inventory detail from the linked invoice, if any.
                let inventoryHtml = '<span style="color:var(--text-muted);">&mdash;</span>';
                const linkedInv = t.refInvoiceId ? transactions.find(x => x.id == t.refInvoiceId) : null;
                if (linkedInv && linkedInv.items && linkedInv.items.length) {
                    inventoryHtml = linkedInv.items.map(it =>
                        `${escapeHtml(it.name)} (${it.qty} ${escapeHtml(it.uom)})`
                    ).join(', ');
                }

                // Ref No opens the Payment/Receipt voucher itself. Against
                // Invoice opens the sale/purchase invoice it's settling, if
                // any — same distinction as Purchase/Sales reports.
                const openId = t.id;
                const invOpenId = t.refInvoiceId || t.id;
                const typeColor = t.type === 'Receipt' ? 'var(--success)' : 'var(--danger)';

                body.innerHTML += `
                    <tr style="cursor:pointer;" title="Open voucher">
                        <td onclick="printInvoice(${openId})">${t.date}</td>
                        <td onclick="printInvoice(${openId})" style="color:${typeColor}; font-weight:bold;">${t.type}</td>
                        <td onclick="printInvoice(${openId})">${escapeHtml(t.invNo)}</td>
                        <td style="color:var(--accent); text-decoration:underline;" onclick="event.stopPropagation(); openPartyLedgerFromReport(${t.partyId})" title="Open party ledger">${escapeHtml(t.partyName)}</td>
                        <td onclick="printInvoice(${openId})">${escapeHtml(t.accountName || 'Cash')}</td>
                        <td onclick="printInvoice(${invOpenId})">${ref}</td>
                        <td onclick="printInvoice(${invOpenId})" style="white-space:normal; max-width:260px;">${inventoryHtml}</td>
                        <td onclick="printInvoice(${openId})" style="font-weight:bold;">\u20B9${t.grandTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    </tr>
                `;
            });
        }

        document.getElementById('crReceiptsTotal').innerText =
            `\u20B9${receiptsTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
        document.getElementById('crPaymentsTotal').innerText =
            `\u20B9${paymentsTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
    }


    // ---- Sub-Ledger Report (sales & purchases by category) ----
    function onSlPeriodChange() {
        const sel = document.getElementById('slPeriod').value;
        document.getElementById('slCustomWrap').style.display = (sel === 'custom') ? 'block' : 'none';
        renderSubLedgerReport();
    }

    function renderSubLedgerReport() {
        const preset = document.getElementById('slPeriod').value;
        const fromStr = document.getElementById('slFrom').value;
        const toStr = document.getElementById('slTo').value;
        const range = periodRange(preset, fromStr, toStr);

        // Aggregate sales & purchases per category. Optional vouchers are
        // included here (tagged by their category) since this is a category
        // report, not the main books; their value uses grandTotal.
        const tally = {};   // name -> { sales, purch }
        const ensure = n => { if (!tally[n]) tally[n] = { sales: 0, purch: 0 }; return tally[n]; };

        // Seed known categories so they always show, even at zero.
        subLedgers.forEach(n => ensure(n));

        transactions.forEach(t => {
            if (!inRange(t.date, range)) return;
            const isSale = (t.type === 'Sales' || t.type === 'OptionalSales');
            const isPurch = (t.type === 'Purchase' || t.type === 'OptionalPurchase');
            if (!isSale && !isPurch) return;
            const name = t.subLedger && t.subLedger.trim() ? t.subLedger : 'Uncategorized';
            const bucket = ensure(name);
            if (isSale) bucket.sales += t.grandTotal;
            else bucket.purch += t.grandTotal;
        });

        const body = document.getElementById('subLedgerReportBody');
        body.innerHTML = '';
        let totSales = 0, totPurch = 0;

        // Sort: named categories first (by name), Uncategorized last.
        const names = Object.keys(tally).sort((a, b) => {
            if (a === 'Uncategorized') return 1;
            if (b === 'Uncategorized') return -1;
            return a.localeCompare(b);
        });

        let anyRows = false;
        names.forEach(name => {
            const { sales, purch } = tally[name];
            // Skip zero rows that are Uncategorized (keep seeded categories visible)
            if (name === 'Uncategorized' && sales === 0 && purch === 0) return;
            anyRows = true;
            totSales += sales; totPurch += purch;
            const net = sales - purch;
            const netColor = net > 0 ? 'var(--success)' : net < 0 ? 'var(--danger)' : 'var(--text-muted)';
            body.innerHTML += `
                <tr style="cursor:pointer;" onclick="openCategoryDetail('${escapeHtml(name)}')" title="Open category detail">
                    <td><strong>${escapeHtml(name)}</strong></td>
                    <td style="color:var(--success);">\u20B9${sales.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    <td style="color:var(--pink);">\u20B9${purch.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    <td style="color:${netColor}; font-weight:bold;">\u20B9${net.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                </tr>
            `;
        });

        if (!anyRows) {
            body.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">No sales or purchases in this period.</td></tr>';
        }

        document.getElementById('slTotalSales').innerText = `\u20B9${totSales.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
        document.getElementById('slTotalPurch').innerText = `\u20B9${totPurch.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
    }

    // Drill into one sub-ledger category: every sale/purchase (incl. optional)
    // tagged with it, each with its inventory line items shown inline.
    let currentCategoryDetail = null;

    let categoryDetailRowOrder = [];
    function openCategoryDetail(name) {
        clearSelection('categoryDetail');
        currentCategoryDetail = name;
        document.getElementById('catDetailTitle').innerText = `Category: ${name}`;
        const body = document.getElementById('categoryDetailBody');
        body.innerHTML = '';

        const rows = sortByDate(transactions.filter(t => {
            const isSale = (t.type === 'Sales' || t.type === 'OptionalSales');
            const isPurch = (t.type === 'Purchase' || t.type === 'OptionalPurchase');
            if (!isSale && !isPurch) return false;
            const cat = t.subLedger && t.subLedger.trim() ? t.subLedger : 'Uncategorized';
            return cat === name;
        }), 'categoryDetail');

        let salesTotal = 0, purchTotal = 0;

        if (rows.length === 0) {
            body.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">No transactions in this category yet.</td></tr>';
        } else {
            categoryDetailRowOrder = rows.map(t => t.id);
            rows.forEach(t => {
                const isSaleType = (t.type === 'Sales' || t.type === 'OptionalSales');
                if (isSaleType) salesTotal += t.grandTotal; else purchTotal += t.grandTotal;
                const itemList = (t.items || []).map(it => `${escapeHtml(it.name || 'Item')} (${it.qty || 0} ${escapeHtml(it.uom || '')} @ \u20B9${(typeof it.inclRate === 'number' ? it.inclRate : 0).toLocaleString('en-IN', {minimumFractionDigits: 2})})`).join(', ');
                const typeColor = isSaleType ? 'var(--success)' : 'var(--pink)';
                body.innerHTML += `
                    <tr onclick="printInvoice(${t.id})" style="cursor:pointer;" title="Open invoice">
                        <td class="no-print" data-select-col="categoryDetail" style="display:none;" onclick="event.stopPropagation();">
                            <input type="checkbox" data-select-key="categoryDetail" data-select-id="${t.id}" onchange="toggleRowSelection('categoryDetail', ${t.id}, this.checked)">
                        </td>
                        <td>${t.date}</td>
                        <td style="color:${typeColor}; font-weight:bold;">${t.type}</td>
                        <td>${escapeHtml(t.invNo)}</td>
                        <td style="color:var(--accent); text-decoration:underline;" onclick="event.stopPropagation(); openPartyLedgerFromReport(${t.partyId})" title="Open party ledger">${escapeHtml(t.partyName)}</td>
                        <td style="white-space:normal; max-width:280px;">${itemList}</td>
                        <td style="font-weight:bold;">\u20B9${t.grandTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    </tr>
                `;
            });
        }

        document.getElementById('catSalesTotal').innerText = `\u20B9${salesTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
        document.getElementById('catPurchTotal').innerText = `\u20B9${purchTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
        openPanel('panelCategoryDetail');
    }

    // ---- Sales Statement (all sales, by period) ----
    function onSalesPeriodChange() {
        const sel = document.getElementById('salesPeriod').value;
        document.getElementById('salesCustomWrap').style.display = (sel === 'custom') ? 'block' : 'none';
        renderSalesStatement();
    }

    let salesStatementRowOrder = [];
    function renderSalesStatement() {
        clearSelection('salesStatement');
        const range = periodRange(document.getElementById('salesPeriod').value,
                                  document.getElementById('salesFrom').value,
                                  document.getElementById('salesTo').value);
        const rows = sortByDate(
            transactions.filter(t => t.type === 'Sales' && inRange(t.date, range)),
            'salesStatement'
        );

        const body = document.getElementById('salesStatementBody');
        body.innerHTML = '';
        let total = 0;

        if (rows.length === 0) {
            body.innerHTML = '<tr><td colspan="10" style="text-align:center; color:var(--text-muted);">No sales in this period.</td></tr>';
        } else {
            salesStatementRowOrder = rows.map(t => t.id);
            rows.forEach(t => { total += t.grandTotal; }); // full-set total, independent of which page is showing
            const pageRows = paginateRows('salesStatement', rows);
            pageRows.forEach(t => {
                const cat = t.subLedger
                    ? `<span style="color:var(--violet); text-decoration:underline; cursor:pointer;" onclick="event.stopPropagation(); openCategoryDetail('${escapeHtml(t.subLedger)}')" title="Open category detail">${escapeHtml(t.subLedger)}</span>`
                    : '<span style="color:var(--text-muted);">&mdash;</span>';
                const itemsDetail = (t.items && t.items.length)
                    ? t.items.map(it => `<div class="item-detail-line">${escapeHtml(it.name)}: ${it.qty}${it.uom ? ' ' + escapeHtml(it.uom) : ''} @ \u20B9${(it.inclRate || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</div>`).join('')
                    : '<span style="color:var(--text-muted);">&mdash;</span>';
                body.innerHTML += `
                    <tr style="cursor:pointer;">
                        <td class="no-print" data-select-col="salesStatement" style="display:none;" onclick="event.stopPropagation();">
                            <input type="checkbox" data-select-key="salesStatement" data-select-id="${t.id}" onchange="toggleRowSelection('salesStatement', ${t.id}, this.checked)">
                        </td>
                        <td onclick="printInvoice(${t.id})">${t.date}</td>
                        <td onclick="printInvoice(${t.id})">${escapeHtml(t.invNo)}</td>
                        <td style="color:var(--accent); text-decoration:underline;" onclick="event.stopPropagation(); openPartyLedgerFromReport(${t.partyId})" title="Open party ledger">${escapeHtml(t.partyName)}</td>
                        <td onclick="printInvoice(${t.id})">${cat}</td>
                        <td onclick="printInvoice(${t.id})">${itemsDetail}</td>
                        <td onclick="printInvoice(${t.id})">\u20B9${t.taxable.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        <td onclick="printInvoice(${t.id})">\u20B9${t.totalTax.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        <td onclick="printInvoice(${t.id})" style="font-weight:bold;">\u20B9${t.grandTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        <td class="no-print" style="display:flex; gap:6px;">
                            <button onclick="event.stopPropagation(); deleteVoucherSmart(${t.id})" class="btn-danger" style="padding:3px 9px; font-size:0.7rem;">Delete</button>
                        </td>
                    </tr>
                `;
            });
        }
        renderPaginationControls('salesStatement', rows.length, renderSalesStatement);
        document.getElementById('salesPeriodTotal').innerText =
            `\u20B9${total.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
    }

    // ---- Purchase Report (mirrors Sales Statement, for Purchase + Raw Purchase) ----
    function onPurchPeriodChange() {
        const sel = document.getElementById('purchPeriod').value;
        document.getElementById('purchCustomWrap').style.display = (sel === 'custom') ? 'block' : 'none';
        renderPurchaseReport();
    }

    let purchaseReportRowOrder = [];
    function renderPurchaseReport() {
        clearSelection('purchaseReport');
        const range = periodRange(document.getElementById('purchPeriod').value,
                                  document.getElementById('purchFrom').value,
                                  document.getElementById('purchTo').value);
        const rows = sortByDate(
            transactions.filter(t => (t.type === 'Purchase' || t.type === 'RawPurchase') && inRange(t.date, range)),
            'purchaseReport'
        );

        const body = document.getElementById('purchaseReportBody');
        body.innerHTML = '';
        let total = 0;

        if (rows.length === 0) {
            body.innerHTML = '<tr><td colspan="11" style="text-align:center; color:var(--text-muted);">No purchases in this period.</td></tr>';
        } else {
            purchaseReportRowOrder = rows.map(t => t.id);
            rows.forEach(t => { total += t.grandTotal; }); // full-set total, independent of which page is showing
            const pageRows = paginateRows('purchaseReport', rows);
            pageRows.forEach(t => {
                const cat = t.subLedger
                    ? `<span style="color:var(--violet); text-decoration:underline; cursor:pointer;" onclick="event.stopPropagation(); openCategoryDetail('${escapeHtml(t.subLedger)}')" title="Open category detail">${escapeHtml(t.subLedger)}</span>`
                    : '<span style="color:var(--text-muted);">&mdash;</span>';
                const typeLabel = t.type === 'RawPurchase'
                    ? '<span style="color:var(--success); font-weight:bold;">Raw Purchase</span>'
                    : '<span style="color:var(--text-main);">Purchase</span>';
                body.innerHTML += `
                    <tr style="cursor:pointer;">
                        <td class="no-print" data-select-col="purchaseReport" style="display:none;" onclick="event.stopPropagation();">
                            <input type="checkbox" data-select-key="purchaseReport" data-select-id="${t.id}" onchange="toggleRowSelection('purchaseReport', ${t.id}, this.checked)">
                        </td>
                        <td onclick="printInvoice(${t.id})">${t.date}</td>
                        <td onclick="printInvoice(${t.id})">${escapeHtml(t.invNo)}</td>
                        <td style="color:var(--accent); text-decoration:underline;" onclick="event.stopPropagation(); openPartyLedgerFromReport(${t.partyId})" title="Open vendor ledger">${escapeHtml(t.partyName)}</td>
                        <td onclick="printInvoice(${t.id})">${typeLabel}</td>
                        <td onclick="printInvoice(${t.id})">${cat}</td>
                        <td onclick="printInvoice(${t.id})">${t.items ? t.items.length : 0}</td>
                        <td onclick="printInvoice(${t.id})">\u20B9${t.taxable.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        <td onclick="printInvoice(${t.id})">\u20B9${t.totalTax.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        <td onclick="printInvoice(${t.id})" style="font-weight:bold;">\u20B9${t.grandTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        <td class="no-print" style="display:flex; gap:6px;">
                            <button onclick="event.stopPropagation(); deleteVoucherSmart(${t.id})" class="btn-danger" style="padding:3px 9px; font-size:0.7rem;">Delete</button>
                        </td>
                    </tr>
                `;
            });
        }
        renderPaginationControls('purchaseReport', rows.length, renderPurchaseReport);
        document.getElementById('purchPeriodTotal').innerText =
            `\u20B9${total.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
    }

    // ---- GST Liability (dashboard tile drill-down): mini GST return ----
    function onGstPeriodChange() {
        const sel = document.getElementById('gstPeriod').value;
        document.getElementById('gstCustomWrap').style.display = (sel === 'custom') ? 'block' : 'none';
        renderGstLiability();
    }

    function renderGstLiability() {
        const range = periodRange(document.getElementById('gstPeriod').value,
                                  document.getElementById('gstFrom').value,
                                  document.getElementById('gstTo').value);
        const view = document.getElementById('gstView').value; // 'all' | 'taxed' | 'nil'

        // Same rule the dashboard figure itself uses: Output tax from Sales,
        // Input tax from Purchase only (Raw Purchase is tracked separately
        // and deliberately excluded from the main GST/Purchase totals).
        let rows = transactions.filter(t => (t.type === 'Sales' || t.type === 'Purchase') && inRange(t.date, range));
        if (view === 'taxed') rows = rows.filter(t => t.taxType !== 'EXEMPT');
        else if (view === 'nil') rows = rows.filter(t => t.taxType === 'EXEMPT');
        rows = sortByDate(rows, 'gstLiability');

        const body = document.getElementById('gstLiabilityBody');
        body.innerHTML = '';
        let outputTax = 0, inputTax = 0, outputTaxable = 0, inputTaxable = 0;

        if (rows.length === 0) {
            const emptyMsg = view === 'nil' ? 'No Nil GST transactions in this period.'
                            : view === 'taxed' ? 'No taxed GST transactions in this period.'
                            : 'No GST-contributing transactions in this period.';
            body.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">${emptyMsg}</td></tr>`;
        } else {
            rows.forEach(t => {
                const isSale = (t.type === 'Sales');
                if (isSale) { outputTax += t.totalTax; outputTaxable += t.taxable; }
                else { inputTax += t.totalTax; inputTaxable += t.taxable; }
                const taxColor = isSale ? 'var(--success)' : 'var(--pink)';
                const taxLabel = isSale ? 'Output' : 'Input';
                const taxCellText = (t.taxType === 'EXEMPT')
                    ? `<span style="color:var(--text-muted);">Nil GST</span>`
                    : `\u20B9${t.totalTax.toLocaleString('en-IN', {minimumFractionDigits: 2})} (${taxLabel})`;
                body.innerHTML += `
                    <tr style="cursor:pointer;" title="Open invoice">
                        <td onclick="printInvoice(${t.id})">${t.date}</td>
                        <td onclick="printInvoice(${t.id})">${escapeHtml(t.type)}</td>
                        <td onclick="printInvoice(${t.id})">${escapeHtml(t.invNo)}</td>
                        <td style="color:var(--accent); text-decoration:underline;" onclick="event.stopPropagation(); openPartyLedgerFromReport(${t.partyId})" title="Open party ledger">${escapeHtml(t.partyName)}</td>
                        <td onclick="printInvoice(${t.id})">\u20B9${t.taxable.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        <td onclick="printInvoice(${t.id})" style="color:${taxColor}; font-weight:bold;">${taxCellText}</td>
                    </tr>
                `;
            });
        }

        const card1 = document.getElementById('gstCard1Label');
        const card2 = document.getElementById('gstCard2Label');
        const card3 = document.getElementById('gstCard3Label');
        const outEl = document.getElementById('gstOutputTax');
        const inEl = document.getElementById('gstInputTax');
        const netEl = document.getElementById('gstNetPayable');

        if (view === 'nil') {
            // Tax is always ₹0 on Nil-rated supplies — what actually matters
            // for GSTR-1's Nil Rated section is the taxable VALUE, so show
            // that instead of a meaningless ₹0.00 "tax" figure.
            card1.innerText = 'Nil Rated Value (Sales)';
            card2.innerText = 'Nil Rated Value (Purchases)';
            card3.innerText = 'Total Nil Rated Value';
            outEl.innerText = `\u20B9${outputTaxable.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
            inEl.innerText = `\u20B9${inputTaxable.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
            netEl.innerText = `\u20B9${(outputTaxable + inputTaxable).toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
            netEl.style.color = 'var(--text-muted)';
        } else {
            card1.innerText = 'Output Tax (Sales)';
            card2.innerText = 'Input Tax (Purchases)';
            card3.innerText = 'Net Payable';
            const net = outputTax - inputTax;
            outEl.innerText = `\u20B9${outputTax.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
            inEl.innerText = `\u20B9${inputTax.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
            netEl.innerText = `\u20B9${Math.abs(net).toLocaleString('en-IN', {minimumFractionDigits: 2})}${net < 0 ? ' (Credit)' : ''}`;
            netEl.style.color = net < 0 ? 'var(--success)' : 'var(--warning)';
        }
    }

    // ---- Delivery Notes (dispatch records) ----
    function onDnPeriodChange() {
        const sel = document.getElementById('dnPeriod').value;
        document.getElementById('dnCustomWrap').style.display = (sel === 'custom') ? 'block' : 'none';
        renderDeliveryNotes();
    }

    let deliveryNotesRowOrder = [];
    function renderDeliveryNotes() {
        clearSelection('deliveryNotes');
        const range = periodRange(document.getElementById('dnPeriod').value,
                                  document.getElementById('dnFrom').value,
                                  document.getElementById('dnTo').value);
        const rows = sortByDate(
            transactions.filter(t => t.deliveryNote && inRange(t.date, range)),
            'deliveryNotes'
        );

        const body = document.getElementById('deliveryNotesBody');
        body.innerHTML = '';

        if (rows.length === 0) {
            body.innerHTML = '<tr><td colspan="8" style="text-align:center; color:var(--text-muted);">No delivery notes in this period.</td></tr>';
        } else {
            deliveryNotesRowOrder = rows.map(t => t.id);
            rows.forEach(t => {
                const itemList = (t.items || []).map(i => `${escapeHtml(i.name)} (${i.qty} ${escapeHtml(i.uom)})`).join(', ');
                const narrationHint = t.narration ? `<div style="font-size:0.72rem; color:var(--text-muted); font-style:italic; margin-top:3px;">${escapeHtml(t.narration)}</div>` : '';
                const transportBits = [];
                if (t.driverName) transportBits.push(escapeHtml(t.driverName) + (t.driverPhone ? ' (' + escapeHtml(t.driverPhone) + ')' : ''));
                if (t.vehicleNo) transportBits.push(escapeHtml(t.vehicleNo) + (t.vehicleType ? ' - ' + escapeHtml(t.vehicleType) : ''));
                const transportHtml = transportBits.length
                    ? transportBits.join('<br>')
                    : '<span style="color:var(--text-muted);">&mdash;</span>';
                body.innerHTML += `
                    <tr>
                        <td class="no-print" data-select-col="deliveryNotes" style="display:none;">
                            <input type="checkbox" data-select-key="deliveryNotes" data-select-id="${t.id}" onchange="toggleRowSelection('deliveryNotes', ${t.id}, this.checked)">
                        </td>
                        <td>${t.date}</td>
                        <td>${escapeHtml(t.invNo)}</td>
                        <td>${escapeHtml(t.partyName)}</td>
                        <td style="white-space:normal; max-width:280px;">${itemList}${narrationHint}</td>
                        <td style="white-space:normal;">${transportHtml}</td>
                        <td style="font-weight:bold;">\u20B9${t.grandTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        <td class="no-print" style="display:flex; gap:6px;">
                            <button onclick="printInvoice(${t.id})" class="btn-success" style="padding:4px 10px; font-size:0.72rem;">Print</button>
                            <button onclick="openEditModal(${t.id})" style="padding:4px 10px; font-size:0.72rem; width:auto;">Edit</button>
                            <button onclick="deleteDeliveryNote(${t.id})" class="btn-danger" style="padding:4px 10px; font-size:0.72rem;">Delete</button>
                        </td>
                    </tr>
                `;
            });
        }
        document.getElementById('dnCount').innerText = rows.length;
    }

    async function deleteDeliveryNote(txnId) {
        if (!isAdmin() && !hasPermission('deleteVoucher')) return alert("Only an admin, or a user with 'Delete a voucher' turned on, can delete a voucher.");
        const t = transactions.find(x => x.id == txnId);
        if (!t) return;
        if (!(await confirmAsync(`Delete delivery note ${t.invNo}?`))) return;
        logAudit('Deleted', t);
        transactions = transactions.filter(x => x.id != txnId);
        renumberSeriesAfterDelete(t);
        localStorage.setItem('tally_mob_db', JSON.stringify(transactions));
        syncCloud();
        renderDeliveryNotes();
        render();
    }

    // Universal delete: routes to whichever specific delete function a
    // voucher type actually needs (each one reverses its own stock/ledger
    // effect correctly), then refreshes any ledger statement or report
    // that happens to be open so nothing shows stale figures afterward.
    async function deleteVoucherSmart(txnId) {
        const txn = transactions.find(t => t.id == txnId);
        if (!txn) return;

        if (txn.deliveryNote) {
            await deleteDeliveryNote(txnId);
        } else if (txn.conversion) {
            await deleteConversion(txnId);
        } else if (txn.optional) {
            await deleteOptional(txnId);
        } else {
            await deleteTransaction(txnId);
        }

        // deleteTransaction() blanks the ledger view as a safety default.
        // Only redraw it in place if the Party Ledger panel is genuinely
        // the one the person is looking at right now — otherwise
        // openLedgerStatement()'s own "jump to panelLedger if not already
        // there" behavior would yank them away from whatever report
        // (e.g. Purchase Report) they actually deleted from.
        const stillExists = transactions.some(t => t.id == txnId);
        const ledgerIsActive = document.getElementById('panelLedger').classList.contains('active');
        if (!stillExists && lastLedger && ledgerIsActive) {
            openLedgerStatement(lastLedger.kind, lastLedger.id);
        }
        // Keep whichever report panel is actually open current.
        const openPanelEl = document.querySelector('.panel.active');
        if (openPanelEl) {
            if (openPanelEl.id === 'panelSalesStatement' && typeof renderSalesStatement === 'function') renderSalesStatement();
            if (openPanelEl.id === 'panelPurchaseReport' && typeof renderPurchaseReport === 'function') renderPurchaseReport();
            if (openPanelEl.id === 'panelPendingReceivable' && typeof renderPendingReceivable === 'function') renderPendingReceivable();
            if (openPanelEl.id === 'panelPendingPayable' && typeof renderPendingPayable === 'function') renderPendingPayable();
            if (openPanelEl.id === 'panelGstLiability' && typeof renderGstLiability === 'function') renderGstLiability();
            if (openPanelEl.id === 'panelInvoiceGapCheck' && typeof renderInvoiceGapCheck === 'function') renderInvoiceGapCheck();
        }
    }

    // ================================================================
    // RAW PURCHASE ENTRY (seed processing plant: buying raw seed, usually
    // in Quintals). Posts a normal Purchase voucher — same stock increase,
    // vendor ledger, and GST handling as the main voucher screen — just
    // through a faster, dedicated form. Items bought here are flagged
    // rawMaterial so the Conversion screen's "Raw Item" dropdown can find them.
    // ================================================================
    function populateRawPurchaseDropdowns() {
        const pSel = document.getElementById('rpParty');
        pSel.innerHTML = '<option value="">-- Choose Vendor --</option>';
        parties.forEach(p => pSel.innerHTML += `<option value="${p.id}">${escapeHtml(p.name)} (${p.type})</option>`);

        const iSel = document.getElementById('rpItem');
        iSel.innerHTML = '<option value="">-- Select Raw Item --</option>';
        stockItems.filter(i => i.rawMaterial).forEach(i =>
            iSel.innerHTML += `<option value="${i.id}">${escapeHtml(i.name)} (Stock: ${i.qty} ${escapeHtml(i.uom)})</option>`
        );
    }

    function autoFillRawItem() {
        const id = document.getElementById('rpItem').value;
        const item = stockItems.find(s => s.id == id);
        document.getElementById('rpRate').value = item ? item.rate : '';
        recomputeRawPurchaseTotal();
    }

    async function quickAddRawItem() {
        const name = document.getElementById('rpItemQuickName').value.trim();
        if (!name) return alert("Enter the raw item's name first.");
        const hsn = document.getElementById('rpItemQuickHsn').value.trim();

        const normalizedNewRawItem = normalizeNameForDupCheck(name);
        const similarRawItem = stockItems.find(s => normalizeNameForDupCheck(s.name) === normalizedNewRawItem);
        if (similarRawItem) {
            const proceed = await confirmAsync(`A stock item named "${similarRawItem.name}" already exists.\n\nAdd "${name}" anyway as a separate item?`);
            if (!proceed) return;
        }

        const newItem = {
            id: newId(stockItems),
            name: name,
            groupId: null,
            hsn: hsn,
            uom: 'Quintal',
            qty: 0,
            openingQty: 0,
            rate: 0,
            gstRate: 5,
            rawMaterial: true
        };
        stockItems.push(newItem);
        localStorage.setItem('tally_mob_stock', JSON.stringify(stockItems));
        syncCloud();

        populateRawPurchaseDropdowns();
        document.getElementById('rpItem').value = newItem.id;
        document.getElementById('rpItemQuickName').value = '';
        document.getElementById('rpItemQuickHsn').value = '';
        document.getElementById('rpItemQuickAdd').classList.remove('active');
        render();
    }

    function onRpUnitChange() {
        const unit = document.getElementById('rpUnit').value;
        document.getElementById('rpRateLabel').innerText = `Rate / ${unit === 'Bags' ? 'Bag' : 'Quintal'} (\u20B9 Incl. GST)`;
    }

    function recomputeRawPurchaseTotal() {
        const itemId = document.getElementById('rpItem').value;
        const item = stockItems.find(s => s.id == itemId);
        const qty = parseFloat(document.getElementById('rpQty').value) || 0;
        const rate = parseFloat(document.getElementById('rpRate').value) || 0;
        const taxType = document.getElementById('rpTaxType').value;
        const mode = (taxType === 'EXEMPT') ? 'EXEMPT' : 'INCL';
        const gstRate = item ? item.gstRate : 0;
        const res = calculateLine(rate, qty, gstRate, mode);
        document.getElementById('rpTotalDisplay').innerText = `\u20B9${res.lineTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
        return res;
    }
    document.getElementById('rpQty').addEventListener('input', recomputeRawPurchaseTotal);
    document.getElementById('rpRate').addEventListener('input', recomputeRawPurchaseTotal);
    document.getElementById('rpTaxType').addEventListener('change', recomputeRawPurchaseTotal);

    document.getElementById('rawPurchaseForm').addEventListener('submit', (e) => {
        e.preventDefault();
        if (!isAdmin() && !hasPermission('postVouchers')) return alert("Only an admin, or a user with 'Post new vouchers' turned on, can post a voucher.");
        const partyId = document.getElementById('rpParty').value;
        const itemId = document.getElementById('rpItem').value;
        const qty = parseFloat(document.getElementById('rpQty').value);
        const rate = parseFloat(document.getElementById('rpRate').value);
        const purchaseUnit = document.getElementById('rpUnit').value; // 'Quintal' or 'Bags' — as entered this purchase, no conversion applied
        if (!partyId) return alert("Please choose a vendor.");
        if (!itemId) return alert("Please select the raw item being purchased.");
        if (isNaN(qty) || qty <= 0) return alert("Enter a valid quantity.");
        if (isNaN(rate) || rate < 0) return alert("Enter a valid rate.");

        const partyObj = parties.find(p => p.id == partyId);
        const item = stockItems.find(s => s.id == itemId);
        const taxType = document.getElementById('rpTaxType').value;
        const mode = (taxType === 'EXEMPT') ? 'EXEMPT' : 'INCL';
        const res = calculateLine(rate, qty, item.gstRate, mode);

        // Raw Purchase increases stock, same as a normal Purchase — it's
        // just tagged as its own voucher type so it's tracked separately
        // from the main Purchase/GST totals (Raw Purchase Report instead).
        item.qty += qty;
        item.rawMaterial = true;
        localStorage.setItem('tally_mob_stock', JSON.stringify(stockItems));
        syncCloud();

        const txn = {
            id: newId(transactions),
            invNo: nextVoucherNo('RawPurchase', 'RPUR', null, document.getElementById('rpDate').value),
            date: document.getElementById('rpDate').value,
            type: 'RawPurchase',
            rawPurchase: true,
            taxType: taxType,
            rateMode: mode,
            subLedger: '',
            partyId: partyObj.id,
            partyName: partyObj.name,
            items: [{
                itemId: item.id, name: item.name, hsn: item.hsn, uom: purchaseUnit,
                qty: qty, inclRate: rate, gstRate: item.gstRate,
                taxable: res.taxable, taxAmount: res.taxAmount, lineTotal: res.lineTotal
            }],
            taxable: res.taxable,
            totalTax: res.taxAmount,
            grandTotal: res.lineTotal,
            narration: document.getElementById('rpNarration').value.trim()
        };
        transactions.push(txn);
        localStorage.setItem('tally_mob_db', JSON.stringify(transactions));
        syncCloud();

        e.target.reset();
        document.getElementById('rpDate').valueAsDate = new Date();
        document.getElementById('rpTotalDisplay').innerText = '\u20B90.00';
        onRpUnitChange(); // reset the rate label back to Quintal, matching the form reset
        populateRawPurchaseDropdowns();
        render();
        showSyncToast('ok', `Raw purchase posted \u2022 ${qty} ${purchaseUnit} of ${item.name} \u2022 ${txn.invNo}`);
    });

    // ================================================================
    // STOCK CONVERSION (raw seed -> processed bags). Reduces the raw
    // item's stock by the quantity consumed, increases the processed
    // item's stock by whatever quantity was actually produced (entered
    // manually, since real output varies with moisture/wastage). Recorded
    // as its own transaction type so it can be reported on separately and
    // never gets mixed into Sales/Purchase totals, GST, or party ledgers.
    // ================================================================
    function populateConversionDropdowns() {
        const rawSel = document.getElementById('cvRawItem');
        const prevRaw = rawSel.value;
        rawSel.innerHTML = '<option value="">-- Select Raw Item --</option>';
        stockItems.filter(i => i.rawMaterial).forEach(i =>
            rawSel.innerHTML += `<option value="${i.id}">${escapeHtml(i.name)} (Available: ${i.qty} ${escapeHtml(i.uom)})</option>`
        );
        if (prevRaw) rawSel.value = prevRaw;

        const procSel = document.getElementById('cvProcessedItem');
        const prevProc = procSel.value;
        procSel.innerHTML = '<option value="">-- Select Processed Item --</option>';
        stockItems.filter(i => i.processedGood).forEach(i =>
            procSel.innerHTML += `<option value="${i.id}">${escapeHtml(i.name)} (Stock: ${i.qty} ${escapeHtml(i.uom)})</option>`
        );
        if (prevProc) procSel.value = prevProc;

        updateConversionAvailability();
    }

    function onConversionRawChange() {
        updateConversionAvailability();
    }

    function updateConversionAvailability() {
        const rawId = document.getElementById('cvRawItem').value;
        const item = stockItems.find(s => s.id == rawId);
        const note = document.getElementById('cvRawAvailability');
        if (!item) { note.innerText = ''; return; }
        const qty = parseFloat(document.getElementById('cvRawQty').value) || 0;
        const remaining = item.qty - qty;
        note.innerHTML = `Available: <strong>${item.qty} ${escapeHtml(item.uom)}</strong>`
            + (qty > 0 ? ` &rarr; remaining after this conversion: <strong style="color:${remaining < 0 ? 'var(--danger)' : 'var(--accent)'};">${remaining} ${escapeHtml(item.uom)}</strong>` : '');
    }

    function quickAddProcessedItem() {
        const name = document.getElementById('cvProcessedQuickName').value.trim();
        if (!name) return alert("Enter the processed item's name first.");
        const hsn = document.getElementById('cvProcessedQuickHsn').value.trim();
        const uom = document.getElementById('cvProcessedQuickUom').value.trim() || 'Bag';
        const newItem = {
            id: newId(stockItems),
            name: name,
            groupId: null,
            hsn: hsn,
            uom: uom,
            qty: 0,
            openingQty: 0,
            rate: 0,
            gstRate: 5,
            processedGood: true
        };
        stockItems.push(newItem);
        localStorage.setItem('tally_mob_stock', JSON.stringify(stockItems));
        syncCloud();

        populateConversionDropdowns();
        document.getElementById('cvProcessedItem').value = newItem.id;
        document.getElementById('cvProcessedQuickName').value = '';
        document.getElementById('cvProcessedQuickHsn').value = '';
        document.getElementById('cvProcessedQuickUom').value = '';
        document.getElementById('cvProcessedQuickAdd').classList.remove('active');
        render();
    }

    document.getElementById('conversionForm').addEventListener('submit', (e) => {
        e.preventDefault();
        if (!isAdmin() && !hasPermission('postVouchers')) return alert("Only an admin, or a user with 'Post new vouchers' turned on, can post a voucher.");
        const rawId = document.getElementById('cvRawItem').value;
        const procId = document.getElementById('cvProcessedItem').value;
        const rawQty = parseFloat(document.getElementById('cvRawQty').value);
        const outQty = parseFloat(document.getElementById('cvOutQty').value);

        if (!rawId) return alert("Please select the raw item being consumed.");
        if (!procId) return alert("Please select the processed item being produced.");
        if (isNaN(rawQty) || rawQty <= 0) return alert("Enter a valid quantity consumed.");
        if (isNaN(outQty) || outQty <= 0) return alert("Enter a valid quantity produced.");

        const rawItem = stockItems.find(s => s.id == rawId);
        const procItem = stockItems.find(s => s.id == procId);
        if (!rawItem || !procItem) return alert("Selected item no longer exists.");
        if (rawItem.qty < rawQty) {
            return alert(`Not enough raw stock: only ${rawItem.qty} ${rawItem.uom} of ${rawItem.name} available.`);
        }

        rawItem.qty -= rawQty;
        procItem.qty += outQty;
        localStorage.setItem('tally_mob_stock', JSON.stringify(stockItems));
        syncCloud();

        const conv = {
            id: newId(transactions),
            invNo: nextVoucherNo('Conversion', 'CONV', null, document.getElementById('cvDate').value),
            date: document.getElementById('cvDate').value,
            type: 'Conversion',
            conversion: true,
            rawItemId: rawItem.id,
            rawItemName: rawItem.name,
            rawUom: rawItem.uom,
            rawQty: rawQty,
            processedItemId: procItem.id,
            processedItemName: procItem.name,
            processedUom: procItem.uom,
            outQty: outQty,
            notes: document.getElementById('cvNotes').value.trim(),
            // Kept for compatibility with anywhere the code expects a
            // grandTotal/partyId/items shape on a generic "transaction".
            partyId: null,
            partyName: '',
            items: [],
            taxable: 0,
            totalTax: 0,
            grandTotal: 0
        };
        transactions.push(conv);
        localStorage.setItem('tally_mob_db', JSON.stringify(transactions));
        syncCloud();

        e.target.reset();
        document.getElementById('cvDate').valueAsDate = new Date();
        populateConversionDropdowns();
        render();
        showSyncToast('ok', `Conversion posted \u2022 ${rawQty} ${rawItem.uom} of ${rawItem.name} \u2192 ${outQty} ${procItem.uom} of ${procItem.name}`);
    });

    async function deleteConversion(convId) {
        if (!isAdmin() && !hasPermission('deleteVoucher')) return alert("Only an admin, or a user with 'Delete a voucher' turned on, can delete a voucher.");
        const conv = transactions.find(t => t.id == convId);
        if (!conv) return;
        if (!(await confirmAsync(`Delete conversion ${conv.invNo}? This will reverse the stock movement (raw stock restored, processed stock reduced).`))) return;
        logAudit('Deleted', conv);

        const rawItem = stockItems.find(s => s.id == conv.rawItemId);
        const procItem = stockItems.find(s => s.id == conv.processedItemId);
        if (rawItem) rawItem.qty += conv.rawQty;
        if (procItem) {
            if (procItem.qty < conv.outQty) {
                return alert(`Cannot delete: ${procItem.name} only has ${procItem.qty} ${procItem.uom} left, but this conversion produced ${conv.outQty}. Some of that stock has already been sold/used elsewhere.`);
            }
            procItem.qty -= conv.outQty;
        }
        localStorage.setItem('tally_mob_stock', JSON.stringify(stockItems));
        syncCloud();

        transactions = transactions.filter(t => t.id != convId);
        renumberSeriesAfterDelete(conv);
        localStorage.setItem('tally_mob_db', JSON.stringify(transactions));
        syncCloud();

        renderProcessedReport();
        render();
    }

    // ---- Processed Report ----
    function onPrPeriodChange() {
        const sel = document.getElementById('prPeriod').value;
        document.getElementById('prCustomWrap').style.display = (sel === 'custom') ? 'block' : 'none';
        renderProcessedReport();
    }

    function renderProcessedReport() {
        const range = periodRange(document.getElementById('prPeriod').value,
                                  document.getElementById('prFrom').value,
                                  document.getElementById('prTo').value);
        const rows = sortByDate(
            transactions.filter(t => t.conversion && inRange(t.date, range)),
            'processedReport'
        );

        const body = document.getElementById('processedReportBody');
        body.innerHTML = '';
        let rawTotal = 0, outTotal = 0;

        if (rows.length === 0) {
            body.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">No conversions in this period.</td></tr>';
        } else {
            rows.forEach(t => {
                rawTotal += t.rawQty;
                outTotal += t.outQty;
                body.innerHTML += `
                    <tr>
                        <td>${t.date}</td>
                        <td>${escapeHtml(t.rawItemName)}</td>
                        <td style="color:var(--pink); font-weight:bold;">-${t.rawQty} ${escapeHtml(t.rawUom)}</td>
                        <td>${escapeHtml(t.processedItemName)}</td>
                        <td style="color:var(--success); font-weight:bold;">+${t.outQty} ${escapeHtml(t.processedUom)}</td>
                        <td style="color:var(--text-muted);">${escapeHtml(t.notes || '-')}</td>
                        <td><button onclick="deleteConversion(${t.id})" class="btn-danger" style="padding:4px 10px; font-size:0.72rem;">Delete</button></td>
                    </tr>
                `;
            });
        }

        document.getElementById('prRawTotal').innerText = rawTotal.toLocaleString('en-IN');
        document.getElementById('prOutTotal').innerText = outTotal.toLocaleString('en-IN');
        document.getElementById('prCount').innerText = rows.length;

        // Processed stock on hand summary (all-time produced vs current stock)
        const stockBody = document.getElementById('processedStockBody');
        stockBody.innerHTML = '';
        const processedItems = stockItems.filter(i => i.processedGood);
        if (processedItems.length === 0) {
            stockBody.innerHTML = '<tr><td colspan="3" style="text-align:center; color:var(--text-muted);">No processed items yet. Create one from Stock Conversion.</td></tr>';
        } else {
            processedItems.forEach(i => {
                const totalProduced = transactions
                    .filter(t => t.conversion && t.processedItemId == i.id)
                    .reduce((a, c) => a + c.outQty, 0);
                stockBody.innerHTML += `
                    <tr>
                        <td><strong>${escapeHtml(i.name)}</strong></td>
                        <td style="color:${i.qty < 5 ? 'var(--danger)' : 'var(--success)'}; font-weight:bold;">${i.qty} ${escapeHtml(i.uom)}</td>
                        <td>${totalProduced} ${escapeHtml(i.uom)}</td>
                    </tr>
                `;
            });
        }
    }

    // ---- Raw Purchase Report ----
    function onRprPeriodChange() {
        const sel = document.getElementById('rprPeriod').value;
        document.getElementById('rprCustomWrap').style.display = (sel === 'custom') ? 'block' : 'none';
        renderRawPurchaseReport();
    }

    function populateRawVarietyFilter() {
        const sel = document.getElementById('rprVariety');
        const prev = sel.value;
        sel.innerHTML = '<option value="">All Varieties</option>';
        stockItems.filter(i => i.rawMaterial).forEach(i => {
            sel.innerHTML += `<option value="${i.id}">${escapeHtml(i.name)}</option>`;
        });
        if (prev) sel.value = prev;
    }

    let rawPurchaseReportRowOrder = [];
    function renderRawPurchaseReport() {
        clearSelection('rawPurchaseReport');
        populateRawVarietyFilter();

        const range = periodRange(document.getElementById('rprPeriod').value,
                                  document.getElementById('rprFrom').value,
                                  document.getElementById('rprTo').value);
        const varietyId = document.getElementById('rprVariety').value;

        const rows = sortByDate(transactions
            .filter(t => t.type === 'RawPurchase' && inRange(t.date, range))
            .filter(t => !varietyId || (t.items[0] && t.items[0].itemId == varietyId)), 'rawPurchaseReport');

        const body = document.getElementById('rawPurchaseReportBody');
        body.innerHTML = '';
        let qtyTotal = 0, valueTotal = 0;

        if (rows.length === 0) {
            body.innerHTML = '<tr><td colspan="9" style="text-align:center; color:var(--text-muted);">No raw purchases in this period.</td></tr>';
        } else {
            rawPurchaseReportRowOrder = rows.map(t => t.id);
            rows.forEach(t => {
                const line = t.items[0] || {};
                qtyTotal += line.qty || 0;
                valueTotal += t.grandTotal;
                body.innerHTML += `
                    <tr style="cursor:pointer;" title="Open invoice">
                        <td class="no-print" data-select-col="rawPurchaseReport" style="display:none;" onclick="event.stopPropagation();">
                            <input type="checkbox" data-select-key="rawPurchaseReport" data-select-id="${t.id}" onchange="toggleRowSelection('rawPurchaseReport', ${t.id}, this.checked)">
                        </td>
                        <td onclick="printInvoice(${t.id})">${t.date}</td>
                        <td onclick="printInvoice(${t.id})">${escapeHtml(t.invNo)}</td>
                        <td style="color:var(--accent); text-decoration:underline;" onclick="event.stopPropagation(); openPartyLedgerFromReport(${t.partyId})" title="Open vendor ledger">${escapeHtml(t.partyName)}</td>
                        <td onclick="printInvoice(${t.id})">${escapeHtml(line.name || '-')}</td>
                        <td onclick="printInvoice(${t.id})">${line.qty || 0} ${escapeHtml(line.uom || '')}</td>
                        <td onclick="printInvoice(${t.id})">\u20B9${(line.inclRate || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        <td onclick="printInvoice(${t.id})" style="font-weight:bold;">\u20B9${t.grandTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    </tr>
                `;
            });
        }

        document.getElementById('rprQtyTotal').innerText = qtyTotal.toLocaleString('en-IN');
        document.getElementById('rprValueTotal').innerText = `\u20B9${valueTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
        document.getElementById('rprCount').innerText = rows.length;

        // Current raw stock on hand, per variety: purchased vs converted vs in stock
        const stockBody = document.getElementById('rawStockBody');
        stockBody.innerHTML = '';
        const rawItems = stockItems.filter(i => i.rawMaterial);
        if (rawItems.length === 0) {
            stockBody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">No raw varieties yet. Create one from Raw Purchase Entry.</td></tr>';
        } else {
            rawItems.forEach(i => {
                const totalPurchased = transactions
                    .filter(t => t.type === 'RawPurchase' && t.items[0] && t.items[0].itemId == i.id)
                    .reduce((a, c) => a + c.items[0].qty, 0);
                const totalConverted = transactions
                    .filter(t => t.conversion && t.rawItemId == i.id)
                    .reduce((a, c) => a + c.rawQty, 0);
                stockBody.innerHTML += `
                    <tr>
                        <td><strong>${escapeHtml(i.name)}</strong></td>
                        <td style="color:${i.qty < 5 ? 'var(--danger)' : 'var(--success)'}; font-weight:bold;">${i.qty} ${escapeHtml(i.uom)}</td>
                        <td>${totalPurchased} ${escapeHtml(i.uom)}</td>
                        <td>${totalConverted} ${escapeHtml(i.uom)}</td>
                    </tr>
                `;
            });
        }
    }


    document.getElementById('voucherTypeForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const editId = document.getElementById('vtEditId').value;
        const name = document.getElementById('vtName').value.trim();
        const prefix = document.getElementById('vtPrefix').value.trim().toUpperCase();
        if (!name) return alert("Please enter a name for this voucher type.");
        if (!prefix) return alert("Please enter a voucher number prefix.");

        const data = {
            name: name,
            stockEffect: document.getElementById('vtStockEffect').value,
            gst: document.getElementById('vtGst').value,
            ledgerEffect: document.getElementById('vtLedgerEffect').value,
            requiresParty: document.getElementById('vtRequiresParty').value,
            usesCategory: document.getElementById('vtUsesCategory').value,
            prefix: prefix,
            inMainBooks: document.getElementById('vtInMainBooks').value
        };

        if (editId) {
            const vt = customVoucherTypes.find(v => v.id === editId);
            if (vt) Object.assign(vt, data);
        } else {
            // The internal id is a stable slug derived from the name, used as
            // the <option value> in the Voucher Type dropdown and stored on
            // every transaction posted under this type.
            let slug = 'CT_' + name.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
            if (customVoucherTypes.some(v => v.id === slug)) slug += '_' + Date.now();
            customVoucherTypes.push({ id: slug, ...data });
        }
        localStorage.setItem('tally_mob_vouchertypes', JSON.stringify(customVoucherTypes));
        syncCloud();
        cancelVoucherTypeEdit();
        populateCustomVoucherTypeOptions();
        renderVoucherTypes();
    });

    function editVoucherType(id) {
        const vt = customVoucherTypes.find(v => v.id === id);
        if (!vt) return;
        document.getElementById('vtEditId').value = vt.id;
        document.getElementById('vtName').value = vt.name;
        document.getElementById('vtStockEffect').value = vt.stockEffect;
        document.getElementById('vtGst').value = vt.gst;
        document.getElementById('vtLedgerEffect').value = vt.ledgerEffect;
        document.getElementById('vtRequiresParty').value = vt.requiresParty || 'yes'; // older types created before this option existed still require a party, unchanged
        document.getElementById('vtUsesCategory').value = vt.usesCategory || 'no';
        document.getElementById('vtPrefix').value = vt.prefix;
        document.getElementById('vtInMainBooks').value = vt.inMainBooks;
        document.getElementById('vtPanelTitle').innerText = 'Edit Voucher Type';
        document.getElementById('vtSubmitBtn').innerText = 'Save Changes';
        document.getElementById('vtCancelBtn').style.display = 'block';
    }

    function cancelVoucherTypeEdit() {
        document.getElementById('voucherTypeForm').reset();
        document.getElementById('vtEditId').value = '';
        document.getElementById('vtPanelTitle').innerText = 'Voucher Types';
        document.getElementById('vtSubmitBtn').innerText = 'Create Voucher Type';
        document.getElementById('vtCancelBtn').style.display = 'none';
    }

    async function deleteVoucherType(id) {
        const used = transactions.some(t => t.customVoucherTypeId === id);
        if (used) return alert("Cannot delete a voucher type that already has entries posted under it.");
        const vt = customVoucherTypes.find(v => v.id === id);
        if (vt && await confirmAsync(`Delete voucher type "${vt.name}"?`)) {
            customVoucherTypes = customVoucherTypes.filter(v => v.id !== id);
            localStorage.setItem('tally_mob_vouchertypes', JSON.stringify(customVoucherTypes));
            syncCloud();
            populateCustomVoucherTypeOptions();
            renderVoucherTypes();
        }
    }

    // Keep the Post Voucher "Type" dropdown's custom optgroup in sync.
    function populateCustomVoucherTypeOptions() {
        const grp = document.getElementById('customTypeOptgroup');
        if (!grp) return;
        grp.innerHTML = '';
        customVoucherTypes.forEach(vt => {
            grp.innerHTML += `<option value="${vt.id}">${escapeHtml(vt.name)}</option>`;
        });
    }

    function stockEffectLabel(v) { return v === 'out' ? 'Reduces' : v === 'in' ? 'Increases' : 'None'; }
    function ledgerEffectLabel(v) { return v === 'debit' ? 'Debit' : v === 'credit' ? 'Credit' : 'None'; }

    function renderVoucherTypes() {
        const body = document.getElementById('voucherTypesBody');
        body.innerHTML = '';
        if (customVoucherTypes.length === 0) {
            body.innerHTML = '<tr><td colspan="9" style="text-align:center; color:var(--text-muted);">No custom voucher types yet. Create one above.</td></tr>';
            return;
        }
        customVoucherTypes.forEach(vt => {
            const count = transactions.filter(t => t.customVoucherTypeId === vt.id).length;
            const requiresParty = vt.requiresParty !== 'no'; // defaults to required, matching older types
            body.innerHTML += `
                <tr style="cursor:pointer;" onclick="openCustomVoucherList('${vt.id}')" title="View entries for this voucher type">
                    <td><strong>${escapeHtml(vt.name)}</strong> <span style="color:var(--text-muted); font-size:0.72rem;">(${count})</span></td>
                    <td>${stockEffectLabel(vt.stockEffect)}</td>
                    <td>${vt.gst === 'no' ? 'Nil GST' : 'Applicable'}</td>
                    <td>${ledgerEffectLabel(vt.ledgerEffect)}</td>
                    <td>${requiresParty ? 'Yes' : 'No'}</td>
                    <td>${vt.usesCategory === 'yes' ? 'Yes' : 'No'}</td>
                    <td>${escapeHtml(vt.prefix)}</td>
                    <td>${vt.inMainBooks === 'no' ? 'Off-book' : 'Yes'}</td>
                    <td style="display:flex; gap:6px;">
                        <button onclick="event.stopPropagation(); editVoucherType('${vt.id}')" style="padding:4px 10px; font-size:0.75rem; width:auto;">Edit</button>
                        <button onclick="event.stopPropagation(); deleteVoucherType('${vt.id}')" class="btn-danger" style="padding:4px 10px; font-size:0.75rem;">Delete</button>
                    </td>
                </tr>
            `;
        });
    }

    // ---- Entries posted under a specific custom voucher type ----
    let currentCustomTypeId = null;

    function openCustomVoucherList(typeId) {
        currentCustomTypeId = typeId;
        clearSelection('customVoucherList');
        const vt = customVoucherTypes.find(v => v.id === typeId);
        document.getElementById('cvListTitle').innerText = vt ? `${vt.name} — Entries` : 'Voucher Entries';
        openPanel('panelCustomVoucherList');
        renderCustomVoucherList();
    }

    function onCvPeriodChange() {
        const sel = document.getElementById('cvPeriod').value;
        document.getElementById('cvCustomWrap').style.display = (sel === 'custom') ? 'block' : 'none';
        renderCustomVoucherList();
    }

    let customVoucherListRowOrder = [];
    function renderCustomVoucherList() {
        if (!currentCustomTypeId) return;
        const range = periodRange(document.getElementById('cvPeriod').value,
                                  document.getElementById('cvFrom').value,
                                  document.getElementById('cvTo').value);
        const rows = sortByDate(
            transactions.filter(t => t.customVoucherTypeId === currentCustomTypeId && inRange(t.date, range)),
            'customVoucherList'
        );

        const body = document.getElementById('customVoucherListBody');
        body.innerHTML = '';
        if (rows.length === 0) {
            body.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">No entries in this period.</td></tr>';
            customVoucherListRowOrder = [];
            return;
        }
        customVoucherListRowOrder = rows.map(t => t.id);
        rows.forEach(t => {
            const itemList = (t.items || []).map(it => `${escapeHtml(it.name)} (${it.qty} ${escapeHtml(it.uom)})`).join(', ');
            body.innerHTML += `
                <tr>
                    <td class="no-print" data-select-col="customVoucherList" style="display:none;">
                        <input type="checkbox" data-select-key="customVoucherList" data-select-id="${t.id}" onchange="toggleRowSelection('customVoucherList', ${t.id}, this.checked)">
                    </td>
                    <td>${t.date}</td>
                    <td>${escapeHtml(t.invNo)}</td>
                    <td style="color:var(--accent); text-decoration:underline; cursor:pointer;" onclick="openPartyLedgerFromReport(${t.partyId})" title="Open party ledger">${escapeHtml(t.partyName)}</td>
                    <td style="white-space:normal; max-width:280px;">${itemList}</td>
                    <td style="font-weight:bold;">\u20B9${t.grandTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    <td style="display:flex; gap:6px;">
                        <button onclick="printInvoice(${t.id})" class="btn-success" style="padding:4px 10px; font-size:0.72rem;">Invoice</button>
                        <button onclick="openEditModal(${t.id})" style="padding:4px 10px; font-size:0.72rem; width:auto;">Edit</button>
                        <button onclick="deleteTransaction(${t.id})" class="btn-danger" style="padding:4px 10px; font-size:0.72rem;">Delete</button>
                    </td>
                </tr>
            `;
        });
    }

    let optionalVouchersRowOrder = [];
    function renderOptional() {
        clearSelection('optionalVouchers');
        const optTxns = sortByDate(transactions.filter(t => t.optional), 'optionalVouchers');
        const body = document.getElementById('optionalBody');
        body.innerHTML = '';

        let salesTotal = 0, purchTotal = 0;
        optTxns.forEach(t => {
            if (t.type === 'OptionalSales') salesTotal += t.grandTotal;
            else purchTotal += t.grandTotal;
        });

        if (optTxns.length === 0) {
            body.innerHTML = '<tr><td colspan="8" style="text-align:center; color:var(--text-muted);">No optional vouchers yet. Post one from the voucher screen using "Optional Sale" / "Optional Purchase".</td></tr>';
        } else {
            optionalVouchersRowOrder = optTxns.map(t => t.id);
            optTxns.forEach(t => {
                const label = t.type === 'OptionalSales' ? 'Optional Sale' : 'Optional Purchase';
                const color = t.type === 'OptionalSales' ? 'var(--success)' : 'var(--pink)';
                // main summary row (click to open invoice)
                body.innerHTML += `
                    <tr>
                        <td class="no-print" data-select-col="optionalVouchers" style="display:none;">
                            <input type="checkbox" data-select-key="optionalVouchers" data-select-id="${t.id}" onchange="toggleRowSelection('optionalVouchers', ${t.id}, this.checked)">
                        </td>
                        <td>${t.date}</td>
                        <td style="color:${color}; font-weight:bold;">${label}</td>
                        <td>${escapeHtml(t.invNo)}</td>
                        <td style="color:var(--accent); text-decoration:underline; cursor:pointer;" onclick="openPartyLedgerFromReport(${t.partyId})" title="Open party ledger">${escapeHtml(t.partyName)}</td>
                        <td><button onclick="toggleOptItems(${t.id})" style="width:auto; padding:3px 10px; font-size:0.72rem; background:rgba(139,124,255,0.2); color:var(--text-main);">${t.items.length} item(s) &#9662;</button></td>
                        <td style="font-weight:bold;">\u20B9${t.grandTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        <td style="display:flex; gap:6px;"><button onclick="printInvoice(${t.id})" class="btn-success" style="padding:4px 10px; font-size:0.72rem;">Invoice</button><button onclick="openEditModal(${t.id})" style="padding:4px 10px; font-size:0.72rem; width:auto;">Edit</button><button onclick="deleteOptional(${t.id})" class="btn-danger" style="padding:4px 10px; font-size:0.72rem;">Delete</button></td>
                    </tr>
                `;
                // hidden inventory detail row
                let itemRows = t.items.map(it =>
                    `<div style="display:flex; justify-content:space-between; padding:3px 0; border-bottom:1px dashed var(--border);">
                        <span>${escapeHtml(it.name || 'Item')} <span style="color:var(--text-muted);">(${escapeHtml(it.hsn || '')})</span></span>
                        <span>${it.qty || 0} ${escapeHtml(it.uom || '')} &times; \u20B9${(typeof it.inclRate === 'number' ? it.inclRate : 0).toLocaleString('en-IN', {minimumFractionDigits: 2})} = <strong>\u20B9${(typeof it.lineTotal === 'number' ? it.lineTotal : 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</strong></span>
                    </div>`
                ).join('');
                if (t.narration) {
                    itemRows += `<div style="padding:6px 0 0; color:var(--text-muted); font-style:italic; font-size:0.78rem;">Narration: ${escapeHtml(t.narration)}</div>`;
                }
                body.innerHTML += `
                    <tr id="optItems-${t.id}" style="display:none; background:rgba(139,124,255,0.05);">
                        <td colspan="8" style="font-size:0.8rem;">
                            <div style="font-weight:600; color:var(--accent); margin-bottom:4px;">Inventory in this voucher</div>
                            ${itemRows}
                        </td>
                    </tr>
                `;
            });
        }

        document.getElementById('optSalesTotal').innerText = `\u20B9${salesTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
        document.getElementById('optPurchTotal').innerText = `\u20B9${purchTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
        document.getElementById('optCount').innerText = optTxns.length;
    }

    function toggleOptItems(txnId) {
        const row = document.getElementById('optItems-' + txnId);
        if (row) row.style.display = (row.style.display === 'none') ? 'table-row' : 'none';
    }

    async function deleteOptional(txnId) {
        if (!isAdmin() && !hasPermission('deleteVoucher')) return alert("Only an admin, or a user with 'Delete a voucher' turned on, can delete a voucher.");
        const txn = transactions.find(t => t.id == txnId);
        if (!txn) return;
        if (!(await confirmAsync(`Delete optional voucher ${txn.invNo}?`))) return;
        logAudit('Deleted', txn);
        transactions = transactions.filter(t => t.id != txnId);
        renumberSeriesAfterDelete(txn);
        localStorage.setItem('tally_mob_db', JSON.stringify(transactions));
        syncCloud();
        renderOptional();
        render();
    }

    // Builds one invoice's printable HTML as a string, for the batch-print
    // job below. Deliberately reuses printInvoice() itself (the exact same
    // function a single-invoice view uses) rather than re-implementing its
    // layout logic — this guarantees a batch-printed invoice always looks
    // identical to printing that same invoice on its own, and never drifts
    // out of sync if printInvoice's rendering changes later.
    function buildInvoiceHtml(txnId) {
        const txn = transactions.find(t => t.id == txnId);
        if (!txn) return null;
        suppressInvoiceModalHistory = true;
        printInvoice(txnId); // populates the existing modal's DOM as usual
        suppressInvoiceModalHistory = false;
        const box = document.querySelector('#invoiceModal .invoice-box');
        if (!box) return null;
        const html = box.outerHTML;
        document.getElementById('invoiceModal').style.display = 'none';
        return html;
    }

    let currentPrintTxnId = null;
    // Batch PDF/print export (buildInvoiceHtml above) reuses this function
    // to render each invoice off-screen, without ever showing the modal to
    // the person — that pass shouldn't push a history entry, or the back
    // button would have to be pressed once per invoice in the batch.
    let suppressInvoiceModalHistory = false;
    function closeInvoiceModal() { history.back(); }
    function closeInvoiceModalUI() {
        document.getElementById('invoiceModal').style.display = 'none';
    }
    function printInvoice(txnId) {  
        const txn = transactions.find(t => t.id == txnId);  
        if (!txn) return;  
        currentPrintTxnId = txnId;
        const styleWrap = document.getElementById('invPrintStyleWrap');
        const styleSelect = document.getElementById('invPrintStyleSelect');
        const formalAvailable = (txn.type === 'Sales' || txn.type === 'Payment' || txn.type === 'Receipt');
        if (styleWrap) {
            styleWrap.style.display = formalAvailable ? 'flex' : 'none';
            if (styleSelect) styleSelect.value = 'classic'; // always reset — never silently remember Formal from a previous invoice
        }
        const isJournalTxn = (txn.type === 'Journal');
        const partyObj = isJournalTxn ? null : parties.find(p => p.id == txn.partyId);
        const isCash = (txn.type === 'Payment' || txn.type === 'Receipt' || isCustomNoPartyType(txn.type));
        const isOptional = !!txn.optional;
        const isDN = !!txn.deliveryNote;

        document.getElementById('invDocTitle').innerText = isJournalTxn
            ? 'JOURNAL VOUCHER'
            : isCash
            ? (txn.type === 'Receipt' ? 'RECEIPT VOUCHER' : (isCustomNoPartyType(txn.type) ? (txn.customVoucherTypeName || 'EXPENSE VOUCHER').toUpperCase() : 'PAYMENT VOUCHER'))
            : isDN
                ? 'DELIVERY NOTE'
            : isOptional
                ? (txn.type === 'OptionalSales' ? 'OPTIONAL SALE (OFF-BOOK)' : 'OPTIONAL PURCHASE (OFF-BOOK)')
            : txn.customVoucherTypeId
                ? (txn.customVoucherTypeName || 'CUSTOM VOUCHER').toUpperCase() + (txn.inMainBooks === false ? ' (OFF-BOOK)' : '')
                : 'TAX INVOICE';
        const rh = document.getElementById('invRateHead');
        if (rh) rh.innerText = (txn.rateMode === 'EXEMPT') ? 'Rate (Nil GST)' : 'Rate (Incl GST)';
        document.getElementById('invNo').innerText = txn.invNo;  
        // Every voucher's id is a Date.now() timestamp from when it was
        // created, so the creation time can be shown without needing a
        // separate stored field — works for vouchers created before this
        // was added too.
        const createdTime = txn.id ? new Date(Number(txn.id)).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '';
        document.getElementById('invDate').innerText = txn.date + (createdTime ? ` \u00B7 ${createdTime}` : '');  
        document.getElementById('invParty').innerText = isJournalTxn
            ? `Dr ${txn.journalDebit ? txn.journalDebit.name : 'Unknown'}  /  Cr ${txn.journalCredit ? txn.journalCredit.name : 'Unknown'}`
            : txn.partyName;
        // "Billed To" only makes sense for an invoice-style voucher — a
        // Payment/Receipt/expense voucher didn't bill anyone, it paid or
        // received money, and a Journal entry has no single counterparty.
        const partyLabel = document.getElementById('invPartyLabel');
        if (partyLabel) {
            partyLabel.innerText = isJournalTxn
                ? 'Entry:'
                : isCash
                    ? (txn.type === 'Receipt' ? 'Received From:' : 'Paid To:')
                    : 'Billed To:';
        }  
        document.getElementById('invAddress').innerText = partyObj && partyObj.address ? `Address: ${partyObj.address}` : '';
        document.getElementById('invGstin').innerText = partyObj && partyObj.gstin ? `GSTIN: ${partyObj.gstin}` : '';

        const transportWrap = document.getElementById('invTransportWrap');
        if (isDN && (txn.driverName || txn.driverPhone || txn.vehicleNo || txn.vehicleType)) {
            const bits = [];
            if (txn.driverName) bits.push(`Driver: <strong>${escapeHtml(txn.driverName)}</strong>${txn.driverPhone ? ' (' + escapeHtml(txn.driverPhone) + ')' : ''}`);
            if (txn.vehicleNo) bits.push(`Vehicle: <strong>${escapeHtml(txn.vehicleNo)}</strong>${txn.vehicleType ? ' - ' + escapeHtml(txn.vehicleType) : ''}`);
            document.getElementById('invTransportDetails').innerHTML = bits.join(' &nbsp;|&nbsp; ');
            transportWrap.style.display = 'block';
        } else {
            transportWrap.style.display = 'none';
        }

        let itemsHtml = '';
        if (isJournalTxn) {
            const desc = `Debit: ${txn.journalDebit ? txn.journalDebit.name : 'Unknown'}  |  Credit: ${txn.journalCredit ? txn.journalCredit.name : 'Unknown'}`
                + (txn.narration ? ` — ${txn.narration}` : '');
            itemsHtml = `
                <tr>
                    <td style="border:1px solid #cbd5e1; padding:6px;" colspan="5">${escapeHtml(desc)}</td>
                    <td style="border:1px solid #cbd5e1; padding:6px;">\u20B9${txn.grandTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                </tr>
            `;
        } else if (isCash) {
            const desc = `${txn.type} ${txn.type === 'Receipt' ? 'from' : 'to'} ${txn.partyName} via ${txn.accountName || 'Cash'}`
                + (txn.refInvoiceNo ? ` (Ref: ${txn.refInvoiceNo})` : '')
                + (txn.narration ? ` — ${txn.narration}` : '');
            itemsHtml = `
                <tr>
                    <td style="border:1px solid #cbd5e1; padding:6px;" colspan="5">${escapeHtml(desc)}</td>
                    <td style="border:1px solid #cbd5e1; padding:6px;">\u20B9${txn.grandTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                </tr>
            `;
        } else {
            // Defensive rendering: older/imported transactions can carry line
            // items missing a field (e.g. inclRate/lineTotal) if the app's
            // item shape changed since they were saved, or a merged-in backup
            // came from an earlier version. A raw `undefined.toFixed()` used
            // to throw here, which aborted the WHOLE items loop silently and
            // left the invoice showing stale/blank rows from whatever was in
            // the modal before. Every field is now read safely with a
            // fallback so one bad row degrades gracefully instead of
            // breaking every row after it.
            const safeNum = (v) => (typeof v === 'number' && !isNaN(v)) ? v : 0;
            const safeText = (v, fallback) => (v === undefined || v === null || v === '') ? (fallback || '\u2014') : v;

            txn.items.forEach(it => {
                const rate = safeNum(it.inclRate);
                const lineTotal = (typeof it.lineTotal === 'number' && !isNaN(it.lineTotal)) ? it.lineTotal : rate * safeNum(it.qty);
                const taxableCell = (it.taxable != null && !isNaN(it.taxable)) ? `\u20B9${safeNum(it.taxable).toLocaleString('en-IN', {minimumFractionDigits: 2})}` : '\u2014';
                itemsHtml += `
                    <tr>  
                        <td style="border:1px solid #cbd5e1; padding:6px;">${escapeHtml(String(safeText(it.name, 'Item')))}</td>  
                        <td style="border:1px solid #cbd5e1; padding:6px;">${escapeHtml(String(safeText(it.hsn, '')))}</td>  
                        <td style="border:1px solid #cbd5e1; padding:6px;">${safeNum(it.qty)} ${escapeHtml(String(safeText(it.uom, '')))}</td>  
                        <td style="border:1px solid #cbd5e1; padding:6px;">\u20B9${rate.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>  
                        <td style="border:1px solid #cbd5e1; padding:6px;">${taxableCell}</td>  
                        <td style="border:1px solid #cbd5e1; padding:6px;">\u20B9${lineTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>  
                    </tr>  
                `;
            });
        }
        document.getElementById('invItems').innerHTML = itemsHtml;

        let taxText;
        if (isCash) {
            taxText = 'No GST applicable on cash/bank vouchers.';
        } else if (isDN) {
            taxText = 'Delivery Note — dispatch record only. Not a tax invoice; no GST charged.';
        } else if (isOptional) {
            taxText = 'Optional voucher — off the main books. No GST recorded.';
        } else {
            if (txn.taxType === 'EXEMPT') {
                taxText = `Taxable Value: \u20B9${txn.taxable.toLocaleString('en-IN', {minimumFractionDigits: 2})}<br>Nil GST \u2014 no tax charged on this voucher.`;
            } else {
                taxText = `Taxable Value: \u20B9${txn.taxable.toLocaleString('en-IN', {minimumFractionDigits: 2})}<br>`;
                if (txn.taxType === 'INTER') {
                    taxText += `IGST: \u20B9${txn.totalTax.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
                } else {
                    taxText += `CGST: \u20B9${(txn.totalTax/2).toLocaleString('en-IN', {minimumFractionDigits: 2})} | SGST: \u20B9${(txn.totalTax/2).toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
                }
            }
        }

        document.getElementById('invTaxBreakdown').innerHTML = taxText;  
        document.getElementById('invGrandTotal').innerText = `\u20B9${txn.grandTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;  

        // Paid / Balance Due — only for real Sales and Purchase invoices,
        // where "money owed against this invoice" is a meaningful concept.
        // Reuses invoiceOutstanding(), the same figure Pending to
        // Receive/Pay already use, so this always agrees with the rest of
        // the app rather than being a second, possibly-drifting calculation.
        const paidBalanceWrap = document.getElementById('invPaidBalanceWrap');
        if (txn.type === 'Sales' || txn.type === 'Purchase') {
            const due = invoiceOutstanding(txn);
            const paid = Math.max(0, txn.grandTotal - due);
            document.getElementById('invPaidAmount').innerText = `\u20B9${paid.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
            document.getElementById('invBalanceDue').innerText = `\u20B9${due.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
            paidBalanceWrap.style.display = 'block';
        } else {
            paidBalanceWrap.style.display = 'none';
        }

        const narrWrap = document.getElementById('invNarrationWrap');
        if (!isCash && txn.narration) {
            document.getElementById('invNarrationText').innerText = txn.narration;
            narrWrap.style.display = 'block';
        } else {
            narrWrap.style.display = 'none';
        }

        document.getElementById('invoiceModal').style.display = 'flex';  
        if (!suppressInvoiceModalHistory) navPushState(closeInvoiceModalUI);
    }  

    // ------------- SECTION 7: LEDGER LOGIC -------------
    // ================================================================
    // UNIFIED LEDGER SEARCH (Tally-style "go to Ledgers, type what you
    // want"). One search box covers every party, every cash/bank account,
    // and every voucher-type register (all Sales, all Purchases, all
    // Payments, all Receipts, plus any custom voucher types) as its own
    // searchable "ledger". Selecting one opens the same statement table,
    // with Edit/Delete already wired into every row.
    // ================================================================

    // The fixed set of voucher-type "ledgers" that behave like a combined
    // register across every party, rather than one specific party/account.
    function voucherTypeLedgers() {
        const base = [
            { kind: 'saleAll', id: 'Sales', label: 'Sales (All Parties)' },
            { kind: 'purchaseAll', id: 'Purchase', label: 'Purchases (All Parties)' },
            { kind: 'paymentAll', id: 'Payment', label: 'Payments (All Parties)' },
            { kind: 'receiptAll', id: 'Receipt', label: 'Receipts (All Parties)' }
        ];
        customVoucherTypes.forEach(vt => {
            base.push({ kind: 'customAll', id: vt.id, label: `${vt.name} (All Parties)` });
        });
        return base;
    }

    function renderLedgerSearchResults() {
        const raw = (document.getElementById('ledgerSearchInput').value || '').trim();
        const box = document.getElementById('ledgerSearchResults');

        // Once a ledger is open, openLedgerStatement() writes its full label
        // back into this box — e.g. "Mahalakshmi traders (Vendor)". That
        // trailing qualifier isn't part of any party or account name, so
        // searching the raw text found nothing and showed "No matching
        // ledger" directly above the ledger it had just opened. Match on the
        // name only, ignoring the qualifier the app added itself.
        const q = raw.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();

        const matches = [];
        parties.forEach(p => {
            if (!q || p.name.toLowerCase().includes(q)) {
                matches.push({ kind: 'party', id: p.id, label: p.name, sub: `${p.type} Ledger` });
            }
        });
        accounts.forEach(a => {
            if (!q || a.name.toLowerCase().includes(q)) {
                matches.push({ kind: 'account', id: a.id, label: a.name, sub: `${a.type} Account` });
            }
        });
        voucherTypeLedgers().forEach(v => {
            if (!q || v.label.toLowerCase().includes(q)) {
                matches.push({ kind: v.kind, id: v.id, label: v.label, sub: 'Voucher Register' });
            }
        });

        if (matches.length === 0) {
            box.innerHTML = '<div style="padding:12px; color:var(--text-muted); font-size:0.85rem;">No matching ledger. Try a party name, an account name, or a voucher type like "Sales".</div>';
            box.style.display = 'block';
            return;
        }

        box.innerHTML = `
            <table>
                <tbody>
                    ${matches.slice(0, 40).map(m => `
                        <tr style="cursor:pointer;" onclick="selectLedger('${m.kind}', ${typeof m.id === 'number' ? m.id : `'${escapeHtml(String(m.id))}'`})">
                            <td><strong>${escapeHtml(m.label)}</strong></td>
                            <td style="color:var(--text-muted); font-size:0.78rem;">${escapeHtml(m.sub)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        box.style.display = 'block';
    }

    function selectLedger(kind, id) {
        document.getElementById('ledgerSearchResults').style.display = 'none';
        document.getElementById('ledgerActiveWrap').style.display = 'block';
        document.getElementById('ledPeriod').value = 'all';
        document.getElementById('ledCustomWrap').style.display = 'none';
        document.getElementById('ledRowFilter').value = '';
        pageStateFor('ledgerStatement').page = 1;
        openLedgerStatement(kind, id);
    }

    function closeActiveLedger() {
        document.getElementById('ledgerActiveWrap').style.display = 'none';
        document.getElementById('ledgerSearchInput').value = '';
        document.getElementById('ledgerSearchResults').style.display = 'none';
        document.getElementById('ledRowFilter').value = '';
        lastLedger = null;
    }

    // Close the ledger search results dropdown when tapping/clicking
    // anywhere outside the search box or the dropdown itself.
    document.addEventListener('click', function(e) {
        const input = document.getElementById('ledgerSearchInput');
        const results = document.getElementById('ledgerSearchResults');
        if (!input || !results) return;
        if (results.style.display === 'none') return;
        if (e.target === input || input.contains(e.target) || results.contains(e.target)) return;
        results.style.display = 'none';
    });

    // ---------- Global Search ----------
    // One box that finds a party, an item, an invoice number, an
    // amount, or narration text across the whole app — so a person
    // doesn't need to already know which report a voucher lives in.
    function openGlobalSearch() {
        navPushState(closeGlobalSearchUI);
        document.getElementById('globalSearchModal').style.display = 'flex';
        const input = document.getElementById('globalSearchInput');
        input.value = '';
        renderGlobalSearchResults();
        setTimeout(() => input.focus(), 50);
    }
    function closeGlobalSearch() { history.back(); }
    function closeGlobalSearchUI() {
        document.getElementById('globalSearchModal').style.display = 'none';
    }
    function renderGlobalSearchResults() {
        const raw = document.getElementById('globalSearchInput').value.trim();
        const box = document.getElementById('globalSearchResults');
        if (!raw) {
            box.innerHTML = '<div class="party-ac-empty">Start typing to search parties, items, invoice numbers, amounts or narration.</div>';
            return;
        }
        const q = raw.toLowerCase();
        const qNum = parseFloat(raw.replace(/,/g, ''));
        const isAmountQuery = !isNaN(qNum) && /^[0-9.,]+$/.test(raw);

        const partyMatches = parties.filter(p =>
            (p.name || '').toLowerCase().includes(q) || (p.phone || '').includes(raw)
        ).slice(0, 8);

        const itemMatches = stockItems.filter(s => (s.name || '').toLowerCase().includes(q)).slice(0, 8);

        const txnMatches = transactions.filter(t => {
            if ((t.invNo || '').toLowerCase().includes(q)) return true;
            if ((t.narration || '').toLowerCase().includes(q)) return true;
            if ((t.partyName || '').toLowerCase().includes(q)) return true;
            if (isAmountQuery && Math.abs((t.grandTotal || 0) - qNum) < 0.005) return true;
            return false;
        }).sort((a, b) => b.id - a.id).slice(0, 15);

        if (!partyMatches.length && !itemMatches.length && !txnMatches.length) {
            box.innerHTML = '<div class="party-ac-empty">No matches for "' + escapeHtml(raw) + '".</div>';
            return;
        }

        let html = '';
        if (partyMatches.length) {
            html += '<div class="section-label" style="margin-top:0;">Parties</div>';
            partyMatches.forEach(p => {
                html += `<div class="party-ac-item" onclick="navPendingAfterBack = () => openPartyLedgerFromReport(${p.id}); closeGlobalSearch();">
                    ${escapeHtml(p.name)} <span style="color:var(--text-muted); font-size:0.8em;">(${escapeHtml(p.type)})</span>
                </div>`;
            });
        }
        if (itemMatches.length) {
            html += '<div class="section-label">Items</div>';
            itemMatches.forEach(s => {
                html += `<div class="party-ac-item" onclick="navPendingAfterBack = () => { openPanel('panelItem'); editItem(${s.id}); }; closeGlobalSearch();">
                    ${escapeHtml(s.name)} <span style="color:var(--text-muted); font-size:0.8em;">Qty: ${s.qty}</span>
                </div>`;
            });
        }
        if (txnMatches.length) {
            html += '<div class="section-label">Vouchers</div>';
            txnMatches.forEach(t => {
                html += `<div class="party-ac-item" onclick="navPendingAfterBack = () => printInvoice(${t.id}); closeGlobalSearch();">
                    <div style="display:flex; justify-content:space-between; gap:10px;">
                        <span><strong>${escapeHtml(t.invNo || t.type || '')}</strong> &mdash; ${escapeHtml(t.partyName || t.type || '')}</span>
                        <span style="font-family:'JetBrains Mono', monospace; white-space:nowrap;">&#8377;${(t.grandTotal || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</span>
                    </div>
                    ${t.narration ? `<div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">${escapeHtml(t.narration)}</div>` : ''}
                </div>`;
            });
        }
        box.innerHTML = html;
    }

    // Jump from anywhere in Reports straight to a party's ledger statement,
    // opening the Party Ledger panel and resetting its period to All Time
    // (the report the person came from may have used a narrower period).
    function openPartyLedgerFromReport(partyId) {
        if (!partyId) return;
        openPanel('panelLedger');
        selectLedger('party', partyId);
    }

    // Jump from anywhere in Reports straight to a Cash/Bank account's ledger.
    function openAccountLedgerFromReport(accountId) {
        if (!accountId) return;
        openPanel('panelLedger');
        selectLedger('account', accountId);
    }

    function onLedPeriodChange() {
        const sel = document.getElementById('ledPeriod').value;
        document.getElementById('ledCustomWrap').style.display = (sel === 'custom') ? 'block' : 'none';
        refreshLedgerView();
    }

    // Re-draw the currently open ledger with the chosen period.
    function refreshLedgerView() {
        if (lastLedger) openLedgerStatement(lastLedger.kind, lastLedger.id);
    }

    function currentLedgerRange() {
        const preset = document.getElementById('ledPeriod').value;
        return periodRange(preset, document.getElementById('ledFrom').value,
                                   document.getElementById('ledTo').value);
    }

    function periodLabel(preset, range) {
        if (!range) return 'All Time';
        const f = range.from ? range.from.toISOString().slice(0, 10) : '...';
        const t = range.to ? range.to.toISOString().slice(0, 10) : '...';
        return `Period: ${f} to ${t}`;
    }

    // Opens a full ledger statement for either a Party ('party') or a
    // Cash/Bank Account ('account'). Used by the Party Ledger tile as well
    // as by drilling into a Ledger Group's list of ledgers. Each row shown
    // includes inventory detail for Sales/Purchase (Party ledgers) and is
    // clickable to open that transaction's underlying voucher/invoice.
    let lastLedger = null;
    let ledgerCurrentRowOrder = [];
    // Determines a single transaction's Debit/Credit contribution to the
    // ledger currently being viewed (a party, an account, or an aggregate
    // "All Parties" register). Shared by the full-dataset totals pass and
    // the paginated row-rendering pass below, so the two can never drift
    // out of sync with each other — the same rule decides both.
    function ledgerTxnDebitCredit(txn, id, isAggregate, isAccount) {
        let debit = 0, credit = 0;
        if (isAggregate) {
            if (txn.type === 'Sales' || txn.type === 'Receipt') debit = txn.grandTotal;
            else credit = txn.grandTotal;
        } else if (isAccount) {
            if (txn.type === 'Journal') {
                if (txn.journalDebit && txn.journalDebit.kind === 'account' && txn.journalDebit.id == id) debit = txn.grandTotal;
                else if (txn.journalCredit && txn.journalCredit.kind === 'account' && txn.journalCredit.id == id) credit = txn.grandTotal;
            } else if (txn.type === 'Receipt') {
                debit = txn.grandTotal;
            } else if (txn.type === 'Payment' || isCustomNoPartyType(txn.type)) {
                credit = txn.grandTotal;
            }
        } else {
            if (txn.type === 'Journal') {
                if (txn.journalDebit && txn.journalDebit.kind === 'party' && txn.journalDebit.id == id) debit = txn.grandTotal;
                else if (txn.journalCredit && txn.journalCredit.kind === 'party' && txn.journalCredit.id == id) credit = txn.grandTotal;
            } else if (txn.type === 'Sales') {
                debit = txn.grandTotal;
            } else if (txn.type === 'Purchase' || txn.type === 'RawPurchase') {
                credit = txn.grandTotal;
            } else if (txn.type === 'Payment') {
                debit = txn.grandTotal;
            } else if (txn.type === 'Receipt') {
                credit = txn.grandTotal;
            } else if (txn.customVoucherTypeId && txn.inMainBooks) {
                if (txn.ledgerEffect === 'debit') debit = txn.grandTotal;
                else if (txn.ledgerEffect === 'credit') credit = txn.grandTotal;
            }
        }
        return { debit, credit };
    }

    function openLedgerStatement(kind, id) {
        clearSelection('ledgerStatement');
        lastLedger = { kind, id };
        const isAccount = (kind === 'account');
        const isAggregate = (kind === 'saleAll' || kind === 'purchaseAll' || kind === 'paymentAll' || kind === 'receiptAll' || kind === 'customAll');
        let headerText = '';
        let ledgerTxns = [];

        const range = currentLedgerRange();
        document.getElementById('ledgerPeriodLabel').innerText =
            periodLabel(document.getElementById('ledPeriod').value, range);

        if (isAggregate) {
            // A combined register across every party — e.g. "Sales (All
            // Parties)" — rather than one specific counterparty's ledger.
            let wantType = id;
            let label = id;
            if (kind === 'customAll') {
                const vt = customVoucherTypes.find(v => v.id === id);
                label = vt ? vt.name : id;
            } else {
                label = { Sales: 'Sales', Purchase: 'Purchases', Payment: 'Payments', Receipt: 'Receipts' }[id] || id;
            }
            headerText = `${label} (All Parties)`;
            ledgerTxns = transactions.filter(t => {
                if (!inRange(t.date, range)) return false;
                if (kind === 'customAll') return t.customVoucherTypeId === id;
                if (kind === 'purchaseAll') return t.type === 'Purchase' || t.type === 'RawPurchase';
                return t.type === wantType;
            });
        } else if (isAccount) {
            const acc = accounts.find(a => a.id == id);
            if (!acc) return;
            headerText = `${acc.name} (${acc.type})`;
            const asOf = acc.openingAsOf || '2000-01-01';
            ledgerTxns = transactions.filter(t => inRange(t.date, range) && t.date >= asOf && (
                t.accountId == id ||
                (t.type === 'Journal' && ((t.journalDebit && t.journalDebit.kind === 'account' && t.journalDebit.id == id)
                    || (t.journalCredit && t.journalCredit.kind === 'account' && t.journalCredit.id == id)))
            ));
        } else {
            const party = parties.find(p => p.id == id);
            if (!party) return;
            headerText = `${party.name} (${party.type})`;
            const asOf = party.openingAsOf || '2000-01-01';
            ledgerTxns = transactions.filter(t => inRange(t.date, range) && t.date >= asOf
                && !(t.customVoucherTypeId && t.inMainBooks === false)
                && (
                    t.partyId == id ||
                    (t.type === 'Journal' && ((t.journalDebit && t.journalDebit.kind === 'party' && t.journalDebit.id == id)
                        || (t.journalCredit && t.journalCredit.kind === 'party' && t.journalCredit.id == id)))
                )
            );
        }
        document.getElementById('ledgerHeaderDetails').innerText = headerText;
        document.getElementById('ledgerAccountLabel').innerText = isAggregate ? 'Voucher Register' : 'Ledger Account';
        document.getElementById('ledgerSearchInput').value = headerText;

        // Free-text filter within whatever's currently loaded — voucher
        // number, counterparty name, or an item name in the line items.
        // Genuinely useful once a ledger (especially an aggregate "All
        // Sales"/"All Purchases" register) has months of history.
        const totalBeforeFilter = ledgerTxns.length;
        const filterQ = (document.getElementById('ledRowFilter').value || '').trim().toLowerCase();
        if (filterQ) {
            ledgerTxns = ledgerTxns.filter(t => {
                if ((t.invNo || '').toLowerCase().includes(filterQ)) return true;
                if ((t.partyName || '').toLowerCase().includes(filterQ)) return true;
                if ((t.narration || '').toLowerCase().includes(filterQ)) return true;
                if ((t.items || []).some(it => (it.name || '').toLowerCase().includes(filterQ))) return true;
                return false;
            });
            document.getElementById('ledgerFilterLabel').innerText =
                `Showing ${ledgerTxns.length} of ${totalBeforeFilter} matching "${document.getElementById('ledRowFilter').value.trim()}"`;
        } else {
            document.getElementById('ledgerFilterLabel').innerText = '';
        }

        const tbody = document.getElementById('partyLedgerBody');
        const tfoot = document.getElementById('partyLedgerFoot');
        tbody.innerHTML = '';
        tfoot.innerHTML = '';

        ledgerTxns = sortByDate(ledgerTxns, 'ledgerStatement');

        let totalDebit = 0;
        let totalCredit = 0;

        // Opening Balance: whatever this ledger's running balance was as of
        // the moment before this statement's period starts (the active
        // Financial Year's Apr 1 by default, or the chosen period's start
        // date if the user picked a different one, or the manual opening
        // if "All Time" is selected). Always shown — including a plain
        // ₹0.00 row when there's genuinely no prior balance — so opening
        // balance behaves the same for every ledger and party rather than
        // silently disappearing when there's nothing to carry forward.
        const openingCutoff = (range && range.from) ? dateToYMD(range.from) : null;
        if (isAccount) {
            const acc = accounts.find(a => a.id == id);
            const asOf = acc.openingAsOf || '2000-01-01';
            const cutoff = openingCutoff || asOf; // no explicit period start -> just the manual base, no txns folded in
            const opening = accountBalanceAsOf(id, cutoff);
            if (asOf !== '2000-01-01') {
                document.getElementById('ledgerFilterLabel').innerText +=
                    (document.getElementById('ledgerFilterLabel').innerText ? ' \u2022 ' : '') +
                    `Opening Balance reflects everything up to ${cutoff} (manual opening carried forward from ${asOf}) — those vouchers aren't listed again below.`;
            } else if (openingCutoff) {
                document.getElementById('ledgerFilterLabel').innerText +=
                    (document.getElementById('ledgerFilterLabel').innerText ? ' \u2022 ' : '') +
                    `Opening Balance reflects everything before ${cutoff} — those vouchers aren't listed again below.`;
            }
            if (opening > 0) totalDebit += opening;
            else if (opening < 0) totalCredit += Math.abs(opening);
            tbody.innerHTML += `
                <tr>
                    <td style="vertical-align:top;">-</td>
                    <td><strong>Opening Balance</strong></td>
                    <td style="vertical-align:top;">-</td>
                    <td style="vertical-align:top;">-</td>
                    <td style="vertical-align:top;">${opening > 0 ? opening.toLocaleString('en-IN', {minimumFractionDigits: 2}) : (opening === 0 ? '0.00' : '')}</td>
                    <td style="vertical-align:top;">${opening < 0 ? Math.abs(opening).toLocaleString('en-IN', {minimumFractionDigits: 2}) : ''}</td>
                    <td style="vertical-align:top;">-</td>
                </tr>
            `;
        } else if (!isAggregate) {
            const party = parties.find(p => p.id == id);
            const asOf = party.openingAsOf || '2000-01-01';
            const cutoff = openingCutoff || asOf;
            const opening = partyBalanceAsOf(id, cutoff);
            if (asOf !== '2000-01-01') {
                document.getElementById('ledgerFilterLabel').innerText +=
                    (document.getElementById('ledgerFilterLabel').innerText ? ' \u2022 ' : '') +
                    `Opening Balance reflects everything up to ${cutoff} (manual opening carried forward from ${asOf}) — those vouchers aren't listed again below.`;
            } else if (openingCutoff) {
                document.getElementById('ledgerFilterLabel').innerText +=
                    (document.getElementById('ledgerFilterLabel').innerText ? ' \u2022 ' : '') +
                    `Opening Balance reflects everything before ${cutoff} — those vouchers aren't listed again below.`;
            }
            if (opening > 0) totalDebit += opening;
            else if (opening < 0) totalCredit += Math.abs(opening);
            tbody.innerHTML += `
                <tr>
                    <td style="vertical-align:top;">-</td>
                    <td><strong>Opening Balance</strong></td>
                    <td style="vertical-align:top;">-</td>
                    <td style="vertical-align:top;">-</td>
                    <td style="vertical-align:top;">${opening > 0 ? opening.toLocaleString('en-IN', {minimumFractionDigits: 2}) : (opening === 0 ? '0.00' : '')}</td>
                    <td style="vertical-align:top;">${opening < 0 ? Math.abs(opening).toLocaleString('en-IN', {minimumFractionDigits: 2}) : ''}</td>
                    <td style="vertical-align:top;">-</td>
                </tr>
            `;
        }

        if (ledgerTxns.length === 0) {
            tbody.innerHTML += `<tr><td colspan="8" style="text-align:center; color:var(--text-muted);">No transactions found for this ledger.</td></tr>`;
        } else {
            ledgerCurrentRowOrder = ledgerTxns.map(t => t.id); // full set, for Print Selected — independent of which page is showing

            // Totals must reflect EVERY transaction in this ledger, not
            // just whatever page happens to be showing — computed here in
            // one pass over the full set, before pagination slices it down
            // for display.
            ledgerTxns.forEach(txn => {
                const { debit, credit } = ledgerTxnDebitCredit(txn, id, isAggregate, isAccount);
                totalDebit += debit;
                totalCredit += credit;
            });

            const pageRows = paginateRows('ledgerStatement', ledgerTxns);
            pageRows.forEach(txn => {
                const { debit, credit } = ledgerTxnDebitCredit(txn, id, isAggregate, isAccount);

                // Details Sub-text
                let invDetails;
                if (txn.type === 'Journal') {
                    // Show whichever side of this Journal ISN'T the ledger
                    // currently being viewed — that's the useful counterpart.
                    const viewingIsDebit = txn.journalDebit && ((isAccount && txn.journalDebit.kind === 'account') || (!isAccount && txn.journalDebit.kind === 'party')) && txn.journalDebit.id == id;
                    const other = viewingIsDebit ? txn.journalCredit : txn.journalDebit;
                    const otherLabel = other ? escapeHtml(other.name) : 'Unknown';
                    invDetails = `<div class="text-muted-print" style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">
                        \u21B3 ${viewingIsDebit ? 'From' : 'To'} ${otherLabel}${txn.narration ? ' - ' + escapeHtml(txn.narration) : ''}
                    </div>`;
                } else if (txn.type === 'Payment' || txn.type === 'Receipt') {
                    const counterpart = isAccount ? (txn.partyName || 'Cash Party') : (txn.accountName || 'Cash');
                    invDetails = `<div class="text-muted-print" style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">
                        \u21B3 ${escapeHtml(counterpart)}${txn.refInvoiceNo ? ' | Ref: ' + escapeHtml(txn.refInvoiceNo) : ''}${txn.narration ? ' - ' + escapeHtml(txn.narration) : ''}
                    </div>`;
                } else if (isCustomNoPartyType(txn.type)) {
                    const bits = [];
                    if (txn.subLedger) bits.push(escapeHtml(txn.subLedger));
                    bits.push(escapeHtml(txn.accountName || 'Cash'));
                    invDetails = `<div class="text-muted-print" style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">
                        \u21B3 ${bits.join(' | ')}${txn.narration ? ' - ' + escapeHtml(txn.narration) : ''}
                    </div>`;
                } else {
                    invDetails = (txn.items || []).map(it => 
                        `<div class="text-muted-print" style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">
                            \u21B3 ${escapeHtml(it.name || 'Item')} : ${it.qty || 0} ${escapeHtml(it.uom || '')} @ \u20B9${(typeof it.inclRate === 'number' ? it.inclRate : 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}
                        </div>`
                    ).join('');
                    if (txn.narration) {
                        invDetails += `<div class="text-muted-print" style="font-size:0.75rem; color:var(--text-muted); margin-top:2px; font-style:italic;">
                            \u21B3 ${escapeHtml(txn.narration)}
                        </div>`;
                    }
                }

                let particularsTitle = 'Sales Account';
                if (txn.type === 'Journal') particularsTitle = 'Journal Entry';
                else if (txn.type === 'Purchase') particularsTitle = 'Purchase Account';
                else if (txn.type === 'RawPurchase') particularsTitle = 'Raw Purchase Account';
                else if (txn.type === 'Payment') particularsTitle = isAccount ? escapeHtml(txn.partyName || 'Cash Party') : 'Payment (Cash/Bank)';
                else if (txn.type === 'Receipt') particularsTitle = isAccount ? escapeHtml(txn.partyName || 'Cash Party') : 'Receipt (Cash/Bank)';
                else if (txn.customVoucherTypeId) particularsTitle = escapeHtml(txn.customVoucherTypeName || 'Custom Voucher');

                // In an aggregate "All Parties" register, lead with who the
                // voucher is against, since that's the whole point of the view.
                if (isAggregate) {
                    const who = txn.partyName || (txn.accountName ? `via ${txn.accountName}` : 'Cash Party');
                    particularsTitle = escapeHtml(who);
                }

                // The "Type" column: a custom voucher type's raw id is an
                // internal slug (e.g. CT_Expense), not something to show —
                // display its actual name instead, same as everywhere else.
                const typeColLabel = txn.customVoucherTypeId ? escapeHtml(txn.customVoucherTypeName || 'Custom') : escapeHtml(txn.type);

                // Payment/Receipt amounts get a distinct color in this
                // statement specifically, since they're the two cash-
                // movement types most worth telling apart at a glance
                // when mixed in with Sales/Purchase/Journal rows.
                const isPaymentTxn = (txn.type === 'Payment');
                const isReceiptTxn = (txn.type === 'Receipt');
                const receiptGreen = '#1B8F53'; // explicit green — --success is blue under the current theme, and this needs to genuinely read as green regardless of theme
                const debitColor = isReceiptTxn ? receiptGreen : (isPaymentTxn ? 'var(--danger)' : 'inherit');
                const creditColor = isPaymentTxn ? 'var(--danger)' : (isReceiptTxn ? receiptGreen : 'inherit');

                tbody.innerHTML += `
                    <tr style="cursor:pointer;" title="Click to view this voucher">
                        <td class="no-print" data-select-col="ledgerStatement" style="vertical-align:top; display:none;" onclick="event.stopPropagation();">
                            <input type="checkbox" data-select-key="ledgerStatement" data-select-id="${txn.id}" onchange="toggleRowSelection('ledgerStatement', ${txn.id}, this.checked)">
                        </td>
                        <td style="vertical-align:top;" onclick="openTransactionDetail(${txn.id})">${txn.date}</td>
                        <td onclick="openTransactionDetail(${txn.id})">
                            <strong>${particularsTitle}</strong>
                            ${invDetails}
                        </td>
                        <td style="vertical-align:top;" onclick="openTransactionDetail(${txn.id})">${typeColLabel}</td>
                        <td style="vertical-align:top;" onclick="openTransactionDetail(${txn.id})">${txn.invNo}</td>
                        <td style="vertical-align:top; color:${debitColor};" onclick="openTransactionDetail(${txn.id})">${debit > 0 ? debit.toLocaleString('en-IN', {minimumFractionDigits: 2}) : ''}</td>
                        <td style="vertical-align:top; color:${creditColor};" onclick="openTransactionDetail(${txn.id})">${credit > 0 ? credit.toLocaleString('en-IN', {minimumFractionDigits: 2}) : ''}</td>
                        <td class="no-print" style="vertical-align:top; white-space:nowrap;">
                            <button onclick="event.stopPropagation(); deleteVoucherSmart(${txn.id})" class="btn-danger" style="padding:2px 8px; font-size:0.68rem; width:auto;">Delete</button>
                        </td>
                    </tr>
                `;
            });
        }

        // Closing Balance Logic
        let netBalance = totalDebit - totalCredit;
        let balanceText = '';
        let balanceColor = '';

        if (isAggregate) {
            balanceText = `Total: \u20B9${(totalDebit + totalCredit).toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
            balanceColor = 'var(--accent)';
        } else if (netBalance > 0) {
            balanceText = `By Closing Balance (Dr): \u20B9${netBalance.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
            balanceColor = 'var(--accent)';
        } else if (netBalance < 0) {
            balanceText = `To Closing Balance (Cr): \u20B9${Math.abs(netBalance).toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
            balanceColor = 'var(--danger)';
        } else {
            balanceText = `Settled (\u20B90.00)`;
            balanceColor = 'var(--success)';
        }

        // Totals are shown in the summary cards above the table and in the
        // print header, so the footer stays empty rather than repeating them.
        tfoot.innerHTML = '';

        // Print header totals (these are what appear on a saved PDF).
        const hdrTotals = document.getElementById('ledgerHeaderTotals');
        if (hdrTotals) {
            hdrTotals.style.display = 'flex';
            document.getElementById('ledgerHdrDebit').innerText =
                '\u20B9' + totalDebit.toLocaleString('en-IN', {minimumFractionDigits: 2});
            document.getElementById('ledgerHdrCredit').innerText =
                '\u20B9' + totalCredit.toLocaleString('en-IN', {minimumFractionDigits: 2});
            const hdrBal = document.getElementById('ledgerHdrBalance');
            hdrBal.innerText = balanceText;
            hdrBal.style.color = balanceColor;
        }

        // Mirror the footer totals into the summary bar at the top of the
        // panel, so a long ledger doesn't have to be scrolled to the bottom
        // just to read the closing balance.
        const topSummary = document.getElementById('ledgerTopSummary');
        if (topSummary) {
            topSummary.style.display = 'flex';
            document.getElementById('ledgerTopDebit').innerText =
                '\u20B9' + totalDebit.toLocaleString('en-IN', {minimumFractionDigits: 2});
            document.getElementById('ledgerTopCredit').innerText =
                '\u20B9' + totalCredit.toLocaleString('en-IN', {minimumFractionDigits: 2});
            // balanceText already carries its own "By/To Closing Balance"
            // wording plus the figure; split it so the label sits above the
            // number like the two cards beside it.
            const sep = balanceText.indexOf(': ');
            const lbl = document.getElementById('ledgerTopBalanceLabel');
            const val = document.getElementById('ledgerTopBalance');
            if (sep > -1) {
                lbl.innerText = balanceText.slice(0, sep);
                val.innerText = balanceText.slice(sep + 2);
            } else {
                lbl.innerText = isAggregate ? 'Total' : 'Closing Balance';
                val.innerText = balanceText.replace(/^Total: /, '');
            }
            val.style.color = balanceColor;
        }

        renderPaginationControls('ledgerStatement', ledgerTxns.length, () => openLedgerStatement(kind, id));

        document.getElementById('ledgerPrintArea').style.display = 'block';
        if (!document.getElementById('panelLedger').classList.contains('active')) {
            openPanel('panelLedger');
        }
    }

    // Opens the underlying voucher for a ledger-statement row: the Tax
    // Invoice view for Sales/Purchase, or the Payment/Receipt voucher view
    // for cash entries (both reuse the same printable modal).
    function openTransactionDetail(txnId) {
        printInvoice(txnId);
    }

    // ---- Generic "save to file" helpers ----

    // Print any region (panel/statement) on its own page -> browser's
    // print dialog lets the user save it as PDF.
    // ---- Smart print: PDF + Share Sheet fallback for iOS home-screen apps ----
    // window.print() is silently disabled by iOS WebKit when the app is
    // running "standalone" (opened via an Add to Home Screen icon, no
    // Safari chrome). Detect that case and render the printable node to
    // a PDF instead, then hand it to the native Share Sheet — from there
    // the person can Save to Files, AirPrint, or send it anywhere.
    // Everywhere else (desktop, or the page opened as a normal Safari/
    // Chrome tab) keeps using window.print() exactly as before.
    function isStandaloneApp() {
        return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
            || window.navigator.standalone === true;
    }

    async function smartPrint(node, filenameBase, fallbackPrintFn) {
        if (!isStandaloneApp() || typeof html2canvas === 'undefined' || typeof window.jspdf === 'undefined') {
            fallbackPrintFn();
            return;
        }
        // .no-print elements (action buttons, the e-Way Bill/paper-size
        // toolbar, etc.) are only hidden via an `@media print` rule,
        // which never applies to a live on-screen html2canvas capture.
        // Actually hide them for real just for the snapshot, then restore
        // exactly what was there before.
        const noPrintEls = node.querySelectorAll('.no-print');
        const prevDisplay = Array.from(noPrintEls).map(el => el.style.display);
        noPrintEls.forEach(el => { el.style.display = 'none'; });

        // Swap in crisp print colors (see .pdf-capture-mode) and lift any
        // overflow-x:auto clipping (e.g. the ledger's scrollable table),
        // so the snapshot captures the FULL width of wide content instead
        // of only whatever fit in the on-screen scroll viewport.
        const prevOverflow = node.style.overflow;
        node.classList.add('pdf-capture-mode');
        node.style.overflow = 'visible';

        try {
            // The logo (and any other <img>) is now a real file rather than
            // an inline data URI, so it isn't guaranteed to be decoded at
            // the instant we snapshot — html2canvas draws whatever is ready
            // and would silently leave a blank space where the logo should
            // be on the PDF. Wait for every image in the node to finish
            // first. Failures resolve rather than reject, so one broken
            // image can't block the whole export.
            await Promise.all(
                Array.from(node.querySelectorAll('img')).map(img => {
                    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
                    return new Promise(resolve => {
                        img.addEventListener('load', resolve, { once: true });
                        img.addEventListener('error', resolve, { once: true });
                    });
                })
            );

            // Explicit width/height (and matching windowWidth/windowHeight)
            // tell html2canvas to render the node's FULL scrollable content,
            // not just whatever fits in one screen's height — without this,
            // long content (e.g. a ledger with many rows) gets cut off after
            // one viewport's worth.
            const canvas = await html2canvas(node, {
                scale: 2,
                backgroundColor: '#ffffff',
                useCORS: true,
                width: node.scrollWidth,
                height: node.scrollHeight,
                windowWidth: node.scrollWidth,
                windowHeight: node.scrollHeight
            });
            const imgData = canvas.toDataURL('image/png');
            const { jsPDF } = window.jspdf;

            // Slice the (possibly very tall) captured image across as many
            // A4 pages as it takes, instead of one giant single-page PDF —
            // same "print a long report" pattern people expect from a real
            // printer, and it prints/paginates properly if opened on paper.
            const a4WidthMm = 210;
            const a4HeightMm = 297;
            const marginMm = 8;
            const usableWidthMm = a4WidthMm - marginMm * 2;
            const usableHeightMm = a4HeightMm - marginMm * 2;

            const imgWidthMm = usableWidthMm;
            const imgHeightMm = (canvas.height * imgWidthMm) / canvas.width;
            const pxPerMm = canvas.width / imgWidthMm;
            const pageHeightPx = usableHeightMm * pxPerMm;

            const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
            let renderedPx = 0;
            let pageNum = 0;
            while (renderedPx < canvas.height) {
                const sliceHeightPx = Math.min(pageHeightPx, canvas.height - renderedPx);

                const sliceCanvas = document.createElement('canvas');
                sliceCanvas.width = canvas.width;
                sliceCanvas.height = sliceHeightPx;
                sliceCanvas.getContext('2d').drawImage(
                    canvas, 0, renderedPx, canvas.width, sliceHeightPx,
                    0, 0, canvas.width, sliceHeightPx
                );
                const sliceData = sliceCanvas.toDataURL('image/png');
                const sliceHeightMm = (sliceHeightPx * imgWidthMm) / canvas.width;

                if (pageNum > 0) pdf.addPage();
                pdf.addImage(sliceData, 'PNG', marginMm, marginMm, imgWidthMm, sliceHeightMm);

                renderedPx += sliceHeightPx;
                pageNum++;
            }

            const blob = pdf.output('blob');
            const safeName = (filenameBase || 'Document').replace(/[^\w.-]+/g, '_');
            const file = new File([blob], `${safeName}.pdf`, { type: 'application/pdf' });

            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({ files: [file], title: safeName });
                    return;
                } catch (err) {
                    if (err && err.name === 'AbortError') return; // person cancelled the share sheet
                }
            }
            // Share Sheet unavailable — fall back to a direct download.
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${safeName}.pdf`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 4000);
        } catch (err) {
            console.error('PDF export failed, falling back to print dialog', err);
            fallbackPrintFn();
        } finally {
            noPrintEls.forEach((el, i) => { el.style.display = prevDisplay[i]; });
            node.classList.remove('pdf-capture-mode');
            node.style.overflow = prevOverflow;
        }
    }

    function printRegion(elementId, title) {
        if (!isAdmin() && !hasPermission('exportPrint')) { alert("Only an admin, or a user with 'Export / print' turned on, can print or export."); return; }
        const el = document.getElementById(elementId);
        if (!el) return;
        const prevTitle = document.title;
        if (title) document.title = title;
        el.classList.add('print-target');
        document.body.classList.add('printing-region');
        const cleanup = () => {
            document.body.classList.remove('printing-region');
            el.classList.remove('print-target');
            document.title = prevTitle;
            window.removeEventListener('afterprint', cleanup);
        };
        window.addEventListener('afterprint', cleanup);
        smartPrint(el, title || 'Report', () => {
            window.print();
            setTimeout(cleanup, 1000);
        }).then(() => { if (isStandaloneApp()) cleanup(); });
    }

    function csvCell(v) {
        const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
        return '"' + s.replace(/"/g, '""') + '"';
    }

    function downloadCSV(filename, rows) {
        const csv = rows.map(r => r.map(csvCell).join(',')).join('\r\n');
        // BOM so Excel reads the rupee sign and unicode correctly
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename.endsWith('.csv') ? filename : filename + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 500);
    }

    // ---- Export / Import all data (JSON backup, move to another device) ----
    // This does NOT touch Firebase/cloud sync directly — it just downloads a
    // JSON snapshot of everything, and on import merges records into the
    // same in-memory arrays + localStorage keys the rest of the app already
    // uses, then calls syncCloud() exactly like every other change does.
    function exportAllData() {
        const payload = {
            exportedAt: new Date().toISOString(),
            appName: 'Sarvadharani seeds',
            version: 1,
            parties, stockItems, transactions, accounts,
            stockGroups, ledgerGroups, refCounter, subLedgers, customVoucherTypes
        };
        const json = JSON.stringify(payload, null, 2);
        const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const stamp = new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = `sarvadharani-seeds-backup-${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 500);
    }

    function handleImportFile(event) {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            let data;
            try {
                data = JSON.parse(reader.result);
            } catch (err) {
                document.getElementById('importSummary').innerHTML =
                    '<span style="color:var(--danger);">This doesn\'t look like a valid export file (couldn\'t parse JSON).</span>';
                return;
            }
            mergeImportedData(data);
            event.target.value = ''; // allow re-choosing the same file later
        };
        reader.onerror = () => {
            document.getElementById('importSummary').innerHTML =
                '<span style="color:var(--danger);">Could not read that file.</span>';
        };
        reader.readAsText(file);
    }

    // Merge one array of imported records into the matching local array,
    // matched by "id" so records already present (same id) are left alone —
    // nothing already on this device gets deleted or overwritten.
    function mergeById(localArr, importedArr) {
        if (!Array.isArray(importedArr)) return { arr: localArr, added: 0 };
        const existingIds = new Set(localArr.map(x => x.id));
        let added = 0;
        importedArr.forEach(rec => {
            if (rec && rec.id != null && !existingIds.has(rec.id)) {
                localArr.push(rec);
                existingIds.add(rec.id);
                added++;
            }
        });
        return { arr: localArr, added };
    }

    // Sub-ledger categories are plain strings, not objects with an id —
    // merge by exact (case-insensitive) name instead.
    function mergeStrings(localArr, importedArr) {
        if (!Array.isArray(importedArr)) return { arr: localArr, added: 0 };
        const existingLower = new Set(localArr.map(s => String(s).toLowerCase()));
        let added = 0;
        importedArr.forEach(name => {
            if (name && !existingLower.has(String(name).toLowerCase())) {
                localArr.push(name);
                existingLower.add(String(name).toLowerCase());
                added++;
            }
        });
        return { arr: localArr, added };
    }

    function mergeImportedData(data) {
        if (!data || typeof data !== 'object') {
            document.getElementById('importSummary').innerHTML =
                '<span style="color:var(--danger);">That file does not contain recognizable backup data.</span>';
            return;
        }

        const r1 = mergeById(parties, data.parties);
        const r2 = mergeById(stockItems, data.stockItems);
        const r3 = mergeById(transactions, data.transactions);
        const r4 = mergeById(accounts, data.accounts);
        const r5 = mergeById(stockGroups, data.stockGroups);
        const r6 = mergeById(ledgerGroups, data.ledgerGroups);
        const r7 = mergeStrings(subLedgers, data.subLedgers);
        const r8 = mergeById(customVoucherTypes, data.customVoucherTypes);

        // refCounter is a small object of counters, not a list — keep
        // whichever count is higher for each so voucher numbering never
        // goes backwards or collides after the merge.
        if (data.refCounter && typeof data.refCounter === 'object') {
            Object.keys(data.refCounter).forEach(k => {
                const incoming = Number(data.refCounter[k]) || 0;
                const current = Number(refCounter[k]) || 0;
                refCounter[k] = Math.max(current, incoming);
            });
        }

        localStorage.setItem('tally_mob_parties', JSON.stringify(parties));
        localStorage.setItem('tally_mob_stock', JSON.stringify(stockItems));
        localStorage.setItem('tally_mob_db', JSON.stringify(transactions));
        localStorage.setItem('tally_mob_accounts', JSON.stringify(accounts));
        localStorage.setItem('tally_mob_stockgroups', JSON.stringify(stockGroups));
        localStorage.setItem('tally_mob_ledgergroups', JSON.stringify(ledgerGroups));
        localStorage.setItem('tally_mob_refcounter', JSON.stringify(refCounter));
        localStorage.setItem('tally_mob_subledgers', JSON.stringify(subLedgers));
        localStorage.setItem('tally_mob_vouchertypes', JSON.stringify(customVoucherTypes));
        syncCloud();

        render();

        const totalAdded = r1.added + r2.added + r3.added + r4.added + r5.added + r6.added + r7.added + r8.added;
        document.getElementById('importSummary').innerHTML = `
            <div style="background: rgba(52,211,153,0.1); border:1px solid rgba(52,211,153,0.3); color:var(--success); padding:10px 14px; border-radius:12px;">
                Import complete &mdash; ${totalAdded} new record(s) merged in.<br>
                <span style="font-size:0.78rem; color:var(--text-muted);">
                    Parties +${r1.added} &middot; Items +${r2.added} &middot; Vouchers +${r3.added} &middot; Accounts +${r4.added} &middot;
                    Stock Groups +${r5.added} &middot; Ledger Groups +${r6.added} &middot; Categories +${r7.added} &middot; Voucher Types +${r8.added}
                </span>
            </div>
        `;
    }

    // Export the table that owns the given tbody, skipping any buttons.
    function exportTableCSV(tbodyId, filename) {
        if (!isAdmin() && !hasPermission('exportPrint')) { alert("Only an admin, or a user with 'Export / print' turned on, can print or export."); return; }
        const tbody = document.getElementById(tbodyId);
        if (!tbody) return;
        const table = tbody.closest('table');
        if (!table) return;
        const rows = [];
        table.querySelectorAll('tr').forEach(tr => {
            const cells = [];
            tr.querySelectorAll('th, td').forEach(cell => {
                const clone = cell.cloneNode(true);
                clone.querySelectorAll('button').forEach(b => b.remove());
                cells.push(clone.innerText);
            });
            if (cells.some(c => c && c.trim() !== '')) rows.push(cells);
        });
        if (rows.length === 0) return alert("Nothing to export.");
        downloadCSV(filename, rows);
    }

    function exportLedgerCSV() {
        if (!isAdmin() && !hasPermission('exportPrint')) return alert("Only an admin, or a user with 'Export / print' turned on, can print or export.");
        if (document.getElementById('ledgerPrintArea').style.display !== 'block') {
            return alert("Please view a ledger statement first.");
        }
        const who = document.getElementById('ledgerHeaderDetails').innerText || 'ledger';
        const period = document.getElementById('ledgerPeriodLabel').innerText || '';
        const rows = [['Ledger Account', who], ['Period', period], []];
        const table = document.getElementById('partyLedgerBody').closest('table');
        table.querySelectorAll('tr').forEach(tr => {
            const cells = [];
            tr.querySelectorAll('th, td').forEach(cell => {
                const clone = cell.cloneNode(true);
                clone.querySelectorAll('button').forEach(b => b.remove());
                cells.push(clone.innerText);
            });
            if (cells.some(c => c && c.trim() !== '')) rows.push(cells);
        });
        downloadCSV('ledger-' + who.replace(/[^a-z0-9]+/gi, '-').toLowerCase(), rows);
    }

    function printLedger() {
        if (!isAdmin() && !hasPermission('exportPrint')) return alert("Only an admin, or a user with 'Export / print' turned on, can print or export.");
        const ledgerEl = document.getElementById('ledgerPrintArea');
        if (ledgerEl.style.display !== 'block') {
            return alert("Please view a party's ledger statement first.");
        }
        document.body.classList.add('printing-ledger');
        const cleanup = () => {
            document.body.classList.remove('printing-ledger');
            window.removeEventListener('afterprint', cleanup);
        };
        window.addEventListener('afterprint', cleanup);
        smartPrint(ledgerEl, 'Ledger', () => {
            window.print();
            // Fallback for browsers that don't fire afterprint reliably
            setTimeout(cleanup, 1000);
        }).then(() => { if (isStandaloneApp()) cleanup(); });
    }

    // ================================================================
    // FORMAL PRINT STYLE — an alternate look for Sales (Tax Invoice) and
    // Payment/Receipt (Voucher), matching a traditional Tally-style
    // printed layout. This is entirely separate from printInvoice()/
    // printInvoiceDoc() — the existing "Classic" style is completely
    // untouched, and this is only reachable via the new "Formal Print"
    // button, shown only for these three voucher types.
    // ================================================================
    function numberToWordsIndian(num) {
        const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
            'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
        const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
        function twoDigits(n) {
            if (n < 20) return a[n];
            return b[Math.floor(n / 10)] + (n % 10 ? ' ' + a[n % 10] : '');
        }
        function threeDigits(n) {
            if (n >= 100) return a[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + twoDigits(n % 100) : '');
            return twoDigits(n);
        }
        let n = Math.round(num);
        if (n === 0) return 'Zero';
        let str = '';
        const crore = Math.floor(n / 10000000); n %= 10000000;
        const lakh = Math.floor(n / 100000); n %= 100000;
        const thousand = Math.floor(n / 1000); n %= 1000;
        const hundred = n;
        if (crore) str += threeDigits(crore) + ' Crore ';
        if (lakh) str += threeDigits(lakh) + ' Lakh ';
        if (thousand) str += threeDigits(thousand) + ' Thousand ';
        if (hundred) str += threeDigits(hundred) + ' ';
        return str.trim();
    }

    const FORMAL_COMPANY_GSTIN = '21AFGFS0227N1Z2';

    // Single entry point for the one Print button in the invoice modal.
    // Reads the Style dropdown (only shown/relevant for Sales/Payment/
    // Receipt) and routes to whichever print path was chosen — Classic
    // is the existing printInvoiceDoc() flow, completely unchanged;
    // Formal is the new alternate layout, also unchanged by this change.
    function printInvoiceCurrentStyle() {
        const styleSelect = document.getElementById('invPrintStyleSelect');
        const styleWrap = document.getElementById('invPrintStyleWrap');
        const useFormal = styleWrap && styleWrap.style.display !== 'none' && styleSelect && styleSelect.value === 'formal';
        if (useFormal) {
            printFormalStyle();
        } else {
            printInvoiceDoc();
        }
    }

    // Renders the Formal print layout INSIDE this same page, in a full-
    // screen overlay with its own sticky Close button — deliberately NOT
    // a new window/tab. window.open() is unreliable on mobile: many phone
    // browsers and installed PWAs don't give a real closeable tab, they
    // just replace the current view with no way to navigate back, which
    // is exactly the "stuck, had to force-close the app" problem this
    // fixes. Closing this overlay always returns to the exact same app
    // state you were in before, with nothing to get trapped inside.
    function printFormalStyle() {
        if (!currentPrintTxnId) return;
        const txn = transactions.find(t => t.id == currentPrintTxnId);
        if (!txn) return;
        const html = (txn.type === 'Sales') ? buildFormalTaxInvoiceHtml(txn) : buildFormalVoucherHtml(txn);
        if (!html) return;

        document.getElementById('formalPrintContent').innerHTML = html;
        document.getElementById('formalPrintOverlay').style.display = 'flex';
        document.getElementById('formalPrintOverlay').style.flexDirection = 'column';
        document.body.classList.add('printing-formal');
        window.scrollTo(0, 0);
    }

    function closeFormalPrintOverlay() {
        document.getElementById('formalPrintOverlay').style.display = 'none';
        document.getElementById('formalPrintContent').innerHTML = '';
        document.body.classList.remove('printing-formal');
    }

    function printFormalDoc() {
        const txn = transactions.find(t => t.id == currentPrintTxnId);
        const node = document.getElementById('formalPrintContent');
        smartPrint(node, (txn && txn.invNo) || 'Voucher', () => window.print());
    }

    // ---- Formal Voucher (Payment / Receipt) — matches a TallyPrime-style
    // Receipt/Payment Voucher: header, No./Dated, a Particulars/Amount
    // table with the party + reference shown, "Through" account, amount
    // in words, and a signature line. ----
    function buildFormalVoucherHtml(txn) {
        const isReceipt = (txn.type === 'Receipt');
        const address = getCompanyAddress();
        const mobile = getCompanyMobile();
        const refLine = txn.refInvoiceNo ? ` <span class="small">Agst Ref&nbsp;${escapeHtml(txn.refInvoiceNo)}</span>` : '';
        return `
            <div class="outer" style="padding:16px;">
                <div class="center bold" style="font-size:15px;">Sarvadharani seeds</div>
                ${address ? `<div class="center small">${escapeHtml(address)}</div>` : ''}
                ${mobile ? `<div class="center small">Mobile: ${escapeHtml(mobile)}</div>` : ''}
                <div class="center small">GSTIN: ${FORMAL_COMPANY_GSTIN}</div>
                <div class="center bold" style="margin-top:10px; font-size:14px;">${isReceipt ? 'Receipt Voucher' : 'Payment Voucher'}</div>

                <table class="no-border" style="margin-top:14px;">
                    <tr>
                        <td class="no-border" style="width:50%;">No. : <strong>${escapeHtml(txn.invNo)}</strong></td>
                        <td class="no-border right">Dated : <strong>${txn.date}${txn.id ? ' &middot; ' + escapeHtml(new Date(Number(txn.id)).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })) : ''}</strong></td>
                    </tr>
                </table>

                <table style="margin-top:10px;">
                    <tr>
                        <th style="width:70%; text-align:left;">Particulars</th>
                        <th class="right">Amount</th>
                    </tr>
                    <tr>
                        <td>
                            <div class="bold">Account :</div>
                            <div style="padding-left:14px; margin-top:4px;">
                                ${escapeHtml(txn.partyName || 'Cash Party')}${refLine}
                            </div>
                        </td>
                        <td class="right" style="vertical-align:top;">\u20B9${txn.grandTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    </tr>
                    <tr>
                        <td colspan="2" style="height:60px;"></td>
                    </tr>
                </table>

                <table class="no-border" style="margin-top:14px;">
                    <tr>
                        <td class="no-border" style="width:15%;">Through :</td>
                        <td class="no-border">${escapeHtml(txn.accountName || 'Cash')}</td>
                    </tr>
                </table>

                <table style="margin-top:6px;">
                    <tr>
                        <td style="width:75%;">
                            <span class="bold">Amount (in words) :</span><br>
                            INR ${numberToWordsIndian(txn.grandTotal)} Only
                        </td>
                        <td class="right bold" style="vertical-align:bottom; font-size:14px;">&#8377; ${txn.grandTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    </tr>
                </table>

                <div style="margin-top:70px; text-align:right;">
                    <div class="small">Authorised Signatory</div>
                </div>
            </div>
        `;
    }

    // ---- Formal Tax Invoice (Sales) — matches a traditional GST tax
    // invoice layout: bordered header box with company + buyer/consignee
    // details, invoice metadata, a line-item table with HSN/GST/Rate/
    // Amount, a tax breakup table (Taxable/CGST/SGST/Total), amount in
    // words, bank details, and a signature line. ----
    function buildFormalTaxInvoiceHtml(txn) {
        const party = parties.find(p => p.id == txn.partyId);
        const address = getCompanyAddress();
        const mobile = getCompanyMobile();
        const tin = getCompanyTin();
        const bankName = getCompanyBankName();
        const bankAcc = getCompanyBankAcc();
        const bankIfsc = getCompanyBankIfsc();
        const isIntra = (txn.taxType !== 'INTER'); // CGST+SGST unless explicitly inter-state
        const halfTax = txn.totalTax / 2;

        const itemRows = (txn.items || []).map(it => `
            <tr>
                <td class="center">${escapeHtml(it.hsn || '')}</td>
                <td>${escapeHtml(it.name || 'Item')}</td>
                <td class="center">${it.gstRate || 0}%</td>
                <td class="right">${it.qty || 0} ${escapeHtml(it.uom || '')}</td>
                <td class="right">${(typeof it.inclRate === 'number' ? it.inclRate : 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                <td class="right">${(typeof it.lineTotal === 'number' ? it.lineTotal : 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
            </tr>
        `).join('');

        const dueAmt = invoiceOutstanding(txn);
        const paidAmt = txn.grandTotal - dueAmt;

        return `
            <div class="title">TAX INVOICE</div>
            <div class="outer">
                <table class="no-border">
                    <tr>
                        <td class="no-border" style="width:60%; border-right:1px solid #000;">
                            <div class="bold" style="font-size:14px;">Sarvadharani seeds</div>
                            ${address ? `<div class="small">${escapeHtml(address)}</div>` : ''}
                            <div class="small">GSTIN/UIN: ${FORMAL_COMPANY_GSTIN}</div>
                            ${tin ? `<div class="small">TIN No ${escapeHtml(tin)}</div>` : ''}
                            ${mobile ? `<div class="small">Contact: ${escapeHtml(mobile)}</div>` : ''}
                        </td>
                        <td class="no-border" style="width:40%; overflow:hidden;">
                            <div style="display:flex; gap:4px;">
                                <div class="small" style="flex:1; min-width:0; overflow-wrap:break-word;">Invoice No.<br><strong>${escapeHtml(txn.invNo)}</strong></div>
                                <div class="small" style="flex:1; min-width:0;">Dated<br><strong>${txn.date}${txn.id ? ' &middot; ' + escapeHtml(new Date(Number(txn.id)).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })) : ''}</strong></div>
                            </div>
                        </td>
                    </tr>
                </table>
                <table class="no-border" style="border-top:1px solid #000;">
                    <tr>
                        <td class="no-border">
                            <div class="small bold">Buyer (Bill to)</div>
                            <div class="bold">${escapeHtml(txn.partyName)}</div>
                            ${party && party.address ? `<div class="small">${escapeHtml(party.address)}</div>` : ''}
                            ${party && party.gstin ? `<div class="small">GSTIN/UIN: ${escapeHtml(party.gstin)}</div>` : ''}
                            ${party && party.phone ? `<div class="small">Contact: ${escapeHtml(party.phone)}</div>` : ''}
                        </td>
                    </tr>
                </table>

                <div class="itemTableScroll">
                <table style="border-top:1px solid #000;">
                    <tr>
                        <th class="center small">HSN/SAC</th>
                        <th class="small">Description of Goods</th>
                        <th class="center small">GST Rate</th>
                        <th class="right small">Quantity</th>
                        <th class="right small">Rate (Incl. Tax)</th>
                        <th class="right small">Amount</th>
                    </tr>
                    ${itemRows}
                    <tr>
                        <td colspan="5" class="right bold no-border">Total</td>
                        <td class="right bold">\u20B9${txn.grandTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    </tr>
                </table>
                </div>

                <table class="no-border">
                    <tr>
                        <td class="no-border" colspan="2">
                            <span class="bold small">Amount Chargeable (in words):</span><br>
                            <span class="small">INR ${numberToWordsIndian(txn.grandTotal)} Only</span>
                        </td>
                    </tr>
                </table>

                <table style="border-top:1px solid #000;">
                    <tr>
                        <th class="small">Taxable Value</th>
                        <th class="small" colspan="2">CGST</th>
                        <th class="small" colspan="2">SGST/UTGST</th>
                        <th class="small">Total Tax</th>
                    </tr>
                    <tr>
                        <td class="right">${txn.taxable.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        <td class="center small">${isIntra ? (txn.items[0] ? (txn.items[0].gstRate / 2) : 0) : 0}%</td>
                        <td class="right">${isIntra ? halfTax.toLocaleString('en-IN', {minimumFractionDigits: 2}) : '0.00'}</td>
                        <td class="center small">${isIntra ? (txn.items[0] ? (txn.items[0].gstRate / 2) : 0) : 0}%</td>
                        <td class="right">${isIntra ? halfTax.toLocaleString('en-IN', {minimumFractionDigits: 2}) : '0.00'}</td>
                        <td class="right bold">${txn.totalTax.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    </tr>
                </table>

                ${dueAmt > 0.001 || paidAmt > 0.001 ? `
                <table class="no-border" style="border-top:1px solid #000;">
                    <tr>
                        <td class="no-border right small">Paid: <strong>\u20B9${paidAmt.toLocaleString('en-IN', {minimumFractionDigits: 2})}</strong> &nbsp;&nbsp; Balance Due: <strong>\u20B9${dueAmt.toLocaleString('en-IN', {minimumFractionDigits: 2})}</strong></td>
                    </tr>
                </table>` : ''}

                <table class="no-border" style="border-top:1px solid #000;">
                    <tr>
                        <td class="no-border small" style="width:60%;">
                            ${(bankName || bankAcc || bankIfsc) ? `
                                <span class="bold">Company's Bank Details</span><br>
                                ${bankName ? `Bank Name: ${escapeHtml(bankName)}<br>` : ''}
                                ${bankAcc ? `A/c No.: ${escapeHtml(bankAcc)}<br>` : ''}
                                ${bankIfsc ? `Branch &amp; IFSC Code: ${escapeHtml(bankIfsc)}` : ''}
                            ` : ''}
                        </td>
                        <td class="no-border right" style="vertical-align:bottom;">
                            <div class="small">for Sarvadharani seeds</div>
                            <div style="margin-top:50px;" class="small">Authorised Signatory</div>
                        </td>
                    </tr>
                </table>
            </div>
            <div class="center small" style="margin-top:6px;">This is a Computer Generated Invoice</div>
        `;
    }


    function printInvoiceDoc() {
        if (!isAdmin() && !hasPermission('exportPrint')) return alert("Only an admin, or a user with 'Export / print' turned on, can print or export.");
        document.body.classList.add('printing-invoice');
        const cleanup = () => {
            document.body.classList.remove('printing-invoice');
            window.removeEventListener('afterprint', cleanup);
        };
        window.addEventListener('afterprint', cleanup);
        const txn = transactions.find(t => t.id == currentPrintTxnId);
        const invoiceBox = document.querySelector('#invoiceModal .invoice-box');
        smartPrint(invoiceBox, (txn && txn.invNo) || 'Invoice', () => {
            window.print();
            setTimeout(cleanup, 1000);
        }).then(() => { if (isStandaloneApp()) cleanup(); });
    }
    // ---------------------------------------------------

    // Refills the Stock Group and Ledger Group dropdown selects (on the
    // Item form and the Account form) from current data, keeping whatever
    // was already chosen selected.
    function populateGroupDropdowns() {
        const itemGroupSel = document.getElementById('itemGroup');
        const prevItemGroup = itemGroupSel.value;
        itemGroupSel.innerHTML = '<option value="">-- Select Group --</option>';
        stockGroups.forEach(g => itemGroupSel.innerHTML += `<option value="${g.id}">${escapeHtml(g.name)}</option>`);
        if (prevItemGroup) itemGroupSel.value = prevItemGroup;

        const acctGroupSel = document.getElementById('acctGroup');
        const prevAcctGroup = acctGroupSel.value;
        acctGroupSel.innerHTML = '<option value="">-- Select Group --</option>';
        ledgerGroups.forEach(g => acctGroupSel.innerHTML += `<option value="${g.id}">${escapeHtml(g.name)} (${g.nature})</option>`);
        if (prevAcctGroup) acctGroupSel.value = prevAcctGroup;

        const pGroupSel = document.getElementById('pGroup');
        const prevPGroup = pGroupSel.value;
        pGroupSel.innerHTML = '<option value="">-- Select Group --</option>';
        ledgerGroups.forEach(g => pGroupSel.innerHTML += `<option value="${g.id}">${escapeHtml(g.name)} (${g.nature})</option>`);
        if (prevPGroup) pGroupSel.value = prevPGroup;
    }

    // Renders the Stock Groups and Ledger Groups management tables, each
    // showing how many items/ledgers currently sit in that group.
    // Drill-down: list items filed under a stock group.
    function viewGroupStock(groupId) {
        const g = stockGroups.find(s => s.id == groupId);
        if (!g) return;
        document.getElementById('groupStockPanelTitle').innerText = `Items in "${g.name}"`;

        const body = document.getElementById('groupStockBody');
        body.innerHTML = '';
        const items = stockItems.filter(i => i.groupId == groupId);

        if (items.length === 0) {
            body.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No items in this group yet.</td></tr>';
        }
        items.forEach(i => {
            const val = i.qty * i.rate;
            body.innerHTML += `
                <tr onclick="viewStockItem(${i.id})" style="cursor:pointer;" title="View item summary">
                    <td><strong>${escapeHtml(i.name)}</strong></td>
                    <td>${escapeHtml(i.hsn)}</td>
                    <td style="color:${i.qty < 5 ? 'var(--danger)' : 'var(--success)'}; font-weight:bold;">${i.qty} ${escapeHtml(i.uom)}</td>
                    <td>\u20B9${i.rate.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    <td>\u20B9${val.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                </tr>
            `;
        });
        openPanel('panelGroupStock');
    }

    // Single item: headline summary + every transaction touching it.
    let currentStockItemViewId = null;
    function viewStockItem(itemId) {
        currentStockItemViewId = itemId;
        const item = stockItems.find(s => s.id == itemId);
        if (!item) return;
        document.getElementById('itemViewTitle').innerText = item.name;
        document.getElementById('ivMeta').innerHTML =
            `HSN: <strong>${escapeHtml(item.hsn)}</strong> &nbsp;|&nbsp; Unit: <strong>${escapeHtml(item.uom)}</strong> `
            + `&nbsp;|&nbsp; GST: <strong>${item.gstRate}%</strong> &nbsp;|&nbsp; Group: <strong>${escapeHtml(getStockGroupName(item.groupId))}</strong>`;

        let purchased = 0, sold = 0, rawPurchased = 0;
        const rows = [];
        const openingAsOf = item.openingAsOf || '2000-01-01';
        transactions.forEach(t => {
            if (!t.items) return;
            if (t.optional || t.deliveryNote || t.conversion) return; // optional/delivery/conversion stay off the main item view
            t.items.forEach(line => {
                if (line.itemId != itemId) return;
                // Purchased/Sold only count from this item's own opening-
                // balance date onward — same as the In Stock figure itself
                // (see netLedgerQtyByItem) — so Opening + Purchased - Sold
                // still reconciles to In Stock after a financial year
                // rollover. The transaction list below stays unfiltered:
                // past vouchers are never deleted or hidden, only excluded
                // from this running total once they're folded into Opening.
                if (!(t.date < openingAsOf)) {
                    if (t.type === 'Purchase') purchased += line.qty;
                    if (t.type === 'RawPurchase') rawPurchased += line.qty;
                    if (t.type === 'Sales') sold += line.qty;
                }
                rows.push({ date: t.date, type: t.rawPurchase ? 'Raw Purchase' : t.type, invNo: t.invNo, party: t.partyName, partyId: t.partyId,
                            qty: line.qty, uom: line.uom, rate: line.inclRate,
                            amount: line.lineTotal != null ? line.lineTotal : line.inclRate * line.qty,
                            openId: t.id });
            });
        });

        document.getElementById('ivStock').innerText = `${item.qty} ${item.uom}`;
        document.getElementById('ivStock').style.color = item.qty < 0 ? 'var(--danger)' : 'var(--accent)';
        document.getElementById('ivOpening').innerText = `${item.openingQty || 0} ${item.uom}`;
        document.getElementById('ivOpeningAsOf').innerText = item.openingAsOf ? `as of ${item.openingAsOf} (FY close)` : '';
        document.getElementById('ivOpeningResetWrap').style.display = (item.openingQty || 0) === 0 ? 'none' : 'block';
        document.getElementById('ivPurch').innerText = `${purchased} ${item.uom}`;
        document.getElementById('ivRawPurch').innerText = `${rawPurchased} ${item.uom}`;
        document.getElementById('ivSold').innerText = `${sold} ${item.uom}`;
        document.getElementById('ivValue').innerText = `\u20B9${(item.qty * item.rate).toLocaleString('en-IN', {minimumFractionDigits: 2})}`;

        const body = document.getElementById('itemTxnBody');
        body.innerHTML = '';
        if (rows.length === 0) {
            body.innerHTML = '<tr><td colspan="8" style="text-align:center; color:var(--text-muted);">No transactions for this item yet.</td></tr>';
        } else {
            rows.sort((a, b) => new Date(b.date) - new Date(a.date));
            rows.forEach(r => {
                const color = r.type === 'Sales' ? 'var(--success)' : 'var(--accent)';
                body.innerHTML += `
                    <tr style="cursor:pointer;" title="Open invoice">
                        <td onclick="printInvoice(${r.openId})">${r.date}</td>
                        <td onclick="printInvoice(${r.openId})" style="color:${color}; font-weight:bold;">${r.type}</td>
                        <td onclick="printInvoice(${r.openId})">${escapeHtml(r.invNo)}</td>
                        <td style="color:var(--accent); text-decoration:underline;" onclick="event.stopPropagation(); openPartyLedgerFromReport(${r.partyId})" title="Open party ledger">${escapeHtml(r.party)}</td>
                        <td onclick="printInvoice(${r.openId})">${r.qty} ${escapeHtml(r.uom)}</td>
                        <td onclick="printInvoice(${r.openId})">\u20B9${r.rate.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        <td onclick="printInvoice(${r.openId})" style="font-weight:bold;">\u20B9${r.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    </tr>
                `;
            });
        }
        openPanel('panelStockItemView');
    }

    function renderGroupTables() {
        const sgBody = document.getElementById('stockGroupsBody');
        sgBody.innerHTML = '';
        if (stockGroups.length === 0) {
            sgBody.innerHTML = '<tr><td colspan="3" style="text-align:center; color:var(--text-muted);">No stock groups yet.</td></tr>';
        }
        stockGroups.forEach(g => {
            const count = stockItems.filter(i => i.groupId == g.id).length;
            sgBody.innerHTML += `
                <tr style="cursor:pointer;">
                    <td onclick="viewGroupStock(${g.id})"><strong>${escapeHtml(g.name)}</strong></td>
                    <td onclick="viewGroupStock(${g.id})">${count}</td>
                    <td style="display:flex; gap:6px;">
                        <button onclick="event.stopPropagation(); editStockGroup(${g.id})" style="padding:4px 10px; font-size:0.75rem; width:auto;">Edit</button>
                        <button onclick="event.stopPropagation(); deleteStockGroup(${g.id})" class="btn-danger" style="padding:4px 10px; font-size:0.75rem;">Delete</button>
                    </td>
                </tr>
            `;
        });

        const lgBody = document.getElementById('ledgerGroupsBody');
        lgBody.innerHTML = '';
        if (ledgerGroups.length === 0) {
            lgBody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">No ledger groups yet.</td></tr>';
        }
        ledgerGroups.forEach(g => {
            const acctCount = accounts.filter(a => a.groupId == g.id).length;
            const partyCount = parties.filter(p => p.groupId == g.id).length;
            const count = acctCount + partyCount;
            lgBody.innerHTML += `
                <tr onclick="viewGroupLedgers(${g.id})" style="cursor:pointer;">
                    <td><strong>${escapeHtml(g.name)}</strong></td>
                    <td>${escapeHtml(g.nature || '-')}</td>
                    <td>${count}</td>
                    <td style="display:flex; gap:6px;">
                        <button onclick="event.stopPropagation(); editLedgerGroup(${g.id})" style="padding:4px 10px; font-size:0.75rem; width:auto;">Edit</button>
                        <button onclick="event.stopPropagation(); deleteLedgerGroup(${g.id})" class="btn-danger" style="padding:4px 10px; font-size:0.75rem;">Delete</button>
                    </td>
                </tr>
            `;
        });
    }

    // Shows every ledger (party or cash/bank account) filed under a clicked
    // Ledger Group, each row opening straight into that ledger's statement.
    let currentGroupLedgerId = null;

    function viewGroupLedgers(groupId) {
        const g = ledgerGroups.find(l => l.id == groupId);
        if (!g) return;
        currentGroupLedgerId = groupId;
        document.getElementById('groupLedgersPanelTitle').innerText = `Ledgers under "${g.name}"`;

        const body = document.getElementById('groupLedgersBody');
        body.innerHTML = '';

        const groupParties = parties.filter(p => p.groupId == groupId);
        const groupAccounts = accounts.filter(a => a.groupId == groupId);

        if (groupParties.length === 0 && groupAccounts.length === 0) {
            body.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">No ledgers in this group yet.</td></tr>';
        }

        groupParties.forEach(p => {
            const pTxns = transactions.filter(t => t.partyId == p.id);
            const dr = pTxns.filter(t => t.type === 'Sales' || t.type === 'Payment').reduce((a, c) => a + c.grandTotal, 0);
            const cr = pTxns.filter(t => t.type === 'Purchase' || t.type === 'RawPurchase' || t.type === 'Receipt').reduce((a, c) => a + c.grandTotal, 0);
            const net = dr - cr;
            const balTxt = net > 0 ? `\u20B9${net.toLocaleString('en-IN', {minimumFractionDigits: 2})} (Dr)` : net < 0 ? `\u20B9${Math.abs(net).toLocaleString('en-IN', {minimumFractionDigits: 2})} (Cr)` : 'Settled';
            const balColor = net > 0 ? 'var(--accent)' : net < 0 ? 'var(--danger)' : 'var(--text-muted)';
            body.innerHTML += `
                <tr style="cursor:pointer;">
                    <td onclick="openLedgerStatement('party', ${p.id})"><strong>${escapeHtml(p.name)}</strong></td>
                    <td onclick="openLedgerStatement('party', ${p.id})"><span style="font-size:0.75rem; background:#1e293b; padding:2px 6px; border-radius:4px;">Party (${escapeHtml(p.type)})</span></td>
                    <td onclick="openLedgerStatement('party', ${p.id})" style="color:${balColor}; font-weight:bold;">${balTxt}</td>
                    <td><button onclick="event.stopPropagation(); deletePartyFromGroup(${p.id})" class="btn-danger" style="padding:4px 10px; font-size:0.75rem;">Delete</button></td>
                </tr>
            `;
        });

        groupAccounts.forEach(a => {
            const bal = accountBalance(a.id);
            body.innerHTML += `
                <tr style="cursor:pointer;">
                    <td onclick="openLedgerStatement('account', ${a.id})"><strong>${escapeHtml(a.name)}</strong></td>
                    <td onclick="openLedgerStatement('account', ${a.id})"><span style="font-size:0.75rem; background:#1e293b; padding:2px 6px; border-radius:4px;">Account (${escapeHtml(a.type)})</span></td>
                    <td onclick="openLedgerStatement('account', ${a.id})" style="color:${bal < 0 ? 'var(--danger)' : 'var(--success)'}; font-weight:bold;">\u20B9${bal.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    <td><button onclick="event.stopPropagation(); deleteAccount(${a.id})" class="btn-danger" style="padding:4px 10px; font-size:0.75rem;">Delete</button></td>
                </tr>
            `;
        });

        openPanel('panelGroupLedgers');
    }

    // Delete a party from within the group view. Blocked if the party has
    // any transactions (protects the ledger's integrity).
    async function deletePartyFromGroup(partyId) {
        if (!isAdmin() && !hasPermission('deleteParty')) return alert("Only an admin, or a user with 'Delete a party' turned on, can delete a party.");
        const p = parties.find(x => x.id == partyId);
        if (!p) return;
        const hasTxns = transactions.some(t => t.partyId == partyId);
        if (hasTxns) return alert(`Cannot delete "${p.name}": there are transactions linked to this party. Delete those vouchers first.`);
        if (!(await confirmAsync(`Delete party "${p.name}"? This cannot be undone.`))) return;
        parties = parties.filter(x => x.id != partyId);
        localStorage.setItem('tally_mob_parties', JSON.stringify(parties));
        syncCloud();
        render();
        if (currentGroupLedgerId) viewGroupLedgers(currentGroupLedgerId);
    }

    let daybookRowOrder = [];
    function render() {  
        recalcStockFromLedger(); // keep "In Stock" mathematically tied to Purchased/Sold on every redraw — see definition above
        populateGroupDropdowns();
        renderGroupTables();
        populateCustomVoucherTypeOptions();

        const vPartyHidden = document.getElementById('vParty');  
        const prevParty = vPartyHidden.value;

        // Restore the voucher-entry party search box's selection (if that
        // party still exists) after this re-render, since it's a text
        // input now instead of a <select> with options.
        const stillExists = parties.find(p => p.id == prevParty);
        if (stillExists) {
            document.getElementById('vPartySearch').value = stillExists.name;
            vPartyHidden.value = stillExists.id;
        } else {
            document.getElementById('vPartySearch').value = '';
            vPartyHidden.value = '';
        }
        const vPartyClearBtnEl = document.getElementById('vPartyClearBtn');
        if (vPartyClearBtnEl) vPartyClearBtnEl.style.display = document.getElementById('vPartySearch').value ? 'block' : 'none';
  
        const vItemHidden = document.getElementById('vItem');
        const prevItem = vItemHidden.value;

        // Restore the voucher-entry item search box's selection (if that
        // item still exists) after this re-render, for the same reason
        // as the party search box above.
        const itemStillExists = stockItems.find(s => s.id == prevItem);
        if (itemStillExists) {
            document.getElementById('vItemSearch').value = itemStillExists.name;
            vItemHidden.value = itemStillExists.id;
        } else {
            document.getElementById('vItemSearch').value = '';
            vItemHidden.value = '';
        }

        // Accounts table + dropdown
        const acctBody = document.getElementById('accountsBody');
        acctBody.innerHTML = '';
        if (accounts.length === 0) {
            acctBody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">No accounts yet. Create Cash / Bank / Capital above.</td></tr>';
        }
        accounts.forEach(a => {
            const bal = accountBalance(a.id);
            acctBody.innerHTML += `
                <tr>
                    <td><strong>${escapeHtml(a.name)}</strong></td>
                    <td>${escapeHtml(a.type)}</td>
                    <td><span class="group-badge${a.groupId ? '' : ' muted'}">${escapeHtml(getLedgerGroupName(a.groupId))}</span></td>
                    <td>\u20B9${(a.opening || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    <td style="color:${bal < 0 ? 'var(--danger)' : 'var(--success)'}; font-weight:bold;">\u20B9${bal.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                    <td style="display:flex; gap:6px;">
                        <button onclick="editAccount(${a.id})" style="padding:4px 10px; font-size:0.75rem; width:auto;">Edit</button>
                        <button onclick="deleteAccount(${a.id})" class="btn-danger" style="padding:4px 10px; font-size:0.75rem;">Delete</button>
                    </td>
                </tr>
            `;
        });
        if (document.getElementById('paymentPanel').style.display === 'block') {
            populateAccountDropdown();
            populateRefInvoices();
        }
  
        renderStockSummary();

        const lBody = document.getElementById('ledgerBody');  
        lBody.innerHTML = '';  
        daybookRowOrder = [];
        sortByDate(transactions, 'daybook').forEach(t => {  
            if (t.optional || t.deliveryNote || t.conversion) return; // shown in their own tiles instead
            const isCash = (t.type === 'Payment' || t.type === 'Receipt');
            const isJournalTxn = (t.type === 'Journal');
            const noPartyCustom = isCustomNoPartyType(t.type);
            const typeLabel = noPartyCustom ? escapeHtml(t.customVoucherTypeName || 'Custom') : escapeHtml(t.type);
            const detailCol = isJournalTxn
                ? `Dr ${escapeHtml(t.journalDebit ? t.journalDebit.name : 'Unknown')} &rarr; Cr ${escapeHtml(t.journalCredit ? t.journalCredit.name : 'Unknown')}`
                : noPartyCustom
                ? (t.subLedger ? escapeHtml(t.subLedger) + ' | ' : '') + escapeHtml(t.accountName || 'Cash')
                : isCash ? (escapeHtml(t.accountName || 'Cash') + (t.refInvoiceNo ? ' &rarr; ' + escapeHtml(t.refInvoiceNo) : '')) : `${t.items ? t.items.length : 1} item(s)`;
            const narrationHint = t.narration ? `<div style="font-size:0.7rem; color:var(--text-muted); font-style:italic; margin-top:2px;">${escapeHtml(t.narration)}</div>` : '';
            // Only genuine invoice-style vouchers (Sales/Purchase/RawPurchase/
            // custom party types) have a real printable invoice — Journal,
            // Payment/Receipt, and no-party custom types (e.g. Expense) don't
            // go through printInvoice's normal item-based layout, so they're
            // left out of batch-print selection here (same reasoning as
            // Processed Report being skipped entirely).
            const isSelectable = !isCash && !isJournalTxn && !noPartyCustom;
            const actionBtn = (isCash || noPartyCustom || isJournalTxn) ? '' : `<button onclick="printInvoice(${t.id})" class="btn-success" style="padding:4px 10px; font-size:0.75rem;">Invoice</button>`;
            const partyCol = (noPartyCustom || isJournalTxn)
                ? '<span style="color:var(--text-muted);">&mdash;</span>'
                : `<span style="color:var(--accent); text-decoration:underline; cursor:pointer;" onclick="openPartyLedgerFromReport(${t.partyId})" title="Open party ledger">${escapeHtml(t.partyName)}</span>`;
            if (isSelectable) daybookRowOrder.push(t.id);
            const checkboxCell = isSelectable
                ? `<input type="checkbox" data-select-key="daybook" data-select-id="${t.id}" onchange="toggleRowSelection('daybook', ${t.id}, this.checked)">`
                : '';
            lBody.innerHTML += `  
                <tr>  
                    <td class="no-print" data-select-col="daybook" style="display:none;">${checkboxCell}</td>
                    <td>${t.date}</td>  
                    <td><strong>${typeLabel}</strong></td>  
                    <td>${partyCol}</td>  
                    <td>${detailCol}${narrationHint}</td>  
                    <td>\u20B9${t.grandTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>  
                    <td style="display:flex; gap:6px;">
                        ${actionBtn}
                        <button onclick="deleteTransaction(${t.id})" class="btn-danger" style="padding:4px 10px; font-size:0.75rem;">Delete</button>
                    </td>  
                </tr>  
            `;  
        });  

        let salesSum = 0, purSum = 0, outputGst = 0, inputGst = 0;
        transactions.forEach(t => {
            if (t.type === 'Sales') {
                salesSum += t.taxable;
                outputGst += t.totalTax;
            } else if (t.type === 'Purchase') {
                purSum += t.taxable;
                inputGst += t.totalTax;
            }
        });

        // Pending receivable / payable, computed per party so overpayments
        // on one party never cancel another party's dues.
        let totalReceivable = 0, totalPayable = 0;
        parties.forEach(p => {
            const pTx = transactions.filter(t => t.partyId == p.id);
            const sales = pTx.filter(t => t.type === 'Sales').reduce((a, c) => a + c.grandTotal, 0);
            const receipts = pTx.filter(t => t.type === 'Receipt').reduce((a, c) => a + c.grandTotal, 0);
            const purchases = pTx.filter(t => t.type === 'Purchase' || t.type === 'RawPurchase').reduce((a, c) => a + c.grandTotal, 0);
            const payments = pTx.filter(t => t.type === 'Payment').reduce((a, c) => a + c.grandTotal, 0);

            const owedToUs = sales - receipts;      // customer still owes us
            const weOwe = purchases - payments;     // we still owe vendor
            if (owedToUs > 0) totalReceivable += owedToUs;
            if (weOwe > 0) totalPayable += weOwe;
        });

        document.getElementById('statReceivable').innerText = `\u20B9${totalReceivable.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
        document.getElementById('statPayable').innerText = `\u20B9${totalPayable.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
        renderRecentTransactions();
        // Net GST Liability is now shown only in Reports > GST Liability
        // (see panelGstLiability / renderGstLiability), not on the
        // dashboard, so there's no #statGst element to write to any more.

        // Keep the Conversion screen's raw/processed item lists (and stock
        // availability note) in sync if it happens to be open — stock can
        // change from any voucher, including a Raw Purchase posted elsewhere.
        const convPanel = document.getElementById('panelConversion');
        if (convPanel && convPanel.classList.contains('active')) {
            populateConversionDropdowns();
        }
        const rawPanel = document.getElementById('panelRawPurchase');
        if (rawPanel && rawPanel.classList.contains('active')) {
            populateRawPurchaseDropdowns();
        }
    }  
  
    render();  



/* =========================================================
   SARVADHARANI SEEDS — Feature extras (loaded AFTER app.js)
   Adds: e-Way Bill JSON, Weekly backup (JSON + Excel),
         PWA install prompt, Print alignment templates.
   Does NOT touch Firebase or any existing app function.
========================================================= */
(function () {
    'use strict';

    // ---- Company defaults (used by e-Way bill) ----
    // addr1 is shared with the Settings > Company Address field (see
    // COMPANY_ADDRESS_KEY in the main app script) so there's one true
    // source for the business address rather than two that can drift
    // apart. Falls back to the original placeholder only if Settings
    // has never been used to set a real address yet.
    const COMPANY = {
        gstin: '21AFGFS0227N1Z2',
        name: 'Sarvadharani seeds',
        stateCode: 21, // from GSTIN prefix
        addr1: localStorage.getItem('sarva_company_address') || 'Sarvadharani Seeds Office',
        pincode: 495001,
        place: 'Bilaspur'
    };

    // ==============================================================
    // 1) PRINT ALIGNMENT TEMPLATES (A4 / A5 / 80mm / 58mm thermal)
    // ==============================================================
    const PAPER_SIZES = {
        'a4':   { label: 'A4 (Standard)',   size: 'A4',        margin: '12mm' },
        'a5':   { label: 'A5 (Half sheet)', size: 'A5',        margin: '8mm'  },
        '80mm': { label: 'Thermal 80 mm',   size: '80mm auto', margin: '3mm'  },
        '58mm': { label: 'Thermal 58 mm',   size: '58mm auto', margin: '2mm'  }
    };
    const PAPER_KEY = 'ss_paperSize';

    function getPaperSize() {
        return localStorage.getItem(PAPER_KEY) || 'a4';
    }
    function setPaperSize(k) {
        if (!PAPER_SIZES[k]) return;
        localStorage.setItem(PAPER_KEY, k);
        document.querySelectorAll('.paperSizeSelect').forEach(s => (s.value = k));
        // Update body class for live preview
        Object.keys(PAPER_SIZES).forEach(x => document.body.classList.remove('paper-' + x));
        document.body.classList.add('paper-' + k);
        if (window.showSyncToast) window.showSyncToast('ok', `Print size: ${PAPER_SIZES[k].label}`);
    }
    window.setPaperSize = setPaperSize;

    function injectPageStyle() {
        const k = getPaperSize();
        const cfg = PAPER_SIZES[k];
        let el = document.getElementById('paperSizeStyle');
        if (!el) {
            el = document.createElement('style');
            el.id = 'paperSizeStyle';
            document.head.appendChild(el);
        }
        el.textContent = `@media print { @page { size: ${cfg.size}; margin: ${cfg.margin}; } }`;
        Object.keys(PAPER_SIZES).forEach(x => document.body.classList.remove('paper-' + x));
        document.body.classList.add('paper-' + k);
    }

    // Monkey-patch existing print functions to inject page-size before print
    const _origPrintInvoiceDoc = window.printInvoiceDoc;
    if (typeof _origPrintInvoiceDoc === 'function') {
        window.printInvoiceDoc = function () {
            injectPageStyle();
            return _origPrintInvoiceDoc.apply(this, arguments);
        };
    }
    const _origPrintLedger = window.printLedger;
    if (typeof _origPrintLedger === 'function') {
        window.printLedger = function () {
            injectPageStyle();
            return _origPrintLedger.apply(this, arguments);
        };
    }
    const _origPrintRegion = window.printRegion;
    if (typeof _origPrintRegion === 'function') {
        window.printRegion = function () {
            injectPageStyle();
            return _origPrintRegion.apply(this, arguments);
        };
    }

    // ==============================================================
    // 2) WEEKLY BACKUP (JSON + Excel via SheetJS)
    // ==============================================================
    const BACKUP_KEY = 'ss_lastBackupAt';

    function readLS(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (raw == null) return fallback;
            const val = JSON.parse(raw);
            return val == null ? fallback : val;
        } catch (e) { return fallback; }
    }

    function appState() {
        // Prefer live IIFE globals if the host page attaches them; otherwise
        // fall back to the localStorage keys the app already persists on every
        // save. This makes the extras robust regardless of scoping.
        return {
            parties:            (window.parties            !== undefined) ? window.parties            : readLS('tally_mob_parties',      []),
            stockItems:         (window.stockItems         !== undefined) ? window.stockItems         : readLS('tally_mob_stock',        []),
            transactions:       (window.transactions       !== undefined) ? window.transactions       : readLS('tally_mob_db',           []),
            accounts:           (window.accounts           !== undefined) ? window.accounts           : readLS('tally_mob_accounts',     []),
            stockGroups:        (window.stockGroups        !== undefined) ? window.stockGroups        : readLS('tally_mob_stockgroups',  []),
            ledgerGroups:       (window.ledgerGroups       !== undefined) ? window.ledgerGroups       : readLS('tally_mob_ledgergroups', []),
            refCounter:         (window.refCounter         !== undefined) ? window.refCounter         : readLS('tally_mob_refcounter',   {}),
            subLedgers:         (window.subLedgers         !== undefined) ? window.subLedgers         : readLS('tally_mob_subledgers',   []),
            customVoucherTypes: (window.customVoucherTypes !== undefined) ? window.customVoucherTypes : readLS('tally_mob_vouchertypes', [])
        };
    }

    function collectAppData() {
        const s = appState();
        return {
            _meta: {
                app: 'sarvadharani-seeds',
                exportedAt: new Date().toISOString(),
                schemaVersion: 1,
                companyGstin: COMPANY.gstin
            },
            parties: s.parties,
            stockItems: s.stockItems,
            transactions: s.transactions,
            accounts: s.accounts,
            stockGroups: s.stockGroups,
            ledgerGroups: s.ledgerGroups,
            refCounter: s.refCounter,
            subLedgers: s.subLedgers,
            customVoucherTypes: s.customVoucherTypes
        };
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 300);
    }

    function backupJSON() {
        const data = collectAppData();
        const stamp = new Date().toISOString().slice(0, 10);
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        downloadBlob(blob, `sarvadharani-backup-${stamp}.json`);
        markBackupDone('json');
    }
    window.backupJSON = backupJSON;

    function ensureSheetJS() {
        return new Promise((resolve, reject) => {
            if (window.XLSX) return resolve(window.XLSX);
            const s = document.createElement('script');
            s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
            s.onload = () => resolve(window.XLSX);
            s.onerror = () => reject(new Error('Could not load SheetJS'));
            document.head.appendChild(s);
        });
    }

    async function backupExcel() {
        try {
            const XLSX = await ensureSheetJS();
            const data = collectAppData();
            const wb = XLSX.utils.book_new();

            const partiesFlat = (data.parties || []).map(p => ({
                Name: p.name, Type: p.type, Phone: p.phone, GSTIN: p.gstin,
                Address: p.address, LedgerGroupId: p.groupId,
                Opening: p.opening || 0, Opening_As_Of: p.openingAsOf || ''
            }));
            const itemsFlat = (data.stockItems || []).map(s => ({
                Name: s.name, HSN: s.hsn, UOM: s.uom, GST_Rate: s.gstRate,
                Rate: s.rate, Current_Qty: s.qty, Opening_Qty: s.openingQty || 0,
                Opening_As_Of: s.openingAsOf || '', StockGroupId: s.groupId
            }));
            const acctFlat = (data.accounts || []).map(a => ({
                Name: a.name, Type: a.type, LedgerGroupId: a.groupId,
                Opening: a.opening, Opening_As_Of: a.openingAsOf || ''
            }));
            const txnFlat = (data.transactions || []).map(t => ({
                Date: t.date, Type: t.type, Voucher_No: t.invNo, Party_Id: t.partyId,
                Grand_Total: t.grandTotal, Tax_Total: t.totalTax, Tax_Type: t.taxType,
                Narration: t.narration, Item_Lines: (t.items || []).length,
                Ref_Invoice: t.againstInvoiceId || '', Account_Id: t.accountId || '',
                Amount: t.amount || '', Vehicle_No: t.vehicleNo || '',
                Driver_Name: t.driverName || ''
            }));
            const linesFlat = [];
            (data.transactions || []).forEach(t => (t.items || []).forEach(it => {
                linesFlat.push({
                    Date: t.date, Voucher_No: t.invNo, Type: t.type,
                    Item_Id: it.itemId, Qty: it.qty, Incl_Rate: it.inclRate,
                    GST_Rate: it.gstRate, Taxable: it.taxable, Tax: it.taxAmount, Total: it.lineTotal
                });
            }));

            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(partiesFlat), 'Parties');
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(itemsFlat), 'Stock Items');
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(acctFlat), 'Accounts');
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(txnFlat), 'Vouchers');
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linesFlat), 'Voucher Lines');
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.stockGroups || []), 'Stock Groups');
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.ledgerGroups || []), 'Ledger Groups');

            const stamp = new Date().toISOString().slice(0, 10);
            XLSX.writeFile(wb, `sarvadharani-backup-${stamp}.xlsx`);
            markBackupDone('excel');
        } catch (e) {
            alert('Excel backup failed: ' + e.message);
        }
    }
    window.backupExcel = backupExcel;

    function markBackupDone(kind) {
        localStorage.setItem(BACKUP_KEY, new Date().toISOString());
        hideBackupBanner();
        if (window.showSyncToast) window.showSyncToast('ok', `${kind === 'excel' ? 'Excel' : 'JSON'} backup saved`);
    }

    function daysSinceBackup() {
        const last = localStorage.getItem(BACKUP_KEY);
        if (!last) return Infinity;
        return (Date.now() - new Date(last).getTime()) / 86400000;
    }

    // ==============================================================
    // 3) PWA — install prompt & iOS home-screen hint
    // ==============================================================
    let deferredInstallPrompt = null;

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstallPrompt = e;
        const btn = document.getElementById('pwaInstallBtn');
        if (btn) btn.style.display = '';
    });

    function triggerInstall() {
        if (deferredInstallPrompt && typeof deferredInstallPrompt.prompt === 'function') {
            try {
                deferredInstallPrompt.prompt();
                if (deferredInstallPrompt.userChoice && typeof deferredInstallPrompt.userChoice.then === 'function') {
                    deferredInstallPrompt.userChoice.then(() => {
                        deferredInstallPrompt = null;
                        const btn = document.getElementById('pwaInstallBtn');
                        if (btn) btn.style.display = 'none';
                    });
                } else {
                    deferredInstallPrompt = null;
                }
                return;
            } catch (err) {
                console.warn('Install prompt threw, falling back to manual guide:', err);
                deferredInstallPrompt = null;
            }
        }
        if (isIOS()) {
            alert("To install on iPhone/iPad:\n\n1. Tap the Share icon (square with arrow) at the bottom of Safari.\n2. Scroll and tap 'Add to Home Screen'.\n3. Tap 'Add' — Sarvadharani will appear like a normal app.");
        } else {
            alert("To install on your device:\n\n• Chrome (Android/Desktop): Menu → 'Install app' / 'Add to Home screen'.\n• Firefox: Menu → 'Install'.\n• Safari (Mac): File → 'Add to Dock'.\n\nWorks best when this page is opened from a real URL (not a local file).");
        }
    }
    window.triggerInstall = triggerInstall;

    function isIOS() {
        return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    }
    function isStandalone() {
        return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
            || window.navigator.standalone === true;
    }

    // Register service worker only when served from a real URL (not file://)
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('sw.js').catch(err => {
                console.warn('SW register failed (safe to ignore if sw.js not hosted):', err.message);
            });
        });
    }

    // ==============================================================
    // 4) E-WAY BILL DRAFT — generate JSON per portal schema
    // ==============================================================
    function toDDMMYYYY(iso) {
        // iso may be "2026-02-15" or full ISO. Return "15/02/2026"
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
    }

    function stateCodeFromGstin(gstin) {
        if (!gstin || gstin.length < 2) return null;
        const n = parseInt(gstin.slice(0, 2), 10);
        return isNaN(n) ? null : n;
    }

    function unitCodeFor(uom) {
        const map = { 'KG': 'KGS', 'Kg': 'KGS', 'GM': 'GMS', 'Gm': 'GMS', 'Quintal': 'QTL', 'QTL': 'QTL', 'Bag': 'BAG', 'Bags': 'BAG', 'Pkt': 'PAC', 'Ltr': 'OTH', 'Pcs': 'NOS', 'Box': 'BOX' };
        return map[uom] || 'OTH';
    }

    function generateEwayBill(txnId) {
        // Pulls a 6-digit PIN code out of a party's free-text address (the
        // Address field already asks for "Street, City, State, Pincode" as
        // one block) so the e-Way Bill JSON carries the party's real
        // location instead of a hardcoded placeholder.
        const extractPincode = (address) => {
            const m = String(address || '').match(/\b(\d{6})\b/);
            return m ? Number(m[1]) : null;
        };

        const s = appState();
        const t = (s.transactions || []).find(x => String(x.id) === String(txnId));
        if (!t) { alert('Voucher not found for e-Way bill'); return; }
        if (!['Sales', 'Purchase', 'DeliveryNote'].includes(t.type)) {
            alert('e-Way Bill is only for Sales, Purchase or Delivery Note vouchers');
            return;
        }
        const party = (s.parties || []).find(p => String(p.id) === String(t.partyId)) || {};
        const isSale = (t.type === 'Sales' || t.type === 'DeliveryNote');

        const partyState  = stateCodeFromGstin(party.gstin) || COMPANY.stateCode;
        const ownGstin    = COMPANY.gstin;
        const ownState    = COMPANY.stateCode;
        const isInterState = (t.taxType === 'INTER');

        const items = (t.items || []).map(it => {
            const stkItem = (s.stockItems || []).find(x => String(x.id) === String(it.itemId)) || {};
            const gst = Number(it.gstRate || 0);
            const cgstRate = isInterState ? 0 : gst / 2;
            const sgstRate = isInterState ? 0 : gst / 2;
            const igstRate = isInterState ? gst : 0;
            return {
                productName: (stkItem.name || 'Item').slice(0, 300),
                productDesc: (stkItem.name || 'Item').slice(0, 300),
                hsnCode: parseInt((stkItem.hsn || '0').toString().replace(/\D/g, ''), 10) || 0,
                quantity: Number(it.qty || 0),
                qtyUnit: unitCodeFor(stkItem.uom),
                taxableAmount: Number((it.taxable || 0).toFixed(2)),
                cgstRate, sgstRate, igstRate, cessRate: 0
            };
        });

        const totTaxable = items.reduce((a, c) => a + c.taxableAmount, 0);
        const cgstValue = isInterState ? 0 : Number(((t.totalTax || 0) / 2).toFixed(2));
        const sgstValue = isInterState ? 0 : Number(((t.totalTax || 0) / 2).toFixed(2));
        const igstValue = isInterState ? Number((t.totalTax || 0).toFixed(2)) : 0;

        const ewb = {
            version: '1.0.0421',
            billLists: [{
                userGstin: ownGstin,
                supplyType: isSale ? 'O' : 'I',
                subSupplyType: '1',
                docType: t.type === 'DeliveryNote' ? 'CHL' : 'INV',
                docNo: (t.invNo || '').slice(0, 16),
                docDate: toDDMMYYYY(t.date),
                fromGstin: isSale ? ownGstin : (party.gstin || 'URP'),
                fromTrdName: isSale ? COMPANY.name : (party.name || 'URP'),
                fromAddr1: (isSale ? COMPANY.addr1 : (party.address || '')).slice(0, 120),
                fromAddr2: '',
                fromPlace: (isSale ? COMPANY.place : '').slice(0, 50),
                fromPincode: isSale ? Number(COMPANY.pincode) : (extractPincode(party.address) || Number(COMPANY.pincode)),
                fromStateCode: isSale ? ownState : partyState,
                actFromStateCode: isSale ? ownState : partyState,
                toGstin: isSale ? (party.gstin || 'URP') : ownGstin,
                toTrdName: isSale ? (party.name || 'URP') : COMPANY.name,
                toAddr1: (isSale ? (party.address || '') : COMPANY.addr1).slice(0, 120),
                toAddr2: '',
                toPlace: (isSale ? '' : COMPANY.place).slice(0, 50),
                toPincode: isSale ? (extractPincode(party.address) || Number(COMPANY.pincode)) : Number(COMPANY.pincode),
                toStateCode: isSale ? partyState : ownState,
                actToStateCode: isSale ? partyState : ownState,
                itemList: items,
                totalValue: Number(totTaxable.toFixed(2)),
                cgstValue, sgstValue, igstValue, cessValue: 0,
                totInvValue: Number((t.grandTotal || 0).toFixed(2)),
                transMode: '1',
                transDistance: '10',
                transporterName: t.driverName || '',
                transporterId: '',
                transDocNo: '',
                transDocDate: '',
                vehicleNo: (t.vehicleNo || '').replace(/\s+/g, '').toUpperCase(),
                vehicleType: (t.vehicleType && /odc/i.test(t.vehicleType)) ? 'O' : 'R'
            }]
        };

        const blob = new Blob([JSON.stringify(ewb, null, 2)], { type: 'application/json' });
        downloadBlob(blob, `ewaybill-${(t.invNo || 'draft').replace(/[^\w-]/g, '_')}.json`);
        if (window.showSyncToast) window.showSyncToast('ok', `e-Way Bill draft ready • ${t.invNo}`);
    }
    window.generateEwayBill = generateEwayBill;

    // ==============================================================
    // UI INJECTION — banners, install button, backup banner,
    // e-Way button on invoice modal, paper-size selector in modal.
    // ==============================================================
    function injectUI() {
        // ---- Weekly backup banner (top of container) ----
        const container = document.querySelector('.container');
        if (!container) return;

        // Top toolbar (install + settings)
        if (!document.getElementById('extrasBar')) {
            const bar = document.createElement('div');
            bar.id = 'extrasBar';
            bar.className = 'extras-bar no-print';
            bar.innerHTML = `
                <button type="button" id="pwaInstallBtn" class="btn-inline extras-btn" style="display:none;" onclick="triggerInstall()">Install app</button>
                <button type="button" class="btn-inline extras-btn" onclick="backupJSON()">Backup JSON</button>
                <button type="button" class="btn-inline extras-btn" onclick="backupExcel()">Backup Excel</button>
                <label class="extras-paper">
                    <span>Print size</span>
                    <select class="paperSizeSelect" onchange="setPaperSize(this.value)">
                        ${Object.entries(PAPER_SIZES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
                    </select>
                </label>`;
            const header = container.querySelector('header');
            if (header && header.parentNode) header.parentNode.insertBefore(bar, header.nextSibling);
            else container.insertBefore(bar, container.firstChild);
        }
        // Sync paper-size select to stored value
        document.querySelectorAll('.paperSizeSelect').forEach(s => (s.value = getPaperSize()));
        document.body.classList.add('paper-' + getPaperSize());

        // iOS: show install button always (no beforeinstallprompt on iOS)
        if (isIOS() && !isStandalone()) {
            const b = document.getElementById('pwaInstallBtn');
            if (b) b.style.display = '';
        }

        // ---- Weekly backup nudge banner ----
        if (daysSinceBackup() >= 7 && !document.getElementById('backupBanner')) {
            const banner = document.createElement('div');
            banner.id = 'backupBanner';
            banner.className = 'backup-banner no-print';
            const lbl = localStorage.getItem(BACKUP_KEY)
                ? `Last backup: ${new Date(localStorage.getItem(BACKUP_KEY)).toLocaleDateString('en-IN')}`
                : 'You have never taken a local backup.';
            banner.innerHTML = `
                <div>
                    <strong>Weekly backup due</strong>
                    <div class="backup-sub">${lbl} — save a JSON or Excel copy so your books survive even without internet.</div>
                </div>
                <div class="backup-actions">
                    <button type="button" class="btn-inline" onclick="backupJSON()">Backup JSON</button>
                    <button type="button" class="btn-inline" onclick="backupExcel()">Backup Excel</button>
                    <button type="button" class="btn-inline" onclick="document.getElementById('backupBanner').remove()">Dismiss</button>
                </div>`;
            const bar = document.getElementById('extrasBar');
            if (bar && bar.parentNode) bar.parentNode.insertBefore(banner, bar.nextSibling);
            else container.insertBefore(banner, container.firstChild);
        }
        function hideBackupBannerRef() { const b = document.getElementById('backupBanner'); if (b) b.remove(); }
        window.__hideBackupBanner = hideBackupBannerRef;

        // ---- Add "e-Way Bill" + paper-size to invoice modal ----
        const invModal = document.getElementById('invoiceModal');
        if (invModal && !invModal.querySelector('.extras-invoice-toolbar')) {
            const bar = document.createElement('div');
            bar.className = 'extras-invoice-toolbar no-print';
            bar.innerHTML = `
                <button type="button" class="btn-inline" onclick="generateEwayBillFromModal()">e-Way Bill JSON</button>
                <label class="extras-paper">
                    <span>Size</span>
                    <select class="paperSizeSelect" onchange="setPaperSize(this.value)">
                        ${Object.entries(PAPER_SIZES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
                    </select>
                </label>`;
            const box = invModal.querySelector('.invoice-box');
            if (box) box.insertBefore(bar, box.firstChild);
        }
    }

    function hideBackupBanner() {
        if (window.__hideBackupBanner) window.__hideBackupBanner();
    }

    // Track which txn is currently shown in the invoice modal so
    // the e-Way button can generate for it. We wrap printInvoice(txnId).
    const _origPrintInvoice = window.printInvoice;
    let currentInvoiceTxnId = null;
    if (typeof _origPrintInvoice === 'function') {
        window.printInvoice = function (txnId) {
            currentInvoiceTxnId = txnId;
            return _origPrintInvoice.apply(this, arguments);
        };
    }
    window.generateEwayBillFromModal = function () {
        if (currentInvoiceTxnId == null) { alert('Open an invoice first, then click e-Way Bill.'); return; }
        generateEwayBill(currentInvoiceTxnId);
    };

    // Add PWA manifest link if not present
    (function ensureManifest() {
        if (!document.querySelector('link[rel="manifest"]')) {
            const link = document.createElement('link');
            link.rel = 'manifest';
            link.href = 'manifest.json';
            document.head.appendChild(link);
        }
    })();

    // Boot UI once DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectUI);
    } else {
        injectUI();
    }
})();



/* =========================================================
   ADMIN LOGIN GATE
   Each person signs in with their own real Firebase Auth
   email + password (accounts created ahead of time in the
   Firebase Console — no self sign-up from this screen). This
   same sign-in is what the Firestore security rule checks, so
   the login screen and database access are backed by the same
   accounts. Also includes a Financial Year picker (Apr–Mar,
   Indian convention) that just records which year the session
   is working in and shows it as a badge in the header.
========================================================= */
const ACTIVE_FY_KEY = 'sarva_active_fy';

// Indian financial year runs Apr 1 - Mar 31. Returns the starting
// calendar year of the FY that "today" falls in.
function currentFinancialYearStart() {
    const now = new Date();
    return now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
}
function fyLabel(startYear) {
    return `FY ${startYear}-${String(startYear + 1).slice(-2)}`;
}

// Tracks whichever Financial Year is currently chosen on the login
// screen — set by either clicking the "Current Year" chip or picking
// a year from the "Other year" dropdown.
let fySelectedValue = null;

function populateFYOptions() {
    const curBox = document.getElementById('fyCurrentOption');
    const sel = document.getElementById('fyOtherSelect');
    if (!curBox || !sel) return;

    const cur = currentFinancialYearStart();
    const saved = Number(localStorage.getItem(ACTIVE_FY_KEY)) || cur;
    fySelectedValue = saved;

    curBox.innerHTML = `<span class="fy-current-label">${fyLabel(cur)}</span><span class="fy-current-sub">Current Year</span>`;
    curBox.onclick = () => {
        fySelectedValue = cur;
        curBox.classList.add('active');
        sel.value = '';
    };

    sel.innerHTML = '<option value="">Other year\u2026</option>';
    // One year ahead through four years back, newest first, skipping
    // the current year since that's already covered by the chip.
    for (let y = cur + 1; y >= cur - 4; y--) {
        if (y === cur) continue;
        const opt = document.createElement('option');
        opt.value = y;
        opt.textContent = fyLabel(y);
        sel.appendChild(opt);
    }
    sel.onchange = () => {
        if (sel.value) {
            fySelectedValue = Number(sel.value);
            curBox.classList.remove('active');
        } else {
            fySelectedValue = cur;
            curBox.classList.add('active');
        }
    };

    // Reflect whatever was saved last time (may not be the current year).
    if (saved === cur) {
        curBox.classList.add('active');
        sel.value = '';
    } else {
        curBox.classList.remove('active');
        sel.value = String(saved);
    }
}

function selectedFY() {
    return fySelectedValue || currentFinancialYearStart();
}

function dismissLoginError() {
    document.getElementById('loginError').style.display = 'none';
}

// Login now goes straight through real Firebase Auth — each person
// signs in with their own email + password (created ahead of time by
// an admin in the Firebase Console, not self-registered here). There
// is no shared local password anymore; Firestore's security rule
// checks this same sign-in, so the login screen and the database
// access are backed by the same real accounts.
function handleAdminLogin(e) {
    e.preventDefault();
    const email = document.getElementById('loginUser').value.trim();
    const p = document.getElementById('loginPass').value;
    const btn = document.getElementById('loginSubmitBtn');
    dismissLoginError();
    btn.disabled = true;
    btn.textContent = 'Signing in\u2026';

    cloudAuth.signInWithEmailAndPassword(email, p)
        .then(() => {
            const fy = selectedFY();
            localStorage.setItem(ACTIVE_FY_KEY, String(fy));
            enterApp(fy);
        })
        .catch(err => {
            document.getElementById('loginErrorText').textContent = 'Invalid email or password!';
            document.getElementById('loginError').style.display = 'flex';
        })
        .finally(() => {
            btn.disabled = false;
            btn.textContent = 'Login';
        });
    return false;
}

function enterApp(fy) {
    document.getElementById('loginGate').style.display = 'none';
    const badge = document.getElementById('fyActiveBadge');
    if (badge) {
        badge.textContent = fyLabel(Number(fy || localStorage.getItem(ACTIVE_FY_KEY) || currentFinancialYearStart()));
        badge.style.display = 'inline-block';
    }
    if (typeof applyRolePermissions === 'function') applyRolePermissions();
    localStorage.removeItem('sds_bg_since');
}

async function logoutAdmin() {
    if (!(await confirmAsync('Log out of the admin panel?'))) return;
    cloudAuth.signOut().finally(() => location.reload());
}

// ---------- Auto-logout ----------
// One rule only: backgrounded for 30+ minutes \u2192 signed out on return.
// While the app is on screen and active, no timer runs at all — this is
// purely about how long it sat unattended in the background, never about
// idle time while someone's actually looking at it. Force-closing the app
// (swiping it away from recents) deliberately does NOT log anyone out:
// Firebase keeps the session, so relaunching resumes straight into the
// app, exactly like any other reopen.
const AUTO_LOGOUT_MS = 30 * 60 * 1000;

function autoLogout() {
    localStorage.removeItem('sds_bg_since');
    cloudAuth.signOut().finally(() => location.reload());
}

function initAutoLogout() {
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            // Only worth recording if someone is actually signed in —
            // otherwise this would fire while the login screen itself is
            // merely backgrounded, which shouldn't log anyone out of
            // anything since there's no session yet to time out.
            if (document.getElementById('loginGate').style.display === 'none') {
                localStorage.setItem('sds_bg_since', String(Date.now()));
            }
        } else {
            const since = Number(localStorage.getItem('sds_bg_since') || 0);
            localStorage.removeItem('sds_bg_since');
            if (since && (Date.now() - since) >= AUTO_LOGOUT_MS) {
                autoLogout();
            }
        }
    });
}
initAutoLogout();

// ---- Change Password (updates the client-side login gate only) ----
function openChangePasswordModal() {
    document.getElementById('changePasswordForm').reset();
    document.getElementById('changePasswordError').style.display = 'none';
    document.getElementById('changePasswordSuccess').style.display = 'none';
    document.getElementById('changePasswordModal').style.display = 'flex';
    document.getElementById('cpCurrent').focus();
}

function closeChangePasswordModal() {
    document.getElementById('changePasswordModal').style.display = 'none';
}

function showChangePasswordError(msg) {
    document.getElementById('changePasswordErrorText').textContent = msg;
    document.getElementById('changePasswordError').style.display = 'flex';
    document.getElementById('changePasswordSuccess').style.display = 'none';
}

function handleChangePassword(e) {
    e.preventDefault();
    const current = document.getElementById('cpCurrent').value;
    const next = document.getElementById('cpNew').value;
    const confirmVal = document.getElementById('cpConfirm').value;
    const user = cloudAuth.currentUser;

    if (!user) {
        showChangePasswordError('You are not signed in.');
        return false;
    }
    if (next.length < 6) {
        showChangePasswordError('New password must be at least 6 characters.');
        return false;
    }
    if (next !== confirmVal) {
        showChangePasswordError('New password and confirmation do not match.');
        return false;
    }
    if (next === current) {
        showChangePasswordError('New password must be different from the current one.');
        return false;
    }

    // Firebase requires a recent sign-in before it will let you change a
    // password, so re-prove identity with the current password first.
    const credential = firebase.auth.EmailAuthProvider.credential(user.email, current);
    user.reauthenticateWithCredential(credential)
        .then(() => user.updatePassword(next))
        .then(() => {
            document.getElementById('changePasswordError').style.display = 'none';
            document.getElementById('changePasswordSuccess').style.display = 'flex';
            document.getElementById('changePasswordForm').reset();
        })
        .catch(err => {
            if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential' || err.code === 'auth/invalid-login-credentials') {
                showChangePasswordError('Current password is incorrect.');
            } else {
                showChangePasswordError('Could not update password. Please try again.');
                console.error('Password change failed:', err);
            }
        });
    return false;
}

// ---- Company Address & Mobile Number (Settings) ----
// Both are purely local display/print details — empty by default, never
// synced to Firestore, never required to use the app. They're read once
// on page load (see applyCompanyDetailsToUI below) and re-applied instantly
// whenever saved, so every place the company name appears (login screen,
// app header, printed invoice, printed ledger statement) shows the same
// values without needing a page reload.
const COMPANY_ADDRESS_KEY = 'sarva_company_address';
const COMPANY_MOBILE_KEY = 'sarva_company_mobile';
const COMPANY_TIN_KEY = 'sarva_company_tin';
const COMPANY_BANK_NAME_KEY = 'sarva_company_bank_name';
const COMPANY_BANK_ACC_KEY = 'sarva_company_bank_acc';
const COMPANY_BANK_IFSC_KEY = 'sarva_company_bank_ifsc';

function getCompanyAddress() {
    return localStorage.getItem(COMPANY_ADDRESS_KEY) || '';
}
function getCompanyMobile() {
    return localStorage.getItem(COMPANY_MOBILE_KEY) || '';
}
function getCompanyTin() {
    return localStorage.getItem(COMPANY_TIN_KEY) || '';
}
function getCompanyBankName() {
    return localStorage.getItem(COMPANY_BANK_NAME_KEY) || '';
}
function getCompanyBankAcc() {
    return localStorage.getItem(COMPANY_BANK_ACC_KEY) || '';
}
function getCompanyBankIfsc() {
    return localStorage.getItem(COMPANY_BANK_IFSC_KEY) || '';
}

function openCompanyAddressModal() {
    document.getElementById('companyAddressForm').reset();
    document.getElementById('companyAddressInput').value = getCompanyAddress();
    document.getElementById('companyAddressSuccess').style.display = 'none';
    document.getElementById('companyAddressModal').style.display = 'flex';
    document.getElementById('companyAddressInput').focus();
}
function closeCompanyAddressModal() {
    document.getElementById('companyAddressModal').style.display = 'none';
}
function handleSaveCompanyAddress(e) {
    e.preventDefault();
    const value = document.getElementById('companyAddressInput').value.trim();
    localStorage.setItem(COMPANY_ADDRESS_KEY, value);
    applyCompanyDetailsToUI();
    document.getElementById('companyAddressSuccess').style.display = 'flex';
    return false;
}

function openCompanyMobileModal() {
    document.getElementById('companyMobileForm').reset();
    document.getElementById('companyMobileInput').value = getCompanyMobile();
    document.getElementById('companyMobileError').style.display = 'none';
    document.getElementById('companyMobileSuccess').style.display = 'none';
    document.getElementById('companyMobileModal').style.display = 'flex';
    document.getElementById('companyMobileInput').focus();
}
function closeCompanyMobileModal() {
    document.getElementById('companyMobileModal').style.display = 'none';
}
function handleSaveCompanyMobile(e) {
    e.preventDefault();
    const raw = document.getElementById('companyMobileInput').value.trim();
    // Light validation only: allow digits, spaces, +, -, ( ) so Indian
    // numbers with or without a country code both work. Blank is fine —
    // that's how it clears the field back to "not shown".
    if (raw && !/^[0-9+\-()\s]{6,20}$/.test(raw)) {
        document.getElementById('companyMobileErrorText').textContent = 'Please enter a valid phone number.';
        document.getElementById('companyMobileError').style.display = 'flex';
        document.getElementById('companyMobileSuccess').style.display = 'none';
        return false;
    }
    localStorage.setItem(COMPANY_MOBILE_KEY, raw);
    applyCompanyDetailsToUI();
    document.getElementById('companyMobileError').style.display = 'none';
    document.getElementById('companyMobileSuccess').style.display = 'flex';
    return false;
}

function openCompanyBankModal() {
    document.getElementById('companyBankForm').reset();
    document.getElementById('companyTinInput').value = getCompanyTin();
    document.getElementById('companyBankNameInput').value = getCompanyBankName();
    document.getElementById('companyBankAccInput').value = getCompanyBankAcc();
    document.getElementById('companyBankIfscInput').value = getCompanyBankIfsc();
    document.getElementById('companyBankSuccess').style.display = 'none';
    document.getElementById('companyBankModal').style.display = 'flex';
    document.getElementById('companyTinInput').focus();
}
function closeCompanyBankModal() {
    document.getElementById('companyBankModal').style.display = 'none';
}
function handleSaveCompanyBank(e) {
    e.preventDefault();
    localStorage.setItem(COMPANY_TIN_KEY, document.getElementById('companyTinInput').value.trim());
    localStorage.setItem(COMPANY_BANK_NAME_KEY, document.getElementById('companyBankNameInput').value.trim());
    localStorage.setItem(COMPANY_BANK_ACC_KEY, document.getElementById('companyBankAccInput').value.trim());
    localStorage.setItem(COMPANY_BANK_IFSC_KEY, document.getElementById('companyBankIfscInput').value.trim());
    document.getElementById('companyBankSuccess').style.display = 'flex';
    return false;
}

// Pushes the current saved address/mobile (or hides the row if empty)
// into every place the company's own details are shown. Safe to call
// even if some of these elements aren't in the DOM yet.
function applyCompanyDetailsToUI() {
    const addr = getCompanyAddress();
    const mobile = getCompanyMobile();
    const mobileLabel = mobile ? `Mobile: ${mobile}` : '';

    const targets = [
        { addr: 'loginCompanyAddress', mobile: 'loginCompanyMobile' },
        { addr: 'invCompanyAddress', mobile: 'invCompanyMobile' },
        { addr: 'ledgerCompanyAddress', mobile: 'ledgerCompanyMobile' }
    ];
    targets.forEach(t => {
        const addrEl = document.getElementById(t.addr);
        const mobileEl = document.getElementById(t.mobile);
        if (addrEl) {
            addrEl.textContent = addr;
            addrEl.style.display = addr ? 'block' : 'none';
        }
        if (mobileEl) {
            mobileEl.textContent = mobileLabel;
            mobileEl.style.display = mobile ? 'block' : 'none';
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    populateFYOptions();
    applyCompanyDetailsToUI();
    document.getElementById('loginUser').focus();
});

// Restores the session automatically on reload — Firebase Auth keeps
// people signed in on this device/browser until they log out, so a
// returning user skips straight past the login screen. This applies
// equally after a force-close: swiping the app away from recents is
// treated as an ordinary close, not a logout.
cloudAuth.onAuthStateChanged(user => {
    if (user) {
        enterApp(localStorage.getItem(ACTIVE_FY_KEY));
    }
});

