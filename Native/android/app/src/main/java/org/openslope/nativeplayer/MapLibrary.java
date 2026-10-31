package org.openslope.nativeplayer;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import java.io.*;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.*;
import org.json.*;

/** Maps/<name>/Patches.json is the discovery contract for both local and SAF libraries. */
final class MapLibrary {

    static final long PATCH_LIMIT = 64L * 1024 * 1024;
    static final long FILE_LIMIT = 128L * 1024 * 1024;
    static final long IMAGE_LIMIT = 64L * 1024 * 1024;
    static final long IMAGE_BUDGET = 256L * 1024 * 1024;
    // A complete disc soundtrack can exceed 1 GiB even with short WAV chunks.
    static final long AUDIO_BUDGET = 1536L * 1024 * 1024;

    static native String nativeAssetFiles(String path);

    static final String DIRECTORY = DocumentsContract.Document.MIME_TYPE_DIR;

    interface Cancel {
        void check() throws IOException;
    }

    static final class Entry {

        final String name;
        String displayName;
        String game = "unknown";
        final Uri uri;
        final boolean directory;

        Entry(String name, Uri uri, boolean directory) {
            this.name = name;
            this.uri = uri;
            this.directory = directory;
        }

        String label() {
            return displayName == null ? LauncherActivity.nativeCourseDisplayName(name) : displayName;
        }
    }

    final ContentResolver resolver;
    final File localRoot;
    final Uri tree;
    final Uri root;

    MapLibrary(ContentResolver resolver, File localRoot, Uri tree) {
        this.resolver = resolver;
        this.localRoot = localRoot;
        this.tree = tree;
        root =
            tree == null
                ? null
                : DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
    }

    static boolean safeName(String name) {
        if (
            name == null ||
            name.isEmpty() ||
            name.length() > 128 ||
            name.startsWith(".") ||
            name.endsWith(".") ||
            name.endsWith(" ")
        ) return false;
        for (char c : name.toCharArray()) if (c < 32 || c == 127 || "/\\:*?\"<>|".indexOf(c) >= 0) return false;
        return true;
    }

    List<Entry> children(Uri directory) throws IOException {
        ArrayList<Entry> result = new ArrayList<>();
        Uri uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(directory));
        String[] columns = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE
        };
        try (Cursor cursor = resolver.query(uri, columns, null, null, null)) {
            if (cursor == null) throw new IOException("The Maps folder is unavailable. Choose it again.");
            while (cursor.moveToNext()) {
                if (result.size() >= 65535) throw new IOException("Folder contains too many entries.");
                result.add(
                    new Entry(
                        cursor.getString(1),
                        DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0)),
                        DIRECTORY.equals(cursor.getString(2))
                    )
                );
            }
        } catch (SecurityException e) {
            throw new IOException("Access to the Maps folder has expired. Choose it again.", e);
        }
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
            for (File directory : directories)
                if (
                    safeName(directory.getName()) &&
                    directory.isDirectory() &&
                    new File(directory, "Patches.json").isFile()
                ) maps.add(new Entry(directory.getName(), Uri.fromFile(directory), true));
        } else {
            for (Entry entry : children(root))
                if (entry.directory && safeName(entry.name)) {
                    Entry patches = child(entry.uri, "Patches.json");
                    if (patches != null && !patches.directory) maps.add(entry);
                }
        }
        for (Entry map : maps) {
            String imported = metadata(map, "Import.json");
            String origin = metadata(map, "Origin.json");
            boolean authored = false;
            try {
                Entry sidecar = tree == null ? null : child(map.uri, "Slopesmith.json");
                authored =
                    tree == null
                        ? new File(new File(localRoot, map.name), "Slopesmith.json").isFile()
                        : sidecar != null && !sidecar.directory;
            } catch (IOException ignored) {}
            map.game = LauncherActivity.nativeMapGame(map.name, origin, imported, authored);
            try {
                Object value = new JSONObject(imported).opt("DisplayName");
                String title = value instanceof String ? ((String) value).trim() : "";
                if (
                    !title.isEmpty() && title.length() <= 200 && !title.matches("(?s).*[\\x00-\\x1f\\x7f].*")
                ) map.displayName = title;
            } catch (JSONException ignored) {}
        }
        maps.sort(Comparator.comparing((Entry e) -> e.label().toLowerCase(Locale.ROOT)).thenComparing(e -> e.name));
        return maps;
    }

    private String metadata(Entry map, String name) {
        try {
            Entry entry = tree == null ? null : child(map.uri, name);
            try (
                InputStream input = tree == null
                    ? new FileInputStream(new File(new File(localRoot, map.name), name))
                    : entry == null || entry.directory
                      ? null
                      : resolver.openInputStream(entry.uri)
            ) {
                if (input == null) return "";
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                byte[] buffer = new byte[4096];
                int count;
                while ((count = input.read(buffer)) >= 0) {
                    if (bytes.size() + count > 1024 * 1024) return "";
                    bytes.write(buffer, 0, count);
                }
                return bytes.toString("UTF-8");
            }
        } catch (IOException ignored) {
            return "";
        }
    }

    boolean exists(String name) throws IOException {
        if (tree == null) return new File(localRoot, name).exists();
        for (Entry entry : children(root)) if (entry.name.equalsIgnoreCase(name)) return true;
        return false;
    }

    void unload(Entry map) throws IOException {
        if (!map.directory || !safeName(map.name)) throw new IOException("Invalid course selection.");
        if (tree != null) {
            Entry current = child(root, map.name);
            Entry terrain = current == null || !current.directory ? null : child(current.uri, "Patches.json");
            if (
                current == null ||
                !current.directory ||
                !current.uri.equals(map.uri) ||
                terrain == null ||
                terrain.directory
            ) throw new IOException("The selected course has changed. Refresh the library first.");
            if (!DocumentsContract.deleteDocument(resolver, current.uri)) throw new IOException(
                "The folder provider could not unload this course."
            );
            return;
        }
        if (
            !new File(localRoot, map.name).getCanonicalFile().equals(new File(map.uri.getPath()).getCanonicalFile())
        ) throw new IOException("The selected course has changed. Refresh the library first.");
        unloadLocal(map.name);
    }

    void unloadLocal(String name) throws IOException {
        if (tree != null || !safeName(name)) throw new IOException("Invalid local course selection.");
        File selected = new File(localRoot, name),
            directory = selected.getCanonicalFile();
        if (
            Files.isSymbolicLink(selected.toPath()) ||
            !directory.getParentFile().equals(localRoot.getCanonicalFile()) ||
            !new File(directory, "Patches.json").isFile()
        ) throw new IOException("The selected course is outside this Maps folder or is no longer available.");
        // walkFileTree does not follow symbolic links; only the selected course's own files are removed.
        Files.walkFileTree(
            directory.toPath(),
            new SimpleFileVisitor<Path>() {
                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) throws IOException {
                    Files.delete(file);
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult postVisitDirectory(Path folder, IOException error) throws IOException {
                    if (error != null) throw error;
                    Files.delete(folder);
                    return FileVisitResult.CONTINUE;
                }
            }
        );
    }

    File prepare(Entry map, File cache, Cancel cancel) throws IOException {
        if (tree == null) return new File(map.uri.getPath());
        File output = new File(cache, "play-" + UUID.randomUUID());
        if (!output.mkdir()) throw new IOException("Cannot prepare course.");
        try {
            Entry patches = child(map.uri, "Patches.json");
            if (patches == null || patches.directory) throw new IOException("This map has no Patches.json.");
            try (
                InputStream input = resolver.openInputStream(patches.uri);
                OutputStream file = new FileOutputStream(new File(output, "Patches.json"))
            ) {
                copy(input, file, PATCH_LIMIT, cancel);
            }
            for (String name : new String[] {
                "Models.json",
                "Instances.json",
                "Materials.json",
                "AIP.json",
                "SOP.json",
                "Splines.json",
                "RidingEffects.json",
                "Crowd.json",
                "Effects.json",
                "Physics.json",
                "SSFLogic.json",
                "World.json",
                "Lights.json",
                "RiderAnimations.json",
                "Origin.json",
                "Slopesmith.json"
            }) {
                cancel.check();
                Entry metadata = child(map.uri, name);
                if (metadata == null) continue;
                if (metadata.directory) throw new IOException("Map metadata is a folder: " + name);
                try (
                    InputStream input = resolver.openInputStream(metadata.uri);
                    OutputStream file = new FileOutputStream(new File(output, name))
                ) {
                    copy(input, file, PATCH_LIMIT, cancel);
                }
            }
            boolean needBehavior =
                !new File(output, "Effects.json").isFile() && !new File(output, "SSFLogic.json").isFile();
            boolean needMaterialSource = false;
            File materialFile = new File(output, "Materials.json");
            if (materialFile.isFile()) try {
                JSONArray materials = new JSONObject(
                    new String(
                        java.nio.file.Files.readAllBytes(materialFile.toPath()),
                        java.nio.charset.StandardCharsets.UTF_8
                    )
                ).getJSONArray("Materials");
                for (int i = 0; i < materials.length(); ++i) needMaterialSource |= !materials
                    .getJSONObject(i)
                    .has("TextureFlipbook");
            } catch (JSONException e) {
                throw new IOException("Invalid animated material metadata.", e);
            }
            if (needBehavior || needMaterialSource) {
                Entry source = child(map.uri, "Source");
                Entry behavior = null,
                    geometry = null,
                    art = null;
                if (source != null && source.directory) {
                    List<Entry> sidecars = children(source.uri);
                    for (Entry file : sidecars) {
                        if (file.directory || !safeName(file.name)) continue;
                        String name = file.name.toLowerCase(Locale.ROOT);
                        if (needBehavior && name.endsWith(".ssf")) {
                            if (behavior != null) throw new IOException("Map has multiple behavior sidecars.");
                            behavior = file;
                        }
                        if (needMaterialSource && name.endsWith(".pbd") && !name.endsWith("_sky.pbd")) {
                            String paired = name.substring(0, name.length() - 4) + ".ssh";
                            for (Entry texture : sidecars)
                                if (
                                    !texture.directory &&
                                    safeName(texture.name) &&
                                    texture.name.equalsIgnoreCase(paired)
                                ) {
                                    if (geometry != null) throw new IOException(
                                        "Map has multiple material sidecar pairs."
                                    );
                                    geometry = file;
                                    art = texture;
                                }
                        }
                    }
                }
                if (behavior != null || geometry != null) {
                    File sourceFolder = new File(output, "Source");
                    if (!sourceFolder.mkdir()) throw new IOException("Cannot prepare map sidecars.");
                    for (Entry file : new Entry[] { behavior, geometry, art })
                        if (file != null) {
                            cancel.check();
                            try (
                                InputStream input = resolver.openInputStream(file.uri);
                                OutputStream destination = new FileOutputStream(new File(sourceFolder, file.name))
                            ) {
                                copy(input, destination, PATCH_LIMIT, cancel);
                            }
                        }
                }
            }
            Entry sky = child(map.uri, "Skybox");
            if (sky != null) {
                if (!sky.directory) throw new IOException("Skybox must be a folder.");
                File skyFolder = new File(output, "Skybox");
                if (!skyFolder.mkdir()) throw new IOException("Cannot prepare sky backdrop.");
                for (String name : new String[] { "Models.json", "Materials.json" }) {
                    cancel.check();
                    Entry metadata = child(sky.uri, name);
                    if (metadata == null || metadata.directory) throw new IOException("Missing sky metadata: " + name);
                    try (
                        InputStream input = resolver.openInputStream(metadata.uri);
                        OutputStream file = new FileOutputStream(new File(skyFolder, name))
                    ) {
                        copy(input, file, PATCH_LIMIT, cancel);
                    }
                }
            }
            long[] audioBudget = { 0, 0 };
            File audioFolder = new File(output, "Audio");
            if (!audioFolder.mkdir()) throw new IOException("Cannot prepare map audio.");
            Entry audio = child(map.uri, "Audio");
            if (audio != null) {
                if (!audio.directory) throw new IOException("Audio must be a folder.");
                copyAudio(audio.uri, audioFolder, cancel, audioBudget, 0);
            }
            Entry sounds = child(map.uri, "Sounds");
            if (sounds != null) {
                if (!sounds.directory) throw new IOException("Sounds must be a folder.");
                File soundsFolder = new File(output, "Sounds");
                if (!soundsFolder.mkdir()) throw new IOException("Cannot prepare authored sounds.");
                copyAudio(sounds.uri, soundsFolder, cancel, audioBudget, 0);
            }
            copyCommonAudio(map, audioFolder, cancel, audioBudget);
            Entry music = child(map.uri, "Music");
            if (music != null) {
                if (!music.directory) throw new IOException("Music must be a folder.");
                File musicFolder = new File(output, "Music");
                if (!musicFolder.mkdir()) throw new IOException("Cannot prepare authored music.");
                for (String name : new String[] { "track.wav", "arrangement.json" }) {
                    cancel.check();
                    Entry file = child(music.uri, name);
                    if (file == null) continue;
                    if (file.directory) throw new IOException("Authored music asset must be a file.");
                    if (++audioBudget[1] > 20000) throw new IOException("Audio library contains too many files.");
                    long limit = name.endsWith(".wav") ? FILE_LIMIT : PATCH_LIMIT;
                    try (
                        InputStream input = resolver.openInputStream(file.uri);
                        OutputStream destination = new FileOutputStream(new File(musicFolder, name))
                    ) {
                        audioBudget[0] += copy(
                            input,
                            destination,
                            Math.min(limit, AUDIO_BUDGET - audioBudget[0]),
                            cancel
                        );
                    }
                }
            }

            JSONArray images;
            try {
                images = new JSONArray(nativeAssetFiles(output.getAbsolutePath()));
            } catch (JSONException e) {
                throw new IOException("Cannot read map image references.", e);
            }
            Map<String, Map<String, Entry>> folders = new HashMap<>();
            long total = 0,
                meshes = 0;
            for (int i = 0; i < images.length(); ++i) {
                cancel.check();
                String relative;
                try {
                    relative = images.getString(i);
                } catch (JSONException e) {
                    throw new IOException("Invalid map image reference.", e);
                }
                String[] parts = relative.split("/", -1);
                boolean skyAsset =
                    parts.length == 3 &&
                    parts[0].equals("Skybox") &&
                    (parts[1].equals("Textures") || parts[1].equals("Meshes"));
                boolean worldAsset =
                    parts.length == 2 &&
                    (parts[0].equals("Textures") ||
                        parts[0].equals("Lightmaps") ||
                        parts[0].equals("Meshes") ||
                        parts[0].equals("Collision"));
                boolean nestedTexture = parts.length >= 3 && parts.length <= 6 && parts[0].equals("Textures");
                if (!(skyAsset || worldAsset || nestedTexture)) throw new IOException("Unsafe map asset reference.");
                for (String part : parts) if (!safeName(part)) throw new IOException("Unsafe map asset reference.");
                String folderName = String.join("/", Arrays.copyOf(parts, parts.length - 1)),
                    filename = parts[parts.length - 1];
                Map<String, Entry> files = folders.get(folderName);
                if (files == null) {
                    files = new HashMap<>();
                    Entry folder = null;
                    Uri parent = map.uri;
                    for (int part = 0; part < parts.length - 1; ++part) {
                        cancel.check();
                        folder = child(parent, parts[part]);
                        if (folder == null) break;
                        if (!folder.directory) throw new IOException(folderName + " must be a folder.");
                        parent = folder.uri;
                    }
                    if (folder != null) {
                        if (!folder.directory) throw new IOException(folderName + " must be a folder.");
                        for (Entry entry : children(folder.uri)) files.put(entry.name, entry);
                    }
                    folders.put(folderName, files);
                }
                boolean mesh = (skyAsset ? parts[1] : parts[0]).equals("Meshes") || parts[0].equals("Collision");
                Entry image = files.get(filename);
                if (image == null) {
                    if (mesh) throw new IOException("Missing map mesh: " + relative);
                    continue;
                }
                if (image.directory) throw new IOException("Map asset is a folder: " + relative);
                File directory = new File(output, folderName);
                if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException(
                    "Cannot prepare map images."
                );
                try (
                    InputStream input = resolver.openInputStream(image.uri);
                    OutputStream file = new FileOutputStream(new File(directory, filename))
                ) {
                    long copied = copy(
                        input,
                        file,
                        Math.min(IMAGE_LIMIT, IMAGE_BUDGET - (mesh ? meshes : total)),
                        cancel
                    );
                    if (mesh) meshes += copied;
                    else total += copied;
                }
            }
            cancel.check();
            return output;
        } catch (Exception e) {
            deleteLocal(output);
            throw e;
        }
    }

    private Entry foldedChild(Uri directory, String name) throws IOException {
        Entry found = null;
        for (Entry entry : children(directory))
            if (entry.name.equalsIgnoreCase(name)) {
                if (found != null) throw new IOException("Ambiguous audio filename.");
                found = entry;
            }
        return found;
    }

    private File foldedFile(File directory, String name) throws IOException {
        File found = null;
        File[] files = directory.listFiles();
        if (files != null) for (File file : files)
            if (file.getName().equalsIgnoreCase(name)) {
                if (found != null) throw new IOException("Ambiguous cached audio filename.");
                found = file;
            }
        return found;
    }

    private void copyCommonAudio(Entry map, File output, Cancel cancel, long[] budget) throws IOException {
        List<Entry> sources = new ArrayList<>();
        Entry shared = child(root, "Shared");
        if (shared != null && shared.directory) sources.add(shared);
        List<Entry> courses = new ArrayList<>();
        for (Entry course : maps())
            if (!course.uri.equals(map.uri) && !course.name.equals("Shared")) courses.add(course);
        if (courses.size() <= 256) sources.addAll(courses);
        String[] banks = { "zBxsfx", "zboard" };
        File index = new File(output, "SoundIndex.json");
        if (index.isFile()) try {
            JSONObject doc = new JSONObject(
                new String(java.nio.file.Files.readAllBytes(index.toPath()), java.nio.charset.StandardCharsets.UTF_8)
            );
            if (doc.optString("Schema").equals("openslope-sound-index/v1")) {
                JSONObject names = doc.optJSONObject("Banks");
                for (int i = 0; i < banks.length; ++i) if (names != null && names.has(Integer.toString(i))) {
                    String name = names.getString(Integer.toString(i));
                    banks[i] = name.equalsIgnoreCase(banks[i]) ? name : null;
                }
            }
        } catch (JSONException e) {
            throw new IOException("Invalid map sound routing.", e);
        }
        for (Entry source : sources) {
            cancel.check();
            Entry audio = child(source.uri, "Audio");
            if (audio == null || !audio.directory) continue;
            File routingTarget = new File(output, "BoardSoundIndex.json");
            if (!routingTarget.isFile()) {
                Entry routing = child(audio.uri, "BoardSoundIndex.json");
                if (routing != null && !routing.directory) try (
                    InputStream input = resolver.openInputStream(routing.uri);
                    OutputStream file = new FileOutputStream(routingTarget)
                ) {
                    budget[0] += copy(input, file, Math.min(PATCH_LIMIT, AUDIO_BUDGET - budget[0]), cancel);
                }
            }
            Entry sfx = child(audio.uri, "SFX");
            if (sfx == null || !sfx.directory) continue;
            File sfxTarget = new File(output, "SFX");
            if (!sfxTarget.isDirectory() && !sfxTarget.mkdir()) throw new IOException("Cannot prepare shared audio.");
            for (String bank : banks) {
                if (bank == null) continue;
                Entry folder = foldedChild(sfx.uri, bank);
                if (folder == null || !folder.directory) continue;
                File target = foldedFile(sfxTarget, bank);
                if (target == null) {
                    target = new File(sfxTarget, bank);
                    if (!target.mkdir()) throw new IOException("Cannot prepare common sound bank.");
                }
                if (!target.isDirectory()) throw new IOException("Common sound bank must be a folder.");
                List<Entry> files = children(folder.uri);
                for (Entry file : files) {
                    cancel.check();
                    if (!file.name.matches("(?i)[0-9]{1,5}\\.wav") || file.directory) continue;
                    if (++budget[1] > 20000) throw new IOException("Audio library contains too many files.");
                    if (foldedFile(target, file.name) != null) continue;
                    String stem = file.name.substring(0, file.name.length() - 4);
                    Entry loop = foldedChild(folder.uri, stem + ".loop.wav");
                    File staleLoop = foldedFile(target, stem + ".loop.wav");
                    if (staleLoop != null && !staleLoop.delete()) throw new IOException(
                        "Cannot replace cached loop region."
                    );
                    for (Entry clip : new Entry[] { file, loop })
                        if (clip != null && !clip.directory) {
                            try (
                                InputStream input = resolver.openInputStream(clip.uri);
                                OutputStream destination = new FileOutputStream(new File(target, clip.name))
                            ) {
                                budget[0] += copy(
                                    input,
                                    destination,
                                    Math.min(IMAGE_LIMIT, AUDIO_BUDGET - budget[0]),
                                    cancel
                                );
                            }
                        }
                }
            }
        }
    }

    private void copyAudio(Uri source, File destination, Cancel cancel, long[] budget, int depth) throws IOException {
        if (depth > 5) throw new IOException("Audio folder nesting exceeds its limit.");
        for (Entry entry : children(source)) {
            cancel.check();
            if (!safeName(entry.name)) throw new IOException("Unsafe audio filename.");
            if (++budget[1] > 20000) throw new IOException("Audio library contains too many files.");
            File target = new File(destination, entry.name);
            if (entry.directory) {
                if (!target.mkdir()) throw new IOException("Cannot prepare audio folder.");
                copyAudio(entry.uri, target, cancel, budget, depth + 1);
            } else {
                String name = entry.name.toLowerCase(Locale.ROOT);
                if (!(name.endsWith(".wav") || name.endsWith(".json") || name.endsWith(".inf"))) continue;
                try (
                    InputStream input = resolver.openInputStream(entry.uri);
                    OutputStream file = new FileOutputStream(target)
                ) {
                    budget[0] += copy(input, file, Math.min(IMAGE_LIMIT, AUDIO_BUDGET - budget[0]), cancel);
                }
            }
        }
    }

    File importPath(File cache) throws IOException {
        File parent = tree == null ? localRoot : cache;
        if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("Cannot create import folder.");
        // Native extraction creates this new, hidden directory itself.
        return new File(parent, ".openslope-import-" + UUID.randomUUID());
    }

    void publishImport(String name, File source, Cancel cancel) throws IOException {
        if (tree != null) {
            publish(name, source, cancel);
            return;
        }
        if (!safeName(name) || exists(name)) throw new IOException(
            "A map named " + name + " already exists. Existing maps are kept."
        );
        // Only consume a fresh staging directory owned by this import. Local
        // imports are already on the destination filesystem, so publication
        // needs one rename instead of a second copy of every asset.
        if (
            !source.getName().startsWith(".openslope-import-") ||
            !source.getCanonicalFile().getParentFile().equals(localRoot.getCanonicalFile())
        ) throw new IOException("Invalid local import staging folder.");
        cancel.check();
        File destination = new File(localRoot, name);
        if (destination.exists() || !source.renameTo(destination)) throw new IOException(
            "Cannot publish map; the destination may now exist."
        );
    }

    void publish(String name, File source, Cancel cancel) throws IOException {
        if (!safeName(name) || exists(name)) throw new IOException(
            "A map named " + name + " already exists. Existing maps are kept."
        );
        cancel.check();
        if (tree == null) {
            File staging = new File(localRoot, ".openslope-import-" + UUID.randomUUID());
            if (!staging.mkdir()) throw new IOException("Cannot stage map in Maps folder.");
            try {
                copyLocal(source, staging, cancel);
                cancel.check();
                File destination = new File(localRoot, name);
                if (destination.exists() || !staging.renameTo(destination)) throw new IOException(
                    "Cannot publish map; the destination may now exist."
                );
            } finally {
                deleteLocal(staging);
            }
            return;
        }
        // Keep Patches.json until last so interrupted/provider-limited copies
        // cannot appear in the library as playable courses.
        Uri staged = DocumentsContract.createDocument(
            resolver,
            root,
            DIRECTORY,
            ".openslope-import-" + UUID.randomUUID()
        );
        if (staged == null) throw new IOException("The selected Maps folder is not writable.");
        Uri published = null;
        try {
            copyTree(source, staged, cancel);
            cancel.check();
            if (exists(name)) throw new IOException("A map with this name was created during import.");
            published = DocumentsContract.renameDocument(resolver, staged, name);
            if (published == null) throw new IOException(
                "The folder provider cannot rename an imported course. Use a local Maps folder."
            );
            Entry patches = child(published, "Patches.json");
            if (patches == null) throw new IOException("Published map is missing its terrain.");
        } catch (Exception e) {
            try {
                DocumentsContract.deleteDocument(resolver, published == null ? staged : published);
            } catch (Exception ignored) {}
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
            String mime = file.isDirectory()
                ? DIRECTORY
                : file.getName().endsWith(".png")
                  ? "image/png"
                  : "application/octet-stream";
            Uri created = DocumentsContract.createDocument(resolver, destination, mime, file.getName());
            if (created == null) throw new IOException("Cannot write " + file.getName() + " to Maps.");
            if (file.isDirectory()) copyTree(file, created, cancel);
            else try (
                InputStream input = new FileInputStream(file);
                OutputStream output = resolver.openOutputStream(created, "w")
            ) {
                copy(input, output, FILE_LIMIT, cancel);
            }
        }
    }

    static void copyLocal(File source, File destination, Cancel cancel) throws IOException {
        File[] files = source.listFiles();
        if (files == null) throw new IOException("Cannot read extracted course.");
        for (File file : files) {
            cancel.check();
            if (!safeName(file.getName())) throw new IOException("Unsafe map filename.");
            File target = new File(destination, file.getName());
            if (file.isDirectory()) {
                if (!target.mkdir()) throw new IOException("Cannot create map directory.");
                copyLocal(file, target, cancel);
            } else try (
                InputStream input = new FileInputStream(file);
                OutputStream output = new FileOutputStream(target)
            ) {
                copy(input, output, FILE_LIMIT, cancel);
            }
        }
    }

    static long copy(InputStream input, OutputStream output, long limit, Cancel cancel) throws IOException {
        if (input == null || output == null) throw new IOException("The document provider could not open this file.");
        byte[] buffer = new byte[128 * 1024];
        long total = 0;
        int count;
        while ((count = input.read(buffer)) != -1) {
            cancel.check();
            total += count;
            if (total > limit) throw new IOException("Map file exceeds the import limit.");
            output.write(buffer, 0, count);
        }
        return total;
    }

    static void deleteLocal(File directory) {
        // Called only for freshly created application cache/staging directories.
        File[] files = directory.listFiles();
        if (files != null) for (File child : files) {
            if (child.isDirectory()) deleteLocal(child);
            else child.delete();
        }
        directory.delete();
    }
}
