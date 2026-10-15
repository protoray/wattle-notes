# Nextcloud / WebDAV encrypted backups

This is an optional **manual full backup**, separate from Google Drive's automatic multi-device synchronization. It needs no Google account or OAuth client. Backups include current Markdown, attachments, empty folders, retained revisions and attachment history, unresolved conflicts, and a consistent encrypted SQLite snapshot for restoring local history/queues. The search index is rebuilt when opening a restored notebook. OS credentials, encryption master keys, transfer files, and lock files are never included.

## Connect and back up

1. Open **Nextcloud backup** in the sidebar, or choose **Nextcloud backup** in Settings.
2. In your Nextcloud web interface, open **Files → Files settings** and copy the **WebDAV URL**. It normally looks like `https://cloud.example.com/remote.php/dav/files/USERNAME/`; installations in a subdirectory include that subdirectory too.
3. Open **Personal settings → Security** in Nextcloud and create an **app password** for Wattle Notes.
4. Enter the WebDAV URL, username, and app password, then choose **Save & test connection**. The connection test reads the directory; the app password is stored in your operating system's secure credential store. HTTPS with a valid certificate is required. Redirects and credentials embedded in URLs are rejected.
5. In **Protect your notes**, set up a vault passphrase and save the recovery key, or unlock an existing vault key. This works without Google sign-in. Google and Nextcloud use the same vault encryption configuration.
6. Select **Back up now**. Pending editor text is saved first. The app creates a fully encrypted snapshot before sending any bytes to the server.

Snapshots are stored under `Wattle Notes Backups/` at your configured WebDAV location. A file is uploaded with a `.partial` suffix and published with a WebDAV MOVE only after the upload succeeds. Incomplete uploads are excluded from the app's backup list. Temporary failures retry with backoff. A lost completion response is verified by downloading and comparing the encrypted bytes. Login, permission, quota, and certificate failures preserve local notes.

## Restore and verify

1. Configure the same WebDAV location/account on the device that will restore the backup. This can be a new local notebook; it does not need an encryption key configured.
2. Choose **Find backups**, select a completed snapshot, and enter its original passphrase or recovery key.
3. Choose **Restore backup to a new folder** and select a parent location outside your currently open notebook.
4. The app verifies the encrypted manifest, authenticates every streamed file, validates paths and file hashes, and rebuilds the local index inside a private staging folder. Only then does it publish a new `Wattle Notes restored ...` folder. Existing notebooks are not overwritten.
5. Select **Open restored notebook**. Check note bodies, attachments, search, history, and any unresolved conflicts before relying on the backup.

Restore failures remove the staging folder. The downloaded transfer file is encrypted. Successfully restored files, like all local vault files, are plaintext. Disconnecting forgets the saved WebDAV app password and local connection settings; it leaves server backups intact.

## Alpha limits

- Full snapshots are manual, not automatic scheduled backups or WebDAV multi-device sync.
- Each backup is limited to **4 GiB**, each file (including the database snapshot) to **100 MiB**, and the manifest to **20,000 file/directory entries**. Existing 10 MiB note limits still apply. Large local notebooks need temporary disk space for the encrypted archive; historical attachments may make backups larger than the visible notebook.
- Upload retries restart a PUT; chunk-resumable Nextcloud uploads are deferred. A failed backup may leave an unlisted `.partial` file on the server.
- Old backups are retained. There is no automatic pruning or deletion.
- Server listings are bounded at 2 MiB / 5,000 entries. Start a new destination when that limit is reached.
- The server sees archive filenames, vault/snapshot identities, sizes, timestamps, and backup activity. Internal note paths, bodies, tags, and attachment bytes are encrypted. There is no cryptographic freshness guarantee: a provider could hide or delete old snapshots.
- Tests use a local WebDAV HTTP fixture with synthetic credentials. Live Nextcloud, OS credential stores, and platform packaging remain acceptance checks.

Official instructions: [Nextcloud WebDAV access and app passwords](https://docs.nextcloud.com/server/latest/user_manual/en/files/access_webdav.html).
