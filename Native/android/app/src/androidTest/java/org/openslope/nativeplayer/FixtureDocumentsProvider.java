package org.openslope.nativeplayer;

import android.database.Cursor;
import android.database.MatrixCursor;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract.Document;
import android.provider.DocumentsContract.Root;
import android.provider.DocumentsProvider;
import java.io.*;

/** An authored, app-private document provider for device-side SAF integration tests. */
public final class FixtureDocumentsProvider extends DocumentsProvider {
    static final String AUTHORITY = "org.openslope.nativeplayer.test.documents";
    private File root;
    @Override public boolean onCreate() { root = new File(getContext().getCacheDir(), "saf-fixture"); root.mkdirs(); return true; }
    private File file(String id) throws FileNotFoundException {
        try { File result = id.equals("root") ? root : new File(root, id); String path = result.getCanonicalPath(); if (!path.equals(root.getCanonicalPath()) && !path.startsWith(root.getCanonicalPath() + File.separator)) throw new IOException("Outside fixture"); return result; }
        catch (IOException e) { throw new FileNotFoundException(e.getMessage()); }
    }
    private String id(File file) { return file.equals(root) ? "root" : file.getAbsolutePath().substring(root.getAbsolutePath().length() + 1); }
    private void row(MatrixCursor cursor, File file) {
        Object[] values = new Object[cursor.getColumnCount()];
        for (int i = 0; i < values.length; ++i) {
            String name = cursor.getColumnNames()[i];
            if (name.equals(Document.COLUMN_DOCUMENT_ID)) values[i] = id(file);
            else if (name.equals(Document.COLUMN_DISPLAY_NAME)) values[i] = file.getName();
            else if (name.equals(Document.COLUMN_MIME_TYPE)) values[i] = file.isDirectory() ? Document.MIME_TYPE_DIR : "application/octet-stream";
            else if (name.equals(Document.COLUMN_SIZE)) values[i] = file.length();
            else if (name.equals(Document.COLUMN_FLAGS)) values[i] = Document.FLAG_SUPPORTS_WRITE | Document.FLAG_SUPPORTS_DELETE | Document.FLAG_SUPPORTS_RENAME | (file.isDirectory() ? Document.FLAG_DIR_SUPPORTS_CREATE : 0);
        }
        cursor.addRow(values);
    }
    private String[] columns(String[] projection) { return projection == null ? new String[]{Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_FLAGS, Document.COLUMN_SIZE} : projection; }
    @Override public Cursor queryRoots(String[] projection) {
        MatrixCursor cursor = new MatrixCursor(new String[]{Root.COLUMN_ROOT_ID, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_TITLE, Root.COLUMN_FLAGS, Root.COLUMN_MIME_TYPES});
        cursor.addRow(new Object[]{"fixture", "root", "OpenSlope test documents", Root.FLAG_SUPPORTS_CREATE, "*/*"}); return cursor;
    }
    @Override public Cursor queryDocument(String documentId, String[] projection) throws FileNotFoundException { MatrixCursor cursor = new MatrixCursor(columns(projection)); row(cursor, file(documentId)); return cursor; }
    @Override public Cursor queryChildDocuments(String parentId, String[] projection, String sortOrder) throws FileNotFoundException {
        MatrixCursor cursor = new MatrixCursor(columns(projection)); File[] children = file(parentId).listFiles(); if (children != null) for (File child : children) row(cursor, child); return cursor;
    }
    @Override public String createDocument(String parentId, String mime, String name) throws FileNotFoundException {
        if (!MapLibrary.safeName(name) && !name.startsWith(".openslope-import-")) throw new FileNotFoundException("Unsafe fixture name");
        File output = new File(file(parentId), name);
        try { if (mime.equals(Document.MIME_TYPE_DIR) ? !output.mkdir() : !output.createNewFile()) throw new IOException("Already exists"); return id(output); }
        catch (IOException e) { throw new FileNotFoundException(e.getMessage()); }
    }
    @Override public String renameDocument(String documentId, String name) throws FileNotFoundException { File source = file(documentId), target = new File(source.getParentFile(), name); if (target.exists() || !source.renameTo(target)) throw new FileNotFoundException("Cannot rename fixture"); return id(target); }
    @Override public void deleteDocument(String documentId) throws FileNotFoundException { if (documentId.equals("root")) throw new FileNotFoundException("Cannot delete fixture root"); MapLibrary.deleteLocal(file(documentId)); }
    @Override public boolean isChildDocument(String parent, String child) { try { return file(child).getAbsolutePath().startsWith(file(parent).getAbsolutePath() + File.separator); } catch (FileNotFoundException e) { return false; } }
    @Override public ParcelFileDescriptor openDocument(String documentId, String mode, CancellationSignal signal) throws FileNotFoundException { return ParcelFileDescriptor.open(file(documentId), ParcelFileDescriptor.parseMode(mode)); }
}
