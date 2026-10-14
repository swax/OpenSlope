package org.openslope.nativeplayer;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import java.io.*;
import java.util.*;
import org.json.*;

/** Maps/<name>/Patches.json is the discovery contract for both local and SAF libraries. */
final class MapLibrary {
    static final long PATCH_LIMIT = 64L * 1024 * 1024;
    static final long FILE_LIMIT = 128L * 1024 * 1024;
    static final long IMAGE_LIMIT = 64L * 1024 * 1024;
    static final long IMAGE_BUDGET = 256L * 1024 * 1024;
    static final long AUDIO_BUDGET = 512L * 1024 * 1024;
    static native String nativeAssetFiles(String path);
    static final String DIRECTORY = DocumentsContract.Document.MIME_TYPE_DIR;
    interface Cancel { void check() throws IOException; }
    static final class Entry {
        final String name;
        final Uri uri;
        final boolean directory;
        Entry(String name, Uri uri, boolean directory) { this.name = name; this.uri = uri; this.directory = directory; }
    }
    final ContentResolver resolver;
    final File localRoot;
    final Uri tree;
    final Uri root;
    MapLibrary(ContentResolver resolver, File localRoot, Uri tree) {
        this.resolver = resolver; this.localRoot = localRoot; this.tree = tree;
        root = tree == null ? null : DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
    }
    static boolean safeName(String name) {
        if (name == null || name.isEmpty() || name.length() > 128 || name.startsWith(".") || name.endsWith(".") || name.endsWith(" ")) return false;
        for (char c : name.toCharArray()) if (c < 32 || c == 127 || "/\\:*?\"<>|".indexOf(c) >= 0) return false;
        return true;
    }
    List<Entry> children(Uri directory) throws IOException {
        ArrayList<Entry> result = new ArrayList<>();
        Uri uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(directory));
        String[] columns = {DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE};
        try (Cursor cursor = resolver.query(uri, columns, null, null, null)) {
            if (cursor == null) throw new IOException("The Maps folder is unavailable. Choose it again.");
            while (cursor.moveToNext()) {
                if (result.size() >= 65535) throw new IOException("Folder contains too many entries.");
                result.add(new Entry(cursor.getString(1), DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0)), DIRECTORY.equals(cursor.getString(2))));
            }
        } catch (SecurityException e) { throw new IOException("Access to the Maps folder has expired. Choose it again.", e); }
        return result;
    }
    Entry child(Uri directory, String name) throws IOException {
        for (Entry entry : children(directory)) if (entry.name.equals(name)) return entry;
        return null;
    }
    List<Entry> maps() throws IOException {
        ArrayList<Entry> maps = new ArrayList<>();
        if (tree == null) {
            if (!localRoot.isDirectory() && !localRoot.mkdirs()) throw new IOException("Cannot create Maps folder.");
            File[] directories = localRoot.listFiles();
            if (directories == null) throw new IOException("Cannot read Maps folder.");
            for (File directory : directories) if (safeName(directory.getName()) && directory.isDirectory() && new File(directory, "Patches.json").isFile()) maps.add(new Entry(directory.getName(), Uri.fromFile(directory), true));
        } else {
            for (Entry entry : children(root)) if (entry.directory && safeName(entry.name)) {
                Entry patches = child(entry.uri, "Patches.json");
                if (patches != null && !patches.directory) maps.add(entry);
            }
        }
        maps.sort(Comparator.comparing(e -> e.name.toLowerCase(Locale.ROOT)));
        return maps;
    }
    boolean exists(String name) throws IOException {
        if (tree == null) return new File(localRoot, name).exists();
        for (Entry entry : children(root)) if (entry.name.equalsIgnoreCase(name)) return true;
        return false;
    }
    File prepare(Entry map, File cache, Cancel cancel) throws IOException {
        if (tree == null) return new File(map.uri.getPath());
        File output = new File(cache, "play-" + UUID.randomUUID());
        if (!output.mkdir()) throw new IOException("Cannot prepare course.");
        try {
            Entry patches = child(map.uri, "Patches.json");
            if (patches == null || patches.directory) throw new IOException("This map has no Patches.json.");
            try (InputStream input = resolver.openInputStream(patches.uri); OutputStream file = new FileOutputStream(new File(output, "Patches.json"))) { copy(input, file, PATCH_LIMIT, cancel); }
            for (String name : new String[]{"Models.json", "Instances.json", "Materials.json", "AIP.json", "SOP.json", "Physics.json", "SSFLogic.json"}) {
                cancel.check(); Entry metadata = child(map.uri, name);
                if (metadata == null) continue;
                if (metadata.directory) throw new IOException("Map metadata is a folder: " + name);
                try (InputStream input = resolver.openInputStream(metadata.uri); OutputStream file = new FileOutputStream(new File(output, name))) { copy(input, file, PATCH_LIMIT, cancel); }
            }
            Entry audio = child(map.uri, "Audio");
            if (audio != null) {
                if (!audio.directory) throw new IOException("Audio must be a folder.");
                File audioFolder = new File(output, "Audio");
                if (!audioFolder.mkdir()) throw new IOException("Cannot prepare map audio.");
                copyAudio(audio.uri, audioFolder, cancel, new long[]{0, 0}, 0);
                if (!new File(audioFolder, "BoardSoundIndex.json").isFile()) {
                    Entry shared = child(root, "Shared");
                    Entry sharedAudio = shared != null && shared.directory ? child(shared.uri, "Audio") : null;
                    Entry routing = sharedAudio != null && sharedAudio.directory ? child(sharedAudio.uri, "BoardSoundIndex.json") : null;
                    if (routing != null && !routing.directory) try (InputStream input = resolver.openInputStream(routing.uri); OutputStream file = new FileOutputStream(new File(audioFolder, "BoardSoundIndex.json"))) { copy(input, file, PATCH_LIMIT, cancel); }
                }
            }
            JSONArray images;
            try { images = new JSONArray(nativeAssetFiles(output.getAbsolutePath())); }
            catch (JSONException e) { throw new IOException("Cannot read map image references.", e); }
            Map<String, Map<String, Entry>> folders = new HashMap<>(); long total = 0, meshes = 0;
            for (int i = 0; i < images.length(); ++i) {
                cancel.check(); String relative;
                try { relative = images.getString(i); } catch (JSONException e) { throw new IOException("Invalid map image reference.", e); }
                String[] parts = relative.split("/", -1);
                if (parts.length != 2 || !(parts[0].equals("Textures") || parts[0].equals("Lightmaps") || parts[0].equals("Meshes") || parts[0].equals("Collision")) || !safeName(parts[1])) throw new IOException("Unsafe map asset reference.");
                Map<String, Entry> files = folders.get(parts[0]);
                if (files == null) {
                    files = new HashMap<>(); Entry folder = child(map.uri, parts[0]);
                    if (folder != null) {
                        if (!folder.directory) throw new IOException(parts[0] + " must be a folder.");
                        for (Entry entry : children(folder.uri)) files.put(entry.name, entry);
                    }
                    folders.put(parts[0], files);
                }
                Entry image = files.get(parts[1]);
                if (image == null) { if (parts[0].equals("Meshes") || parts[0].equals("Collision")) throw new IOException("Missing map mesh: " + parts[1]); continue; }
                if (image.directory) throw new IOException("Map image is a folder: " + parts[1]);
                File directory = new File(output, parts[0]);
                if (!directory.isDirectory() && !directory.mkdir()) throw new IOException("Cannot prepare map images.");
                boolean mesh = parts[0].equals("Meshes") || parts[0].equals("Collision");
                try (InputStream input = resolver.openInputStream(image.uri); OutputStream file = new FileOutputStream(new File(directory, parts[1]))) { long copied = copy(input, file, Math.min(IMAGE_LIMIT, IMAGE_BUDGET - (mesh ? meshes : total)), cancel); if (mesh) meshes += copied; else total += copied; }
            }
            cancel.check();
            return output;
        } catch (Exception e) { deleteLocal(output); throw e; }
    }
    private void copyAudio(Uri source, File destination, Cancel cancel, long[] budget, int depth) throws IOException {
        if (depth > 5) throw new IOException("Audio folder nesting exceeds its limit.");
        for (Entry entry : children(source)) {
            cancel.check(); if (!safeName(entry.name)) throw new IOException("Unsafe audio filename.");
            if (++budget[1] > 20000) throw new IOException("Audio library contains too many files.");
            File target = new File(destination, entry.name);
            if (entry.directory) {
                if (!target.mkdir()) throw new IOException("Cannot prepare audio folder.");
                copyAudio(entry.uri, target, cancel, budget, depth + 1);
            } else {
                String name = entry.name.toLowerCase(Locale.ROOT);
                if (!(name.endsWith(".wav") || name.endsWith(".json") || name.endsWith(".inf"))) continue;
                try (InputStream input = resolver.openInputStream(entry.uri); OutputStream file = new FileOutputStream(target)) { budget[0] += copy(input, file, Math.min(IMAGE_LIMIT, AUDIO_BUDGET - budget[0]), cancel); }
            }
        }
    }
    void publish(String name, File source, Cancel cancel) throws IOException {
        if (!safeName(name) || exists(name)) throw new IOException("A map named " + name + " already exists. Existing maps are kept.");
        cancel.check();
        if (tree == null) {
            File staging = new File(localRoot, ".openslope-import-" + UUID.randomUUID());
            if (!staging.mkdir()) throw new IOException("Cannot stage map in Maps folder.");
            try {
                copyLocal(source, staging, cancel);
                cancel.check();
                File destination = new File(localRoot, name);
                if (destination.exists() || !staging.renameTo(destination)) throw new IOException("Cannot publish map; the destination may now exist.");
            } finally { deleteLocal(staging); }
            return;
        }
        // Keep Patches.json until last so interrupted/provider-limited copies
        // cannot appear in the library as playable courses.
        Uri staged = DocumentsContract.createDocument(resolver, root, DIRECTORY, ".openslope-import-" + UUID.randomUUID());
        if (staged == null) throw new IOException("The selected Maps folder is not writable.");
        Uri published = null;
        try {
            copyTree(source, staged, cancel);
            cancel.check();
            if (exists(name)) throw new IOException("A map with this name was created during import.");
            published = DocumentsContract.renameDocument(resolver, staged, name);
            if (published == null) throw new IOException("The folder provider cannot rename an imported course. Use a local Maps folder.");
            Entry patches = child(published, "Patches.json");
            if (patches == null) throw new IOException("Published map is missing its terrain.");
        } catch (Exception e) {
            try { DocumentsContract.deleteDocument(resolver, published == null ? staged : published); } catch (Exception ignored) { }
            throw e;
        }
    }
    void copyTree(File source, Uri destination, Cancel cancel) throws IOException {
        File[] files = source.listFiles();
        if (files == null) throw new IOException("Cannot read extracted course.");
        Arrays.sort(files, Comparator.comparing(file -> file.getName().equals("Patches.json")));
        for (File file : files) {
            cancel.check();
            if (!safeName(file.getName())) throw new IOException("Unsafe map filename.");
            String mime = file.isDirectory() ? DIRECTORY : file.getName().endsWith(".png") ? "image/png" : "application/octet-stream";
            Uri created = DocumentsContract.createDocument(resolver, destination, mime, file.getName());
            if (created == null) throw new IOException("Cannot write " + file.getName() + " to Maps.");
            if (file.isDirectory()) copyTree(file, created, cancel);
            else try (InputStream input = new FileInputStream(file); OutputStream output = resolver.openOutputStream(created, "w")) { copy(input, output, FILE_LIMIT, cancel); }
        }
    }
    static void copyLocal(File source, File destination, Cancel cancel) throws IOException {
        File[] files = source.listFiles(); if (files == null) throw new IOException("Cannot read extracted course.");
        for (File file : files) {
            cancel.check(); if (!safeName(file.getName())) throw new IOException("Unsafe map filename.");
            File target = new File(destination, file.getName());
            if (file.isDirectory()) { if (!target.mkdir()) throw new IOException("Cannot create map directory."); copyLocal(file, target, cancel); }
            else try (InputStream input = new FileInputStream(file); OutputStream output = new FileOutputStream(target)) { copy(input, output, FILE_LIMIT, cancel); }
        }
    }
    static long copy(InputStream input, OutputStream output, long limit, Cancel cancel) throws IOException {
        if (input == null || output == null) throw new IOException("The document provider could not open this file.");
        byte[] buffer = new byte[128 * 1024]; long total = 0; int count;
        while ((count = input.read(buffer)) != -1) { cancel.check(); total += count; if (total > limit) throw new IOException("Map file exceeds the import limit."); output.write(buffer, 0, count); }
        return total;
    }
    static void deleteLocal(File directory) {
        // Called only for freshly created application cache/staging directories.
        File[] files = directory.listFiles(); if (files != null) for (File child : files) { if (child.isDirectory()) deleteLocal(child); else child.delete(); }
        directory.delete();
    }
}
