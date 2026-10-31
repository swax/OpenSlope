package org.openslope.nativeplayer;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.ContentProviderClient;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.provider.DocumentsContract;

/** Test APK only: its owner grants one fixed fixture tree to the same-signed target. */
public final class FixtureBootstrapReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String target = "org.openslope.nativeplayer";
        if (
            context.getPackageManager().checkSignatures(context.getPackageName(), target) !=
            PackageManager.SIGNATURE_MATCH
        ) {
            setResultCode(Activity.RESULT_CANCELED);
            return;
        }
        try (
            ContentProviderClient provider = context
                .getContentResolver()
                .acquireContentProviderClient(FixtureDocumentsProvider.AUTHORITY)
        ) {
            if (provider == null) throw new IllegalStateException("Fixture provider did not start");
            context.grantUriPermission(
                target,
                DocumentsContract.buildTreeDocumentUri(FixtureDocumentsProvider.AUTHORITY, "root"),
                Intent.FLAG_GRANT_READ_URI_PERMISSION |
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION |
                    Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
            );
            setResultCode(Activity.RESULT_OK);
        } catch (RuntimeException error) {
            setResultCode(Activity.RESULT_CANCELED);
            setResultData(error.toString());
        }
    }
}
